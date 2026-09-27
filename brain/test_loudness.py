import os
import sys
import unittest
from unittest.mock import patch, MagicMock
import subprocess

sys.path.insert(0, os.path.dirname(__file__))

from services.loudness import (
    calculate_normalization_gain,
    parse_loudnorm_json,
    measure_file_loudness,
    LoudnessMeasurement,
    LoudnessError,
    LoudnessTimeoutError,
    LoudnessFFmpegNotFoundError,
    LoudnessCorruptFileError,
    LoudnessInvalidDataError,
    TARGET_LUFS,
    MAX_BOOST_DB,
    MAX_ATTENUATION_DB,
    TRUE_PEAK_CEILING_DB,
    ANALYSIS_VERSION,
)


class TestLoudnessCalculation(unittest.TestCase):
    def test_target_loudness_gives_zero_gain(self):
        # -14 LUFS, true peak -2 dBTP -> 0 dB gain
        gain = calculate_normalization_gain(-14.0, -2.0)
        self.assertEqual(gain, 0.0)

    def test_quiet_track_boost(self):
        # -20 LUFS, true peak -8 dBTP -> raw gain +6 dB, peak safe = -1 - (-8) = +7 dB -> 6 dB
        gain = calculate_normalization_gain(-20.0, -8.0)
        self.assertEqual(gain, 6.0)

    def test_loud_track_attenuation(self):
        # -8 LUFS, true peak 0 dBTP -> raw gain -6 dB, peak safe = -1 - 0 = -1 dB -> min(-6, -1) = -6 dB
        gain = calculate_normalization_gain(-8.0, 0.0)
        self.assertEqual(gain, -6.0)

    def test_max_boost_cap(self):
        # -40 LUFS (very quiet), true peak -30 dBTP -> raw gain +26 dB -> capped at +12 dB
        gain = calculate_normalization_gain(-40.0, -30.0)
        self.assertEqual(gain, MAX_BOOST_DB)

    def test_max_attenuation_cap(self):
        # +2 LUFS (extremely loud), true peak +5 dBTP -> raw gain -16 dB -> capped at -12 dB
        gain = calculate_normalization_gain(2.0, 5.0)
        self.assertEqual(gain, MAX_ATTENUATION_DB)

    def test_true_peak_limits_boost(self):
        # -20 LUFS (wants +6 dB), but true peak is -2.5 dBTP.
        # Safe gain by peak = -1.0 - (-2.5) = +1.5 dB.
        # min(6.0, 1.5) = 1.5 dB.
        gain = calculate_normalization_gain(-20.0, -2.5)
        self.assertEqual(gain, 1.5)

    def test_already_clipping_true_peak_attenuates_further(self):
        # -14 LUFS (wants 0 dB), but true peak is +0.5 dBTP (clipping).
        # Safe gain by peak = -1.0 - 0.5 = -1.5 dB.
        # min(0.0, -1.5) = -1.5 dB.
        gain = calculate_normalization_gain(-14.0, 0.5)
        self.assertEqual(gain, -1.5)

    def test_invalid_nan_inf_values(self):
        with self.assertRaises(LoudnessInvalidDataError):
            calculate_normalization_gain(float("nan"), -2.0)
        with self.assertRaises(LoudnessInvalidDataError):
            calculate_normalization_gain(-14.0, float("inf"))
        with self.assertRaises(LoudnessInvalidDataError):
            calculate_normalization_gain(float("-inf"), -2.0)


