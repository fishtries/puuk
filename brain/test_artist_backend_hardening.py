"""Backend hardening for the artist section contract (EV-3..EV-8, EV-11, EV-12).

Covered contract points:
- EV-3: catalog is computed by SQL aggregation (no full-table reads in Python);
- EV-4: catalog and detail share one resolution path (`find_artist_by_id`);
- EV-5: no track-cover fallback for artist artwork (`artwork_url is None`);
- EV-6: `GET /api/artists/{id}/artwork` uses `get_cover_user` (Bearer and `?token=`);
- EV-7: play-start returns `ignored` for empty / Various Artists artists;
- EV-8: repository exposes explicit public functions (no private import in routers);
- EV-11: artwork error paths (404, 401, 304, 415, 400, 413, 403) covered;
- EV-12: `brain/artist_artwork/` is gitignored.

Each test uses the shared isolated DB from `test_db_path` (PUUK_DB_PATH).
"""
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — isolated DB, must be imported before db/config

import db
from fastapi.testclient import TestClient
from PIL import Image

from repositories import artists

ARTIST_DIR_ROOT = Path(__file__).resolve().parent


def _add_track(track_id, title, artist, album_id=None, position=None):
    db.add_or_update_track(
        track_id=track_id,
        file_path=f"/nonexistent/{track_id}.mp3",
        title=title,
        album_id=album_id,
        artist=artist,
        duration=1.0,
        file_mtime_ns=1111111111,
    )
    if position is not None:
        conn = db.get_connection()
        conn.execute(
            "UPDATE tracks SET album_track_position = ? WHERE id = ?",
            (position, track_id),
        )
        conn.commit()
        conn.close()


def _jpeg_bytes(size=(64, 64), color=(200, 30, 30)):
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="JPEG")
    return buffer.getvalue()


def _png_bytes(size=(64, 64), color=(30, 200, 30)):
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def _webp_bytes(size=(64, 64), color=(30, 30, 200)):
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="WEBP")
    return buffer.getvalue()


def _login(client, username="admin", password="admin"):
    resp = client.post("/api/auth/login", json={"username": username, "password": password})
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


def _non_admin_headers(client):
    from security import hash_password

    username = f"regular_artist_{os.getpid()}"
    existing = db.get_user_by_username(username)
    if not existing:
        db.create_user(username, hash_password("secret123"), role="user")
    resp = client.post("/api/auth/login", json={"username": username, "password": "secret123"})
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


class _ArtistFixture(unittest.TestCase):
    """Shared fixture: a few artists, one album, one Various Artists track."""

    PREFIX = "hard00"

    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.client = TestClient(db_app())
        cls.admin = _login(cls.client)
        cls.user = _non_admin_headers(cls.client)

        cls.album_id = db.resolve_album("Hardening Album", album_artist="Hardening Artist")
        cls.album_only_id = db.resolve_album("Guest Album", album_artist="Hardening Guest")

        cls.track_ids = {
            "alpha1": f"{cls.PREFIX}-track-alpha1",
            "alpha2": f"{cls.PREFIX}-track-alpha2",
            "beta1": f"{cls.PREFIX}-track-beta1",
            "low": f"{cls.PREFIX}-track-low",
            "va": f"{cls.PREFIX}-track-va",
            "empty": f"{cls.PREFIX}-track-empty",
            "guest": f"{cls.PREFIX}-track-guest",
        }
        _add_track(cls.track_ids["alpha1"], "Hard Alpha One", "Hardening Artist", cls.album_id, 1)
        _add_track(cls.track_ids["alpha2"], "Hard Alpha Two", "Hardening   Artist", cls.album_id, 2)
        _add_track(cls.track_ids["beta1"], "Hard Beta One", "Hardening Artist", cls.album_id, 3)
        _add_track(cls.track_ids["low"], "Hard Low", "Hardening Low", None)
        _add_track(cls.track_ids["va"], "Hard VA", "Various Artists", None)
        _add_track(cls.track_ids["empty"], "Hard Empty", "   ", None)
        # Guest album: album_artist does not match track artist -> not in artist discography
        _add_track(cls.track_ids["guest"], "Hard Guest", "Hardening Guest Performer", cls.album_only_id)

        cls.artist_name = "Hardening Artist"
        cls.artist_id = artists.artist_id_for_name(cls.artist_name)

    @classmethod
    def tearDownClass(cls):
        conn = db.get_connection()
        placeholders = ",".join("?" * len(cls.track_ids))
        conn.execute(
            f"DELETE FROM artist_play_starts WHERE track_id IN ({placeholders})",
            list(cls.track_ids.values()),
        )
        conn.execute(
            f"DELETE FROM tracks WHERE id IN ({placeholders})",
            list(cls.track_ids.values()),
        )
        conn.execute("DELETE FROM artist_artwork WHERE artist_id = ?", (cls.artist_id,))
        conn.commit()
        conn.close()


