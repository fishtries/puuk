import test_db_path  # Must precede config/app imports.
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

import asyncio
import hashlib
import json
import subprocess
import threading
import time
import uuid
from unittest import mock
import pytest

# Prevent import-time Qdrant compatibility probes and all external IO.
with mock.patch('qdrant_client.QdrantClient'):
    import db
    import config
    from api import app
    from auth import create_access_token, create_media_ticket
    from services import delivery_service as service
    from repositories import delivery
from starlette.testclient import TestClient


@pytest.fixture
def catalog(tmp_path,monkeypatch):
    db_path=tmp_path/'catalog.db'
    monkeypatch.setenv('PUUK_DB_PATH',str(db_path))
    monkeypatch.setenv('MUSIC_DIR',str(tmp_path))
    monkeypatch.setattr(config,'CDN_DELIVERY_ENABLED',False)
    monkeypatch.setattr(config,'CDN_ORIGIN_ENABLED',False)
    monkeypatch.setattr(config,'CDN_PURGE_ENABLED',False)
    monkeypatch.setattr(config,'CDN_SIGNING_SECRET','aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV')
    monkeypatch.setattr(config,'CDN_ORIGIN_SECRET','a1'*32)
    db.init_db()
    conn=db.get_connection()
    try:
        assert Path(conn.execute('PRAGMA database_list').fetchone()[2])==db_path
    finally:
        conn.close()
    path=tmp_path/'synthetic.mp3'; data=bytes(range(256))*20; path.write_bytes(data)
    tid=str(uuid.uuid4())
    db.add_or_update_track(tid,path.name,'Synthetic',None,'Synthetic artist')
    user=db.get_user_by_username('admin')
    token=create_access_token(user)
    headers={'Authorization':'Bearer '+token}
    client=TestClient(app)
    with mock.patch('qdrant_client.QdrantClient') as q, mock.patch('services.media_locations.client.retrieve',return_value=[]):
        q.return_value.retrieve.return_value=[]
        yield client,tid,path,data,user,headers
    client.close()


def ready(tid,path):
    st=path.stat()
    digest=hashlib.sha256(path.read_bytes()).hexdigest()
    with delivery.transaction() as conn:
        conn.execute("""INSERT INTO delivery_versions(track_id,state,content_version,fingerprint,content_length)
            VALUES (?,'ready',?,?,?) ON CONFLICT(track_id) DO UPDATE SET state='ready',content_version=excluded.content_version,
            fingerprint=excluded.fingerprint,content_length=excluded.content_length""",(tid,digest,json.dumps(delivery.fingerprint(st),separators=(',',':')),st.st_size))
    return digest


def origin(tid,digest):
    return f'/cdn/audio/{tid}/{digest}?md5='+('A'*22)+'&expires=1999999999'


def test_signer_independent_openssl():
    path='/cdn/audio/00000000-0000-0000-0000-000000000001/v1'
    message=b'1763251200'+path.encode()+b' k7W9xP2mQ5vL8nJ1'
    raw=subprocess.run(['openssl','dgst','-md5','-binary'],input=message,capture_output=True,check=True).stdout
    import base64
    oracle=base64.urlsafe_b64encode(raw).decode().rstrip('=')
    assert oracle=='NcMUu1kyDzVaG8fx-u-7WQ'
    assert service.sign_path(path,1763251200,'k7W9xP2mQ5vL8nJ1')==oracle
    assert service.sign_path(path+'x',1763251200,'k7W9xP2mQ5vL8nJ1')!=oracle


def test_ticket_reads_one_file_version_before_returning_the_stream_url(catalog):
    client, tid, path, _, _, headers = catalog
    digest = ready(tid, path)
    with mock.patch.object(service, 'open_safe', wraps=service.open_safe) as open_file:
        response = client.post('/api/media-ticket', json={'track_id': tid}, headers=headers)
    assert response.status_code == 200
    assert response.json()['content_version'] == digest
    assert response.json()['content_length'] == path.stat().st_size
    open_file.assert_called_once()


