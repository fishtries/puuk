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

import uuid
import pytest
from unittest import mock

with mock.patch('qdrant_client.QdrantClient'):
    import db
    import config
    from repositories import share_entities
    from services import media_locations
    from services import track_deletion_service

SYNTHETIC_DIR = Path(__file__).parent / 'fixtures' / 'cdn'
SAMPLE_SYNTHETIC = SYNTHETIC_DIR / 'sample_synthetic.mp3'


@pytest.fixture
def ingest_env(tmp_path, monkeypatch):
    db_path = tmp_path / 'ingest_test.db'
    monkeypatch.setenv('PUUK_DB_PATH', str(db_path))
    monkeypatch.setenv('MUSIC_DIR', str(tmp_path))

    db.init_db()

    audio_file = tmp_path / 'test_track.mp3'
    audio_file.write_bytes(SAMPLE_SYNTHETIC.read_bytes())

    with mock.patch('qdrant_client.QdrantClient') as q, mock.patch('services.media_locations.client.retrieve', return_value=[]):
        q.return_value.retrieve.return_value = []
        yield tmp_path, audio_file


def test_canonical_import_and_repeated_import(ingest_env):
    tmp_path, audio_file = ingest_env
    rel_path = audio_file.name

    # 1. First import: generates canonical UUIDv5 based on rel_path
    row1 = media_locations.ingest_music_file(str(audio_file), source='import')
    assert row1 is not None
    tid1 = row1['id']
    expected_v5 = str(uuid.uuid5(uuid.NAMESPACE_URL, rel_path))
    assert tid1 == expected_v5

    # Check track_path_claims and share_entities
    conn = db.get_connection()
    try:
        claim = conn.execute('SELECT track_id FROM track_path_claims WHERE rel_path=?', (rel_path,)).fetchone()
        assert claim is not None and claim['track_id'] == tid1
        entity = conn.execute("SELECT state FROM share_entities WHERE entity_type='track' AND public_id=?", (tid1,)).fetchone()
        assert entity is not None and entity['state'] == 'active'
    finally:
        conn.close()

    # 2. Repeated import of the exact same path reuses the canonical ID
    row2 = media_locations.ingest_music_file(str(audio_file), source='import')
    assert row2 is not None
    assert row2['id'] == tid1


def test_tombstone_and_same_path_reimport_fresh_id(ingest_env):
    tmp_path, audio_file = ingest_env
    rel_path = audio_file.name

    # Initial import gets UUIDv5
    row = media_locations.ingest_music_file(str(audio_file), source='import')
    orig_id = row['id']

    # Delete track (tombstone)
    db.delete_track(orig_id)

    conn = db.get_connection()
    try:
        # Verify track_path_claims is cleared
        claim = conn.execute('SELECT track_id FROM track_path_claims WHERE rel_path=?', (rel_path,)).fetchone()
        assert claim is None

        # Verify old track ID is marked 'deleted' in share_entities
        entity = conn.execute("SELECT state FROM share_entities WHERE entity_type='track' AND public_id=?", (orig_id,)).fetchone()
        assert entity is not None and entity['state'] == 'deleted'
    finally:
        conn.close()

    # Recovery with deleted ID must be rejected (cannot resurrect tombstone)
    rec_result = media_locations.ingest_music_file(str(audio_file), source='recovery', expected_track_id=orig_id)
    assert rec_result is None

    # Reimport the SAME path after deletion: must NOT reuse the deleted UUIDv5! Must allocate fresh UUIDv4
    reimported = media_locations.ingest_music_file(str(audio_file), source='import')
    assert reimported is not None
    new_id = reimported['id']
    assert new_id != orig_id
    assert uuid.UUID(new_id).version == 4

    # Verify both IDs in share_entities: old is deleted, new is active
    conn = db.get_connection()
    try:
        old_ent = conn.execute("SELECT state FROM share_entities WHERE entity_type='track' AND public_id=?", (orig_id,)).fetchone()
        new_ent = conn.execute("SELECT state FROM share_entities WHERE entity_type='track' AND public_id=?", (new_id,)).fetchone()
        assert old_ent['state'] == 'deleted'
        assert new_ent['state'] == 'active'

        # Live path claim now points to new_id
        live_claim = conn.execute('SELECT track_id FROM track_path_claims WHERE rel_path=?', (rel_path,)).fetchone()
        assert live_claim['track_id'] == new_id
    finally:
        conn.close()


def test_guarded_legacy_upsert_rejects_tombstone(ingest_env):
    tmp_path, audio_file = ingest_env
    rel_path = audio_file.name

    # Import and delete
    row = media_locations.ingest_music_file(str(audio_file), source='import')
    tid = row['id']
    db.delete_track(tid)

    # Calling low-level db.add_or_update_track with tombstoned ID must raise IdentityNotClaimed
    with pytest.raises(share_entities.IdentityNotClaimed):
        db.add_or_update_track(tid, rel_path, 'Title', None, 'Artist')


def test_album_merge_alias_chain(ingest_env):
    tmp_path, audio_file = ingest_env

    # Create albums first
    a1 = db.add_or_get_album('Album Alpha', album_artist='Artist A')
    a2 = db.add_or_get_album('Album Beta', album_artist='Artist B')
    a3 = db.add_or_get_album('Album Gamma', album_artist='Artist C')

    conn = db.get_connection()
    try:
        # Register in share_entities
        share_entities.register(conn, 'album', a1)
        share_entities.register(conn, 'album', a2)
        share_entities.register(conn, 'album', a3)

        # Merge album 1 into album 2 -> creates alias
        share_entities.alias_album(conn, a1, a2)

        # Resolve a1 -> should resolve to a2
        target, status = share_entities.resolve(conn, 'album', a1)
        assert status == 'active'
        assert target == str(a2)

        # Merge album 2 into album 3
        share_entities.alias_album(conn, a2, a3)

        # Resolve a1 -> compressed to a3 in 1 hop
        target1, status1 = share_entities.resolve(conn, 'album', a1)
        assert status1 == 'active'
        assert target1 == str(a3)
        conn.commit()
    finally:
        conn.close()
