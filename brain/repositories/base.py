"""SQLite connection management: pragmas, row factory, shared path."""
import os
import sqlite3

from config import DB_PATH


# Каталожные колонки треков без тяжёлых текстов (lyrics_*): списки, поиск и
# пачки Волны не должны тянуть и передавать килобайты LRC на каждый трек.
# Живёт в base, чтобы albums/playlists/interactions использовали её без
# циклического импорта через tracks.
TRACK_SUMMARY_COLUMNS = """
    t.id, t.file_path, t.title, t.album_id, t.artist, t.cover_color,
    t.album_artist, t.year, t.genre, t.track_number, t.disc_number, t.comment,
    t.duration, t.bitrate, t.sample_rate, t.channels, t.format,
    t.file_size, t.file_mtime_ns, t.cover_version,
    t.auto_genres, t.auto_genre_model, t.auto_genre_updated_at,
    t.normalization_gain_db, t.loudness_status, t.loudness_lufs, t.true_peak_db
"""


def get_connection() -> sqlite3.Connection:
    """
    Открывает соединение с включенными foreign_keys, busy_timeout и row_factory.
    Путь резолвится на каждый вызов: тесты изолируют БД через PUUK_DB_PATH
    (см. test_db_path.py), и переменная окружения действует независимо от
    порядка импорта config.
    """
    path = os.getenv("PUUK_DB_PATH") or DB_PATH
    conn = sqlite3.connect(path, timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    return conn
