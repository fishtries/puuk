"""HTTP-кэш /api/tracks: ETag из (user, отпечаток лайков, версия каталога, limit, offset).

Мутации каталога инкрементируют версию каталога (bump_catalog_version) одной
транзакцией с данными; лайки меняют персональный отпечаток. 304 не переживает
ни смену каталога, ни смену лайков, ни смену пользователя.
"""
import os
import sys
import unittest
import uuid

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД, должен идти до db/config

from fastapi.testclient import TestClient
import db
from api import app


def _track_id(n: int) -> str:
    return f"c0ffee00-0000-4000-8000-{n:012d}"


class TestTracksEtag(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.client = TestClient(app)
        login = cls.client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
        cls.token = login.json()["access_token"]
        cls.auth = {"Authorization": f"Bearer {cls.token}"}

        cls.track_id = _track_id(1)
        db.add_or_update_track(
            track_id=cls.track_id,
            file_path="/nonexistent/etag_track.mp3",
            title="Etag Track",
            album_id=None,
            artist="Etag Artist",
            duration=1.0,
            file_mtime_ns=1111111111,
        )

    @classmethod
    def tearDownClass(cls):
        conn = db.get_connection()
        conn.execute("DELETE FROM tracks WHERE id = ?", (cls.track_id,))
        conn.commit()
        conn.close()

    def _get_window(self, limit, offset, headers=None):
        return self.client.get(
            "/api/tracks",
            params={"limit": limit, "offset": offset},
            headers={**self.auth, **(headers or {})},
        )

    def test_01_first_request_has_etag_and_cache_control(self):
        resp = self._get_window(50, 0)
        self.assertEqual(resp.status_code, 200)
        self.assertIn("etag", resp.headers)
        self.assertEqual(resp.headers["cache-control"], "private, max-age=30")
        self.assertTrue(resp.headers["etag"].startswith('"tracks-'))

    def test_02_matching_if_none_match_returns_304_without_payload(self):
        etag = self._get_window(50, 0).headers["etag"]
        resp = self._get_window(50, 0, {"If-None-Match": etag})
        self.assertEqual(resp.status_code, 304)
        self.assertEqual(resp.content, b"")
        self.assertEqual(resp.headers["etag"], etag)

    def test_02_catalog_mutation_invalidates_etag(self):
        etag = self._get_window(50, 0).headers["etag"]
        self.assertEqual(self._get_window(50, 0, {"If-None-Match": etag}).status_code, 304)

        db.add_or_update_track(
            track_id=_track_id(2),
            file_path="/nonexistent/etag_track2.mp3",
            title="Etag Track 2",
            album_id=None,
            artist="Etag Artist",
        )
        resp = self._get_window(50, 0, {"If-None-Match": etag})
        self.assertEqual(resp.status_code, 200, "старый ETag не должен давать 304 после мутации каталога")
        self.assertNotEqual(resp.headers["etag"], etag)
        # Свежий ETag снова кэшируется
        self.assertEqual(self._get_window(50, 0, {"If-None-Match": resp.headers["etag"]}).status_code, 304)

    def test_03_window_change_changes_etag(self):
        etag = self._get_window(50, 0).headers["etag"]
        resp = self._get_window(50, 50)
        self.assertNotEqual(resp.headers["etag"], etag)
        self.assertEqual(resp.status_code, 200)

    def test_04_favorite_change_changes_etag_same_catalog(self):
        resp = self._get_window(50, 0)
        etag = resp.headers["etag"]
        self.assertEqual(resp.status_code, 200)

        db.add_favorite(1, self.track_id)
        try:
            resp2 = self._get_window(50, 0, {"If-None-Match": etag})
            self.assertEqual(resp2.status_code, 200, "добавление лайка не должно давать 304 (is_liked персональный)")
            self.assertNotEqual(resp2.headers["etag"], etag)
        finally:
            db.remove_favorite(1, self.track_id)

    def test_05_other_user_favorites_do_not_invalidate(self):
        etag = self._get_window(50, 0).headers["etag"]
        other_user_id = db.create_user("etag_other_user", "x", role="user")
        db.add_favorite(other_user_id, self.track_id)
        try:
            self.assertEqual(self._get_window(50, 0, {"If-None-Match": etag}).status_code, 304)
        finally:
            db.remove_favorite(other_user_id, self.track_id)
            conn = db.get_connection()
            conn.execute("DELETE FROM users WHERE id = ?", (other_user_id,))
            conn.commit()
            conn.close()

    def test_06_track_delete_invalidates_etag(self):
        temp_id = _track_id(999)
        db.add_or_update_track(
            track_id=temp_id,
            file_path="/nonexistent/etag_del.mp3",
            title="Etag Delete",
            album_id=None,
            artist="Etag Artist",
        )
        etag = self._get_window(50, 0).headers["etag"]
        self.assertEqual(self._get_window(50, 0, {"If-None-Match": etag}).status_code, 304)

        db.delete_track(self.track_id)
        resp = self._get_window(50, 0, {"If-None-Match": etag})
        self.assertEqual(resp.status_code, 200)
        self.assertNotEqual(resp.headers["etag"], etag)
        # Восстанавливаем трек для tearDownClass
        db.add_or_update_track(
            track_id=self.track_id,
            file_path="/nonexistent/etag_track.mp3",
            title="Etag Track",
            album_id=None,
            artist="Etag Artist",
            file_mtime_ns=1111111111,
        )

    def test_07_lyrics_update_does_not_invalidate(self):
        # lyrics не входят в TRACK_SUMMARY_COLUMNS: страница каталога не меняется
        etag = self._get_window(50, 0).headers["etag"]
        db.update_track_lyrics(self.track_id, "новый текст")
        self.assertEqual(self._get_window(50, 0, {"If-None-Match": etag}).status_code, 304)


if __name__ == "__main__":
    unittest.main(verbosity=2)
