"""Failed telemetry writes must not retain SQLite's sole writer until GC."""
import test_db_path  # noqa: F401

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from threading import Event

import pytest

from repositories import base, interactions, wave
from routers import wave as wave_router


@pytest.fixture
def telemetry_db(tmp_path, monkeypatch):
    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'telemetry.db'))
    with closing(base.get_connection()) as conn:
        conn.execute('PRAGMA journal_mode=WAL')
        conn.executescript('''
            CREATE TABLE users(id INTEGER PRIMARY KEY);
            CREATE TABLE tracks(id TEXT PRIMARY KEY);
            INSERT INTO users VALUES(1);
            INSERT INTO tracks VALUES('present');
            CREATE TABLE user_history(
                id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id),
                track_id TEXT REFERENCES tracks(id));
            CREATE TABLE user_wave_feedback(
                id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id),
                track_id TEXT REFERENCES tracks(id), event_type TEXT,
                listen_duration_ms INTEGER, track_duration_ms INTEGER);
            CREATE TABLE track_stats(
                track_id TEXT PRIMARY KEY REFERENCES tracks(id),
                play_count INTEGER, skip_count INTEGER, like_count INTEGER,
                avg_listen_pct REAL, updated_at TEXT);
        ''')
    # A leaked writer fails quickly; production's timeout remains unchanged.
    def connection():
        conn = base.get_connection()
        conn.execute('PRAGMA busy_timeout=300')
        return conn
    monkeypatch.setattr(interactions, 'get_connection', connection)
    monkeypatch.setattr(wave, 'get_connection', connection)


def _write(kind, user=1, track='present'):
    if kind == 'history':
        interactions.add_history(user, track)
    elif kind == 'feedback':
        wave.add_wave_feedback(user, track, 'finish', 500, 1000)
    else:
        wave.update_track_stats(track, 'finish', 0.5)


def _close_traceback_connections(exc):
    # Before-fix runs deliberately retain a live transaction in the traceback.
    # Release it deterministically even when the regression assertion fails.
    tb = exc.__traceback__
    while tb:
        conn = tb.tb_frame.f_locals.get('conn')
        if isinstance(conn, sqlite3.Connection):
            conn.close()
        tb = tb.tb_next


@pytest.mark.parametrize('kind,user,track', [
    ('history', 1, 'missing'), ('history', 999, 'present'),
    ('feedback', 1, 'missing'), ('feedback', 999, 'present'),
    ('stats', 1, 'missing'),
])
def test_foreign_key_failure_releases_writer_with_traceback_retained(
    telemetry_db, kind, user, track,
):
    with pytest.raises(sqlite3.IntegrityError) as retained:
        _write(kind, user, track)
    try:
        # This succeeds even with the original leaked WAL writer: reads alone
        # do not establish recovery. Keep the original exception/frames alive.
        with closing(base.get_connection()) as conn:
            assert conn.execute('SELECT COUNT(*) FROM user_history').fetchone()[0] == 0
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(_write, 'history').result(timeout=2)
        with closing(base.get_connection()) as conn:
            assert conn.execute('SELECT COUNT(*) FROM user_history').fetchone()[0] == 1
            assert conn.execute('SELECT COUNT(*) FROM user_wave_feedback').fetchone()[0] == 0
            assert conn.execute('SELECT COUNT(*) FROM track_stats').fetchone()[0] == 0
    finally:
        _close_traceback_connections(retained.value)


@pytest.mark.parametrize('kind', ['history', 'feedback', 'stats'])
def test_waiting_writer_recovers_once_other_transaction_releases(
    telemetry_db, monkeypatch, kind,
):
    entering_insert = Event()
    module = interactions if kind == 'history' else wave
    get_connection = module.get_connection

    def traced_connection():
        conn = get_connection()
        conn.set_trace_callback(lambda sql: entering_insert.set() if sql.lstrip().upper().startswith('INSERT') else None)
        return conn

    monkeypatch.setattr(module, 'get_connection', traced_connection)
    with closing(base.get_connection()) as blocker:
        blocker.execute('BEGIN IMMEDIATE')
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(_write, kind)
            try:
                assert entering_insert.wait(1), 'writer never reached INSERT'
            finally:
                blocker.rollback()
            future.result(timeout=2)
    with closing(base.get_connection()) as conn:
        table = {'history': 'user_history', 'feedback': 'user_wave_feedback', 'stats': 'track_stats'}[kind]
        assert conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] == 1
        if kind == 'feedback':
            assert tuple(conn.execute('SELECT event_type, listen_duration_ms, track_duration_ms FROM user_wave_feedback').fetchone()) == ('finish', 500, 1000)
        elif kind == 'stats':
            assert tuple(conn.execute('SELECT play_count, skip_count, like_count, avg_listen_pct FROM track_stats').fetchone()) == (1, 0, 0, 0.5)


