import test_db_path  # noqa: F401 -- isolation before any DB/config imports

import hashlib
import sqlite3
from pathlib import Path
from unittest.mock import patch

import pytest

from repositories import albums, tracks, schema
from repositories.base import get_connection, get_catalog_version, bump_catalog_version
from repositories.artist_credits import (
    AlbumCreditsConflict, CreditConflict, CreditNotFound, CreditSource,
    CreditValidationError, artist_id_for_name, normalize_artist_name,
    backfill_artist_credits, get_credit_states, ingest_artist_credits,
    replace_artist_credits, hydrate_track_credits, hydrate_album_credits,
)


@pytest.fixture
def database(tmp_path, monkeypatch):
    path = tmp_path / 'library.db'
    monkeypatch.setenv('PUUK_DB_PATH', str(path))
    schema.init_db()
    return path


def add_track(track_id='t', artist='A', album_id=None, **kwargs):
    tracks.add_or_update_track(track_id, '/missing/audio.mp3', 'Title', album_id, artist, **kwargs)
    return track_id


def state(kind='track', entity_id='t'):
    return get_credit_states(kind, [entity_id])[str(entity_id)]


def manual(names, entity_id='t', kind='track', revision=None):
    with get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        current = get_credit_states(kind, [entity_id], conn=conn)[str(entity_id)]
        result = replace_artist_credits(conn, kind, entity_id, [{'name': n} for n in names],
                                       expected_revision=current['revision'] if revision is None else revision)
        if result != current:
            bump_catalog_version(conn)
        return result


def imported(kind, names, entity_id='t', entity_type='track'):
    with get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        return ingest_artist_credits(conn, entity_type, entity_id, CreditSource(kind, names))


def legacy_v11(path):
    """Exercise upgrade on persisted v11, rather than the fresh schema alone."""
    with get_connection() as conn:
        for table in ['track_artists', 'album_artists', 'artists', 'artist_credit_state', 'artist_credit_operations']:
            conn.execute(f'DROP TABLE {table}')
        conn.execute('DELETE FROM schema_migrations WHERE version >= 12')
        conn.execute("INSERT INTO albums(id,title,album_artist,title_normalized,album_artist_normalized) VALUES (90,'Release','A','release','a')")
        conn.execute("INSERT INTO tracks(id,file_path,title,artist,album_id) VALUES ('legacy','/absent.mp3','Song','TV Girl/George Clanton',90)")
        conn.execute("INSERT INTO artist_artwork(artist_id,version,has_artwork) VALUES (?,7,1)", (artist_id_for_name('A'),))
        conn.execute("INSERT INTO artist_play_starts(user_id,track_id,played_on) VALUES (1,'legacy','2026-10-27')")


def test_v11_backfill_repeat_preserves_ids_events_artwork_and_literal_name(database):
    legacy_v11(database)
    schema.init_db()
    assert state(entity_id='legacy')['artists'] == [{'id': artist_id_for_name('TV Girl/George Clanton'), 'name': 'TV Girl/George Clanton'}]
    before = state(entity_id='legacy')
    version = get_catalog_version()
    schema.init_db()
    with get_connection() as conn:
        backfill_artist_credits(conn)
        assert conn.execute('SELECT 1 FROM schema_migrations WHERE version = 12').fetchone() is not None
        assert conn.execute('SELECT version FROM artist_artwork').fetchone()[0] == 7
        assert conn.execute('SELECT COUNT(*) FROM artist_play_starts').fetchone()[0] == 1
        assert conn.execute('SELECT album_id,artist FROM tracks WHERE id="legacy"').fetchone()[:] == (90, 'TV Girl/George Clanton')
        assert conn.execute('PRAGMA foreign_key_check').fetchall() == []
    assert state(entity_id='legacy') == before
    assert get_catalog_version() == version


def test_failed_backfill_rolls_back_schema_links_and_checkpoint(database):
    legacy_v11(database)
    original = backfill_artist_credits
    def fail(conn):
        original(conn)
        raise RuntimeError('simulated mid-migration failure')
    with patch('repositories.artist_credits.backfill_artist_credits', side_effect=fail):
        with pytest.raises(RuntimeError):
            schema.init_db()
    with get_connection() as conn:
        assert conn.execute('SELECT 1 FROM schema_migrations WHERE version=12').fetchone() is None
        assert conn.execute("SELECT 1 FROM sqlite_master WHERE name='artists'").fetchone() is None
        assert conn.execute('SELECT COUNT(*) FROM tracks WHERE id="legacy"').fetchone()[0] == 1
    schema.init_db()
    assert state(entity_id='legacy')['revision'] == 1


