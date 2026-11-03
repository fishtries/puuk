"""Album catalog persistence.

Альбом — полноценная сущность с идентичностью (title, album_artist).
Нормализованные значения хранятся в отдельных колонках и защищены
уникальным индексом `idx_albums_identity`, поэтому одноимённые релизы
разных исполнителей не смешиваются, а параллельные upsert не создают дублей.
"""
import sqlite3
import unicodedata
from typing import Any, Dict, List, Optional

from repositories.artist_credits import (
    CreditSource, get_credit_states, ingest_artist_credits, legacy_artist_source,
    hydrate_album_credits, hydrate_track_credits, merge_album_credits, forget_artist_credits,
)
from repositories.base import (
    get_connection,
    TRACK_SUMMARY_COLUMNS,
    bump_catalog_version,
)

UNKNOWN_ALBUM_TITLE = "Unknown Album"
VARIOUS_ARTISTS = "Various Artists"

# Sentinel, отличающий «не менять поле» от «очистить поле (None)».
UNCHANGED = object()

# Детерминированный порядок треков альбома:
# 1. диск (disc_number);
# 2. номер трека (track_number, включая ведущие цифры "7/16" и алфавитно-цифровые вроде "A1");
# 3. явная позиция от источника (album_track_position, fallback если номеров нет);
# 4. порядок добавления (rowid, стабильный fallback вместо алфавитного по названию);
# 5. id трека (детерминированный tie-breaker).
TRACKS_ORDER_SQL = """
    ORDER BY
        CASE WHEN t.disc_number IS NULL OR t.disc_number = '' THEN 1 ELSE 0 END,
        CAST(t.disc_number AS INTEGER),
        CASE WHEN t.track_number IS NULL OR t.track_number = '' THEN 1 ELSE 0 END,
        CAST(t.track_number AS INTEGER),
        t.track_number,
        CASE WHEN t.album_track_position IS NULL THEN 1 ELSE 0 END,
        t.album_track_position,
        t.rowid,
        t.id
"""

# Детерминированный выбор представительского трека (обложка альбома).
REPRESENTATIVE_TRACK_SQL = f"""
    SELECT t.id FROM tracks t WHERE t.album_id = a.id {TRACKS_ORDER_SQL} LIMIT 1
"""


def normalize_text(value: Any) -> str:
    """NFKC-нормализация, схлопывание пробелов, регистронезависимое сравнение."""
    if value is None:
        return ""
    normalized = unicodedata.normalize("NFKC", str(value))
    return " ".join(normalized.split()).casefold()