def db_app():
    from api import app

    return app


class CatalogPathTest(_ArtistFixture):
    def test_catalog_sql_aggregation_no_full_table_read(self):
        """EV-3: catalog issues a bounded number of set-based queries."""
        statements = []

        real_get_connection = artists.get_connection

        def tracing_connection():
            conn = real_get_connection()
            conn.set_trace_callback(statements.append)
            return conn

        with mock.patch.object(artists, "get_connection", side_effect=tracing_connection):
            catalog = artists.get_artist_catalog()

        self.assertIn(self.artist_id, [item["id"] for item in catalog])
        # Two statements: aggregation + artwork lookup. No per-row SELECT.
        executed = [s for s in statements if s.strip().upper().startswith("SELECT")]
        self.assertLessEqual(len(executed), 3, executed)
        self.assertTrue(
            any("COUNT(" in s.upper() and "TRACK_ARTISTS" in s.upper() for s in executed),
            "catalog must count indexed credit membership in SQL",
        )

    def test_catalog_counts_and_shape(self):
        catalog = {item["id"]: item for item in artists.get_artist_catalog("Hardening")}
        self.assertIn(self.artist_id, catalog)
        item = catalog[self.artist_id]
        self.assertEqual(item["track_count"], 3)
        self.assertEqual(item["album_count"], 1)
        self.assertEqual(item["artwork_version"], 0)
        # Display name is the deterministically smallest spelling (code points).
        self.assertEqual(item["name"], "Hardening   Artist")

    def test_catalog_excludes_empty_and_various(self):
        names = {item["name"] for item in artists.get_artist_catalog()}
        self.assertNotIn("Various Artists", names)
        self.assertNotIn("   ", names)
        self.assertFalse(any(artists.is_various_artists(name) for name in names))

    def test_catalog_query_case_insensitive_and_trimmed(self):
        for query in ("HARDENING", "  hardening  ", "Hardening"):
            with self.subTest(query=query):
                ids = [item["id"] for item in artists.get_artist_catalog(query)]
                self.assertIn(self.artist_id, ids)
                # Case-insensitive substring match, not exact equality.
                self.assertIn(artists.artist_id_for_name("Hardening Low"), ids)

    def test_catalog_query_substring_excludes_non_matches(self):
        for query in ("Hardening Guest", "guest  performer"):
            with self.subTest(query=query):
                ids = [item["id"] for item in artists.get_artist_catalog(query)]
                self.assertNotIn(self.artist_id, ids)
                self.assertIn(artists.artist_id_for_name("Hardening Guest Performer"), ids)

    def test_whitespace_variants_collapse_to_one_artist(self):
        matches = [i for i in artists.get_artist_catalog() if i["id"] == self.artist_id]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["track_count"], 3)


