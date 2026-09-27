"""Integration tests for loudness normalization schema, repository, and worker."""
import os
import sys
import unittest
from unittest.mock import Mock, patch, MagicMock

sys.path.insert(0, os.path.dirname(__file__))
import test_db_path  # noqa: F401 — isolates test database

import db
from repositories.schema import get_connection
from serializers import serialize_track
import heavy_worker
from services.loudness import LoudnessMeasurement, ANALYSIS_VERSION


class TestLoudnessIntegration(unittest.TestCase):
    def setUp(self):
        self.track_id = "test-loudness-track-1"
        self.file_path = "test_audio/test_loudness.mp3"
        db.add_or_update_track(
            self.track_id,
            self.file_path,
            "Test Loudness Track",
            None,
            "Test Artist",
            duration=120.0,
        )

    def test_schema_has_loudness_columns(self):
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info(tracks);")
        columns = {row["name"] for row in cursor.fetchall()}
        conn.close()

        expected = [
            "loudness_lufs",
            "true_peak_db",
            "normalization_gain_db",
            "loudness_status",
            "loudness_analyzed_at",
            "loudness_analysis_version",
            "loudness_file_size",
            "loudness_file_mtime_ns",
            "loudness_error",
            "loudness_retry_count",
        ]
        for col in expected:
            self.assertIn(col, columns, f"Column {col} missing in tracks table")

    def test_failed_status_saves_error_message_and_increments_retries(self):
        db.set_track_loudness_status(self.track_id, "failed", error="ffmpeg: corrupt audio stream")
        track = db.get_track(self.track_id)
        self.assertEqual(track["loudness_status"], "failed")
        self.assertEqual(track["loudness_error"], "ffmpeg: corrupt audio stream")
        self.assertEqual(track["loudness_retry_count"], 1)

        # Second failure increments retry count
        db.set_track_loudness_status(self.track_id, "failed", error="ffmpeg: timeout")
        track = db.get_track(self.track_id)
        self.assertEqual(track["loudness_retry_count"], 2)
        self.assertEqual(track["loudness_error"], "ffmpeg: timeout")

        # When analysis succeeds later, error and retry count must be cleared
        db.update_track_loudness(
            track_id=self.track_id,
            loudness_lufs=-14.0,
            true_peak_db=-1.0,
            normalization_gain_db=0.0,
            status="analyzed",
        )
        track = db.get_track(self.track_id)
        self.assertEqual(track["loudness_status"], "analyzed")
        self.assertIsNone(track["loudness_error"])
        self.assertEqual(track["loudness_retry_count"], 0)

    def test_new_track_defaults_to_pending(self):
        track = db.get_track(self.track_id)
        self.assertEqual(track.get("loudness_status"), "pending")
        self.assertIsNone(track.get("normalization_gain_db"))

    def test_update_and_serialize_track(self):
        db.update_track_loudness(
            track_id=self.track_id,
            loudness_lufs=-18.5,
            true_peak_db=-2.3,
            normalization_gain_db=3.2,
            status="analyzed",
            analysis_version=ANALYSIS_VERSION,
            file_size=1024000,
            file_mtime_ns=1700000000000000000,
        )

        track = db.get_track(self.track_id)
        self.assertEqual(track["loudness_status"], "analyzed")
        self.assertEqual(track["normalization_gain_db"], 3.2)
        self.assertEqual(track["loudness_lufs"], -18.5)
        self.assertEqual(track["true_peak_db"], -2.3)
        self.assertEqual(track["file_size"], 1024000)
        self.assertEqual(track["file_mtime_ns"], 1700000000000000000)

        serialized = serialize_track(track, "http://localhost:8000")
        self.assertEqual(serialized["normalization_gain_db"], 3.2)
        self.assertEqual(serialized["loudness_status"], "analyzed")
        self.assertEqual(serialized["loudness_lufs"], -18.5)
        self.assertEqual(serialized["true_peak_db"], -2.3)

    def test_fallback_serialization_when_null(self):
        raw_row = {
            "id": "old-track",
            "title": "Old Track",
            "artist": "Old Artist",
            "file_path": "old.mp3",
        }
        serialized = serialize_track(raw_row, "http://localhost:8000")
        self.assertIsNone(serialized["normalization_gain_db"])
        self.assertEqual(serialized["loudness_status"], "pending")

    def test_status_transitions(self):
        db.set_track_loudness_status(self.track_id, "processing")
        track = db.get_track(self.track_id)
        self.assertEqual(track["loudness_status"], "processing")

        db.set_track_loudness_status(self.track_id, "failed")
        track = db.get_track(self.track_id)
        self.assertEqual(track["loudness_status"], "failed")
        self.assertIsNone(track["normalization_gain_db"])

        count = db.reset_failed_loudness()
        self.assertGreaterEqual(count, 1)
        track = db.get_track(self.track_id)
        self.assertEqual(track["loudness_status"], "pending")
        self.assertIsNone(track["loudness_error"])
        self.assertEqual(track["loudness_retry_count"], 0)

    def test_file_change_resets_pending(self):
        db.update_track_loudness(
            track_id=self.track_id,
            loudness_lufs=-14.0,
            true_peak_db=-1.0,
            normalization_gain_db=0.0,
            status="analyzed",
            analysis_version=ANALYSIS_VERSION,
            file_size=500,
            file_mtime_ns=1000,
        )

        # File changed
        db.reset_track_loudness_pending(self.track_id, file_size=600, file_mtime_ns=2000)
        track = db.get_track(self.track_id)
        self.assertEqual(track["loudness_status"], "pending")
        self.assertIsNone(track["normalization_gain_db"])
        self.assertEqual(track["loudness_file_size"], 600)
        self.assertEqual(track["loudness_file_mtime_ns"], 2000)
        self.assertEqual(track["file_size"], 600)
        self.assertEqual(track["file_mtime_ns"], 2000)
        self.assertEqual(track["loudness_retry_count"], 0)

    def test_should_retry_failed_loudness(self):
        # 1. No track: False
        self.assertFalse(heavy_worker.should_retry_failed_loudness(None))

        # 2. Retries exhausted (>= 3): False
        exhausted_track = {
            "loudness_retry_count": 3,
            "loudness_analyzed_at": "2020-01-01 00:00:00",
        }
        self.assertFalse(heavy_worker.should_retry_failed_loudness(exhausted_track))

        # 3. Retries < 3 and recent failure (< 300s): False
        from datetime import datetime, timezone
        now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        recent_track = {
            "loudness_retry_count": 1,
            "loudness_analyzed_at": now_str,
        }
        self.assertFalse(heavy_worker.should_retry_failed_loudness(recent_track))

        # 4. Retries < 3 and old failure (> 300s): True
        old_track = {
            "loudness_retry_count": 1,
            "loudness_analyzed_at": "2020-01-01 00:00:00",
        }
        self.assertTrue(heavy_worker.should_retry_failed_loudness(old_track))

    def test_add_or_update_track_saves_file_size_and_mtime(self):
        test_id = "test-track-mtime-persistence"
        db.add_or_update_track(
            test_id,
            "path/track.mp3",
            "Mtime Track",
            None,
            "Artist",
            file_size=99999,
            file_mtime_ns=1710000000123456789,
        )
        track = db.get_track(test_id)
        self.assertEqual(track["file_size"], 99999)
        self.assertEqual(track["file_mtime_ns"], 1710000000123456789)

        # Update existing track preserves / updates values
        db.add_or_update_track(
            test_id,
            "path/track.mp3",
            "Mtime Track Renamed",
            None,
            "Artist",
            file_size=88888,
            file_mtime_ns=1710000000987654321,
        )
        updated = db.get_track(test_id)
        self.assertEqual(updated["file_size"], 88888)
        self.assertEqual(updated["file_mtime_ns"], 1710000000987654321)

    @patch("heavy_worker.measure_file_loudness")
    def test_process_loudness_for_track_success(self, mock_measure):
        mock_measure.return_value = LoudnessMeasurement(
            loudness_lufs=-17.0,
            true_peak_db=-2.0,
            normalization_gain_db=1.0,
            analysis_version=ANALYSIS_VERSION,
        )

        mock_qdrant = Mock()
        mock_sftp = Mock()
        mock_stat = Mock()
        mock_stat.st_size = 12345
        mock_stat.st_mtime = 1700000000.0
        mock_sftp.stat.return_value = mock_stat

        record = Mock()
        record.id = self.track_id
        record.payload = {"file_path": self.file_path}

        success = heavy_worker.process_loudness_for_track(mock_qdrant, record, mock_sftp)
        self.assertTrue(success)

        track = db.get_track(self.track_id)
        self.assertEqual(track["loudness_status"], "analyzed")
        self.assertEqual(track["normalization_gain_db"], 1.0)
        mock_qdrant.set_payload.assert_called_once()
        call_payload = mock_qdrant.set_payload.call_args[1]["payload"]
        self.assertEqual(call_payload["loudness_status"], "analyzed")
        self.assertIsNone(call_payload["loudness_error"])
        self.assertEqual(call_payload["loudness_retry_count"], 0)

    def test_process_loudness_for_track_failure(self):
        mock_qdrant = Mock()
        mock_sftp = Mock()
        mock_sftp.stat.side_effect = Exception("SFTP connection timed out")

        record = Mock()
        record.id = self.track_id
        record.payload = {"file_path": self.file_path}

        success = heavy_worker.process_loudness_for_track(mock_qdrant, record, mock_sftp)
        self.assertFalse(success)

        track = db.get_track(self.track_id)
        self.assertEqual(track["loudness_status"], "failed")
        self.assertIn("SFTP connection timed out", track["loudness_error"])
        self.assertGreaterEqual(track["loudness_retry_count"], 1)

        mock_qdrant.set_payload.assert_called_once()
        call_payload = mock_qdrant.set_payload.call_args[1]["payload"]
        self.assertEqual(call_payload["loudness_status"], "failed")
        self.assertIn("SFTP connection timed out", call_payload["loudness_error"])
        self.assertGreaterEqual(call_payload["loudness_retry_count"], 1)

    def test_get_loudness_tracks_uses_payload_fallback_for_loudness_metadata(self):
        # Create a track in SQLite with analyzed status but None in loudness_file_size
        test_id = "test-loudness-fallback-track"
        db.add_or_update_track(test_id, "test/fallback.mp3", "Fallback", None, "Artist")
        db.update_track_loudness(
            track_id=test_id,
            loudness_lufs=-14.0,
            true_peak_db=-1.0,
            normalization_gain_db=0.0,
            status="analyzed",
            analysis_version=ANALYSIS_VERSION,
        )
        # Clear loudness_file_size in SQLite to simulate partially synced record
        conn = db.get_connection()
        conn.cursor().execute("UPDATE tracks SET loudness_file_size = NULL, file_size = 5000 WHERE id = ?", (test_id,))
        conn.commit()
        conn.close()

        mock_client = Mock()
        mock_record = Mock()
        mock_record.id = test_id
        # Qdrant payload has file_size=5000 and loudness_file_size=4000 (meaning file changed!)
        mock_record.payload = {
            "file_path": "test/fallback.mp3",
            "loudness_status": "analyzed",
            "loudness_analysis_version": ANALYSIS_VERSION,
            "file_size": 5000,
            "loudness_file_size": 4000,
        }
        mock_client.scroll.return_value = ([mock_record], None)

        tracks = heavy_worker.get_loudness_tracks(mock_client)
        # Because payload had loudness_file_size=4000 != file_size=5000, it should be selected for analysis!
        self.assertEqual(len(tracks), 1)
        self.assertEqual(tracks[0].id, test_id)


