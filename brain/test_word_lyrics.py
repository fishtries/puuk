"""Tests for verified word-level lyrics (Migration 014 / Contract v1).

Tests:
- Schema migration and verification
- Import CLI: dry-run, apply, idempotent repeat, atomic replacement with backup
- Reject invalid: schema errors, missing track, audio sha256 mismatch
- Stat signature invalidation on mtime/size change
- GET /api/tracks/{track_id}/lyrics:
  - Protected endpoint (auth check)
  - Preservation of existing fields
  - wordLyrics included across empty, plain, and synced lyrics
  - Track without wordLyrics returns wordLyrics: None
- Catalog isolation: /api/tracks does NOT include wordLyrics payload and ETag is NOT invalidated
"""
import hashlib
import json
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 - must be first to isolate PUUK_DB_PATH

from fastapi.testclient import TestClient
import db
from api import app
from services.word_lyrics_validator import (
    compute_canonical_revision,
    validate_word_lyrics_payload,
)

# Import CLI functions
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "scripts", "lyrics"))
from import_word_lyrics import import_word_lyrics_file


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class TestWordLyrics(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.client = TestClient(app)
        login = cls.client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
        cls.token = login.json()["access_token"]
        cls.auth = {"Authorization": f"Bearer {cls.token}"}

        cls.tmp_dir = tempfile.mkdtemp(prefix="puuk_word_lyrics_test_")
        
        # Create test dummy audio file
        cls.audio_data = b"ID3v2-dummy-audio-content-for-word-lyrics-testing-1234567890"
        cls.audio_path = os.path.join(cls.tmp_dir, "test_track.mp3")
        with open(cls.audio_path, "wb") as f:
            f.write(cls.audio_data)
        cls.audio_sha256 = _sha256(cls.audio_data)

        cls.track_id = "test-word-track-001"
        cls.track_empty_id = "test-word-track-empty-lrc"
        cls.track_no_snapshot_id = "test-word-track-no-snapshot"

        # Register tracks in DB
        db.add_or_update_track(
            track_id=cls.track_id,
            file_path=cls.audio_path,
            title="Word Lyrics Track",
            artist="Test Artist",
            album_id=None,
            lyrics="[00:01.00] Line one\n[00:03.00] Line two",
            duration=30.0,
        )
        db.update_track_lyrics_data(
            cls.track_id,
            lyrics_source="embedded_synced_lrc",
            lyrics_status="line_synced",
        )

        db.add_or_update_track(
            track_id=cls.track_empty_id,
            file_path=cls.audio_path,
            title="Empty LRC Track",
            artist="Test Artist",
            album_id=None,
            lyrics=None,
            duration=30.0,
        )

        db.add_or_update_track(
            track_id=cls.track_no_snapshot_id,
            file_path=cls.audio_path,
            title="No Snapshot Track",
            artist="Test Artist",
            album_id=None,
            lyrics="[00:01.00] Line one",
            duration=30.0,
        )
        db.update_track_lyrics_data(
            cls.track_no_snapshot_id,
            lyrics_source="embedded_synced_lrc",
            lyrics_status="line_synced",
        )

    @classmethod
    def tearDownClass(cls):
        conn = db.get_connection()
        conn.execute("DELETE FROM tracks WHERE id IN (?, ?, ?)",
                     (cls.track_id, cls.track_empty_id, cls.track_no_snapshot_id))
        conn.execute("DELETE FROM track_word_lyrics WHERE track_id IN (?, ?, ?)",
                     (cls.track_id, cls.track_empty_id, cls.track_no_snapshot_id))
        conn.commit()
        conn.close()

    def _create_test_payload(self, track_id: str, audio_sha256: str, duration_ms: int = 30000, line_text: str = "Line one"):
        payload_no_rev = {
            "schemaVersion": 1,
            "trackId": track_id,
            "audioSha256": audio_sha256,
            "durationMs": duration_ms,
            "lines": [
                {
                    "id": "line-0001",
                    "text": line_text,
                    "startMs": 1000,
                    "endMs": 2500,
                    "words": [
                        {"id": "word-0001", "from": 0, "to": 4, "startMs": 1000, "endMs": 1600},
                        {"id": "word-0002", "from": 5, "to": len(line_text), "startMs": 1700, "endMs": 2500},
                    ]
                }
            ]
        }
        rev = compute_canonical_revision(payload_no_rev)
        return {**payload_no_rev, "revision": rev}

    def test_01_schema_has_track_word_lyrics_table(self):
        conn = db.get_connection()
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='track_word_lyrics'")
        self.assertIsNotNone(cur.fetchone())
        cur.execute("PRAGMA table_info(track_word_lyrics)")
        cols = {row["name"] for row in cur.fetchall()}
        expected = {"track_id", "schema_version", "revision", "payload_json", "provenance_json",
                    "audio_sha256", "file_path", "file_size", "file_mtime_ns", "imported_at", "is_active"}
        self.assertTrue(expected.issubset(cols))
        conn.close()

    def test_02_validator_accepts_valid_payload_and_rejects_corrupted(self):
        payload = self._create_test_payload(self.track_id, self.audio_sha256)
        valid, err = validate_word_lyrics_payload(payload)
        self.assertTrue(valid, f"Expected valid, got: {err}")

        # Corrupt revision
        bad = dict(payload, revision="a" * 64)
        valid, err = validate_word_lyrics_payload(bad)
        self.assertFalse(valid)
        self.assertIn("Revision", err)

        # Corrupt timing (endMs < startMs)
        bad_timing = dict(payload)
        bad_timing["lines"] = [
            dict(payload["lines"][0], startMs=3000, endMs=2000)
        ]
        valid, err = validate_word_lyrics_payload(bad_timing, verify_revision=False)
        self.assertFalse(valid)
        self.assertIn("invalid endMs", err)

    def test_03_import_dry_run_does_not_mutate_db(self):
        payload = self._create_test_payload(self.track_id, self.audio_sha256)
        input_file = os.path.join(self.tmp_dir, "dry_run_payload.json")
        with open(input_file, "w") as f:
            json.dump({"wordLyrics": payload}, f)

        res = import_word_lyrics_file(input_file, audio_path=self.audio_path, apply_changes=False)
        self.assertEqual(res["status"], "dry_run")
        self.assertFalse(res["applied"])

        # Check DB has no snapshot
        in_db = db.get_track_word_lyrics(self.track_id)
        self.assertIsNone(in_db)

    def test_04_import_apply_writes_to_db_and_repeat_is_noop(self):
        payload = self._create_test_payload(self.track_id, self.audio_sha256)
        input_file = os.path.join(self.tmp_dir, "apply_payload.json")
        with open(input_file, "w") as f:
            json.dump({"wordLyrics": payload}, f)

        res = import_word_lyrics_file(input_file, audio_path=self.audio_path, apply_changes=True)
        self.assertEqual(res["status"], "success")
        self.assertTrue(res["applied"])

        # Check DB has snapshot
        in_db = db.get_track_word_lyrics(self.track_id)
        self.assertIsNotNone(in_db)
        self.assertEqual(in_db["revision"], payload["revision"])

        # Repeat same import -> no-op
        res2 = import_word_lyrics_file(input_file, audio_path=self.audio_path, apply_changes=True)
        self.assertEqual(res2["status"], "noop_identical_revision")
        self.assertFalse(res2["applied"])

    def test_05_atomic_replacement_backs_up_previous_snapshot(self):
        backup_dir = os.path.join(self.tmp_dir, "backups")
        # New revision with different line text
        payload2 = self._create_test_payload(self.track_id, self.audio_sha256, line_text="Line updated")
        input_file2 = os.path.join(self.tmp_dir, "apply_payload2.json")
        with open(input_file2, "w") as f:
            json.dump({"wordLyrics": payload2}, f)

        res = import_word_lyrics_file(
            input_file2,
            audio_path=self.audio_path,
            apply_changes=True,
            backup_dir=backup_dir,
        )
        self.assertEqual(res["status"], "success")
        self.assertTrue(res["applied"])

        # Verify backup exists
        backups = os.listdir(backup_dir)
        self.assertTrue(len(backups) >= 1)
        with open(os.path.join(backup_dir, backups[0])) as f:
            bdata = json.load(f)
            self.assertEqual(bdata["track_id"], self.track_id)
            self.assertIn("previous_record", bdata)

        # DB has updated revision
        in_db = db.get_track_word_lyrics(self.track_id)
        self.assertEqual(in_db["revision"], payload2["revision"])

    def test_06_rejects_missing_track_and_audio_mismatch(self):
        payload = self._create_test_payload("non-existent-track-uuid", self.audio_sha256)
        input_file = os.path.join(self.tmp_dir, "bad_track.json")
        with open(input_file, "w") as f:
            json.dump(payload, f)

        with self.assertRaises(ValueError) as cm:
            import_word_lyrics_file(input_file, audio_path=self.audio_path, apply_changes=False)
        self.assertIn("not found in Puuk database", str(cm.exception))

        # Audio mismatch
        bad_audio_payload = self._create_test_payload(self.track_id, "f" * 64)
        input_file2 = os.path.join(self.tmp_dir, "bad_audio.json")
        with open(input_file2, "w") as f:
            json.dump(bad_audio_payload, f)

        with self.assertRaises(ValueError) as cm2:
            import_word_lyrics_file(input_file2, audio_path=self.audio_path, apply_changes=False)
        self.assertIn("Audio SHA-256 mismatch", str(cm2.exception))

    def test_07_stat_signature_invalidates_on_audio_modification(self):
        # Current snapshot is valid
        self.assertIsNotNone(db.get_track_word_lyrics(self.track_id, verify_file_stat=True))

        # Modify mtime of audio file
        old_stat = os.stat(self.audio_path)
        os.utime(self.audio_path, (old_stat.st_atime, old_stat.st_mtime + 5))

        # Stat verification should fail and return None
        self.assertIsNone(db.get_track_word_lyrics(self.track_id, verify_file_stat=True))

        # Restore original mtime_ns in DB to keep testing
        st = os.stat(self.audio_path)
        conn = db.get_connection()
        conn.execute("UPDATE track_word_lyrics SET file_mtime_ns = ?, file_size = ? WHERE track_id = ?",
                     (st.st_mtime_ns, st.st_size, self.track_id))
        conn.commit()
        conn.close()

        # Should be valid again
        self.assertIsNotNone(db.get_track_word_lyrics(self.track_id, verify_file_stat=True))

    def test_08_api_requires_auth(self):
        resp = self.client.get(f"/api/tracks/{self.track_id}/lyrics")
        self.assertEqual(resp.status_code, 401)

    def test_09_api_returns_word_lyrics_and_preserves_old_fields(self):
        resp = self.client.get(f"/api/tracks/{self.track_id}/lyrics", headers=self.auth)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()

        # Old fields preserved
        self.assertTrue(data["isSynced"])
        self.assertEqual(data["lyricsSource"], "embedded_synced_lrc")
        self.assertIn("syncedLyrics", data)
        self.assertIn("plainLyrics", data)

        # wordLyrics attached
        self.assertIn("wordLyrics", data)
        wl = data["wordLyrics"]
        self.assertIsNotNone(wl)
        self.assertEqual(wl["schemaVersion"], 1)
        self.assertEqual(wl["trackId"], self.track_id)
        self.assertEqual(len(wl["lines"]), 1)

    def test_10_api_returns_word_lyrics_when_lrc_empty(self):
        # Import snapshot for track with no LRC
        payload = self._create_test_payload(self.track_empty_id, self.audio_sha256)
        input_file = os.path.join(self.tmp_dir, "empty_lrc_payload.json")
        with open(input_file, "w") as f:
            json.dump({"wordLyrics": payload}, f)

        res = import_word_lyrics_file(input_file, audio_path=self.audio_path, apply_changes=True)
        self.assertTrue(res["applied"])

        resp = self.client.get(f"/api/tracks/{self.track_empty_id}/lyrics", headers=self.auth)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIsNone(data["lyrics"])
        self.assertIsNotNone(data["wordLyrics"])
        self.assertEqual(data["wordLyrics"]["trackId"], self.track_empty_id)

    def test_11_api_returns_none_word_lyrics_for_track_without_snapshot(self):
        resp = self.client.get(f"/api/tracks/{self.track_no_snapshot_id}/lyrics", headers=self.auth)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data["isSynced"])
        self.assertIsNone(data.get("wordLyrics"))

    def test_12_catalog_does_not_contain_word_lyrics_and_etag_not_invalidated(self):
        # 1. Fetch catalog ETag
        r1 = self.client.get("/api/tracks?limit=10&offset=0", headers=self.auth)
        self.assertEqual(r1.status_code, 200)
        etag1 = r1.headers.get("etag")
        tracks_data = r1.json()
        # Ensure no wordLyrics in catalog list
        for t in tracks_data:
            self.assertNotIn("wordLyrics", t)

        # 2. Re-import word lyrics for test_track
        payload = self._create_test_payload(self.track_id, self.audio_sha256, line_text="New text without bump")
        input_file = os.path.join(self.tmp_dir, "no_bump.json")
        with open(input_file, "w") as f:
            json.dump({"wordLyrics": payload}, f)
        import_word_lyrics_file(input_file, audio_path=self.audio_path, apply_changes=True)

        # 3. Catalog request with If-None-Match should return 304 Not Modified
        r2 = self.client.get(
            "/api/tracks?limit=10&offset=0",
            headers={**self.auth, "If-None-Match": etag1},
        )
        self.assertEqual(r2.status_code, 304, "Word lyrics mutation should NOT invalidate catalog ETag")


if __name__ == "__main__":
    unittest.main()
