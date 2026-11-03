import test_db_path  # noqa: F401

import hashlib
import multiprocessing
import os
import shutil
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from repositories import schema, albums, tracks
from repositories.artist_credits import artist_id_for_name, get_credit_states
from services import album_service
from services.artist_credit_service import set_album_artists
from services.artist_credit_bulk_service import preview_artist_replacement
from routers.albums import AlbumEditPayload
from metadata import read_audio_metadata

ADMIN = {'id': 1, 'role': 'admin'}


def _attempt(kind, album_id, revision, source_id, operation_id, started, finished, results):
    from fastapi import HTTPException
    from services.artist_credit_service import set_album_artists
    from services.artist_credit_bulk_service import apply_artist_replacement, undo_artist_replacement
    started.set()
    try:
        if kind == 'put':
            set_album_artists(album_id, [{'name': 'Conflicting'}], revision, ADMIN, '')
        elif kind == 'bulk':
            apply_artist_replacement(source_id, operation_id, ADMIN)
        else:
            undo_artist_replacement(source_id, operation_id, ADMIN)
        results.put((kind, 200, None))
    except HTTPException as exc:
        results.put((kind, exc.status_code, exc.detail.get('code')))
    except BaseException as exc:
        results.put((kind, 'exception', repr(exc)))
    finally:
        finished.set()


def _hold_lock(ready, release):
    from services.artist_credit_lock import artist_credit_mutation_lock
    with artist_credit_mutation_lock():
        ready.set()
        release.wait(10)


@pytest.fixture
def merge_library(tmp_path, monkeypatch):
    sample = Path(__file__).parent / 'temp_audio' / 'Daft Punk - Around the World.mp3'
    if not sample.exists():
        pytest.skip('sample MP3 unavailable')
    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'test.db'))
    monkeypatch.setenv('MUSIC_DIR', str(tmp_path))
    schema.init_db()
    path = tmp_path / 'source.mp3'
    shutil.copy2(sample, path)
    source = albums.resolve_album('Source', 'A')
    target = albums.resolve_album('Target', 'A')
    tracks.add_or_update_track('source-track', 'source.mp3', 'Song', source, 'A')
    state = get_credit_states('album', [source])[str(source)]
    set_album_artists(source, [{'name': 'A'}], state['revision'], ADMIN, '')
    return source, target, path


def test_process_put_and_bulk_cannot_enter_between_preflight_and_audio_write(merge_library, monkeypatch):
    source, target, audio = merge_library
    before_hash = hashlib.sha256(audio.read_bytes()).hexdigest()
    revision = get_credit_states('album', [target])[str(target)]['revision']
    artist_id = artist_id_for_name('A')
    preview = preview_artist_replacement(artist_id, 'albums', [{'name': 'Conflicting'}], ADMIN)
    passed_preflight, allow_file = threading.Event(), threading.Event()
    original = album_service.prepare_cover_bytes
    def pause_once(*args, **kwargs):
        if not passed_preflight.is_set():
            passed_preflight.set()
            assert allow_file.wait(10), 'test did not release album mutation'
        return original(*args, **kwargs)
    monkeypatch.setattr(album_service, 'prepare_cover_bytes', pause_once)
    result = {}
    def edit():
        try:
            result['value'] = album_service.update_album(source, AlbumEditPayload(title='Target'), ADMIN, '')
        except BaseException as exc:
            result['error'] = exc
    thread = threading.Thread(target=edit)
    thread.start()
    assert passed_preflight.wait(10)
    ctx = multiprocessing.get_context('spawn')
    results = ctx.Queue()
    starts = [ctx.Event(), ctx.Event()]
    finishes = [ctx.Event(), ctx.Event()]
    processes = [ctx.Process(target=_attempt, args=(kind, target, revision, artist_id, preview['operation_id'], starts[i], finishes[i], results))
                 for i, kind in enumerate(('put', 'bulk'))]
    try:
        for process in processes:
            process.start()
        assert all(event.wait(10) for event in starts)
        assert not any(event.wait(.3) for event in finishes), 'credit write entered while merge was paused'
        allow_file.set()
        thread.join(15)
        assert not thread.is_alive()
        assert 'error' not in result, repr(result.get('error'))
        assert result['value']['merged'] and result['value']['status'] == 'success'
        for process in processes:
            process.join(15)
            assert process.exitcode == 0
        outcomes = {kind: (status, code) for kind, status, code in (results.get(timeout=2) for _ in processes)}
        assert outcomes['put'] == (409, 'artists_revision_conflict')
        assert outcomes['bulk'] == (409, 'bulk_selection_changed')
        assert tracks.get_track('source-track')['album_id'] == target
        assert albums.get_album(source) is None
        assert [a['name'] for a in get_credit_states('album', [target])[str(target)]['artists']] == ['A']
        assert read_audio_metadata(str(audio)).album == 'Target'
        assert hashlib.sha256(audio.read_bytes()).hexdigest() != before_hash
    finally:
        allow_file.set()
        thread.join(15)
        for process in processes:
            if process.is_alive():
                process.terminate()
                process.join(5)


