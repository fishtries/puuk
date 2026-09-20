"""Album catalog persistence."""
from repositories.base import get_connection


def get_all_albums():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM albums ORDER BY title")
    albums = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return albums

def add_or_get_album(title, cover_path=None):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM albums WHERE title = ?", (title,))
    row = cursor.fetchone()
    if row:
        if cover_path and not row['cover_path']:
            cursor.execute("UPDATE albums SET cover_path = ? WHERE id = ?", (cover_path, row['id']))
            conn.commit()
        album_id = row['id']
    else:
        cursor.execute("INSERT INTO albums (title, cover_path) VALUES (?, ?)", (title, cover_path))
        conn.commit()
        album_id = cursor.lastrowid
    conn.close()
    return album_id

def get_album_tracks(album_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT t.*, a.title AS album
        FROM tracks t
        LEFT JOIN albums a ON a.id = t.album_id
        WHERE t.album_id = ?
    """, (album_id,))
    tracks = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return tracks