@pytest.fixture
def feedback_client(telemetry_db, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app = FastAPI()
    app.include_router(wave_router.router)
    app.dependency_overrides[wave_router.get_current_user] = lambda: {'id': 1}
    monkeypatch.setattr(wave_router, 'feedback_rate_limiter', wave_router.InMemoryRateLimiter())
    monkeypatch.setattr(wave_router, 'should_recompute_embedding', lambda *a, **k: False)
    def no_qdrant():
        raise AssertionError('telemetry regression must stay offline')
    monkeypatch.setattr(wave_router, 'get_qdrant_client', no_qdrant)
    with TestClient(app) as client:
        yield client, app


def test_missing_feedback_track_returns_404_then_valid_write_succeeds(feedback_client):
    client, _ = feedback_client
    missing = client.post('/api/wave/feedback', json={'track_id': 'deleted', 'event_type': 'finish'})
    assert missing.status_code == 404
    valid = client.post('/api/wave/feedback', json={'track_id': 'present', 'event_type': 'finish'})
    assert valid.status_code == 200
    assert valid.json() == {'status': 'ok'}
    with closing(base.get_connection()) as conn:
        assert conn.execute('SELECT COUNT(*) FROM user_wave_feedback').fetchone()[0] == 1


def test_feedback_missing_user_remains_an_error_and_releases_writer(feedback_client):
    client, app = feedback_client
    app.dependency_overrides[wave_router.get_current_user] = lambda: {'id': 999}
    with pytest.raises(sqlite3.IntegrityError) as retained:
        client.post('/api/wave/feedback', json={'track_id': 'present', 'event_type': 'finish'})
    # Retaining the ASGI exception must not keep a failed write transaction.
    _write('history')
    assert retained.value.sqlite_errorcode == sqlite3.SQLITE_CONSTRAINT_FOREIGNKEY


def test_unrelated_feedback_integrity_error_is_not_a_missing_track(feedback_client, monkeypatch):
    client, _ = feedback_client
    def reject(**kwargs):
        exc = sqlite3.IntegrityError('unrelated constraint')
        exc.sqlite_errorcode = sqlite3.SQLITE_CONSTRAINT_UNIQUE
        raise exc
    monkeypatch.setattr(wave_router.db, 'add_wave_feedback', reject)
    with pytest.raises(sqlite3.IntegrityError, match='unrelated constraint'):
        client.post('/api/wave/feedback', json={'track_id': 'deleted', 'event_type': 'finish'})


def test_artist_edit_keeps_playing_track_id_and_accepts_feedback(tmp_path, monkeypatch):
    from repositories import schema, tracks, artist_credits
    from services.artist_credit_service import set_track_artists
    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'artist-edit.db'))
    schema.init_db()
    tracks.add_or_update_track('playing', '/nonexistent/never-read.mp3', 'Song', None, 'Before')
    before = tracks.get_track('playing')
    revision = artist_credits.get_credit_states('track', ['playing'])['playing']['revision']
    result = set_track_artists('playing', [{'name': 'After'}, {'name': 'Guest'}],
                               revision, {'id': 1, 'role': 'admin'}, 'http://test')
    assert result['id'] == before['id'] == 'playing'
    assert tracks.get_track('playing')['file_path'] == before['file_path']
    _write('feedback', track='playing')
    _write('history', track='playing')
    with closing(base.get_connection()) as conn:
        assert conn.execute('SELECT COUNT(*) FROM tracks').fetchone()[0] == 1
        assert conn.execute('SELECT COUNT(*) FROM user_wave_feedback').fetchone()[0] == 1
