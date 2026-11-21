import json

from import_jobs import ImportJobs


def submit(jobs, message, request, *, user=123, owner=1, mode='server'):
    job_id, outcome = jobs.submit(user, owner, user, message, request, mode)
    if outcome == 'created':
        jobs.set_message(job_id, message + 1000)
    return job_id, outcome


def ready(jobs, row):
    assert jobs.downloaded(row['job_id'], row['position'], {'path': '/fixture.flac', 'sha256': 'fixture'})


def complete(jobs, row):
    ready(jobs, row)
    jobs.delivered(row['job_id'], row['position'])


def test_playlist_recovery_retains_positions_and_gives_single_track_priority(tmp_path):
    path = tmp_path / 'queue.sqlite'
    jobs = ImportJobs(path)
    jobs.start_worker()
    request = {'url': 'https://vk.com/music/playlist/1_2'}
    playlist, _ = submit(jobs, 1, request)
    assert jobs.claim_snapshot()['id'] == playlist
    sources = [{'type': 'vk', 'provider_id': 'a' if n in {3, 12} else str(n), 'title': str(n)}
               for n in range(1, 301)]
    jobs.snapshot(playlist, 'Playlist', 'playlist', sources, playlist_id=42)
    for n in range(1, 81):
        item = jobs.claim_position()
        assert item['position'] == n
        complete(jobs, item)
    assert jobs.claim_position()['position'] == 81
    assert jobs.control(playlist, 123, 1, 'pause')
    jobs.close()

    jobs = ImportJobs(path)
    jobs.start_worker()
    assert jobs.job(playlist)['state'] == 'paused'
    assert jobs.claim_position() is None
    assert submit(jobs, 1, request) == (playlist, 'duplicate')
    assert jobs.control(playlist, 456, 2, 'resume') is False
    assert submit(jobs, 2, request) == (playlist, 'resumed')
    assert submit(jobs, 2, request) == (playlist, 'duplicate')
    row = jobs.claim_position()
    assert row['position'] == 81
    single, _ = submit(jobs, 3, {'url': 'single'}, mode='chat')
    assert jobs.claim_snapshot()['id'] == single
    jobs.snapshot(single, 'Single', 'track', [{'type': 'direct', 'title': 'Single'}])
    complete(jobs, row)
    row = jobs.claim_position()
    assert row['job_id'] == single
    complete(jobs, row)
    jobs.settle(single)

    for n in range(82, 301):
        item = jobs.claim_position()
        assert item['position'] == n
        complete(jobs, item)
    jobs.settle(playlist)
    assert jobs.job(playlist)['playlist_id'] == 42
    assert jobs.job(playlist)['status_message'] == 1001
    assert not jobs.outstanding(123, 1)
    completed = jobs.positions(playlist)
    assert len(completed) == 300 and all(row['sha256'] == 'fixture' for row in completed)
    assert all(json.loads(completed[n - 1]['source'])['provider_id'] == 'a' for n in (3, 12))
    jobs.close()


def test_chat_delivers_ready_positions_in_order_then_delivers_late_repair(tmp_path, monkeypatch):
    import import_jobs

    now = 1000
    monkeypatch.setattr(import_jobs.time, 'time', lambda: now)
    jobs = ImportJobs(tmp_path / 'queue.sqlite')
    jobs.start_worker()
    album, _ = submit(jobs, 1, {'url': 'album'}, mode='chat')
    jobs.claim_snapshot()
    jobs.snapshot(album, 'Album', 'album', [{'title': str(n)} for n in range(1, 4)])
    first, second, third = (jobs.claim_position() for _ in range(3))
    ready(jobs, third)
    assert jobs.deliverable(album, 'chat') is None
    ready(jobs, first)
    assert jobs.deliverable(album, 'chat')['position'] == 1
    jobs.delivered(album, 1)
    jobs.skip(album, 2, 'Temporary source failure', temporary=True)
    assert jobs.deliverable(album, 'chat')['position'] == 3
    jobs.delivered(album, 3)
    jobs.settle(album)
    assert jobs.job(album)['state'] == 'finished'
    assert not jobs.control(album, 123, 1, 'retry', 0)
    now += 86401
    assert jobs.expire_retries() == {album}
    assert jobs.control(album, 123, 1, 'retry', 0)
    assert not jobs.control(album, 123, 1, 'retry', 2)
    restored = jobs.claim_position()
    assert restored['position'] == 2
    ready(jobs, restored)
    assert jobs.deliverable(album, 'chat')['position'] == 2
    jobs.delivered(album, 2)
    assert not jobs.outstanding(123, 1)
    jobs.close()


def test_cancel_rejects_late_artifact_and_survives_restart(tmp_path):
    path = tmp_path / 'queue.sqlite'
    jobs = ImportJobs(path)
    jobs.start_worker()
    job, _ = submit(jobs, 1, {'url': 'album'})
    jobs.claim_snapshot()
    jobs.snapshot(job, 'Playlist', 'playlist', [{'title': 'One'}], playlist_id=42)
    item = jobs.claim_position()
    assert jobs.control(job, 123, 1, 'pause')
    assert jobs.control(job, 123, 1, 'cancel')
    assert not jobs.downloaded(item['job_id'], item['position'], {'path': '/fixture', 'sha256': 'fixture'})
    jobs.close()
    jobs = ImportJobs(path)
    jobs.start_worker()
    assert jobs.job(job)['state'] == 'cancelled'
    assert not jobs.claim_position()
    jobs.close()
