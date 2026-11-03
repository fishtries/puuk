"""Regressions reproduced in the final artist-section review."""
import test_db_path  # noqa: F401 — before db/config

import json
import time
from unittest.mock import Mock

import pytest

import db
from repositories import artists


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'review.db'))
    db.init_db()
    return tmp_path


def add_track(track_id, artist='DJ   Arbuz', album_id=None):
    db.add_or_update_track(track_id=track_id, file_path=f'/test/{track_id}.mp3',
                           title=track_id, artist=artist, album_id=album_id)


def test_catalog_search_normalizes_both_sides(catalog):
    add_track('review-track', artist='ＤＪ\t  Arbuz')
    results = artists.get_artist_catalog('dj arbuz')
    assert len(results) == 1
    assert results[0]['id'] == artists.artist_id_for_name('DJ Arbuz')


@pytest.mark.parametrize('album_artist', [None, '', '   ', '\t\n', '\u00a0'])
def test_album_attribution_and_clean_dto(catalog, album_artist):
    album_id = db.add_or_get_album(title='Review Album', year='2024')
    conn = db.get_connection()
    conn.execute('UPDATE albums SET album_artist = ? WHERE id = ?', (album_artist, album_id))
    conn.commit()
    conn.close()
    add_track('review-track', album_id=album_id)
    add_track('guest-track', artist='Guest', album_id=album_id)
    artist_id = artists.artist_id_for_name('DJ Arbuz')
    detail = artists.get_artist_detail(artist_id, 'http://test')
    assert detail['artist']['album_count'] == len(detail['albums']) == 0
    # Attribution is owned by the album; adding a credit exposes the whole release.
    from services.artist_credit_service import set_album_artists
    from repositories.artist_credits import get_credit_states
    revision = get_credit_states('album', [album_id])[str(album_id)]['revision']
    set_album_artists(album_id, [{'id': artist_id}], revision, {'id': 1, 'role': 'admin'}, 'http://test')
    detail = artists.get_artist_detail(artist_id, 'http://test')
    assert detail['artist']['album_count'] == len(detail['albums']) == 1
    album = detail['albums'][0]
    assert {'id', 'title', 'album_artist', 'year', 'track_count', 'cover_id', 'coverArt',
            'artist_id', 'artists', 'artists_revision'} <= set(album)
    assert album['track_count'] == 2


@pytest.mark.parametrize('failure', ['begin', 'backup', 'install', 'commit'])
def test_failed_artwork_replace_preserves_previous_file_and_version(catalog, monkeypatch, failure):
    target, staged = catalog / 'artist.jpg', catalog / 'staged.jpg'
    staged.write_bytes(b'old')
    artist_id = artists.artist_id_for_name('Review')
    assert artists.replace_artwork_atomically(artist_id, str(staged), str(target)) == 1
    staged.write_bytes(b'new')
    connection = db.get_connection()
    wrapped = Mock(wraps=connection)
    if failure == 'begin':
        wrapped.execute.side_effect = OSError('begin failed')
    elif failure == 'commit':
        wrapped.commit.side_effect = OSError('commit failed')
    monkeypatch.setattr(artists, 'get_connection', lambda: wrapped)
    original_replace = artists.os.replace

    def replace(source, destination):
        if (failure == 'backup' and source == str(target)) or (failure == 'install' and source == str(staged)):
            raise OSError('rename failed')
        return original_replace(source, destination)

    monkeypatch.setattr(artists.os, 'replace', replace)
    with pytest.raises(OSError):
        artists.replace_artwork_atomically(artist_id, str(staged), str(target))
    assert target.read_bytes() == b'old'
    assert not list(catalog.glob('*.bak'))
    with db.get_connection() as conn:
        row = conn.execute('SELECT version FROM artist_artwork WHERE artist_id = ?', (artist_id,)).fetchone()
        assert row['version'] == 1


@pytest.mark.parametrize('remove', [False, True])
def test_artwork_cleanup_failure_does_not_undo_commit(catalog, monkeypatch, remove):
    target, staged = catalog / 'artist.jpg', catalog / 'staged.jpg'
    artist_id = artists.artist_id_for_name('Review')
    staged.write_bytes(b'old')
    artists.replace_artwork_atomically(artist_id, str(staged), str(target))
    original_unlink = artists.os.unlink

    def unlink(path, *args, **kwargs):
        if str(path).endswith('.bak'):
            raise PermissionError('cleanup failed')
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(artists.os, 'unlink', unlink)
    if remove:
        artists.remove_artwork_atomically(artist_id, str(target))
        assert not target.exists()
        assert artists.get_artwork_metadata(artist_id) is None
    else:
        staged.write_bytes(b'new')
        assert artists.replace_artwork_atomically(artist_id, str(staged), str(target)) == 2
        assert target.read_bytes() == b'new'
        assert artists.get_artwork_metadata(artist_id)['version'] == 2


def test_catalog_10k_tracks_uses_two_queries(catalog, monkeypatch):
    conn = db.get_connection()
    conn.executemany('INSERT INTO tracks (id, file_path, title, artist) VALUES (?, ?, ?, ?)',
                     [(f'perf-{i}', f'/test/perf-{i}.mp3', f'Track {i}', f'Artist {i % 1000}')
                      for i in range(10000)])
    from repositories.artist_credits import backfill_artist_credits
    backfill_artist_credits(conn)
    conn.commit()
    conn.close()
    queries = []
    get_connection = artists.get_connection

    def traced_connection():
        connection = get_connection()
        connection.set_trace_callback(queries.append)
        return connection

    monkeypatch.setattr(artists, 'get_connection', traced_connection)
    started = time.perf_counter()
    result = [artists.public_artist(row, 'http://test') for row in artists.get_artist_catalog()]
    elapsed = time.perf_counter() - started
    size = len(json.dumps(result).encode())
    assert len(result) == 1000
    assert all(row['track_count'] == 10 for row in result)
    assert len([q for q in queries if q.strip().upper().startswith("SELECT")]) <= 2
    assert size < 250000
    print(f'catalog 10k tracks / 1k artists: {elapsed:.3f}s, {size} bytes, {len(queries)} queries')


def test_artist_migration_on_v10_preserves_data_and_is_idempotent(tmp_path, monkeypatch):
    from repositories import schema

    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'legacy.db'))
    listdir = schema.os.listdir
    with monkeypatch.context() as migration_patch:
        migration_patch.setattr(schema.os, 'listdir', lambda path: [
            filename for filename in listdir(path) if int(filename.split('_')[0]) <= 10
        ])
        db.init_db()
    with db.get_connection() as conn:
        conn.execute("INSERT INTO tracks (id, file_path, title, artist) VALUES ('legacy-track', '/test/legacy.mp3', 'legacy-track', 'Legacy Artist')")
    with db.get_connection() as conn:
        assert conn.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0] == 10
        assert not conn.execute("SELECT name FROM sqlite_master WHERE name='artist_play_starts'").fetchone()
    db.init_db()
    assert artists.record_play_start(1, 'legacy-track') == 'recorded'
    db.init_db()
    with db.get_connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM schema_migrations WHERE version=11').fetchone()[0] == 1
        assert conn.execute('SELECT COUNT(*) FROM artist_play_starts').fetchone()[0] == 1
        foreign_keys = conn.execute('PRAGMA foreign_key_list(artist_play_starts)').fetchall()
        assert {(row['table'], row['on_delete']) for row in foreign_keys} == {('tracks', 'CASCADE'), ('users', 'CASCADE')}
        assert not conn.execute('PRAGMA foreign_key_check').fetchall()
