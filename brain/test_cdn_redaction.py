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
import logging
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
    from repositories import delivery

SYNTHETIC_DIR = Path(__file__).parent / 'fixtures' / 'cdn'
SAMPLE_SYNTHETIC = SYNTHETIC_DIR / 'sample_synthetic.mp3'

CANARY_SIGNING_SECRET = "CANARY_SIGN_SEC_778899001122"
CANARY_ORIGIN_SECRET = "f" * 32 + "1234567890abcdef1234567890abcdef"
CANARY_FILE_PATH_LEAK = "CANARY_SECRET_PATH_DIR_ROOT"


@pytest.fixture
def canary_env(tmp_path, monkeypatch):
    db_path = tmp_path / 'redaction_test.db'
    monkeypatch.setenv('PUUK_DB_PATH', str(db_path))
    monkeypatch.setenv('MUSIC_DIR', str(tmp_path))
    monkeypatch.setattr(config, 'CDN_ORIGIN_ENABLED', True)
    monkeypatch.setattr(config, 'CDN_ORIGIN_SECRET', CANARY_ORIGIN_SECRET)
    monkeypatch.setattr(config, 'CDN_SIGNING_SECRET', CANARY_SIGNING_SECRET)
    monkeypatch.setattr(config, 'CDN_DELIVERY_ENABLED', False)

    db.init_db()

    audio_file = tmp_path / f'{CANARY_FILE_PATH_LEAK}_track.mp3'
    audio_data = SAMPLE_SYNTHETIC.read_bytes()
    audio_file.write_bytes(audio_data)

    tid = str(uuid.uuid4())
    db.add_or_update_track(tid, audio_file.name, 'Redaction Track', None, 'Redaction Artist')

    st = audio_file.stat()
    digest = hashlib.sha256(audio_data).hexdigest()
    with delivery.transaction() as conn:
        conn.execute("""INSERT INTO delivery_versions(track_id,state,content_version,fingerprint,content_length)
            VALUES (?,'ready',?,?,?) ON CONFLICT(track_id) DO UPDATE SET state='ready',content_version=excluded.content_version,
            fingerprint=excluded.fingerprint,content_length=excluded.content_length""",
            (tid, digest, json.dumps(delivery.fingerprint(st), separators=(',', ':')), st.st_size))

    user_id = db.create_user("redact_user", hash_password("pass"), role="user")
    user = db.get_user_by_id(user_id)
    token = create_access_token(user)
    auth_header = {'Authorization': f'Bearer {token}'}

    client = TestClient(app)
    with mock.patch('qdrant_client.QdrantClient') as q, mock.patch('services.media_locations.client.retrieve', return_value=[]):
        q.return_value.retrieve.return_value = []
        yield client, tid, digest, audio_file, user, token, auth_header
    client.close()


def test_error_responses_do_not_leak_secrets_or_paths(canary_env):
    """Verify that 4xx/5xx responses do not contain secrets, keys, or filesystem paths."""
    client, tid, digest, audio_file, user, token, auth_header = canary_env

    # 1. 403 Forbidden with wrong secret on /cdn/audio/
    r_wrong_sec = client.get(
        f'/cdn/audio/{tid}/{digest}?md5=AAAAAAAAAAAAAAAAAAAAAA&expires=1999999999',
        headers={'X-Puuk-Origin-Secret': 'wrong'}
    )
    assert r_wrong_sec.status_code == 403
    assert CANARY_ORIGIN_SECRET not in r_wrong_sec.text
    assert CANARY_SIGNING_SECRET not in r_wrong_sec.text
    assert CANARY_FILE_PATH_LEAK not in r_wrong_sec.text

    # 2. 404 Track unavailable on stream
    nonexistent_tid = str(uuid.uuid4())
    r_notfound = client.get(f'/api/stream/{nonexistent_tid}', headers=auth_header)
    assert r_notfound.status_code == 404
    assert CANARY_FILE_PATH_LEAK not in r_notfound.text

    # 3. 400 Bad request on invalid query
    r_bad_query = client.get(
        f'/cdn/audio/{tid}/{digest}?md5=CANARY_BAD_TOKEN_VALUE&expires=abc&secret={CANARY_SIGNING_SECRET}',
        headers={'X-Puuk-Origin-Secret': CANARY_ORIGIN_SECRET}
    )
    assert r_bad_query.status_code in (400, 403)
    assert CANARY_SIGNING_SECRET not in r_bad_query.text
    assert CANARY_ORIGIN_SECRET not in r_bad_query.text


def test_logs_do_not_leak_origin_secret_or_signing_secret(canary_env, caplog):
    """Verify emitted logs do not log full origin secret, signing key, or raw JWT."""
    client, tid, digest, audio_file, user, token, auth_header = canary_env
    caplog.set_level(logging.DEBUG)

    # Make successful ticket request
    r_ticket = client.post('/api/media-ticket', json={'track_id': tid}, headers=auth_header)
    assert r_ticket.status_code == 200

    # Make origin request with origin secret
    url = f'/cdn/audio/{tid}/{digest}?md5=AAAAAAAAAAAAAAAAAAAAAA&expires=1999999999'
    r_origin = client.get(url, headers={'X-Puuk-Origin-Secret': CANARY_ORIGIN_SECRET})

    all_logs = caplog.text
    # 1. Neither signing secret nor origin secret can ever be in logs
    assert CANARY_ORIGIN_SECRET not in all_logs
    assert CANARY_SIGNING_SECRET not in all_logs

    # 2. Access JWT token must not be logged in plaintext
    assert token not in all_logs


def test_injected_internal_exception_log_redaction(canary_env, caplog, monkeypatch):
    """Even on unhandled exception containing sensitive canary, response strips it."""
    client, tid, digest, audio_file, user, token, auth_header = canary_env
    canary_exception_msg = f"EXCEPTION_CANARY_{CANARY_SIGNING_SECRET}_{CANARY_ORIGIN_SECRET}"

    from services import delivery_service
    def crashing_stream(*args, **kwargs):
        raise RuntimeError(canary_exception_msg)

    monkeypatch.setattr(delivery_service, "stream", crashing_stream)

    r = client.get(f'/api/stream/{tid}', headers=auth_header)
    assert r.status_code == 500

    # Response text must NOT leak the canary secrets
    assert CANARY_SIGNING_SECRET not in r.text
    assert CANARY_ORIGIN_SECRET not in r.text
    assert canary_exception_msg not in r.text
