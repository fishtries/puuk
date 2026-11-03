import test_db_path  # noqa: F401

import hashlib
import wave
import pytest
from unittest.mock import patch
from fastapi import HTTPException
from repositories import schema, tracks, albums, artists
from repositories.artist_credits import get_credit_states
from repositories.base import get_catalog_version
from services.artist_credit_service import set_track_artists, set_album_artists
from services.track_metadata_service import mutate_track_metadata
from routers.tracks import TrackEditPayload


@pytest.fixture
def library(tmp_path, monkeypatch):
    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'library.db'))
    schema.init_db()
    audio = tmp_path / 'audio.wav'
    with wave.open(str(audio), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(8000)
        output.writeframes(b'\x00\x00' * 80)
    album = albums.resolve_album('Release', 'A')
    tracks.add_or_update_track('t', str(audio), 'Song', album, 'A')
    return audio, album


def test_db_only_credits_and_catalog(library):
    audio, album = library
    before = (hashlib.sha256(audio.read_bytes()).hexdigest(), audio.stat().st_size, audio.stat().st_mtime_ns)
    admin = {'id': 1, 'role': 'admin'}
    rev = get_credit_states('track', ['t'])['t']['revision']
    version = get_catalog_version()
    with patch('services.track_metadata_service.resolve_track_file_path', side_effect=AssertionError('file access')):
        result = set_track_artists('t', [{'name': 'A'}, {'name': 'B'}], rev, admin, 'http://test')
        assert result['artist'] == 'A, B' and result['artist_id'] is None
        assert [a['name'] for a in result['artists']] == ['A', 'B']
        assert get_catalog_version() == version + 1
        set_track_artists('t', [{'name': 'A'}, {'name': 'B'}], rev, admin, 'http://test')
        assert get_catalog_version() == version + 1
        with pytest.raises(HTTPException) as conflict:
            set_track_artists('t', [{'name': 'C'}], rev, admin, 'http://test')
        assert conflict.value.status_code == 409
        ar = get_credit_states('album', [album])[str(album)]['revision']
        set_album_artists(album, [{'name': 'A'}], ar, admin, 'http://test')
        detail = artists.get_artist_detail(artists.artist_id_for_name('B'), 'http://test')
        assert len(detail['popular_tracks']) == 1 and detail['albums'] == []
    assert before == (hashlib.sha256(audio.read_bytes()).hexdigest(), audio.stat().st_size, audio.stat().st_mtime_ns)


def test_legacy_multi_conflict_precedes_file_access(library):
    admin = {'id': 1, 'role': 'admin'}
    rev = get_credit_states('track', ['t'])['t']['revision']
    set_track_artists('t', [{'name': 'A'}, {'name': 'B'}], rev, admin, '')
    with patch('services.track_metadata_service.resolve_track_file_path', side_effect=AssertionError('file access')):
        with pytest.raises(HTTPException) as error:
            mutate_track_metadata('t', TrackEditPayload(artist='C', title='changed'), admin)
        assert error.value.detail['code'] == 'structured_artists_required'


def test_full_web_payload_echo_is_noop_and_mixed_change_rejected(library):
    admin = {'id': 1, 'role': 'admin'}
    original = library[0].stat().st_mtime_ns
    web = dict(title='Song', artist='A', album='Release', album_artist='A', year=None,
               genre=None, track_number=None, disc_number=None, comment=None,
               lyrics='', cover_action='keep', cover_base64=None, cover_mime=None)
    with patch('services.track_metadata_service.resolve_track_file_path', side_effect=AssertionError('file access')):
        dto = mutate_track_metadata('t', TrackEditPayload(**web), admin)
        assert dto['artist'] == 'A'
        web.update(artist='New', title='Changed')
        with pytest.raises(HTTPException) as error:
            mutate_track_metadata('t', TrackEditPayload(**web), admin)
        assert error.value.detail['code'] == 'artists_edit_separately'
    assert library[0].stat().st_mtime_ns == original


def test_partial_album_split_keeps_manual_credits(library):
    from services.album_service import update_album
    from routers.albums import AlbumEditPayload
    from repositories.tracks import get_track
    admin = {'id': 1, 'role': 'admin'}
    album = library[1]
    tracks.add_or_update_track('t2', '/missing/audio.wav', 'Song 2', album, 'A')
    from repositories.artist_credits import CreditSource, ingest_artist_credits
    from repositories.base import get_connection
    with get_connection() as conn:
        ingest_artist_credits(conn, 'album', album, CreditSource('provider', ['Provider']))
    revision = get_credit_states('album', [album])[str(album)]['revision']
    set_album_artists(album, [{'name': 'A'}, {'name': 'B'}], revision, admin, '')
    def mutate(track_id, *args, **kwargs):
        if track_id == 't2':
            raise OSError('simulated file failure')
    with patch('services.album_service.mutate_track_metadata', side_effect=mutate):
        result = update_album(album, AlbumEditPayload(title='New Release'), admin, '')
    assert result['status'] == 'partial'
    new_album = get_track('t')['album_id']
    assert new_album != album and get_track('t2')['album_id'] == album
    states = get_credit_states('album', [album, new_album])
    assert all(states[str(i)]['manual'] and [a['name'] for a in states[str(i)]['artists']] == ['A', 'B'] for i in (album, new_album))
    assert states[str(new_album)]['source_kind'] == 'provider'
    assert states[str(new_album)]['source_names'] == ['Provider']


def test_http_credits_rbac_validation_etag_and_album_membership(library):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from auth import get_current_user, get_current_admin_user
    from routers import tracks as track_router, albums as album_router, artists as artist_router, search as search_router
    from repositories.base import get_connection
    app = FastAPI()
    for router in (track_router.router, album_router.router, artist_router.router, search_router.router):
        app.include_router(router)
    current = {'id': 1, 'role': 'admin'}
    app.dependency_overrides[get_current_user] = lambda: current
    app.dependency_overrides[get_current_admin_user] = lambda: current
    client = TestClient(app)
    before = client.get('/api/tracks').headers['etag']
    rev = get_credit_states('track', ['t'])['t']['revision']
    body = {'artists': [{'name': 'A'}, {'name': 'B'}], 'expected_revision': rev}
    assert client.put('/api/tracks/t/artists', json={**body, 'title': 'x'}).status_code == 422
    assert client.put('/api/tracks/t/artists', json={**body, 'expected_revision': True}).status_code == 422
    assert client.put('/api/tracks/t/artists', json={'artists': [{'name': 'B', 'id': 'x'}], 'expected_revision': rev}).status_code == 422
    response = client.put('/api/tracks/t/artists', json=body)
    assert response.status_code == 200, response.text
    assert response.json()['artist'] == 'A, B'
    assert client.get('/api/tracks', headers={'If-None-Match': before}).status_code == 200
    after = client.get('/api/tracks').headers['etag']
    assert client.put('/api/tracks/t/artists', json=body).status_code == 200
    assert client.get('/api/tracks').headers['etag'] == after
    conflict = client.put('/api/tracks/t/artists', json={'artists': [{'name': 'C'}], 'expected_revision': rev})
    assert conflict.status_code == 409 and conflict.json()['detail']['code'] == 'artists_revision_conflict'
    result = client.get('/api/search', params={'q': 'B'}).json()
    assert len(result['tracks']) == 1 and result['albums'] == []
    artist_b = artists.artist_id_for_name('B')
    profile = client.get('/api/artists/' + artist_b).json()
    assert len(profile['popular_tracks']) == 1 and profile['albums'] == []
    album_revision = get_credit_states('album', [library[1]])[str(library[1])]['revision']
    album_result = client.put(f'/api/albums/{library[1]}/artists', json={'artists': [{'name': 'A'}, {'name': 'B'}], 'expected_revision': album_revision})
    assert album_result.status_code == 200 and len(album_result.json()['tracks']) == 1
    assert len(client.get('/api/artists/' + artist_b).json()['albums']) == 1
    current.update(id=2, role='user')
    assert client.put('/api/tracks/t/artists', json=body).status_code == 403
    assert client.put(f'/api/albums/{library[1]}/artists', json={'artists': [], 'expected_revision': album_revision}).status_code == 403
    missing = client.put('/api/tracks/no-such-track/artists', json=body)
    assert missing.status_code == 404 and missing.json()['detail']['code'] == 'entity_not_found'


def test_real_old_web_payloads_keep_artists_out_of_audio_patches(tmp_path, monkeypatch):
    import base64
    import io
    import shutil
    from pathlib import Path
    from PIL import Image
    from metadata import read_audio_metadata
    from repositories import tracks as track_repo
    from services import track_metadata_service as metadata_service
    from services.album_service import update_album
    from routers.albums import AlbumEditPayload
    sample = Path(__file__).parent / 'temp_audio' / 'Daft Punk - Around the World.mp3'
    if not sample.exists():
        pytest.skip('sample mp3 unavailable')
    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'real.db'))
    monkeypatch.setenv('MUSIC_DIR', str(tmp_path))
    schema.init_db()
    audio = tmp_path / 'sample.mp3'
    shutil.copy2(sample, audio)
    meta = read_audio_metadata(str(audio))
    album = albums.resolve_album(meta.album or 'Release', meta.album_artist)
    track_repo.add_or_update_track('web', 'sample.mp3', meta.title, album, meta.artist,
        lyrics=meta.lyrics, genre=meta.genre, track_number=meta.track_number, disc_number=meta.disc_number,
        file_size=meta.file_size, file_mtime_ns=meta.file_mtime_ns)
    track_repo.update_track_metadata_from_audio('web', meta, album_id=album)
    admin = {'id': 1, 'role': 'admin'}
    track_rev = get_credit_states('track', ['web'])['web']['revision']
    album_rev = get_credit_states('album', [album])[str(album)]['revision']
    initial = (hashlib.sha256(audio.read_bytes()).hexdigest(), audio.stat().st_size, audio.stat().st_mtime_ns)
    set_track_artists('web', [{'name':'A'}, {'name':'B'}], track_rev, admin, '')
    set_album_artists(album, [{'name':'Album A'}, {'name':'Album B'}], album_rev, admin, '')
    editor = metadata_service.get_track_metadata_details('web', admin, '')
    assert editor['artist'] == 'A, B' and editor['album_artist'] == 'Album A, Album B'
    # Force editor reconciliation from disk; manual empty is authoritative and independent of album credits.
    cleared = set_track_artists('web', [], editor['artists_revision'], admin, '')
    from repositories.base import get_connection
    with get_connection() as conn:
        conn.execute("UPDATE tracks SET file_mtime_ns=0 WHERE id='web'")
    editor = metadata_service.get_track_metadata_details('web', admin, '')
    assert editor['artists'] == [] and editor['album_id'] == album
    assert editor['album_artist'] == 'Album A, Album B'
    assert metadata_service.resync_track_from_disk('web', admin, '')['track']['artists'] == []
    from repositories.tracks import log_mutation_journal, get_uncommitted_mutations
    log_mutation_journal('web', 'replaced')
    metadata_service.reconcile_uncommitted_mutations()
    assert not get_uncommitted_mutations()
    assert get_credit_states('track', ['web'])['web']['artists'] == []
    assert get_credit_states('album', [album])[str(album)]['artists'][0]['name'] == 'Album A'
    editor = set_track_artists('web', [{'name':'A'}, {'name':'B'}], editor['artists_revision'], admin, '')
    assert initial == (hashlib.sha256(audio.read_bytes()).hexdigest(), audio.stat().st_size, audio.stat().st_mtime_ns)
    png = io.BytesIO()
    Image.new('RGB', (8, 8), 'blue').save(png, format='PNG')
    encoded = base64.b64encode(png.getvalue()).decode()
    row = track_repo.get_track('web')
    web = dict(title='Web changed title', artist='A, B', album=meta.album, album_artist='Album A, Album B',
               year=row.get('year'), genre=row.get('genre'), track_number=row.get('track_number'),
               disc_number=row.get('disc_number'), comment=row.get('comment'), lyrics=row.get('lyrics') or '',
               cover_action='replace', cover_base64=encoded, cover_mime='image/png')
    original_write = metadata_service.safe_replace_audio_file
    patches = []
    def spy(path, payload):
        patches.append(set(payload.fields_set))
        return original_write(path, payload)
    monkeypatch.setattr(metadata_service, 'safe_replace_audio_file', spy)
    result = metadata_service.mutate_track_metadata('web', TrackEditPayload(**web), admin)
    assert result['artist'] == 'A, B' and result['album_artist'] == 'Album A, Album B'
    assert all(not {'artist', 'album_artist'} & fields for fields in patches)
    after = read_audio_metadata(str(audio))
    assert after.artist == meta.artist and after.album_artist == meta.album_artist
    album_web = AlbumEditPayload(title='Web changed album', album_artist='Album A, Album B',
                                 year=albums.get_album(album)['year'], cover_action='replace', cover_base64=encoded)
    updated = update_album(album, album_web, admin, '')
    assert updated['album']['album_artist'] == 'Album A, Album B'
    assert all(not {'artist', 'album_artist'} & fields for fields in patches)
    after = read_audio_metadata(str(audio))
    assert after.artist == meta.artist and after.album_artist == meta.album_artist
    assert [a['name'] for a in get_credit_states('album', [album])[str(album)]['artists']] == ['Album A', 'Album B']


