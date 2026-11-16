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
import uuid
import pytest
from unittest import mock
from starlette.testclient import TestClient

with mock.patch('qdrant_client.QdrantClient'):
    import db
    import config
    from api import app
    from auth import create_access_token
    from security import hash_password
    from repositories import delivery
    from services.delivery_service import sign_path


@pytest.fixture
def boundary_env(tmp_path, monkeypatch):
    db_path = tmp_path / 'boundary_test.db'
    monkeypatch.setenv('PUUK_DB_PATH', str(db_path))
    monkeypatch.setenv('MUSIC_DIR', str(tmp_path))
    monkeypatch.setattr(config, 'CDN_ORIGIN_ENABLED', True)
    monkeypatch.setattr(config, 'CDN_ORIGIN_SECRET', 'c' * 64)
    monkeypatch.setattr(config, 'CDN_SIGNING_SECRET', 'BoundarySecretKey1234567890')
    monkeypatch.setattr(config, 'CDN_DELIVERY_ENABLED', False)

    db.init_db()
    audio_path = tmp_path / 'boundary.mp3'
    audio_data = b'ABCDEF' * 1000
    audio_path.write_bytes(audio_data)

    tid = str(uuid.uuid4())
    db.add_or_update_track(tid, audio_path.name, 'Boundary Track', None, 'Boundary Artist')

    st = audio_path.stat()
    digest = hashlib.sha256(audio_data).hexdigest()
    with delivery.transaction() as conn:
        conn.execute("""INSERT INTO delivery_versions(track_id,state,content_version,fingerprint,content_length)
            VALUES (?,'ready',?,?,?) ON CONFLICT(track_id) DO UPDATE SET state='ready',content_version=excluded.content_version,
            fingerprint=excluded.fingerprint,content_length=excluded.content_length""",
            (tid, digest, json.dumps(delivery.fingerprint(st), separators=(',', ':')), st.st_size))

    user_id = db.create_user("boundary_user", hash_password("pass"), role="user")
    user = db.get_user_by_id(user_id)
    token = create_access_token(user)
    auth_header = {'Authorization': f'Bearer {token}'}

    client = TestClient(app)
    with mock.patch('qdrant_client.QdrantClient') as q, mock.patch('services.media_locations.client.retrieve', return_value=[]):
        q.return_value.retrieve.return_value = []
        yield client, tid, digest, audio_data, user, token, auth_header
    client.close()


def test_assembled_cors_and_no_store_on_direct_success(boundary_env):
    client, tid, digest, audio_data, user, token, auth_header = boundary_env
    headers = {
        **auth_header,
        'Origin': 'https://web.puuk.fun',
    }
    r = client.get(f'/api/stream/{tid}', headers=headers)
    assert r.status_code == 200
    assert r.content == audio_data
    # Cache-control private, no-store
    cc = r.headers.get('cache-control', '')
    assert 'no-store' in cc and 'private' in cc
    # CORS
    assert r.headers.get('access-control-allow-origin') == 'https://web.puuk.fun'
    assert 'access-control-allow-credentials' not in r.headers
    assert 'accept-ranges' in r.headers.get('access-control-expose-headers', '').lower()


def test_assembled_cors_untrusted_origin_rejected(boundary_env):
    client, tid, digest, audio_data, user, token, auth_header = boundary_env
    headers = {
        **auth_header,
        'Origin': 'https://evil.attacker.com',
    }
    r = client.get(f'/api/stream/{tid}', headers=headers)
    assert r.status_code == 200
    # Untrusted origin must not get Access-Control-Allow-Origin
    assert r.headers.get('access-control-allow-origin') != 'https://evil.attacker.com'
    assert 'access-control-allow-origin' not in r.headers


def test_assembled_preflight_origin_requires_secret(boundary_env):
    client, tid, digest, audio_data, user, token, auth_header = boundary_env
    preflight_headers = {
        'Origin': 'https://web.puuk.fun',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'range',
    }
    url = f'/cdn/audio/{tid}/{digest}?md5=AAAAAAAAAAAAAAAAAAAAAA&expires=1999999999'

    # Missing origin secret header on /cdn/ preflight -> 403
    r1 = client.options(url, headers=preflight_headers)
    assert r1.status_code == 403

    # With valid secret header -> 204
    r2 = client.options(url, headers={**preflight_headers, 'X-Puuk-Origin-Secret': config.CDN_ORIGIN_SECRET})
    assert r2.status_code == 204
    assert r2.headers.get('access-control-allow-origin') == 'https://web.puuk.fun'
    assert 'GET' in r2.headers.get('access-control-allow-methods', '')
    assert int(r2.headers.get('access-control-max-age', 0)) == 300