def test_cross_process_contention_is_bounded_and_db_only(merge_library, monkeypatch):
    from services import artist_credit_lock
    source, target, audio = merge_library
    before = (hashlib.sha256(audio.read_bytes()).hexdigest(), audio.stat().st_mtime_ns)
    revision = get_credit_states('album', [target])[str(target)]['revision']
    ctx = multiprocessing.get_context('spawn')
    ready, release = ctx.Event(), ctx.Event()
    process = ctx.Process(target=_hold_lock, args=(ready, release))
    process.start()
    try:
        assert ready.wait(10)
        monkeypatch.setattr(artist_credit_lock, '_LOCK_TIMEOUT', .25)
        started = time.monotonic()
        with pytest.raises(HTTPException) as exc:
            set_album_artists(target, [{'name': 'B'}], revision, ADMIN, '')
        assert exc.value.status_code == 503 and exc.value.detail['code'] == 'credits_busy'
        assert exc.value.headers['Retry-After'] == '1'
        assert .20 <= time.monotonic() - started < 2
        assert get_credit_states('album', [target])[str(target)]['revision'] == revision
    finally:
        release.set()
        process.join(10)
        if process.is_alive():
            process.terminate()
            process.join(5)
    assert process.exitcode == 0
    assert before == (hashlib.sha256(audio.read_bytes()).hexdigest(), audio.stat().st_mtime_ns)
    assert set_album_artists(target, [{'name': 'B'}], revision, ADMIN, '')['album']['artist'] == 'B'


def test_bulk_undo_waits_until_manual_merge_is_finished(merge_library, monkeypatch):
    from services.artist_credit_bulk_service import apply_artist_replacement
    source, target, audio = merge_library
    artist_id = artist_id_for_name('A')
    preview = preview_artist_replacement(artist_id, 'albums', [{'name': 'Shared'}], ADMIN)
    apply_artist_replacement(artist_id, preview['operation_id'], ADMIN)
    entered, release = threading.Event(), threading.Event()
    original = album_service.prepare_cover_bytes
    def pause(*args, **kwargs):
        if not entered.is_set():
            entered.set()
            assert release.wait(10)
        return original(*args, **kwargs)
    monkeypatch.setattr(album_service, 'prepare_cover_bytes', pause)
    outcome = {}
    def merge():
        try:
            outcome['result'] = album_service.update_album(source, AlbumEditPayload(title='Target'), ADMIN, '')
        except BaseException as exc:
            outcome['error'] = exc
    thread = threading.Thread(target=merge)
    thread.start()
    ctx = multiprocessing.get_context('spawn')
    started, finished, results = ctx.Event(), ctx.Event(), ctx.Queue()
    process = ctx.Process(target=_attempt, args=('undo', target, 0, artist_id, preview['operation_id'], started, finished, results))
    try:
        assert entered.wait(10)
        process.start()
        assert started.wait(10)
        assert not finished.wait(.3)
        release.set()
        thread.join(15)
        assert not thread.is_alive() and 'error' not in outcome, repr(outcome.get('error'))
        assert outcome['result']['merged']
        process.join(15)
        assert process.exitcode == 0
        assert results.get(timeout=2) == ('undo', 409, 'bulk_undo_conflict')
        assert [a['name'] for a in get_credit_states('album', [target])[str(target)]['artists']] == ['Shared']
        assert read_audio_metadata(str(audio)).album == 'Target'
    finally:
        release.set()
        thread.join(15)
        if process.is_alive():
            process.terminate()
            process.join(5)


def test_lock_artifact_outside_music_directory(merge_library):
    from services.artist_credit_lock import _lock_path
    db_path = os.path.realpath(os.environ['PUUK_DB_PATH'])
    music_dir = os.path.realpath(os.environ['MUSIC_DIR'])
    assert os.path.commonpath((_lock_path(db_path), music_dir)) != music_dir


