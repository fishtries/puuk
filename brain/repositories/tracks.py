"""Track records: CRUD, search, lyrics columns, audio-derived metadata, mutation journal."""
import os
import json
from typing import Optional, List, Dict, Any

from repositories import albums
from repositories.base import (
    get_connection,
    TRACK_SUMMARY_COLUMNS,
    bump_catalog_version,
)
from repositories.artist_credits import (
    CreditSource, artist_id_for_name, normalize_artist_name, ingest_artist_credits,
    legacy_artist_source, audio_artist_source, hydrate_track_credits, hydrate_album_credits,
    get_credit_states, forget_artist_credits,
)


def get_all_tracks():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT t.*, a.title AS album
        FROM tracks t
        LEFT JOIN albums a ON a.id = t.album_id
        ORDER BY t.title
    """)
    tracks = hydrate_track_credits([dict(row) for row in cursor.fetchall()], conn=conn)
    conn.close()
    return tracks

def get_tracks_page(limit: int = 50, offset: int = 0) -> List[Dict[str, Any]]:
    """Страница каталога для списковых эндпоинтов: без lyrics, LIMIT в SQL."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(f"""
        SELECT {TRACK_SUMMARY_COLUMNS}, a.title AS album
        FROM tracks t
        LEFT JOIN albums a ON a.id = t.album_id
        ORDER BY t.title
        LIMIT ? OFFSET ?
    """, (limit, offset))
    tracks = hydrate_track_credits([dict(row) for row in cursor.fetchall()], conn=conn)
    conn.close()
    return tracks

def get_tracks_by_ids(track_ids) -> Dict[str, Dict[str, Any]]:
    """Bounded batch lookup, including effective credit metadata."""
    ids = list(dict.fromkeys(str(value) for value in (track_ids or []) if value))
    if not ids:
        return {}
    conn = get_connection()
    try:
        rows = []
        for offset in range(0, len(ids), 400):
            chunk = ids[offset:offset+400]
            binds = ','.join('?' for _ in chunk)
            rows.extend(dict(row) for row in conn.execute(f"""SELECT {TRACK_SUMMARY_COLUMNS},a.title AS album
                FROM tracks t LEFT JOIN albums a ON a.id=t.album_id WHERE t.id IN ({binds})""", chunk))
        return {row['id']: row for row in hydrate_track_credits(rows, conn=conn)}
    finally:
        conn.close()


def get_catalog_tracks() -> List[Dict[str, Any]]:
    """Весь каталог без lyrics: для жанровых подборок (одна выгрузка на запрос)."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(f"""
        SELECT {TRACK_SUMMARY_COLUMNS}, a.title AS album
        FROM tracks t
        LEFT JOIN albums a ON a.id = t.album_id
        ORDER BY t.title
    """)
    tracks = hydrate_track_credits([dict(row) for row in cursor.fetchall()], conn=conn)
    conn.close()
    return tracks

def get_tracks_for_embedding_reconcile() -> List[Dict[str, Any]]:
    """Каталог для сверки ML-очереди: без lyrics, но с полными loudness-полями.

    TRACK_SUMMARY_COLUMNS не содержит loudness_analysis_version/file_size/mtime,
    которые нужны для проверки актуальности готового результата, поэтому здесь
    собственный узкий список колонок вместо тяжёлого SELECT t.* (lyrics).
    """
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT id, album_id, file_path, title, artist, duration, genre,
               file_size, file_mtime_ns,
               loudness_status, loudness_lufs, true_peak_db, normalization_gain_db,
               loudness_analysis_version, loudness_file_size, loudness_file_mtime_ns,
               loudness_error, loudness_retry_count
        FROM tracks
    """)
    tracks = hydrate_track_credits([dict(row) for row in cursor.fetchall()], conn=conn)
    conn.close()
    return tracks


