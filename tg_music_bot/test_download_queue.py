import sqlite3
import pytest
from download_queue import DownloadQueue


def test_recovery_exclusive_owner_and_retry_bound(tmp_path):
    path = tmp_path / 'queue.db'
    q = DownloadQueue(path)
    q.start_worker()
    job_id = q.enqueue(1, 10, 20, 'url')
    assert q.enqueue(1, 10, 21, 'url') == job_id
    first = q.claim()
    assert first['attempts'] == 1
    other = DownloadQueue(path)
    with pytest.raises(RuntimeError):
        other.start_worker()
    assert q.claim() is None
    q.close()  # simulate interrupted import
    other.start_worker()
    second = other.claim()
    assert second['id'] == job_id and second['attempts'] == 2
    other.finish(second, error=TimeoutError(), transient=True)
    assert other.claim() is None  # backoff
    with other.connect() as c:
        c.execute('UPDATE downloads SET run_after=0')
    third = other.claim()
    other.finish(third, error=TimeoutError(), transient=True)
    assert other.list_user(1)[0]['status'] == 'failed'
    assert other.claim() is None
    assert not other.retry(job_id, 2)
    assert other.retry(job_id, 1)
    assert other.claim()['attempts'] == 1
    other.close()


def test_partial_retry_and_success(tmp_path):
    q = DownloadQueue(tmp_path / 'q.db'); q.start_worker()
    n = q.enqueue(1, 2, 3, 'url')
    q.finish(q.claim(), result={'failed_tracks': 1, 'failures': [{'title': 'a'}]})
    assert q.list_user(1)[0]['status'] == 'partial'
    assert q.retry(n, 1)
    q.finish(q.claim(), result={'failed_tracks': 0})
    assert q.list_user(1)[0]['status'] == 'done'
    assert not q.retry(n, 1)
    q.close()


def test_capacity(tmp_path):
    q = DownloadQueue(tmp_path / 'q.db')
    for i in range(100):
        q.enqueue(1, 2, 3, str(i))
    with pytest.raises(ValueError):
        q.enqueue(1, 2, 3, 'overflow')