def test_legacy_album_credit_edit_is_reentrant_and_requires_no_audio(merge_library):
    from repositories.base import get_connection
    source, _, audio = merge_library
    # Remove the previous multi/single decision by making a distinct empty release.
    empty_source = albums.resolve_album('Offline', 'Original')
    tracks.add_or_update_track('missing-track', '/missing/audio.mp3', 'Offline', empty_source, 'A')
    before = (hashlib.sha256(audio.read_bytes()).hexdigest(), audio.stat().st_size, audio.stat().st_mtime_ns)
    result = album_service.update_album(empty_source, AlbumEditPayload(album_artist='New'), ADMIN, '')
    assert result['album']['artist'] == 'New' and result['changed']
    assert before == (hashlib.sha256(audio.read_bytes()).hexdigest(), audio.stat().st_size, audio.stat().st_mtime_ns)


def test_different_database_is_not_blocked(merge_library, tmp_path, monkeypatch):
    ctx = multiprocessing.get_context('spawn')
    ready, release = ctx.Event(), ctx.Event()
    process = ctx.Process(target=_hold_lock, args=(ready, release))
    process.start()
    try:
        assert ready.wait(10)
        monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'other.db'))
        schema.init_db()
        target = albums.resolve_album('Other', 'A')
        revision = get_credit_states('album', [target])[str(target)]['revision']
        started = time.monotonic()
        result = set_album_artists(target, [{'name': 'B'}], revision, ADMIN, '')
        assert result['album']['artist'] == 'B'
        assert time.monotonic() - started < 2
    finally:
        release.set()
        process.join(10)
        if process.is_alive():
            process.terminate()
            process.join(5)
    assert process.exitcode == 0


def test_existing_conflict_precedes_cover_file_reads_and_writes(merge_library):
    source, target, audio = merge_library
    revision = get_credit_states('album', [target])[str(target)]['revision']
    set_album_artists(target, [{'name': 'Different'}], revision, ADMIN, '')
    before = (hashlib.sha256(audio.read_bytes()).hexdigest(), audio.stat().st_size, audio.stat().st_mtime_ns)
    with patch('services.album_service.prepare_cover_bytes', side_effect=AssertionError('cover fetched')), \
         patch('services.album_service.mutate_track_metadata', side_effect=AssertionError('audio mutation')), \
         patch('services.track_metadata_service.read_audio_metadata', side_effect=AssertionError('audio read')), \
         patch('services.track_metadata_service.resolve_track_file_path', side_effect=AssertionError('audio resolution')):
        with pytest.raises(HTTPException) as error:
            album_service.update_album(source, AlbumEditPayload(title='Target', cover_action='replace', cover_url='https://example.com/cover'), ADMIN, '')
    assert error.value.status_code == 409 and error.value.detail['code'] == 'album_credits_conflict'
    assert before == (hashlib.sha256(audio.read_bytes()).hexdigest(), audio.stat().st_size, audio.stat().st_mtime_ns)


def test_contended_guard_precedes_all_sql_connections(merge_library, monkeypatch):
    from services import artist_credit_lock, artist_credit_service, artist_credit_bulk_service
    source, target, _ = merge_library
    ctx = multiprocessing.get_context('spawn')
    ready, release = ctx.Event(), ctx.Event()
    process = ctx.Process(target=_hold_lock, args=(ready, release))
    process.start()
    try:
        assert ready.wait(10)
        monkeypatch.setattr(artist_credit_lock, '_LOCK_TIMEOUT', .08)
        operations = [
            (artist_credit_service, 'get_connection', lambda: set_album_artists(target, [], 1, ADMIN, '')),
            (artist_credit_bulk_service, 'get_connection', lambda: artist_credit_bulk_service.apply_artist_replacement('id', 'operation', ADMIN)),
            (album_service.db, 'get_connection', lambda: album_service.update_album(source, AlbumEditPayload(title='Target'), ADMIN, '')),
        ]
        for module, name, operation in operations:
            with patch.object(module, name, side_effect=AssertionError('SQLite opened before lock')) as connection:
                with pytest.raises(HTTPException) as error:
                    operation()
                assert error.value.status_code == 503
                assert error.value.detail['code'] == 'credits_busy' and error.value.headers['Retry-After'] == '1'
                connection.assert_not_called()
    finally:
        release.set()
        process.join(10)
        if process.is_alive():
            process.terminate()
            process.join(5)
    assert process.exitcode == 0


def test_offline_album_credit_put_does_not_need_file(merge_library):
    offline = albums.resolve_album('Offline PUT', 'Original')
    tracks.add_or_update_track('missing-put', '/missing/no.mp3', 'Offline', offline, 'A')
    revision = get_credit_states('album', [offline])[str(offline)]['revision']
    with patch('services.track_metadata_service.resolve_track_file_path', side_effect=AssertionError('audio resolution')):
        result = set_album_artists(offline, [{'name': 'New'}], revision, ADMIN, '')
    assert result['album']['artist'] == 'New' and result['tracks'][0]['id'] == 'missing-put'
