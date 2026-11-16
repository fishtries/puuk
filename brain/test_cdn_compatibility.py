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
from starlette.testclient import TestClient

with mock.patch('qdrant_client.QdrantClient'):
    import db
    import config
    from api import app
    from auth import create_access_token, create_media_ticket
    from security import hash_password
    from repositories import delivery, schema

SYNTHETIC_DIR = Path(__file__).parent / 'fixtures' / 'cdn'
SAMPLE_SYNTHETIC = SYNTHETIC_DIR / 'sample_synthetic.mp3'


@pytest.fixture
def compat_env(tmp_path, monkeypatch):
    db_path = tmp_path / 'compat_test.db'
    monkeypatch.setenv('PUUK_DB_PATH', str(db_path))
    monkeypatch.setenv('MUSIC_DIR', str(tmp_path))
    monkeypatch.setattr(config, 'CDN_DELIVERY_ENABLED', False)
    monkeypatch.setattr(config, 'CDN_ORIGIN_ENABLED', False)
    monkeypatch.setattr(config, 'CDN_PURGE_ENABLED', False)
    monkeypatch.setattr(config, 'CDN_SIGNING_SECRET', 'CompatSigningSecretKey12345678')
    monkeypatch.setattr(config, 'CDN_ORIGIN_SECRET', 'e' * 64)
    monkeypatch.setattr(config, 'CDN_PILOT_USER_IDS', set())

    db.init_db()

    audio_file = tmp_path / 'compat_track.mp3'
    audio_data = SAMPLE_SYNTHETIC.read_bytes()
    audio_file.write_bytes(audio_data)

    tid = str(uuid.uuid4())
    db.add_or_update_track(tid, audio_file.name, 'Compat Track', None, 'Compat Artist')

    st = audio_file.stat()
    digest = hashlib.sha256(audio_data).hexdigest()
    with delivery.transaction() as conn:
        conn.execute("""INSERT INTO delivery_versions(track_id,state,content_version,fingerprint,content_length)
            VALUES (?,'ready',?,?,?) ON CONFLICT(track_id) DO UPDATE SET state='ready',content_version=excluded.content_version,
            fingerprint=excluded.fingerprint,content_length=excluded.content_length""",
            (tid, digest, json.dumps(delivery.fingerprint(st), separators=(',', ':')), st.st_size))

    user_id = db.create_user("compat_user", hash_password("pass"), role="user")
    user = db.get_user_by_id(user_id)
    token = create_access_token(user)
    auth_header = {'Authorization': f'Bearer {token}'}

    client = TestClient(app)
    with mock.patch('qdrant_client.QdrantClient') as q, mock.patch('services.media_locations.client.retrieve', return_value=[]):
        q.return_value.retrieve.return_value = []
        yield client, tid, digest, audio_data, user, token, auth_header
    client.close()


def test_media_ticket_dto_schema_and_defaults(compat_env):
    """Verify G1 MediaTicketResponseV1 fields in full conformance with CONTRACT §2.1."""
    client, tid, digest, data, user, token, auth_header = compat_env

    # 1. Request with omitted delivery -> direct
    r = client.post('/api/media-ticket', json={'track_id': tid}, headers=auth_header)
    assert r.status_code == 200
    dto = r.json()

    # Exact expected fields from MediaTicketResponseV1
    expected_fields = {
        'url', 'expires_in', 'expires_at', 'delivery', 'server_time',
        'content_version', 'content_length', 'download_binding',
        'delivery_epoch', 'cache_for'
    }
    assert set(dto.keys()) == expected_fields
    assert dto['delivery'] == 'direct'
    assert dto['expires_in'] == 600
    assert dto['cache_for'] == 30
    assert dto['content_version'] == digest
    assert dto['content_length'] == len(data)
    assert dto['download_binding'] == 'if-match'
    assert f'/api/stream/{tid}?mt=' in dto['url']

    # 2. Unknown delivery value -> 422
    r_bad = client.post('/api/media-ticket', json={'track_id': tid, 'delivery': 'p2p'}, headers=auth_header)
    assert r_bad.status_code == 422

    # 3. Extra unknown fields -> ignored by Pydantic
    r_extra = client.post('/api/media-ticket', json={'track_id': tid, 'extra_field': 'ignore_me'}, headers=auth_header)
    assert r_extra.status_code == 200

    # 4. Uppercase UUID -> normalized to canonical lowercase
    r_upper = client.post('/api/media-ticket', json={'track_id': tid.upper()}, headers=auth_header)
    assert r_upper.status_code == 200
    assert tid in r_upper.json()['url']


