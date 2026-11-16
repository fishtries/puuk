import test_db_path  # Must precede app imports.
import os
import tempfile
from pathlib import Path
assert os.environ['PUUK_DB_PATH'].startswith(tempfile.gettempdir()+os.sep)
assert Path(os.environ['PUUK_DB_PATH']).is_absolute()
import sqlite3
_test_database=Path(os.environ['PUUK_DB_PATH']).resolve()
assert _test_database.is_relative_to(Path(tempfile.gettempdir()).resolve())
os.environ['PUUK_DB_PATH']=str(_test_database)
_isolation_connection=sqlite3.connect(_test_database)
try:
    assert Path(_isolation_connection.execute('PRAGMA database_list').fetchone()[2]).resolve()==_test_database
finally:
    _isolation_connection.close()

import uuid
from unittest import mock
import pytest
with mock.patch('qdrant_client.QdrantClient'):
    import db
    from api import app
    from auth import create_access_token
    from metadata import AudioMetadata
    from repositories import share_entities
    from repositories.artist_credits import artist_id_for_name
    from services.media_locations import ingest_music_file,ensure_track_in_db
from starlette.testclient import TestClient


@pytest.fixture
def library(tmp_path,monkeypatch):
    monkeypatch.setenv('PUUK_DB_PATH',str(tmp_path/'identity.db'))
    monkeypatch.setenv('MUSIC_DIR',str(tmp_path))
    db.init_db()
    conn=db.get_connection()
    try:
        assert Path(conn.execute('PRAGMA database_list').fetchone()[2])==tmp_path/'identity.db'
    finally:
        conn.close()
    path=tmp_path/'only-synthetic.mp3'; path.write_bytes(b'ID3 synthetic test fixture')
    def tags(value):
        st=Path(value).stat()
        return AudioMetadata(title='Fixture',artist='Artist',album='Album',album_artist='Artist',duration=2,
            file_size=st.st_size,file_mtime_ns=st.st_mtime_ns)
    with mock.patch('metadata.read_audio_metadata',side_effect=tags),mock.patch('services.media_locations.client.retrieve',return_value=[]):
        yield path


def test_idempotent_migration_and_old_sql(library):
    row=ingest_music_file(library,source='import')
    db.init_db(); db.init_db()
    conn=db.get_connection()
    try:
        assert conn.execute('SELECT id,title,file_path FROM tracks WHERE id=?',(row['id'],)).fetchone()['title']=='Fixture'
        assert conn.execute("SELECT COUNT(*) FROM schema_migrations WHERE version=16").fetchone()[0]==1
        share_entities.backfill(conn); share_entities.backfill(conn); conn.commit()
        assert conn.execute('SELECT COUNT(*) FROM track_path_claims').fetchone()[0]==1
        assert conn.execute("SELECT COUNT(*) FROM share_entities WHERE entity_type='track'").fetchone()[0]==1
    finally:
        conn.close()


def test_reimport_new_identity_and_recovery_rejection(library):
    first=ingest_music_file(library,source='import')
    assert first['id']==str(uuid.uuid5(uuid.NAMESPACE_URL,library.name))
    assert ingest_music_file(library,source='import')['id']==first['id']
    db.delete_track(first['id'])
    second=ingest_music_file(library,source='import')
    assert second['id']!=first['id']
    assert uuid.UUID(second['id']).version==4
    assert ingest_music_file(library,source='import')['id']==second['id']
    assert ensure_track_in_db(first['id'],{'file_path':str(library),'title':'stale'}) is None
    with pytest.raises(share_entities.IdentityNotClaimed):
        db.add_or_update_track(first['id'],library.name,'stale',None,'stale')
    assert db.get_track(second['id'])['title']=='Fixture'


def test_conflict_rolls_back_album_and_legacy_upsert(library):
    first=ingest_music_file(library,source='import')
    before=len(db.get_all_albums())
    assert ingest_music_file(library,source='recovery',expected_track_id=str(uuid.uuid4()),payload={'album':'Should not exist'}) is None
    assert len(db.get_all_albums())==before
    with pytest.raises(share_entities.IdentityNotClaimed):
        db.add_or_update_track(str(uuid.uuid4()),library.name,'Conflict',None,'Conflict')


def test_album_alias_and_empty_artist_profile(library):
    row=ingest_music_file(library,source='import')
    source=row['album_id']; target=db.resolve_album('Target','Artist')
    db.merge_album_into(source,target)
    conn=db.get_connection()
    try:
        assert share_entities.resolve(conn,'album',str(source))==(str(target),'active')
    finally:
        conn.close()
    from repositories.artist_credits import replace_artist_credits,get_credit_states
    conn=db.get_connection()
    try:
        conn.execute('BEGIN IMMEDIATE')
        state=get_credit_states('track',[row['id']],conn=conn)[row['id']]
        replace_artist_credits(conn,'track',row['id'],[],expected_revision=state['revision'])
        state=get_credit_states('album',[target],conn=conn)[str(target)]
        replace_artist_credits(conn,'album',target,[],expected_revision=state['revision'])
        conn.commit()
    finally:
        conn.close()
    from repositories.artists import get_artist_detail
    assert get_artist_detail(artist_id_for_name('Artist'),'')['artist']['track_count']==0
    token=create_access_token(db.get_user_by_username('admin'))
    client=TestClient(app)
    h={'Authorization':'Bearer '+token}
    alias=client.get('/api/share/album/'+str(source),headers=h)
    assert alias.status_code==200 and alias.json()['canonical_id']==str(target)
    empty=client.get('/api/share/artist/'+artist_id_for_name('Artist'),headers=h)
    assert empty.status_code==200 and empty.json()['tracks']==[] and empty.json()['albums']==[]
    client.close()


