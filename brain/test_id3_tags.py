import io
import os
import shutil
import tempfile
import unittest
from PIL import Image

import sys
sys.path.insert(0, os.path.dirname(__file__))

from metadata import (
    AudioMetadata,
    MetadataPatch,
    read_audio_metadata,
    clean_cover_bytes,
    mutate_audio_file,
    verify_mutated_file,
    validate_safe_path,
    track_mutation_lock,
    safe_replace_audio_file,
)


class TestAudioMetadataEngine(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        temp_audio_dir = os.path.join(os.path.dirname(__file__), "temp_audio")
        self.sample_mp3 = os.path.join(temp_audio_dir, "Daft Punk - Around the World.mp3")
        if os.path.exists(self.sample_mp3):
            self.test_file = os.path.join(temp_audio_dir, "test_track_unit_test.mp3")
            shutil.copy2(self.sample_mp3, self.test_file)
        else:
            self.test_file = None

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)
        if hasattr(self, "test_file") and self.test_file and os.path.exists(self.test_file):
            try:
                os.remove(self.test_file)
            except Exception:
                pass

    def test_01_read_real_mp3(self):
        if not self.test_file:
            self.skipTest("Sample MP3 not found")
        meta = read_audio_metadata(self.test_file)
        self.assertEqual(meta.format, "mp3")
        self.assertEqual(meta.title, "Around the World")
        self.assertEqual(meta.artist, "Daft Punk")
        self.assertEqual(meta.album, "Homework")
        self.assertEqual(meta.year, "1997-01-17")
        self.assertEqual(meta.track_number, "7/16")
        self.assertTrue(meta.has_cover)
        self.assertGreater(meta.duration, 400)

    def test_02_cover_sanitization(self):
        # Create small test image
        img = Image.new("RGBA", (100, 100), color=(255, 0, 0, 128))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        raw_bytes = buf.getvalue()

        clean_bytes, mime = clean_cover_bytes(raw_bytes)
        self.assertEqual(mime, "image/png")
        self.assertGreater(len(clean_bytes), 0)

        # Test JPEG
        rgb_img = Image.new("RGB", (2500, 2500), color=(0, 255, 0))
        buf_jpg = io.BytesIO()
        rgb_img.save(buf_jpg, format="JPEG")
        clean_jpg, mime_jpg = clean_cover_bytes(buf_jpg.getvalue())
        self.assertEqual(mime_jpg, "image/jpeg")
        # Check resized to max 2000
        res_img = Image.open(io.BytesIO(clean_jpg))
        self.assertLessEqual(res_img.width, 2000)
        self.assertLessEqual(res_img.height, 2000)

    def test_03_mutate_and_verify_mp3(self):
        if not self.test_file:
            self.skipTest("Sample MP3 not found")

        patch = MetadataPatch(
            fields_set={"title", "artist", "album", "year", "genre", "comment", "track_number"},
            title="Around the World (Remix)",
            artist="Daft Punk feat. Antigravity",
            album="Homework Deluxe",
            year="2026",
            genre="Electronic",
            comment="Puuk mutated tag",
            track_number="12/20",
        )

        mutate_audio_file(self.test_file, patch)
        verified = verify_mutated_file(self.test_file, patch)

        self.assertEqual(verified.title, "Around the World (Remix)")
        self.assertEqual(verified.artist, "Daft Punk feat. Antigravity")
        self.assertEqual(verified.album, "Homework Deluxe")
        self.assertEqual(verified.year, "2026")
        self.assertEqual(verified.genre, "Electronic")
        self.assertEqual(verified.comment, "Puuk mutated tag")
        self.assertEqual(verified.track_number, "12/20")

    def test_04_remove_cover_action(self):
        if not self.test_file:
            self.skipTest("Sample MP3 not found")

        patch = MetadataPatch(
            fields_set=set(),
            cover_action="remove"
        )
        mutate_audio_file(self.test_file, patch)
        meta = read_audio_metadata(self.test_file)
        self.assertFalse(meta.has_cover)

    def test_05_path_traversal_protection(self):
        music_dir = self.temp_dir

        # Valid subpath
        sub_path = "artist/album/song.mp3"
        valid_res = validate_safe_path(sub_path, music_dir)
        self.assertTrue(valid_res.startswith(os.path.realpath(music_dir)))

        # Path traversal attempts
        with self.assertRaises(PermissionError):
            validate_safe_path("../../../etc/passwd", music_dir)

        with self.assertRaises(PermissionError):
            validate_safe_path("folder/../../..", music_dir)

        with self.assertRaises(PermissionError):
            validate_safe_path("/etc/shadow", music_dir)

    def test_06_sidecar_locking(self):
        track_id = "test_track_lock_123"
        with track_mutation_lock(track_id, self.temp_dir):
            lock_file = os.path.join(self.temp_dir, ".mutation_locks", f"{track_id}.lock")
            self.assertTrue(os.path.exists(lock_file))

    def test_07_safe_replace_audio_file(self):
        if not self.test_file:
            self.skipTest("Sample MP3 not found")

        patch = MetadataPatch(
            fields_set={"title", "genre"},
            title="Safe Replace Title",
            genre="Synthwave"
        )

        meta = safe_replace_audio_file(self.test_file, patch)
        self.assertEqual(meta.title, "Safe Replace Title")
        self.assertEqual(meta.genre, "Synthwave")
        # Artist should be unchanged from original Homework album
        self.assertEqual(meta.artist, "Daft Punk")

    def test_08_api_get_and_patch(self):
        if not self.test_file:
            self.skipTest("Sample MP3 not found")

        from fastapi.testclient import TestClient
        from api import app
        import db
        from security import hash_password

        client = TestClient(app)

        # Create test users
        admin_user = db.get_user_by_username("id3_admin")
        if not admin_user:
            admin_id = db.create_user("id3_admin", hash_password("pass_admin"), role="admin")
        else:
            admin_id = admin_user["id"]

        resp = client.post("/api/auth/login", json={"username": "id3_admin", "password": "pass_admin"})
        self.assertEqual(resp.status_code, 200)
        token = resp.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}

        # Add track to DB
        track_id = "test_api_track_123"
        rel_path = os.path.relpath(self.test_file, os.path.dirname(os.path.dirname(self.test_file)))
        db.add_or_update_track(
            track_id=track_id,
            file_path=self.test_file,
            title="Old Title",
            album_id=None,
            artist="Old Artist",
            added_by_user_id=admin_id
        )

        # GET track
        get_res = client.get(f"/api/tracks/{track_id}", headers=headers)
        self.assertEqual(get_res.status_code, 200)
        track_data = get_res.json()
        self.assertEqual(track_data["id"], track_id)
        self.assertIn("bitrate", track_data)
        self.assertIn("cover_version", track_data)

        # PATCH track
        patch_payload = {
            "title": "API Patched Title",
            "year": "2027",
            "genre": "Deep House",
            "track_number": "5/12",
            "cover_action": "keep"
        }
        patch_res = client.patch(f"/api/tracks/{track_id}", json=patch_payload, headers=headers)
        self.assertEqual(patch_res.status_code, 200)
        patched_track = patch_res.json()["track"]
        self.assertEqual(patched_track["title"], "API Patched Title")
        self.assertEqual(patched_track["year"], "2027")
        self.assertEqual(patched_track["genre"], "Deep House")
        self.assertEqual(patched_track["track_number"], "5/12")

        # Verify on disk
        meta_on_disk = read_audio_metadata(self.test_file)
        self.assertEqual(meta_on_disk.title, "API Patched Title")
        self.assertEqual(meta_on_disk.year, "2027")

        # Test resync endpoint
        resync_res = client.post(f"/api/tracks/{track_id}/resync", headers=headers)
        self.assertEqual(resync_res.status_code, 200)
        self.assertTrue(resync_res.json()["status"], "success")

    def test_09_api_rbac_and_unowned_track(self):
        if not self.test_file:
            self.skipTest("Sample MP3 not found")

        from fastapi.testclient import TestClient
        from api import app
        import db
        from security import hash_password

        client = TestClient(app)

        # Create normal user
        user = db.get_user_by_username("id3_normal_user")
        if not user:
            user_id = db.create_user("id3_normal_user", hash_password("pass_user"), role="user")
        else:
            user_id = user["id"]

        resp = client.post("/api/auth/login", json={"username": "id3_normal_user", "password": "pass_user"})
        user_token = resp.json()["access_token"]
        user_headers = {"Authorization": f"Bearer {user_token}"}

        # Track with added_by_user_id IS NULL (unowned system track)
        unowned_id = "test_unowned_track_456"
        db.add_or_update_track(
            track_id=unowned_id,
            file_path=self.test_file,
            title="System Track",
            album_id=None,
            artist="System Artist",
            added_by_user_id=None
        )

        # Normal user tries to PATCH unowned track -> 403 Forbidden!
        bad_patch = client.patch(f"/api/tracks/{unowned_id}", json={"title": "Hacked Title"}, headers=user_headers)
        self.assertEqual(bad_patch.status_code, 403)


if __name__ == "__main__":
    unittest.main()

