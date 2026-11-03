"""Поиск и альбомные DTO: стабильный artist_id и схлопывание вариантов имени.

Покрывает контракт §4.6 и §5:
- search artists: `id` == `artist_id`, дубли по artist_id схлопнуты,
  зарезервированный Various Artists и пустые имена исключены, лимит
  применяется после схлопывания;
- album artist_id выводится в одном месте (serialize_album) и не берётся
  из fallback-ярлыка "Various Artists";
- поиск альбома по гостевому исполнителю не подменяет artist_id релиза.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД, должен идти до db/config

import db
from fastapi.testclient import TestClient
from api import app
from repositories import artists
from services.album_service import serialize_album


class AlbumDtoArtistIdTest(unittest.TestCase):
    def _dto(self, **row):
        base = {"id": 1, "title": "A", "album_artist": "Album Artist", "year": "2020",
                "track_count": 1, "cover_track_id": None}
        base.update(row)
        artist_id = artists.artist_id_for_name(base['album_artist'])
        base['artist_id'] = artist_id
        base['artists'] = [{'id': artist_id, 'name': artists.normalize_artist_name(base['album_artist'])}] if artist_id else []
        base['artists_revision'] = 1
        return serialize_album(base, "http://test")

    def test_artist_id_come_from_album_artist(self):
        dto = self._dto()
        self.assertEqual(dto["artist_id"], artists.artist_id_for_name("Album Artist"))

    def test_various_artists_album_has_no_artist_id(self):
        dto = self._dto(album_artist="Various Artists")
        self.assertIsNone(dto["artist_id"])
        for label in ("various artists", "VARIOUS ARTISTS", " various   artists "):
            with self.subTest(label=label):
                self.assertIsNone(self._dto(album_artist=label)["artist_id"])

    def test_missing_album_artist_falls_back_to_track_artist(self):
        dto = self._dto(album_artist="", artist="Fallback Artist")
        self.assertIsNone(dto["artist_id"])

    def test_display_artist_keeps_various_artists_fallback(self):
        dto = self._dto(album_artist="")
        self.assertEqual(dto["artist"], db.VARIOUS_ARTISTS)
        self.assertIsNone(dto["artist_id"])

    def test_artist_id_is_case_sensitive(self):
        self.assertNotEqual(
            self._dto(album_artist="Artist A")["artist_id"],
            self._dto(album_artist="artist a")["artist_id"],
        )


class SearchAlbumsArtistsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.client = TestClient(app)
        login = cls.client.post(
            "/api/auth/login", json={"username": "admin", "password": "admin"}
        )
        cls.headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

        cls.compilation = db.resolve_album("Search Compilation", album_artist="Various Artists")
        cls.solo = db.resolve_album("Search Solo", album_artist="Search Solo Artist")
        cls.guest = db.resolve_album("Search Guest", album_artist="Search Solo Artist")

        cls.track_ids = [
            "c0ffee00-0000-4000-8000-000000000001",
            "c0ffee00-0000-4000-8000-000000000002",
            "c0ffee00-0000-4000-8000-000000000003",
            "c0ffee00-0000-4000-8000-000000000004",
            "c0ffee00-0000-4000-8000-000000000005",
        ]
        for track_id, title, artist, album_id in [
            (cls.track_ids[0], "Comp Song", "Various Artists", cls.compilation),
            (cls.track_ids[1], "Solo Song", "Search Solo Artist", cls.solo),
            (cls.track_ids[2], "Solo Song Two", "Search   Solo Artist", cls.solo),
            (cls.track_ids[3], "Guest Song", "Search Guest Performer", cls.guest),
            (cls.track_ids[4], "Standalone", "Search Standalone", None),
        ]:
            db.add_or_update_track(
                track_id=track_id,
                file_path=f"/nonexistent/{track_id}.mp3",
                title=title,
                album_id=album_id,
                artist=artist,
                duration=1.0,
                file_mtime_ns=1111111111,
            )

    @classmethod
    def tearDownClass(cls):
        conn = db.get_connection()
        conn.execute(
            "DELETE FROM tracks WHERE id IN (%s)" % ",".join("?" * len(cls.track_ids)),
            cls.track_ids,
        )
        conn.commit()
        conn.close()

    def _search(self, query, **params):
        resp = self.client.get(
            "/api/search", params={"q": query, **params}, headers=self.headers
        )
        self.assertEqual(resp.status_code, 200)
        return resp.json()

    def test_search_artists_expose_id_and_artist_id(self):
        artists_out = self._search("Search Solo Artist")["artists"]
        self.assertEqual(len(artists_out), 1)
        item = artists_out[0]
        self.assertEqual(item["id"], item["artist_id"])
        self.assertEqual(item["artist_id"], artists.artist_id_for_name("Search Solo Artist"))
        for field in ("name", "track_count", "album_count", "coverArt"):
            self.assertIn(field, item)

    def test_whitespace_variants_collapse_to_one_artist(self):
        # Запрос "Solo Artist" (LIKE чувствителен к пробелам) находит оба трека:
        # "Search Solo Artist" и "Search   Solo Artist". Они обязаны дать одну
        # группу, а не две записи с одинаковым artist_id.
        artists_out = self._search("Solo Artist")["artists"]
        solo_id = artists.artist_id_for_name("Search Solo Artist")
        matching = [a for a in artists_out if a["artist_id"] == solo_id]
        self.assertEqual(len(matching), 1)
        self.assertGreaterEqual(matching[0]["track_count"], 2)

    def test_artist_ids_are_unique_in_search_results(self):
        for query in ("Search", "Solo", "Artist"):
            ids = [a["artist_id"] for a in self._search(query)["artists"]]
            with self.subTest(query=query):
                self.assertEqual(len(ids), len(set(ids)))

    def test_various_artists_is_excluded_from_search_artists(self):
        for query in ("Various", "Various Artists", "VARIOUS"):
            with self.subTest(query=query):
                self.assertEqual(self._search(query)["artists"], [])

    def test_empty_artist_names_never_appear(self):
        for item in self._search("Search")["artists"]:
            with self.subTest(name=item["name"]):
                self.assertTrue(item["name"].strip())

    def test_limit_applies_after_deduplication(self):
        artists_out = self._search("Search Solo Artist", limit=1)["artists"]
        self.assertEqual(len(artists_out), 1)

    def test_limit_bounds_are_enforced(self):
        for limit in (0, 101):
            with self.subTest(limit=limit):
                resp = self.client.get(
                    "/api/search", params={"q": "x", "limit": limit}, headers=self.headers
                )
                self.assertEqual(resp.status_code, 422)

    def test_search_album_dto_matches_catalog_dto(self):
        albums_out = {a["title"]: a for a in self._search("Search")["albums"]}
        catalog = {a["title"]: a for a in self.client.get("/api/albums", headers=self.headers).json()}
        for title in ("Search Solo", "Search Guest", "Search Compilation"):
            with self.subTest(title=title):
                self.assertIn(title, albums_out)
                self.assertEqual(albums_out[title]["artist_id"], catalog[title]["artist_id"])
                self.assertEqual(albums_out[title]["artist"], catalog[title]["artist"])

    def test_compilation_album_has_no_artist_id_and_still_displayed(self):
        albums_out = {a["title"]: a for a in self._search("Search")["albums"]}
        compilation = albums_out["Search Compilation"]
        self.assertIsNone(compilation["artist_id"])
        self.assertEqual(compilation["artist"], db.VARIOUS_ARTISTS)

    def test_guest_album_attributed_to_album_artist(self):
        albums_out = {a["title"]: a for a in self._search("Search")["albums"]}
        self.assertEqual(
            albums_out["Search Guest"]["artist_id"],
            artists.artist_id_for_name("Search Solo Artist"),
        )

    def test_album_detail_artist_id_is_single_source(self):
        catalog = {a["title"]: a for a in self.client.get("/api/albums", headers=self.headers).json()}
        detail = self.client.get(f"/api/albums/{self.solo}", headers=self.headers).json()
        self.assertEqual(detail["album"]["artist_id"], catalog["Search Solo"]["artist_id"])

    def test_track_dtos_carry_artist_id(self):
        tracks = self._search("Solo Song")["tracks"]
        self.assertTrue(tracks)
        for track in tracks:
            self.assertIn("artist_id", track)


if __name__ == "__main__":
    unittest.main()
