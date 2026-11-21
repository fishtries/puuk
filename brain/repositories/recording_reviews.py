"""Durable recording reviews compare and affect only the requested file revision."""
from contextlib import closing
import json
import re
import time

from repositories import delivery
from repositories.base import bump_catalog_version, get_connection


def revision(row):
    size, mtime = row.get('file_size'), row.get('file_mtime_ns')
    return f'{size}:{mtime}' if size and mtime else None


def request(track_id, actor_id, expected):
    if not expected or not re.fullmatch(r'\d+:\d+', expected):
        return 'unavailable'
    with closing(get_connection()) as conn, conn:
        conn.execute('BEGIN IMMEDIATE')
        found = conn.execute('SELECT state FROM recording_reviews WHERE track_id=? AND revision=?',
                             (track_id, expected)).fetchone()
        if found:
            return found['state']
        track = conn.execute('SELECT file_path,file_size,file_mtime_ns FROM tracks WHERE id=?', (track_id,)).fetchone()
        if not track or expected != revision(dict(track)):
            return 'changed'
        rows = conn.execute('SELECT evidence FROM telegram_track_imports WHERE track_id=?', (track_id,)).fetchall()
        evidence = next((data for row in rows if (data := json.loads(row[0])).get('reference')), None)
        if not evidence:
            return 'unavailable'
        conn.execute('INSERT INTO recording_reviews(track_id,owner_id,revision,file_path,source) VALUES (?,?,?,?,?)',
                     (track_id, actor_id, expected, track['file_path'], json.dumps(evidence['reference'])))
        return 'queued'


def recover():
    with closing(get_connection()) as conn, conn:
        conn.execute("UPDATE recording_reviews SET state='queued' WHERE state='running'")


def claim():
    with closing(get_connection()) as conn, conn:
        row = conn.execute("""UPDATE recording_reviews SET state='running',attempts=attempts+1
            WHERE id=(SELECT id FROM recording_reviews WHERE state='queued' AND retry_at<=?
            ORDER BY id LIMIT 1) RETURNING *""", (time.time(),)).fetchone()
        return dict(row) if row else None


def finish(review, result):
    track_id = review['track_id']
    with closing(get_connection()) as conn, conn:
        conn.execute('BEGIN IMMEDIATE')
        track = conn.execute('SELECT file_path,file_size,file_mtime_ns FROM tracks WHERE id=?', (track_id,)).fetchone()
        if not track or track['file_path'] != review['file_path'] or review['revision'] != revision(dict(track)):
            result = 'changed'
        if result == 'mismatch':
            conn.execute('UPDATE tracks SET audio_review_blocked=1 WHERE id=?', (track_id,))
            delivery.reserve_retirement(conn, track_id, unmanaged=True)
            bump_catalog_version(conn)
        if result == 'unavailable' and review['attempts'] < 3:
            conn.execute("UPDATE recording_reviews SET state='queued',retry_at=? WHERE id=?",
                         (time.time() + 60 * review['attempts'], review['id']))
        else:
            conn.execute('UPDATE recording_reviews SET state=? WHERE id=?', (result, review['id']))
        return result


def blocked_track_ids():
    with closing(get_connection()) as conn:
        return {row[0] for row in conn.execute('SELECT id FROM tracks WHERE audio_review_blocked=1')}
