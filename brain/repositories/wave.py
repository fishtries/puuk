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

def set_user_embedding(user_id: int, embedding: Any, track_count: int, source_revision=None):
    """Сохранить или обновить 400-мерный вектор пользователя в SQLite."""
    if np is None:
        raise RuntimeError("numpy is required for user embeddings")
    conn = get_connection()
    try:
        with conn:
            conn.execute('BEGIN IMMEDIATE')
            current = conn.execute('SELECT revision FROM user_taste_revisions WHERE user_id=?', (user_id,)).fetchone()
            revision = current['revision'] if current else 0
            if source_revision is not None and source_revision != revision:
                return  # feedback arrived while computing the vector
            vector = np.asarray(embedding, dtype=np.float32)
            if vector.shape != (400,) or not np.isfinite(vector).all():
                raise ValueError('Expected a finite 400-dimensional taste vector')
            conn.execute("""INSERT INTO user_embeddings
                (user_id,embedding_vector,track_count,source_revision,updated_at)
                VALUES (?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET
                embedding_vector=excluded.embedding_vector,track_count=excluded.track_count,
                source_revision=excluded.source_revision,updated_at=CURRENT_TIMESTAMP""",
                (user_id,vector.tobytes(),track_count,revision))
    finally:
        conn.close()

def get_user_embedding_metadata(user_id: int) -> Optional[dict]:
    """Получить метаданные эмбеддинга (track_count, updated_at) для проверки необходимости пересчета."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT track_count, updated_at, source_revision FROM user_embeddings WHERE user_id = ?", (user_id,))
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
    try:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO user_wave_feedback (user_id, track_id, event_type, listen_duration_ms, track_duration_ms)
            VALUES (?, ?, ?, ?, ?)
        """, (user_id, track_id, event_type, listen_duration_ms, track_duration_ms))
        conn.commit()
    finally:
        conn.close()

# A canonical outcome replaces its start, even when the two deliveries are far apart.
_UNPAIRED_START = """NOT EXISTS (SELECT 1 FROM user_wave_feedback f
    WHERE f.user_id=h.user_id AND f.playback_id=h.playback_id)"""


# Sequence numbers cover legacy events with second-resolution server timestamps.
# Client timestamps also keep late offline deliveries on their side of the reset.
_NEW_HISTORY = """h.id > :history_id AND (h.playback_id IS NULL OR :reset_at IS NULL
    OR julianday(h.played_at) > julianday(:reset_at))"""
_NEW_FEEDBACK = """id > :feedback_id AND (occurred_at IS NULL OR :reset_at IS NULL
    OR julianday(occurred_at) > julianday(:reset_at))"""


def _taste_window(conn, user_id):
    row = conn.execute("SELECT * FROM user_taste_resets WHERE user_id=?", (user_id,)).fetchone()
    return dict(row) if row else dict(user_id=user_id, reset_at=None, history_id=0, feedback_id=0)


def reset_taste(user_id):
    """Start learning again while preserving the library and listening history."""
    conn = get_connection()
    try:
        with conn:
            conn.execute('BEGIN IMMEDIATE')
            conn.execute("""INSERT OR REPLACE INTO user_taste_resets
                SELECT ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                    COALESCE((SELECT MAX(id) FROM user_history WHERE user_id=?), 0),
                    COALESCE((SELECT MAX(id) FROM user_wave_feedback WHERE user_id=?), 0)
                """, (user_id, user_id, user_id))
            conn.execute("""UPDATE user_favorites SET before_taste_reset=1
                WHERE user_id=? AND before_taste_reset=0""", (user_id,))
            conn.execute("""INSERT INTO user_taste_revisions(user_id,revision) VALUES (?,1)
                ON CONFLICT(user_id) DO UPDATE SET revision=revision+1""", (user_id,))
            conn.execute("DELETE FROM user_embeddings WHERE user_id=?", (user_id,))
    finally:
        conn.close()


def recent_wave_exposure(user_id):
    """Per-track recent playback volume and early skips on suggested music."""
    conn = get_connection()
    try:
        rows = conn.execute(f"""
            WITH plays AS (
                SELECT h.track_id, julianday(h.played_at) AS ts, 0 AS skipped
                FROM user_history h WHERE h.user_id=? AND {_UNPAIRED_START}
                AND (h.playback_id IS NOT NULL OR NOT EXISTS (
                    SELECT 1 FROM user_wave_feedback f WHERE f.user_id=h.user_id
                    AND f.track_id=h.track_id AND f.playback_id IS NULL
                    AND f.event_type IN ('skip','finish')
                    AND abs(julianday(COALESCE(f.occurred_at,f.created_at))-julianday(h.played_at))<10.0/1440))
                UNION ALL
                SELECT track_id, julianday(COALESCE(occurred_at,created_at)),
                    event_type='skip' AND COALESCE(context,'unknown')!='manual'
                    AND listen_duration_ms < 30000 AND listen_duration_ms*2 < track_duration_ms
                FROM user_wave_feedback WHERE user_id=? AND event_type IN ('finish','skip')
                    AND provenance NOT IN ('qa','import')
            )
            SELECT track_id, SUM(1.0 - (julianday('now')-ts)/30.0) AS exposure,
                MAX(skipped AND ts >= julianday('now','-14 days')) AS skipped
            FROM plays WHERE ts BETWEEN julianday('now','-30 days') AND julianday('now')
            GROUP BY track_id""", (user_id, user_id))
        return {r['track_id']: (r['exposure'], bool(r['skipped'])) for r in rows}
    finally:
        conn.close()


