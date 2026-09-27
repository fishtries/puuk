"""Loudness measurement and gain normalization module (EBU R128 / LUFS-I).

Pure domain service: does not depend on FastAPI, SQLite, or Qdrant.
"""
from dataclasses import dataclass
import json
import logging
import math
import os
from pathlib import Path
import subprocess
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

TARGET_LUFS: float = -14.0
MAX_BOOST_DB: float = 12.0
MAX_ATTENUATION_DB: float = -12.0
TRUE_PEAK_CEILING_DB: float = -1.0
ANALYSIS_VERSION: str = "r128-v1"
MIN_MEASURABLE_LUFS: float = -70.0  # Audio below -70 LUFS (near digital silence) is considered non-measurable


class LoudnessError(Exception):
    """Base exception for loudness measurement failures."""
    pass


class LoudnessTimeoutError(LoudnessError):
    """Raised when ffmpeg measurement exceeds timeout."""
    pass


class LoudnessFFmpegNotFoundError(LoudnessError):
    """Raised when ffmpeg executable is not available."""
    pass


class LoudnessCorruptFileError(LoudnessError):
    """Raised when audio file cannot be decoded by ffmpeg."""
    pass


class LoudnessInvalidDataError(LoudnessError):
    """Raised when measurement data is empty, -inf, NaN, or unparseable."""
    pass


@dataclass
class LoudnessMeasurement:
    loudness_lufs: float
    true_peak_db: float
    normalization_gain_db: float
    analysis_version: str = ANALYSIS_VERSION


def calculate_normalization_gain(measured_lufs: float, true_peak_db: float) -> float:
    """Calculates safe normalization gain in dB.

    1. Base correction = TARGET_LUFS - measured_lufs
    2. Clamp to [MAX_ATTENUATION_DB, MAX_BOOST_DB]
    3. Peak safety limit = TRUE_PEAK_CEILING_DB - true_peak_db
    4. Safe gain = min(clamped_gain, safe_gain_by_peak)
    5. Final clamp to [MAX_ATTENUATION_DB, MAX_BOOST_DB]
    """
    if (
        measured_lufs is None
        or true_peak_db is None
        or math.isnan(measured_lufs)
        or math.isinf(measured_lufs)
        or math.isnan(true_peak_db)
        or math.isinf(true_peak_db)
    ):
        raise LoudnessInvalidDataError(
            f"Invalid measurement values: lufs={measured_lufs}, tp={true_peak_db}"
        )

    # 1. Base gain
    raw_gain = TARGET_LUFS - measured_lufs

    # 2. First clamp to [-12, +12]
    clamped_raw_gain = max(MAX_ATTENUATION_DB, min(MAX_BOOST_DB, raw_gain))

    # 3. Peak safety: ceiling is -1 dBTP
    safe_gain_by_peak = TRUE_PEAK_CEILING_DB - true_peak_db

    # 4. Limit by peak
    normalization_gain = min(clamped_raw_gain, safe_gain_by_peak)

    # 5. Final clamp to [-12, +12]
    final_gain = max(MAX_ATTENUATION_DB, min(MAX_BOOST_DB, normalization_gain))

    return round(final_gain, 2)


def extract_loudnorm_json(stderr_text: str) -> str:
    """Extracts the final loudnorm JSON block from ffmpeg stderr output.

    Robust against preceding logs, banners, or multiple JSON/brace blocks.
    Locates the last occurrence of 'input_i' and balances enclosing braces.
    """
    idx = stderr_text.rfind('"input_i"')
    if idx == -1:
        raise LoudnessInvalidDataError("loudnorm JSON block not found in ffmpeg output")
    start = stderr_text.rfind('{', 0, idx)
    if start == -1:
        raise LoudnessInvalidDataError("Opening brace for loudnorm JSON block not found")

    depth = 0
    end = -1
    for i in range(start, len(stderr_text)):
        if stderr_text[i] == '{':
            depth += 1
        elif stderr_text[i] == '}':
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end == -1:
        raise LoudnessInvalidDataError("Closing brace for loudnorm JSON block not found")
    return stderr_text[start:end]


