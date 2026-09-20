"""
Unit and Integration Tests for Word-level (Enhanced LRC) generation.
"""

import os
import re
import unittest
import numpy as np
import soundfile as sf
from word_lrc_generator import format_lrc_time

class TestWordLRC(unittest.TestCase):
    def test_format_lrc_time(self):
        self.assertEqual(format_lrc_time(0.0), "00:00.000")
        self.assertEqual(format_lrc_time(12.34), "00:12.340")
        self.assertEqual(format_lrc_time(75.502), "01:15.502")
        self.assertEqual(format_lrc_time(125.0), "02:05.000")
        self.assertEqual(format_lrc_time(-1.0), "00:00.000")

    def test_enhanced_lrc_regex_format(self):
        line = "[00:12.340]<00:12.340>Первое<00:12.890> <00:12.910>слово<00:13.450> <00:13.470>строки<00:14.000>"
        # Line time pattern: ^\[\d{2,}:\d{2}\.\d{3}\]
        self.assertTrue(re.match(r"^\[\d{2,}:\d{2}\.\d{3}\]", line))
        
        # Word tags pattern: <\d{2,}:\d{2}\.\d{3}>
        word_tags = re.findall(r"<\d{2,}:\d{2}\.\d{3}>", line)
        self.assertEqual(len(word_tags), 6)

    def test_error_on_missing_file(self):
        from word_lrc_generator import generate_word_level_lrc
        with self.assertRaises(FileNotFoundError):
            generate_word_level_lrc("/non_existent_audio_path_xyz.mp3")

    def test_generate_word_level_lrc_cuda(self):
        from word_lrc_generator import generate_word_level_lrc
        wav_path = os.path.join(os.path.dirname(__file__), "temp_audio", "jfk.wav")
        if os.path.isfile(wav_path):
            lrc = generate_word_level_lrc(wav_path, language="en")
            self.assertTrue(len(lrc) > 0)
            self.assertIn("<00:00.", lrc)
            self.assertIn("Americans", lrc)
            self.assertIn("country", lrc)
            print("\nSuccessfully generated Enhanced LRC:\n" + lrc)

    def test_api_generate_word_lyrics(self):
        import db
        from api import app, generate_and_save_word_lrc
        from fastapi.testclient import TestClient
        
        wav_path = os.path.join(os.path.dirname(__file__), "temp_audio", "jfk.wav")
        track_id = "test-word-lrc-track"
        album_id = db.add_or_get_album("JFK Collection")
        db.add_or_update_track(track_id, wav_path, "JFK Inaugural Address", album_id, "John F. Kennedy", lyrics="")
        
        client = TestClient(app)
        db.delete_lyrics_job(track_id)
        
        # Test status endpoint initially idle
        res = client.get(f"/api/tracks/{track_id}/lyrics-generation-status")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json().get("status"), "idle")
        
        # Test triggering generation endpoint
        res = client.post(f"/api/tracks/{track_id}/generate-word-lyrics?language=en")
        self.assertEqual(res.status_code, 200)
        self.assertIn(res.json().get("status"), ["queued", "processing"])
        
        # Execute worker directly to simulate completion
        generate_and_save_word_lrc(track_id, wav_path, language="en")
        
        # Test status endpoint completed
        res = client.get(f"/api/tracks/{track_id}/lyrics-generation-status")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json().get("status"), "completed")
        
        # Check that lyrics were stored in DB
        db_track = db.get_track(track_id)
        self.assertIsNotNone(db_track.get("lyrics"))
        self.assertIn("<00:00.", db_track["lyrics"])
        
        # Check GET /api/tracks/{track_id}/lyrics returns clean plainLyrics and syncedLyrics
        res_lyrics = client.get(f"/api/tracks/{track_id}/lyrics")
        self.assertEqual(res_lyrics.status_code, 200)
        lyrics_data = res_lyrics.json()
        self.assertTrue(lyrics_data.get("isSynced"))
        self.assertIn("<00:00.", lyrics_data.get("lyrics"))
        self.assertNotIn("<00:00.", lyrics_data.get("plainLyrics"))
        self.assertIn("country", lyrics_data.get("plainLyrics"))


