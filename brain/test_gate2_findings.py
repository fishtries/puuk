"""Test fixes for Gate 2 HIGH findings: H1 (non-ASCII search), H2 (album_count consistency), H3 (NULL album_artist)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД, должен идти до db/config

import db
from repositories import artists
from repositories import albums as albums_repo


def _add_track(track_id, title, artist, album_id=None):
    """Helper to add a track."""
    db.add_or_update_track(
        track_id=track_id,
        file_path=f"/nonexistent/{track_id}.mp3",
        title=title,
        album_id=album_id,
        artist=artist,
        duration=1.0,
        file_mtime_ns=1111111111,
    )


def _add_album(title, album_artist=None, year=None):
    """Helper to add an album; returns album_id."""
    return albums_repo.resolve_album(title, album_artist=album_artist, year=year)


class H1NonASCIISearchTest(unittest.TestCase):
    """H1: catalog search must be truly case-insensitive for non-ASCII (Cyrillic, accented Latin).
    
    Current query-only casefold + ASCII-only SQLite LIKE fails for ADÉLA/Кино.
    Use a Python casefold UDF that normalizes both column and query.
    """
    
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.track_ids = []
        
        # Add tracks with accented Latin and Cyrillic artists
        test_cases = [
            ("adela-1", "Track 1", "ADÉLA"),
            ("adela-2", "Track 2", "adéla"),
            ("adela-3", "Track 3", "Adéla"),
            ("kino-1", "Track 1", "КИНО"),
            ("kino-2", "Track 2", "кино"),
            ("kino-3", "Track 3", "Кино"),
        ]
        for track_id, title, artist in test_cases:
            _add_track(track_id, title, artist)
            cls.track_ids.extend([track_id])
    
    @classmethod
    def tearDownClass(cls):
        conn = db.get_connection()
        conn.execute(
            "DELETE FROM tracks WHERE id IN (%s)" % ",".join("?" * len(cls.track_ids)),
            cls.track_ids,
        )
        conn.commit()
        conn.close()
    
    def test_search_accented_latin_uppercase_query(self):
        """Search with uppercase accented query finds lowercase stored artist."""
        results = artists.get_artist_catalog("ADÉLA")
        names = {r["name"] for r in results}
        self.assertTrue(any("dél" in n.lower() for n in names), 
                       f"Expected to find ADÉLA variant, got {names}")
    
    def test_search_accented_latin_lowercase_query(self):
        """Search with lowercase accented query finds uppercase stored artist."""
        results = artists.get_artist_catalog("adéla")
        names = {r["name"] for r in results}
        self.assertTrue(any("dél" in n.lower() for n in names),
                       f"Expected to find ADÉLA variant, got {names}")
    
    def test_search_cyrillic_uppercase_query(self):
        """Search with uppercase Cyrillic query finds lowercase stored artist."""
        results = artists.get_artist_catalog("КИНО")
        names = {r["name"] for r in results}
        self.assertTrue(any("ино" in n.lower() for n in names),
                       f"Expected to find КИНО variant, got {names}")
    
    def test_search_cyrillic_lowercase_query(self):
        """Search with lowercase Cyrillic query finds uppercase stored artist."""
        results = artists.get_artist_catalog("кино")
        names = {r["name"] for r in results}
        self.assertTrue(any("ино" in n.lower() for n in names),
                       f"Expected to find КИНО variant, got {names}")


class H2AlbumCountConsistencyTest(unittest.TestCase):
    """H2: artist.album_count must equal the albums[] list length in the same detail payload.
    
    Problem: album_count counts all distinct albums a track artist appears in,
    but discography only returns albums where album_artist matches or is NULL.
    
    Fix: Derive both from the same discography query/rule.
    """
    
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.track_ids = []
        cls.album_ids = []
        
        # Setup: album A (album_artist=Real Artist, track Real Artist) 
        #        + album B (album_artist=Other Act, track Real Artist)
        # Expected: album_count == len(albums) == 1 (only A, not B)
        
        album_a_id = _add_album("Album A", album_artist="Real Artist", year="2020")
        cls.album_ids.append(album_a_id)
        
        album_b_id = _add_album("Album B", album_artist="Other Act", year="2021")
        cls.album_ids.append(album_b_id)
        
        track_a_id = "track-a-1"
        track_b_id = "track-b-1"
        
        db.add_or_update_track(
            track_id=track_a_id,
            file_path="/nonexistent/a.mp3",
            title="Song A",
            album_id=album_a_id,
            artist="Real Artist",
            duration=1.0,
            file_mtime_ns=1111111111,
        )
        cls.track_ids.append(track_a_id)
        
        db.add_or_update_track(
            track_id=track_b_id,
            file_path="/nonexistent/b.mp3",
            title="Song B",
            album_id=album_b_id,
            artist="Real Artist",
            duration=1.0,
            file_mtime_ns=1111111111,
        )
        cls.track_ids.append(track_b_id)
    
    @classmethod
    def tearDownClass(cls):
        conn = db.get_connection()
        if cls.track_ids:
            conn.execute(
                "DELETE FROM tracks WHERE id IN (%s)" % ",".join("?" * len(cls.track_ids)),
                cls.track_ids,
            )
        if cls.album_ids:
            conn.execute(
                "DELETE FROM albums WHERE id IN (%s)" % ",".join("?" * len(cls.album_ids)),
                cls.album_ids,
            )
        conn.commit()
        conn.close()
    
    def test_album_count_equals_albums_list_length(self):
        """album_count in detail must equal len(albums) from same response."""
        artist_id = artists.artist_id_for_name("Real Artist")
        self.assertIsNotNone(artist_id)
        
        detail = artists.get_artist_detail(artist_id, "http://test")
        self.assertIsNotNone(detail)
        
        album_count = detail["artist"]["album_count"]
        albums_list = detail["albums"]
        
        self.assertEqual(album_count, len(albums_list),
                        f"album_count ({album_count}) must equal len(albums) ({len(albums_list)})")
        self.assertEqual(album_count, 1, "Should have exactly 1 album (A only, not B)")
        self.assertEqual(len(albums_list), 1, "Albums list should have 1 album")


class H3NullAlbumArtistTest(unittest.TestCase):
    """Album credits, rather than a track artist, control discography membership."""

    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.track_ids = []
        cls.album_ids = []
        
        # Album with NULL album_artist, track artist = "Solo Performer"
        album_null_id = _add_album("Solo Album", album_artist=None, year="2022")
        cls.album_ids.append(album_null_id)
        
        track_null_id = "track-null-1"
        db.add_or_update_track(
            track_id=track_null_id,
            file_path="/nonexistent/solo.mp3",
            title="Solo Track",
            album_id=album_null_id,
            artist="Solo Performer",
            duration=1.0,
            file_mtime_ns=1111111111,
        )
        cls.track_ids.append(track_null_id)
    
    @classmethod
    def tearDownClass(cls):
        conn = db.get_connection()
        if cls.track_ids:
            conn.execute(
                "DELETE FROM tracks WHERE id IN (%s)" % ",".join("?" * len(cls.track_ids)),
                cls.track_ids,
            )
        if cls.album_ids:
            conn.execute(
                "DELETE FROM albums WHERE id IN (%s)" % ",".join("?" * len(cls.album_ids)),
                cls.album_ids,
            )
        conn.commit()
        conn.close()
    
    def test_null_album_artist_excluded_from_discography(self):
        artist_id = artists.artist_id_for_name("Solo Performer")
        detail = artists.get_artist_detail(artist_id, "http://test")
        self.assertIsNotNone(detail)
        self.assertEqual(len(detail["albums"]), 0)
        self.assertEqual(len(detail["popular_tracks"]), 1)

    def test_album_count_consistent_with_null_album_artist(self):
        """album_count must match albums[] length even with NULL album_artist."""
        artist_id = artists.artist_id_for_name("Solo Performer")
        detail = artists.get_artist_detail(artist_id, "http://test")
        
        album_count = detail["artist"]["album_count"]
        albums_list = detail["albums"]
        
        self.assertEqual(album_count, len(albums_list),
                        f"album_count ({album_count}) must equal len(albums) ({len(albums_list)})")
        self.assertEqual(album_count, 0, "Empty album credits do not attribute the album")


if __name__ == "__main__":
    unittest.main()