def test_disabled_legacy_and_scope(catalog):
    c,tid,path,data,user,h=catalog
    r=c.post('/api/media-ticket',json={'track_id':tid.upper(),'ignored':True},headers=h)
    assert r.status_code==200
    dto=r.json(); assert dto['delivery']=='direct'; assert dto['expires_in']==600
    assert dto['content_version'] is None and dto['download_binding'] is None
    assert tid in dto['url']
    assert c.get(dto['url']).content==data
    assert c.get('/api/stream/'+tid,headers=h).content==data
    assert c.head('/api/stream/'+tid,headers=h).content==b''
    mt=dto['url'].split('mt=')[1]
    assert c.post('/api/media-ticket',json={'track_id':tid},headers={'Authorization':'Bearer '+mt}).status_code==401
    assert c.get('/api/share/track/'+tid,headers={'Authorization':'Bearer '+mt}).status_code==401


@pytest.mark.parametrize('method,url,body,status',[
    ('post','/api/media-ticket',{'track_id':'bad'},401),
    ('post','/api/media-ticket',{},422),
    ('get','/api/stream/bad',None,400),
    ('get','/api/stream/unknown/extra',None,404),
    ('post','/api/stream/unknown',None,405),
])
def test_assembled_error_policy(catalog,method,url,body,status):
    c,tid,path,data,user,h=catalog
    # First row intentionally unauthenticated, remaining rows exercise validation.
    headers={'Origin':'https://web.puuk.fun',**(h if status!=401 else {})}
    r=c.request(method,url,json=body,headers=headers)
    assert r.status_code==status
    assert 'no-store' in r.headers['cache-control']
    assert r.headers['access-control-allow-origin']=='https://web.puuk.fun'
    assert 'access-control-allow-credentials' not in r.headers


def test_boundary_preflight_secret_order_and_account_policy(catalog,monkeypatch):
    c,tid,path,data,user,h=catalog
    url=origin(tid,'a'*64)
    headers={'Origin':'https://web.puuk.fun','Access-Control-Request-Method':'GET'}
    assert c.options(url,headers=headers).status_code==404
    monkeypatch.setattr(config,'CDN_ORIGIN_ENABLED',True)
    assert c.options(url,headers=headers).status_code==403
    headers['X-Puuk-Origin-Secret']=config.CDN_ORIGIN_SECRET
    r=c.options(url,headers=headers)
    assert r.status_code==204 and not r.content
    assert 'access-control-allow-credentials' not in r.headers
    assert c.options('/api/auth/login',headers={**headers,'Access-Control-Request-Method':'POST'}).headers['access-control-allow-credentials']=='true'
    assert c.options(url,headers={**headers,'Origin':'https://evil.invalid'}).status_code==403
    duplicates=list(headers.items())+[('X-Puuk-Origin-Secret',config.CDN_ORIGIN_SECRET)]
    assert c.options(url,headers=duplicates).status_code==403


@pytest.mark.parametrize('suffix',['&v=1','&md5='+('B'*22),'&expires=1999999999','&mt=canary',';v=1','&%76=1'])
def test_origin_query_rejects(catalog,monkeypatch,suffix):
    c,tid,path,data,user,h=catalog
    monkeypatch.setattr(config,'CDN_ORIGIN_ENABLED',True)
    digest=ready(tid,path)
    r=c.get(origin(tid,digest)+suffix,headers={'X-Puuk-Origin-Secret':config.CDN_ORIGIN_SECRET})
    assert r.status_code==400 and r.content!=data


def test_pinned_range_head_conditional(catalog,monkeypatch):
    c,tid,path,data,user,h=catalog
    monkeypatch.setattr(config,'CDN_ORIGIN_ENABLED',True)
    digest=ready(tid,path); url=origin(tid,digest)
    h={'X-Puuk-Origin-Secret':config.CDN_ORIGIN_SECRET,'Origin':'https://web.puuk.fun'}
    etag='"sha256-'+digest+'"'
    for value,start,end in [('bytes=0-9',0,10),('bytes=12-22',12,23),('bytes=-9',len(data)-9,len(data)),('bytes=5110-',5110,len(data))]:
        r=c.get(url,headers={**h,'Range':value})
        assert r.status_code==206 and r.content==data[start:end]
        assert r.headers['content-range']==f'bytes {start}-{end-1}/{len(data)}'
    r=c.get(url,headers={**h,'Range':'bytes=0-2,20-22'})
    assert r.status_code==206 and len(r.content)==int(r.headers['content-length'])
    assert b'Content-Range: bytes 0-2/5120' in r.content and data[20:23] in r.content
    assert c.get(url,headers={**h,'Range':'bytes=9000-'}).status_code==416
    assert c.get(url,headers={**h,'Range':'garbage'}).status_code==400
    assert c.get(url,headers={**h,'Range':'bytes=0-9','If-Range':etag}).status_code==206
    assert c.get(url,headers={**h,'Range':'bytes=0-9','If-Range':'"other"'}).status_code==200
    r=c.head(url,headers={**h,'Range':'bytes=0-9'})
    assert r.status_code==200 and not r.content and int(r.headers['content-length'])==len(data)
    assert c.get(url,headers={**h,'If-None-Match':etag}).status_code==304
    assert c.get(url,headers={'If-None-Match':etag}).status_code==403