def resolve_album(title, album_artist=None, year=None, cover_path=None, *, artist_source: CreditSource | None = None) -> int:
    """Единая точка создания/поиска альбома по идентичности (title, album_artist).

    Пустое название канонизируется в UNKNOWN_ALBUM_TITLE; пустой album_artist
    становится отдельной группой без исполнителя (""), а не merge-со всеми.
    Гонка параллельных upsert разрешается уникальным индексом + повтором SELECT.
    """
    display_title = str(title).strip() if title is not None else ""
    display_title = display_title or UNKNOWN_ALBUM_TITLE
    display_artist = str(album_artist).strip() if album_artist else None
    norm_title = normalize_text(display_title)
    norm_artist = normalize_text(display_artist)
    clean_year = str(year).strip() if year else None

    for attempt in (0, 1):
        conn = get_connection()
        try:
            conn.execute("BEGIN IMMEDIATE")
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM albums WHERE title_normalized = ? AND album_artist_normalized = ?",
                (norm_title, norm_artist),
            )
            row = cursor.fetchone()
            if row:
                updates: List[str] = []
                params: List[Any] = []
                if clean_year and not row["year"]:
                    updates.append("year = ?")
                    params.append(clean_year)
                if display_artist and not row["album_artist"]:
                    updates.append("album_artist = ?")
                    params.append(display_artist)
                if cover_path and not row["cover_path"]:
                    updates.append("cover_path = ?")
                    params.append(cover_path)
                if updates:
                    updates.append("updated_at = CURRENT_TIMESTAMP")
                    params.append(row["id"])
                    cursor.execute(
                        f"UPDATE albums SET {', '.join(updates)} WHERE id = ?",
                        tuple(params),
                    )
                before = get_credit_states('album', [row['id']], conn=conn).get(str(row['id']))
                after = ingest_artist_credits(conn, 'album', row['id'], artist_source if artist_source is not None else legacy_artist_source(album_artist))
                if updates or before != after:
                    bump_catalog_version(conn)
                conn.commit()
                return row["id"]
            cursor.execute(
                """
                INSERT INTO albums
                    (title, album_artist, year, cover_path, title_normalized, album_artist_normalized)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (display_title, display_artist, clean_year, cover_path, norm_title, norm_artist),
            )
            album_id = cursor.lastrowid
            ingest_artist_credits(conn, 'album', album_id, artist_source if artist_source is not None else legacy_artist_source(album_artist))
            bump_catalog_version(conn)
            conn.commit()
            return album_id
        except sqlite3.IntegrityError:
            conn.rollback()
            if attempt == 0:
                continue
            raise
        finally:
            conn.close()
    raise RuntimeError("resolve_album: unreachable")


def add_or_get_album(title, cover_path=None, album_artist=None, year=None) -> int:
    """Обратно-совместимая обёртка над resolve_album (старые вызовы db.add_or_get_album)."""
    return resolve_album(title, album_artist=album_artist, year=year, cover_path=cover_path)


def get_all_albums():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM albums ORDER BY title COLLATE NOCASE")
    albums = hydrate_album_credits([dict(row) for row in cursor.fetchall()], conn=conn)
    conn.close()
    return albums


def get_album(album_id) -> Optional[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM albums WHERE id = ?", (album_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def find_album_by_identity(title, album_artist=None) -> Optional[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM albums WHERE title_normalized = ? AND album_artist_normalized = ?",
        (normalize_text(title), normalize_text(album_artist)),
    )
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def get_album_tracks(album_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(f"""
        SELECT {TRACK_SUMMARY_COLUMNS}, a.title AS album, a.album_artist AS album_title_artist
        FROM tracks t
        LEFT JOIN albums a ON a.id = t.album_id
        WHERE t.album_id = ?
        {TRACKS_ORDER_SQL}
    """, (album_id,))
    tracks = hydrate_track_credits([dict(row) for row in cursor.fetchall()], conn=conn)
    conn.close()
    return tracks


def get_albums_catalog_rows(album_id=None):
    """Каталог альбомов одним агрегирующим запросом: без N+1.

    Возвращает только альбомы с треками; исполнитель и год берутся из самой
    сущности альбома, обложка — детерминированный представительский трек.
    """
    conn = get_connection()
    cursor = conn.cursor()
    conditions = ["(SELECT COUNT(*) FROM tracks t WHERE t.album_id = a.id) > 0"]
    params: List[Any] = []
    if album_id is not None:
        conditions.append("a.id = ?")
        params.append(album_id)
    cursor.execute(f"""
        SELECT a.id, a.title, a.album_artist, a.year,
               (SELECT COUNT(*) FROM tracks t WHERE t.album_id = a.id) AS track_count,
               (SELECT SUM(t.duration) FROM tracks t WHERE t.album_id = a.id) AS total_duration,
               ({REPRESENTATIVE_TRACK_SQL}) AS cover_track_id
        FROM albums a
        WHERE {' AND '.join(conditions)}
        ORDER BY
            CASE WHEN a.album_artist IS NULL OR a.album_artist = '' THEN 1 ELSE 0 END,
            a.album_artist COLLATE NOCASE,
            CAST(a.year AS INTEGER),
            a.title COLLATE NOCASE,
            a.id
    """, tuple(params))
    rows = hydrate_album_credits([dict(row) for row in cursor.fetchall()], conn=conn)
    conn.close()
    return rows


def update_album_fields(album_id, title=None, album_artist=None, year=UNCHANGED) -> Optional[Dict[str, Any]]:
    """Обновляет поля альбома (None = не менять; year=UNCHANGED = не менять год,
    year=None = очистить год) и пересчитывает нормализованную идентичность."""
    current = get_album(album_id)
    if not current:
        return None
    new_title = str(title).strip() if title is not None else current["title"]
    new_artist = str(album_artist).strip() if album_artist is not None else (current["album_artist"] or None)

    set_clauses = [
        "title = ?",
        "album_artist = ?",
        "title_normalized = ?",
        "album_artist_normalized = ?",
        "updated_at = CURRENT_TIMESTAMP",
    ]
    params: List[Any] = [
        new_title,
        new_artist,
        normalize_text(new_title),
        normalize_text(new_artist),
    ]
    if year is not UNCHANGED:
        set_clauses.append("year = ?")
        params.append(year)
    params.append(album_id)

    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        f"UPDATE albums SET {', '.join(set_clauses)} WHERE id = ?",
        tuple(params),
    )
    ingest_artist_credits(conn, 'album', album_id, legacy_artist_source(new_artist))
    # Название альбома видно в DTO каталога треков (поле album) — двигаем версию.
    bump_catalog_version(conn)
    conn.commit()
    updated = get_album(album_id)
    conn.close()
    return updated


def rebind_tracks_to_album(track_ids: List[str], target_album_id) -> int:
    """Explicit membership change, with its recovery snapshot in one transaction."""
    if not track_ids:
        return 0
    conn = get_connection()
    try:
        conn.execute('BEGIN IMMEDIATE')
        count = 0
        ids = list(dict.fromkeys(str(value) for value in track_ids))
        for offset in range(0, len(ids), 400):
            chunk = ids[offset:offset+400]
            binds = ','.join('?' for _ in chunk)
            count += conn.execute(f'UPDATE tracks SET album_id=? WHERE id IN ({binds})', (target_album_id, *chunk)).rowcount
            conn.execute(f"UPDATE artist_credit_state SET recovery_album_id=? WHERE entity_type='track' AND entity_id IN ({binds})", (target_album_id, *chunk))
        if count:
            bump_catalog_version(conn)
        conn.commit()
        return count
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def merge_album_into(source_album_id, target_album_id) -> None:
    """Preflight manual credits before moving any tracks or deleting the source."""
    if source_album_id == target_album_id:
        return
    conn = get_connection()
    try:
        conn.execute('BEGIN IMMEDIATE')
        merge_album_credits(conn, source_album_id, target_album_id)
        cursor = conn.cursor()
        cursor.execute("UPDATE artist_credit_state SET recovery_album_id=? WHERE entity_type='track' AND recovery_album_id=?", (target_album_id, source_album_id))
        cursor.execute("UPDATE tracks SET album_id = ? WHERE album_id = ?", (target_album_id, source_album_id))
        cursor.execute("SELECT * FROM albums WHERE id IN (?, ?)", (source_album_id, target_album_id))
        rows = {row["id"]: dict(row) for row in cursor.fetchall()}
        source, target = rows.get(source_album_id), rows.get(target_album_id)
        if target and source:
            updates: List[str] = []
            params: List[Any] = []
            if not target.get("year") and source.get("year"):
                updates.append("year = ?")
                params.append(source["year"])
            if not target.get("cover_path") and source.get("cover_path"):
                updates.append("cover_path = ?")
                params.append(source["cover_path"])
            if updates:
                updates.append("updated_at = CURRENT_TIMESTAMP")
                params.append(target_album_id)
                cursor.execute(
                    f"UPDATE albums SET {', '.join(updates)} WHERE id = ?",
                    tuple(params),
                )
        cursor.execute("DELETE FROM albums WHERE id = ?", (source_album_id,))
        bump_catalog_version(conn)
        conn.commit()

    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def delete_empty_albums() -> int:
    """Explicit cleanup also forgets credit recovery decisions; registry survives."""
    conn = get_connection()
    try:
        conn.execute('BEGIN IMMEDIATE')
        ids = [r[0] for r in conn.execute('SELECT id FROM albums WHERE NOT EXISTS (SELECT 1 FROM tracks WHERE album_id=albums.id)')]
        for album_id in ids:
            forget_artist_credits(conn, 'album', album_id)
            conn.execute('DELETE FROM albums WHERE id=?', (album_id,))
        if ids:
            bump_catalog_version(conn)
        conn.commit()
        return len(ids)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _most_frequent_track_value(cursor, album_id, expression: str) -> Optional[str]:
    cursor.execute(f"""
        SELECT {expression} AS val, COUNT(*) AS c
        FROM tracks
        WHERE album_id = ?
          AND {expression} IS NOT NULL
          AND TRIM({expression}) != ''
        GROUP BY val
        ORDER BY c DESC, val ASC
        LIMIT 1
    """, (album_id,))
    row = cursor.fetchone()
    return row["val"] if row else None


def backfill_album_identities(*, conn=None) -> int:
    """Миграция 008 (данные): заполнить нормализованную идентичность и слить дубли.

    - album_artist/year альбома выводятся из наиболее частого непустого значения
      его треков (COALESCE(album_artist, artist)); существующие поля не затираются;
    - альбомы с одинаковой идентичностью сливаются (хранится запись с min id);
    - в конце создаётся уникальный индекс идентичности.
    Повторный запуск — no-op. Возвращает число слитых дубликатов.
    """
    own = conn is None
    conn = get_connection() if own else conn
    cursor = conn.cursor()
    cursor.execute("PRAGMA table_info(albums)")
    cols = {row["name"].lower() for row in cursor.fetchall()}
    if "title_normalized" not in cols:
        if own:
            conn.close()
        return 0

    cursor.execute("SELECT id, title, album_artist, year FROM albums")
    albums = [dict(row) for row in cursor.fetchall()]

    merged = 0
    for album in albums:
        computed_artist = _most_frequent_track_value(cursor, album["id"], "COALESCE(album_artist, artist)")
        computed_year = _most_frequent_track_value(cursor, album["id"], "year")
        display_artist = (album["album_artist"] or "").strip() or computed_artist or None
        display_title = (album["title"] or "").strip() or UNKNOWN_ALBUM_TITLE
        cursor.execute("""
            UPDATE albums
            SET title = ?,
                album_artist = ?,
                year = COALESCE(?, year),
                title_normalized = ?,
                album_artist_normalized = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        """, (
            display_title,
            display_artist,
            computed_year,
            normalize_text(display_title),
            normalize_text(display_artist),
            album["id"],
        ))
    if own:
        conn.commit()

    cursor.execute(
        "SELECT id, title_normalized, album_artist_normalized, album_artist, year, cover_path FROM albums"
    )
    groups: Dict[tuple, List[Dict[str, Any]]] = {}
    for row in cursor.fetchall():
        record = dict(row)
        key = (record["title_normalized"] or "", record["album_artist_normalized"] or "")
        groups.setdefault(key, []).append(record)

    for members in groups.values():
        if len(members) < 2:
            continue
        keeper, duplicates = members[0], members[1:]
        for dup in duplicates:
            cursor.execute("UPDATE tracks SET album_id = ? WHERE album_id = ?", (keeper["id"], dup["id"]))
            if not keeper.get("album_artist") and dup.get("album_artist"):
                keeper["album_artist"] = dup["album_artist"]
            if not keeper.get("year") and dup.get("year"):
                keeper["year"] = dup["year"]
            if not keeper.get("cover_path") and dup.get("cover_path"):
                keeper["cover_path"] = dup["cover_path"]
            cursor.execute("DELETE FROM albums WHERE id = ?", (dup["id"],))
            merged += 1
    if own:
        conn.commit()

    cursor.execute("""
        DELETE FROM albums
        WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL)
    """)
    if own:
        conn.commit()

    cursor.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_identity "
        "ON albums(title_normalized, album_artist_normalized)"
    )
    if own:
        conn.commit()
    if own:
        conn.close()
    return merged
