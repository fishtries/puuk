import test_db_path  # Must precede config/app imports.
import os
import tempfile
from pathlib import Path

assert os.environ['PUUK_DB_PATH'].startswith(tempfile.gettempdir() + os.sep)
assert Path(os.environ['PUUK_DB_PATH']).is_absolute()
import sqlite3
_test_database = Path(os.environ['PUUK_DB_PATH']).resolve()
assert _test_database.is_relative_to(Path(tempfile.gettempdir()).resolve())
os.environ['PUUK_DB_PATH'] = str(_test_database)
_isolation_connection = sqlite3.connect(_test_database)
try:
    assert Path(_isolation_connection.execute('PRAGMA database_list').fetchone()[2]).resolve() == _test_database
finally:
    _isolation_connection.close()

import hashlib
import json
import time
import uuid
import pytest
from unittest import mock

with mock.patch('qdrant_client.QdrantClient'):
    import db
    import config
    from repositories import delivery, share_entities
    from services.cdn_purge_service import PurgeSupervisor

SYNTHETIC_DIR = Path(__file__).parent / 'fixtures' / 'cdn'
SAMPLE_SYNTHETIC = SYNTHETIC_DIR / 'sample_synthetic.mp3'


@pytest.fixture
def purge_env(tmp_path, monkeypatch):
    db_path = tmp_path / 'purge_test.db'
    monkeypatch.setenv('PUUK_DB_PATH', str(db_path))
    monkeypatch.setenv('MUSIC_DIR', str(tmp_path))
    monkeypatch.setattr(config, 'DELIVERY_LOCK_DIR', str(tmp_path / 'locks'))
    monkeypatch.setattr(config, 'CDN_PURGE_ENABLED', True)
    monkeypatch.setattr(config, 'CDN_RESOURCE_ID', 'test_resource_123')
    monkeypatch.setattr(config, 'CDN_PURGE_TOKEN', 'test_token_123')

    os.makedirs(tmp_path / 'locks', mode=0o700, exist_ok=True)
    db.init_db()

    audio_file = tmp_path / 'purge_track.mp3'
    audio_data = SAMPLE_SYNTHETIC.read_bytes()
    audio_file.write_bytes(audio_data)

    tid = str(uuid.uuid4())
    db.add_or_update_track(tid, audio_file.name, 'Purge Track', None, 'Purge Artist')

    st = audio_file.stat()
    digest = hashlib.sha256(audio_data).hexdigest()
    with delivery.transaction() as conn:
        conn.execute("""INSERT INTO delivery_versions(track_id,state,content_version,fingerprint,content_length)
            VALUES (?,'ready',?,?,?) ON CONFLICT(track_id) DO UPDATE SET state='ready',content_version=excluded.content_version,
            fingerprint=excluded.fingerprint,content_length=excluded.content_length""",
            (tid, digest, json.dumps(delivery.fingerprint(st), separators=(',', ':')), st.st_size))

    with mock.patch('qdrant_client.QdrantClient') as q, mock.patch('services.media_locations.client.retrieve', return_value=[]):
        q.return_value.retrieve.return_value = []
        yield tid, digest, audio_file


def test_direct_only_track_creates_zero_purge_jobs(purge_env):
    """Mutating or deleting a direct-only track (never exposed to CDN) creates 0 purge outbox rows."""
    tid, digest, audio_file = purge_env

    # Track has ready version, but NO entry in delivery_exposures
    conn = db.get_connection()
    try:
        assert conn.execute('SELECT COUNT(*) FROM delivery_exposures WHERE track_id=?', (tid,)).fetchone()[0] == 0
    finally:
        conn.close()

    # Invalidate track (simulate tag update or replace)
    delivery.invalidate(tid)

    # Deleting track
    db.delete_track(tid)

    # Outbox must have ZERO jobs
    conn = db.get_connection()
    try:
        count = conn.execute('SELECT COUNT(*) FROM cdn_purge_outbox').fetchone()[0]
        assert count == 0
    finally:
        conn.close()


def test_exposed_track_creates_purge_job(purge_env):
    """Mutating an exposed track within drain_until window creates a durable purge outbox job."""
    tid, digest, audio_file = purge_env

    # Record CDN exposure for track
    now = int(time.time())
    with delivery.transaction() as conn:
        delivery.expose(conn, tid, digest, now + 1800)

    # Invalidate (simulates audio replacement)
    delivery.invalidate(tid)

    # Check outbox has a pending job for this track
    conn = db.get_connection()
    try:
        row = conn.execute('SELECT * FROM cdn_purge_outbox WHERE path LIKE ?', (f'%{tid}%',)).fetchone()
        assert row is not None
        assert row['state'] == 'pending'
    finally:
        conn.close()