class TestDatabaseBootstrapAndMigrations(unittest.TestCase):
    def test_fresh_database_bootstrap_and_repeated_init(self):
        import tempfile
        import sqlite3
        from repositories.schema import init_db

        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            temp_db = f.name

        saved_env = os.environ.get("PUUK_DB_PATH")
        os.environ["PUUK_DB_PATH"] = temp_db
        try:
            # 1. Fresh DB
            init_db()
            conn = sqlite3.connect(temp_db)
            cur = conn.cursor()
            cur.execute("PRAGMA table_info(tracks);")
            track_cols = {r[1] for r in cur.fetchall()}
            self.assertIn("loudness_lufs", track_cols)
            self.assertIn("loudness_error", track_cols)
            self.assertIn("artist", track_cols)

            cur.execute("PRAGMA table_info(albums);")
            album_cols = {r[1] for r in cur.fetchall()}
            self.assertIn("title_normalized", album_cols)
            self.assertIn("album_artist_normalized", album_cols)

            cur.execute("SELECT version FROM schema_migrations;")
            versions = {r[0] for r in cur.fetchall()}
            self.assertIn(8, versions)
            self.assertIn(9, versions)
            conn.close()

            # 2. Repeated init_db() must be idempotent and succeed without error
            init_db()
        finally:
            if saved_env is not None:
                os.environ["PUUK_DB_PATH"] = saved_env
            else:
                os.environ.pop("PUUK_DB_PATH", None)
            if os.path.exists(temp_db):
                os.remove(temp_db)

    def test_legacy_database_upgrade(self):
        import tempfile
        import sqlite3
        from repositories.schema import init_db

        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            temp_db = f.name

        saved_env = os.environ.get("PUUK_DB_PATH")
        os.environ["PUUK_DB_PATH"] = temp_db
        try:
            # Create a legacy DB without 008/009 schema
            conn = sqlite3.connect(temp_db)
            cur = conn.cursor()
            cur.execute("CREATE TABLE albums (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, cover_path TEXT);")
            cur.execute("CREATE TABLE tracks (id TEXT PRIMARY KEY, file_path TEXT NOT NULL, title TEXT NOT NULL, album_id INTEGER);")
            cur.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT, role TEXT);")
            cur.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, filename TEXT NOT NULL, applied_at TIMESTAMP);")
            cur.execute("INSERT INTO schema_migrations (version, filename) VALUES (2, '002_user_embeddings.sql'), (3, '003_track_audio_metadata.sql');")
            conn.commit()
            conn.close()

            init_db()

            conn = sqlite3.connect(temp_db)
            cur = conn.cursor()
            cur.execute("PRAGMA table_info(tracks);")
            track_cols = {r[1] for r in cur.fetchall()}
            self.assertIn("loudness_lufs", track_cols)
            self.assertIn("loudness_error", track_cols)

            cur.execute("PRAGMA table_info(albums);")
            album_cols = {r[1] for r in cur.fetchall()}
            self.assertIn("title_normalized", album_cols)
            conn.close()
        finally:
            if saved_env is not None:
                os.environ["PUUK_DB_PATH"] = saved_env
            else:
                os.environ.pop("PUUK_DB_PATH", None)
            if os.path.exists(temp_db):
                os.remove(temp_db)


if __name__ == "__main__":
    unittest.main()