def parse_loudnorm_json(stderr_text: str) -> Tuple[float, float]:
    """Extracts input_i and input_tp from ffmpeg stderr output."""
    if not stderr_text:
        raise LoudnessInvalidDataError("ffmpeg produced empty stderr output")

    json_str = extract_loudnorm_json(stderr_text)
    try:
        data = json.loads(json_str)
    except json.JSONDecodeError as err:
        raise LoudnessInvalidDataError(f"Failed to decode loudnorm JSON: {err}") from err

    try:
        raw_i = str(data["input_i"]).strip()
        raw_tp = str(data["input_tp"]).strip()

        # Check for non-numeric or infinite values
        if raw_i.lower() in ("-inf", "inf", "-nan", "nan") or raw_tp.lower() in ("-inf", "inf", "-nan", "nan"):
            raise LoudnessInvalidDataError(f"Audio has infinite or invalid loudness: input_i={raw_i}, input_tp={raw_tp}")

        measured_lufs = float(raw_i)
        true_peak_db = float(raw_tp)
    except (KeyError, ValueError) as err:
        raise LoudnessInvalidDataError(f"Missing or invalid loudness metrics in JSON: {err}") from err

    if math.isnan(measured_lufs) or math.isinf(measured_lufs) or math.isnan(true_peak_db) or math.isinf(true_peak_db):
        raise LoudnessInvalidDataError(f"Non-finite loudness values: input_i={measured_lufs}, input_tp={true_peak_db}")

    # Files that are purely silent or below threshold cannot be normalized safely
    if measured_lufs < MIN_MEASURABLE_LUFS:
        raise LoudnessInvalidDataError(f"Audio loudness below threshold ({MIN_MEASURABLE_LUFS} LUFS): {measured_lufs}")

    return measured_lufs, true_peak_db


def measure_file_loudness(
    file_path: str | Path,
    timeout: float = 60.0,
    ffmpeg_binary: str = "ffmpeg",
) -> LoudnessMeasurement:
    """Measures integrated loudness (LUFS) and true peak (dBTP) using ffmpeg loudnorm filter.

    Does not modify or generate any audio files.
    """
    path_str = str(file_path)
    if not os.path.exists(path_str):
        raise FileNotFoundError(f"Audio file not found: {path_str}")

    cmd = [
        ffmpeg_binary,
        "-hide_banner",
        "-nostats",
        "-i",
        path_str,
        "-af",
        "loudnorm=I=-14:TP=-1:LRA=11:print_format=json",
        "-f",
        "null",
        "-",
    ]

    try:
        res = subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as err:
        raise LoudnessFFmpegNotFoundError(f"ffmpeg executable not found: {ffmpeg_binary}") from err
    except subprocess.TimeoutExpired as err:
        raise LoudnessTimeoutError(f"Loudness measurement timed out after {timeout}s: {path_str}") from err
    except Exception as err:
        raise LoudnessError(f"Unexpected error executing ffmpeg: {err}") from err

    has_loudnorm = False
    try:
        extract_loudnorm_json(res.stderr or "")
        has_loudnorm = True
    except LoudnessInvalidDataError:
        has_loudnorm = False

    if res.returncode != 0 and not has_loudnorm:
        raise LoudnessCorruptFileError(
            f"ffmpeg failed with exit code {res.returncode}: {(res.stderr or '')[-500:]}"
        )

    measured_lufs, true_peak_db = parse_loudnorm_json(res.stderr or "")
    gain_db = calculate_normalization_gain(measured_lufs, true_peak_db)

    return LoudnessMeasurement(
        loudness_lufs=round(measured_lufs, 2),
        true_peak_db=round(true_peak_db, 2),
        normalization_gain_db=gain_db,
        analysis_version=ANALYSIS_VERSION,
    )
