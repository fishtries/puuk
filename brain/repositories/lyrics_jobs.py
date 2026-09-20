"""Lyrics alignment background jobs registry (survives restarts in SQLite)."""
from typing import Optional, List

from repositories.base import get_connection


def set_lyrics_job(track_id: str, status: str, stage: Optional[str] = None, progress: int = 0, error: Optional[str] = None):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO lyrics_jobs (track_id, status, stage, progress, error, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(track_id) DO UPDATE SET
            status = excluded.status,
            stage = excluded.stage,
            progress = excluded.progress,
            error = excluded.error,
            updated_at = CURRENT_TIMESTAMP
    """, (track_id, status, stage, progress, error))
    conn.commit()
    conn.close()

def get_lyrics_job(track_id: str) -> Optional[dict]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM lyrics_jobs WHERE track_id = ?", (track_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def delete_lyrics_job(track_id: str):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM lyrics_jobs WHERE track_id = ?", (track_id,))
    conn.commit()
    conn.close()

def get_next_pending_lyrics_job() -> Optional[dict]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT j.*, t.title, t.artist, t.file_path, t.lyrics, t.lyrics_source
        FROM lyrics_jobs j
        JOIN tracks t ON j.track_id = t.id
        WHERE j.status = 'queued'
        ORDER BY j.created_at ASC
        LIMIT 1
    """)
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def get_pending_lyrics_jobs() -> List[dict]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT j.*, t.title, t.artist, t.file_path, t.lyrics, t.lyrics_source
        FROM lyrics_jobs j
        JOIN tracks t ON j.track_id = t.id
        WHERE j.status = 'queued'
        ORDER BY j.created_at ASC
    """)
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]
