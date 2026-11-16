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
import uuid
import pytest
from unittest import mock
from starlette.testclient import TestClient

with mock.patch('qdrant_client.QdrantClient'):
    import db
    import config
    from api import app
    from repositories import delivery
    from services.delivery_service import sign_path, _pin

SYNTHETIC_DIR = Path(__file__).parent / 'fixtures' / 'cdn'
SAMPLE_SYNTHETIC = SYNTHETIC_DIR / 'sample_synthetic.mp3'
SAMPLE_REPLACEMENT = SYNTHETIC_DIR / 'sample_replacement.mp3'


@pytest.fixture
def origin_env(tmp_path, monkeypatch):
    db_path = tmp_path / 'origin_test.db'
    monkeypatch.setenv('PUUK_DB_PATH', str(db_path))
    monkeypatch.setenv('MUSIC_DIR', str(tmp_path))
    monkeypatch.setattr(config, 'CDN_ORIGIN_ENABLED', True)
    monkeypatch.setattr(config, 'CDN_ORIGIN_SECRET', 'b' * 64)
    monkeypatch.setattr(config, 'CDN_SIGNING_SECRET', 'OriginSigningKey1234567890')
    monkeypatch.setattr(config, 'CDN_DELIVERY_ENABLED', True)

    db.init_db()
    audio_path = tmp_path / 'track1.mp3'
    audio_data = SAMPLE_SYNTHETIC.read_bytes()
    audio_path.write_bytes(audio_data)

    tid = str(uuid.uuid4())
    db.add_or_update_track(tid, audio_path.name, 'Origin Track', None, 'Origin Artist')

    st = audio_path.stat()
    digest = hashlib.sha256(audio_data).hexdigest()
    with delivery.transaction() as conn:
        conn.execute("""INSERT INTO delivery_versions(track_id,state,content_version,fingerprint,content_length)
            VALUES (?,'ready',?,?,?) ON CONFLICT(track_id) DO UPDATE SET state='ready',content_version=excluded.content_version,
            fingerprint=excluded.fingerprint,content_length=excluded.content_length""",
            (tid, digest, json.dumps(delivery.fingerprint(st), separators=(',', ':')), st.st_size))

    secret_headers = {'X-Puuk-Origin-Secret': config.CDN_ORIGIN_SECRET}
    client = TestClient(app)
    with mock.patch('qdrant_client.QdrantClient') as q, mock.patch('services.media_locations.client.retrieve', return_value=[]):
        q.return_value.retrieve.return_value = []
        yield client, tid, digest, audio_path, audio_data, secret_headers
    client.close()


def valid_query(tid, digest, expires=1999999999):
    path = f"/cdn/audio/{tid}/{digest}"
    sig = sign_path(path, expires, config.CDN_SIGNING_SECRET)
    return f"?md5={sig}&expires={expires}"


def test_origin_disabled_returns_404(origin_env, monkeypatch):
    client, tid, digest, path, data, headers = origin_env
    monkeypatch.setattr(config, 'CDN_ORIGIN_ENABLED', False)
    url = f"/cdn/audio/{tid}/{digest}" + valid_query(tid, digest)
    r = client.get(url, headers=headers)
    assert r.status_code == 404


def test_origin_secret_validation(origin_env):
    client, tid, digest, path, data, headers = origin_env
    url = f"/cdn/audio/{tid}/{digest}" + valid_query(tid, digest)

    # Missing header -> 403
    assert client.get(url).status_code == 403

    # Wrong secret -> 403
    assert client.get(url, headers={'X-Puuk-Origin-Secret': 'wrong' * 12}).status_code == 403

    # Empty secret -> 403
    assert client.get(url, headers={'X-Puuk-Origin-Secret': ''}).status_code == 403

    # Oversized secret (>64 chars) -> 403
    assert client.get(url, headers={'X-Puuk-Origin-Secret': 'b' * 65}).status_code == 403

    # Duplicate / multiple header -> 403
    # Note: starlette TestClient handles duplicate headers via list or comma separation
    assert client.get(url, headers={'X-Puuk-Origin-Secret': f"{config.CDN_ORIGIN_SECRET},{config.CDN_ORIGIN_SECRET}"}).status_code == 403

    # Valid secret -> 200
    assert client.get(url, headers=headers).status_code == 200