def test_normalization_dedup_order_case_and_literal_punctuation(database):
    add_track()
    result = manual([' Ａ ', 'A', 'a', 'DJ\u00a0  Arbuz', 'AC/DC', 'Earth, Wind & Fire'])
    assert [a['name'] for a in result['artists']] == ['A', 'a', 'DJ Arbuz', 'AC/DC', 'Earth, Wind & Fire']
    assert normalize_artist_name('  DJ\tArbuz ') == 'DJ Arbuz'
    assert artist_id_for_name('A') != artist_id_for_name('a')
    assert artist_id_for_name(' various\u00a0 artists ') is None


@pytest.mark.parametrize('names', [[''], ['Various Artists'], ['X'*301], ['A']*101])
def test_invalid_manual_does_not_register_or_change(database, names):
    add_track()
    before = state()
    with pytest.raises(CreditValidationError):
        manual(names)
    assert state() == before
    with get_connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM artists').fetchone()[0] == 1


def test_provider_precedence_empty_override_and_observation(database):
    add_track()
    imported('provider', ['A', 'B'])
    original = state()
    lower = imported('tags', ['A'])
    assert lower == original
    with get_connection() as conn:
        assert conn.execute('SELECT observed_kind,observed_names_json FROM artist_credit_state').fetchone()[:] == ('tags', '["A"]')
    cleared = manual([])
    assert cleared['manual'] and not cleared['artists']
    imported('provider', ['C'])
    assert state()['artists'] == []
    with get_connection() as conn:
        result = ingest_artist_credits(conn, 'track', 't', None)
    assert result == state()
    assert state()['source_names'] == ['C']


def test_explicit_empty_same_rank_clears_but_legacy_missing_does_not(database):
    add_track()
    imported('tags', ['A', 'B'])
    add_track(artist='')
    assert len(state()['artists']) == 2
    imported('tags', [])
    assert state()['artists'] == []
    imported('legacy', ['A'])
    assert state()['artists'] == []


def test_revision_idempotency_pin_and_stale_no_registry_write(database):
    add_track()
    first = state()
    pinned = manual(['A'])
    assert pinned['revision'] == first['revision'] + 1
    version = get_catalog_version()
    repeated = manual(['A'], revision=first['revision'])
    assert repeated == pinned and get_catalog_version() == version
    with pytest.raises(CreditConflict) as conflict:
        manual(['B'], revision=first['revision'])
    assert conflict.value.current_state == pinned
    with get_connection() as conn:
        assert conn.execute('SELECT 1 FROM artists WHERE normalized_name="B"').fetchone() is None
    assert state() == pinned


def test_missing_and_empty_and_caller_rollback(database):
    add_track(artist='')
    found = get_credit_states('track', ['t', 'missing'])
    assert found['t']['artists'] == [] and 'missing' not in found
    before = state()
    conn = get_connection()
    conn.execute('BEGIN IMMEDIATE')
    replace_artist_credits(conn, 'track', 't', [{'name':'New'}], expected_revision=before['revision'])
    conn.rollback()
    conn.close()
    assert state() == before
    with get_connection() as conn:
        with pytest.raises(CreditNotFound):
            replace_artist_credits(conn, 'track', 'absent', [], expected_revision=0)


def test_audio_fixture_bytes_stat_and_metadata_fingerprint_unchanged(database, tmp_path):
    import wave
    fixture = tmp_path / 'fixture.wav'
    with wave.open(str(fixture), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b'\x00\x00' * 800)
    before_hash = hashlib.sha256(fixture.read_bytes()).hexdigest()
    before_stat = fixture.stat()
    add_track(file_size=before_stat.st_size, file_mtime_ns=before_stat.st_mtime_ns)
    with get_connection() as conn:
        conn.execute('UPDATE tracks SET file_path=?,cover_version=9,loudness_status="analyzed",loudness_file_size=123 WHERE id="t"', (str(fixture),))
    raw = tracks.get_track('t')
    manual(['A','B'])
    schema.init_db()
    assert hashlib.sha256(fixture.read_bytes()).hexdigest() == before_hash
    after_stat = fixture.stat()
    assert (after_stat.st_size,after_stat.st_mtime_ns) == (before_stat.st_size,before_stat.st_mtime_ns)
    assert tracks.get_track('t') == raw