@pytest.mark.parametrize('validator',['*','W/"sha256-x"','"sha256-x", "sha256-y"','"bad"'])
def test_if_match_rejects_malformed(catalog,validator):
    c,tid,path,data,user,h=catalog
    ready(tid,path)
    r=c.get('/api/stream/'+tid,headers={**h,'If-Match':validator})
    assert r.status_code==412 and r.content!=data


def test_replace_before_pin_and_after_pin(catalog):
    c,tid,path,data,user,h=catalog
    digest=ready(tid,path)
    validator='"sha256-'+digest+'"'
    assert c.get('/api/stream/'+tid,headers={**h,'If-Match':validator}).content==data
    assert c.get('/api/stream/'+tid,headers={**h,'If-Match':validator,'Range':'bytes=0-1'}).status_code==412
    from starlette.requests import Request
    request=Request({'type':'http','method':'GET','path':'/api/stream/'+tid,'query_string':b'', 'headers':[(k.lower().encode(),v.encode()) for k,v in h.items()]+[(b'if-match',validator.encode())]})
    response=service.stream(request,tid,time.monotonic()+2.5,threading.Event())
    replacement=path.with_suffix('.next'); replacement.write_bytes(b'B'*len(data)); os.replace(replacement,path)
    messages=[]
    async def run():
        wait=asyncio.Event()
        async def receive():
            await wait.wait()
        async def send(msg):
            messages.append(msg)
        await response(request.scope,receive,send)
    asyncio.run(run())
    assert b''.join(m.get('body',b'') for m in messages)==data
    assert response._closed
    assert c.get('/api/stream/'+tid,headers={**h,'If-Match':validator}).status_code==412
    assert c.get('/api/stream/'+tid,headers=h).content==b'B'*len(data)


def test_pilot_exposure_requires_healthy_purge(catalog,monkeypatch):
    c,tid,path,data,user,h=catalog
    ready(tid,path)
    monkeypatch.setattr(config,'CDN_DELIVERY_ENABLED',True)
    monkeypatch.setattr(config,'CDN_ORIGIN_ENABLED',True)
    monkeypatch.setattr(config,'CDN_PILOT_USER_IDS',frozenset())
    monkeypatch.setattr(config,'CDN_PURGE_ENABLED',True)
    monkeypatch.setattr(config,'CDN_RESOURCE_ID','synthetic')
    monkeypatch.setattr(config,'CDN_PURGE_TOKEN','synthetic')
    with delivery.transaction() as conn:
        conn.execute("INSERT INTO delivery_control(key,value) VALUES ('purge_heartbeat',?)",(str(time.time()),))
    assert c.post('/api/media-ticket',headers=h,json={'track_id':tid,'delivery':'cdn'}).json()['delivery']=='direct'
    monkeypatch.setattr(config,'CDN_PILOT_USER_IDS',frozenset([user['id']]))
    dto=c.post('/api/media-ticket',headers=h,json={'track_id':tid,'delivery':'cdn'}).json()
    assert dto['delivery']=='cdn' and dto['download_binding']=='immutable-path'
    with delivery.transaction() as conn:
        assert conn.execute('SELECT COUNT(*) FROM delivery_exposures').fetchone()[0]==1
    monkeypatch.setattr(config,'CDN_PURGE_ENABLED',False)
    assert c.post('/api/media-ticket',headers=h,json={'track_id':tid,'delivery':'cdn'}).json()['delivery']=='direct'


def test_hash_real_child_and_flock(catalog):
    c,tid,path,data,user,h=catalog
    from services.content_version_service import HashSupervisor
    delivery.enqueue(tid)
    owner=HashSupervisor(); other=HashSupervisor()
    assert owner.start()
    try:
        assert not other.start()
        end=time.monotonic()+8
        while time.monotonic()<end:
            row=delivery.get_version(tid)
            if row and row['state']=='ready':
                break
            time.sleep(.03)
        assert row['state']=='ready'
        assert row['content_version']==hashlib.sha256(data).hexdigest()
    finally:
        assert owner.shutdown()


