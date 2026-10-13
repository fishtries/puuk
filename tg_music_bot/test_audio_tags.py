"""Тесты слоя метаданных бота: чтение/запись/проверка тегов и хелперы загрузчика.

Файлы — минимальные валидные MP3 (MPEG-1 Layer III фреймы), теги собираются
mutagen во временной папке. Сетевые источники обложек мокаются.
"""
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

from mutagen.id3 import ID3, TIT2, TPE1

import audio_tags
import downloader


def _make_mp3(path: str, title: str = "", artist: str = "") -> str:
    frame = bytes([0xFF, 0xFB, 0x90, 0x44]) + b"\x00" * 413
    with open(path, "wb") as f:
        f.write(frame * 10)
    if title or artist:
        tags = ID3()
        if title:
            tags.add(TIT2(encoding=3, text=title))
        if artist:
            tags.add(TPE1(encoding=3, text=artist))
        tags.save(path)
    return path


class TestAudioTags(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="puuk_tags_")

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _path(self, name="track.mp3"):
        return os.path.join(self.temp_dir, name)

    def test_01_write_and_read_roundtrip(self):
        path = _make_mp3(self._path())
        tags = audio_tags.write_audio_metadata(
            path,
            title="Never Gonna Give You Up",
            artist="Rick Astley",
            album="Whenever You Need Somebody",
            album_artist="Rick Astley",
            date="1987-11-12",
            genre="Pop",
            track_number="1/10",
            disc_number="1/1",
            lyrics="We're no strangers to love",
        )
        self.assertEqual(tags.title, "Never Gonna Give You Up")
        self.assertEqual(tags.artist, "Rick Astley")
        self.assertEqual(tags.album, "Whenever You Need Somebody")
        self.assertEqual(tags.album_artist, "Rick Astley")
        self.assertEqual(tags.date, "1987-11-12")
        self.assertEqual(tags.genre, "Pop")
        self.assertEqual(tags.track_number, "1/10")
        self.assertEqual(tags.disc_number, "1/1")
        self.assertEqual(tags.lyrics, "We're no strangers to love")
        self.assertEqual(audio_tags.extract_year(tags.date), "1987")

        reread = audio_tags.read_audio_tags(path)
        self.assertEqual(reread.title, "Never Gonna Give You Up")
        self.assertEqual(reread.artist, "Rick Astley")

    def test_02_merge_does_not_overwrite_existing(self):
        path = _make_mp3(self._path(), title="Existing Title", artist="Existing Artist")
        tags = audio_tags.write_audio_metadata(path, title="New Title", artist="New Artist", album="Album")
        self.assertEqual(tags.title, "Existing Title")
        self.assertEqual(tags.artist, "Existing Artist")
        self.assertEqual(tags.album, "Album")

    def test_03_overwrite_replaces_existing(self):
        path = _make_mp3(self._path(), title="Existing Title", artist="Existing Artist")
        tags = audio_tags.write_audio_metadata(
            path, title="New Title", artist="New Artist", overwrite=True
        )
        self.assertEqual(tags.title, "New Title")
        self.assertEqual(tags.artist, "New Artist")

    def test_04_cover_embedding(self):
        path = _make_mp3(self._path())
        cover = b"\xff\xd8\xff\xe0fake-jpeg-bytes"
        tags = audio_tags.write_audio_metadata(path, title="T", artist="A", cover_bytes=cover)
        self.assertTrue(tags.has_cover)
        id3 = ID3(path)
        self.assertEqual(len(id3.getall("APIC")), 1)
        self.assertEqual(id3.getall("APIC")[0].data, cover)

    def test_05_verify_detects_missing_required_fields(self):
        path = _make_mp3(self._path())
        ok, missing = audio_tags.verify_audio_tags(path)
        self.assertFalse(ok)
        self.assertIn("title", missing)
        self.assertIn("artist", missing)

        audio_tags.write_audio_metadata(path, title="T", artist="A")
        ok, missing = audio_tags.verify_audio_tags(path)
        self.assertTrue(ok)
        self.assertEqual(missing, [])

    def test_06_parse_filename_metadata(self):
        self.assertEqual(
            audio_tags.parse_filename_metadata("/tmp/Rick Astley - Never Gonna Give You Up.mp3"),
            ("Rick Astley", "Never Gonna Give You Up"),
        )
        self.assertEqual(
            audio_tags.parse_filename_metadata("/tmp/untitled.mp3"),
            ("", "untitled"),
        )

    def test_07_extract_year(self):
        self.assertEqual(audio_tags.extract_year("1987-11-12"), "1987")
        self.assertEqual(audio_tags.extract_year("2024"), "2024")
        self.assertEqual(audio_tags.extract_year(""), "")
        self.assertEqual(audio_tags.extract_year(None), "")


