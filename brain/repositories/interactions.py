"""User-track interactions: favorites, listening history, dislikes."""
import sqlite3

from repositories.base import get_connection, TRACK_SUMMARY_COLUMNS
from repositories.artist_credits import hydrate_track_credits


# --- Избранное (Favorites) ---

def add_favorite(user_id: int, track_id: str, *, provenance: str = 'manual') -> bool:
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO user_favorites (user_id, track_id, provenance) VALUES (?, ?, ?)", (user_id, track_id, provenance))
        conn.commit()
        success = True
    except sqlite3.IntegrityError:
        if provenance == 'manual':
            cursor.execute("UPDATE user_favorites SET provenance='manual' WHERE user_id=? AND track_id=? AND provenance='import'", (user_id,track_id))
            conn.commit()
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
    cursor.execute(f"""
        SELECT {TRACK_SUMMARY_COLUMNS}, a.title AS album, uf.added_at as favorited_at
        FROM tracks t
        JOIN user_favorites uf ON t.id = uf.track_id
        LEFT JOIN albums a ON a.id = t.album_id
        WHERE uf.user_id = ?
        ORDER BY uf.added_at DESC
    """, (user_id,))
    tracks = hydrate_track_credits([dict(row) for row in cursor.fetchall()], conn=conn)
    conn.close()
    return tracks

def get_favorite_track_ids(user_id: int, *, for_taste: bool = False) -> set[str]:
    conn = get_connection()
    cursor = conn.cursor()
    condition = " AND before_taste_reset=0" if for_taste else ""
    cursor.execute("SELECT track_id FROM user_favorites WHERE user_id = ?" + condition, (user_id,))
    ids = {row["track_id"] for row in cursor.fetchall()}
    conn.close()
    return ids

def get_favorites_fingerprint(user_id: int) -> str:
    """
    Дешёвый отпечаток лайков пользователя для валидации кэша /api/tracks:
    (число лайков, max(added_at, id)) — детерминирован без загрузки всех id.
    """
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT COUNT(*) AS cnt,
               COALESCE(MAX(added_at), '') AS max_added,
               COALESCE(MAX(rowid), 0) AS max_rowid
        FROM user_favorites WHERE user_id = ?
    """, (user_id,))
    row = cursor.fetchone()
    conn.close()
    return f"{row['cnt']}-{row['max_added']}-{row['max_rowid']}"

def set_track_rating(user_id: int, track_id: str, rating: str, operation_id: str) -> bool:
    """Apply an explicit rating once. Keep receipts even when a track is deleted."""
    if rating not in {'like', 'dislike', 'neutral'}:
        raise ValueError('invalid rating')
    conn = get_connection()
    key = (user_id, track_id)
    try:
        with conn:
            conn.execute('BEGIN IMMEDIATE')
            old = conn.execute(
                'SELECT track_id, rating FROM user_rating_operations WHERE user_id=? AND operation_id=?',
                (user_id, operation_id),
            ).fetchone()
            if old:
                if tuple(old) != (track_id, rating):
                    raise ValueError('operation_id already used for a different rating')
                return False
            if conn.execute('SELECT 1 FROM tracks WHERE id=?', (track_id,)).fetchone() is None:
                raise LookupError(track_id)

            if rating == 'like':
                conn.execute("""INSERT INTO user_favorites(user_id,track_id,provenance)
                    VALUES (?,?,'manual') ON CONFLICT(user_id,track_id) DO UPDATE
                    SET provenance='manual' WHERE user_favorites.provenance='import'""", key)
            else:
                conn.execute('DELETE FROM user_favorites WHERE user_id=? AND track_id=?', key)
            if rating == 'dislike':
                conn.execute("""INSERT INTO user_dislikes(user_id,track_id) VALUES (?,?)
                    ON CONFLICT(user_id,track_id) DO NOTHING""", key)
            else:
                conn.execute('DELETE FROM user_dislikes WHERE user_id=? AND track_id=?', key)
            conn.execute('INSERT INTO user_rating_operations VALUES (?,?,?,?)',
                         (user_id, operation_id, track_id, rating))
        return True
    finally:
        conn.close()


# --- История (History) ---

def add_history(user_id: int, track_id: str, *, playback_id=None, occurred_at=None, context=None):
    conn = get_connection()
    try:
        with conn:
            if playback_id is None:
                conn.execute("INSERT INTO user_history (user_id, track_id) VALUES (?, ?)", (user_id, track_id))
                return
            conn.execute('BEGIN IMMEDIATE')
            old = conn.execute("""SELECT track_id, played_at, context FROM user_history
                WHERE user_id=? AND playback_id=?""", (user_id, playback_id)).fetchone()
            if old:
                if tuple(old) != (track_id, occurred_at, context):
                    raise ValueError('playback_id already used for a different history event')
                return
            feedback = conn.execute("""SELECT track_id, occurred_at, context FROM user_wave_feedback
                WHERE user_id=? AND playback_id=?""", (user_id, playback_id)).fetchone()
            if feedback and tuple(feedback) != (track_id, occurred_at, context):
                raise ValueError('playback_id already used for a different play')
            conn.execute("""INSERT INTO user_history(user_id,track_id,playback_id,played_at,context,received_at)
                VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)""", (user_id, track_id, playback_id, occurred_at, context))
    finally:
        conn.close()


def get_user_history(user_id: int, limit: int = 50) -> list[dict]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(f"""
        SELECT {TRACK_SUMMARY_COLUMNS}, a.title AS album, uh.played_at
        FROM user_history uh
        JOIN tracks t ON t.id = uh.track_id
        LEFT JOIN albums a ON a.id = t.album_id
        WHERE uh.user_id = ?
          AND uh.id = (
              SELECT uh2.id
              FROM user_history uh2
              WHERE uh2.user_id = uh.user_id AND uh2.track_id = uh.track_id
              ORDER BY julianday(uh2.played_at) DESC, uh2.id DESC LIMIT 1
          )
        ORDER BY julianday(uh.played_at) DESC, uh.id DESC
        LIMIT ?
    """, (user_id, limit))
    history = hydrate_track_credits([dict(row) for row in cursor.fetchall()], conn=conn)
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