class TestLoudnormJsonParsing(unittest.TestCase):
    SAMPLE_FFMPEG_STDERR = """
[Parsed_loudnorm_0 @ 0x55d01234]
{
	"input_i" : "-19.42",
	"input_tp" : "-3.15",
	"input_lra" : "8.20",
	"input_thresh" : "-29.80",
	"output_i" : "-14.02",
	"output_tp" : "-1.00",
	"output_lra" : "7.10",
	"output_thresh" : "-24.30",
	"normalization_type" : "dynamic",
	"target_offset" : "0.02"
}
[out#0/null @ 0x55d05678] video:0KiB audio:1234KiB subtitle:0KiB other streams:0KiB
"""

    def test_successful_parse(self):
        lufs, tp = parse_loudnorm_json(self.SAMPLE_FFMPEG_STDERR)
        self.assertEqual(lufs, -19.42)
        self.assertEqual(tp, -3.15)

    def test_empty_stderr_raises(self):
        with self.assertRaises(LoudnessInvalidDataError):
            parse_loudnorm_json("")

    def test_missing_json_raises(self):
        with self.assertRaises(LoudnessInvalidDataError):
            parse_loudnorm_json("ffmpeg error: no audio stream found")

    def test_inf_values_raises(self):
        stderr = '{\n"input_i" : "-inf",\n"input_tp" : "-inf"\n}'
        with self.assertRaises(LoudnessInvalidDataError):
            parse_loudnorm_json(stderr)

    def test_noisy_stderr_with_preceding_json_blocks(self):
        noisy_stderr = """
        [info] ffmpeg banner
        [debug] filtergraph configuration: {"threads": 4, "options": {"mode": "auto"}}
        [debug] other block {some unclosed or unrelated braces}
        [Parsed_loudnorm_0 @ 0x55d01234]
        {
            "input_i" : "-16.50",
            "input_tp" : "-2.00",
            "input_lra" : "5.00"
        }
        [out#0/null @ 0x55d05678] video:0KiB audio:500KiB
        """
        lufs, tp = parse_loudnorm_json(noisy_stderr)
        self.assertEqual(lufs, -16.50)
        self.assertEqual(tp, -2.00)

    def test_below_threshold_silence_raises(self):
        silent_stderr = """
        {
            "input_i" : "-74.50",
            "input_tp" : "-40.00"
        }
        """
        with self.assertRaises(LoudnessInvalidDataError):
            parse_loudnorm_json(silent_stderr)


    def test_too_quiet_or_silent_file_raises(self):
        stderr = '{\n"input_i" : "-85.0",\n"input_tp" : "-40.0"\n}'
        with self.assertRaises(LoudnessInvalidDataError):
            parse_loudnorm_json(stderr)


class TestMeasureFileLoudness(unittest.TestCase):
    @patch("services.loudness.os.path.exists", return_value=True)
    @patch("services.loudness.subprocess.run")
    def test_successful_measurement(self, mock_run, mock_exists):
        mock_run.return_value = MagicMock(
            returncode=0,
            stderr=TestLoudnormJsonParsing.SAMPLE_FFMPEG_STDERR,
        )
        res = measure_file_loudness("/fake/track.mp3")
        self.assertIsInstance(res, LoudnessMeasurement)
        self.assertEqual(res.loudness_lufs, -19.42)
        self.assertEqual(res.true_peak_db, -3.15)
        # Target -14 - (-19.42) = +5.42 dB.
        # Safe gain by peak = -1 - (-3.15) = +2.15 dB.
        # min(5.42, 2.15) = 2.15 dB.
        self.assertEqual(res.normalization_gain_db, 2.15)
        self.assertEqual(res.analysis_version, ANALYSIS_VERSION)

    @patch("services.loudness.os.path.exists", return_value=True)
    @patch("services.loudness.subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="ffmpeg", timeout=60))
    def test_timeout_raises(self, mock_run, mock_exists):
        with self.assertRaises(LoudnessTimeoutError):
            measure_file_loudness("/fake/track.mp3")

    @patch("services.loudness.os.path.exists", return_value=True)
    @patch("services.loudness.subprocess.run", side_effect=FileNotFoundError("ffmpeg"))
    def test_ffmpeg_not_found_raises(self, mock_run, mock_exists):
        with self.assertRaises(LoudnessFFmpegNotFoundError):
            measure_file_loudness("/fake/track.mp3")

    @patch("services.loudness.os.path.exists", return_value=True)
    @patch("services.loudness.subprocess.run")
    def test_corrupt_file_raises(self, mock_run, mock_exists):
        mock_run.return_value = MagicMock(
            returncode=1,
            stderr="Invalid data found when processing input",
        )
        with self.assertRaises(LoudnessCorruptFileError):
            measure_file_loudness("/fake/corrupt.mp3")


if __name__ == "__main__":
    unittest.main()