def test_share_authenticated_filtered_lossless(library):
    row=ingest_music_file(library,source='import')
    user=db.get_user_by_username('admin'); h={'Authorization':'Bearer '+create_access_token(user)}
    c=TestClient(app)
    assert c.get('/api/share/track/'+row['id']).status_code==401
    r=c.get('/api/share/track/'+row['id'],headers=h)
    assert r.status_code==200
    entity=r.json()['entity']
    assert entity['share_id']==row['id'] and entity['album_share_id']==str(row['album_id'])
    assert entity['artists'][0]['share_id']==artist_id_for_name('Artist')
    assert not {'stream_url','file_path','comment','added_by_user_id','lyrics'} & entity.keys()
    assert 'no-store' in r.headers['cache-control']
    assert c.get('/api/share/album/9223372036854775808',headers=h).status_code==400
    db.delete_track(row['id'])
    assert c.get('/api/share/track/'+row['id'],headers=h).status_code==410
    c.close()


def test_scan_startup_and_cli_use_returned_identity(library):
    old=ingest_music_file(library,source='import'); db.delete_track(old['id'])
    from services.library_service import scan_library,sync_missing_tracks_to_db
    scan_library()
    current=ingest_music_file(library,source='import')
    assert current['id']!=old['id']
    with mock.patch('services.media_locations.client.scroll',return_value=([],None)):
        sync_missing_tracks_to_db()
    assert ingest_music_file(library,source='import')['id']==current['id']
    # librosa import is unrelated to canonical ingest and may be costly; installed
    # CLI is imported normally, no execution of its network/main loop.
    import scan
    assert scan._index_scanned_file(library,library.name,old['id'])['id']==current['id']


def test_lossless_album_id_above_javascript_safe_integer(library):
    high=9007199254740993
    conn=db.get_connection()
    try:
        conn.execute("INSERT INTO albums(id,title,title_normalized,album_artist_normalized) VALUES (?,'Huge','huge','')",(high,))
        conn.commit()
    finally:
        conn.close()
    token=create_access_token(db.get_user_by_username('admin'))
    c=TestClient(app)
    r=c.get('/api/share/album/'+str(high),headers={'Authorization':'Bearer '+token})
    assert r.status_code==200
    assert r.json()['entity']['id']==high and r.json()['entity']['share_id']==str(high)
    assert r.json()['canonical_id']==str(high)
    c.close()


def test_alias_chain_and_tombstone_never_revived_by_backfill(library):
    row=ingest_music_file(library,source='import')
    a=row['album_id']; b=db.resolve_album('Second','Artist'); c=db.resolve_album('Third','Artist')
    db.merge_album_into(a,b); db.merge_album_into(b,c)
    conn=db.get_connection()
    try:
        assert share_entities.resolve(conn,'album',str(a))==(str(c),'active')
        assert conn.execute("SELECT target_id FROM share_entities WHERE entity_type='album' AND public_id=?",(str(a),)).fetchone()[0]==str(c)
        share_entities.tombstone(conn,'track',row['id'])
        share_entities.backfill(conn)
        conn.commit()
        assert share_entities.resolve(conn,'track',row['id'])==(None,'deleted')
        assert not conn.execute('SELECT 1 FROM track_path_claims WHERE track_id=?',(row['id'],)).fetchone()
    finally:
        conn.close()


def test_failed_prepared_replaced_journals_block_version_until_reconciliation(library):
    row=ingest_music_file(library,source='import')
    from test_delivery_service import ready
    from repositories import delivery
    ready(row['id'],library)
    assert delivery.ready_version(row['id'],library.stat())
    journal=db.log_mutation_journal(row['id'],'prepared')
    assert delivery.ready_version(row['id'],library.stat()) is None
    for stage in ('replaced','failed'):
        db.update_mutation_journal(journal,stage)
        assert db.get_uncommitted_mutations()
        assert delivery.ready_version(row['id'],library.stat()) is None
    db.update_mutation_journal(journal,'committed')
    assert delivery.ready_version(row['id'],library.stat())


def test_share_entity_expansion_bounds(library):
    row=ingest_music_file(library,source='import')
    conn=db.get_connection()
    try:
        conn.executemany("INSERT INTO tracks(id,file_path,title,album_id) VALUES (?,?,?,?)",
            [(f'bounded-{i}',f'never-read-{i}.mp3','Bounded',row['album_id']) for i in range(5000)])
        conn.commit()
    finally:
        conn.close()
    c=TestClient(app)
    token=create_access_token(db.get_user_by_username('admin'))
    response=c.get('/api/share/album/'+str(row['album_id']),headers={'Authorization':'Bearer '+token})
    assert response.status_code==422 and response.json()['detail']['code']=='entity_too_large'
    c.close()
