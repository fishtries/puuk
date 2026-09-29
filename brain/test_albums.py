"""Tests for the album entity: identity, catalog DTO, detail, whole-release editing."""
import os
import shutil
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД, должен идти до db/config

import db
from metadata import read_audio_metadata
from repositories import albums

SAMPLE_MP3 = os.path.join(os.path.dirname(__file__), "temp_audio", "Daft Punk - Around the World.mp3")
AUDIO_DIR = os.path.dirname(SAMPLE_MP3)


class AlbumRepositoryTest(unittest.TestCase):
    def test_identity_separates_same_title_by_artist(self):
        a = db.resolve_album("Greatest Hits", album_artist="Queen")
        b = db.resolve_album("Greatest Hits", album_artist="ABBA")
        self.assertNotEqual(a, b)

    def test_identity_normalizes_case_and_spaces(self):
        a = db.resolve_album("Greatest Hits", album_artist="Queen")
        c = db.resolve_album("  greatest   hits ", album_artist="QUEEN")
        self.assertEqual(a, c)
        self.assertEqual(a, db.resolve_album("Greatest Hits", album_artist="Queen"))

    def test_empty_title_canonical_fallback(self):
        aid = db.resolve_album(None, album_artist="Nobody")
        self.assertEqual(db.get_album(aid)["title"], albums.UNKNOWN_ALBUM_TITLE)

    def test_catalog_excludes_empty_albums_and_orders_tracks(self):
        aid = db.resolve_album("Order Test", album_artist="Tester")
        empty = db.resolve_album("Empty Album", album_artist="Tester")
        conn = db.get_connection()
        cursor = conn.cursor()
        for tid, title, disc, trk in [
            ("ord_c", "Song C", None, "2"),
            ("ord_a", "Song A", None, "10"),
            ("ord_b", "Song B", "1", "1"),
        ]:
            cursor.execute(
                "INSERT INTO tracks (id,file_path,title,album_id,artist,disc_number,track_number) "
                "VALUES (?,?,?,?,?,?,?)",
                (tid, tid + ".mp3", title, aid, "Tester", disc, trk),
            )
        conn.commit()
        conn.close()

        self.assertEqual([t["id"] for t in db.get_album_tracks(aid)], ["ord_b", "ord_c", "ord_a"])

        ids = {row["id"] for row in db.get_albums_catalog_rows()}
        self.assertIn(aid, ids)
        self.assertNotIn(empty, ids)

        row = next(r for r in db.get_albums_catalog_rows() if r["id"] == aid)
        self.assertEqual(row["track_count"], 3)
        self.assertEqual(row["cover_track_id"], "ord_b")

    def test_backfill_merges_legacy_duplicates_and_fills_album_artist(self):
        conn = db.get_connection()
        cursor = conn.cursor()
        cursor.execute("DROP INDEX IF EXISTS idx_albums_identity")
        cursor.execute("INSERT INTO albums (title, album_artist) VALUES ('Legacy Home', NULL)")
        first = cursor.lastrowid
        cursor.execute("INSERT INTO albums (title, album_artist) VALUES ('Legacy Home', NULL)")
        second = cursor.lastrowid
        cursor.execute(
            "INSERT INTO tracks (id,file_path,title,album_id,artist,album_artist,year) "
            "VALUES ('lc1','lc1.mp3','T1',?, 'Daft Punk','Daft Punk','1997')",
            (first,),
        )
        cursor.execute(
            "INSERT INTO tracks (id,file_path,title,album_id,artist) VALUES ('lc2','lc2.mp3','T2',?, 'Daft Punk')",
            (second,),
        )
        conn.commit()
        conn.close()

        albums.backfill_album_identities()

        survivor = db.get_album(first)
        self.assertIsNotNone(survivor)
        self.assertIsNone(db.get_album(second))
        self.assertEqual(survivor["album_artist"], "Daft Punk")
        self.assertEqual(survivor["year"], "1997")
        self.assertEqual(db.get_track("lc2")["album_id"], first)
        indexes = {r["name"]: r for r in db.get_connection().execute("PRAGMA index_list(albums)").fetchall()}
        self.assertEqual(indexes["idx_albums_identity"]["unique"], 1)


