"""Genre-пайплайн сканера: извлечение TCON из файла, запись в tracks.genre,
защита существующего непустого жанра от затирания пустым при повторном скане.

Тестовая БД изолирована через PUUK_DB_PATH (test_db_path.py), аудиофайлы —
фейковые MP3 (минимальные валидные MPEG-фреймы), собираются mutagen во
временной папке.
"""
import os
import shutil
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД, должен идти до db/config

from mutagen.id3 import ID3, TIT2, TPE1, TCON

import db
from metadata import AudioMetadata, read_audio_metadata


def _make_mp3(path: str, genre_values=None) -> str:
    """Минимальный валидный MP3: 10 MPEG-1 Layer III фреймов + ID3-теги через mutagen."""
    frame = bytes([0xFF, 0xFB, 0x90, 0x44]) + b"\x00" * 413  # 417 байт: 128 kbps, 44100 Hz
    with open(path, "wb") as f:
        f.write(frame * 10)
    tags = ID3()
    tags.add(TIT2(encoding=3, text="Genre Test Title"))
    tags.add(TPE1(encoding=3, text="Genre Test Artist"))
    if genre_values is not None:
        tags.add(TCON(encoding=3, text=list(genre_values)))
    tags.save(path)
    return path


def _strip_tcon(path: str) -> None:
    tags = ID3(path)
    tags.delall("TCON")
    tags.save()


class TestGenreExtraction(unittest.TestCase):
    """Чтение жанра из файла: TCON как есть, включая мультижанровые значения."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="puuk_genre_read_")

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_tcon_single_genre(self):
        path = _make_mp3(os.path.join(self.temp_dir, "g_single.mp3"), ["Deep House"])
        self.assertEqual(read_audio_metadata(path).genre, "Deep House")

    def test_tcon_semicolon_string_kept_as_is(self):
        path = _make_mp3(os.path.join(self.temp_dir, "g_semicolon.mp3"), ["Electronic; House"])
        self.assertEqual(read_audio_metadata(path).genre, "Electronic; House")

    def test_tcon_multiple_values_joined(self):
        path = _make_mp3(os.path.join(self.temp_dir, "g_multi.mp3"), ["Rock", "Pop"])
        self.assertEqual(read_audio_metadata(path).genre, "Rock; Pop")

    def test_no_tcon_means_no_genre(self):
        path = _make_mp3(os.path.join(self.temp_dir, "g_none.mp3"))
        self.assertIsNone(read_audio_metadata(path).genre)


class TestGenrePersistence(unittest.TestCase):
    """Запись жанра в tracks: INSERT/UPDATE через add_or_update_track."""

    def test_insert_writes_genre(self):
        db.add_or_update_track("g_ins", "g_ins.mp3", "T", None, "A", genre="Jazz")
        self.assertEqual(db.get_track("g_ins")["genre"], "Jazz")

    def test_multi_genre_string_stored_as_is(self):
        db.add_or_update_track("g_multi_db", "g_multi_db.mp3", "T", None, "A", genre="Electronic; House")
        self.assertEqual(db.get_track("g_multi_db")["genre"], "Electronic; House")

    def test_rescan_empty_genre_does_not_clobber(self):
        db.add_or_update_track("g_keep", "g_keep.mp3", "T", None, "A", genre="Jazz")
        db.add_or_update_track("g_keep", "g_keep.mp3", "T2", None, "A")
        self.assertEqual(db.get_track("g_keep")["genre"], "Jazz")

    def test_rescan_unknown_genre_does_not_clobber(self):
        db.add_or_update_track("g_unk", "g_unk.mp3", "T", None, "A", genre="Jazz")
        db.add_or_update_track("g_unk", "g_unk.mp3", "T2", None, "A", genre="Unknown")
        self.assertEqual(db.get_track("g_unk")["genre"], "Jazz")

    def test_rescan_new_genre_overwrites(self):
        db.add_or_update_track("g_new", "g_new.mp3", "T", None, "A", genre="Jazz")
        db.add_or_update_track("g_new", "g_new.mp3", "T2", None, "A", genre="Techno")
        self.assertEqual(db.get_track("g_new")["genre"], "Techno")


class TestUpdateMetadataFromAudioGenre(unittest.TestCase):
    """preserve_empty_genre: сканер сохраняет жанр, PATCH/resync-семантика не меняется."""

    def setUp(self):
        self.track_id = "g_meta_flag"
        db.add_or_update_track(self.track_id, "g_meta_flag.mp3", "T", None, "A", genre="Jazz")

    def test_preserve_flag_keeps_genre_when_file_empty(self):
        meta = AudioMetadata(title="T2", artist="A", genre=None)
        db.update_track_metadata_from_audio(self.track_id, meta, preserve_empty_genre=True)
        self.assertEqual(db.get_track(self.track_id)["genre"], "Jazz")

    def test_preserve_flag_keeps_genre_when_file_unknown(self):
        meta = AudioMetadata(title="T2", artist="A", genre="Unknown")
        db.update_track_metadata_from_audio(self.track_id, meta, preserve_empty_genre=True)
        self.assertEqual(db.get_track(self.track_id)["genre"], "Jazz")

    def test_preserve_flag_overwrites_with_new_genre(self):
        meta = AudioMetadata(title="T2", artist="A", genre="House")
        db.update_track_metadata_from_audio(self.track_id, meta, preserve_empty_genre=True)
        self.assertEqual(db.get_track(self.track_id)["genre"], "House")

    def test_default_clears_genre(self):
        meta = AudioMetadata(title="T2", artist="A", genre=None)
        db.update_track_metadata_from_audio(self.track_id, meta)
        self.assertIsNone(db.get_track(self.track_id)["genre"])


class TestExtractFullMetadataWithGenre(unittest.TestCase):
    """Сканерный кортеж (title, artist, album, genre, lyrics, duration) и compat 5-кортеж."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="puuk_genre_scan_")
        self._old_music_dir = os.environ.get("MUSIC_DIR")
        os.environ["MUSIC_DIR"] = self.temp_dir
        _make_mp3(os.path.join(self.temp_dir, "g_rel.mp3"), ["Deep House"])

    def tearDown(self):
        if self._old_music_dir is None:
            os.environ.pop("MUSIC_DIR", None)
        else:
            os.environ["MUSIC_DIR"] = self._old_music_dir
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_with_genre_returns_six_tuple(self):
        from services.media_locations import extract_full_metadata_with_genre
        result = extract_full_metadata_with_genre("g_rel.mp3")
        self.assertEqual(len(result), 6)
        title, artist, album, genre, lyrics, duration = result
        self.assertEqual(title, "Genre Test Title")
        self.assertEqual(artist, "Genre Test Artist")
        self.assertEqual(genre, "Deep House")

    def test_extract_full_metadata_stays_five_tuple(self):
        from services.media_locations import extract_full_metadata
        result = extract_full_metadata("g_rel.mp3")
        self.assertEqual(len(result), 5)
        title, artist, album, lyrics, duration = result
        self.assertEqual(title, "Genre Test Title")


