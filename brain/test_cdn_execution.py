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

import asyncio
import fcntl
import hashlib
import threading
import time
import uuid
import pytest
from unittest import mock
from fastapi import HTTPException
from starlette.requests import Request
from starlette.testclient import TestClient

with mock.patch('qdrant_client.QdrantClient'):
    import db
    import config
    from api import app
    from auth import create_access_token
    from security import hash_password
    from repositories import delivery
    from services.delivery_service import DeliveryExecutor, stream
    from services.content_version_service import HashSupervisor, OwnerSupervisor
    from metadata import track_mutation_lock


@pytest.fixture
def exec_env(tmp_path, monkeypatch):
    db_path = tmp_path / 'exec_test.db'
    monkeypatch.setenv('PUUK_DB_PATH', str(db_path))
    monkeypatch.setenv('MUSIC_DIR', str(tmp_path))
    monkeypatch.setattr(config, 'DELIVERY_LOCK_DIR', str(tmp_path / 'delivery_locks'))
    monkeypatch.setattr(config, 'CDN_DELIVERY_ENABLED', False)
    monkeypatch.setattr(config, 'CDN_ORIGIN_ENABLED', True)
    monkeypatch.setattr(config, 'CDN_ORIGIN_SECRET', 'd' * 64)

    os.makedirs(tmp_path / 'delivery_locks', mode=0o700, exist_ok=True)
    db.init_db()

    audio_path = tmp_path / 'exec_audio.mp3'
    data = b'ExecutionTestBytes' * 100
    audio_path.write_bytes(data)

    tid = str(uuid.uuid4())
    db.add_or_update_track(tid, audio_path.name, 'Exec Track', None, 'Exec Artist')

    user_id = db.create_user("exec_user", hash_password("pass"), role="user")
    user = db.get_user_by_id(user_id)
    token = create_access_token(user)

    client = TestClient(app)
    with mock.patch('qdrant_client.QdrantClient') as q, mock.patch('services.media_locations.client.retrieve', return_value=[]):
        q.return_value.retrieve.return_value = []
        yield client, tid, audio_path, data, token, user
    client.close()


def test_four_lane_admission_and_fast_fifth_rejection():
    """Verify zero-queue 4-item work pool: 5th concurrent request fails fast with 503."""
    executor = DeliveryExecutor()
    gate = threading.Event()
    entered = threading.Barrier(5)

    def blocking_work(deadline, cancel):
        entered.wait(timeout=2.0)
        gate.wait(timeout=2.0)
        return "done"

    async def scenario():
        requests = [Request({'type': 'http', 'headers': []}) for _ in range(4)]
        tasks = [asyncio.create_task(executor.run(r, blocking_work)) for r in requests]

        # Wait until 4 workers enter the barrier
        await asyncio.to_thread(entered.wait, 2.0)

        # 5th request must be rejected immediately with 503
        r5 = Request({'type': 'http', 'headers': []})
        with pytest.raises(HTTPException) as exc_info:
            await executor.run(r5, lambda d, c: "should_not_run")

        assert exc_info.value.status_code == 503
        assert exc_info.value.headers.get('Retry-After') == '1'
        assert exc_info.value.detail.get('code') == 'delivery_busy'

        # Now unblock the 4 running tasks
        gate.set()
        results = await asyncio.gather(*tasks)
        assert results == ["done", "done", "done", "done"]

        # Now lanes are freed: 6th request can succeed
        r6 = Request({'type': 'http', 'headers': []})
        res6 = await executor.run(r6, lambda d, c: "free_again")
        assert res6 == "free_again"

        assert await executor.shutdown()

    asyncio.run(scenario())


def test_database_contention_deadline_budget(exec_env):
    """Under active exclusive DB lock, requests fail fast with 503 within 1s budget."""
    client, tid, audio_path, data, token, user = exec_env
    auth_header = {'Authorization': f'Bearer {token}'}

    conn = db.get_connection()
    conn.execute('BEGIN IMMEDIATE')
    try:
        start = time.monotonic()
        r = client.post('/api/media-ticket', json={'track_id': tid}, headers=auth_header)
        elapsed = time.monotonic() - start
        assert r.status_code == 503
        assert elapsed < 1.5
    finally:
        conn.rollback()
        conn.close()