def test_busy_error_is_503_and_has_retry_after(library, monkeypatch):
    import sqlite3
    from services import artist_credit_service
    def busy():
        raise sqlite3.OperationalError('database is locked')
    monkeypatch.setattr(artist_credit_service, 'get_connection', busy)
    with pytest.raises(HTTPException) as error:
        set_track_artists('t', [], 1, {'id': 1, 'role': 'admin'}, '')
    assert error.value.status_code == 503
    assert error.value.detail['code'] == 'credits_busy' and error.value.headers['Retry-After'] == '1'


def test_album_merge_conflict_rejects_before_cover_and_file(library):
    from routers.albums import AlbumEditPayload
    from services.album_service import update_album
    admin = {'id': 1, 'role': 'admin'}
    source = library[1]
    target = albums.resolve_album('Target', 'A')
    tracks.add_or_update_track('other', '/missing/other.wav', 'Other', target, 'A')
    for album, name in [(source, 'First'), (target, 'Second')]:
        revision = get_credit_states('album', [album])[str(album)]['revision']
        set_album_artists(album, [{'name': name}], revision, admin, '')
    before = (hashlib.sha256(library[0].read_bytes()).hexdigest(), library[0].stat().st_mtime_ns)
    with patch('services.album_service.prepare_cover_bytes', side_effect=AssertionError('cover fetch')), \
         patch('services.album_service.mutate_track_metadata', side_effect=AssertionError('file write')):
        with pytest.raises(HTTPException) as error:
            update_album(source, AlbumEditPayload(title='Target', cover_action='replace', cover_url='https://example.com/cover'), admin, '')
    assert error.value.status_code == 409 and error.value.detail['code'] == 'album_credits_conflict'
    assert before == (hashlib.sha256(library[0].read_bytes()).hexdigest(), library[0].stat().st_mtime_ns)


