import test_db_path  # noqa: F401

import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

# The bot is a sibling component; keep brain first for its existing imports.
sys.path.append(str(Path(__file__).resolve().parent.parent / 'tg_music_bot'))

import metadata
from mutagen.id3 import ID3, TPE1, TPE2


def test_mp3_literal_values_are_read_without_writing(tmp_path, monkeypatch):
    path = tmp_path / 'track.mp3'
    path.write_bytes(b'audio')
    tags = ID3()
    tags.add(TPE1(encoding=3, text=['AC/DC', 'Earth, Wind & Fire']))
    tags.add(TPE2(encoding=3, text=['Album A', 'Album B']))
    monkeypatch.setattr(metadata, 'MP3', lambda _: SimpleNamespace(info=None, tags=tags))
    before = (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_size, path.stat().st_mtime_ns)
    result = metadata.read_mp3_metadata(str(path))
    assert result.artists == ['AC/DC', 'Earth, Wind & Fire']
    assert result.album_artists == ['Album A', 'Album B']
    assert before == (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_size, path.stat().st_mtime_ns)


def test_structured_missing_and_empty_values():
    assert metadata._tag_values({}, 'ARTIST') is None
    assert metadata._tag_values({'artist': []}, 'ARTIST') == []
    assert metadata._tag_values({'artist': ['TV Girl/George Clanton']}, 'ARTIST') == ['TV Girl/George Clanton']

import shutil
import subprocess
import uuid
import pytest
import mutagen
from mutagen.id3 import TIT2, TALB
from repositories import schema
from repositories.base import get_connection
from repositories.artist_credits import get_credit_states, replace_artist_credits
from services import library_service, media_locations
import db


@pytest.fixture(params=['mp3v23', 'mp3v24', 'flac', 'm4a', 'ogg', 'opus'])
def tagged_audio(tmp_path, request):
    if not shutil.which('ffmpeg'):
        pytest.skip('ffmpeg unavailable')
    kind = request.param
    ext = 'mp3' if kind.startswith('mp3') else kind
    path = tmp_path / ('fixture.' + ext)
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
                    '-t', '0.12', '-y', str(path)], check=True, capture_output=True)
    if ext == 'mp3':
        tags = ID3(str(path))
        tags.add(TIT2(encoding=3, text=['Title']))
        tags.add(TALB(encoding=3, text=['Release']))
        values = ['TV Girl/George Clanton'] if kind == 'mp3v23' else ['AC/DC', 'Earth, Wind & Fire']
        tags.add(TPE1(encoding=3, text=values))
        tags.add(TPE2(encoding=3, text=['Album A'] if kind == 'mp3v23' else ['Album A', 'Album B']))
        tags.save(str(path), v2_version=3 if kind == 'mp3v23' else 4)
    else:
        audio = mutagen.File(path, easy=True)
        audio['title'] = ['Title']
        audio['album'] = ['Release']
        audio['artist'] = ['AC/DC', 'Earth, Wind & Fire']
        audio['albumartist'] = ['Album A', 'Album B']
        audio.save()
        values = ['AC/DC', 'Earth, Wind & Fire']
    return path, values, ['Album A'] if kind == 'mp3v23' else ['Album A', 'Album B']


def fingerprint(path):
    return hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_size, path.stat().st_mtime_ns


def test_real_multiformat_readers_do_not_write(tagged_audio):
    import audio_tags
    path, artists, album_artists = tagged_audio
    before = fingerprint(path)
    brain = metadata.read_audio_metadata(str(path))
    bot = audio_tags.read_audio_tags(str(path))
    assert brain.artists == bot.artists == artists
    assert brain.album_artists == bot.album_artists == album_artists
    assert fingerprint(path) == before


def set_manual(kind, entity_id, names):
    with get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        state = get_credit_states(kind, [entity_id], conn=conn)[str(entity_id)]
        return replace_artist_credits(conn, kind, entity_id, [{'name': name} for name in names], expected_revision=state['revision'])


def names(kind, entity_id):
    return [artist['name'] for artist in get_credit_states(kind, [entity_id])[str(entity_id)]['artists']]