def test_track_mutation_lock_contention(exec_env):
    """Holding a track lock causes concurrent stream attempts to fail busy within budget."""
    client, tid, audio_path, data, token, user = exec_env
    auth_header = {'Authorization': f'Bearer {token}'}

    entered = threading.Event()
    release = threading.Event()

    def hold_lock():
        with track_mutation_lock(tid, str(audio_path.parent)):
            entered.set()
            release.wait(timeout=3.0)

    t = threading.Thread(target=hold_lock)
    t.start()
    assert entered.wait(timeout=1.0)
    try:
        start = time.monotonic()
        r = client.get(f'/api/stream/{tid}', headers=auth_header)
        elapsed = time.monotonic() - start
        assert r.status_code == 503
        assert elapsed < 1.5
    finally:
        release.set()
        t.join(timeout=2.0)


def test_hash_supervisor_flock_mutual_exclusion(exec_env):
    """Only one HashSupervisor can hold the lock; second returns False on start()."""
    client, tid, audio_path, data, token, user = exec_env
    delivery.enqueue(tid)

    sup1 = HashSupervisor()
    sup2 = HashSupervisor()

    assert sup1.start() is True
    try:
        assert sup2.start() is False
    finally:
        assert sup1.shutdown() is True


def test_hash_supervisor_completes_real_job(exec_env):
    """HashSupervisor processes enqueued track in subprocess and marks version ready."""
    client, tid, audio_path, data, token, user = exec_env
    delivery.enqueue(tid)

    sup = HashSupervisor()
    assert sup.start() is True
    try:
        deadline = time.monotonic() + 10.0
        row = None
        while time.monotonic() < deadline:
            row = delivery.get_version(tid)
            if row and row['state'] == 'ready':
                break
            time.sleep(0.05)
        assert row is not None
        assert row['state'] == 'ready'
        assert row['content_version'] == hashlib.sha256(data).hexdigest()
    finally:
        assert sup.shutdown() is True


def test_hash_child_timeout_and_reap(exec_env, tmp_path):
    """Supervised child process exceeding budget is terminated, reaped, and lock retained."""
    owner = OwnerSupervisor('hash')
    lock_file = tmp_path / 'child_test.lock'
    owner.owner_fd = os.open(lock_file, os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(owner.owner_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

    start = time.monotonic()
    try:
        with pytest.raises(TimeoutError):
            owner.run_child(
                'timeit',
                ['-n', '1', '-r', '1', '-s', 'import time', 'time.sleep(30)'],
                budget=0.2,
                limit=512,
            )
        elapsed = time.monotonic() - start
        assert elapsed < 6.0
        assert owner.child is None
    finally:
        os.close(owner.owner_fd)


def test_child_retains_flock_via_inherited_fd(exec_env, tmp_path):
    """Child retains flock FD via pass_fds even if parent closes supervisor FD."""
    owner = OwnerSupervisor('hash')
    lock_file = tmp_path / 'pass_fds.lock'
    owner.owner_fd = os.open(lock_file, os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(owner.owner_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

    errors = []
    def spawn():
        try:
            owner.run_child(
                'timeit',
                ['-n', '1', '-r', '1', '-s', 'import time', 'time.sleep(30)'],
                budget=2.0,
                limit=512,
            )
        except TimeoutError:
            errors.append('timed_out')

    t = threading.Thread(target=spawn)
    t.start()

    # Wait for child to be spawned
    deadline = time.monotonic() + 1.0
    while owner.child is None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert owner.child is not None

    # Parent closes its copy of owner_fd
    os.close(owner.owner_fd)

    # Another process/handle trying to acquire lock must fail (flock still held by child!)
    other_fd = os.open(lock_file, os.O_RDWR)
    try:
        with pytest.raises(BlockingIOError):
            fcntl.flock(other_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    finally:
        owner.stop.set()
        t.join(timeout=6.0)
        os.close(other_fd)


def test_hash_late_fence_discards_result(exec_env):
    """If version state or fencing token was invalidated during hashing, result is discarded."""
    client, tid, audio_path, data, token, user = exec_env
    digest = hashlib.sha256(data).hexdigest()
    st = audio_path.stat()

    # Set version to ready then invalidate
    with delivery.transaction() as conn:
        conn.execute("""INSERT INTO delivery_versions(track_id,state,content_version,fingerprint,content_length)
            VALUES (?,'ready',?,?,?) ON CONFLICT(track_id) DO UPDATE SET state='ready'""",
            (tid, digest, "{}", st.st_size))

    delivery.invalidate(tid)
    assert delivery.get_version(tid)['state'] == 'pending'

    owner = HashSupervisor()
    def fake_run_child(*args, **kwargs):
        # Invalidate again while hashing was supposedly in progress
        delivery.invalidate(tid)
        return {'hash': digest, 'fingerprint': delivery.fingerprint(audio_path.stat())}

    with mock.patch.object(owner, 'run_child', side_effect=fake_run_child):
        owner.tick()

    # State must remain pending, not promoted to ready
    assert delivery.get_version(tid)['state'] == 'pending'