def test_recovery_album_is_read_only_after_track_disappears(library):
    from repositories.artist_credits import get_recovery_album
    from repositories.base import get_connection, get_catalog_version
    album = library[1]
    with get_connection() as conn:
        conn.execute("DELETE FROM tracks WHERE id='t'")
    version = get_catalog_version()
    recovered = get_recovery_album('t')
    assert recovered['id'] == album and recovered['album_artist'] == 'A'
    with get_connection() as conn:
        assert get_recovery_album('t', conn=conn)['id'] == album
        assert conn.execute("SELECT count(*) FROM tracks WHERE id='t'").fetchone()[0] == 0
    assert get_recovery_album('missing') is None and get_catalog_version() == version


def test_bulk_http_admin_and_conflicts(library):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from auth import get_current_user
    from routers.artists import router
    app = FastAPI()
    app.include_router(router)
    current = {'id': 1, 'role': 'admin'}
    app.dependency_overrides[get_current_user] = lambda: current
    client = TestClient(app)
    source = artists.artist_id_for_name('A')
    preview = client.post(f'/api/artists/{source}/credits/preview', json={'scope':'tracks', 'artists':[{'name':'B'}]})
    assert preview.status_code == 200, preview.text
    operation = preview.json()['operation_id']
    current.update(id=2, role='user')
    assert client.post(f'/api/artists/{source}/credits/apply', json={'operation_id': operation}).status_code == 403
    current.update(id=1, role='admin')
    wrong = client.post(f'/api/artists/{artists.artist_id_for_name("Other")}/credits/apply', json={'operation_id': operation})
    assert wrong.status_code == 409 and wrong.json()['detail']['code'] == 'operation_source_mismatch'
    applied = client.post(f'/api/artists/{source}/credits/apply', json={'operation_id': operation})
    assert applied.status_code == 200, applied.text
    assert client.post(f'/api/artists/{source}/credits/undo', json={'operation_id': operation}).status_code == 200
    assert client.post(f'/api/artists/{source}/credits/preview', json={'scope':'all', 'artists':[]}).status_code == 422