def get_track_artist_map() -> Dict[str, Optional[str]]:
    """Маппинг id -> artist для резолвера артистов (вместо полной выгрузки каталога)."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, artist FROM tracks")
    mapping = {row["id"]: row["artist"] for row in cursor.fetchall()}
    conn.close()
    return mapping

def get_track(track_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM tracks WHERE id = ?", (track_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def delete_track(track_id) -> bool:
    """
    Удаляет трек и его журнал мутаций одной транзакцией.
    Зависимые строки (playlist_tracks, favorites, history, dislikes,
    wave_feedback, track_stats) уходят по FK-каскаду (foreign_keys=ON).
    Возвращает True, если трек существовал.
    """
    conn = get_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        cursor = conn.cursor()
        forget_artist_credits(conn, 'track', track_id)
        cursor.execute("DELETE FROM tracks WHERE id = ?", (track_id,))
        deleted = cursor.rowcount > 0
        cursor.execute("DELETE FROM track_mutation_journal WHERE track_id = ?", (track_id,))
        if deleted:
            bump_catalog_version(conn)
        conn.commit()
        return deleted
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

def search_tracks(query, limit=30):
    conn = get_connection()
    cursor = conn.cursor()
    search_term = f"%{query}%"
    cursor.execute(f"""
        SELECT {TRACK_SUMMARY_COLUMNS}, a.title as album_title
        FROM tracks t
        LEFT JOIN albums a ON t.album_id = a.id
        WHERE t.title LIKE ? OR EXISTS (SELECT 1 FROM track_artists ta JOIN artists ar ON ar.id=ta.artist_id
            WHERE ta.track_id=t.id AND ar.name LIKE ?) OR a.title LIKE ?
        LIMIT ?
    """, (search_term, search_term, search_term, limit))
    tracks = hydrate_track_credits([dict(row) for row in cursor.fetchall()], conn=conn)
    conn.close()
    return tracks

def search_all(query, limit=30):
    conn = get_connection()
    cursor = conn.cursor()
    search_term = f"%{query}%"

    # 1. Tracks (matching title, artist or album)
    cursor.execute(f"""
        SELECT {TRACK_SUMMARY_COLUMNS}, a.title as album_title
        FROM tracks t
        LEFT JOIN albums a ON t.album_id = a.id
        WHERE t.title LIKE ? OR EXISTS (SELECT 1 FROM track_artists ta JOIN artists ar ON ar.id=ta.artist_id
            WHERE ta.track_id=t.id AND ar.name LIKE ?) OR a.title LIKE ?
        LIMIT ?
    """, (search_term, search_term, search_term, limit))
    tracks = hydrate_track_credits([dict(row) for row in cursor.fetchall()], conn=conn)

    cursor.execute(f"""
        SELECT a.id,a.title,a.album_artist,a.year,
               (SELECT COUNT(*) FROM tracks t WHERE t.album_id=a.id) AS track_count,
               ({albums.REPRESENTATIVE_TRACK_SQL}) AS cover_track_id
        FROM albums a WHERE a.title LIKE ? OR EXISTS (
            SELECT 1 FROM album_artists aa JOIN artists ar ON ar.id=aa.artist_id
            WHERE aa.album_id=a.id AND ar.name LIKE ?)
        LIMIT ?
    """, (search_term, search_term, limit))
    albums_rows = hydrate_album_credits([dict(row) for row in cursor.fetchall()], conn=conn)
    conn.create_function('artist_fold', 1, lambda value: normalize_artist_name(value).casefold(), deterministic=True)
    cursor.execute("""
        SELECT ar.id,ar.id AS artist_id,ar.name,
          (SELECT COUNT(*) FROM track_artists ta JOIN tracks t ON t.id=ta.track_id WHERE ta.artist_id=ar.id) AS track_count,
          (SELECT COUNT(*) FROM album_artists aa WHERE aa.artist_id=ar.id AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id=aa.album_id)) AS album_count,
          (SELECT MIN(ta.track_id) FROM track_artists ta JOIN tracks t ON t.id=ta.track_id WHERE ta.artist_id=ar.id) AS cover_track_id
        FROM artists ar WHERE instr(artist_fold(ar.normalized_name),artist_fold(?))>0
          AND (EXISTS (SELECT 1 FROM track_artists ta JOIN tracks t ON t.id=ta.track_id WHERE ta.artist_id=ar.id)
            OR EXISTS (SELECT 1 FROM album_artists aa WHERE aa.artist_id=ar.id AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id=aa.album_id)))
        ORDER BY artist_fold(ar.name),ar.name,ar.id LIMIT ?
    """, (query, limit))
    artists = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return {'tracks': tracks, 'albums': albums_rows, 'artists': artists}


def _clean_genre(genre: Optional[str]) -> Optional[str]:
    """Жанр из файла для сканера: пустые и заглушки ('Unknown') считаются отсутствием жанра."""
    if genre is None:
        return None
    cleaned = str(genre).strip()
    if not cleaned or cleaned.lower() == "unknown":
        return None
    return cleaned

def _track_fingerprint(conn, track_id):
    row = conn.execute('SELECT * FROM tracks WHERE id=?', (track_id,)).fetchone()
    return (tuple(row) if row else None, get_credit_states('track', [track_id], conn=conn).get(str(track_id)))


def _recovery_album(conn, track_id, proposed_album_id):
    """Recover the original release if a lost row's source identity is unchanged."""
    existing = conn.execute('SELECT album_id FROM tracks WHERE id=?', (track_id,)).fetchone()
    if existing:
        return proposed_album_id if proposed_album_id is not None else existing[0]
    state = conn.execute("SELECT recovery_album_id FROM artist_credit_state WHERE entity_type='track' AND entity_id=?", (str(track_id),)).fetchone()
    if not state or state[0] is None:
        return proposed_album_id
    old = conn.execute('SELECT title_normalized,album_artist_normalized FROM albums WHERE id=?', (state[0],)).fetchone()
    new = conn.execute('SELECT title_normalized,album_artist_normalized FROM albums WHERE id=?', (proposed_album_id,)).fetchone() if proposed_album_id is not None else None
    return state[0] if old and (new is None or tuple(old) == tuple(new)) else proposed_album_id