@pytest.mark.parametrize("bad_path", [
    "/cdn/audio/NOT-A-UUID/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "/cdn/audio/11111111-2222-3333-4444-555555555555/TOOSHORT",
    "/cdn/audio/11111111-2222-3333-4444-555555555555/0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",  # uppercase hex
    "/cdn/audio/11111111-2222-3333-4444-555555555555/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/",  # trailing slash
    "/cdn/audio/11111111-2222-3333-4444-555555555555/../0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",  # dot segment
    "/cdn//audio/11111111-2222-3333-4444-555555555555/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",  # double slash
])
def test_origin_strict_path_rejections(origin_env, bad_path):
    client, tid, digest, path, data, headers = origin_env
    url = bad_path + "?md5=AAAAAAAAAAAAAAAAAAAAAA&expires=1999999999"
    r = client.get(url, headers=headers)
    assert r.status_code in (400, 404)


@pytest.mark.parametrize("query_mod", [
    "?md5=AAAAAAAAAAAAAAAAAAAAAA&expires=1999999999&extra=1",  # unknown parameter
    "?md5=AAAAAAAAAAAAAAAAAAAAAA&expires=1999999999&mt=some_token",  # mt parameter
    "?md5=AAAAAAAAAAAAAAAAAAAAAA&expires=1999999999&md5=AAAAAAAAAAAAAAAAAAAAAA",  # duplicate md5
    "?expires=1999999999&expires=1999999999&md5=AAAAAAAAAAAAAAAAAAAAAA",  # duplicate expires
    "?md5=&expires=1999999999",  # empty md5
    "?md5=AAAAAAAAAAAAAAAAAAAAAA&expires=",  # empty expires
    "?md5=AAAAAAAAAAAAAAAAAAAAAA;expires=1999999999",  # semicolon delimiter
    "?md5=AAAAAAAAAAAAAAAAAAAAAA&expires=+1999999999",  # leading plus
    "?md5=AAAAAAAAAAAAAAAAAAAAAA&expires=01999999999",  # leading zero
    "?" + "a" * 130,  # query string > 128 bytes
])
def test_origin_strict_query_rejections(origin_env, query_mod):
    client, tid, digest, path, data, headers = origin_env
    url = f"/cdn/audio/{tid}/{digest}" + query_mod
    r = client.get(url, headers=headers)
    assert r.status_code in (400, 403)


def test_origin_query_order_independence(origin_env):
    client, tid, digest, path, data, headers = origin_env
    obj_path = f"/cdn/audio/{tid}/{digest}"
    sig = sign_path(obj_path, 1999999999, config.CDN_SIGNING_SECRET)

    # Order 1: md5 then expires
    url1 = f"{obj_path}?md5={sig}&expires=1999999999"
    r1 = client.get(url1, headers=headers)
    assert r1.status_code == 200

    # Order 2: expires then md5
    url2 = f"{obj_path}?expires=1999999999&md5={sig}"
    r2 = client.get(url2, headers=headers)
    assert r2.status_code == 200


def test_origin_http_methods(origin_env):
    client, tid, digest, path, data, headers = origin_env
    url = f"/cdn/audio/{tid}/{digest}" + valid_query(tid, digest)

    # GET 200
    r_get = client.get(url, headers=headers)
    assert r_get.status_code == 200
    assert r_get.content == data
    assert r_get.headers['ETag'] == f'"sha256-{digest}"'
    assert r_get.headers['Accept-Ranges'] == 'bytes'
    assert int(r_get.headers['Content-Length']) == len(data)

    # HEAD 200 with headers but empty content
    r_head = client.head(url, headers=headers)
    assert r_head.status_code == 200
    assert r_head.content == b''
    assert int(r_head.headers['Content-Length']) == len(data)
    assert r_head.headers['ETag'] == f'"sha256-{digest}"'

    # Disallowed methods -> 405
    for method in ['post', 'put', 'delete', 'patch']:
        r = getattr(client, method)(url, headers=headers)
        assert r.status_code == 405