def test_album_only_artist_and_empty_album_visibility(library):
    admin = {'id': 1, 'role': 'admin'}
    album = library[1]
    revision = get_credit_states('album', [album])[str(album)]['revision']
    set_album_artists(album, [{'name': 'Album only'}], revision, admin, '')
    profile = artists.get_artist_detail(artists.artist_id_for_name('Album only'), '')
    assert profile['artist']['track_count'] == 0
    assert profile['artist']['album_count'] == 1 and profile['albums'][0]['track_count'] == 1
    empty = albums.resolve_album('Empty', 'Invisible')
    assert not artists.find_artist_by_id(artists.artist_id_for_name('Invisible'))
    revision = get_credit_states('album', [empty])[str(empty)]['revision']
    with pytest.raises(HTTPException) as error:
        set_album_artists(empty, [], revision, {'id': 1, 'role': 'user'}, '')
    assert error.value.status_code == 403
    assert set_album_artists(empty, [], revision, admin, '')['tracks'] == []


def test_popularity_follows_current_memberships_and_deduplicates_events(library):
    admin = {'id': 1, 'role': 'admin'}
    rev = get_credit_states('track', ['t'])['t']['revision']
    edited = set_track_artists('t', [{'name': 'A'}, {'name': 'B'}], rev, admin, '')
    assert artists.record_play_start(1, 't') == 'recorded'
    assert artists.record_play_start(1, 't') == 'duplicate'
    for name in ['A', 'B']:
        detail = artists.get_artist_detail(artists.artist_id_for_name(name), '')
        assert detail['popular_tracks'][0]['play_count'] == 1
    set_track_artists('t', [], edited['artists_revision'], admin, '')
    assert artists.record_play_start(1, 't') == 'ignored'
    assert artists.get_artist_detail(artists.artist_id_for_name('B'), '') is None


