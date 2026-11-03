import test_db_path  # noqa: F401
import hashlib
import json
import subprocess
import sys
from pathlib import Path
import pytest
from fastapi import HTTPException
from repositories import schema, tracks
from repositories.base import get_connection, get_catalog_version
from repositories.artist_credits import artist_id_for_name, get_credit_states, replace_artist_credits
from services import artist_credit_bulk_service as bulk

ADMIN = {'id': 1, 'role': 'admin'}

@pytest.fixture
def library(tmp_path, monkeypatch):
    db = tmp_path / 'library.db'
    monkeypatch.setenv('PUUK_DB_PATH', str(db))
    schema.init_db()
    audio = tmp_path / 'audio.mp3'
    audio.write_bytes(b'audio fixture')
    tracks.add_or_update_track('one', str(audio), 'Song', None, 'A/B')
    tracks.add_or_update_track('two', str(tmp_path / 'absent.mp3'), 'Song', None, 'A/B')
    return db, audio

def snapshot(audio):
    s = audio.stat()
    return hashlib.sha256(audio.read_bytes()).hexdigest(), s.st_size, s.st_mtime_ns

def edit(track, names):
    with get_connection() as conn:
        s = get_credit_states('track', [track], conn=conn)[track]
        return replace_artist_credits(conn, 'track', track, [{'name': n} for n in names], expected_revision=s['revision'])

def test_apply_undo_atomic_idempotent_no_audio(library):
    _, audio = library
    before = snapshot(audio)
    source = artist_id_for_name('A/B')
    p = bulk.preview_artist_replacement(source, 'tracks', [{'name':'A'}, {'name':'B'}], ADMIN)
    assert p['matched_count'] == 2 and p['changed_count'] == 2
    applied = bulk.apply_artist_replacement(source, p['operation_id'], ADMIN)
    assert applied == bulk.apply_artist_replacement(source, p['operation_id'], ADMIN)
    edit('two', ['Later'])
    with pytest.raises(HTTPException) as ex: bulk.undo_artist_replacement(source, p['operation_id'], ADMIN)
    assert ex.value.detail['code'] == 'bulk_undo_conflict'
    assert [x['name'] for x in get_credit_states('track',['one'])['one']['artists']] == ['A','B']
    assert snapshot(audio) == before

def test_undo_and_stale_membership(library):
    source = artist_id_for_name('A/B')
    p = bulk.preview_artist_replacement(source, 'tracks', [], ADMIN)
    edit('two', ['C'])
    with pytest.raises(HTTPException) as ex: bulk.apply_artist_replacement(source, p['operation_id'], ADMIN)
    assert ex.value.detail['code'] == 'bulk_selection_changed'
    p = bulk.preview_artist_replacement(source, 'tracks', [], ADMIN)
    applied = bulk.apply_artist_replacement(source, p['operation_id'], ADMIN)
    undone = bulk.undo_artist_replacement(source, p['operation_id'], ADMIN)
    assert undone == bulk.undo_artist_replacement(source, p['operation_id'], ADMIN)
    assert applied == bulk.apply_artist_replacement(source, p['operation_id'], ADMIN)
    assert get_credit_states('track',['one'])['one']['artists'][0]['name'] == 'A/B'

def test_noop_and_auth(library):
    source = artist_id_for_name('A/B')
    p = bulk.preview_artist_replacement(source, 'tracks', [{'id': source}], ADMIN)
    version = get_catalog_version()
    assert bulk.apply_artist_replacement(source, p['operation_id'], ADMIN)['changed_count'] == 0
    assert get_catalog_version() == version
    for user, status in [(None,401), ({'id':2,'role':'user'},403)]:
        with pytest.raises(HTTPException) as ex: bulk.apply_artist_replacement(source, p['operation_id'], user)
        assert ex.value.status_code == status

