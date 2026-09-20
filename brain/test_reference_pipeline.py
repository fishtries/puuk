"""
Deterministic Mock and Fixture Test Suite for Reference & Timing Pipeline.

Tests:
1. synced LRC: validation, monotonicity, anchor coverage >= 0.8.
2. embedded plain + LRCLIB synced found: atomic upgrade, old wordData cleared to NULL.
3. embedded plain + LRCLIB synced not found: retains plain, wordData is null, hasLineAnchors=false.
4. missing lyrics everywhere: falls back to Whisper ASR draft, computes actual anchors.
5. zero anchors rejection: refuses anchored alignment, no 0.0s windows, line fallback.
6. partial anchors: coverage < 0.8 -> partial_anchor/degraded, unanchored lines not interpolated.
7. repeated GET without duplicate external requests: caches reference_search_status.
"""

import os
import sys
import unittest
import json
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.dirname(__file__))

import db
from lyrics_normalizer import (
    validate_synced_lrc,
    is_synced_lrc,
    parse_reference_lrc,
    inspect_reference_anchors,
)
from alignment_types import AlignmentResult, ReferenceLine, AlignedLine, AlignedWord
from whisper_anchor_backend import WhisperAnchorBackend
from api import app, process_word_lyrics_job
from fastapi.testclient import TestClient


