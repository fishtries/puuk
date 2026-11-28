import test_db_path  # noqa: F401

from contextlib import closing
import hashlib
from pathlib import Path
from uuid import uuid4

import db
from repositories import imported_playlists, recording_reviews
from repositories.base import get_connection
from repositories.playlists import remove_playlist_entry
from services.telegram_import_service import prepare_playlist


def add_track(title):
    track_id = str(uuid4())
    db.add_or_update_track(track_id, f'test-imports/{track_id}.flac', title, None, 'Artist',
                           file_size=50, file_mtime_ns=100)
    return track_id


def test_scan_preserves_imported_catalog_metadata_and_cover(tmp_path, monkeypatch):
    import metadata
    from PIL import Image
    from services.media_locations import ingest_music_file
    from services.telegram_import_service import publish, track_cover

    monkeypatch.setenv('MUSIC_DIR', str(tmp_path))
    audio = tmp_path / 'audio.mp3'
    audio.write_bytes(b'audio')
    checksum = hashlib.sha256(audio.read_bytes()).hexdigest()
    cover = tmp_path / 'art.png'
    Image.new('RGB', (20, 20), 'orange').save(cover)
    monkeypatch.setattr(metadata, 'read_audio_metadata', lambda path: metadata.AudioMetadata(
        title=Path(path).stem, format='mp3', duration=20))
    monkeypatch.setattr('services.telegram_import_service.read_audio_metadata', metadata.read_audio_metadata)
    track_id, _ = publish(1, {'type': 'vk', 'title': 'VK title', 'artist': 'VK artist'},
                          {'path': str(audio), 'sha256': checksum, 'cover': str(cover)},
                          tmp_path, position=1)
    track = db.get_track(track_id)
    path = tmp_path / track['file_path']
    assert path.read_bytes() == audio.read_bytes()
    refreshed = ingest_music_file(str(path), source='import')
    assert (refreshed['title'], refreshed['artist']) == ('VK title', 'VK artist')
    assert refreshed['cover_version'] == track['cover_version']
    assert track_cover(track_id)[1] == 'image/jpeg'


def insert_tracks(playlist_id, source, tracks):
    assert imported_playlists.apply_playlist(1, playlist_id, source)
    with closing(get_connection()) as conn, conn:
        for item, track in zip(source, tracks):
            conn.execute("""UPDATE telegram_playlist_positions SET track_id=? WHERE playlist_id=? AND slot=?""",
                         (track, playlist_id, item['slot']))
        conn.execute("""INSERT INTO playlist_tracks(playlist_id,track_id,position,import_slot)
            SELECT playlist_id,track_id,display_position,slot FROM telegram_playlist_positions
            WHERE playlist_id=?""", (playlist_id,))


def titles(playlist_id):
    return [row['title'] for row in db.get_playlist_tracks(playlist_id)]


def test_refresh_preserves_manual_addition_and_rejects_stale_preview():
    playlist_id, created = prepare_playlist(1, f'vk:{uuid4()}', 'Source')
    assert created
    source = [{'slot': value.lower(), 'title': value} for value in ('Thriller', 'Bad', 'Beat It')]
    tracks = [add_track(item['title']) for item in source]
    insert_tracks(playlist_id, source, tracks)
    personal = add_track('Human Nature')
    assert db.add_track_to_playlist(playlist_id, personal)
    entries = {row['title']: row['playlist_entry_id'] for row in db.get_playlist_tracks(playlist_id)}
    assert db.reorder_playlist_tracks(playlist_id, [entries[name] for name in
                                      ('Beat It', 'Human Nature', 'Thriller', 'Bad')], by_entry=True)
    refreshed = [source[1], {'slot': 'billie', 'title': 'Billie Jean'}, source[2], source[0]]
    revision, changes = imported_playlists.playlist_preview(1, playlist_id, refreshed)
    assert 'Human Nature · с 2 на 4' in changes
    assert titles(playlist_id) == ['Beat It', 'Human Nature', 'Thriller', 'Bad']
    assert db.reorder_playlist_tracks(playlist_id, [entries[name] for name in
                                      ('Beat It', 'Human Nature', 'Bad', 'Thriller')], by_entry=True)
    assert not imported_playlists.apply_playlist(1, playlist_id, refreshed, revision)
    revision, _ = imported_playlists.playlist_preview(1, playlist_id, refreshed)
    assert imported_playlists.apply_playlist(1, playlist_id, refreshed, revision)
    assert titles(playlist_id) == ['Bad', 'Beat It', 'Human Nature', 'Thriller']


