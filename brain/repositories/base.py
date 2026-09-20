"""SQLite connection management: pragmas, row factory, shared path."""
import sqlite3

from config import DB_PATH


def get_connection() -> sqlite3.Connection:
    """Открывает соединение с включенными foreign keys, busy_timeout и row_factory."""
    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    return conn
