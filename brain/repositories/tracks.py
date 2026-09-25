"""Track records: CRUD, search, lyrics columns, audio-derived metadata, mutation journal."""
import json
from typing import Optional, List, Dict, Any

from repositories.base import get_connection


def get_all_tracks():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT t.*, a.title AS album
        FROM tracks t
        LEFT JOIN albums a ON a.id = t.album_id
        ORDER BY t.title
    """)
    tracks = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return tracks

def get_track(track_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM tracks WHERE id = ?", (track_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def search_tracks(query, limit=30):
    conn = get_connection()
    cursor = conn.cursor()
    search_term = f"%{query}%"
    cursor.execute("""
        SELECT t.*, a.title as album_title
        FROM tracks t
        LEFT JOIN albums a ON t.album_id = a.id
        WHERE t.title LIKE ? OR t.artist LIKE ? OR a.title LIKE ?
        LIMIT ?
    """, (search_term, search_term, search_term, limit))
    tracks = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return tracks

def search_all(query, limit=30):
    conn = get_connection()
    cursor = conn.cursor()
    search_term = f"%{query}%"

    # 1. Tracks (matching title, artist or album)
    cursor.execute("""
        SELECT t.*, a.title as album_title
        FROM tracks t
        LEFT JOIN albums a ON t.album_id = a.id
        WHERE t.title LIKE ? OR t.artist LIKE ? OR a.title LIKE ?
        LIMIT ?
    """, (search_term, search_term, search_term, limit))
    tracks = [dict(row) for row in cursor.fetchall()]

    # 2. Albums (matching title or artist)
    cursor.execute("""
        SELECT a.id, a.title,
               (SELECT t.artist FROM tracks t WHERE t.album_id = a.id LIMIT 1) as artist,
               (SELECT COUNT(*) FROM tracks t WHERE t.album_id = a.id) as track_count,
               (SELECT t.id FROM tracks t WHERE t.album_id = a.id LIMIT 1) as cover_track_id
        FROM albums a
        WHERE a.title LIKE ? OR (SELECT t.artist FROM tracks t WHERE t.album_id = a.id LIMIT 1) LIKE ?
        LIMIT ?
    """, (search_term, search_term, limit))
    albums = [dict(row) for row in cursor.fetchall()]

    # 3. Artists (grouped by artist name)
    cursor.execute("""
        SELECT t.artist as name,
               COUNT(DISTINCT t.id) as track_count,
               COUNT(DISTINCT t.album_id) as album_count,
               (SELECT t2.id FROM tracks t2 WHERE t2.artist = t.artist AND t2.id IS NOT NULL LIMIT 1) as cover_track_id
        FROM tracks t
        WHERE t.artist LIKE ? AND t.artist IS NOT NULL AND t.artist != ''
        GROUP BY t.artist
        LIMIT ?
    """, (search_term, limit))
    artists = [dict(row) for row in cursor.fetchall()]

    conn.close()
    return {"tracks": tracks, "albums": albums, "artists": artists}

def _clean_genre(genre: Optional[str]) -> Optional[str]:
    """Жанр из файла для сканера: пустые и заглушки ('Unknown') считаются отсутствием жанра."""
    if genre is None:
        return None
    cleaned = str(genre).strip()
    if not cleaned or cleaned.lower() == "unknown":
        return None
    return cleaned

def add_or_update_track(track_id, file_path, title, album_id, artist, lyrics=None, added_by_user_id=1, cover_color=None, duration=None, genre=None):
    genre_value = _clean_genre(genre)
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM tracks WHERE id = ?", (track_id,))
    if cursor.fetchone():
        # Пустой/Unknown жанр из файла не затирает существующее непустое значение.
        cursor.execute("""
            UPDATE tracks
            SET file_path = ?, title = ?, album_id = ?, artist = ?, lyrics = ?,
                genre = COALESCE(?, genre),
                cover_color = COALESCE(?, cover_color), duration = COALESCE(?, duration)
            WHERE id = ?
        """, (file_path, title, album_id, artist, lyrics, genre_value, cover_color, duration, track_id))
    else:
        cursor.execute("""
            INSERT INTO tracks (id, file_path, title, album_id, artist, lyrics, added_by_user_id, cover_color, duration, genre)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (track_id, file_path, title, album_id, artist, lyrics, added_by_user_id, cover_color, duration, genre_value))
    conn.commit()
    conn.close()

