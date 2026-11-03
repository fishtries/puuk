"""Gate 2 fixes: H1 (case-insensitive search non-ASCII), H2 (album_count consistency),
H3 (NULL album_artist), M1 (404 on race), L1 (dead code), L3 (whitespace-only q).
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — isolates test DB

import db
from repositories import artists
from serializers import serialize_track


class CaseInsensitiveNonASCIISearchTest(unittest.TestCase):
    """H1: Artist catalog search is broken for non-ASCII names."""

    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.track_ids = []
        cls.album_ids = []
        
        # Add tracks with non-ASCII artists
        test_artists = [
            ("ADÉLA", "Track 1"),
            ("Кино", "Track 2"),
            ("ПАРАНОЙЯ", "Track 3"),
            ("Тёмный ПринЦ", "Track 4"),  # mixed case with non-ASCII (all Cyrillic)
        ]
        
        from repositories import tracks, albums as album_repo
        
        for idx, (artist, title) in enumerate(test_artists):
            # Create album first
            album_id = album_repo.add_or_get_album(
                title=f"Album {idx}",
                year="2024",
            )
            cls.album_ids.append(album_id)
            
            track_id = f"h1-test-{idx:04d}"
            tracks.add_or_update_track(
                track_id=track_id,
                file_path=f"/test/h1_{idx}.mp3",
                title=title,
                album_id=album_id,
                artist=artist,
                duration=1.0,
                file_mtime_ns=1111111111,
            )
            cls.track_ids.append(track_id)

    @classmethod
    def tearDownClass(cls):
        conn = db.get_connection()
        conn.execute(
            "DELETE FROM tracks WHERE id IN (%s)" % ",".join("?" * len(cls.track_ids)),
            cls.track_ids,
        )
        conn.commit()
        conn.close()

    def test_exact_case_search_finds_uppercase_non_ascii(self):
        """Query 'ADÉLA' should find artist 'ADÉLA'."""
        results = artists.get_artist_catalog(query="ADÉLA")
        self.assertTrue(any(r["name"] == "ADÉLA" for r in results))

    def test_lowercase_search_finds_uppercase_non_ascii(self):
        """Query 'adéla' (lowercase) should find artist 'ADÉLA' (uppercase)."""
        results = artists.get_artist_catalog(query="adéla")
        self.assertTrue(any(r["name"] == "ADÉLA" for r in results))

    def test_cyrillic_exact_case_search(self):
        """Query 'Кино' should find artist 'Кино'."""
        results = artists.get_artist_catalog(query="Кино")
        self.assertTrue(any(r["name"] == "Кино" for r in results))

    def test_cyrillic_lowercase_search(self):
        """Query 'кино' (lowercase) should find artist 'Кино' (uppercase)."""
        results = artists.get_artist_catalog(query="кино")
        self.assertTrue(any(r["name"] == "Кино" for r in results))

    def test_cyrillic_uppercase_search(self):
        """Query 'КИНО' (uppercase) should find artist 'Кино'."""
        results = artists.get_artist_catalog(query="КИНО")
        self.assertTrue(any(r["name"] == "Кино" for r in results))

    def test_partial_substring_match_non_ascii(self):
        """Query 'парано' should find artist 'ПАРАНОЙЯ'."""
        results = artists.get_artist_catalog(query="парано")
        self.assertTrue(any(r["name"] == "ПАРАНОЙЯ" for r in results))

    def test_mixed_case_search_non_ascii(self):
        """Query 'тёмный' (lowercase) should find artist 'Тёмный ПринЦ' (mixed case)."""
        results = artists.get_artist_catalog(query="тёмный")
        self.assertTrue(any(r["name"] == "Тёмный ПринЦ" for r in results))


class AlbumCountConsistencyTest(unittest.TestCase):
    """H2: artist.album_count must match len(albums) in detail response."""

    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.track_ids = []
        cls.album_ids = []
        cls.artist_name = "H2 Test Artist"
        cls.artist_id = artists.artist_id_for_name(cls.artist_name)
        
        from repositories import albums as album_repo, tracks
        
        # Create album A with matching album_artist
        album_a_id = album_repo.add_or_get_album(
            title="Album A",
            album_artist=cls.artist_name,
            year="2024",
        )
        cls.album_ids.append(album_a_id)
        
        # Create album B with different album_artist
        album_b_id = album_repo.add_or_get_album(
            title="Album B",
            album_artist="Other Artist",
            year="2024",
        )
        cls.album_ids.append(album_b_id)
        
        # Add tracks: both albums have a track from cls.artist_name
        t1 = "h2-track-001"
        tracks.add_or_update_track(
            track_id=t1,
            file_path="/test/h2_1.mp3",
            title="Track 1",
            album_id=album_a_id,
            artist=cls.artist_name,
            duration=1.0,
            file_mtime_ns=1111111111,
        )
        cls.track_ids.append(t1)
        
        t2 = "h2-track-002"
        tracks.add_or_update_track(
            track_id=t2,
            file_path="/test/h2_2.mp3",
            title="Track 2",
            album_id=album_b_id,
            artist=cls.artist_name,
            duration=1.0,
            file_mtime_ns=1111111111,
        )
        cls.track_ids.append(t2)

    @classmethod
    def tearDownClass(cls):
        conn = db.get_connection()
        conn.execute(
            "DELETE FROM tracks WHERE id IN (%s)" % ",".join("?" * len(cls.track_ids)),
            cls.track_ids,
        )
        conn.execute(
            "DELETE FROM albums WHERE id IN (%s)" % ",".join("?" * len(cls.album_ids)),
            cls.album_ids,
        )
        conn.commit()
        conn.close()

    def test_album_count_matches_detail_albums_list(self):
        """Verify album_count in find_artist_by_id matches albums in detail."""
        summary = artists.find_artist_by_id(self.artist_id)
        self.assertIsNotNone(summary)
        
        detail = artists.get_artist_detail(self.artist_id, "http://test")
        self.assertIsNotNone(detail)
        
        # The album_count should equal the number of albums in the detail response
        self.assertEqual(
            summary["album_count"],
            len(detail["albums"]),
            f"album_count {summary['album_count']} != albums list {len(detail['albums'])}"
        )


class NullAlbumArtistTest(unittest.TestCase):
    """H3: Albums with NULL album_artist should be included in discography."""

    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.track_ids = []
        cls.album_ids = []
        cls.artist_name = "H3 Test Artist"
        cls.artist_id = artists.artist_id_for_name(cls.artist_name)
        
        from repositories import albums as album_repo, tracks
        
        # Create album with NULL album_artist (untagged album)
        album_id = album_repo.add_or_get_album(
            title="Album with NULL artist",
            album_artist=None,  # NULL
            year="2024",
        )
        cls.album_ids.append(album_id)
        
        # Add track with cls.artist_name
        track_id = "h3-track-001"
        tracks.add_or_update_track(
            track_id=track_id,
            file_path="/test/h3_1.mp3",
            title="Track 1",
            album_id=album_id,
            artist=cls.artist_name,
            duration=1.0,
            file_mtime_ns=1111111111,
        )
        cls.track_ids.append(track_id)

    @classmethod
    def tearDownClass(cls):
        conn = db.get_connection()
        conn.execute(
            "DELETE FROM tracks WHERE id IN (%s)" % ",".join("?" * len(cls.track_ids)),
            cls.track_ids,
        )
        conn.execute(
            "DELETE FROM albums WHERE id IN (%s)" % ",".join("?" * len(cls.album_ids)),
            cls.album_ids,
        )
        conn.commit()
        conn.close()

    def test_album_credit_controls_discography(self):
        detail = artists.get_artist_detail(self.artist_id, "http://test")
        self.assertIsNotNone(detail)
        self.assertEqual(detail["albums"], [])
        self.assertEqual(len(detail["popular_tracks"]), 1)
        self.assertEqual(artists.find_artist_by_id(self.artist_id)["album_count"], 0)

        from repositories.artist_credits import get_credit_states
        from services.artist_credit_service import set_album_artists
        album_id = self.album_ids[0]
        revision = get_credit_states('album', [album_id])[str(album_id)]['revision']
        set_album_artists(album_id, [{'id': self.artist_id}], revision, {'id': 1, 'role': 'admin'}, 'http://test')
        detail = artists.get_artist_detail(self.artist_id, "http://test")
        self.assertEqual([a["title"] for a in detail["albums"]], ["Album with NULL artist"])
        self.assertEqual(artists.find_artist_by_id(self.artist_id)["album_count"], 1)


class WhitespaceOnlyQueryTest(unittest.TestCase):
    """L3: Whitespace-only q parameter should not dump full catalog."""

    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.track_ids = []
        
        # Add a track so catalog is non-empty
        from repositories import albums as album_repo, tracks
        
        album_id = album_repo.add_or_get_album(
            title="L3 Album",
            year="2024",
        )
        
        track_id = "l3-test-001"
        tracks.add_or_update_track(
            track_id=track_id,
            file_path="/test/l3_1.mp3",
            title="Test Track",
            album_id=album_id,
            artist="L3 Test Artist",
            duration=1.0,
            file_mtime_ns=1111111111,
        )
        cls.track_ids.append(track_id)

    @classmethod
    def tearDownClass(cls):
        conn = db.get_connection()
        conn.execute(
            "DELETE FROM tracks WHERE id IN (%s)" % ",".join("?" * len(cls.track_ids)),
            cls.track_ids,
        )
        conn.commit()
        conn.close()

    def test_whitespace_only_query_returns_empty(self):
        """Whitespace-only query must equal get_artist_catalog(None) per contract 4.1."""
        self.assertEqual(
            artists.get_artist_catalog("   "),
            artists.get_artist_catalog(None),
        )


class RaceConditionHandlingTest(unittest.TestCase):
    """M1: Verify record_play_start returns None (404) for deleted tracks."""

    @classmethod
    def setUpClass(cls):
        db.init_db()

    def test_record_play_start_returns_none_for_missing_track(self):
        """record_play_start should return None for a non-existent track."""
        result = artists.record_play_start(user_id=1, track_id="nonexistent-track-12345")
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