class AlbumApiTest(unittest.TestCase):
    """API-тесты альбомов: каталог, detail, PATCH релиза, merge, RBAC, перенос трека."""

    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        from api import app
        from security import hash_password

        if not os.path.exists(SAMPLE_MP3):
            raise unittest.SkipTest("Sample MP3 not found")

        cls.client = TestClient(app)
        for username, role in (("alb_admin", "admin"), ("alb_user", "user")):
            user = db.get_user_by_username(username)
            if not user:
                db.create_user(username, hash_password("pass"), role=role)

        admin_login = cls.client.post("/api/auth/login", json={"username": "alb_admin", "password": "pass"})
        user_login = cls.client.post("/api/auth/login", json={"username": "alb_user", "password": "pass"})
        cls.admin_headers = {"Authorization": f"Bearer {admin_login.json()['access_token']}"}
        cls.user_headers = {"Authorization": f"Bearer {user_login.json()['access_token']}"}
        cls.admin_id = db.get_user_by_username("alb_admin")["id"]

    def _make_track(self, track_id, album_id, filename, *, owner=None):
        dest = os.path.join(AUDIO_DIR, filename)
        shutil.copy2(SAMPLE_MP3, dest)
        db.add_or_update_track(
            track_id=track_id,
            file_path=filename,
            title=f"Title {track_id}",
            album_id=album_id,
            artist="Tester",
            added_by_user_id=self.admin_id if owner is None else owner,
        )
        return track_id, dest

    def tearDown(self):
        for name in ("alb_edit_1.mp3", "alb_edit_2.mp3", "alb_merge_1.mp3", "alb_merge_2.mp3",
                     "alb_move_1.mp3", "alb_move_2.mp3", "alb_clear_1.mp3", "alb_partial_1.mp3"):
            path = os.path.join(AUDIO_DIR, name)
            if os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass

    def test_catalog_returns_full_dto(self):
        aid = db.resolve_album("Catalog DTO Album", album_artist="Catalog Artist", year="2001")
        self._make_track("cat_dto_1", aid, "alb_edit_1.mp3")

        resp = self.client.get("/api/albums", headers=self.user_headers)
        self.assertEqual(resp.status_code, 200)
        album = next(a for a in resp.json() if a["id"] == aid)
        self.assertEqual(album["title"], "Catalog DTO Album")
        self.assertEqual(album["artist"], "Catalog Artist")
        self.assertEqual(album["album_artist"], "Catalog Artist")
        self.assertEqual(album["year"], "2001")
        self.assertEqual(album["track_count"], 1)
        self.assertTrue(album["coverArt"])
        self.assertEqual(album["cover_id"], "cat_dto_1")

    def test_detail_envelope_and_404(self):
        aid = db.resolve_album("Detail Album", album_artist="Detail Artist")
        self._make_track("det_1", aid, "alb_edit_2.mp3")
        self._make_track("det_2", aid, "alb_merge_1.mp3")

        resp = self.client.get(f"/api/albums/{aid}", headers=self.user_headers)
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["album"]["id"], aid)
        self.assertEqual(body["album"]["track_count"], 2)
        self.assertEqual(len(body["tracks"]), 2)

        missing = self.client.get("/api/albums/999999", headers=self.user_headers)
        self.assertEqual(missing.status_code, 404)

    def test_patch_album_writes_all_track_files(self):
        aid = db.resolve_album("Album Edit", album_artist="Edit Artist", year="2000")
        _, f1 = self._make_track("edit_1", aid, "alb_edit_1.mp3")
        _, f2 = self._make_track("edit_2", aid, "alb_edit_2.mp3")

        resp = self.client.patch(
            f"/api/albums/{aid}",
            json={"title": "Album Edit Renamed", "album_artist": "New Edit Artist", "year": "2002"},
            headers=self.admin_headers,
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["status"], "success")

        updated = db.get_album(aid)
        self.assertEqual(updated["title"], "Album Edit Renamed")
        self.assertEqual(updated["album_artist"], "New Edit Artist")
        self.assertEqual(updated["year"], "2002")

        for path in (f1, f2):
            meta = read_audio_metadata(path)
            self.assertEqual(meta.album, "Album Edit Renamed")
            self.assertEqual(meta.album_artist, "New Edit Artist")
            self.assertEqual(meta.year, "2002")

    def test_patch_album_merges_on_identity_conflict(self):
        source = db.resolve_album("Album Merge Source", album_artist="Merge Artist")
        target = db.resolve_album("Album Merge Target", album_artist="Merge Artist")
        self._make_track("merge_1", source, "alb_merge_1.mp3")
        self._make_track("merge_2", target, "alb_merge_2.mp3")

        resp = self.client.patch(
            f"/api/albums/{source}",
            json={"title": "Album Merge Target"},
            headers=self.admin_headers,
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertTrue(body["merged"])

        self.assertIsNone(db.get_album(source))
        self.assertEqual(db.get_track("merge_1")["album_id"], target)
        self.assertEqual(db.get_track("merge_2")["album_id"], target)
        self.assertEqual(len(db.get_album_tracks(target)), 2)

    def test_patch_album_requires_permissions(self):
        aid = db.resolve_album("Album RBAC", album_artist="Rbac Artist")
        self._make_track("rbac_1", aid, "alb_edit_1.mp3", owner=self.admin_id)

        resp = self.client.patch(
            f"/api/albums/{aid}",
            json={"title": "Hacked"},
            headers=self.user_headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_patch_album_clears_year(self):
        aid = db.resolve_album("Album Clear Year", album_artist="Clear Artist", year="1999")
        _, f1 = self._make_track("clear_1", aid, "alb_clear_1.mp3")

        resp = self.client.patch(
            f"/api/albums/{aid}",
            json={"year": None},
            headers=self.admin_headers,
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["status"], "success")

        self.assertIsNone(db.get_album(aid)["year"])
        self.assertIsNone(read_audio_metadata(f1).year)

    def test_patch_album_partial_failure_splits_tracks_by_identity(self):
        aid = db.resolve_album("Album Partial", album_artist="Partial Artist")
        self._make_track("part_ok", aid, "alb_partial_1.mp3")
        # Трек с несуществующим файлом: его запись тегов упадёт с 404.
        db.add_or_update_track(
            track_id="part_broken",
            file_path="does_not_exist_partial.mp3",
            title="Broken File",
            album_id=aid,
            artist="Partial Artist",
            added_by_user_id=self.admin_id,
        )

        resp = self.client.patch(
            f"/api/albums/{aid}",
            json={"title": "Album Partial Renamed"},
            headers=self.admin_headers,
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertEqual(body["status"], "partial")
        self.assertEqual([f["track_id"] for f in body["failed_tracks"]], ["part_broken"])

        # Успешный трек — в новом альбоме с новым названием.
        new_album_id = db.get_track("part_ok")["album_id"]
        self.assertNotEqual(new_album_id, aid)
        self.assertEqual(db.get_album(new_album_id)["title"], "Album Partial Renamed")

        # Упавший трек остался в исходном альбоме со старым названием.
        self.assertEqual(db.get_track("part_broken")["album_id"], aid)
        self.assertEqual(db.get_album(aid)["title"], "Album Partial")

    def test_track_move_leaves_other_tracks_untouched(self):
        aid = db.resolve_album("Album Move Origin", album_artist="Move Artist")
        self._make_track("move_1", aid, "alb_move_1.mp3")
        self._make_track("move_2", aid, "alb_move_2.mp3")

        resp = self.client.patch(
            "/api/tracks/move_1",
            json={"album": "Album Move Destination", "album_artist": "Move Artist"},
            headers=self.admin_headers,
        )
        self.assertEqual(resp.status_code, 200, resp.text)

        moved_id = db.get_track("move_1")["album_id"]
        self.assertNotEqual(moved_id, aid)
        self.assertEqual(db.get_album(moved_id)["title"], "Album Move Destination")
        self.assertEqual(db.get_track("move_2")["album_id"], aid)
        self.assertIsNotNone(db.get_album(aid))


if __name__ == "__main__":
    unittest.main()