class TestLineFallbackDowngradeStatsRegression(unittest.TestCase):
    """
    Regression test ensuring that when a line initially has matched words
    but is subsequently downgraded to line_fallback (>50% unresolved words),
    the final stats and counters strictly reflect line_fallback, not the intermediate matched state.
    """
    def test_line_downgrade_recalculates_stats_and_whisper_words(self):
        from unittest.mock import MagicMock, patch
        from whisper_anchor_backend import WhisperAnchorBackend
        from lyrics_normalizer import parse_reference_lrc

        # Line 1: 5 words ("раз два три четыре пять")
        # Line 2: 2 words ("следующая строка")
        lrc_text = "[00:01.00]раз два три четыре пять\n[00:05.00]следующая строка"
        ref_lines = parse_reference_lrc(lrc_text)

        # Mock Whisper: only hears 'раз'
        mock_word = MagicMock()
        mock_word.word = "раз"
        mock_word.start = 1.05
        mock_word.end = 1.35
        mock_word.probability = 0.95

        mock_segment = MagicMock()
        mock_segment.words = [mock_word]

        backend = WhisperAnchorBackend()

        with patch("os.path.isfile", return_value=True), \
             patch("librosa.load", return_value=(np.zeros(16000 * 10, dtype=np.float32), 16000)), \
             patch("whisper_anchor_backend.get_whisper_model") as mock_get_model:
            mock_model = MagicMock()
            mock_model.transcribe.return_value = ([mock_segment], None)
            mock_get_model.return_value = mock_model

            result = backend.align("dummy.wav", ref_lines)

            stats = result.stats
            first_line = result.lines[0]

            # 1. Line must be line_fallback and word_timing_available False
            self.assertEqual(first_line.quality, "line_fallback")
            self.assertFalse(first_line.word_timing_available)
            self.assertEqual(first_line.line_fallback_words, 5)
            self.assertEqual(first_line.matched_words, 0)
            self.assertEqual(first_line.interpolated_words, 0)
            self.assertEqual(first_line.unresolved_words, 0)

            # 2. Words in line must be unresolved & line_fallback
            for w in first_line.words:
                self.assertEqual(w.alignment, "unresolved")
                self.assertEqual(w.timestamp_source, "line_fallback")
                self.assertIsNone(w.confidence)

            # 3. Global stats MUST NOT include the pre-downgrade matched word
            self.assertEqual(stats["matched_words"], 0)
            self.assertEqual(stats["final_word_level_match_rate_pct"], 0.0)
            # Raw text match rate before downgrade should record the ASR match
            self.assertGreater(stats["text_match_rate_pct"], 0.0)
            self.assertEqual(stats["line_fallback_words"], 7)
            self.assertEqual(stats["matched_whisper_words"], 0)
            self.assertEqual(stats["rejected_whisper_words"], 1)
            self.assertIsNone(stats["anchor_deviation_ms"])

            # 4. Strict sum assertion
            total_sum = (
                stats["matched_words"]
                + stats["interpolated_words"]
                + stats["unresolved_words"]
                + stats["line_fallback_words"]
            )
            self.assertEqual(total_sum, stats["reference_words_count"])
            self.assertEqual(total_sum, 7)

    def test_cascading_overlaps_resolution(self):
        """
        Regression test ensuring that tightly packed words with zero/under durations,
        cascading collisions, and multi-cluster overlaps are resolved with strictly positive durations,
        perfect monotonicity, and zero introduced overlaps.
        """
        from whisper_anchor_backend import WhisperAnchorBackend
        from alignment_types import AlignedWord, ReferenceLine

        backend = WhisperAnchorBackend()
        ref_line = ReferenceLine(original_text="тест каскада", start_anchor=1.0, next_anchor=4.0, tokens=[], line_index=0)

        # Scenario A: 4 tightly packed words with an isolated 4th word
        words_a = [
            AlignedWord(text="слово1", start=1.00, end=1.05),
            AlignedWord(text="слово2", start=1.02, end=1.06),
            AlignedWord(text="слово3", start=1.04, end=1.08),
            AlignedWord(text="слово4", start=1.50, end=1.90),
        ]
        res_a, _, _, raw_a, fix_a, intro_a, _ = backend._validate_and_finalize_line(words_a, ref_line)
        self.assertEqual(intro_a, 0, "Scenario A: No introduced overlaps allowed")
        self.assertEqual(raw_a, 2)
        self.assertEqual(fix_a, 2)
        self.assertGreaterEqual(res_a[3].start, res_a[2].end - 1e-4)

        # Scenario B: Ultra-cramped 5 words in 0.10s
        words_b = [
            AlignedWord(text="w1", start=1.00, end=1.02),
            AlignedWord(text="w2", start=1.01, end=1.03),
            AlignedWord(text="w3", start=1.02, end=1.04),
            AlignedWord(text="w4", start=1.03, end=1.05),
            AlignedWord(text="w5", start=1.04, end=1.06),
        ]
        res_b, _, _, raw_b, fix_b, intro_b, _ = backend._validate_and_finalize_line(words_b, ref_line)
        self.assertEqual(intro_b, 0, "Scenario B: No introduced overlaps allowed")
        self.assertEqual(raw_b, 4)
        self.assertEqual(fix_b, 4)
        for i in range(len(res_b) - 1):
            self.assertGreater(res_b[i].end, res_b[i].start)
            self.assertGreaterEqual(res_b[i + 1].start, res_b[i].end - 1e-4)

        # Scenario C: Zero duration words
        words_c = [
            AlignedWord(text="z1", start=2.00, end=2.00),
            AlignedWord(text="z2", start=2.00, end=2.00),
            AlignedWord(text="z3", start=2.00, end=2.00),
        ]
        res_c, _, _, raw_c, fix_c, intro_c, _ = backend._validate_and_finalize_line(words_c, ref_line)
        self.assertEqual(intro_c, 0, "Scenario C: No introduced overlaps allowed")
        for i in range(len(res_c) - 1):
            self.assertGreater(res_c[i].end, res_c[i].start)
            self.assertGreaterEqual(res_c[i + 1].start, res_c[i].end - 1e-4)

        # Scenario D: Two distinct clusters separated by silence
        words_d = [
            AlignedWord(text="c1_1", start=1.00, end=1.20),
            AlignedWord(text="c1_2", start=1.15, end=1.35),
            # silence gap [1.35, 2.50]
            AlignedWord(text="c2_1", start=2.50, end=2.70),
            AlignedWord(text="c2_2", start=2.65, end=2.85),
        ]
        res_d, _, _, raw_d, fix_d, intro_d, _ = backend._validate_and_finalize_line(words_d, ref_line)
        self.assertEqual(intro_d, 0, "Scenario D: No introduced overlaps allowed")
        self.assertEqual(raw_d, 2)
        self.assertEqual(fix_d, 2)
        # Verify cluster separation preserved
        self.assertLessEqual(res_d[1].end, res_d[2].start)


