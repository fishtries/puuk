"""SQLite connection management: pragmas, row factory, shared path."""
import os
import sqlite3
import time
from contextlib import contextmanager
from contextvars import ContextVar

_delivery_context = ContextVar("delivery_deadline", default=(None, None))


def check_deadline(deadline=None, cancel=None):
    inherited_deadline, inherited_cancel = _delivery_context.get()
    deadline = deadline if deadline is not None else inherited_deadline
    cancel = cancel if cancel is not None else inherited_cancel
    if (cancel is not None and cancel.is_set()) or (deadline is not None and time.monotonic() >= deadline):
        raise TimeoutError("delivery_busy")


@contextmanager
def deadline_context(deadline=None, cancel=None):
    token = _delivery_context.set((deadline, cancel))
    try:
        check_deadline(deadline, cancel)
        yield
    finally:
        _delivery_context.reset(token)


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
    t.normalization_gain_db, t.loudness_status, t.loudness_lufs, t.true_peak_db,
    t.album_track_position,
    (t.lyrics IS NOT NULL AND trim(t.lyrics) != '') AS has_lyrics
"""

# Ключ версии каталога в таблице catalog_meta. Живёт в base по той же причине,
# что и TRACK_SUMMARY_COLUMNS: треки, альбомы и взаимодействия используют
# bump/get без циклического импорта через друг друга.
CATALOG_VERSION_KEY = "track_catalog"

# Таблица-счётчик версии каталога (одна строка на ключ). Инкрементируется
# мутациями, меняющими каталог, вместо тяжёлого агрегирующего запроса
# (COUNT/MAX(file_mtime_ns)) на каждый HTTP-запрос.
CATALOG_META_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS catalog_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
"""


def get_connection(deadline=None, cancel=None) -> sqlite3.Connection:
    inherited_deadline, inherited_cancel = _delivery_context.get()
    deadline = deadline if deadline is not None else inherited_deadline
    cancel = cancel if cancel is not None else inherited_cancel
    check_deadline(deadline, cancel)
    path = os.getenv("PUUK_DB_PATH") or DB_PATH
    busy_ms = min(100, max(1, int((deadline-time.monotonic())*1000))) if deadline is not None else 5000
    conn = sqlite3.connect(path, timeout=busy_ms/1000 if deadline is not None else 10.0)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute(f"PRAGMA busy_timeout = {busy_ms}")
        if deadline is not None or cancel is not None:
            conn.set_progress_handler(lambda: int((cancel is not None and cancel.is_set()) or
                (deadline is not None and time.monotonic() >= deadline)), 1000)
        check_deadline(deadline, cancel)
        return conn
    except BaseException:
        conn.close()
        raise


def bump_catalog_version(conn: sqlite3.Connection) -> None:
    """
    Инкрементирует версию каталога внутри транзакции вызывающей мутации
    (до conn.commit()): версия и данные фиксируются одной транзакцией.
    Отсутствующая строка создаётся со значением 1.
    """
    conn.cursor().execute(
        f"""
        INSERT INTO catalog_meta (key, value) VALUES (?, '1')
        ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
        """,
        (CATALOG_VERSION_KEY,),
    )


def get_catalog_version() -> int:
    """
    Текущая версия каталога (0, если мутаций ещё не было).
    Дешёвое чтение одной строки: выполняется на каждый HTTP-запрос /api/tracks.
    """
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM catalog_meta WHERE key = ?", (CATALOG_VERSION_KEY,))
        row = cursor.fetchone()
        return int(row["value"]) if row else 0
    finally:
        conn.close()