def test_bounded_lanes_late_result(catalog):
    c,tid,path,data,user,h=catalog
    from starlette.requests import Request
    owner=service.DeliveryExecutor(); gate=threading.Event(); entered=threading.Barrier(5)
    async def run():
        def blocking(deadline,cancel):
            entered.wait(timeout=2); gate.wait(timeout=2)
            return {'late':True}
        requests=[Request({'type':'http','headers':[],'delivery_deadline':time.monotonic()+.15}) for _ in range(4)]
        tasks=[asyncio.create_task(owner.run(r,blocking)) for r in requests]
        await asyncio.to_thread(entered.wait,2)
        with pytest.raises(HTTPException) as err:
            await owner.run(Request({'type':'http','headers':[]}),lambda d,c:None)
        assert err.value.status_code==503
        results=await asyncio.gather(*tasks,return_exceptions=True)
        assert all(isinstance(r,HTTPException) and r.status_code==503 for r in results)
        assert not owner.lanes.acquire(blocking=False)
        gate.set()
        assert await owner.shutdown()
    from fastapi import HTTPException
    asyncio.run(run())


def test_exposure_only_capacity_and_drain(catalog,monkeypatch):
    c,tid,path,data,user,h=catalog
    digest=ready(tid,path)
    monkeypatch.setattr(delivery,'CAPACITY',0)
    delivery.invalidate(tid)  # Direct-only mutation never requires optional capacity.
    with delivery.transaction() as conn:
        assert conn.execute('SELECT COUNT(*) FROM cdn_purge_outbox').fetchone()[0]==0
        delivery.expose(conn,tid,digest,int(time.time())+100)
    with pytest.raises(TimeoutError):
        delivery.invalidate(tid,deleting=True)
    from repositories.share_entities import recovery_allowed
    assert recovery_allowed(tid)
    with delivery.transaction() as conn:
        conn.execute('UPDATE delivery_exposures SET max_expires_at=?',(int(time.time())-4000,))
    delivery.invalidate(tid,deleting=True)
    assert not recovery_allowed(tid)


def test_purge_restart_polling_failure_and_drain(catalog):
    c,tid,path,data,user,h=catalog
    from services.cdn_purge_service import PurgeSupervisor
    digest=ready(tid,path)
    with delivery.transaction() as conn:
        delivery.expose(conn,tid,digest,int(time.time())+100)
    delivery.invalidate(tid)
    one=PurgeSupervisor()
    with mock.patch.object(one,'run_child',return_value={'status':'polling','operation_id':'synthetic-operation'}) as call:
        one.tick()
        assert call.call_count==1
    with delivery.transaction() as conn:
        row=dict(conn.execute('SELECT * FROM cdn_purge_outbox').fetchone())
        assert row['state']=='polling' and row['attempts']==1 and row['operation_id']=='synthetic-operation'
        conn.execute('UPDATE cdn_purge_outbox SET next_attempt_at=0,lease_until=0')
    # Restart reclaims only after actual flock acquisition in lifecycle; test tick
    # exercises durable persisted operation and fence replacement independently.
    two=PurgeSupervisor()
    with mock.patch.object(two,'run_child',return_value={'status':'terminal','reason':'provider_rejected'}) as call:
        two.tick()
        assert call.call_count==1
    with delivery.transaction() as conn:
        row=dict(conn.execute('SELECT * FROM cdn_purge_outbox').fetchone())
        assert row['state']=='failed' and row['attempts']==1
        conn.execute('UPDATE cdn_purge_outbox SET drain_until=0')
        delivery.drain_expired(conn)
        assert conn.execute('SELECT state FROM cdn_purge_outbox').fetchone()[0]=='drained'


