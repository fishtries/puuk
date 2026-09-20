"""User-track interactions: favorites, listening history, dislikes."""
import sqlite3

from repositories.base import get_connection


# --- Избранное (Favorites) ---

def add_favorite(user_id: int, track_id: str) -> bool:
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO user_favorites (user_id, track_id) VALUES (?, ?)", (user_id, track_id))
        conn.commit()
        success = True
    except sqlite3.IntegrityError:
        success = False
    conn.close()
    return success

def remove_favorite(user_id: int, track_id: str) -> bool:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM user_favorites WHERE user_id = ? AND track_id = ?", (user_id, track_id))
    affected = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return affected

def is_favorite(user_id: int, track_id: str) -> bool:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT 1 FROM user_favorites WHERE user_id = ? AND track_id = ?", (user_id, track_id))
    row = cursor.fetchone()
    conn.close()
    return row is not None

def get_user_favorites(user_id: int) -> list[dict]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT t.*, a.title AS album, uf.added_at as favorited_at
        FROM tracks t
        JOIN user_favorites uf ON t.id = uf.track_id
        LEFT JOIN albums a ON a.id = t.album_id
        WHERE uf.user_id = ?
        ORDER BY uf.added_at DESC
    """, (user_id,))
    tracks = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return tracks

def get_favorite_track_ids(user_id: int) -> set[str]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT track_id FROM user_favorites WHERE user_id = ?", (user_id,))
    ids = {row["track_id"] for row in cursor.fetchall()}
    conn.close()
    return ids

# --- История (History) ---

def add_history(user_id: int, track_id: str):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("INSERT INTO user_history (user_id, track_id) VALUES (?, ?)", (user_id, track_id))
    conn.commit()
    conn.close()

def get_user_history(user_id: int, limit: int = 50) -> list[dict]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT t.*, a.title AS album, uh.played_at
        FROM user_history uh
        JOIN tracks t ON t.id = uh.track_id
        LEFT JOIN albums a ON a.id = t.album_id
        WHERE uh.user_id = ?
          AND uh.id = (
              SELECT MAX(uh2.id)
              FROM user_history uh2
              WHERE uh2.user_id = uh.user_id AND uh2.track_id = uh.track_id
          )
        ORDER BY uh.played_at DESC, uh.id DESC
        LIMIT ?
    """, (user_id, limit))
    history = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return history

# --- Дизлайки (Dislikes) ---

def add_dislike(user_id: int, track_id: str) -> bool:
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO user_dislikes (user_id, track_id) VALUES (?, ?)", (user_id, track_id))
        conn.commit()
        success = True
    except sqlite3.IntegrityError:
        success = False
    conn.close()
    return success

def remove_dislike(user_id: int, track_id: str) -> bool:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM user_dislikes WHERE user_id = ? AND track_id = ?", (user_id, track_id))
    affected = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return affected

def get_user_dislike_ids(user_id: int) -> set[str]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT track_id FROM user_dislikes WHERE user_id = ?", (user_id,))
    dislikes = {row["track_id"] for row in cursor.fetchall()}
    conn.close()
    return dislikes
