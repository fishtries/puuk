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
    from repositories import share_entities

SYNTHETIC_DIR = Path(__file__).parent / 'fixtures' / 'cdn'
SAMPLE_SYNTHETIC = SYNTHETIC_DIR / 'sample_synthetic.mp3'


@pytest.fixture
def share_env(tmp_path, monkeypatch):
    db_path = tmp_path / 'share_test.db'
    monkeypatch.setenv('PUUK_DB_PATH', str(db_path))
    monkeypatch.setenv('MUSIC_DIR', str(tmp_path))

    db.init_db()

    audio_file = tmp_path / 'share_track.mp3'
    audio_file.write_bytes(SAMPLE_SYNTHETIC.read_bytes())

    # Create album and track
    aid = db.add_or_get_album('Share Album', album_artist='Share Artist')
    tid = str(uuid.uuid4())
    db.add_or_update_track(tid, audio_file.name, 'Share Track', aid, 'Share Artist')

    # Register in share_entities
    conn = db.get_connection()
    try:
        share_entities.register(conn, 'album', aid)
        share_entities.register(conn, 'track', tid)
    finally:
        conn.close()

    # Create test user
    user_id = db.create_user("share_user", hash_password("pass"), role="user")
    user = db.get_user_by_id(user_id)
    token = create_access_token(user)
    auth_header = {'Authorization': f'Bearer {token}'}

    client = TestClient(app)
    with mock.patch('qdrant_client.QdrantClient') as q, mock.patch('services.media_locations.client.retrieve', return_value=[]):
        q.return_value.retrieve.return_value = []
        yield client, tid, aid, user, token, auth_header
    client.close()


def test_share_resolver_authentication_and_scope(share_env):
    """Share resolver requires Access JWT; unauthenticated or Media JWT rejected with 401."""
    client, tid, aid, user, token, auth_header = share_env

    # 1. Unauthenticated -> 401
    assert client.get(f'/api/share/track/{tid}').status_code == 401

    # 2. Authenticated with Media JWT -> 401
    media_ticket = create_media_ticket(user, tid)
    assert client.get(f'/api/share/track/{tid}', headers={'Authorization': f'Bearer {media_ticket}'}).status_code == 401

    # 3. Authenticated with Access JWT -> 200
    r = client.get(f'/api/share/track/{tid}', headers=auth_header)
    assert r.status_code == 200
    data = r.json()
    assert data['type'] == 'track'
    assert data['requested_id'] == tid
    assert data['canonical_id'] == tid
    assert data['canonical_path'] == f'/track/{tid}'


def test_lossless_share_id_in_dtos(share_env):
    """Verify lossless string share_id and album_share_id are present in Track and Album DTOs."""
    client, tid, aid, user, token, auth_header = share_env

    # Track share resolution
    r_track = client.get(f'/api/share/track/{tid}', headers=auth_header)
    assert r_track.status_code == 200
    t_dto = r_track.json()['entity']
    assert isinstance(t_dto['share_id'], str)
    assert t_dto['share_id'] == tid
    assert isinstance(t_dto['album_share_id'], str)
    assert t_dto['album_share_id'] == str(aid)

    # Album share resolution
    r_album = client.get(f'/api/share/album/{aid}', headers=auth_header)
    assert r_album.status_code == 200
    a_dto = r_album.json()['entity']
    assert isinstance(a_dto['share_id'], str)
    assert a_dto['share_id'] == str(aid)


def test_album_alias_resolution(share_env):
    """When an album has an alias (e.g. from a merge), the share resolver returns canonical target."""
    client, tid, aid, user, token, auth_header = share_env

    # Create merged target album
    aid_target = db.add_or_get_album('Merged Target Album', album_artist='Share Artist')

    conn = db.get_connection()
    try:
        share_entities.register(conn, 'album', aid_target)
        share_entities.alias_album(conn, aid, aid_target)
        conn.commit()
    finally:
        conn.close()

    # Request old album ID -> resolver must return canonical_id == str(aid_target)
    r = client.get(f'/api/share/album/{aid}', headers=auth_header)
    assert r.status_code == 200
    res = r.json()
    assert res['requested_id'] == str(aid)
    assert res['canonical_id'] == str(aid_target)
    assert res['canonical_path'] == f'/album/{aid_target}'


def test_deleted_entity_returns_410(share_env):
    """Requesting a tombstoned/deleted entity returns 410 Gone."""
    client, tid, aid, user, token, auth_header = share_env

    conn = db.get_connection()
    try:
        share_entities.tombstone(conn, 'track', tid)
        conn.commit()
    finally:
        conn.close()

    r = client.get(f'/api/share/track/{tid}', headers=auth_header)
    assert r.status_code == 410


def test_empty_artist_profile_semantics(share_env):
    """A registered artist with 0 tracks returns 200 with empty popular_tracks and empty albums (not 404)."""
    client, tid, aid, user, token, auth_header = share_env

    # Create artist with 0 tracks in DB
    artist_name = "Empty Artist Profile"
    artist_id = "art_" + uuid.uuid4().hex

    conn = db.get_connection()
    try:
        conn.execute("INSERT INTO artists (id, normalized_name, name) VALUES (?, ?, ?)", (artist_id, artist_name.lower(), artist_name))
        share_entities.register(conn, 'artist', artist_id)
        conn.commit()
    finally:
        conn.close()

    r = client.get(f'/api/share/artist/{artist_id}', headers=auth_header)
    assert r.status_code == 200
    data = r.json()
    assert data['type'] == 'artist'
    assert data['canonical_id'] == artist_id
    assert data['tracks'] == []
    assert data['albums'] == []
    assert data['entity']['name'] == artist_name


@pytest.mark.parametrize("bad_kind,bad_id,expected_status", [
    ('playlist', '123', 400),  # unsupported kind
    ('album', '-5', 400),  # negative album id
    ('album', '0', 400),  # zero album id
    ('track', 'not-a-uuid', 400),  # malformed track id
    ('artist', 'not_art_hash', 400),  # malformed artist id
])
def test_share_resolver_input_validation(share_env, bad_kind, bad_id, expected_status):
    client, tid, aid, user, token, auth_header = share_env
    r = client.get(f'/api/share/{bad_kind}/{bad_id}', headers=auth_header)
    assert r.status_code == expected_status
