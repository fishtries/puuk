"""HTTP-кэш обложек: ETag по (cover_version, file_mtime_ns), 304/инвалидация.

Регрессия: ETag строился только из cover_version, а сканер/resync обновляют
файл с cover_version_inc=False — внешняя замена файла с новой обложкой
не сбрасывала кэш (браузер получал 304 со старым артом до суток).
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