def add_or_update_track(
    track_id,
    file_path,
    title,
    album_id,
    artist,
    lyrics=None,
    added_by_user_id=1,
    cover_color=None,
    duration=None,
    genre=None,
    file_size=None,
    file_mtime_ns=None,
    track_number=None,
    disc_number=None,
    album_track_position=None,
    *, artist_source: CreditSource | None = None,
):
    genre_value = _clean_genre(genre)
    conn = get_connection()
    try:
        conn.execute('BEGIN IMMEDIATE')
        before = _track_fingerprint(conn, track_id)
        album_id = _recovery_album(conn, track_id, album_id)
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM tracks WHERE id = ?", (track_id,))
        if cursor.fetchone():
            # Пустой/Unknown жанр из файла не затирает существующее непустое значение.
            cursor.execute("""
                UPDATE tracks
                SET file_path = ?, title = ?, album_id = ?, artist = ?, lyrics = ?,
                    genre = COALESCE(?, genre),
                    cover_color = COALESCE(?, cover_color), duration = COALESCE(?, duration),
                    file_size = COALESCE(?, file_size),
                    file_mtime_ns = COALESCE(?, file_mtime_ns),
                    track_number = COALESCE(?, track_number),
                    disc_number = COALESCE(?, disc_number),
                    album_track_position = COALESCE(?, album_track_position)
                WHERE id = ?
            """, (file_path, title, album_id, artist, lyrics, genre_value, cover_color, duration, file_size, file_mtime_ns, track_number, disc_number, album_track_position, track_id))
        else:
            cursor.execute("""
                INSERT INTO tracks (id, file_path, title, album_id, artist, lyrics, added_by_user_id, cover_color, duration, genre, file_size, file_mtime_ns, track_number, disc_number, album_track_position)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (track_id, file_path, title, album_id, artist, lyrics, added_by_user_id, cover_color, duration, genre_value, file_size, file_mtime_ns, track_number, disc_number, album_track_position))
        ingest_artist_credits(conn, 'track', track_id, artist_source if artist_source is not None else legacy_artist_source(artist))
        conn.execute("UPDATE artist_credit_state SET recovery_album_id=(SELECT album_id FROM tracks WHERE id=?) WHERE entity_type='track' AND entity_id=?", (track_id, str(track_id)))
        if _track_fingerprint(conn, track_id) != before:
            bump_catalog_version(conn)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

def update_track_cover_color(track_id, cover_color):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE tracks SET cover_color = ? WHERE id = ?", (cover_color, track_id))
    bump_catalog_version(conn)
    conn.commit()
    conn.close()

def update_track_lyrics(track_id, lyrics, lyrics_source=None, lyrics_status=None):
    """Обновляет текст трека. Не входит в TRACK_SUMMARY_COLUMNS — версию каталога не двигает."""
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

def update_track_metadata(track_id, title, artist, album_id, lyrics, *, artist_source: CreditSource | None = None):
    conn = get_connection()
    try:
        conn.execute('BEGIN IMMEDIATE')
        before = _track_fingerprint(conn, track_id)
        album_id = _recovery_album(conn, track_id, album_id)
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE tracks
            SET title = ?, artist = ?, album_id = ?, lyrics = ?
            WHERE id = ?
        """, (title, artist, album_id, lyrics, track_id))
        ingest_artist_credits(conn, 'track', track_id, artist_source if artist_source is not None else legacy_artist_source(artist))
        conn.execute("UPDATE artist_credit_state SET recovery_album_id=(SELECT album_id FROM tracks WHERE id=?) WHERE entity_type='track' AND entity_id=?", (track_id, str(track_id)))
        if _track_fingerprint(conn, track_id) != before:
            bump_catalog_version(conn)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