def update_track_cover_color(track_id, cover_color):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE tracks SET cover_color = ? WHERE id = ?", (cover_color, track_id))
    conn.commit()
    conn.close()

def update_track_lyrics(track_id, lyrics, lyrics_source=None, lyrics_status=None):
    conn = get_connection()
    cursor = conn.cursor()
    if lyrics_source or lyrics_status:
        cursor.execute(
            "UPDATE tracks SET lyrics = ?, lyrics_source = COALESCE(?, lyrics_source), lyrics_status = COALESCE(?, lyrics_status) WHERE id = ?",
            (lyrics, lyrics_source, lyrics_status, track_id)
        )
    else:
        cursor.execute("UPDATE tracks SET lyrics = ? WHERE id = ?", (lyrics, track_id))
    conn.commit()
    conn.close()

def update_track_lyrics_data(
    track_id: str,
    lyrics: Optional[str] = None,
    lyrics_source: Optional[str] = None,
    lyrics_status: Optional[str] = None,
    lyrics_language: Optional[str] = None,
    reference_search_status: Optional[str] = None,
):
    conn = get_connection()
    cursor = conn.cursor()
    fields = []
    values = []
    if lyrics is not None:
        fields.append("lyrics = ?")
        values.append(lyrics)
    if lyrics_source is not None:
        fields.append("lyrics_source = ?")
        values.append(lyrics_source)
    if lyrics_status is not None:
        fields.append("lyrics_status = ?")
        values.append(lyrics_status)
    if lyrics_language is not None:
        fields.append("lyrics_language = ?")
        values.append(lyrics_language)
    if reference_search_status is not None:
        fields.append("reference_search_status = ?")
        values.append(reference_search_status)
    if fields:
        values.append(track_id)
        query = f"UPDATE tracks SET {', '.join(fields)} WHERE id = ?"
        cursor.execute(query, tuple(values))
        conn.commit()
    conn.close()

def set_track_synced_reference(
    track_id: str,
    synced_lrc: str,
    lyrics_source: str = "lrclib_synced_lrc",
    lyrics_status: str = "line_synced",
    reference_search_status: str = "found"
):
    """
    Atomically updates reference lyrics to synced LRC, sets source and status,
    and marks reference_search_status.
    """
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        UPDATE tracks
        SET lyrics = ?,
            lyrics_source = ?,
            lyrics_status = ?,
            reference_search_status = ?
        WHERE id = ?
    """, (synced_lrc, lyrics_source, lyrics_status, reference_search_status, track_id))
    conn.commit()
    conn.close()

def set_track_reference_search_status(track_id: str, search_status: str):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE tracks SET reference_search_status = ? WHERE id = ?", (search_status, track_id))
    conn.commit()
    conn.close()

def update_track_metadata(track_id, title, artist, album_id, lyrics):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        UPDATE tracks
        SET title = ?, artist = ?, album_id = ?, lyrics = ?
        WHERE id = ?
    """, (title, artist, album_id, lyrics, track_id))
    conn.commit()
    conn.close()

def update_track_metadata_from_audio(track_id: str, meta, album_id: Optional[int] = None, lyrics: Optional[str] = None, cover_version_inc: bool = False, preserve_empty_genre: bool = False):
    """
    Обновляет запись трека в SQLite фактическими данными, прочитанными из файла на диске.

    preserve_empty_genre=True — режим сканера: пустой/Unknown жанр из файла
    не затирает существующее непустое значение в БД. По умолчанию False —
    ручные PATCH/resync-потоки, где файл является источником истины.
    """
    conn = get_connection()
    cursor = conn.cursor()

    # Если lyrics не передан явно, берем из метаданных
    lyr = lyrics if lyrics is not None else meta.lyrics

    genre_value = _clean_genre(meta.genre) if preserve_empty_genre else meta.genre
    genre_sql = "genre = COALESCE(?, genre)" if preserve_empty_genre else "genre = ?"

    cover_inc_sql = ", cover_version = COALESCE(cover_version, 0) + 1" if cover_version_inc else ""

    cursor.execute(f"""
        UPDATE tracks
        SET title = ?,
            artist = ?,
            album_id = COALESCE(?, album_id),
            album_artist = ?,
            year = ?,
            {genre_sql},
            track_number = ?,
            disc_number = ?,
            comment = ?,
            lyrics = ?,
            duration = COALESCE(?, duration),
            bitrate = ?,
            sample_rate = ?,
            channels = ?,
            format = ?,
            file_size = ?,
            file_mtime_ns = ?
            {cover_inc_sql}
        WHERE id = ?
    """, (
        meta.title,
        meta.artist,
        album_id,
        meta.album_artist,
        meta.year,
        genre_value,
        meta.track_number,
        meta.disc_number,
        meta.comment,
        lyr,
        meta.duration if meta.duration > 0 else None,
        meta.bitrate,
        meta.sample_rate,
        meta.channels,
        meta.format,
        meta.file_size,
        meta.file_mtime_ns,
        track_id
    ))
    conn.commit()
    conn.close()

