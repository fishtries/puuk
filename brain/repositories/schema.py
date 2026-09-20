"""Schema bootstrap: tables, indexes, migrations, default admin seeding."""
import os

try:
    from security import hash_password
except ImportError:
    from .security import hash_password

from repositories.base import get_connection


def _ensure_columns(cursor, table_name: str, expected_columns: dict):
    """
    Проверяет наличие колонок в таблице и добавляет отсутствующие.
    expected_columns: dict { "col_name": "SQL_TYPE_AND_CONSTRAINTS" }
    """
    cursor.execute(f"PRAGMA table_info({table_name});")
    existing_cols = {row["name"].lower() for row in cursor.fetchall()}
    for col_name, col_def in expected_columns.items():
        if col_name.lower() not in existing_cols:
            cursor.execute(f"ALTER TABLE {table_name} ADD COLUMN {col_name} {col_def};")


def apply_migrations(conn):
    """Применяет миграции схемы БД из папки migrations/."""
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            filename TEXT NOT NULL,
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    """)
    cursor.execute("SELECT version FROM schema_migrations")
    applied_versions = {row[0] for row in cursor.fetchall()}

    migrations_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "migrations")
    if os.path.exists(migrations_dir):
        sql_files = sorted([f for f in os.listdir(migrations_dir) if f.endswith(".sql")])
        for sql_file in sql_files:
            try:
                version = int(sql_file.split("_")[0])
            except ValueError:
                continue
            if version not in applied_versions:
                filepath = os.path.join(migrations_dir, sql_file)
                try:
                    with open(filepath, "r", encoding="utf-8") as f:
                        script = f.read()
                    statements = [s.strip() for s in script.split(";") if s.strip()]
                    for stmt in statements:
                        try:
                            cursor.execute(stmt)
                        except Exception as oe:
                            msg = str(oe).lower()
                            if "duplicate column name" in msg or "no such column" in msg:
                                continue
                            raise
                    cursor.execute("INSERT INTO schema_migrations (version, filename) VALUES (?, ?)", (version, sql_file))
                    conn.commit()
                except Exception as e:
                    print(f"[DB Migration] Warning applying {sql_file}: {e}")


def init_db():
    """Создает схему БД, применяет миграции, сеет дефолтного админа."""
    conn = get_connection()
    cursor = conn.cursor()

    # 1. Режим WAL для высокой производительности и параллельного чтения
    cursor.execute("PRAGMA journal_mode = WAL;")

    # 2. Таблица пользователей
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        telegram_id INTEGER UNIQUE,
        role TEXT DEFAULT 'user' NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 3. Таблица альбомов
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS albums (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        cover_path TEXT
    );
    """)

    # 4. Таблица треков
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS tracks (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        title TEXT NOT NULL,
        album_id INTEGER,
        artist TEXT,
        lyrics TEXT,
        cover_color TEXT,
        added_by_user_id INTEGER,
        FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE SET NULL,
        FOREIGN KEY (added_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    """)

    # Проверяем колонки в tracks на случай обновления старой схемы
    _ensure_columns(cursor, "tracks", {
        "lyrics": "TEXT",
        "cover_color": "TEXT",
        "added_by_user_id": "INTEGER REFERENCES users(id) ON DELETE SET NULL",
        "duration": "REAL",
        "lyrics_source": "TEXT",
        "lyrics_status": "TEXT",
        "lyrics_language": "TEXT",
        "reference_search_status": "TEXT",
        "album_artist": "TEXT",
        "year": "TEXT",
        "genre": "TEXT",
        "track_number": "TEXT",
        "disc_number": "TEXT",
        "comment": "TEXT",
        "bitrate": "INTEGER",
        "sample_rate": "INTEGER",
        "channels": "INTEGER",
        "format": "TEXT",
        "file_size": "INTEGER",
        "file_mtime_ns": "INTEGER",
        "cover_version": "INTEGER DEFAULT 0"
    })

    # Таблица журнала мутаций для надежного восстановления при сбоях (Recovery)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS track_mutation_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id TEXT NOT NULL,
        status TEXT NOT NULL,
        old_size INTEGER,
        old_mtime_ns INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_mutation_journal_track ON track_mutation_journal(track_id, created_at DESC);")

    # 5. Таблица плейлистов
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        user_id INTEGER,
        is_public BOOLEAN DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    """)

    # Проверяем колонки в playlists на случай обновления старой схемы
    _ensure_columns(cursor, "playlists", {
        "user_id": "INTEGER REFERENCES users(id) ON DELETE CASCADE",
        "is_public": "BOOLEAN DEFAULT 0"
    })

    # 6. Таблица связи плейлистов и треков
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlist_id INTEGER,
        track_id TEXT,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (playlist_id, track_id),
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
        FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );
    """)

    # 7. Таблица избранного (лайки пользователей)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS user_favorites (
        user_id INTEGER NOT NULL,
        track_id TEXT NOT NULL,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, track_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );
    """)

    # 8. Таблица истории прослушиваний
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS user_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        track_id TEXT NOT NULL,
        played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );
    """)

    # 9. Таблица дизлайков (исключение из волны рекомендаций)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS user_dislikes (
        user_id INTEGER NOT NULL,
        track_id TEXT NOT NULL,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, track_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );
    """)

    # 10. Таблица одноразовых кодов авторизации (Telegram OTP)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS auth_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        code TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    """)

    # 11. Персонализация Волны: Кэш пользовательских эмбеддингов
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS user_embeddings (
        user_id INTEGER PRIMARY KEY,
        embedding_vector BLOB NOT NULL,
        track_count INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    """)

    # 12. Детализированный фидбек для «Моей Волны»
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS user_wave_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        track_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        listen_duration_ms INTEGER DEFAULT 0,
        track_duration_ms INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );
    """)

    # 13. Глобальная статистика треков (diversity & popularity analytics)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS track_stats (
        track_id TEXT PRIMARY KEY,
        play_count INTEGER DEFAULT 0,
        skip_count INTEGER DEFAULT 0,
        like_count INTEGER DEFAULT 0,
        avg_listen_pct REAL DEFAULT 0.0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );
    """)

    # Индексы для быстрой фильтрации и поиска
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_favorites_user ON user_favorites(user_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_history_user ON user_history(user_id, played_at);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_dislikes_user ON user_dislikes(user_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_auth_codes_code ON auth_codes(code);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_wave_feedback_user ON user_wave_feedback(user_id, created_at DESC);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_wave_feedback_track ON user_wave_feedback(track_id);")

    # Применение SQL-миграций
    apply_migrations(conn)

    # 11. Миграция дефолтного администратора
    cursor.execute("SELECT id FROM users WHERE id = 1 OR username = 'admin'")
    admin_row = cursor.fetchone()
    if not admin_row:
        # Создаем системного админа по умолчанию
        default_pwd_hash = hash_password("admin")
        cursor.execute("""
            INSERT INTO users (id, username, password_hash, role)
            VALUES (1, 'admin', ?, 'admin')
        """, (default_pwd_hash,))
        admin_id = 1
    else:
        admin_id = admin_row["id"]

    # Привязка старых треков и плейлистов к admin (id=1)
    cursor.execute("UPDATE tracks SET added_by_user_id = ? WHERE added_by_user_id IS NULL", (admin_id,))
    cursor.execute("UPDATE playlists SET user_id = ? WHERE user_id IS NULL", (admin_id,))

    conn.commit()
    conn.close()