def test_report_cli_read_only(library, tmp_path, monkeypatch):
    db, audio = library
    before = snapshot(audio)
    output = tmp_path / 'report.json'
    result = subprocess.run([sys.executable, 'reconcile_artist_credits.py', 'report', '--json', str(output)], cwd=Path(__file__).resolve().parent, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    data = json.loads(output.read_text())
    assert data['proposals'] and all(p['ambiguity'] == 'ambiguous' and p['before'] == p['after'] for p in data['proposals'])
    human = subprocess.run([sys.executable, 'reconcile_artist_credits.py'], cwd=Path(__file__).resolve().parent, capture_output=True, text=True)
    assert human.returncode == 0 and 'ambiguous' in human.stdout
    assert snapshot(audio) == before

def test_splice_order_dedup_and_stale_revision(library):
    source = artist_id_for_name('A/B')
    edit('one', ['X', 'A/B', 'A', 'C'])
    p = bulk.preview_artist_replacement(source, 'tracks', [{'name':'A'}, {'name':'B'}], ADMIN)
    one = next(e for e in p['entries'] if e['entity_id'] == 'one')
    assert [a['name'] for a in one['after']] == ['X', 'A', 'B', 'C']
    edit('one', ['Y', 'A/B'])
    with pytest.raises(HTTPException) as ex:
        bulk.apply_artist_replacement(source, p['operation_id'], ADMIN)
    assert ex.value.detail['code'] == 'bulk_revision_conflict'
    assert [a['name'] for a in get_credit_states('track',['two'])['two']['artists']] == ['A/B']


def test_result_overflow_and_no_match(library):
    source = artist_id_for_name('A/B')
    edit('one', ['A/B'] + [f'Name{i}' for i in range(99)])
    with pytest.raises(HTTPException) as ex:
        bulk.preview_artist_replacement(source, 'tracks', [{'name':'A'}, {'name':'B'}], ADMIN)
    assert ex.value.detail['code'] == 'bulk_result_too_large'
    edit('one', ['Other'])
    edit('two', ['Other'])
    p = bulk.preview_artist_replacement(source, 'tracks', [], ADMIN)
    assert p['matched_count'] == 0
    assert bulk.apply_artist_replacement(source, p['operation_id'], ADMIN)['changed_count'] == 0


def test_report_requires_confirmation_and_hash(library):
    from reconcile_artist_credits import report
    proposal = report(library[0])['proposals'][0]
    with pytest.raises(HTTPException) as ex:
        bulk.preview_artist_report({'version':1,'proposals':[proposal]}, [proposal['id']], ADMIN)
    assert ex.value.detail['code'] == 'ambiguous_proposal'
    proposal['ambiguity'] = 'confirmed'
    with pytest.raises(HTTPException) as ex:
        bulk.preview_artist_report({'version':1,'proposals':[proposal]}, [proposal['id']], ADMIN)
    assert ex.value.detail['code'] == 'invalid_report'

def test_scope_limit_real_membership(library):
    source = artist_id_for_name('A/B')
    with get_connection() as conn:
        conn.executemany('INSERT INTO tracks(id,file_path,title,artist) VALUES (?,?,?,?)',
                         [(f'extra{i}', f'/absent/{i}', 'Song', 'A/B') for i in range(4999)])
        conn.executemany('INSERT INTO track_artists(track_id,artist_id,position) VALUES (?,?,0)',
                         [(f'extra{i}', source) for i in range(4999)])
    with pytest.raises(HTTPException) as ex:
        bulk.preview_artist_replacement(source, 'tracks', [], ADMIN)
    assert ex.value.detail['code'] == 'bulk_scope_too_large'


def test_undo_preserves_source_and_observed(library):
    source = artist_id_for_name('A/B')
    p = bulk.preview_artist_replacement(source, 'tracks', [{'name':'A'}], ADMIN)
    bulk.apply_artist_replacement(source, p['operation_id'], ADMIN)
    with get_connection() as conn:
        conn.execute("UPDATE artist_credit_state SET observed_kind='tags', observed_names_json='[\"Observed\"]' WHERE entity_type='track' AND entity_id='one'")
        row = conn.execute("SELECT source_kind,source_names_json FROM artist_credit_state WHERE entity_type='track' AND entity_id='one'").fetchone()
        before = tuple(row)
    bulk.undo_artist_replacement(source, p['operation_id'], ADMIN)
    with get_connection() as conn:
        row = conn.execute("SELECT source_kind,source_names_json,observed_kind,observed_names_json FROM artist_credit_state WHERE entity_type='track' AND entity_id='one'").fetchone()
        assert tuple(row[:2]) == before
        assert tuple(row[2:]) == ('tags', '["Observed"]')


def test_added_membership_invalidates_preview(library):
    source = artist_id_for_name('A/B')
    p = bulk.preview_artist_replacement(source, 'tracks', [], ADMIN)
    tracks.add_or_update_track('three', '/absent/three', 'Song', None, 'A/B')
    with pytest.raises(HTTPException) as ex:
        bulk.apply_artist_replacement(source, p['operation_id'], ADMIN)
    assert ex.value.detail['code'] == 'bulk_selection_changed'

def test_deleted_member_and_retained_source(library):
    source = artist_id_for_name('A/B')
    p = bulk.preview_artist_replacement(source, 'tracks', [{'id':source}, {'name':'B'}], ADMIN)
    assert [a['name'] for a in p['entries'][0]['after']] == ['A/B','B']
    with get_connection() as conn:
        conn.execute("DELETE FROM tracks WHERE id='two'")
    with pytest.raises(HTTPException) as ex:
        bulk.apply_artist_replacement(source, p['operation_id'], ADMIN)
    assert ex.value.detail['code'] == 'bulk_selection_changed'


def test_confirmed_report_application(library):
    from reconcile_artist_credits import report
    p = report(library[0])['proposals'][0]
    p['ambiguity'] = 'confirmed'
    p['evidence'] = 'Reviewed provider listing'
    p['after'] = [{'id':artist_id_for_name('A'),'name':'A'}]
    p.pop('id')
    p['id'] = hashlib.sha256(json.dumps(p, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    preview = bulk.preview_artist_report({'version':1,'proposals':[p]}, [p['id']], ADMIN)
    result = bulk.apply_artist_replacement(None, preview['operation_id'], ADMIN)
    assert result['changed_count'] == 1
    assert bulk.undo_artist_replacement(None, preview['operation_id'], ADMIN)['changed_count'] == 1


def test_busy_returns_contract_response_and_rolls_back(library, monkeypatch):
    import sqlite3

    db, _ = library
    source = artist_id_for_name('A/B')
    before = get_credit_states('track', ['one', 'two'])
    lock = get_connection()
    lock.execute('BEGIN IMMEDIATE')

    def immediate_connection():
        conn = sqlite3.connect(db, timeout=0)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        return conn

    monkeypatch.setattr(bulk, 'get_connection', immediate_connection)
    try:
        with pytest.raises(HTTPException) as exc:
            bulk.preview_artist_replacement(source, 'tracks', [{'name': 'A'}], ADMIN)
        assert exc.value.status_code == 503
        assert exc.value.detail == {'code': 'credits_busy', 'message': 'База занята'}
        assert exc.value.headers == {'Retry-After': '1'}
    finally:
        lock.rollback()
        lock.close()
    assert get_credit_states('track', ['one', 'two']) == before
    with get_connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM artist_credit_operations').fetchone()[0] == 0


def test_album_bulk_keeps_track_credits_and_audio(library, tmp_path):
    from repositories import albums
    from repositories.artist_credits import hydrate_album_credits

    _, audio = library
    second_audio = tmp_path / 'second.mp3'
    second_audio.write_bytes(b'another audio fixture')
    album_id = albums.resolve_album('Joint release', 'A/B')
    tracks.add_or_update_track('album-one', str(audio), 'One', album_id, 'Track Artist')
    tracks.add_or_update_track('album-two', str(second_audio), 'Two', album_id, 'Guest')
    before_audio = [snapshot(audio), snapshot(second_audio)]
    before_tracks = get_credit_states('track', ['album-one', 'album-two'])
    source = artist_id_for_name('A/B')
    preview = bulk.preview_artist_replacement(source, 'albums', [{'name': 'A'}, {'name': 'B'}], ADMIN)
    assert preview['matched_count'] == preview['changed_count'] == 1
    assert preview['entries'][0]['entity_id'] == str(album_id)
    assert [a['name'] for a in preview['entries'][0]['after']] == ['A', 'B']

    result = bulk.apply_artist_replacement(source, preview['operation_id'], ADMIN)
    assert result['affected']['album_ids'] == [album_id]
    assert result['affected']['track_ids'] == ['album-one', 'album-two']
    album = hydrate_album_credits([albums.get_album(album_id)])[0]
    assert [a['name'] for a in album['artists']] == ['A', 'B']
    assert get_credit_states('track', ['album-one', 'album-two']) == before_tracks
    album_tracks = albums.get_album_tracks(album_id)
    assert {row['id']: row['artist'] for row in album_tracks} == {'album-one': 'Track Artist', 'album-two': 'Guest'}
    assert all([a['name'] for a in row['album_artists']] == ['A', 'B'] for row in album_tracks)
    assert [snapshot(audio), snapshot(second_audio)] == before_audio

    undone = bulk.undo_artist_replacement(source, preview['operation_id'], ADMIN)
    assert undone['affected']['track_ids'] == ['album-one', 'album-two']
    assert [a['name'] for a in hydrate_album_credits([albums.get_album(album_id)])[0]['artists']] == ['A/B']
    assert get_credit_states('track', ['album-one', 'album-two']) == before_tracks
    assert [snapshot(audio), snapshot(second_audio)] == before_audio
