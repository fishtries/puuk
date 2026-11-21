"""Authorized delivery owner: admission, identity, byte pinning and URL selection.

Routers describe intent only. No hash or provider control-plane call happens in
Play. Descriptor ownership transfers explicitly from the admitted worker to the
response, including cancellation and late blocking-read completion.
"""
import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import logging
import os
import re
import threading
import time
import uuid
from collections import Counter
from email.utils import parsedate_to_datetime
from secrets import token_hex

from fastapi import HTTPException
from starlette.responses import FileResponse, Response
from starlette.responses import MalformedRangeHeader, RangeNotSatisfiable
import config
from repositories import delivery, share_entities
from repositories.base import deadline_context, check_deadline, get_connection
from services.content_version_service import open_safe

logger=logging.getLogger('puuk.delivery')
_metrics=Counter()
_metrics_guard=threading.Lock()
_stopped=False


def record_event(branch,status,latency_ms=0,byte_count=0):
    # Fixed enums/buckets only; never entity/account/URL labels.
    branch=branch if branch in ('origin','direct','ticket','share') else 'other'
    bucket=next((v for v in (10,50,100,500,1000,2500,5000) if latency_ms<=v),10000)
    with _metrics_guard:
        _metrics[(branch,'responses',status//100)]+=1
        _metrics[(branch,'latency_ms_le',bucket)]+=1
        _metrics[(branch,'bytes',0)]+=byte_count


def record_bytes(branch,byte_count):
    with _metrics_guard:
        _metrics[(branch,'bytes',0)]+=byte_count


def readiness():
    """Nonsecret scoped signal for the operator; /api/health stays unchanged."""
    try:
        config.validate_delivery_config()
        with delivery.transaction(time.monotonic()+.1) as conn:
            state={'configured':True,'purge_healthy':delivery.purge_healthy(conn),
                'hash_pending':conn.execute("SELECT COUNT(*) FROM delivery_versions WHERE state IN ('pending','hashing')").fetchone()[0],
                'hash_failed':conn.execute("SELECT COUNT(*) FROM delivery_versions WHERE state='failed'").fetchone()[0],
                'purge_pending':conn.execute("SELECT COUNT(*) FROM cdn_purge_outbox WHERE state IN ('pending','submitting','polling','failed')").fetchone()[0]}
        return state
    except Exception:
        return {'configured':False,'purge_healthy':False}

_UUID=r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
OBJECT_PATH=re.compile(r'/cdn/audio/('+_UUID+r')/([0-9a-f]{64})')
QUERY=re.compile(rb'(?:md5=[A-Za-z0-9_-]{22}&expires=[1-9][0-9]{0,9}|expires=[1-9][0-9]{0,9}&md5=[A-Za-z0-9_-]{22})')


def busy():
    return HTTPException(503,detail={'code':'delivery_busy','message':'Delivery busy'},headers={'Retry-After':'1'})


def unavailable():
    return HTTPException(404,detail={'code':'track_unavailable','message':'Track unavailable'})


def canonical_uuid(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError,TypeError,AttributeError):
        raise HTTPException(400,detail='Invalid track_id') from None


def sign_path(path,expires,secret):
    raw=hashlib.md5((str(expires)+path+' '+secret).encode('ascii'),usedforsecurity=False).digest()
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def cdn_expiry(now,ttl):
    """Share a canonical capability without stripping auth from the cache key.

    Round down within at most five minutes; never extend the configured TTL or
    return less than sixty seconds, including short operator-test settings.
    """
    window=min(300,ttl-59)
    return now+ttl-now%window


def validate_origin(scope):
    if not config.CDN_ORIGIN_ENABLED:
        raise HTTPException(404,detail='Not found')
    values=[v for k,v in scope['headers'] if k.lower()==b'x-puuk-origin-secret']
    expected=config.CDN_ORIGIN_SECRET.encode('ascii')
    valid=(len(values)==1 and len(values[0])==64 and all(32<c<127 for c in values[0]) and len(expected)==64)
    accepted=valid and hmac.compare_digest(values[0] if valid else b'',expected)
    logger.info('delivery_origin_auth header_count=%s accepted=%s',min(len(values),2),bool(accepted))
    with _metrics_guard:
        _metrics[('origin_auth','accepted' if accepted else 'rejected',min(len(values),2))]+=1
    if not accepted:
        raise HTTPException(403,detail={'code':'forbidden','message':'Forbidden'})
    raw=scope.get('raw_path',scope['path'].encode())
    try:
        path=raw.decode('ascii')
    except UnicodeDecodeError:
        raise HTTPException(400,detail='Invalid object path') from None
    match=OBJECT_PATH.fullmatch(path)
    if not match or path!=scope['path']:
        raise HTTPException(400,detail='Invalid object path')
    query=scope.get('query_string',b'')
    if len(query)>128 or not QUERY.fullmatch(query):
        raise HTTPException(400,detail='Invalid object query')
    # The secret authenticates the upstream, while the query retains exactly the
    # same syntax accepted publicly. Edge cryptographic enforcement remains G3.
    return match.groups()


class DeliveryExecutor:
    def __init__(self):
        self.pool=ThreadPoolExecutor(max_workers=4,thread_name_prefix='delivery-request')
        self.lanes=threading.BoundedSemaphore(4)
        self.guard=threading.Lock()
        self.active=set()
        self.accepting=True

    async def run(self,request,fn,*,budget=2.5):
        deadline=request.scope.get('delivery_deadline',time.monotonic()+budget)
        cancel=request.scope.get('delivery_cancel') or threading.Event()
        if not self.accepting or not self.lanes.acquire(blocking=False):
            raise busy()
        with self.guard:
            self.active.add(cancel)
        def work():
            result=None
            try:
                with deadline_context(deadline,cancel):
                    result=fn(deadline,cancel)
                    check_deadline(deadline,cancel)
                    return result
            except BaseException:
                if isinstance(result,PinnedResponse):
                    result.close()
                raise
            finally:
                with self.guard:
                    self.active.discard(cancel)
                self.lanes.release()
        try:
            future=self.pool.submit(work)
        except BaseException:
            with self.guard:
                self.active.discard(cancel)
            self.lanes.release()
            raise
        wrapped=asyncio.wrap_future(future)
        try:
            result=await asyncio.wait_for(asyncio.shield(wrapped),max(.001,deadline-time.monotonic()))
            if isinstance(result,PinnedResponse):
                request.scope['delivery_pinned_response']=result
            return result
        except (asyncio.TimeoutError,asyncio.CancelledError):
            cancel.set()
            # Future may have returned just before cancellation: dispose its
            # result exactly once without depending on garbage collection.
            def discard(done):
                try:
                    result=done.result()
                    if isinstance(result,PinnedResponse):
                        result.close()
                except BaseException:
                    pass
            future.add_done_callback(discard)
            if not wrapped.done():
                wrapped.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
            raise busy() from None
        except (TimeoutError,):
            raise busy() from None
        except Exception as exc:
            import sqlite3
            if isinstance(exc,sqlite3.OperationalError):
                raise busy() from None
            raise

    async def shutdown(self):
        self.accepting=False
        with self.guard:
            for event in self.active:
                event.set()
        end=time.monotonic()+5
        while time.monotonic()<end:
            with self.guard:
                if not self.active:
                    break
            await asyncio.sleep(.02)
        self.pool.shutdown(wait=False,cancel_futures=True)
        with self.guard:
            return not self.active


executor=DeliveryExecutor()
_read_pool=ThreadPoolExecutor(max_workers=4,thread_name_prefix='delivery-read')
_stream_slots=threading.BoundedSemaphore(16)
_stream_guard=threading.Lock()
_streams=set()


class PinnedResponse(FileResponse):
    chunk_size=1024*1024

    def __init__(self,fd,st,path,version=None):
        self.fd=fd
        self._guard=threading.Lock()
        self._inflight=0
        self._closing=False
        self._closed=False
        self.cancel=threading.Event()
        from services.cover_extractor import get_media_type
        headers={'Cache-Control':'private, no-store'}
        if version:
            headers['ETag']='"sha256-'+version+'"'
        super().__init__(path,stat_result=st,media_type=get_media_type(path),headers=headers)
        with _stream_guard:
            _streams.add(self)

    def _finish_locked(self):
        if self._closing and not self._inflight and not self._closed:
            self._closed=True
            os.close(self.fd)
            _stream_slots.release()
            with _stream_guard:
                _streams.discard(self)

    def close(self):
        self.cancel.set()
        with self._guard:
            self._closing=True
            self._finish_locked()

    async def read(self,offset,size):
        if self.cancel.is_set():
            raise asyncio.CancelledError()
        with self._guard:
            self._inflight+=1
        def work():
            try:
                return os.pread(self.fd,min(size,self.chunk_size),offset)
            finally:
                with self._guard:
                    self._inflight-=1
                    self._finish_locked()
        try:
            future=_read_pool.submit(work)
        except BaseException:
            with self._guard:
                self._inflight-=1
                self._finish_locked()
            raise
        wrapped=asyncio.wrap_future(future)
        try:
            data=await asyncio.wait_for(asyncio.shield(wrapped),15)
        except BaseException:
            wrapped.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
            raise
        if self.cancel.is_set():
            raise asyncio.CancelledError()
        return data

    async def __call__(self,scope,receive,send):
        async def emit(message):
            await asyncio.wait_for(send(message),15)
        async def disconnect():
            while True:
                msg=await receive()
                if msg['type']=='http.disconnect':
                    return
        async def body():
            heads={}
            for key,value in scope['headers']:
                heads.setdefault(key.lower(),[]).append(value.decode('latin-1'))
            if_none=heads.get(b'if-none-match',[])
            etag=self.headers['etag']
            conditional=bool(if_none and any(token.strip().removeprefix('W/') in (etag,'*') for line in if_none for token in line.split(',')))
            if not if_none and b'if-modified-since' in heads:
                try:
                    conditional=int(parsedate_to_datetime(heads[b'if-modified-since'][0]).timestamp())>=int(self.stat_result.st_mtime)
                except (ValueError,TypeError,OverflowError):
                    pass
            if b'if-match' in heads:
                conditional=False
            if conditional:
                await emit({'type':'http.response.start','status':304,'headers':[(k,v) for k,v in self.raw_headers if k!=b'content-length']})
                await emit({'type':'http.response.body','body':b''})
                return
            head=scope['method']=='HEAD'
            ranges=[]
            raw=heads.get(b'range',[])
            if not head and len(raw)>1:
                raise HTTPException(400,detail='Invalid Range')
            if raw and not head:
                ir=heads.get(b'if-range',[])
                if not ir or (len(ir)==1 and self._should_use_range(ir[0])):
                    try:
                        ranges=self._parse_range_header(raw[0],self.stat_result.st_size)
                    except MalformedRangeHeader:
                        await Response(status_code=400)(scope,receive,emit)
                        return
                    except RangeNotSatisfiable:
                        await Response(status_code=416,headers={'Content-Range':f'bytes */{self.stat_result.st_size}'})(scope,receive,emit)
                        return
            headers=dict(self.headers)
            generator=None
            boundary=None
            if len(ranges)==1:
                start,end=ranges[0]
                headers['content-range']=f'bytes {start}-{end-1}/{self.stat_result.st_size}'
                headers['content-length']=str(end-start)
            elif len(ranges)>1:
                boundary=token_hex(13)
                length,generator=self.generate_multipart(ranges,boundary,self.stat_result.st_size,self.media_type)
                headers['content-type']='multipart/byteranges; boundary='+boundary
                headers['content-length']=str(length)
            response=Response(status_code=206 if ranges else 200,headers=headers)
            await emit({'type':'http.response.start','status':response.status_code,'headers':response.raw_headers})
            if not head:
                for start,end in ranges or [(0,self.stat_result.st_size)]:
                    if generator:
                        await emit({'type':'http.response.body','body':generator(start,end),'more_body':True})
                    while start<end:
                        data=await self.read(start,end-start)
                        if not data:
                            raise OSError('short_read')
                        start+=len(data)
                        await emit({'type':'http.response.body','body':data,'more_body':True})
                    if generator:
                        await emit({'type':'http.response.body','body':b'\r\n','more_body':True})
            await emit({'type':'http.response.body','body':('--'+boundary+'--').encode() if boundary else b''})
        task=asyncio.create_task(body())
        gone=asyncio.create_task(disconnect())
        try:
            done,_=await asyncio.wait((task,gone),return_when=asyncio.FIRST_COMPLETED)
            if gone in done:
                task.cancel()
            await task
        finally:
            gone.cancel()
            task.cancel()
            await asyncio.gather(gone,task,return_exceptions=True)
            self.close()


def authenticate(request,track_id=None):
    from auth import get_current_user,verify_media_ticket
    auths=request.headers.getlist('authorization')
    if len(auths)>1:
        raise HTTPException(401,detail='Invalid authorization',headers={'WWW-Authenticate':'Bearer'})
    token=None
    if auths:
        pieces=auths[0].split(' ',1)
        if len(pieces)==2 and pieces[0].lower()=='bearer':
            token=pieces[1]
        else:
            raise HTTPException(401,detail='Invalid authorization',headers={'WWW-Authenticate':'Bearer'})
    if token or track_id is None:
        return get_current_user(token)
    tickets=request.query_params.getlist('mt')
    user=verify_media_ticket(tickets[0],track_id) if len(tickets)==1 else None
    if user:
        return user
    raise HTTPException(401,detail='Authentication required',headers={'WWW-Authenticate':'Bearer'})


def _track(track_id,deadline,cancel,*,recover=True):
    import db
    if not share_entities.recovery_allowed(track_id):
        raise unavailable()
    row=db.get_track(track_id)
    if row is None and recover:
        from services.media_locations import ensure_track_in_db
        row=ensure_track_in_db(track_id,deadline=deadline,cancel=cancel)
        logger.info('delivery_track track_id=%s path=recovery recovered=%s',track_id,bool(row))
    elif row is not None:
        logger.info('delivery_track track_id=%s path=sqlite',track_id)
    check_deadline(deadline,cancel)
    if not row or row.get('audio_review_blocked'):
        raise unavailable()
    return row


def _ready_or_prepare(track_id,st,deadline,cancel):
    version=delivery.ready_version(track_id,st)
    if not version:
        existing=delivery.get_version(track_id)
        if existing and existing['state']=='ready':
            delivery.invalidate(track_id,unmanaged=True,deadline=deadline,cancel=cancel)
        else:
            delivery.enqueue(track_id)
    return version


def _pin(track_id,deadline,cancel,*,origin_version=None,if_match=None,range_present=False):
    from metadata import track_mutation_lock
    row=_track(track_id,deadline,cancel,recover=origin_version is None)
    if not _stream_slots.acquire(blocking=False):
        raise busy()
    fd=None
    transferred=False
    try:
        with track_mutation_lock(track_id,config.get_effective_music_dir(),min(deadline,time.monotonic()+.1),cancel):
            # Deletion may have won the lock while we waited.
            row=_track(track_id,deadline,cancel,recover=False)
            try:
                fd,st,path=open_safe(row['file_path'])
            except (OSError,ValueError):
                logger.warning('delivery_track track_id=%s reason=file_missing',track_id)
                delivery.invalidate(track_id,deleting=True,unmanaged=True,deadline=deadline,cancel=cancel)
                raise unavailable() from None
            version=_ready_or_prepare(track_id,st,deadline,cancel)
            if origin_version and (not version or version['content_version']!=origin_version):
                raise unavailable()
            if if_match is not None:
                expected='"sha256-'+version['content_version']+'"' if version else None
                if len(if_match)!=1 or if_match[0]!=expected or range_present:
                    raise HTTPException(412,detail='Version precondition failed')
            check_deadline(deadline,cancel)
            response=PinnedResponse(fd,st,path,version['content_version'] if version else None)
            transferred=True
            return response,version
    finally:
        if not transferred:
            if fd is not None:
                os.close(fd)
            _stream_slots.release()


def issue(request,track_id,requested,deadline,cancel):
    user=authenticate(request)
    track_id=canonical_uuid(track_id)
    pinned,version=_pin(track_id,deadline,cancel)
    try:
        # _pin validated under the lock; reacquire and recheck for the exposure
        # commit so a managed replace cannot intervene in permission issuance.
        from metadata import track_mutation_lock
        with track_mutation_lock(track_id,config.get_effective_music_dir(),min(deadline,time.monotonic()+.1),cancel):
            row=_track(track_id,deadline,cancel,recover=False)
            try:
                fd,st,path=open_safe(row['file_path'])
            except (OSError,ValueError):
                raise unavailable() from None
            try:
                version=_ready_or_prepare(track_id,st,deadline,cancel)
                now=int(time.time())
                mode='direct'
                if requested=='cdn' and config.CDN_DELIVERY_ENABLED and config.CDN_ORIGIN_ENABLED and user['id'] in config.CDN_PILOT_USER_IDS and version:
                    with delivery.transaction(deadline,cancel) as conn:
                        if delivery.purge_healthy(conn):
                            expires=cdn_expiry(now,config.CDN_TICKET_TTL_SECONDS)
                            delivery.expose(conn,track_id,version['content_version'],expires)
                            mode='cdn'
                check_deadline(deadline,cancel)
                if mode=='cdn':
                    object_path=f"/cdn/audio/{track_id}/{version['content_version']}"
                    url=config.CDN_BASE_URL+object_path+'?md5='+sign_path(object_path,expires,config.CDN_SIGNING_SECRET)+'&expires='+str(expires)
                    binding='immutable-path'
                else:
                    from auth import create_media_ticket_with_expiry, MEDIA_TICKET_TTL_SECONDS
                    ticket,expires=create_media_ticket_with_expiry(user,track_id)
                    now=expires-MEDIA_TICKET_TTL_SECONDS
                    url=f'/api/stream/{track_id}?mt={ticket}'
                    binding='if-match' if version else None
                check_deadline(deadline,cancel)
                request.scope['delivery_mode']=mode
                return {'url':url,'expires_in':expires-now,'expires_at':expires,'delivery':mode,'server_time':now,
                    'content_version':version['content_version'] if version else None,'content_length':st.st_size if version else None,
                    'download_binding':binding,'delivery_epoch':config.CDN_DELIVERY_EPOCH,'cache_for':30}
            finally:
                os.close(fd)
    finally:
        pinned.close()


def stream(request,track_id,deadline,cancel,version=None):
    if version is None:
        track_id=canonical_uuid(track_id)
        authenticate(request,track_id)
    else:
        validate_origin(request.scope)
    matches=request.headers.getlist('if-match')
    pinned,_=_pin(track_id,deadline,cancel,origin_version=version,
        if_match=matches if matches else None,range_present=bool(request.headers.getlist('range') or request.headers.getlist('if-range')))
    return pinned


def observe(track_id,path,*,retry_failed=False):
    """Scanner/editor reconciliation; caller already owns the mutation lock."""
    try:
        fd,st,_=open_safe(path)
    except (OSError,ValueError):
        delivery.invalidate(track_id,unmanaged=True)
        return
    try:
        with delivery.transaction() as conn:
            old=delivery.get_version(track_id,conn=conn)
            if old and old['state']=='ready' and not delivery.ready_version(track_id,st,conn=conn):
                delivery.reserve_retirement(conn,track_id,unmanaged=True)
            delivery.enqueue(track_id,conn=conn,retry_failed=retry_failed)
    finally:
        os.close(fd)


async def shutdown():
    global _stopped
    _stopped=True
    clean=await executor.shutdown()
    with _stream_guard:
        streams=list(_streams)
    for response in streams:
        response.close()
    end=time.monotonic()+5
    while time.monotonic()<end:
        with _stream_guard:
            if not _streams:
                break
        await asyncio.sleep(.02)
    with _stream_guard:
        clean=clean and not _streams
    _read_pool.shutdown(wait=False,cancel_futures=False)
    if not clean:
        logger.error('delivery_shutdown reason=unclean')
    return clean


def startup():
    """A completed lifespan can restart; unclean resources prohibit new pools."""
    global executor, _read_pool, _stopped
    if not _stopped:
        return
    with executor.guard, _stream_guard:
        if executor.active or _streams:
            raise RuntimeError('delivery_unclean_shutdown')
    executor=DeliveryExecutor()
    _read_pool=ThreadPoolExecutor(max_workers=4,thread_name_prefix='delivery-read')
    _stopped=False
