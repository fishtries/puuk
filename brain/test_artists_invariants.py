"""Пограничные инварианты артистов: стабильный artist_id в TrackDTO и
исключение любых вариантов Various Artists из каталога и detail.

Идентичность артиста регистрозависима (NFKC + сворачивание пробелов, без
casefold); casefold применяется только для распознавания зарезервированного
ярлыка compilation.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД, должен идти до db/config

import db
from repositories import artists
from serializers import serialize_track

VARIOUS_LABELS = [
    "Various Artists",
    "various artists",
    "VARIOUS ARTISTS",
    " various   artists ",
    "vArIoUs\tArTiStS",
]


def _add_track(track_id, title, artist, album_id=None):
    db.add_or_update_track(
        track_id=track_id,
        file_path=f"/nonexistent/{track_id}.mp3",
        title=title,
        album_id=album_id,
        artist=artist,
        duration=1.0,
        file_mtime_ns=1111111111,
    )


class TrackArtistIdSerializationTest(unittest.TestCase):
    def _serialize(self, artist_name):
        artist_id = artists.artist_id_for_name(artist_name)
        members = [{"id": artist_id, "name": artists.normalize_artist_name(artist_name)}] if artist_id else []
        return serialize_track(
            {"id": "t-x", "title": "T", "artist": artist_name, "file_path": "x.mp3",
             "artists": members, "artists_revision": 1, "artist_id": artist_id},
            "http://test",
        )

    def test_serialize_track_does_not_raise_and_returns_stable_id(self):
        dto = self._serialize("Artist A")
        self.assertEqual(dto["artist_id"], artists.artist_id_for_name("Artist A"))
        self.assertTrue(dto["artist_id"].startswith("art_"))

    def test_whitespace_only_differences_share_id(self):
        self.assertEqual(
            self._serialize("DJ  Arbuz")["artist_id"],
            self._serialize("  DJ   Arbuz ")["artist_id"],
        )

    def test_identity_is_case_sensitive(self):
        self.assertNotEqual(
            self._serialize("Artist A")["artist_id"],
            self._serialize("artist a")["artist_id"],
        )

    def test_various_artists_labels_have_no_id(self):
        for label in VARIOUS_LABELS:
            with self.subTest(label=label):
                self.assertIsNone(self._serialize(label)["artist_id"])

    def test_empty_and_missing_artist_have_no_id(self):
        self.assertIsNone(self._serialize("")["artist_id"])
        self.assertIsNone(self._serialize("   ")["artist_id"])
        dto = serialize_track({"id": "t-y", "title": "T", "file_path": "y.mp3"}, "http://test")
        self.assertIsNone(dto["artist_id"])


class VariousArtistsExclusionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.track_ids = []
        for index, label in enumerate(VARIOUS_LABELS):
            track_id = f"c0ffee00-0000-4000-8000-{index + 100:012d}"
            _add_track(track_id, f"Comp Track {index}", label)
            cls.track_ids.append(track_id)
        cls.artist_track_id = "c0ffee00-0000-4000-8000-000000000199"
        _add_track(cls.artist_track_id, "Real Track", "Exclusion Artist")
        cls.track_ids.append(cls.artist_track_id)

    @classmethod
    def tearDownClass(cls):
        conn = db.get_connection()
        conn.execute(
            "DELETE FROM tracks WHERE id IN (%s)" % ",".join("?" * len(cls.track_ids)),
            cls.track_ids,
        )
        conn.commit()
        conn.close()

    def test_artist_id_for_name_rejects_every_variant(self):
        for label in VARIOUS_LABELS:
            with self.subTest(label=label):
                self.assertIsNone(artists.artist_id_for_name(label))

    def test_catalog_contains_no_various_artists_variant(self):
        names = {item["name"] for item in artists.get_artist_catalog()}
        for label in VARIOUS_LABELS:
            with self.subTest(label=label):
                self.assertNotIn(label, names)
        self.assertFalse(
            any(artists.is_various_artists(name) for name in names),
            "каталог не должен содержать зарезервированный ярлык ни в каком регистре",
        )
        self.assertIn("Exclusion Artist", names)

    def test_catalog_search_by_reserved_label_returns_nothing(self):
        for label in VARIOUS_LABELS:
            with self.subTest(label=label):
                self.assertEqual(artists.get_artist_catalog(label), [])

    def test_detail_is_not_resolvable_for_reserved_labels(self):
        for track_id in self.track_ids[:-1]:
            self.assertIsNone(artists.get_artist_detail(track_id, "http://test"))

    def test_detail_resolves_real_artist(self):
        artist_id = artists.artist_id_for_name("Exclusion Artist")
        detail = artists.get_artist_detail(artist_id, "http://test")
        self.assertIsNotNone(detail)
        self.assertEqual(detail["artist"]["name"], "Exclusion Artist")
        self.assertEqual(
            [t["id"] for t in detail["popular_tracks"]],
            [self.artist_track_id],
        )


if __name__ == "__main__":
    unittest.main()