class TestReferencePipelineFixtures(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.test_track_id = "test-fixture-track-001"
        # Ensure clean state in DB
        conn = db.get_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM tracks WHERE id = ?", (self.test_track_id,))
        cursor.execute("DELETE FROM lyrics_jobs WHERE track_id = ?", (self.test_track_id,))
        conn.commit()
        conn.close()

    def tearDown(self):
        conn = db.get_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM tracks WHERE id = ?", (self.test_track_id,))
        cursor.execute("DELETE FROM lyrics_jobs WHERE track_id = ?", (self.test_track_id,))
        conn.commit()
        conn.close()

    def test_1_synced_lrc_fixture(self):
        """Test valid synchronized LRC: high coverage, monotonic, valid anchors."""
        valid_lrc = """[ti:Song Title]
[ar:Artist Name]
[00:10.50]First line of the song
[00:14.20]Second line continues here
[00:18.00]Third line with melody
[00:22.50]Fourth line finishes chorus
[00:26.10]Fifth line ends the segment"""

        diag = validate_synced_lrc(valid_lrc)
        self.assertTrue(diag["is_synced"])
        self.assertEqual(diag["total_lines"], 5)
        self.assertEqual(diag["anchored_lines"], 5)
        self.assertEqual(diag["coverage"], 1.0)
        self.assertTrue(diag["monotonic"])
        self.assertEqual(diag["issues"], [])
        self.assertTrue(is_synced_lrc(valid_lrc))

        ref_lines = parse_reference_lrc(valid_lrc)
        anchors_info = inspect_reference_anchors(ref_lines)
        self.assertEqual(anchors_info["anchor_mode"], "anchored")
        self.assertTrue(anchors_info["has_line_anchors"])
        self.assertEqual(anchors_info["coverage"], 1.0)

    def test_2_embedded_plain_with_lrclib_synced_found(self):
        """
        Track has embedded plain text in DB with old invalid wordData.
        When LRCLIB returns syncedLyrics, Puuk atomically upgrades reference,
        sets source=lrclib_synced_lrc, status=line_synced, and strictly CLEARS wordData to NULL.
        """
        album_id = db.add_or_get_album("Test Album")
        old_dummy_word_data = json.dumps({"fake": "old_word_data_at_zero_offset"})
        db.add_or_update_track(
            self.test_track_id,
            "test_path.mp3",
            "Super Song",
            album_id,
            "Famous Artist",
            lyrics="Plain verse 1\nPlain verse 2\nPlain chorus",
        )
        db.update_track_lyrics_data(
            self.test_track_id,
            lyrics_source="embedded_plain",
            lyrics_status="plain",
            lyrics_word_data=old_dummy_word_data,
        )

        mock_synced_lrc = (
            "[00:10.00]Super verse 1\n[00:15.00]Super verse 2\n[00:20.00]Super chorus\n[00:25.00]Super outro"
        )
        mock_lrclib_resp = MagicMock()
        mock_lrclib_resp.status_code = 200
        mock_lrclib_resp.json.return_value = [{"syncedLyrics": mock_synced_lrc}]

        with patch("requests.get", return_value=mock_lrclib_resp):
            res = self.client.get(f"/api/tracks/{self.test_track_id}/lyrics")

        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data["isSynced"])
        self.assertEqual(data["referenceSource"], "lrclib_synced_lrc")
        self.assertEqual(data["lyricsStatus"], "line_synced")
        self.assertTrue(data["hasLineAnchors"])
        self.assertIsNone(data["wordData"])  # Must be atomically cleared!

        # Verify DB directly
        db_track = db.get_track(self.test_track_id)
        self.assertIsNone(db_track.get("lyrics_word_data"))
        self.assertEqual(db_track.get("lyrics_source"), "lrclib_synced_lrc")
        self.assertEqual(db_track.get("lyrics_status"), "line_synced")
        self.assertEqual(db_track.get("reference_search_status"), "found")

    def test_3_embedded_plain_with_lrclib_synced_not_found(self):
        """
        Track has embedded plain text. LRCLIB returns empty results.
        Puuk retains plain text, returns wordData=null, lyricsStatus=plain, hasLineAnchors=false.
        """
        album_id = db.add_or_get_album("Test Album")
        db.add_or_update_track(
            self.test_track_id,
            "test_path.mp3",
            "Obscure Track",
            album_id,
            "Indie Band",
            lyrics="Just plain words line 1\nJust plain words line 2",
        )
        db.update_track_lyrics_data(
            self.test_track_id,
            lyrics_source="embedded_plain",
            lyrics_status="plain",
            lyrics_word_data=None,
        )

        mock_empty_resp = MagicMock()
        mock_empty_resp.status_code = 200
        mock_empty_resp.json.return_value = []

        with patch("requests.get", return_value=mock_empty_resp):
            res = self.client.get(f"/api/tracks/{self.test_track_id}/lyrics")

        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertFalse(data["isSynced"])
        self.assertIsNone(data["wordData"])
        self.assertEqual(data["lyricsStatus"], "plain")
        self.assertFalse(data["hasLineAnchors"])
        self.assertEqual(data["anchorCoverage"], 0.0)
        self.assertEqual(data["referenceSource"], "embedded_plain")

        # Verify search status cached
        db_track = db.get_track(self.test_track_id)
        self.assertEqual(db_track.get("reference_search_status"), "not_found")

    def test_4_missing_lyrics_everywhere_whisper_draft(self):
        """
        Track has no lyrics in ID3 and LRCLIB has nothing.
        Job triggers Whisper ASR draft and computes actual anchors from parsed draft.
        """
        album_id = db.add_or_get_album("Test Album")
        db.add_or_update_track(
            self.test_track_id,
            "test_path.mp3",
            "Unreleased Freestyle",
            album_id,
            "Anonymous MC",
            lyrics="",
        )

        mock_draft_lrc = (
            "[00:05.000]<00:05.000>Yo<00:05.500> <00:05.600>mic<00:06.000>\n"
            "[00:08.000]<00:08.000>Check<00:08.400> <00:08.500>one<00:09.000>"
        )

        with patch("requests.get") as mock_get, \
             patch("word_lrc_generator.generate_word_level_lrc", return_value=mock_draft_lrc) as mock_gen, \
             patch.object(WhisperAnchorBackend, "align") as mock_align:

            mock_get.return_value.status_code = 200
            mock_get.return_value.json.return_value = []

            # Mock backend align result
            mock_align.return_value = AlignmentResult(
                backend="whisper_anchor",
                quality="approximate",
                lines=[],
                stats={"final_word_level_match_rate_pct": 95.0},
                reference_source="whisper_generated",
                has_line_anchors=True,
                anchored_lines_count=2,
                total_lines_count=2,
                anchor_coverage=1.0,
            )

            process_word_lyrics_job(self.test_track_id, "/dummy/audio.mp3")

        db_track = db.get_track(self.test_track_id)
        self.assertEqual(db_track.get("lyrics_source"), "whisper_generated")
        self.assertEqual(db_track.get("lyrics_status"), "draft_generated")

    def test_5_zero_anchors_rejection_no_zero_windows(self):
        """
        Reference has lines but zero timestamps (plain lyrics).
        Backend MUST refuse anchored alignment and never stretch across fake 0.0s windows.
        """
        plain_text = "Line without timestamp one\nLine without timestamp two\nLine without timestamp three"
        diag = validate_synced_lrc(plain_text)
        self.assertFalse(diag["is_synced"])
        self.assertEqual(diag["coverage"], 0.0)
        self.assertIn("zero_anchors", diag["issues"])

        ref_lines = parse_reference_lrc(plain_text)
        anchors_info = inspect_reference_anchors(ref_lines)
        self.assertEqual(anchors_info["anchor_mode"], "plain")
        self.assertEqual(anchors_info["anchored_lines"], 0)
        self.assertFalse(anchors_info["has_line_anchors"])

        # Call backend align directly
        backend = WhisperAnchorBackend()
        with patch("os.path.isfile", return_value=True):
            result = backend.align("/dummy/audio.mp3", ref_lines)
        self.assertEqual(result.quality, "line_fallback")
        self.assertFalse(result.has_line_anchors)
        self.assertEqual(result.anchored_lines_count, 0)
        self.assertEqual(result.anchor_coverage, 0.0)

        # Ensure all words have start=None, end=None, alignment="unresolved"
        for line in result.lines:
            self.assertEqual(line.quality, "line_fallback")
            self.assertFalse(line.word_timing_available)
            for w in line.words:
                self.assertIsNone(w.start)
                self.assertIsNone(w.end)
                self.assertEqual(w.alignment, "unresolved")

    def test_6_partial_anchors_degraded_unanchored_not_interpolated(self):
        """
        Reference has 10 lines, but only 3 have anchors (coverage = 30% < 80%).
        Backend flags result as degraded/partial_anchor.
        Unanchored lines remain unanchored with words having start=None, end=None.
        """
        lines_text = """[00:10.00]Line 1 with anchor
Line 2 unanchored
Line 3 unanchored
[00:25.00]Line 4 with anchor
Line 5 unanchored
Line 6 unanchored
Line 7 unanchored
[00:50.00]Line 8 with anchor
Line 9 unanchored
Line 10 unanchored"""

        diag = validate_synced_lrc(lines_text)
        self.assertFalse(diag["is_synced"])
        self.assertEqual(diag["coverage"], 0.3)
        self.assertIn("low_coverage(30.0% < 80%)", diag["issues"])

        ref_lines = parse_reference_lrc(lines_text)
        anchors_info = inspect_reference_anchors(ref_lines)
        self.assertEqual(anchors_info["anchor_mode"], "partial")
        self.assertEqual(anchors_info["anchored_lines"], 3)
        self.assertEqual(anchors_info["total_lines"], 10)
        self.assertEqual(anchors_info["coverage"], 0.3)

        backend = WhisperAnchorBackend()
        # Mocking transcribe to test line assembly without full GPU model loading
        with patch.object(backend, "_global_sequence_dp", return_value=([], 0)), \
             patch("os.path.isfile", return_value=True), \
             patch("librosa.load", return_value=(MagicMock(), 16000)), \
             patch("whisper_anchor_backend.get_whisper_model") as mock_wm:
            mock_model = MagicMock()
            mock_model.transcribe.return_value = ([], MagicMock())
            mock_wm.return_value = mock_model

            result = backend.align("/dummy/audio.mp3", ref_lines)

        self.assertEqual(result.quality, "degraded")
        self.assertEqual(result.anchor_coverage, 0.3)
        self.assertEqual(result.anchored_lines_count, 3)

        # Unanchored lines must have start=None words (no fake interpolated timestamps)
        unanchored_line_2 = result.lines[1]
        self.assertEqual(unanchored_line_2.quality, "line_fallback")
        self.assertFalse(unanchored_line_2.word_timing_available)
        for w in unanchored_line_2.words:
            self.assertIsNone(w.start)
            self.assertIsNone(w.end)
            self.assertEqual(w.alignment, "unresolved")

    def test_7_repeated_get_no_duplicate_external_request(self):
        """
        After initial search sets reference_search_status='not_found',
        subsequent GET requests do NOT query external LRCLIB unless force=true.
        """
        album_id = db.add_or_get_album("Test Album")
        db.add_or_update_track(
            self.test_track_id,
            "test_path.mp3",
            "Cached Search Track",
            album_id,
            "Band Name",
            lyrics="Plain lyrics",
        )
        db.update_track_lyrics_data(
            self.test_track_id,
            lyrics_source="embedded_plain",
            lyrics_status="plain",
            reference_search_status="not_found",  # already marked!
        )

        with patch("requests.get") as mock_get:
            # 1. Standard GET
            res = self.client.get(f"/api/tracks/{self.test_track_id}/lyrics")
            self.assertEqual(res.status_code, 200)
            mock_get.assert_not_called()  # NO external request made!

            # 2. Forced GET
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_resp.json.return_value = []
            mock_get.return_value = mock_resp

            res_force = self.client.get(f"/api/tracks/{self.test_track_id}/lyrics?force=true")
            self.assertEqual(res_force.status_code, 200)
            mock_get.assert_called_once()  # Called only when force=true!


if __name__ == "__main__":
    unittest.main()
