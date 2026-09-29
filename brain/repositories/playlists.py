"""Playlists and playlist-track links."""
import sqlite3

from repositories.base import get_connection, TRACK_SUMMARY_COLUMNS


def get_all_playlists(user_id: int = None):
    """
    Если user_id указан — возвращает личные плейлисты пользователя + публичные.
    Если user_id не указан — возвращает все плейлисты.
    Каждая запись дополнена track_count (число связей в playlist_tracks).
    """
    conn = get_connection()
    cursor = conn.cursor()
    if user_id is not None:
        cursor.execute("""
            SELECT p.*, (
                SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id
            ) AS track_count
            FROM playlists p
            WHERE p.user_id = ? OR p.is_public = 1
            ORDER BY p.created_at DESC
        """, (user_id,))
    else:
        cursor.execute("""
            SELECT p.*, (
                SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id
            ) AS track_count
            FROM playlists p
            ORDER BY p.created_at DESC
        """)
    playlists = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return playlists

def create_playlist(name: str, user_id: int = 1, is_public: bool = False):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO playlists (name, user_id, is_public)
        VALUES (?, ?, ?)
    """, (name, user_id, 1 if is_public else 0))
    conn.commit()
    playlist_id = cursor.lastrowid
    conn.close()
    return playlist_id

def get_playlist(playlist_id: int):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM playlists WHERE id = ?", (playlist_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def get_playlist_tracks(playlist_id: int):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(f"""
        SELECT {TRACK_SUMMARY_COLUMNS}, a.title AS album, pt.added_at
        FROM tracks t
        JOIN playlist_tracks pt ON t.id = pt.track_id
        LEFT JOIN albums a ON a.id = t.album_id
        WHERE pt.playlist_id = ?
        ORDER BY pt.position ASC, pt.added_at ASC
    """, (playlist_id,))
    tracks = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return tracks

def add_track_to_playlist(playlist_id: int, track_id: str) -> bool:
    conn = get_connection()
    cursor = conn.cursor()
    try:
        # Новый трек всегда в конец: position = max+1 (пустой плейлист -> 0)
        cursor.execute(
            "SELECT COALESCE(MAX(position), -1) AS max_pos FROM playlist_tracks WHERE playlist_id = ?",
            (playlist_id,),
        )
        next_position = cursor.fetchone()["max_pos"] + 1
        cursor.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)",
            (playlist_id, track_id, next_position),
        )
        conn.commit()
        success = True
    except sqlite3.IntegrityError:
        conn.rollback()
        success = False
    conn.close()
    return success

def reorder_playlist_tracks(playlist_id: int, track_ids: list) -> bool:
    """
    Полностью перезаписывает порядок треков плейлиста:
    position каждого трека = его индекс в track_ids.

    Возвращает False без изменения порядка, если:
      - плейлист с таким playlist_id не существует, либо
      - состав track_ids не совпадает с текущим составом плейлиста
        (дубликаты, неизвестные track_id или неполный список).
    Возвращает True, если порядок успешно записан (одна транзакция).
    """
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT id FROM playlists WHERE id = ?", (playlist_id,))
        if cursor.fetchone() is None:
            return False
        cursor.execute(
            "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?",
            (playlist_id,),
        )
        current_track_ids = {row["track_id"] for row in cursor.fetchall()}
        if len(track_ids) != len(set(track_ids)) or set(track_ids) != current_track_ids:
            return False
        cursor.executemany(
            "UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?",
            [(index, playlist_id, track_id) for index, track_id in enumerate(track_ids)],
        )
        conn.commit()
        return True
    finally:
        conn.close()

def remove_track_from_playlist(playlist_id: int, track_id: str):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?", (playlist_id, track_id))
    conn.commit()
    conn.close()

def delete_playlist(playlist_id: int):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))
    conn.commit()
    conn.close()

def update_playlist(playlist_id: int, new_name: str, is_public: bool = None):
    conn = get_connection()
    cursor = conn.cursor()
    if is_public is not None:
        cursor.execute("""
            UPDATE playlists
            SET name = ?, is_public = ?
            WHERE id = ?
        """, (new_name, 1 if is_public else 0, playlist_id))
    else:
        cursor.execute("UPDATE playlists SET name = ? WHERE id = ?", (new_name, playlist_id))
    conn.commit()
    conn.close()