# --- Журнал мутаций (Mutation Journal) ---

def log_mutation_journal(track_id: str, status: str, old_size: Optional[int] = None, old_mtime_ns: Optional[int] = None) -> int:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO track_mutation_journal (track_id, status, old_size, old_mtime_ns)
        VALUES (?, ?, ?, ?)
    """, (track_id, status, old_size, old_mtime_ns))
    journal_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return journal_id

def update_mutation_journal(journal_id: int, status: str):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE track_mutation_journal SET status = ? WHERE id = ?", (status, journal_id))
    conn.commit()
    conn.close()

def get_uncommitted_mutations() -> List[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT * FROM track_mutation_journal
        WHERE status = 'replaced'
        ORDER BY created_at ASC
    """)
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_track_auto_genres(
    track_id: str,
    auto_genres: Optional[List[Dict[str, Any]]],
    model_name: Optional[str] = None,
    updated_at: Optional[str] = None,
    sync_pending: bool = False,
) -> None:
    """Сохраняет автоматически определенные жанры в формате JSON и название модели.

    Ручной genre не изменяется.
    """
    serialized = json.dumps(auto_genres, ensure_ascii=False) if auto_genres is not None else None
    conn = get_connection()
    cursor = conn.cursor()
    status = "classified"
    if updated_at:
        cursor.execute("""
            UPDATE tracks
            SET auto_genres = ?,
                auto_genre_model = ?,
                auto_genre_updated_at = ?,
                auto_genre_status = ?,
                auto_genre_sync_pending = ?
            WHERE id = ?
        """, (serialized, model_name, updated_at, status, int(sync_pending), str(track_id)))
    else:
        cursor.execute("""
            UPDATE tracks
            SET auto_genres = ?,
                auto_genre_model = ?,
                auto_genre_updated_at = CURRENT_TIMESTAMP,
                auto_genre_status = ?,
                auto_genre_sync_pending = ?
            WHERE id = ?
        """, (serialized, model_name, status, int(sync_pending), str(track_id)))
    conn.commit()
    conn.close()


def get_pending_auto_genre_syncs() -> List[Dict[str, Any]]:
    """Возвращает auto-жанры, которые не удалось доставить в Qdrant."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT id, auto_genres, auto_genre_model, auto_genre_updated_at
        FROM tracks
        WHERE auto_genre_sync_pending = 1
          AND auto_genre_status = 'classified'
    """)
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return rows


def mark_auto_genre_sync_complete(track_id: str) -> None:
    """Помечает auto-жанры как доставленные в Qdrant."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE tracks SET auto_genre_sync_pending = 0 WHERE id = ?",
        (str(track_id),),
    )
    conn.commit()
    conn.close()


def mark_auto_genre_failed(track_id: str) -> None:
    """Помечает классификацию неуспешной и удаляет устаревший результат."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        UPDATE tracks
        SET auto_genres = NULL,
            auto_genre_model = NULL,
            auto_genre_status = 'failed',
            auto_genre_sync_pending = 0,
            auto_genre_updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    """, (str(track_id),))
    conn.commit()
    conn.close()


def reset_failed_auto_genres() -> int:
    """Возвращает failed-классификации в очередь backfill."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE tracks SET auto_genre_status = NULL WHERE auto_genre_status = 'failed'")
    count = cursor.rowcount
    conn.commit()
    conn.close()
    return count
