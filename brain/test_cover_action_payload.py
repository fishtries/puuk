import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import test_db_path  # noqa: F401

from routers.tracks import TrackEditPayload
from routers.albums import AlbumEditPayload


class TestCoverActionPayload(unittest.TestCase):
    def test_track_edit_payload_auto_infers_replace_on_cover_url(self):
        payload = TrackEditPayload.model_validate({
            "title": "Song",
            "artist": "Artist",
            "album": "Album",
            "cover_url": "https://example.com/cover.jpg",
        })
        self.assertEqual(payload.cover_action, "replace")
        self.assertEqual(payload.cover_url, "https://example.com/cover.jpg")
        self.assertIsNone(payload.cover_base64)

    def test_track_edit_payload_auto_infers_replace_on_cover_base64(self):
        payload = TrackEditPayload.model_validate({
            "title": "Song",
            "cover_base64": "data:image/jpeg;base64,abc123xyz",
        })
        self.assertEqual(payload.cover_action, "replace")
        self.assertEqual(payload.cover_base64, "data:image/jpeg;base64,abc123xyz")
        self.assertIsNone(payload.cover_url)

    def test_track_edit_payload_explicit_keep(self):
        payload = TrackEditPayload.model_validate({
            "title": "Song",
            "cover_action": "keep",
            "cover_url": None,
            "cover_base64": None,
        })
        self.assertEqual(payload.cover_action, "keep")
        self.assertIsNone(payload.cover_url)
        self.assertIsNone(payload.cover_base64)

    def test_track_edit_payload_explicit_remove(self):
        payload = TrackEditPayload.model_validate({
            "title": "Song",
            "cover_action": "remove",
        })
        self.assertEqual(payload.cover_action, "remove")

    def test_track_edit_payload_forbids_both_url_and_base64(self):
        with self.assertRaises(ValueError):
            TrackEditPayload.model_validate({
                "title": "Song",
                "cover_url": "https://example.com/c.jpg",
                "cover_base64": "data:image/jpeg;base64,abc",
            })

    def test_album_edit_payload_auto_infers_replace(self):
        payload = AlbumEditPayload.model_validate({
            "title": "Album",
            "cover_url": "https://example.com/album.jpg",
        })
        self.assertEqual(payload.cover_action, "replace")
        self.assertEqual(payload.cover_url, "https://example.com/album.jpg")

    def test_album_edit_payload_explicit_keep(self):
        payload = AlbumEditPayload.model_validate({
            "title": "Album",
            "cover_action": "keep",
        })
        self.assertEqual(payload.cover_action, "keep")


if __name__ == "__main__":
    unittest.main()