UNCHANGED = object()


def update_track_metadata_from_audio(track_id: str, meta, album_id: Optional[int] = None, lyrics: Optional[str] = None, cover_version_inc: bool = False, preserve_empty_genre: bool = False, album_track_position: Any = UNCHANGED, *, artist_source: CreditSource | None = None, album_artist_source: CreditSource | None = None):
    """
    Обновляет запись трека в SQLite фактическими данными, прочитанными из файла на диске.

    preserve_empty_genre=True — режим сканера: пустой/Unknown жанр из файла
    не затирает существующее непустое значение в БД. По умолчанию False —
    ручные PATCH/resync-потоки, где файл является источником истины.
    """
    conn = get_connection()
    try:
        conn.execute('BEGIN IMMEDIATE')
        before = _track_fingerprint(conn, track_id)
        album_id = _recovery_album(conn, track_id, album_id)
        cursor = conn.cursor()

        # Если lyrics не передан явно, берем из метаданных
        lyr = lyrics if lyrics is not None else meta.lyrics

        genre_value = _clean_genre(meta.genre) if preserve_empty_genre else meta.genre
        genre_sql = "genre = COALESCE(?, genre)" if preserve_empty_genre else "genre = ?"

        cover_inc_sql = ", cover_version = COALESCE(cover_version, 0) + 1" if cover_version_inc else ""

        if album_track_position is UNCHANGED:
            pos_sql = "album_track_position = album_track_position"
            pos_params = []
        else:
            pos_sql = "album_track_position = ?"
            pos_params = [album_track_position]

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
                file_mtime_ns = ?,
                {pos_sql}
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
            *pos_params,
            track_id
        ))
        ingest_artist_credits(conn, 'track', track_id, artist_source if artist_source is not None else audio_artist_source(meta))
        conn.execute("UPDATE artist_credit_state SET recovery_album_id=(SELECT album_id FROM tracks WHERE id=?) WHERE entity_type='track' AND entity_id=?", (track_id, str(track_id)))
        linked_album = conn.execute('SELECT album_id FROM tracks WHERE id=?', (track_id,)).fetchone()
        if linked_album and linked_album[0] is not None:
            source = album_artist_source if album_artist_source is not None else audio_artist_source(meta, album=True)
            album_before = get_credit_states('album', [linked_album[0]], conn=conn)
            ingest_artist_credits(conn, 'album', linked_album[0], source)
            album_changed = album_before != get_credit_states('album', [linked_album[0]], conn=conn)
        else:
            album_changed = False
        if _track_fingerprint(conn, track_id) != before or album_changed:
            bump_catalog_version(conn)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
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
    bump_catalog_version(conn)
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
    bump_catalog_version(conn)
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


# --- Нормализация громкости (Loudness Normalization: EBU R128) ---

