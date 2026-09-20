"""«Моя Волна» personalization: user taste embeddings, wave feedback, track stats."""
from typing import Optional, Any

try:
    import numpy as np
except ImportError:
    np = None

from repositories.base import get_connection


def get_user_embedding(user_id: int) -> Optional[Any]:
    """Получить кэшированный 400-мерный вектор пользователя из SQLite."""
    if np is None:
        return None
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT embedding_vector FROM user_embeddings WHERE user_id = ?", (user_id,))
    row = cursor.fetchone()
    conn.close()
    if not row or not row["embedding_vector"]:
        return None
    try:
        raw_blob = row["embedding_vector"]
        arr = np.frombuffer(raw_blob, dtype=np.float32).copy()
        if arr.shape == (400,):
            return arr
    except Exception as e:
        print(f"[DB] Error deserializing user embedding: {e}")
    return None

def set_user_embedding(user_id: int, embedding: Any, track_count: int):
    """Сохранить или обновить 400-мерный вектор пользователя в SQLite."""
    if np is None:
        raise RuntimeError("numpy is required for user embeddings")
    conn = get_connection()
    cursor = conn.cursor()
    blob = embedding.astype(np.float32).tobytes()
    cursor.execute("""
        INSERT INTO user_embeddings (user_id, embedding_vector, track_count, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
            embedding_vector = excluded.embedding_vector,
            track_count = excluded.track_count,
            updated_at = CURRENT_TIMESTAMP
    """, (user_id, blob, track_count))
    conn.commit()
    conn.close()

def get_user_embedding_metadata(user_id: int) -> Optional[dict]:
    """Получить метаданные эмбеддинга (track_count, updated_at) для проверки необходимости пересчета."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT track_count, updated_at FROM user_embeddings WHERE user_id = ?", (user_id,))
    row = cursor.fetchone()
    conn.close()
    if not row:
        return None
    return dict(row)

def add_wave_feedback(
    user_id: int,
    track_id: str,
    event_type: str,
    listen_duration_ms: int = 0,
    track_duration_ms: int = 0
):
    """Записать событие фидбека ('like', 'skip', 'finish') от пользователя."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO user_wave_feedback (user_id, track_id, event_type, listen_duration_ms, track_duration_ms)
        VALUES (?, ?, ?, ?, ?)
    """, (user_id, track_id, event_type, listen_duration_ms, track_duration_ms))
    conn.commit()
    conn.close()

def get_user_listening_history(user_id: int, limit: int = 100) -> list[str]:
    """
    Получить ID треков, отражающих позитивный интерес пользователя:
    треки из user_history + качественные прослушивания из user_wave_feedback.
    """
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT track_id
        FROM (
            SELECT track_id, played_at as ts
            FROM user_history
            WHERE user_id = ?
            UNION ALL
            SELECT track_id, created_at as ts
            FROM user_wave_feedback
            WHERE user_id = ? AND (
                event_type != 'skip'
                OR (track_duration_ms > 0 AND (listen_duration_ms * 1.0 / track_duration_ms) >= 0.3)
            )
        )
        ORDER BY ts DESC
        LIMIT ?
    """, (user_id, user_id, limit))
    track_ids = [row["track_id"] for row in cursor.fetchall()]
    conn.close()
    return track_ids

def get_recent_artists(user_id: int, limit: int = 5) -> list[str]:
    """Получить список последних звучавших исполнителей для diversity boost."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT t.artist
        FROM (
            SELECT track_id, played_at as ts FROM user_history WHERE user_id = ?
            UNION ALL
            SELECT track_id, created_at as ts FROM user_wave_feedback WHERE user_id = ?
            ORDER BY ts DESC
            LIMIT ?
        ) recent
        JOIN tracks t ON t.id = recent.track_id
        WHERE t.artist IS NOT NULL AND t.artist != ''
    """, (user_id, user_id, limit * 2))
    rows = cursor.fetchall()
    conn.close()
    artists = []
    for r in rows:
        artist = r["artist"]
        if artist and artist not in artists:
            artists.append(artist)
        if len(artists) >= limit:
            break
    return artists

def update_track_stats(track_id: str, event_type: str, listen_pct: float):
    """Обновить агрегированную глобальную статистику прослушиваний трека."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM track_stats WHERE track_id = ?", (track_id,))
    row = cursor.fetchone()
    if not row:
        play_cnt = 1 if event_type in ("finish", "skip") else 0
        skip_cnt = 1 if event_type == "skip" else 0
        like_cnt = 1 if event_type == "like" else 0
        cursor.execute("""
            INSERT INTO track_stats (track_id, play_count, skip_count, like_count, avg_listen_pct, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        """, (track_id, play_cnt, skip_cnt, like_cnt, float(listen_pct)))
    else:
        current_plays = row["play_count"]
        current_skips = row["skip_count"]
        current_likes = row["like_count"]
        current_avg = row["avg_listen_pct"]

        new_plays = current_plays + (1 if event_type in ("finish", "skip") else 0)
        new_skips = current_skips + (1 if event_type == "skip" else 0)
        new_likes = current_likes + (1 if event_type == "like" else 0)

        if new_plays > 0:
            new_avg = ((current_avg * current_plays) + listen_pct) / new_plays
        else:
            new_avg = current_avg

        cursor.execute("""
            UPDATE track_stats
            SET play_count = ?, skip_count = ?, like_count = ?, avg_listen_pct = ?, updated_at = CURRENT_TIMESTAMP
            WHERE track_id = ?
        """, (new_plays, new_skips, new_likes, float(new_avg), track_id))
    conn.commit()
    conn.close()

def get_user_profile_stats(user_id: int) -> dict:
    """Получить статистику персонализации вкуса пользователя для фронтенд-индикатора."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT track_count, updated_at FROM user_embeddings WHERE user_id = ?", (user_id,))
    meta = cursor.fetchone()

    cursor.execute("SELECT COUNT(*) as total_feedback FROM user_wave_feedback WHERE user_id = ?", (user_id,))
    feedback_count = cursor.fetchone()["total_feedback"]

    cursor.execute("SELECT COUNT(*) as fav_count FROM user_favorites WHERE user_id = ?", (user_id,))
    fav_count = cursor.fetchone()["fav_count"]

    conn.close()

    track_count = meta["track_count"] if meta else feedback_count
    updated_at = meta["updated_at"] if meta else None

    return {
        "user_id": user_id,
        "track_count": track_count,
        "favorites_count": fav_count,
        "feedback_count": feedback_count,
        "last_updated": updated_at,
        "is_personalized": bool(meta and meta["track_count"] >= 5)
    }

def get_wave_stats_summary() -> dict:
    """Получить общую сводную аналитику фидбека Волны для мониторинга."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) as total FROM user_wave_feedback")
    total_events = cursor.fetchone()["total"]

    cursor.execute("""
        SELECT event_type, COUNT(*) as count,
               AVG(CASE WHEN track_duration_ms > 0 THEN (listen_duration_ms * 1.0 / track_duration_ms) ELSE 0 END) as avg_pct
        FROM user_wave_feedback
        GROUP BY event_type
    """)
    breakdown = [dict(r) for r in cursor.fetchall()]

    cursor.execute("SELECT COUNT(*) as active_profiles FROM user_embeddings")
    active_profiles = cursor.fetchone()["active_profiles"]

    conn.close()
    return {
        "total_events": total_events,
        "active_profiles": active_profiles,
        "breakdown": breakdown
    }