class DetailPathTest(_ArtistFixture):
    def test_detail_and_catalog_share_identity(self):
        """EV-4: detail resolves the same id/name/counts as the catalog."""
        catalog_item = next(
            i for i in artists.get_artist_catalog() if i["id"] == self.artist_id
        )
        detail = artists.get_artist_detail(self.artist_id, "http://test")
        self.assertIsNotNone(detail)
        self.assertEqual(detail["artist"]["id"], catalog_item["id"])
        self.assertEqual(detail["artist"]["name"], catalog_item["name"])
        self.assertEqual(detail["artist"]["track_count"], catalog_item["track_count"])
        self.assertEqual(detail["artist"]["album_count"], catalog_item["album_count"])

    def test_detail_unknown_and_various_are_none(self):
        self.assertIsNone(artists.get_artist_detail("art_doesnotexist", "http://test"))
        self.assertIsNone(artists.get_artist_detail("", "http://test"))
        va_id = artists.artist_id_for_name("Various Artists")
        self.assertIsNone(va_id)
        self.assertIsNone(artists.get_artist_detail(va_id or "art_x", "http://test"))

    def test_popular_tracks_top10_and_tiebreak(self):
        detail = artists.get_artist_detail(self.artist_id, "http://test")
        self.assertEqual(len(detail["popular_tracks"]), 3)
        self.assertEqual([t["play_count"] for t in detail["popular_tracks"]], [0, 0, 0])
        titles = [t["title"] for t in detail["popular_tracks"]]
        self.assertEqual(titles, sorted(titles, key=lambda s: (s.casefold(), s)) or titles)
        # Deterministic cold start: alphabetical by title, then id
        self.assertEqual(titles, ["Hard Alpha One", "Hard Alpha Two", "Hard Beta One"])

    def test_discography_excludes_guest_album(self):
        detail = artists.get_artist_detail(self.artist_id, "http://test")
        titles = {album["title"] for album in detail["albums"]}
        self.assertIn("Hardening Album", titles)
        self.assertNotIn("Guest Album", titles)

    def test_no_track_cover_fallback_for_artwork(self):
        """EV-5: artwork_url must be null when only a manual artwork is absent."""
        detail = artists.get_artist_detail(self.artist_id, "http://test")
        self.assertIsNone(detail["artist"]["artwork_url"])
        self.assertEqual(detail["artist"]["artwork_version"], 0)
        for item in artists.get_artist_catalog():
            self.assertIsNone(item.get("cover_track_id") is not None and item.get("artwork_url"))
            dto = artists.public_artist(item, "http://test")
            if dto["artwork_version"] == 0:
                self.assertIsNone(dto["artwork_url"])
            self.assertNotIn("/api/cover/", dto["artwork_url"] or "")


class PublicRepositoryApiTest(unittest.TestCase):
    def test_explicit_public_functions_exist(self):
        """EV-8: repository exposes explicit public functions."""
        for name in (
            "normalize_artist_name",
            "artist_id_for_name",
            "is_various_artists",
            "get_artist_catalog",
            "get_artist_detail",
            "find_artist_by_id",
            "get_artist_summary",
            "public_artist",
            "record_play_start",
            "get_artwork_metadata",
            "replace_artwork_atomically",
            "remove_artwork_atomically",
        ):
            with self.subTest(name=name):
                self.assertTrue(callable(getattr(artists, name, None)), name)

    def test_router_does_not_use_private_repository_internals(self):
        source = (ARTIST_DIR_ROOT / "routers" / "artists.py").read_text(encoding="utf-8")
        self.assertNotIn("artists._", source)