class TestDownloaderHelpers(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="puuk_dl_")

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_01_snapshot_and_changed_detection(self):
        existing = _make_mp3(os.path.join(self.temp_dir, "existing.mp3"))
        before = downloader._snapshot_dir(self.temp_dir)
        self.assertIn("existing.mp3", before)
        self.assertEqual(downloader._changed_audio_files(self.temp_dir, before), [])

        new_file = _make_mp3(os.path.join(self.temp_dir, "new.mp3"))
        changed = downloader._changed_audio_files(self.temp_dir, before)
        self.assertIn(new_file, changed)
        self.assertNotIn(existing, changed)

        os.utime(existing, (0, 0))
        changed = downloader._changed_audio_files(self.temp_dir, before)
        self.assertIn(existing, changed)

    def test_02_non_audio_files_ignored(self):
        with open(os.path.join(self.temp_dir, "cover.jpg"), "wb") as f:
            f.write(b"jpg")
        with open(os.path.join(self.temp_dir, "notes.txt"), "w") as f:
            f.write("x")
        self.assertEqual(downloader._snapshot_dir(self.temp_dir), {})

    def test_03_match_song_by_title(self):
        songs = [{"name": "Never Gonna Give You Up", "artists": ["Rick Astley"]}]
        matched = downloader._match_song(songs, "Never Gonna Give You Up", "Rick Astley", "/tmp/x.mp3")
        self.assertIs(matched, songs[0])

    def test_04_match_song_by_filename(self):
        songs = [{"name": "Some Song", "artists": ["Some Artist"]}]
        matched = downloader._match_song(
            songs, "", "", "/tmp/Some Artist - Some Song.mp3"
        )
        self.assertIs(matched, songs[0])

    def test_04b_match_prefers_title_and_artist_over_title_only(self):
        songs = [
            {"name": "Same Title", "artists": ["Wrong Artist"]},
            {"name": "Same Title", "artists": ["Right Artist"]},
        ]
        matched = downloader._match_song(songs, "Same Title", "Right Artist", "/tmp/x.mp3")
        self.assertEqual(matched["artists"], ["Right Artist"])

    def test_05_finalize_fills_from_song_and_writes_tags(self):
        path = _make_mp3(os.path.join(self.temp_dir, "Artist - Title.mp3"))
        song = {
            "name": "Title",
            "artists": ["Artist"],
            "album_name": "Album",
            "album_artist": "Artist",
            "date": "2020-05-01",
            "year": 2020,
            "genres": ["Rock"],
            "track_number": 3,
            "tracks_count": 12,
            "disc_number": 1,
            "disc_count": 2,
            "lyrics": "la la",
            "cover_url": None,
        }
        with mock.patch.object(downloader, "cover_from_itunes", return_value=None):
            meta = downloader._finalize_track(path, song=song)

        self.assertEqual(meta["title"], "Title")
        self.assertEqual(meta["artist"], "Artist")
        self.assertEqual(meta["album"], "Album")
        self.assertEqual(meta["track_number"], "3/12")
        self.assertEqual(meta["disc_number"], "1/2")
        self.assertEqual(meta["lyrics"], "la la")
        self.assertTrue(meta["verification"])
        self.assertTrue(meta["has_lyrics"])

        on_disk = audio_tags.read_audio_tags(path)
        self.assertEqual(on_disk.title, "Title")
        self.assertEqual(on_disk.album, "Album")

    def test_06_finalize_falls_back_to_filename(self):
        path = _make_mp3(os.path.join(self.temp_dir, "Fallback Artist - Fallback Title.mp3"))
        with mock.patch.object(downloader, "cover_from_itunes", return_value=None):
            meta = downloader._finalize_track(path)
        self.assertEqual(meta["title"], "Fallback Title")
        self.assertEqual(meta["artist"], "Fallback Artist")
        self.assertTrue(meta["verification"])

    def test_07_finalize_embeds_cover_from_itunes(self):
        path = _make_mp3(os.path.join(self.temp_dir, "A - T.mp3"))
        with mock.patch.object(
            downloader, "cover_from_itunes", return_value=(b"\xff\xd8cover", "image/jpeg")
        ):
            meta = downloader._finalize_track(path, fallback_title="T", fallback_artist="A")
        self.assertTrue(meta["has_cover"])
        self.assertTrue(audio_tags.read_audio_tags(path).has_cover)

    def test_08_finalize_uses_fallback_date(self):
        path = _make_mp3(os.path.join(self.temp_dir, "A - T.mp3"))
        with mock.patch.object(downloader, "cover_from_itunes", return_value=None):
            meta = downloader._finalize_track(
                path, fallback_title="T", fallback_artist="A", fallback_date="2021-03-04"
            )
        self.assertEqual(meta["date"], "2021-03-04")
        self.assertEqual(audio_tags.read_audio_tags(path).date, "2021-03-04")