class TestPunctuationAndTokenReconstruction(unittest.TestCase):
    """
    Validates exact character reconstruction invariant:
    "".join(t.prefix + t.original_text + t.suffix for t in tokens) == original_line
    and ensures acoustic original_text contains NO attached punctuation.
    """

    def test_reconstruction_invariant_cases(self):
        from lyrics_normalizer import tokenize_line

        test_lines = [
            "(А в его—) А в его мешке",
            "head)?",
            "American,",
            "«Привет» — сказал",
            "Двойной  пробел   и   тройной",
            "Hey! Are you (really) sure? Yes, I'm... sure—totally!",
            "«— Ничего, — ответил он, улыбаясь. — Всё в порядке!»",
        ]

        for line in test_lines:
            tokens = tokenize_line(line)
            reconstructed = "".join(t.prefix + t.original_text + t.suffix for t in tokens)
            self.assertEqual(
                reconstructed,
                line,
                f"Invariant broken for line: {line!r}. Got reconstructed: {reconstructed!r}",
            )

    def test_specific_token_breakdown(self):
        from lyrics_normalizer import tokenize_line

        # 1. "(А в его—) А в его мешке"
        tokens = tokenize_line("(А в его—) А в его мешке")
        self.assertEqual([t.original_text for t in tokens], ["А", "в", "его", "А", "в", "его", "мешке"])
        self.assertEqual(tokens[0].prefix, "(")
        self.assertIn("—", tokens[2].suffix)
        self.assertEqual(
            "".join(t.prefix + t.original_text + t.suffix for t in tokens),
            "(А в его—) А в его мешке",
        )

        # 2. "head)?"
        tokens_head = tokenize_line("head)?")
        self.assertEqual(len(tokens_head), 1)
        self.assertEqual(tokens_head[0].original_text, "head")
        self.assertEqual(tokens_head[0].prefix, "")
        self.assertEqual(tokens_head[0].suffix, ")?")
        self.assertEqual("".join(t.prefix + t.original_text + t.suffix for t in tokens_head), "head)?")

        # 3. "American,"
        tokens_am = tokenize_line("American,")
        self.assertEqual(len(tokens_am), 1)
        self.assertEqual(tokens_am[0].original_text, "American")
        self.assertEqual(tokens_am[0].prefix, "")
        self.assertEqual(tokens_am[0].suffix, ",")
        self.assertEqual("".join(t.prefix + t.original_text + t.suffix for t in tokens_am), "American,")

        # 4. "«Привет» — сказал"
        tokens_quote = tokenize_line("«Привет» — сказал")
        self.assertEqual([t.original_text for t in tokens_quote], ["Привет", "сказал"])
        self.assertEqual(tokens_quote[0].prefix, "«")
        self.assertIn("»", tokens_quote[0].suffix)
        self.assertEqual("".join(t.prefix + t.original_text + t.suffix for t in tokens_quote), "«Привет» — сказал")

        # 5. Punctuation only
        tokens_punct = tokenize_line("♪")
        self.assertEqual("".join(t.prefix + t.original_text + t.suffix for t in tokens_punct), "♪")
        self.assertEqual([t.original_text for t in tokens_punct if t.original_text], [])

    def test_aligned_word_serialization_with_prefix_suffix(self):
        from alignment_types import AlignedWord, AlignedLine, AlignmentResult

        word1 = AlignedWord(text="Привет", start=1.0, end=1.5, prefix="«", suffix="» ")
        word2 = AlignedWord(text="мир", start=1.6, end=2.0, prefix="", suffix="!")
        line = AlignedLine(
            text="«Привет» мир!",
            start=1.0,
            end=2.0,
            language="ru",
            words=[word1, word2],
        )
        res = AlignmentResult(lines=[line])
        d = res.to_dict()

        w_json = d["lines"][0]["words"]
        self.assertEqual(w_json[0]["prefix"], "«")
        self.assertEqual(w_json[0]["suffix"], "» ")
        self.assertEqual(w_json[1]["prefix"], "")
        self.assertEqual(w_json[1]["suffix"], "!")

    def test_canonical_line_start_anchor_preserved(self):
        from alignment_types import AlignedWord, ReferenceLine
        from whisper_anchor_backend import WhisperAnchorBackend

        backend = WhisperAnchorBackend(mode="fast")
        ref_line = ReferenceLine(
            original_text="Canonical start test",
            start_anchor=12.450,
            next_anchor=18.000,
            tokens=[],
            line_index=0,
        )
        # Words with technical start 13.100 (e.g. after intro delay)
        words = [
            AlignedWord(text="Canonical", start=13.100, end=13.600),
            AlignedWord(text="start", start=13.650, end=14.100),
            AlignedWord(text="test", start=14.150, end=14.700),
        ]
        _, line_start, line_end, _, _, _, _ = backend._validate_and_finalize_line(words, ref_line)
        self.assertEqual(line_start, 12.450, "Line start anchor must preserve canonical reference_line.start_anchor")
        self.assertEqual(line_end, 18.000, "Line end anchor must preserve canonical reference_line.next_anchor")


if __name__ == "__main__":
    unittest.main()