class PlayStartStatusTest(_ArtistFixture):
    def _post(self, track_id, headers=None):
        return self.client.post(
            f"/api/tracks/{track_id}/play-start", headers=headers or self.admin
        )

    def test_recorded_then_duplicate(self):
        track_id = self.track_ids["beta1"]
        first = self._post(track_id)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["status"], "recorded")
        second = self._post(track_id)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["status"], "duplicate")

    def test_ignored_for_various_artists(self):
        """EV-7: Various Artists track -> 200 ignored, no event written."""
        resp = self._post(self.track_ids["va"])
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["status"], "ignored")
        conn = db.get_connection()
        count = conn.execute(
            "SELECT COUNT(*) AS c FROM artist_play_starts WHERE track_id = ?",
            (self.track_ids["va"],),
        ).fetchone()["c"]
        conn.close()
        self.assertEqual(count, 0)

    def test_ignored_for_empty_artist(self):
        resp = self._post(self.track_ids["empty"])
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["status"], "ignored")

    def test_unknown_track_404(self):
        resp = self._post("does-not-exist")
        self.assertEqual(resp.status_code, 404)

    def test_anonymous_401(self):
        resp = self.client.post(f"/api/tracks/{self.track_ids['beta1']}/play-start")
        self.assertEqual(resp.status_code, 401)

    def test_play_start_affects_ranking(self):
        track_id = self.track_ids["alpha1"]
        self._post(track_id)
        detail = artists.get_artist_detail(self.artist_id, "http://test")
        top = detail["popular_tracks"][0]
        self.assertEqual(top["id"], track_id)
        self.assertEqual(top["play_count"], 1)


