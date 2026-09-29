"""Schema bootstrap: tables, indexes, migrations, default admin seeding."""
import os
import secrets
import sys
import re

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
                        alter_match = re.match(r"^ALTER\s+TABLE\s+([^\s]+)\s+ADD(?:\s+COLUMN)?\s+([^\s(]+)", stmt, re.IGNORECASE)
                        if alter_match:
                            tbl, col = alter_match.group(1), alter_match.group(2)
                            cursor.execute(f"PRAGMA table_info({tbl});")
                            cols = {
                                row["name"].lower() if isinstance(row, dict) or hasattr(row, "keys") else row[1].lower()
                                for row in cursor.fetchall()
                            }
                            if col.lower() in cols:
                                continue
                        drop_match = re.match(r"^ALTER\s+TABLE\s+([^\s]+)\s+DROP(?:\s+COLUMN)?\s+([^\s(]+)", stmt, re.IGNORECASE)
                        if drop_match:
                            tbl, col = drop_match.group(1), drop_match.group(2)
                            cursor.execute(f"PRAGMA table_info({tbl});")
                            cols = {
                                row["name"].lower() if isinstance(row, dict) or hasattr(row, "keys") else row[1].lower()
                                for row in cursor.fetchall()
                            }
                            if col.lower() not in cols:
                                continue
                        try:
                            cursor.execute(stmt)
                        except Exception as oe:
                            msg = str(oe).lower()
                            if "duplicate column name" in msg or "already exists" in msg:
                                continue
                            raise
                    cursor.execute("INSERT INTO schema_migrations (version, filename) VALUES (?, ?)", (version, sql_file))
                    conn.commit()
                except Exception as e:
                    conn.rollback()
                    print(f"[DB Migration] Fatal error applying {sql_file}: {e}")
                    raise


def verify_and_repair_schema(cursor):
    """
    Гарантирует полноту схемы даже для нестандартных legacy-баз,
    где миграция могла быть частично применена или преждевременно
    отмечена в schema_migrations.
    """
    # 1. Поля loudness в tracks
    _ensure_columns(cursor, "tracks", {
        "loudness_lufs": "REAL",
        "true_peak_db": "REAL",
        "normalization_gain_db": "REAL",
        "loudness_status": "TEXT NOT NULL DEFAULT 'pending'",
        "loudness_analyzed_at": "TEXT",
        "loudness_analysis_version": "TEXT",
        "loudness_file_size": "INTEGER",
        "loudness_file_mtime_ns": "INTEGER",
        "loudness_error": "TEXT",
        "loudness_retry_count": "INTEGER DEFAULT 0"
    })

    # 2. Поля альбомов
    _ensure_columns(cursor, "albums", {
        "album_artist": "TEXT",
        "year": "TEXT",
        "title_normalized": "TEXT",
        "album_artist_normalized": "TEXT",
        "created_at": "TIMESTAMP",
        "updated_at": "TIMESTAMP"
    })

    # 3. Индексы
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_tracks_loudness_status ON tracks(loudness_status);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_albums_norm_title ON albums(title_normalized);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_albums_norm_artist ON albums(album_artist_normalized);")



def _ensure_playlist_track_positions(cursor):
    """
    Миграция 007: колонка position в playlist_tracks + backfill 0..N-1.

    Колонка добавляется только если её ещё нет; backfill (последовательные
    position 0..N-1 внутри каждого playlist по ORDER BY added_at ASC,
    tiebreak по track_id для детерминизма) выполняется только вместе с
    добавлением колонки. Повторный запуск — no-op: порядок не сбрасывается.
    """
    cursor.execute("PRAGMA table_info(playlist_tracks);")
    existing_cols = {row["name"].lower() for row in cursor.fetchall()}
    if "position" in existing_cols:
        return
    cursor.execute("ALTER TABLE playlist_tracks ADD COLUMN position INTEGER NOT NULL DEFAULT 0;")
    cursor.execute("""
        SELECT playlist_id, track_id FROM playlist_tracks
        ORDER BY playlist_id ASC, added_at ASC, track_id ASC
    """)
    counters = {}
    updates = []
    for row in cursor.fetchall():
        playlist_id = row["playlist_id"]
        next_pos = counters.get(playlist_id, 0)
        updates.append((next_pos, playlist_id, row["track_id"]))
        counters[playlist_id] = next_pos + 1
    cursor.executemany(
        "UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?",
        updates,
    )


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

    # 3. Таблица альбомов (identity = (title_normalized, album_artist_normalized) расширяется миграцией 008)
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
        "artist": "TEXT",
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
        "cover_version": "INTEGER DEFAULT 0",
        "auto_genres": "TEXT",
        "auto_genre_model": "TEXT",
        "auto_genre_updated_at": "TIMESTAMP",
        "auto_genre_status": "TEXT",
        "auto_genre_sync_pending": "INTEGER DEFAULT 0"
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
        position INTEGER NOT NULL DEFAULT 0,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (playlist_id, track_id),
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
        FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );
    """)

    # 6b. Миграция 007: position в playlist_tracks для старых баз.
    # ALTER ADD COLUMN не идемпотентен, поэтому колонка добавляется и
    # бэктфиллится здесь (стиль _ensure_columns), а не в SQL-файле:
    # если колонка уже есть, шаг пропускается и повторный запуск init_db
    # не сбрасывает сохранённый порядок треков.
    _ensure_playlist_track_positions(cursor)

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

    # Верификация полноты схемы (гарантия отсутствия частично примененных миграций)
    verify_and_repair_schema(cursor)

    # Миграция 008: нормализация идентичности альбомов + уникальный индекс.
    try:
        from repositories.albums import backfill_album_identities
        backfill_album_identities()
    except Exception as e:
        print(f"[DB Migration] Warning during album identity backfill: {e}")

    # 11. Миграция дефолтного администратора
    admin_username = os.getenv("PUUK_ADMIN_USERNAME", "admin")
    cursor.execute("SELECT id FROM users WHERE id = 1 OR username = ?", (admin_username,))
    admin_row = cursor.fetchone()
    if not admin_row:
        # Пароль администратора задается только через окружение; без него
        # генерируется случайный и выводится однократно. Никаких известных
        # дефолтных паролей в коде не осталось.
        admin_password = os.getenv("PUUK_ADMIN_PASSWORD")
        if not admin_password:
            admin_password = secrets.token_urlsafe(18)
            print(
                "[Security] PUUK_ADMIN_PASSWORD не задан — сгенерирован разовый пароль "
                f"для '{admin_username}': {admin_password}\n"
                "  Сохраните его и смените через: python manage_users.py set-password "
                "--username <имя> --password <новый>",
                file=sys.stderr,
            )
        default_pwd_hash = hash_password(admin_password)
        cursor.execute("""
            INSERT INTO users (id, username, password_hash, role)
            VALUES (1, ?, ?, 'admin')
        """, (admin_username, default_pwd_hash))
        admin_id = 1
    else:
        admin_id = admin_row["id"]

    # Привязка старых треков и плейлистов к admin (id=1)
    cursor.execute("UPDATE tracks SET added_by_user_id = ? WHERE added_by_user_id IS NULL", (admin_id,))
    cursor.execute("UPDATE playlists SET user_id = ? WHERE user_id IS NULL", (admin_id,))

    conn.commit()
    conn.close()