def test_expired_exposure_creates_zero_purge_jobs(purge_env):
    """If drain_until (max_expires_at + 3630) has passed, mutation creates ZERO purge jobs."""
    tid, digest, audio_file = purge_env

    # Record exposure that expired in the past
    now = int(time.time())
    past_expiry = now - 4000
    with delivery.transaction() as conn:
        delivery.expose(conn, tid, digest, past_expiry)
        # Ensure max_expires_at is old
        conn.execute('UPDATE delivery_exposures SET max_expires_at=? WHERE track_id=?', (past_expiry, tid))

    # Invalidate track
    delivery.invalidate(tid)

    # Must NOT create any purge jobs because needs_intent is False
    conn = db.get_connection()
    try:
        count = conn.execute('SELECT COUNT(*) FROM cdn_purge_outbox').fetchone()[0]
        assert count == 0
    finally:
        conn.close()


def test_saturated_capacity_blocks_exposed_but_allows_direct(purge_env, monkeypatch):
    """When outbox capacity is 0/full, direct-only operations succeed while exposed operations fail busy."""
    tid, digest, audio_file = purge_env

    # Saturate capacity to 0
    monkeypatch.setattr(delivery, 'CAPACITY', 0)

    # 1. Direct-only track can still be invalidated with 0 outbox jobs
    delivery.invalidate(tid)

    # 2. Expose the track to CDN
    with delivery.transaction() as conn:
        delivery.expose(conn, tid, digest, int(time.time()) + 1800)

    # 3. Deleting exposed track when capacity is 0 must raise TimeoutError (backpressure)
    with pytest.raises(TimeoutError):
        delivery.invalidate(tid, deleting=True)

    # 4. Deletion was rolled back: track is still active in share_entities!
    assert share_entities.recovery_allowed(tid) is True


def test_purge_rate_limiting_and_ambiguous_submission(purge_env):
    """Ambiguous submission (timeout) increments attempts and enforces at least 60s backoff."""
    tid, digest, audio_file = purge_env

    now = int(time.time())
    with delivery.transaction() as conn:
        delivery.expose(conn, tid, digest, now + 1800)
    delivery.invalidate(tid)

    supervisor = PurgeSupervisor()
    with mock.patch.object(supervisor, 'run_child', side_effect=TimeoutError()):
        supervisor.tick()

    conn = db.get_connection()
    try:
        row = dict(conn.execute('SELECT * FROM cdn_purge_outbox').fetchone())
        assert row['state'] == 'pending'
        assert row['reason'] == 'ambiguous_submission'
        assert row['attempts'] == 1
        assert row['next_attempt_at'] >= time.time() + 60

        # Rate limiter control record enforces next submission >= 60s
        next_sub = float(conn.execute("SELECT value FROM delivery_control WHERE key='purge_next_submission'").fetchone()[0])
        assert next_sub >= time.time() + 60
    finally:
        conn.close()

    # Immediate second tick does not call run_child because of rate limiting
    with mock.patch.object(supervisor, 'run_child') as call:
        supervisor.tick()
        call.assert_not_called()


def test_drained_status_transition_for_expired_jobs(purge_env):
    """Expired failed purge jobs transition to 'drained' with audit record preserved."""
    tid, digest, audio_file = purge_env

    now = int(time.time())
    with delivery.transaction() as conn:
        delivery.expose(conn, tid, digest, now + 1800)
    delivery.invalidate(tid)

    supervisor = PurgeSupervisor()
    with mock.patch.object(supervisor, 'run_child', return_value={'status': 'terminal', 'reason': 'rejected'}):
        supervisor.tick()

    with delivery.transaction() as conn:
        row = dict(conn.execute('SELECT * FROM cdn_purge_outbox').fetchone())
        assert row['state'] == 'failed'

        # Force drain_until into the past
        conn.execute('UPDATE cdn_purge_outbox SET drain_until=0')
        delivery.drain_expired(conn)

        # Job must be in 'drained' state (not 'succeeded'!)
        row_drained = dict(conn.execute('SELECT * FROM cdn_purge_outbox').fetchone())
        assert row_drained['state'] == 'drained'