def test_concurrent_revision_rejects_lost_update(library):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    admin = {'id': 1, 'role': 'admin'}
    rev = get_credit_states('track', ['t'])['t']['revision']
    barrier = Barrier(2)
    def change(name):
        barrier.wait()
        try:
            return set_track_artists('t', [{'name': name}], rev, admin, '')['artist']
        except HTTPException as exc:
            return exc.status_code
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(change, ['X', 'Y']))
    assert results.count(409) == 1 and sum(value in ('X', 'Y') for value in results) == 1
    assert get_credit_states('track', ['t'])['t']['revision'] == rev + 1


def test_album_permission_requires_every_track_and_system_admin(library):
    from repositories.base import get_connection
    admin = {'id': 1, 'role': 'admin'}
    owner = {'id': 1, 'role': 'user'}
    foreign = {'id': 2, 'role': 'user'}
    album = library[1]
    revision = get_credit_states('album', [album])[str(album)]['revision']
    assert set_album_artists(album, [{'name': 'Owner'}], revision, owner, '')['album']['artist'] == 'Owner'
    tracks.add_or_update_track('system', '/missing/system', 'System', album, 'A', added_by_user_id=None)
    revision = get_credit_states('album', [album])[str(album)]['revision']
    for user in (owner, foreign):
        with pytest.raises(HTTPException) as exc:
            set_album_artists(album, [], revision, user, '')
        assert exc.value.status_code == 403
        with pytest.raises(HTTPException) as exc:
            set_track_artists('system', [], get_credit_states('track', ['system'])['system']['revision'], user, '')
        assert exc.value.status_code == 403
    assert set_album_artists(album, [], revision, admin, '')['album']['artists'] == []


def test_legacy_missing_file_only_credit_edit(library):
    from repositories.base import get_connection
    admin = {'id': 1, 'role': 'admin'}
    with get_connection() as conn:
        conn.execute("UPDATE tracks SET file_path='/missing/none.mp3' WHERE id='t'")
    with patch('services.track_metadata_service.resolve_track_file_path', side_effect=AssertionError('file access')):
        dto = mutate_track_metadata('t', TrackEditPayload(artist='Solo'), admin)
    assert dto['artist'] == 'Solo'


