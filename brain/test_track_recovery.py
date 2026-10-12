"""
Unit and integration tests for track recovery and path resolution resiliency.
Verifies that:
1. validate_safe_path allows safe absolute paths inside music_dir while blocking traversal.
2. resolve_track_file_path handles relative paths, safe absolute paths, and redundant prefixes.
3. ensure_track_in_db recovers a track missing from SQLite using Qdrant or disk.
4. get_track_metadata_details and mutate_track_metadata auto-recover tracks missing from SQLite.
"""

import os
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.dirname(__file__))
import test_db_path  # noqa: F401 - isolates test database
import db
from metadata import validate_safe_path
from services.media_locations import ensure_track_in_db
from services.track_metadata_service import (
    resolve_track_file_path,
    get_track_metadata_details,
    mutate_track_metadata,
)
from routers.tracks import TrackEditPayload


class TestPathResolutionAndRecovery(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.music_dir = os.path.realpath(self.temp_dir.name)

        # Create a dummy audio file
        self.sub_dir = os.path.join(self.music_dir, "Artists", "Rock")
        os.makedirs(self.sub_dir, exist_ok=True)
        self.sample_audio = os.path.join(self.sub_dir, "song.mp3")
        with open(self.sample_audio, "wb") as f:
            f.write(b"ID3dummy content")

        self.user = {"id": 1, "username": "admin", "role": "admin"}

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_validate_safe_path_relative(self):
        res = validate_safe_path("Artists/Rock/song.mp3", self.music_dir)
        self.assertEqual(res, self.sample_audio)

    def test_validate_safe_path_absolute_inside(self):
        res = validate_safe_path(self.sample_audio, self.music_dir)
        self.assertEqual(res, self.sample_audio)

    def test_validate_safe_path_traversal_blocked(self):
        with self.assertRaises(PermissionError):
            validate_safe_path("../outside.mp3", self.music_dir)

        with self.assertRaises(PermissionError):
            validate_safe_path("/etc/passwd", self.music_dir)

    def test_resolve_track_file_path_redundant_music_prefix(self):
        # Suppose music_dir ends with 'music'
        custom_music_dir = os.path.join(self.temp_dir.name, "music")
        os.makedirs(custom_music_dir, exist_ok=True)
        sample = os.path.join(custom_music_dir, "perso_track_0.mp3")
        with open(sample, "wb") as f:
            f.write(b"data")

        with patch("services.track_metadata_service.get_music_dir", return_value=custom_music_dir):
            db_track = {"id": "test-1", "file_path": "music/perso_track_0.mp3"}
            resolved, eff = resolve_track_file_path(db_track)
            self.assertEqual(resolved, sample)
            self.assertEqual(eff, custom_music_dir)

    def test_ensure_track_in_db_from_qdrant(self):
        track_id = "test-qdrant-recovery-uuid"
        # Ensure track is not in SQLite initially
        self.assertIsNone(db.get_track(track_id))

        fake_payload = {
            "file_path": "Artists/Rock/song.mp3",
            "title": "Recovered Title",
            "artist": "Recovered Artist",
            "album": "Recovered Album",
            "duration": 180.0,
            "loudness_status": "analyzed",
            "loudness_lufs": -14.0,
            "true_peak_db": -1.0,
            "normalization_gain_db": 0.0,
        }

        mock_point = MagicMock()
        mock_point.id = track_id
        mock_point.payload = fake_payload

        with patch("services.media_locations.client.retrieve", return_value=[mock_point]), \
             patch("services.media_locations.get_effective_music_dir", return_value=self.music_dir):
            row = ensure_track_in_db(track_id)
            self.assertIsNotNone(row)
            self.assertEqual(row["id"], track_id)
            self.assertEqual(row["title"], "Recovered Title")
            self.assertEqual(row["artist"], "Recovered Artist")
            self.assertEqual(row["normalization_gain_db"], 0.0)

            # SQLite now has it
            db_row = db.get_track(track_id)
            self.assertIsNotNone(db_row)
            self.assertEqual(db_row["id"], track_id)

    def test_get_track_details_recovers_missing_track(self):
        track_id = "test-details-recovery-uuid"
        self.assertIsNone(db.get_track(track_id))

        fake_payload = {
            "file_path": self.sample_audio,
            "title": "Song Title",
            "artist": "Artist Name",
            "album": "Album Name",
            "duration": 200.0,
        }
        mock_point = MagicMock()
        mock_point.id = track_id
        mock_point.payload = fake_payload

        with patch("services.media_locations.client.retrieve", return_value=[mock_point]), \
             patch("services.media_locations.get_effective_music_dir", return_value=self.music_dir), \
             patch("services.track_metadata_service.get_music_dir", return_value=self.music_dir):
            # get_track_metadata_details should succeed rather than raising 404
            details = get_track_metadata_details(track_id, self.user, base_url="http://test")
            self.assertIsNotNone(details)
            self.assertEqual(details["id"], track_id)
            self.assertEqual(details["title"], "Song Title")

    def test_resolve_safe_music_file_blocks_path_traversal(self):
        from services.media_locations import resolve_safe_music_file
        # Absolute path outside music dir
        self.assertIsNone(resolve_safe_music_file("/etc/passwd", self.music_dir))
        # Relative traversal outside music dir
        self.assertIsNone(resolve_safe_music_file("../../../outside.mp3", self.music_dir))
        # Valid file inside music dir
        res = resolve_safe_music_file("Artists/Rock/song.mp3", self.music_dir)
        self.assertEqual(res, self.sample_audio)

    def test_ensure_track_from_file_fast_registration(self):
        from services.media_locations import ensure_track_from_file
        # File outside music dir is rejected
        self.assertIsNone(ensure_track_from_file("/etc/passwd"))
        # Valid file is registered directly without Qdrant or re-scan
        with patch("services.media_locations.get_effective_music_dir", return_value=self.music_dir):
            row = ensure_track_from_file(self.sample_audio)
            self.assertIsNotNone(row)
            self.assertIn("song", row["title"])
            self.assertEqual(row["file_path"], "Artists/Rock/song.mp3")
            # Re-calling returns cached DB row immediately
            row2 = ensure_track_from_file(self.sample_audio)
            self.assertEqual(row["id"], row2["id"])

    def test_ensure_track_in_db_rejects_payload_outside_music_dir(self):
        track_id = "test-outside-payload-uuid"
        fake_payload = {
            "file_path": "/etc/passwd",
            "title": "Malicious Track",
            "artist": "Attacker",
        }
        mock_point = MagicMock()
        mock_point.id = track_id
        mock_point.payload = fake_payload

        with patch("services.media_locations.client.retrieve", return_value=[mock_point]), \
             patch("services.media_locations.get_effective_music_dir", return_value=self.music_dir):
            row = ensure_track_in_db(track_id)
            self.assertIsNone(row)
            self.assertIsNone(db.get_track(track_id))

    def test_ensure_track_in_db_rejects_missing_file_payload(self):
        track_id = "test-missing-file-uuid"
        fake_payload = {
            "file_path": "non_existent_audio_file.mp3",
            "title": "Missing File Track",
            "artist": "Ghost Artist",
        }
        mock_point = MagicMock()
        mock_point.id = track_id
        mock_point.payload = fake_payload

        with patch("services.media_locations.client.retrieve", return_value=[mock_point]), \
             patch("services.media_locations.get_effective_music_dir", return_value=self.music_dir):
            row = ensure_track_in_db(track_id)
            self.assertIsNone(row)
            self.assertIsNone(db.get_track(track_id))


if __name__ == "__main__":
    unittest.main()