@pytest.mark.parametrize("status,method,path,extra_headers,body", [
    (400, 'GET', '/api/stream/not-a-uuid', {}, None),
    (401, 'POST', '/api/media-ticket', {}, {'track_id': '00000000-0000-0000-0000-000000000001'}),
    (403, 'GET', '/cdn/audio/00000000-0000-4000-8000-000000000001/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?md5=AAAAAAAAAAAAAAAAAAAAAA&expires=1999999999', {'X-Puuk-Origin-Secret': 'wrong'}, None),
    (404, 'GET', '/api/stream/00000000-0000-4000-8000-000000000002', {'Authorization': 'Bearer placeholder'}, None),
    (405, 'POST', '/api/stream/00000000-0000-4000-8000-000000000001', {}, None),
    (412, 'GET', '/api/stream/{tid}', {'Authorization': 'Bearer valid', 'If-Match': '"sha256-wrong"'}, None),
    (416, 'GET', '/api/stream/{tid}', {'Authorization': 'Bearer valid', 'Range': 'bytes=500000-600000'}, None),
    (422, 'POST', '/api/media-ticket', {'Authorization': 'Bearer valid'}, {'track_id': '00000000-0000-0000-0000-000000000001', 'delivery': 'unsupported_mode'}),
])
def test_assembled_error_responses_receive_media_boundary_policy(boundary_env, status, method, path, extra_headers, body):
    client, tid, digest, audio_data, user, token, auth_header = boundary_env
    resolved_path = path.replace('{tid}', tid)

    headers = {
        'Origin': 'https://web.puuk.fun',
        **extra_headers,
    }
    if headers.get('Authorization') == 'Bearer valid':
        headers['Authorization'] = f'Bearer {token}'
    elif headers.get('Authorization') == 'Bearer placeholder' and status == 404:
        headers['Authorization'] = f'Bearer {token}'

    r = client.request(method, resolved_path, headers=headers, json=body)
    assert r.status_code == status

    # Verify Cache-Control: private, no-store on error
    cc = r.headers.get('cache-control', '')
    assert 'no-store' in cc and 'private' in cc

    # Verify CORS headers on error
    assert r.headers.get('access-control-allow-origin') == 'https://web.puuk.fun'
    assert 'access-control-allow-credentials' not in r.headers

    # 401 must include WWW-Authenticate: Bearer
    if status == 401:
        assert 'Bearer' in r.headers.get('www-authenticate', '')


def test_assembled_injected_500_receives_boundary_policy(boundary_env, monkeypatch):
    client, tid, digest, audio_data, user, token, auth_header = boundary_env
    headers = {
        **auth_header,
        'Origin': 'https://web.puuk.fun',
    }

    # Inject an unhandled error inside delivery_service.stream
    from services import delivery_service
    def broken_stream(*args, **kwargs):
        raise RuntimeError("Injected internal crash for boundary test")
    monkeypatch.setattr(delivery_service, "stream", broken_stream)

    r = client.get(f'/api/stream/{tid}', headers=headers)
    assert r.status_code == 500

    cc = r.headers.get('cache-control', '')
    assert 'no-store' in cc and 'private' in cc
    assert r.headers.get('access-control-allow-origin') == 'https://web.puuk.fun'
    assert 'access-control-allow-credentials' not in r.headers


def test_account_route_preflight_compatibility(boundary_env):
    """Verify that default account routes (outside media boundary) retain baseline CORS behavior."""
    client, tid, digest, audio_data, user, token, auth_header = boundary_env
    preflight_headers = {
        'Origin': 'https://web.puuk.fun',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
    }
    r = client.options('/api/auth/login', headers=preflight_headers)
    assert r.status_code == 200
    assert r.headers.get('access-control-allow-origin') == 'https://web.puuk.fun'


def test_boundary_payload_size_limits(boundary_env):
    client, tid, digest, audio_data, user, token, auth_header = boundary_env

    # 1. Ticket JSON body > 4 KiB -> 413
    oversized_body = {'track_id': tid, 'extra': 'X' * 5000}
    r_body = client.post('/api/media-ticket', json=oversized_body, headers=auth_header)
    assert r_body.status_code == 413

    # 2. Authorization header > 8 KiB -> 400
    oversized_auth = {'Authorization': 'Bearer ' + 'Y' * 9000}
    r_auth = client.post('/api/media-ticket', json={'track_id': tid}, headers=oversized_auth)
    assert r_auth.status_code == 400