def get_user_listening_history(user_id: int, limit: int = 100) -> list[str]:
    """
    Получить ID треков, отражающих позитивный интерес пользователя:
    треки из user_history + качественные прослушивания из user_wave_feedback.
    """
    conn = get_connection()
    cursor = conn.cursor()
    window = _taste_window(conn, user_id)
    cursor.execute(f"""
        SELECT track_id
        FROM (
            SELECT track_id, played_at as ts
            FROM user_history h
            WHERE user_id = :user_id AND {_NEW_HISTORY} AND {_UNPAIRED_START}
            UNION ALL
            SELECT track_id, CASE WHEN playback_id IS NULL THEN created_at ELSE occurred_at END as ts
            FROM user_wave_feedback
            WHERE user_id = :user_id AND {_NEW_FEEDBACK} AND (
                event_type != 'skip'
                OR (track_duration_ms > 0 AND (listen_duration_ms * 1.0 / track_duration_ms) >= 0.3)
            )
        )
        ORDER BY julianday(ts) DESC
        LIMIT :limit
    """, dict(window, limit=limit))
    track_ids = [row["track_id"] for row in cursor.fetchall()]
    conn.close()
    return track_ids

def get_recent_artists(user_id: int, limit: int = 5) -> list[str]:
    """Получить список последних звучавших исполнителей для diversity boost."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(f"""
        SELECT t.artist
        FROM (
            SELECT track_id, julianday(played_at) as ts FROM user_history h WHERE user_id = ? AND {_UNPAIRED_START}
            UNION ALL
            SELECT track_id, julianday(CASE WHEN playback_id IS NULL THEN created_at ELSE occurred_at END) as ts FROM user_wave_feedback WHERE user_id = ?
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


def get_recent_artist_counts(user_id: int, limit: int = 5) -> dict[str, int]:
    """Count each participant once per event in the latest listening window."""
    if limit <= 0:
        return {}
    from collections import Counter
    from repositories.artist_credits import get_credit_states
    conn = get_connection()
    try:
        events = conn.execute(f"""
            SELECT track_id FROM (
                SELECT track_id, played_at AS ts, 0 AS source, rowid AS event_row
                FROM user_history h WHERE user_id=? AND {_UNPAIRED_START}
                UNION ALL
                SELECT track_id, CASE WHEN playback_id IS NULL THEN created_at ELSE occurred_at END AS ts, 1 AS source, rowid AS event_row
                FROM user_wave_feedback WHERE user_id=?
            ) ORDER BY julianday(ts) DESC, track_id ASC, source ASC, event_row DESC LIMIT ?
        """, (user_id, user_id, limit)).fetchall()
        ids = [str(row['track_id']) for row in events]
        states = get_credit_states('track', ids, conn=conn)
        counts = Counter()
        for track_id in ids:
            state = states.get(track_id)
            if state:
                counts.update({artist['id'] for artist in state['artists']})
        return dict(counts)
    finally:
        conn.close()

def update_track_stats(track_id: str, event_type: str, listen_pct: float, *, conn=None):
    """Обновить агрегированную глобальную статистику прослушиваний трека."""
    owned = conn is None
    conn = conn or get_connection()
    try:
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
        if owned:
            conn.commit()
    finally:
        if owned:
            conn.close()

def get_user_profile_stats(user_id: int) -> dict:
    """Получить статистику персонализации вкуса пользователя для фронтенд-индикатора."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT track_count, updated_at, source_revision FROM user_embeddings WHERE user_id = ?", (user_id,))
    meta = cursor.fetchone()

    cursor.execute(f"SELECT COUNT(*) as total_feedback FROM user_wave_feedback WHERE user_id=:user_id AND {_NEW_FEEDBACK}", _taste_window(conn,user_id))
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


def get_taste_revision(user_id):
    conn = get_connection()
    try:
        row = conn.execute('SELECT revision FROM user_taste_revisions WHERE user_id=?', (user_id,)).fetchone()
        return row['revision'] if row else 0
    finally:
        conn.close()


def record_listening_event(user_id, track_id, event_type, listen_duration_ms=0,
                           track_duration_ms=0, event_id=None, occurred_at=None,
                           context=None, client=None, provenance='listening', *, playback_id=None):
    """Event, like and counters commit together. Return False for an exact retry.

    Reusing an ID for another payload is a conflict, never a silent new action.
    Old clients without an ID retain their existing append behavior.
    """
    conn = get_connection()
    try:
        with conn:
            conn.execute('BEGIN IMMEDIATE')
            values = (track_id, event_type, listen_duration_ms, track_duration_ms,
                      occurred_at, context, client, provenance, playback_id)
            if event_id:
                old = conn.execute('SELECT track_id,event_type,listen_duration_ms,track_duration_ms,occurred_at,context,client,provenance,playback_id FROM user_wave_feedback WHERE user_id=? AND event_id=?', (user_id,event_id)).fetchone()
                if old:
                    if tuple(old) != values:
                        raise ValueError('event_id already used for a different event')
                    return False
            if playback_id:
                if conn.execute("""SELECT 1 FROM user_wave_feedback WHERE user_id=? AND playback_id=?""",
                                (user_id, playback_id)).fetchone():
                    raise ValueError('playback_id already has an outcome')
                history = conn.execute("""SELECT track_id, played_at, context FROM user_history
                    WHERE user_id=? AND playback_id=?""", (user_id, playback_id)).fetchone()
                if history and tuple(history) != (track_id, occurred_at, context):
                    raise ValueError('playback_id already used for a different play')
            conn.execute("""INSERT INTO user_wave_feedback
                (user_id,track_id,event_type,listen_duration_ms,track_duration_ms,event_id,occurred_at,context,client,provenance,playback_id)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)""", (user_id, track_id, event_type, listen_duration_ms,
                         track_duration_ms, event_id, occurred_at, context, client, provenance, playback_id))
            if event_type == 'like':
                conn.execute("""INSERT OR IGNORE INTO user_favorites(user_id,track_id,provenance,before_taste_reset)
                    VALUES (?,?,'manual',EXISTS(SELECT 1 FROM user_taste_resets WHERE user_id=?
                        AND julianday(?) <= julianday(reset_at)))""", (user_id,track_id,user_id,occurred_at))
                conn.execute("UPDATE user_favorites SET provenance='manual' WHERE user_id=? AND track_id=? AND provenance='import'", (user_id,track_id))
            update_track_stats(track_id, event_type,
                min(1., max(0., listen_duration_ms / max(track_duration_ms, 1))), conn=conn)
        return True
    finally:
        conn.close()


def taste_snapshot(user_id, limit=2000):
    """Use playback identity for new starts and the ten minute heuristic for legacy starts."""
    conn = get_connection()
    try:
        conn.execute('BEGIN')
        revision = conn.execute('SELECT revision FROM user_taste_revisions WHERE user_id=?', (user_id,)).fetchone()
        window = dict(_taste_window(conn, user_id), limit=limit)
        events = conn.execute(f"""SELECT track_id,event_type,listen_duration_ms,track_duration_ms,
            COALESCE(occurred_at,created_at) AS ts,created_at AS received_at,context,provenance
            FROM user_wave_feedback WHERE user_id=:user_id AND {_NEW_FEEDBACK}
            ORDER BY id DESC LIMIT :limit""", window).fetchall()
        history = conn.execute(f"""SELECT h.track_id,'start' AS event_type, h.played_at AS ts,
            COALESCE(h.received_at,h.played_at) AS received_at, h.context,
            CASE WHEN h.playback_id IS NULL THEN 'legacy' ELSE 'listening' END AS provenance,
            0 AS listen_duration_ms, 0 AS track_duration_ms FROM user_history h
            WHERE h.user_id=:user_id AND {_NEW_HISTORY} AND {_UNPAIRED_START} AND (h.playback_id IS NOT NULL OR NOT EXISTS (
                SELECT 1 FROM user_wave_feedback f WHERE f.user_id=h.user_id AND f.track_id=h.track_id
                AND f.playback_id IS NULL AND f.id > :feedback_id
                AND ABS(julianday(COALESCE(f.occurred_at,f.created_at))-julianday(h.played_at))<10.0/1440))
            ORDER BY julianday(h.played_at) DESC, h.id DESC LIMIT :limit""", window).fetchall()
        likes = conn.execute("SELECT track_id FROM user_favorites WHERE user_id=? AND before_taste_reset=0 AND provenance!='import'", (user_id,)).fetchall()
        dislikes = conn.execute('SELECT track_id FROM user_dislikes WHERE user_id=?', (user_id,)).fetchall()
        return {'revision':revision['revision'] if revision else 0,
                'events':[dict(r) for r in [*events,*history]],
                'likes':{r['track_id'] for r in likes}, 'dislikes':{r['track_id'] for r in dislikes}}
    finally:
        conn.close()