def test_purge_ambiguous_submission_is_rate_limited(catalog):
    c,tid,path,data,user,h=catalog
    from services.cdn_purge_service import PurgeSupervisor
    digest=ready(tid,path)
    with delivery.transaction() as conn:
        delivery.expose(conn,tid,digest,int(time.time())+100)
    delivery.invalidate(tid)
    one=PurgeSupervisor()
    with mock.patch.object(one,'run_child',side_effect=TimeoutError()):
        one.tick()
    with delivery.transaction() as conn:
        row=dict(conn.execute('SELECT * FROM cdn_purge_outbox').fetchone())
        assert row['state']=='pending' and row['reason']=='ambiguous_submission'
        assert row['attempts']==1 and row['next_attempt_at']>=time.time()+60
        assert float(conn.execute("SELECT value FROM delivery_control WHERE key='purge_next_submission'").fetchone()[0])>=time.time()+60
    with mock.patch.object(one,'run_child') as call:
        one.tick()
        call.assert_not_called()


def test_track_and_database_lock_budgets(catalog):
    c,tid,path,data,user,h=catalog
    from metadata import track_mutation_lock
    entered=threading.Event(); release=threading.Event()
    def hold():
        with track_mutation_lock(tid,str(path.parent)):
            entered.set(); release.wait(3)
    thread=threading.Thread(target=hold); thread.start(); entered.wait(1)
    start=time.monotonic()
    try:
        r=c.get('/api/stream/'+tid,headers=h)
        assert r.status_code==503 and time.monotonic()-start<1
    finally:
        release.set(); thread.join(2)
    conn=db.get_connection(); conn.execute('BEGIN IMMEDIATE')
    start=time.monotonic()
    try:
        # Unknown preparation causes one short write, never the legacy 5s wait.
        r=c.post('/api/media-ticket',json={'track_id':tid},headers=h)
        assert r.status_code==503 and time.monotonic()-start<1
    finally:
        conn.rollback(); conn.close()


def test_unhandled_failure_and_redaction(catalog):
    c,tid,path,data,user,h=catalog
    canary='SECRET_CANARY_signed_url_and_filename'
    with mock.patch.object(service,'_track',side_effect=RuntimeError(canary)):
        r=c.get('/api/stream/'+tid,headers={**h,'Origin':'https://web.puuk.fun'})
    assert r.status_code==500
    assert canary not in r.text and 'no-store' in r.headers['cache-control']
    assert r.headers['access-control-allow-origin']=='https://web.puuk.fun'
    r=c.post('/api/media-ticket',content=b'x'*4097,headers=h)
    assert r.status_code==413 and r.headers['pragma']=='no-cache'