def test_accidental_row_loss_recovers_manual_empty_and_album_membership(database):
    album = albums.resolve_album('Original', 'A')
    add_track(album_id=album)
    manual([])
    before = state()
    with get_connection() as conn:
        conn.execute('DELETE FROM tracks WHERE id="t"')
    add_track(album_id=None, artist='A')
    assert state() == before
    assert tracks.get_track('t')['album_id'] == album


def test_startup_never_fills_empty_album_artist_or_deletes_empty_album(database):
    album = albums.resolve_album('Unattributed')
    add_track(artist='Track artist', album_id=album)
    empty = albums.resolve_album('Empty')
    manual([], entity_id=album, kind='album')
    schema.init_db()
    assert albums.get_album(album)['album_artist'] is None
    assert albums.get_album(empty) is not None
    assert state('album',album)['artists'] == []


def test_manual_album_merge_conflict_atomic_and_success_preserves_track_credits(database):
    source = albums.resolve_album('Source','A')
    target = albums.resolve_album('Target','B')
    add_track(album_id=source)
    manual(['X'], source, 'album')
    manual(['Y'], target, 'album')
    with pytest.raises(AlbumCreditsConflict):
        albums.merge_album_into(source,target)
    assert tracks.get_track('t')['album_id'] == source
    assert albums.get_album(source) is not None
    manual(['X'], target, 'album')
    albums.merge_album_into(source,target)
    assert tracks.get_track('t')['album_id'] == target
    assert state('album',target)['artists'][0]['name'] == 'X'
    assert state()['artists'][0]['name'] == 'A'
    with get_connection() as conn:
        assert conn.execute("SELECT 1 FROM artist_credit_state WHERE entity_type='album' AND entity_id=?", (str(source),)).fetchone() is None
        assert conn.execute('PRAGMA foreign_key_check').fetchall() == []


def test_explicit_delete_cleans_state_but_keeps_registry_and_other_links(database):
    add_track()
    add_track('other')
    manual(['B'])
    assert tracks.delete_track('t')
    with get_connection() as conn:
        assert conn.execute("SELECT 1 FROM artist_credit_state WHERE entity_id='t' AND entity_type='track'").fetchone() is None
        assert conn.execute('SELECT COUNT(*) FROM artists').fetchone()[0] == 2
    assert state(entity_id='other')['artists'][0]['name'] == 'A'
    album = albums.resolve_album('Empty', 'Album Only')
    albums.delete_empty_albums()
    assert albums.get_album(album) is None
    assert str(album) not in get_credit_states('album',[album])


def test_batch_reads_hydration_and_chunk_query_bound(database):
    conn = get_connection()
    with conn:
        conn.executemany('INSERT INTO tracks(id,file_path,title,artist) VALUES (?,?,?,?)', [(f't{i}',f'{i}.mp3',str(i),f'Artist{i%1000}') for i in range(10001)])
        backfill_artist_credits(conn)
    queries = []
    conn.set_trace_callback(queries.append)
    states = get_credit_states('track', [f't{i}' for i in range(10001)], conn=conn)
    assert len(states) == 10001
    assert len([q for q in queries if q.startswith('SELECT')]) == 52
    rows = [{'id':'t0','artist':'raw','album_id':None}]
    assert hydrate_track_credits(rows,conn=conn)[0]['artist'] == 'Artist0'
    assert rows[0]['artist'] == 'raw'
    conn.close()
    assert len(tracks.get_tracks_by_ids([f't{i}' for i in range(10001)])) == 10001


def test_search_uses_effective_track_and_album_membership_once(database):
    album = albums.resolve_album('Release', 'A')
    add_track(album_id=album)
    manual(['A','Guest'])
    result = tracks.search_all('Guest')
    assert [r['id'] for r in result['tracks']] == ['t']
    assert result['albums'] == []
    assert result['artists'][0]['track_count'] == 1
    assert result['artists'][0]['album_count'] == 0
    manual(['A','Guest'], album, 'album')
    result = tracks.search_all('Guest')
    assert len(result['albums']) == 1
    assert result['artists'][0]['album_count'] == 1


def test_unchanged_import_does_not_bump_catalog(database):
    add_track()
    version = get_catalog_version()
    add_track()
    assert get_catalog_version() == version


def test_existing_long_source_name_id_is_usable_without_truncation(database):
    long_name = 'X'*301
    add_track(artist=long_name)
    with get_connection() as conn:
        result = replace_artist_credits(conn,'track','t',[{'id':artist_id_for_name(long_name)}],expected_revision=1)
    assert result['artists'][0]['name'] == long_name


def test_invalid_large_import_preserves_current_state(database):
    add_track()
    before = state()
    imported('provider',[str(i) for i in range(101)])
    assert state() == before
