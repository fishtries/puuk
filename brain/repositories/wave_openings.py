"""Per-user rotation of offered opening tracks, independent of playback feedback."""
import json

from repositories.base import get_connection


def _read(conn, user_id):
    row = conn.execute("SELECT track_ids FROM user_wave_openings WHERE user_id=?", (user_id,)).fetchone()
    return json.loads(row[0]) if row else []


def recent_openings(user_id):
    conn = get_connection()
    try:
        return _read(conn, user_id)
    finally:
        conn.close()


def reserve_opening(user_id, candidates, avoid, queued):
    """Choose and remember one head atomically, including across concurrent requests."""
    conn = get_connection()
    try:
        with conn:
            conn.execute("BEGIN IMMEDIATE")
            history = _read(conn, user_id)
            order = {tid: i for i, tid in enumerate(history)}
            pick = min(candidates, key=lambda tid: (tid in queued, order.get(tid, -1), tid in avoid))
            history = [tid for tid in history if tid != pick]
            conn.execute("""INSERT INTO user_wave_openings VALUES (?, ?)
                ON CONFLICT(user_id) DO UPDATE SET track_ids=excluded.track_ids""",
                         (user_id, json.dumps([*history, pick][-24:])))
            return pick
    finally:
        conn.close()
