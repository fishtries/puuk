"""SQLite connection management: pragmas, row factory, shared path."""
import os
import sqlite3

from config import DB_PATH


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