class TestItunesCoverMatch(unittest.TestCase):
    def test_01_title_and_artist_matching(self):
        self.assertTrue(audio_tags._title_matches("Never Gonna Give You Up", "Never Gonna Give You Up"))
        self.assertTrue(audio_tags._title_matches("Song", "Song (Remastered)"))
        self.assertFalse(audio_tags._title_matches("Song A", "Song B"))
        self.assertTrue(audio_tags._artist_matches("Rick Astley", "Rick Astley"))
        self.assertFalse(audio_tags._artist_matches("Rick Astley", "Someone Else"))

    def test_01b_artist_stopword_only_overlap_is_not_a_match(self):
        self.assertFalse(audio_tags._artist_matches("The xx", "The Weeknd"))
        self.assertFalse(audio_tags._artist_matches("The Band", "The"))
        self.assertTrue(audio_tags._artist_matches("Rick Astley", "Rick Astley feat. Someone"))

    def _fake_response(self, results):
        response = mock.Mock()
        response.status_code = 200
        response.json.return_value = {"results": results}
        return response

    def test_02_skips_wrong_artist(self):
        results = [
            {"trackName": "Same Title", "artistName": "Wrong Artist", "artworkUrl100": "http://x/100x100bb.jpg"},
            {"trackName": "Same Title", "artistName": "Right Artist", "artworkUrl100": "http://x/100x100bb.jpg"},
        ]
        with mock.patch("requests.get") as get, mock.patch.object(
            audio_tags, "fetch_cover", return_value=(b"img", "image/jpeg")
        ) as fetch:
            get.side_effect = [self._fake_response(results)]
            result = audio_tags.cover_from_itunes("Same Title", "Right Artist")
        self.assertIsNotNone(result)
        fetch.assert_called_once_with("http://x/600x600bb.jpg", timeout=12)

    def test_03_returns_none_when_no_confident_match(self):
        results = [
            {"trackName": "Different Song", "artistName": "Wrong Artist", "artworkUrl100": "http://x/100x100bb.jpg"},
        ]
        with mock.patch("requests.get", return_value=self._fake_response(results)):
            self.assertIsNone(audio_tags.cover_from_itunes("My Song", "My Artist"))

    def test_04_returns_none_without_query(self):
        self.assertIsNone(audio_tags.cover_from_itunes("", ""))

    def test_05_continues_when_cover_fetch_fails(self):
        results = [
            {"trackName": "Same Title", "artistName": "Right Artist", "artworkUrl100": "http://x/100x100bb.jpg"},
            {"trackName": "Same Title", "artistName": "Right Artist", "artworkUrl100": "http://y/100x100bb.jpg"},
        ]
        with mock.patch("requests.get", return_value=self._fake_response(results)), mock.patch.object(
            audio_tags, "fetch_cover", side_effect=[None, (b"img", "image/jpeg")]
        ) as fetch:
            result = audio_tags.cover_from_itunes("Same Title", "Right Artist")
        self.assertEqual(result, (b"img", "image/jpeg"))
        self.assertEqual(fetch.call_count, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
