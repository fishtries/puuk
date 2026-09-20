"""Playlists and playlist-track links."""
import sqlite3

from repositories.base import get_connection


def get_all_playlists(user_id: int = None):
    """
    Если user_id указан — возвращает личные плейлисты пользователя + публичные.
    Если user_id не указан — возвращает все плейлисты.
    """
    conn = get_connection()
    cursor = conn.cursor()
    if user_id is not None:
        cursor.execute("""
            SELECT * FROM playlists
            WHERE user_id = ? OR is_public = 1
            ORDER BY created_at DESC
        """, (user_id,))
    else:
        cursor.execute("SELECT * FROM playlists ORDER BY created_at DESC")
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
    cursor.execute("""
        SELECT t.*, a.title AS album, pt.added_at
        FROM tracks t
        JOIN playlist_tracks pt ON t.id = pt.track_id
        LEFT JOIN albums a ON a.id = t.album_id
        WHERE pt.playlist_id = ?
        ORDER BY pt.added_at ASC
    """, (playlist_id,))
    tracks = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return tracks

def add_track_to_playlist(playlist_id: int, track_id: str) -> bool:
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO playlist_tracks (playlist_id, track_id) VALUES (?, ?)", (playlist_id, track_id))
        conn.commit()
        success = True
    except sqlite3.IntegrityError:
        success = False
    conn.close()
    return success

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