@pytest.mark.parametrize('track_manual,album_manual', [(['Manual Track', 'Guest'], []), ([], ['Manual Album'])])
def test_scan_and_recovery_keep_independent_manual_credits(tagged_audio, tmp_path, monkeypatch, track_manual, album_manual):
    path, _, _ = tagged_audio
    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'test.db'))
    schema.init_db()
    monkeypatch.setattr(library_service, 'get_effective_music_dir', lambda: str(tmp_path))
    monkeypatch.setattr(media_locations, 'get_effective_music_dir', lambda: str(tmp_path))
    monkeypatch.setattr(library_service, '_deliver_embedding_queue', lambda: None)
    track_id = str(uuid.uuid5(uuid.NAMESPACE_URL, path.name))
    before = fingerprint(path)
    library_service.scan_library()
    album_id = db.get_track(track_id)['album_id']
    set_manual('track', track_id, track_manual)
    set_manual('album', album_id, album_manual)
    library_service.scan_library()
    assert db.get_track(track_id)['album_id'] == album_id
    assert names('track', track_id) == track_manual
    assert names('album', album_id) == album_manual
    # Simulate accidental row loss, preserving durable state and album.
    with get_connection() as conn:
        conn.execute('DELETE FROM tracks WHERE id=?', (track_id,))
    payload = {'file_path': path.name, 'title': 'stale', 'album': 'Release',
               'artist': 'stale', 'artists': [{'name': 'Stale', 'id': 'invalid'}],
               'album_artists': []}
    recovered = media_locations.ensure_track_in_db(track_id, payload)
    assert recovered and recovered['album_id'] == album_id
    assert names('track', track_id) == track_manual
    assert names('album', album_id) == album_manual
    assert fingerprint(path) == before


def test_bot_provider_survives_scan_and_redownload(tagged_audio, tmp_path, monkeypatch):
    import bot
    path, _, _ = tagged_audio
    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'test.db'))
    schema.init_db()
    monkeypatch.setattr(library_service, 'get_effective_music_dir', lambda: str(tmp_path))
    monkeypatch.setattr(library_service, '_deliver_embedding_queue', lambda: None)
    monkeypatch.setattr(bot, 'enqueue_embedding_tasks', lambda *args: None)
    monkeypatch.setattr(db, 'add_favorite', lambda *args: None)
    user_id = db.create_user('import_test', role='user')
    raw = metadata.read_audio_metadata(str(path))
    provider = {'filepath': str(path), 'title': 'Title', 'artist': raw.artist,
                'album': 'Release', 'album_artist': raw.album_artist,
                'artists': ['Provider A', 'Provider B'], 'artists_kind': 'provider'}
    info = {'is_spotify': True, 'total_tracks': 1, 'tracks': [{'filepath': str(path), 'verified_metadata': provider}]}
    before = fingerprint(path)
    assert bot.index_downloaded_tracks(info, {'id': user_id}, str(tmp_path)) == 1
    track_id = str(uuid.uuid5(uuid.NAMESPACE_URL, path.name))
    album_id = db.get_track(track_id)['album_id']
    assert names('track', track_id) == ['Provider A', 'Provider B']
    # Provider track participants must not become album participants.
    assert names('album', album_id) == [raw.album_artist]
    library_service.scan_library()
    state = get_credit_states('track', [track_id])[track_id]
    assert state['source_kind'] == 'provider'
    assert state['source_names'] == ['Provider A', 'Provider B']
    with get_connection() as conn:
        observed = conn.execute("SELECT observed_kind, observed_names_json FROM artist_credit_state WHERE entity_type='track' AND entity_id=?", (track_id,)).fetchone()
        assert observed['observed_kind'] == 'tags'
        assert json.loads(observed['observed_names_json']) == raw.artists
    set_manual('track', track_id, [])
    set_manual('album', album_id, ['Manual Release'])
    assert bot.index_downloaded_tracks(info, {'id': user_id}, str(tmp_path)) == 1
    assert names('track', track_id) == []
    assert names('album', album_id) == ['Manual Release']
    assert db.get_track(track_id)['album_id'] == album_id
    # Explicit provider empty clears the source but never the manual override.
    provider['artists'] = []
    assert bot.index_downloaded_tracks(info, {'id': user_id}, str(tmp_path)) == 1
    state = get_credit_states('track', [track_id])[track_id]
    assert state['source_kind'] == 'provider' and state['source_names'] == []
    assert names('track', track_id) == []
    assert fingerprint(path) == before