def test_actual_child_timeout_reap_and_inherited_owner(catalog):
    c,tid,path,data,user,h=catalog
    import fcntl
    from services.content_version_service import OwnerSupervisor
    owner=OwnerSupervisor('hash')
    lock=path.parent/'inherited-owner.lock'
    owner.owner_fd=os.open(lock,os.O_CREAT|os.O_RDWR,0o600)
    fcntl.flock(owner.owner_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    try:
        start=time.monotonic()
        with pytest.raises(TimeoutError):
            owner.run_child('timeit',['-n','1','-r','1','-s','import time','time.sleep(30)'],budget=.15,limit=512)
        assert owner.child is None and time.monotonic()-start<5.5
        other=os.open(lock,os.O_RDWR)
        try:
            with pytest.raises(BlockingIOError):
                fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
        finally:
            os.close(other)
    finally:
        os.close(owner.owner_fd)


def test_retirement_during_purge_requires_another_operation(catalog):
    c,tid,path,data,user,h=catalog
    from services.cdn_purge_service import PurgeSupervisor
    digest=ready(tid,path)
    with delivery.transaction() as conn:
        delivery.expose(conn,tid,digest,int(time.time())+100)
    delivery.invalidate(tid)
    owner=PurgeSupervisor()
    with mock.patch.object(owner,'run_child',return_value={'status':'polling','operation_id':'first-operation'}):
        owner.tick()
    # Another destructive mutation occurs after provider submission.
    delivery.invalidate(tid)
    with delivery.transaction() as conn:
        conn.execute('UPDATE cdn_purge_outbox SET next_attempt_at=0')
    with mock.patch.object(owner,'run_child',return_value={'status':'succeeded','operation_id':'first-operation'}):
        owner.tick()
    with delivery.transaction() as conn:
        row=conn.execute('SELECT * FROM cdn_purge_outbox').fetchone()
        assert row['state']=='pending' and row['reason']=='changed_during_operation'
        assert row['revision']>row['submitted_revision']


def test_same_path_cleanup_does_not_delete_new_owner(catalog):
    c,tid,path,data,user,h=catalog
    from services.track_deletion_service import delete_track_everywhere
    from services.media_locations import ingest_music_file
    from metadata import AudioMetadata
    delivery.invalidate(tid,deleting=True)  # interrupted old deletion
    st=path.stat()
    with mock.patch('metadata.read_audio_metadata',return_value=AudioMetadata(title='New',artist='New',file_size=st.st_size,file_mtime_ns=st.st_mtime_ns)):
        new=ingest_music_file(str(path),source='import')
    assert new['id']!=tid
    with mock.patch('services.track_deletion_service.qdrant_client'):
        result=delete_track_everywhere(tid,user)
    assert result['file_deleted'] is False and path.read_bytes()==data
    assert db.get_track(new['id']) is not None


@pytest.mark.parametrize('variant',['percent','uppercase','slash','extra','backslash','query_alias','query_zero'])
def test_raw_origin_noncanonical_requests(catalog,monkeypatch,variant):
    c,tid,path,data,user,h=catalog
    monkeypatch.setattr(config,'CDN_ORIGIN_ENABLED',True)
    digest=ready(tid,path)
    canonical=f'/cdn/audio/{tid}/{digest}'
    raw=canonical.encode(); query=b'md5='+b'A'*22+b'&expires=1999999999'
    if variant=='percent': raw=raw.replace(b'/cdn/',b'/%63dn/')
    elif variant=='uppercase': raw=raw.upper()
    elif variant=='slash': raw+=b'/'
    elif variant=='extra': raw+=b'/extra'
    elif variant=='backslash': raw=raw.replace(b'/audio/',b'/audio\\')
    elif variant=='query_alias': query=query.replace(b'md5',b'%6dd5')
    elif variant=='query_zero': query=query.replace(b'1999999999',b'0199999999')
    messages=[]
    async def run():
        sent=False
        forever=asyncio.Event()
        async def receive():
            nonlocal sent
            if not sent:
                sent=True
                return {'type':'http.request','body':b''}
            await forever.wait()
        async def send(message): messages.append(message)
        scope={'type':'http','asgi':{'version':'3.0'},'method':'GET','scheme':'https','http_version':'1.1',
            'path':canonical,'raw_path':raw,'query_string':query,'root_path':'',
            'server':('test',443),'client':('test',123),'headers':[(b'x-puuk-origin-secret',config.CDN_ORIGIN_SECRET.encode())]}
        await app(scope,receive,send)
    asyncio.run(run())
    assert messages[0]['status']==400
    assert b''.join(m.get('body',b'') for m in messages)!=data


def test_stream_capacity_and_late_read_holds_descriptor(catalog):
    c,tid,path,data,user,h=catalog
    from starlette.requests import Request
    request=Request({'type':'http','method':'GET','path':'/api/stream/'+tid,'query_string':b'',
        'headers':[(k.lower().encode(),v.encode()) for k,v in h.items()]})
    pinned=[]
    try:
        for _ in range(16):
            pinned.append(service.stream(request,tid,time.monotonic()+2,threading.Event()))
        assert c.head('/api/stream/'+tid,headers=h).status_code==503
    finally:
        for response in pinned: response.close()
    response=service.stream(request,tid,time.monotonic()+2,threading.Event())
    held=threading.Event(); release=threading.Event(); real_pread=os.pread
    def blocked_read(fd,size,offset):
        held.set(); release.wait(3)
        return real_pread(fd,size,offset)
    async def run():
        with mock.patch('os.pread',side_effect=blocked_read):
            task=asyncio.create_task(response.read(0,10))
            await asyncio.to_thread(held.wait,1)
            response.close()
            assert not response._closed
            os.fstat(response.fd)  # Descriptor still owned by the blocking read.
            release.set()
            await asyncio.gather(task,return_exceptions=True)
        assert response._closed
    asyncio.run(run())


def test_cancelled_transaction_rolls_back_and_closes(catalog):
    c,tid,path,data,user,h=catalog
    from repositories.base import deadline_context
    cancel=threading.Event()
    with pytest.raises(TimeoutError):
        with deadline_context(time.monotonic()+1,cancel), delivery.transaction() as conn:
            conn.execute("INSERT INTO delivery_control(key,value) VALUES ('late-test','never')")
            cancel.set()
    with delivery.transaction() as conn:
        assert conn.execute("SELECT 1 FROM delivery_control WHERE key='late-test'").fetchone() is None
        conn.execute("INSERT INTO delivery_control(key,value) VALUES ('after-cancel','works')")


def test_hash_late_fence_discards_result(catalog):
    c,tid,path,data,user,h=catalog
    from services.content_version_service import HashSupervisor
    digest=ready(tid,path)
    delivery.invalidate(tid)
    owner=HashSupervisor()
    def superseded(*args,**kwargs):
        delivery.invalidate(tid)
        return {'hash':digest,'fingerprint':delivery.fingerprint(path.stat())}
    with mock.patch.object(owner,'run_child',side_effect=superseded):
        owner.tick()
    assert delivery.get_version(tid)['state']=='pending'


def test_child_retains_flock_after_supervisor_fd_closes(catalog):
    c,tid,path,data,user,h=catalog
    import fcntl
    from services.content_version_service import OwnerSupervisor
    owner=OwnerSupervisor('hash')
    lock=path.parent/'retained-owner.lock'
    owner.owner_fd=os.open(lock,os.O_CREAT|os.O_RDWR,0o600)
    fcntl.flock(owner.owner_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    errors=[]
    def spawn():
        try:
            owner.run_child('timeit',['-n','1','-r','1','-s','import time','time.sleep(30)'],budget=2,limit=512)
        except TimeoutError:
            errors.append('stopped')
    thread=threading.Thread(target=spawn)
    thread.start()
    end=time.monotonic()+1
    while owner.child is None and time.monotonic()<end:
        time.sleep(.01)
    assert owner.child is not None
    os.close(owner.owner_fd)
    other=os.open(lock,os.O_RDWR)
    try:
        with pytest.raises(BlockingIOError):
            fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
        owner.stop.set(); thread.join(6)
        assert not thread.is_alive() and errors==['stopped'] and owner.child is None
        fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
    finally:
        owner.stop.set();thread.join(6);os.close(other)


def test_lease_loss_stops_and_reaps_child(catalog):
    c,tid,path,data,user,h=catalog
    import fcntl
    from services.content_version_service import OwnerSupervisor
    owner=OwnerSupervisor('hash')
    owner.owner_fd=os.open(path.parent/'lease-owner.lock',os.O_CREAT|os.O_RDWR,0o600)
    fcntl.flock(owner.owner_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    ticks=iter(range(0,10000,2))
    renewal=mock.Mock(return_value=False)
    try:
        with mock.patch('services.content_version_service.time.monotonic',side_effect=lambda:next(ticks)):
            with pytest.raises(TimeoutError):
                owner.run_child('timeit',['-n','1','-r','1','-s','import time','time.sleep(30)'],budget=120,limit=512,renew=renewal)
        renewal.assert_called_once()
        assert owner.child is None
    finally:
        os.close(owner.owner_fd)


def test_shutdown_reports_live_lane_until_actual_completion(catalog):
    c,tid,path,data,user,h=catalog
    from starlette.requests import Request
    owner=service.DeliveryExecutor(); release=threading.Event(); entered=threading.Event()
    async def run():
        def blocked(deadline,cancel):
            entered.set();release.wait(8)
            return None
        request=Request({'type':'http','headers':[],'delivery_deadline':time.monotonic()+.1})
        task=asyncio.create_task(owner.run(request,blocked))
        await asyncio.to_thread(entered.wait,1)
        await asyncio.gather(task,return_exceptions=True)
        try:
            assert await owner.shutdown() is False
            assert not owner.accepting and owner.active
        finally:
            release.set()
        end=time.monotonic()+1
        while owner.active and time.monotonic()<end:
            await asyncio.sleep(.01)
        assert not owner.active
    asyncio.run(run())


def test_logs_strip_capabilities_and_stream_exceptions(catalog,caplog):
    c,tid,path,data,user,h=catalog
    import logging
    caplog.set_level(logging.INFO,logger='puuk.delivery')
    r=c.post('/api/media-ticket',json={'track_id':tid},headers=h)
    token=r.json()['url'].split('mt=')[1]
    assert c.get(r.json()['url']).status_code==200
    canary='SECRET_CANARY_after_headers'
    with mock.patch.object(service.PinnedResponse,'read',side_effect=RuntimeError(canary)):
        with pytest.raises(RuntimeError,match='delivery_stream_failed'):
            c.get('/api/stream/'+tid,headers=h)
    for secret in (token,h['Authorization'],str(path),canary,config.CDN_ORIGIN_SECRET):
        assert secret not in caplog.text