def test_partial_merge_preserves_source_manual_in_both_albums(library):
    from services.album_service import update_album
    from routers.albums import AlbumEditPayload
    admin = {'id': 1, 'role': 'admin'}
    source = library[1]
    target = albums.resolve_album('Destination', 'A')
    tracks.add_or_update_track('other', '/missing/other', 'Other', source, 'A')
    tracks.add_or_update_track('existing', '/missing/existing', 'Existing', target, 'A')
    revision = get_credit_states('album', [source])[str(source)]['revision']
    set_album_artists(source, [{'name': 'Manual'}], revision, admin, '')
    def mutate(track_id, *args, **kwargs):
        if track_id == 'other':
            raise OSError('simulated file error')
    with patch('services.album_service.mutate_track_metadata', side_effect=mutate):
        result = update_album(source, AlbumEditPayload(title='Destination'), admin, '')
    assert result['status'] == 'partial'
    states = get_credit_states('album', [source, target])
    assert all(states[str(i)]['manual'] and states[str(i)]['artists'][0]['name'] == 'Manual' for i in (source, target))
    assert tracks.get_track('t')['album_id'] == target and tracks.get_track('other')['album_id'] == source


def test_unauthenticated_credit_endpoints_and_http_busy(library, monkeypatch):
    import sqlite3
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from auth import get_current_user
    from routers import tracks as track_router, artists as artist_router
    from services import artist_credit_service
    app = FastAPI()
    app.include_router(track_router.router)
    app.include_router(artist_router.router)
    client = TestClient(app)
    payload = {'artists': [], 'expected_revision': 1}
    assert client.put('/api/tracks/t/artists', json=payload).status_code == 401
    assert client.post(f'/api/artists/{artists.artist_id_for_name("A")}/credits/preview', json={'scope':'tracks', 'artists':[]}).status_code == 401
    app.dependency_overrides[get_current_user] = lambda: {'id': 1, 'role': 'admin'}
    def busy():
        raise sqlite3.OperationalError('database is locked')
    monkeypatch.setattr(artist_credit_service, 'get_connection', busy)
    response = client.put('/api/tracks/t/artists', json=payload)
    assert response.status_code == 503 and response.headers['Retry-After'] == '1'
    assert response.json()['detail']['code'] == 'credits_busy'


def test_real_sqlite_busy_rolls_back_and_returns_retry_after(library):
    from repositories.base import get_connection, get_catalog_version
    import time
    lock = get_connection()
    lock.execute('BEGIN IMMEDIATE')
    before = get_credit_states('track', ['t'])['t']
    version = get_catalog_version()
    started = time.monotonic()
    try:
        with pytest.raises(HTTPException) as exc:
            set_track_artists('t', [{'name': 'New'}], before['revision'], {'id': 1, 'role': 'admin'}, '')
        assert exc.value.status_code == 503 and exc.value.headers == {'Retry-After': '1'}
        assert time.monotonic() - started >= 4.5
    finally:
        lock.rollback()
        lock.close()
    assert get_credit_states('track', ['t'])['t'] == before
    assert get_catalog_version() == version


def test_track_album_artist_change_rejected_before_cover_or_files(library):
    from services import track_metadata_service
    admin = {'id': 1, 'role': 'admin'}
    before = (hashlib.sha256(library[0].read_bytes()).hexdigest(), library[0].stat().st_mtime_ns)
    payload = TrackEditPayload(artist='A', album_artist='Different', title='new', cover_action='replace', cover_url='https://example.com/cover')
    with patch.object(track_metadata_service, 'resolve_track_file_path', side_effect=AssertionError('file access')), \
         patch.object(track_metadata_service, 'prepare_cover_bytes', side_effect=AssertionError('cover access')):
        with pytest.raises(HTTPException) as error:
            mutate_track_metadata('t', payload, admin)
    assert error.value.status_code == 409 and error.value.detail['code'] == 'album_artists_edit_separately'
    assert before == (hashlib.sha256(library[0].read_bytes()).hexdigest(), library[0].stat().st_mtime_ns)