class TestScanLibraryGenre(unittest.TestCase):
    """E2E: scan_library заполняет genre и не затирает его при повторном скане."""

    def setUp(self):
        self.music_dir = tempfile.mkdtemp(prefix="puuk_genre_music_")
        self._old_music_dir = os.environ.get("MUSIC_DIR")
        os.environ["MUSIC_DIR"] = self.music_dir
        self.rel_path = "g_scan_song.mp3"
        self.track_id = str(uuid.uuid5(uuid.NAMESPACE_URL, self.rel_path))

    def tearDown(self):
        if self._old_music_dir is None:
            os.environ.pop("MUSIC_DIR", None)
        else:
            os.environ["MUSIC_DIR"] = self._old_music_dir
        shutil.rmtree(self.music_dir, ignore_errors=True)

    def test_scan_fills_genre_from_tcon(self):
        from services.library_service import scan_library
        _make_mp3(os.path.join(self.music_dir, self.rel_path), ["Deep House"])

        result = scan_library()
        self.assertEqual(result["tracks_scanned"], 1)
        self.assertEqual(db.get_track(self.track_id)["genre"], "Deep House")

    def test_rescan_without_tcon_keeps_existing_genre(self):
        from services.library_service import scan_library
        file_path = _make_mp3(os.path.join(self.music_dir, self.rel_path), ["Deep House"])

        scan_library()
        self.assertEqual(db.get_track(self.track_id)["genre"], "Deep House")

        # Файл перезаписан без жанра (но с новыми тегами title/artist)
        tags = ID3(file_path)
        tags.add(TIT2(encoding=3, text="Renamed Title"))
        tags.save()

        scan_library()
        track = db.get_track(self.track_id)
        self.assertEqual(track["genre"], "Deep House")
        self.assertEqual(track["title"], "Renamed Title")


if __name__ == "__main__":
    unittest.main()