def test_removing_one_occurrence_keeps_other_and_persists_across_refresh():
    playlist_id, _ = prepare_playlist(1, f'vk:{uuid4()}', 'Repeated')
    song = add_track('Billie Jean')
    source = [{'slot': 'billie-a', 'title': 'Billie Jean'}, {'slot': 'billie-b', 'title': 'Billie Jean'}]
    insert_tracks(playlist_id, source, [song, song])
    first, second = db.get_playlist_tracks(playlist_id)
    assert first['id'] == second['id'] == song
    assert first['playlist_entry_id'] != second['playlist_entry_id']
    remove_playlist_entry(playlist_id, second['playlist_entry_id'])
    refreshed = source + [{'slot': 'beat-it', 'title': 'Beat It'}]
    revision, changes = imported_playlists.playlist_preview(1, playlist_id, refreshed)
    assert 'Billie Jean · личное удаление сохранится' in changes
    assert imported_playlists.apply_playlist(1, playlist_id, refreshed, revision)
    assert titles(playlist_id) == ['Billie Jean']
    assert db.add_track_to_playlist(playlist_id, song)
    assert titles(playlist_id) == ['Billie Jean', 'Billie Jean']


def test_recording_review_does_not_block_a_replaced_file():
    track_id = add_track('Original')
    with closing(get_connection()) as conn, conn:
        conn.execute("""INSERT INTO telegram_track_imports VALUES (?,?,?,?)""",
                     (f'spotify:{uuid4()}', track_id, 'sample',
                      '{"reference":{"preview_url":"https://p.scdn.co/reference","duration":160}}'))
    assert recording_reviews.request(track_id, 1, '50:100') == 'queued'
    review = recording_reviews.claim()
    assert review['track_id'] == track_id
    assert recording_reviews.request(track_id, 1, '50:100') == 'running'
    with closing(get_connection()) as conn, conn:
        conn.execute('UPDATE tracks SET file_mtime_ns=200 WHERE id=?', (track_id,))
    assert recording_reviews.finish(review, 'mismatch') == 'changed'
    assert track_id not in recording_reviews.blocked_track_ids()
    assert recording_reviews.request(track_id, 1, '50:200') == 'queued'
    assert recording_reviews.finish(recording_reviews.claim(), 'mismatch') == 'mismatch'
    assert track_id in recording_reviews.blocked_track_ids()


def test_vk_catalog_metadata_updates_existing_track_without_replacing_audio(tmp_path, monkeypatch):
    from PIL import Image
    from metadata import AudioMetadata
    from services import telegram_import_service as catalog
    from services.media_locations import ingest_music_file

    monkeypatch.setenv('MUSIC_DIR', str(tmp_path))
    audio = tmp_path / 'audio.mp3'
    audio.write_bytes(b'vk recording')
    art = tmp_path / 'cover.png'
    Image.new('RGB', (30, 30), 'red').save(art)
    monkeypatch.setattr(catalog, 'read_audio_metadata', lambda _: AudioMetadata(title='Original', duration=245))
    source = {'type': 'vk', 'key': f'vk:track:{uuid4()}', 'title': 'Original', 'artist': 'Artist'}
    artifact = {'path': str(audio), 'sha256': hashlib.sha256(audio.read_bytes()).hexdigest()}
    track_id, _ = catalog.publish(1, source, artifact, tmp_path, position=1)
    before = db.get_track(track_id)
    db.add_favorite(1, track_id)
    playlist_id, _ = prepare_playlist(1, f'vk:{uuid4()}', 'Playlist')
    assert db.add_track_to_playlist(playlist_id, track_id)
    entry_id = db.get_playlist_tracks(playlist_id)[0]['playlist_entry_id']
    edition = {'title': 'Original', 'artist': 'Artist', 'album': 'Studio Album', 'album_artist': 'Artist',
               'year': '2021', 'track_number': '4', 'source': 'iTunes'}

    assert not catalog.update_vk_metadata({'id': 2, 'role': 'user'}, track_id, source['key'], before, edition, art)
    assert catalog.update_vk_metadata({'id': 1}, track_id, source['key'], before, edition, art)
    after = db.get_track(track_id)
    assert db.get_album(after['album_id'])['title'] == 'Studio Album'
    assert (after['year'], after['track_number'], after['duration']) == ('2021', '4', 245)
    assert after['cover_version'] > before['cover_version']
    assert catalog.track_cover(track_id, preferred=True)[1] == 'image/jpeg'
    assert not catalog.update_vk_metadata({'id': 1}, track_id, source['key'], before, edition, art)

    published = tmp_path / after['file_path']
    assert published.read_bytes() == audio.read_bytes()
    assert published.stat().st_mtime_ns == before['file_mtime_ns']
    assert track_id in db.get_favorite_track_ids(1)
    entry, = db.get_playlist_tracks(playlist_id)
    assert (entry['id'], entry['playlist_entry_id']) == (track_id, entry_id)
    assert catalog.publish(1, source, artifact, tmp_path, position=1)[0] == track_id
    assert ingest_music_file(str(published), source='import')['album_id'] == after['album_id']
    assert catalog.has_catalog_metadata(track_id)