def test_two_authorized_users_share_canonical_capability_within_window(compat_env,monkeypatch):
    client,tid,digest,data,user,token,headers=compat_env
    second_id=db.create_user('cohort_second_user',hash_password('synthetic-password'))
    second=db.get_user_by_id(second_id)
    second_headers={'Authorization':'Bearer '+create_access_token(second)}
    monkeypatch.setattr(config,'CDN_DELIVERY_ENABLED',True)
    monkeypatch.setattr(config,'CDN_ORIGIN_ENABLED',True)
    monkeypatch.setattr(config,'CDN_PURGE_ENABLED',True)
    monkeypatch.setattr(config,'CDN_SIGNING_SECRET','s'*32)
    monkeypatch.setattr(config,'CDN_PILOT_USER_IDS',{user['id'],second_id})
    monkeypatch.setattr(config,'CDN_RESOURCE_ID','synthetic-resource')
    monkeypatch.setattr(config,'CDN_PURGE_TOKEN','synthetic-token')
    base=int(time.time())//300*300
    results=[]
    for now,auth in [(base+5,headers),(base+125,second_headers),(base+301,second_headers)]:
        monkeypatch.setattr(time,'time',lambda value=now:value)
        with delivery.transaction() as conn:
            conn.execute("INSERT OR REPLACE INTO delivery_control(key,value) VALUES ('purge_heartbeat',?)",(str(now),))
        response=client.post('/api/media-ticket',json={'track_id':tid,'delivery':'cdn'},headers=auth)
        assert response.status_code==200
        dto=response.json()
        assert dto['delivery']=='cdn' and 1501<=dto['expires_in']<=1800
        assert dto['expires_at']-dto['server_time']==dto['expires_in']
        assert 'no-store' in response.headers['cache-control']
        results.append(dto)
    assert results[0]['url']==results[1]['url']
    assert results[0]['expires_at']==results[1]['expires_at']==base+1800
    assert results[2]['url']!=results[1]['url'] and results[2]['expires_at']==base+2100
    with delivery.transaction() as conn:
        row=conn.execute('SELECT max_expires_at FROM delivery_exposures WHERE track_id=? AND content_version=?',(tid,digest)).fetchone()
        assert row[0]==results[2]['expires_at']


def test_delivery_selection_flags_and_pilot_isolation(compat_env, monkeypatch):
    """Verify CDN selection requires global flag, origin flag, pilot membership, ready version, healthy purge."""
    client, tid, digest, data, user, token, auth_header = compat_env

    # Flag on, but user NOT in pilot -> direct
    monkeypatch.setattr(config, 'CDN_DELIVERY_ENABLED', True)
    monkeypatch.setattr(config, 'CDN_ORIGIN_ENABLED', True)
    monkeypatch.setattr(config, 'CDN_PILOT_USER_IDS', {999999})
    r1 = client.post('/api/media-ticket', json={'track_id': tid, 'delivery': 'cdn'}, headers=auth_header)
    assert r1.status_code == 200
    assert r1.json()['delivery'] == 'direct'

    # User in pilot, but purge not healthy -> direct
    monkeypatch.setattr(config, 'CDN_PILOT_USER_IDS', {user['id']})
    monkeypatch.setattr(config, 'CDN_PURGE_ENABLED', False)
    r2 = client.post('/api/media-ticket', json={'track_id': tid, 'delivery': 'cdn'}, headers=auth_header)
    assert r2.status_code == 200
    assert r2.json()['delivery'] == 'direct'

    # User in pilot, purge healthy -> CDN selected!
    with delivery.transaction() as conn:
        conn.execute("INSERT OR REPLACE INTO delivery_control(key,value) VALUES ('purge_heartbeat', ?)", (str(time.time()),))
        conn.execute("INSERT OR REPLACE INTO delivery_control(key,value) VALUES ('purge_terminal_failures', '0')")
    monkeypatch.setattr(config, 'CDN_PURGE_ENABLED', True)
    monkeypatch.setattr(config, 'CDN_RESOURCE_ID', 'res-12345')
    monkeypatch.setattr(config, 'CDN_PURGE_TOKEN', 'token-12345')

    r3 = client.post('/api/media-ticket', json={'track_id': tid, 'delivery': 'cdn'}, headers=auth_header)
    assert r3.status_code == 200
    dto = r3.json()
    assert dto['delivery'] == 'cdn'
    assert 1501 <= dto['expires_in'] <= 1800
    assert dto['expires_at'] - dto['server_time'] == dto['expires_in']
    assert dto['download_binding'] == 'immutable-path'
    assert f'/cdn/audio/{tid}/{digest}' in dto['url']


def test_auth_scope_separation(compat_env):
    """Media JWT has scope 'media' and cannot authenticate ticket, share, or account APIs."""
    client, tid, digest, data, user, token, auth_header = compat_env

    # Generate a track-bound media JWT
    media_ticket = create_media_ticket(user, tid)
    mt_header = {'Authorization': f'Bearer {media_ticket}'}

    # 1. Media ticket CAN stream its bound track
    r_stream = client.get(f'/api/stream/{tid}?mt={media_ticket}')
    assert r_stream.status_code == 200
    assert r_stream.content == data

    # 2. Media ticket CANNOT stream a DIFFERENT track
    other_tid = str(uuid.uuid4())
    r_diff = client.get(f'/api/stream/{other_tid}?mt={media_ticket}')
    assert r_diff.status_code in (401, 403)

    # 3. Media ticket CANNOT issue a media ticket
    r_ticket = client.post('/api/media-ticket', json={'track_id': tid}, headers=mt_header)
    assert r_ticket.status_code == 401

    # 4. Media ticket CANNOT access share resolver
    r_share = client.get(f'/api/share/track/{tid}', headers=mt_header)
    assert r_share.status_code == 401

    # 5. Media ticket CANNOT access account info
    r_me = client.get('/api/auth/me', headers=mt_header)
    assert r_me.status_code == 401


def test_migration_016_idempotent_and_safe_repeated_runs(compat_env):
    """Running migration 016 or init_db multiple times succeeds without error."""
    # First repeat
    conn = db.get_connection()
    try:
        schema.apply_migrations(conn)
    finally:
        conn.close()
    db.init_db()

    # Second repeat
    conn = db.get_connection()
    try:
        schema.apply_migrations(conn)
    finally:
        conn.close()
    db.init_db()

    # Check that required delivery and share tables exist and are healthy
    conn = db.get_connection()
    try:
        tables = [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        assert 'share_entities' in tables
        assert 'track_path_claims' in tables
        assert 'delivery_versions' in tables
        assert 'delivery_control' in tables
        assert 'cdn_purge_outbox' in tables
    finally:
        conn.close()