class ArtworkEndpointTest(_ArtistFixture):
    """EV-6 / EV-11: artwork auth via Bearer and ?token=, plus error paths."""

    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory(prefix="puuk_artwork_")
        self.addCleanup(self._tmpdir.cleanup)
        self._patch = mock.patch("routers.artists.ARTIST_ARTWORK_DIR", self._tmpdir.name)
        self._patch.start()
        self.addCleanup(self._patch.stop)

        conn = db.get_connection()
        conn.execute("DELETE FROM artist_artwork WHERE artist_id = ?", (self.artist_id,))
        conn.commit()
        conn.close()
        self.path = os.path.join(self._tmpdir.name, f"{self.artist_id}.jpg")

    def _put(self, data=None, mime="image/jpeg", filename="a.jpg", headers=None):
        return self.client.put(
            f"/api/artists/{self.artist_id}/artwork",
            files={"file": (filename, data if data is not None else _jpeg_bytes(), mime)},
            headers=headers or self.admin,
        )

    def test_put_get_bearer_and_query_token(self):
        put = self._put()
        self.assertEqual(put.status_code, 200, put.text)
        version = put.json()["artwork_version"]
        self.assertGreaterEqual(version, 1)
        self.assertTrue(os.path.isfile(self.path))

        with Image.open(self.path) as stored:
            self.assertEqual(stored.format, "JPEG")

        bearer = self.client.get(
            f"/api/artists/{self.artist_id}/artwork", headers=self.admin
        )
        self.assertEqual(bearer.status_code, 200)
        self.assertEqual(bearer.headers["content-type"], "image/jpeg")
        self.assertEqual(bearer.headers["etag"], f'"{self.artist_id}-{version}"')
        self.assertIn("private", bearer.headers["cache-control"])

        bearer_token = self.admin["Authorization"].split(" ", 1)[1]
        query = self.client.get(
            f"/api/artists/{self.artist_id}/artwork?token={bearer_token}"
        )
        self.assertEqual(query.status_code, 200)
        self.assertEqual(query.content, bearer.content)

    def test_if_none_match_returns_304(self):
        self._put()
        first = self.client.get(f"/api/artists/{self.artist_id}/artwork", headers=self.admin)
        etag = first.headers["etag"]
        second = self.client.get(
            f"/api/artists/{self.artist_id}/artwork",
            headers={**self.admin, "If-None-Match": etag},
        )
        self.assertEqual(second.status_code, 304)
        self.assertEqual(second.content, b"")

    def test_query_v_does_not_authorize(self):
        self._put()
        resp = self.client.get(f"/api/artists/{self.artist_id}/artwork?v=2")
        self.assertEqual(resp.status_code, 401)

    def test_missing_artwork_404(self):
        resp = self.client.get(f"/api/artists/{self.artist_id}/artwork", headers=self.admin)
        self.assertEqual(resp.status_code, 404)

    def test_metadata_present_but_file_missing_404(self):
        self._put()
        os.unlink(self.path)
        resp = self.client.get(f"/api/artists/{self.artist_id}/artwork", headers=self.admin)
        self.assertEqual(resp.status_code, 404)

    def test_unknown_artist_404(self):
        resp = self.client.get("/api/artists/art_unknown/artwork", headers=self.admin)
        self.assertEqual(resp.status_code, 404)

    def test_put_non_admin_403(self):
        resp = self._put(headers=self.user)
        self.assertEqual(resp.status_code, 403)

    def test_put_anonymous_401(self):
        resp = self.client.put(
            f"/api/artists/{self.artist_id}/artwork",
            files={"file": ("a.jpg", _jpeg_bytes(), "image/jpeg")},
        )
        self.assertEqual(resp.status_code, 401)

    def test_put_png_and_webp_are_reencoded_to_jpeg(self):
        for payload in (_png_bytes(), _webp_bytes()):
            with self.subTest(fmt=payload[:4]):
                resp = self._put(payload, mime="image/png")
                self.assertEqual(resp.status_code, 200, resp.text)
                with Image.open(self.path) as stored:
                    self.assertEqual(stored.format, "JPEG")

    def test_put_empty_400(self):
        resp = self._put(b"")
        self.assertEqual(resp.status_code, 400)

    def test_put_garbage_415(self):
        resp = self._put(b"not an image at all", mime="image/jpeg")
        self.assertEqual(resp.status_code, 415)

    def test_put_oversize_413(self):
        big = b"\xff\xd8" + b"0" * (5 * 1024 * 1024 + 1)
        resp = self._put(big, mime="image/jpeg")
        self.assertEqual(resp.status_code, 413)

    def test_delete_idempotent_and_bumps_version(self):
        put1 = self._put()
        v1 = put1.json()["artwork_version"]
        put2 = self._put(_png_bytes(), mime="image/png")
        v2 = put2.json()["artwork_version"]
        self.assertGreater(v2, v1)

        deleted = self.client.delete(f"/api/artists/{self.artist_id}/artwork", headers=self.admin)
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.json()["status"], "removed")
        self.assertFalse(os.path.isfile(self.path))

        again = self.client.delete(f"/api/artists/{self.artist_id}/artwork", headers=self.admin)
        self.assertEqual(again.status_code, 200)
        after = self.client.get(f"/api/artists/{self.artist_id}/artwork", headers=self.admin)
        self.assertEqual(after.status_code, 404)

    def test_failed_replace_restores_previous_file(self):
        """EV-11 / B15: a failing replace must keep the previous artwork."""
        first = self._put()
        self.assertEqual(first.status_code, 200)
        before = Path(self.path).read_bytes()
        version_before = first.json()["artwork_version"]

        with mock.patch.object(
            artists, "replace_artwork_atomically", side_effect=RuntimeError("boom")
        ):
            with self.assertRaises(RuntimeError):
                self._put(_png_bytes(), mime="image/png")

        self.assertTrue(os.path.isfile(self.path))
        self.assertEqual(Path(self.path).read_bytes(), before)
        meta = artists.get_artwork_metadata(self.artist_id)
        self.assertEqual(meta["version"], version_before)
        leftovers = [n for n in os.listdir(self._tmpdir.name) if n.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_delete_non_admin_403(self):
        resp = self.client.delete(
            f"/api/artists/{self.artist_id}/artwork", headers=self.user
        )
        self.assertEqual(resp.status_code, 403)


class GitignoreTest(unittest.TestCase):
    def test_artist_artwork_dir_is_gitignored(self):
        """EV-12: runtime artwork directory must not be committable."""
        gitignore = (ARTIST_DIR_ROOT.parent / ".gitignore").read_text(encoding="utf-8")
        self.assertIn("brain/artist_artwork/", gitignore.splitlines())


if __name__ == "__main__":
    unittest.main()