def update_track_loudness(
    track_id: str,
    loudness_lufs: Optional[float],
    true_peak_db: Optional[float],
    normalization_gain_db: Optional[float],
    status: str = "analyzed",
    analysis_version: Optional[str] = None,
    file_size: Optional[int] = None,
    file_mtime_ns: Optional[int] = None,
) -> None:
    """Сохраняет результаты анализа громкости трека в SQLite."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        UPDATE tracks
        SET loudness_lufs = ?,
            true_peak_db = ?,
            normalization_gain_db = ?,
            loudness_status = ?,
            loudness_analyzed_at = CURRENT_TIMESTAMP,
            loudness_analysis_version = ?,
            loudness_file_size = COALESCE(?, loudness_file_size),
            loudness_file_mtime_ns = COALESCE(?, loudness_file_mtime_ns),
            file_size = COALESCE(?, file_size),
            file_mtime_ns = COALESCE(?, file_mtime_ns),
            loudness_error = NULL,
            loudness_retry_count = 0
        WHERE id = ?
    """, (
        loudness_lufs,
        true_peak_db,
        normalization_gain_db,
        status,
        analysis_version,
        file_size,
        file_mtime_ns,
        file_size,
        file_mtime_ns,
        str(track_id),
    ))
    bump_catalog_version(conn)
    conn.commit()
    conn.close()


def set_track_loudness_status(track_id: str, status: str, error: Optional[str] = None) -> None:
    """Обновляет статус обработки громкости (например: 'processing', 'failed')."""
    conn = get_connection()
    cursor = conn.cursor()
    if status == "failed":
        cursor.execute("""
            UPDATE tracks
            SET loudness_status = ?,
                normalization_gain_db = NULL,
                loudness_analyzed_at = CURRENT_TIMESTAMP,
                loudness_error = ?,
                loudness_retry_count = COALESCE(loudness_retry_count, 0) + 1
            WHERE id = ?
        """, (status, error, str(track_id)))
    else:
        cursor.execute("""
            UPDATE tracks
            SET loudness_status = ?,
                loudness_error = NULL
            WHERE id = ?
        """, (status, str(track_id)))
    bump_catalog_version(conn)
    conn.commit()
    conn.close()


def reset_track_loudness_pending(
    track_id: str,
    file_size: Optional[int] = None,
    file_mtime_ns: Optional[int] = None,
) -> None:
    """Сбрасывает статус громкости на pending при изменении файла."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        UPDATE tracks
        SET loudness_status = 'pending',
            normalization_gain_db = NULL,
            loudness_file_size = COALESCE(?, loudness_file_size),
            loudness_file_mtime_ns = COALESCE(?, loudness_file_mtime_ns),
            file_size = COALESCE(?, file_size),
            file_mtime_ns = COALESCE(?, file_mtime_ns),
            loudness_error = NULL,
            loudness_retry_count = 0
        WHERE id = ?
    """, (file_size, file_mtime_ns, file_size, file_mtime_ns, str(track_id)))
    bump_catalog_version(conn)
    conn.commit()
    conn.close()


def reset_failed_loudness() -> int:
    """Возвращает failed-треки в статус pending для повторного анализа."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        UPDATE tracks
        SET loudness_status = 'pending',
            loudness_error = NULL,
            loudness_retry_count = 0
        WHERE loudness_status = 'failed'
    """)
    count = cursor.rowcount
    if count:
        bump_catalog_version(conn)
    conn.commit()
    conn.close()
    return count


# =========================================================================
# Word Lyrics Storage & Verification (Migration 014 / Contract v1)
# =========================================================================

