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
import threading
import time
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
    from services.delivery_service import _pin

SYNTHETIC_DIR = Path(__file__).parent / 'fixtures' / 'cdn'
SAMPLE_SYNTHETIC = SYNTHETIC_DIR / 'sample_synthetic.mp3'
SAMPLE_REPLACEMENT = SYNTHETIC_DIR / 'sample_replacement.mp3'


@pytest.fixture
def version_env(tmp_path, monkeypatch):
    db_path = tmp_path / 'versions_test.db'
    monkeypatch.setenv('PUUK_DB_PATH', str(db_path))
    monkeypatch.setenv('MUSIC_DIR', str(tmp_path))
    monkeypatch.setattr(config, 'CDN_DELIVERY_ENABLED', False)

    db.init_db()

    audio_path = tmp_path / 'versioned.mp3'
    audio_data = SAMPLE_SYNTHETIC.read_bytes()
    audio_path.write_bytes(audio_data)

    tid = str(uuid.uuid4())
    db.add_or_update_track(tid, audio_path.name, 'Version Track', None, 'Version Artist')

    st = audio_path.stat()
    digest = hashlib.sha256(audio_data).hexdigest()
    with delivery.transaction() as conn:
        conn.execute("""INSERT INTO delivery_versions(track_id,state,content_version,fingerprint,content_length)
            VALUES (?,'ready',?,?,?) ON CONFLICT(track_id) DO UPDATE SET state='ready',content_version=excluded.content_version,
            fingerprint=excluded.fingerprint,content_length=excluded.content_length""",
            (tid, digest, json.dumps(delivery.fingerprint(st), separators=(',', ':')), st.st_size))

    user_id = db.create_user("version_user", hash_password("pass"), role="user")
    user = db.get_user_by_id(user_id)
    token = create_access_token(user)
    auth_header = {'Authorization': f'Bearer {token}'}

    client = TestClient(app)
    with mock.patch('qdrant_client.QdrantClient') as q, mock.patch('services.media_locations.client.retrieve', return_value=[]):
        q.return_value.retrieve.return_value = []
        yield client, tid, digest, audio_path, audio_data, auth_header
    client.close()


def test_full_file_sha256_version_lifecycle(version_env):
    """content_version is SHA-256 over entire served bytes, invalidated on metadata/file change."""
    client, tid, digest, audio_path, audio_data, auth_header = version_env

    # Check verified ready row
    v_row = delivery.get_version(tid)
    assert v_row is not None
    assert v_row['state'] == 'ready'
    assert v_row['content_version'] == digest
    assert v_row['content_length'] == len(audio_data)

    # Invalidate marks pending
    delivery.invalidate(tid)
    v_after = delivery.get_version(tid)
    assert v_after['state'] == 'pending'


def test_if_match_matching_returns_full_pinned_file(version_env):
    """Direct stream with matching If-Match returns full pinned file with strong ETag."""
    client, tid, digest, audio_path, audio_data, auth_header = version_env
    headers = {
        **auth_header,
        'If-Match': f'"sha256-{digest}"',
    }
    r = client.get(f'/api/stream/{tid}', headers=headers)
    assert r.status_code == 200
    assert r.content == audio_data
    assert r.headers['ETag'] == f'"sha256-{digest}"'
    assert int(r.headers['Content-Length']) == len(audio_data)


@pytest.mark.parametrize("bad_if_match", [
    '"sha256-wronghash123456789012345678901234567890123456789012345678901234"',  # mismatch
    'W/"sha256-something"',  # weak ETag forbidden
    '*',  # wildcard forbidden
    'sha256-noparentheses',  # unquoted forbidden
    '"sha256-0000000000000000000000000000000000000000000000000000000000000000", "sha256-other"',  # multiple headers forbidden
])
def test_if_match_mismatched_or_malformed_returns_412(version_env, bad_if_match):
    client, tid, digest, audio_path, audio_data, auth_header = version_env
    headers = {
        **auth_header,
        'If-Match': bad_if_match,
    }
    r = client.get(f'/api/stream/{tid}', headers=headers)
    assert r.status_code == 412
    assert r.content == b'{"detail":"Version precondition failed"}'


def test_if_match_combined_with_range_returns_412(version_env):
    """Range combined with If-Match cache precondition must return 412."""
    client, tid, digest, audio_path, audio_data, auth_header = version_env
    headers = {
        **auth_header,
        'If-Match': f'"sha256-{digest}"',
        'Range': 'bytes=0-100',
    }
    r = client.get(f'/api/stream/{tid}', headers=headers)
    assert r.status_code == 412


def test_equal_length_replacement_before_and_after_pin(version_env):
    """Equal-length replacement before pin returns 412; after pin serves pinned descriptor."""
    client, tid, digest, audio_path, audio_data, auth_header = version_env
    replacement_data = SAMPLE_REPLACEMENT.read_bytes()
    assert len(replacement_data) == len(audio_data)
    assert replacement_data != audio_data

    # 1. Equal-length replacement BEFORE pin:
    tmp_rep = audio_path.with_suffix('.tmp_repl')
    tmp_rep.write_bytes(replacement_data)
    tmp_rep.replace(audio_path)

    # Request with old hash -> must fail with 412 because current file hash != old digest
    headers = {
        **auth_header,
        'If-Match': f'"sha256-{digest}"',
    }
    r_before = client.get(f'/api/stream/{tid}', headers=headers)
    assert r_before.status_code == 412

    # Restore original file and mark ready again
    tmp_orig = audio_path.with_suffix('.tmp_orig')
    tmp_orig.write_bytes(audio_data)
    tmp_orig.replace(audio_path)
    st = audio_path.stat()
    with delivery.transaction() as conn:
        conn.execute("""UPDATE delivery_versions SET state='ready', fingerprint=? WHERE track_id=?""",
            (json.dumps(delivery.fingerprint(st), separators=(',', ':')), tid))

    # 2. Equal-length replacement AFTER pin:
    cancel = threading.Event()
    deadline = time.monotonic() + 10.0
    pinned, version = _pin(tid, deadline, cancel, if_match=[f'"sha256-{digest}"'])
    try:
        # Atomically replace file on disk while descriptor is pinned
        tmp_rep = audio_path.with_suffix('.tmp_repl2')
        tmp_rep.write_bytes(replacement_data)
        tmp_rep.replace(audio_path)

        # Reading from the pinned descriptor must return the original audio data
        read_bytes = os.read(pinned.fd, len(audio_data))
        assert read_bytes == audio_data
        assert read_bytes != replacement_data
    finally:
        pinned.close()