def test_origin_range_requests(origin_env):
    client, tid, digest, path, data, headers = origin_env
    url = f"/cdn/audio/{tid}/{digest}" + valid_query(tid, digest)
    total = len(data)

    # Start slice: bytes=0-99 (100 bytes)
    r = client.get(url, headers={**headers, 'Range': 'bytes=0-99'})
    assert r.status_code == 206
    assert r.headers['Content-Range'] == f"bytes 0-99/{total}"
    assert len(r.content) == 100
    assert r.content == data[0:100]

    # Middle slice: bytes=100-199 (100 bytes)
    r = client.get(url, headers={**headers, 'Range': 'bytes=100-199'})
    assert r.status_code == 206
    assert r.headers['Content-Range'] == f"bytes 100-199/{total}"
    assert len(r.content) == 100
    assert r.content == data[100:200]

    # Suffix slice: bytes=-50 (last 50 bytes)
    r = client.get(url, headers={**headers, 'Range': 'bytes=-50'})
    assert r.status_code == 206
    assert r.headers['Content-Range'] == f"bytes {total-50}-{total-1}/{total}"
    assert len(r.content) == 50
    assert r.content == data[total-50:]

    # Open-ended slice: bytes=100-
    r = client.get(url, headers={**headers, 'Range': 'bytes=100-'})
    assert r.status_code == 206
    assert r.headers['Content-Range'] == f"bytes 100-{total-1}/{total}"
    assert len(r.content) == total - 100
    assert r.content == data[100:]

    # Unsatisfiable range: bytes=20000-30000 (beyond total 10240)
    r = client.get(url, headers={**headers, 'Range': f"bytes={total+1000}-{total+2000}"})
    assert r.status_code == 416
    assert r.headers['Content-Range'] == f"bytes */{total}"
    assert r.content == b''

    # If-Range matching -> 206
    r = client.get(url, headers={**headers, 'Range': 'bytes=0-49', 'If-Range': f'"sha256-{digest}"'})
    assert r.status_code == 206
    assert len(r.content) == 50

    # If-Range mismatch -> 200 full file
    r = client.get(url, headers={**headers, 'Range': 'bytes=0-49', 'If-Range': '"sha256-wronghash"'})
    assert r.status_code == 200
    assert len(r.content) == total


def test_origin_equal_length_replacement_before_and_after_pin(origin_env):
    client, tid, digest, audio_path, data, headers = origin_env
    url = f"/cdn/audio/{tid}/{digest}" + valid_query(tid, digest)

    replacement_data = SAMPLE_REPLACEMENT.read_bytes()
    assert len(replacement_data) == len(data)
    assert replacement_data != data

    # 1. Equal-length replacement BEFORE pin:
    # Atomically replace file with replacement fixture of same length
    tmp_rep = audio_path.with_suffix('.tmp')
    tmp_rep.write_bytes(replacement_data)
    tmp_rep.replace(audio_path)

    # Requesting the old hash should fail because current fingerprint/hash does not match
    r_before = client.get(url, headers=headers)
    assert r_before.status_code == 404

    # Restore original content and mark ready again
    tmp_orig = audio_path.with_suffix('.orig')
    tmp_orig.write_bytes(data)
    tmp_orig.replace(audio_path)
    st = audio_path.stat()
    with delivery.transaction() as conn:
        conn.execute("""UPDATE delivery_versions SET state='ready', fingerprint=? WHERE track_id=?""",
            (json.dumps(delivery.fingerprint(st), separators=(',', ':')), tid))

    # 2. Equal-length replacement AFTER pin:
    # Pin descriptor under lock, atomically replace file while pinned, verify read still serves original pinned bytes
    import time
    cancel = threading.Event()
    deadline = time.monotonic() + 10.0
    pinned, version = _pin(tid, deadline, cancel, origin_version=digest)
    try:
        # Now atomically replace file on disk with replacement_data
        tmp_rep = audio_path.with_suffix('.tmp2')
        tmp_rep.write_bytes(replacement_data)
        tmp_rep.replace(audio_path)

        # The pinned descriptor should still yield original data bytes
        read_bytes = os.read(pinned.fd, len(data))
        assert read_bytes == data
        assert read_bytes != replacement_data
    finally:
        pinned.close()
