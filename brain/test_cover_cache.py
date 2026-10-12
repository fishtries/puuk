"""HTTP-кэш обложек: ETag по (cover_version, file_mtime_ns), 304/инвалидация.

Регрессия: ETag строился только из cover_version, а сканер/resync обновляют
файл с cover_version_inc=False — внешняя замена файла с новой обложкой
не сбрасывала кэш (браузер получал 304 со старым артом до суток).
"""
import os
import sys
import tempfile
import unittest
import uuid
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД, должен идти до db/config

from fastapi.testclient import TestClient
import db
from api import app

TRACK_ID = "c0ffee00-0000-4000-8000-000000000001"


class TestCoverCache(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.client = TestClient(app)
        login = cls.client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
        cls.token = login.json()["access_token"]
        cls.auth = {"Authorization": f"Bearer {cls.token}"}

        album_id = db.resolve_album("Cache Test Album", album_artist="Cache Artist")
        db.add_or_update_track(
            track_id=TRACK_ID,
            file_path="/nonexistent/no_cover.mp3",
            title="Cache Track",
            album_id=album_id,
            artist="Cache Artist",
            duration=1.0,
            file_mtime_ns=1111111111,
        )

    def _get(self, headers=None):
        return self.client.get(f"/api/cover/{TRACK_ID}", headers={**self.auth, **(headers or {})})

    def _get_color(self, track_id):
        return self.client.get(f"/api/color/{track_id}", headers=self.auth)

    def test_01_first_request_has_etag_and_cache_control(self):
        resp = self._get()
        self.assertEqual(resp.status_code, 200)
        self.assertIn("etag", resp.headers)
        self.assertIn("max-age", resp.headers.get("cache-control", ""))
        etag = resp.headers["etag"]
        self.assertIn(str(uuid.UUID(TRACK_ID)), etag)
        self.assertIn("1111111111", etag)

    def test_02_matching_if_none_match_returns_304(self):
        etag = self._get().headers["etag"]
        resp = self._get({"If-None-Match": etag})
        self.assertEqual(resp.status_code, 304)
        self.assertEqual(resp.headers["etag"], etag)

    def test_03_external_file_change_invalidates_etag(self):
        # Сканируемая внешняя замена файла: mtime меняется, cover_version — нет
        # (scan.py/resync вызывают update с cover_version_inc=False).
        etag = self._get().headers["etag"]
        self._get({"If-None-Match": etag}).status_code == 304

        conn = db.get_connection()
        conn.execute("UPDATE tracks SET file_mtime_ns = 2222222222 WHERE id = ?", (TRACK_ID,))
        conn.commit()
        conn.close()

        resp = self._get({"If-None-Match": etag})
        self.assertEqual(resp.status_code, 200, "старый ETag не должен давать 304 после смены файла")
        new_etag = resp.headers["etag"]
        self.assertNotEqual(new_etag, etag)
        self.assertIn("2222222222", new_etag)
        # Свежий ETag снова кэшируется
        self.assertEqual(self._get({"If-None-Match": new_etag}).status_code, 304)

    def test_04_cover_version_bump_invalidates_etag(self):
        etag = self._get().headers["etag"]
        conn = db.get_connection()
        conn.execute(
            "UPDATE tracks SET cover_version = COALESCE(cover_version, 0) + 1 WHERE id = ?",
            (TRACK_ID,),
        )
        conn.commit()
        conn.close()
        resp = self._get({"If-None-Match": etag})
        self.assertEqual(resp.status_code, 200)
        self.assertNotEqual(resp.headers["etag"], etag)

    def test_05_unknown_track_still_gets_stable_etag(self):
        ghost = "c0ffee00-0000-4000-8000-000000000009"
        resp = self.client.get(f"/api/cover/{ghost}", headers=self.auth)
        self.assertEqual(resp.status_code, 200)
        etag = resp.headers["etag"]
        self.assertIn("-0-0", etag)
        self.assertEqual(self._get_ghost(ghost, etag).status_code, 304)

    def _get_ghost(self, track_id, etag):
        return self.client.get(f"/api/cover/{track_id}", headers={**self.auth, "If-None-Match": etag})

    def test_06_color_qdrant_relative_path_uses_safe_music_root(self):
        track_id = str(uuid.uuid4())
        db.add_or_update_track(
            track_id=track_id,
            file_path="not-present.mp3",
            title="Qdrant Color Track",
            album_id=None,
            artist="Cache Artist",
        )
        with tempfile.TemporaryDirectory() as music_dir:
            artist_dir = os.path.join(music_dir, "Artist")
            os.makedirs(artist_dir)
            audio_path = os.path.join(artist_dir, "remote.mp3")
            with open(audio_path, "wb") as audio_file:
                audio_file.write(b"audio")

            point = mock.MagicMock()
            point.payload = {"file_path": "Artist/remote.mp3"}
            with mock.patch("routers.streaming.get_effective_music_dir", return_value=music_dir), \
                 mock.patch("services.media_locations.get_effective_music_dir", return_value=music_dir), \
                 mock.patch("routers.streaming.client.retrieve", return_value=[point]), \
                 mock.patch("routers.streaming.extract_dominant_hex", return_value="#123abc") as extract_color, \
                 mock.patch("routers.streaming.db.update_track_cover_color") as save_color:
                response = self._get_color(track_id)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"color": "#123abc"})
        extract_color.assert_called_once_with(audio_path)
        save_color.assert_called_once_with(track_id, "#123abc")
        conn = db.get_connection()
        conn.execute("DELETE FROM tracks WHERE id = ?", (track_id,))
        conn.commit()
        conn.close()

    def test_07_color_qdrant_path_traversal_is_rejected(self):
        track_id = str(uuid.uuid4())
        point = mock.MagicMock()
        point.payload = {"file_path": "/etc/passwd"}
        with mock.patch("routers.streaming.client.retrieve", return_value=[point]), \
             mock.patch("routers.streaming.extract_dominant_hex") as extract_color:
            response = self._get_color(track_id)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"color": "#13141f"})
        extract_color.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