def test_selected_variant_fills_album_position_without_moving_an_existing_track(tmp_path, monkeypatch):
    from metadata import AudioMetadata
    from services import telegram_import_service as catalog

    audio = tmp_path / 'variant.mp3'
    audio.write_bytes(b'already published audio')
    sha = hashlib.sha256(audio.read_bytes()).hexdigest()
    monkeypatch.setattr(catalog, 'read_audio_metadata', lambda _: AudioMetadata(title='Variant', duration=245))
    existing_source = {'type': 'direct', 'key': f'youtube:{uuid4()}', 'title': 'Variant',
                       'artist': 'Artist', 'album': f'Other release {uuid4()}'}
    old_track, old_album = catalog.publish(1, existing_source, {'path': str(audio), 'sha256': sha}, tmp_path,
                                          position=1)
    release = db.resolve_album(f'Target album {uuid4()}', album_artist='Artist')
    source = {'type': 'vk', 'key': f'vk:track:{uuid4()}', 'title': 'Requested recording', 'artist': 'Artist'}
    evidence = {'selection': 'user-replacement', 'candidate': {'title': 'Variant'}}
    artifact = {'path': str(audio), 'sha256': sha, 'evidence': evidence}
    track, album = catalog.publish(1, source, artifact, tmp_path, position=8, album=True, selected_album_id=release)
    assert track != old_track and album == release
    assert db.get_track(old_track)['album_id'] == old_album
    placed = db.get_track(track)
    assert (placed['album_id'], placed['album_track_position'], placed['title']) == (release, 8, 'Variant')
    assert catalog.publish(1, source, artifact, tmp_path, position=8, album=True, selected_album_id=release)[0] == track


def test_bulk_vk_metadata_keeps_the_imported_album_and_track_numbers(tmp_path, monkeypatch):
    from PIL import Image
    from metadata import AudioMetadata
    from services import telegram_import_service as catalog

    audio = tmp_path / 'audio.mp3'
    audio.write_bytes(b'vk album recording')
    cover = tmp_path / 'cover.png'
    Image.new('RGB', (30, 30), 'blue').save(cover)
    monkeypatch.setattr(catalog, 'read_audio_metadata', lambda _: AudioMetadata(duration=190))
    source = {'type': 'vk', 'key': f'vk:track:{uuid4()}', 'title': 'Song', 'artist': 'Artist',
              'album': f'Original album {uuid4()}', 'album_artist': 'Artist', 'disc': 2, 'track': 8}
    artifact = {'path': str(audio), 'sha256': hashlib.sha256(audio.read_bytes()).hexdigest()}
    track_id, album_id = catalog.publish(1, source, artifact, tmp_path, position=8, album=True)
    edition = {'album': 'Compilation', 'album_artist': 'Various Artists', 'track_number': '19', 'disc_number': '1',
               'source': 'iTunes', 'genre': 'Pop'}
    before = db.get_track(track_id)
    assert catalog.update_vk_metadata({'id': 1}, track_id, source['key'], before, edition, cover, keep_album=True)
    after = db.get_track(track_id)
    assert (after['album_id'], after['album_artist'], after['disc_number'], after['track_number']) == (
        album_id, 'Artist', '2', '8',
    )
    assert after['genre'] == 'Pop'
    assert catalog.track_cover(track_id, preferred=True)[1] == 'image/jpeg'