def get_track_word_lyrics(track_id: str, verify_file_stat: bool = True) -> Optional[Dict[str, Any]]:
    """
    Retrieves verified wordLyrics payload for a track.

    If verify_file_stat is True, checks audio file signature (size + mtime_ns).
    If audio file was altered or missing, returns None to avoid showing misaligned timings.
    """
    import json
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT payload_json, audio_sha256, file_path, file_size, file_mtime_ns, is_active
        FROM track_word_lyrics
        WHERE track_id = ?
    """, (str(track_id),))
    row = cursor.fetchone()
    conn.close()

    if not row or not row["is_active"]:
        return None

    if verify_file_stat:
        file_path = row["file_path"]
        current = get_track(track_id)
        if not current:
            return None
        current_path = current.get("file_path") or ""
        if not os.path.isabs(current_path) or not os.path.isfile(current_path):
            from services.media_locations import resolve_existing_file_path
            current_path = resolve_existing_file_path(current_path)
        if not current_path or os.path.realpath(current_path) != os.path.realpath(file_path):
            return None
        target_path = current_path
        if not os.path.isabs(target_path) or not os.path.exists(target_path):
            from services.media_locations import resolve_existing_file_path
            resolved = resolve_existing_file_path(file_path)
            if resolved:
                target_path = resolved

        if not os.path.exists(target_path):
            return None

        try:
            st = os.stat(target_path)
            if st.st_size != row["file_size"] or st.st_mtime_ns != row["file_mtime_ns"]:
                # File signature changed; stat check fails
                return None
        except OSError:
            return None

    try:
        from services.word_lyrics_validator import validate_word_lyrics_payload
        payload = json.loads(row["payload_json"])
        valid, error = validate_word_lyrics_payload(
            payload, expected_track_id=str(track_id), expected_audio_sha256=row["audio_sha256"])
        if not valid:
            import logging
            logging.getLogger(__name__).warning("Invalid word lyrics for %s: %s", track_id, error)
            return None
        return payload
    except Exception:
        return None


def get_track_word_lyrics_record(track_id: str, conn=None) -> Optional[Dict[str, Any]]:
    """Retrieves full database row for track_word_lyrics including provenance."""
    close_conn = False
    if conn is None:
        conn = get_connection()
        close_conn = True
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT track_id, schema_version, revision, payload_json, provenance_json,
                   audio_sha256, file_path, file_size, file_mtime_ns, imported_at, is_active
            FROM track_word_lyrics
            WHERE track_id = ?
        """, (str(track_id),))
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        if close_conn:
            conn.close()


def upsert_track_word_lyrics(
    track_id: str,
    payload_json: str,
    revision: str,
    audio_sha256: str,
    file_path: str,
    file_size: int,
    file_mtime_ns: int,
    provenance_json: Optional[str] = None,
    schema_version: int = 1,
    is_active: int = 1,
    conn=None,
) -> None:
    """Inserts or atomically replaces word lyrics snapshot for track_id."""
    close_conn = False
    if conn is None:
        conn = get_connection()
        close_conn = True
    try:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO track_word_lyrics (
                track_id, schema_version, revision, payload_json, provenance_json,
                audio_sha256, file_path, file_size, file_mtime_ns, imported_at, is_active
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
            ON CONFLICT(track_id) DO UPDATE SET
                schema_version = excluded.schema_version,
                revision = excluded.revision,
                payload_json = excluded.payload_json,
                provenance_json = excluded.provenance_json,
                audio_sha256 = excluded.audio_sha256,
                file_path = excluded.file_path,
                file_size = excluded.file_size,
                file_mtime_ns = excluded.file_mtime_ns,
                imported_at = CURRENT_TIMESTAMP,
                is_active = excluded.is_active
        """, (
            str(track_id),
            schema_version,
            revision,
            payload_json,
            provenance_json,
            audio_sha256,
            file_path,
            file_size,
            file_mtime_ns,
            is_active,
        ))
        conn.commit()
    finally:
        if close_conn:
            conn.close()


def delete_track_word_lyrics(track_id: str, conn=None) -> bool:
    """Deletes word lyrics snapshot for track_id."""
    close_conn = False
    if conn is None:
        conn = get_connection()
        close_conn = True
    try:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM track_word_lyrics WHERE track_id = ?", (str(track_id),))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted
    finally:
        if close_conn:
            conn.close()


def set_track_word_lyrics_active(track_id: str, is_active: bool, conn=None) -> bool:
    """Enables or disables word lyrics snapshot for track_id."""
    close_conn = False
    if conn is None:
        conn = get_connection()
        close_conn = True
    try:
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE track_word_lyrics
            SET is_active = ?
            WHERE track_id = ?
        """, (1 if is_active else 0, str(track_id)))
        updated = cursor.rowcount > 0
        conn.commit()
        return updated
    finally:
        if close_conn:
            conn.close()