def test_scanner_and_queue_use_sqlite_when_qdrant_is_down(tagged_audio, tmp_path, monkeypatch):
    import scan
    from services.embedding_queue_service import _build_payload
    path, _, _ = tagged_audio
    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'test.db'))
    schema.init_db()
    track_id = str(uuid.uuid5(uuid.NAMESPACE_URL, path.name))
    before = fingerprint(path)
    first = scan._index_scanned_file(path, path.name, track_id)
    album_id = first['album_id']
    set_manual('track', track_id, [])
    set_manual('album', album_id, ['Album Override'])
    class OfflineQdrant:
        def retrieve(self, **kwargs):
            raise ConnectionError('offline')
    monkeypatch.setattr(scan, 'MUSIC_DIR', str(tmp_path))
    monkeypatch.setattr(scan, 'scan_directory', lambda _: [path])
    monkeypatch.setattr(scan, 'init_qdrant', lambda **kwargs: OfflineQdrant())
    monkeypatch.setattr(scan.time, 'sleep', lambda _: (_ for _ in ()).throw(SystemExit()))
    monkeypatch.setattr('sys.argv', ['scan.py'])
    with pytest.raises(SystemExit):
        scan.main()
    effective = db.get_tracks_by_ids([track_id])[track_id]
    payload = _build_payload(effective, path.name, path.stat())
    assert payload['artists'] == []
    assert [item['name'] for item in payload['album_artists']] == ['Album Override']
    assert db.get_track(track_id)['album_id'] == album_id
    assert fingerprint(path) == before


def test_recovery_without_album_artist_reuses_legacy_identity(tmp_path, monkeypatch):
    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'test.db'))
    schema.init_db()
    path = tmp_path / 'song.mp3'
    path.write_bytes(b'fixture')
    before = fingerprint(path)
    track_id = str(uuid.uuid5(uuid.NAMESPACE_URL, path.name))
    album_id = db.resolve_album('Release', album_artist='Legacy Album Artist')
    db.add_or_update_track(track_id, path.name, 'Title', album_id, 'Track Artist')
    set_manual('track', track_id, [])
    set_manual('album', album_id, ['Manual Album'])
    with get_connection() as conn:
        conn.execute('DELETE FROM tracks WHERE id=?', (track_id,))
    monkeypatch.setattr(media_locations, 'get_effective_music_dir', lambda: str(tmp_path))
    meta = metadata.AudioMetadata(title='Title', artist='Track Artist', album='Release')
    monkeypatch.setattr(metadata, 'read_audio_metadata', lambda _: meta)
    row = media_locations.ensure_track_in_db(track_id, {'file_path': path.name, 'album': 'Release'})
    assert row['album_id'] == album_id
    assert names('track', track_id) == []
    assert names('album', album_id) == ['Manual Album']
    with get_connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM albums').fetchone()[0] == 1
    assert fingerprint(path) == before


def test_database_read_failure_does_not_trigger_qdrant_recovery(monkeypatch):
    def fail(_):
        raise RuntimeError('database unavailable')
    monkeypatch.setattr(db, 'get_track', fail)
    class NeverQdrant:
        def retrieve(self, **kwargs):
            raise AssertionError('must not query Qdrant after DB error')
    monkeypatch.setattr(media_locations, 'client', NeverQdrant())
    assert media_locations.ensure_track_in_db(str(uuid.uuid4())) is None


def test_legacy_scanner_new_point_has_effective_credits(tmp_path, monkeypatch):
    import scan
    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'test.db'))
    schema.init_db()
    path = tmp_path / 'song.mp3'
    path.write_bytes(b'fixture')
    track_id = str(uuid.uuid5(uuid.NAMESPACE_URL, path.name))
    meta = metadata.AudioMetadata(title='Song', artist='Tag Artist', album='Album', album_artist='Tag Album',
                                  artists=['Tag Artist'], album_artists=['Tag Album'], file_size=path.stat().st_size,
                                  file_mtime_ns=path.stat().st_mtime_ns)
    monkeypatch.setattr(metadata, 'read_audio_metadata', lambda _: meta)
    initial = scan._index_scanned_file(path, path.name, track_id)
    set_manual('track', track_id, [])
    set_manual('album', initial['album_id'], ['Album Override'])
    class FakeQdrant:
        points = []
        def retrieve(self, **kwargs):
            return []
        def upsert(self, **kwargs):
            self.points.extend(kwargs['points'])
    client = FakeQdrant()
    monkeypatch.setattr(scan, 'MUSIC_DIR', str(tmp_path))
    monkeypatch.setattr(scan, 'scan_directory', lambda _: [path])
    monkeypatch.setattr(scan, 'init_qdrant', lambda **kwargs: client)
    monkeypatch.setattr(scan, 'process_audio_file', lambda *_: {'file_path': path.name, 'bpm': 100})
    monkeypatch.setattr(scan.time, 'sleep', lambda _: (_ for _ in ()).throw(SystemExit()))
    monkeypatch.setattr('sys.argv', ['scan.py'])
    before = fingerprint(path)
    with pytest.raises(SystemExit):
        scan.main()
    assert len(client.points) == 1
    payload = client.points[0].payload
    assert payload['artists'] == []
    assert [artist['name'] for artist in payload['album_artists']] == ['Album Override']
    assert fingerprint(path) == before
