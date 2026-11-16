"""Path policy outside account CORS and inside FastAPI ServerErrorMiddleware."""
import asyncio
import json
import logging
import threading
import time
import uuid
import config
from fastapi import HTTPException
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse
from services.delivery_service import validate_origin, busy, record_event, record_bytes

logger=logging.getLogger('puuk.delivery')
ORIGIN=b'https://web.puuk.fun'
EXPOSE=b'Accept-Ranges, Content-Range, Content-Length, ETag, Last-Modified, Age'
POLICIES={
    'origin':('GET, HEAD, OPTIONS',{'range','if-range','if-none-match'}),
    'direct':('GET, HEAD, OPTIONS',{'authorization','range','if-range','if-none-match','if-match'}),
    'ticket':('POST, OPTIONS',{'authorization','content-type'}),
    'share':('GET, OPTIONS',{'authorization'}),
}


class DeliveryBoundaryMiddleware:
    def __init__(self,app,account_cors_options):
        self.app=app
        self.account=CORSMiddleware(app,**account_cors_options)

    async def __call__(self,scope,receive,send):
        if scope['type']!='http':
            return await self.app(scope,receive,send)
        path=scope['path']
        raw=scope.get('raw_path',path.encode())
        if path.startswith('/cdn/') or raw.startswith(b'/cdn/') or path=='/cdn':
            branch='origin'
        elif path=='/api/media-ticket':
            branch='ticket'
        elif path.startswith('/api/stream/'):
            branch='direct'
        elif path.startswith('/api/share/'):
            branch='share'
        else:
            return await self.account(scope,receive,send)
        started=False
        admission=asyncio.Event()
        cancel=threading.Event()
        beginning=time.monotonic()
        scope['delivery_deadline']=beginning+(5 if branch=='share' else 2.5)
        scope['delivery_cancel']=cancel
        correlation=uuid.uuid4().hex
        origins=[v for k,v in scope['headers'] if k.lower()==b'origin']
        allowed_origin=len(origins)==1 and origins[0]==ORIGIN
        sanitize_validation=False
        async def guarded(message):
            nonlocal started,sanitize_validation
            if message['type']=='http.response.start':
                if started:
                    raise RuntimeError('duplicate_response_start')
                if scope.get('delivery_disconnected'):
                    raise asyncio.CancelledError()
                if message['status']<500 and time.monotonic()>scope['delivery_deadline']:
                    raise busy()
                started=True
                status=message['status']
                sanitize_validation=status==422
                blocked={b'cache-control',b'pragma',b'expires',b'set-cookie'}
                headers=[(k,v) for k,v in message.get('headers',[]) if k.lower() not in blocked and not k.lower().startswith(b'access-control-') and not (sanitize_validation and k.lower()==b'content-length')]
                headers.append((b'cache-control',b'no-store, private'))
                if branch in ('ticket','share'):
                    headers.append((b'pragma',b'no-cache'))
                if status==401 and not any(k.lower()==b'www-authenticate' for k,v in headers):
                    headers.append((b'www-authenticate',b'Bearer'))
                if allowed_origin:
                    headers.extend([(b'access-control-allow-origin',ORIGIN),(b'access-control-expose-headers',EXPOSE)])
                    if scope['method']=='OPTIONS' and status==204:
                        methods,allowed=POLICIES[branch]
                        headers.extend([(b'access-control-allow-methods',methods.encode()),
                            (b'access-control-allow-headers',', '.join(sorted(allowed)).encode()),(b'access-control-max-age',b'300')])
                message={**message,'headers':headers}
                record_event(branch,status,(time.monotonic()-beginning)*1000)
                logger.info('delivery_response correlation=%s branch=%s delivery=%s epoch=%s reason=response status_class=%s latency_ms=%.2f',correlation,branch,scope.get('delivery_mode','origin' if branch=='origin' else 'direct'),config.CDN_DELIVERY_EPOCH,status//100,(time.monotonic()-beginning)*1000)
            elif message['type']=='http.response.body' and sanitize_validation:
                try:
                    detail=json.loads(message.get('body',b'{}')).get('detail')
                except (ValueError,AttributeError):
                    detail=None
                safe=detail if isinstance(detail,dict) and detail.get('code')=='entity_too_large' else {'code':'validation_error','message':'Invalid request'}
                message={**message,'body':json.dumps({'detail':safe}).encode() if not scope.get('_delivery_validation_sent') else b''}
                scope['_delivery_validation_sent']=True
            if message['type']=='http.response.body':
                record_bytes(branch,len(message.get('body',b'')))
            await asyncio.wait_for(send(message),15)
            if message['type']=='http.response.start':
                admission.set()
        async def error(exc):
            headers=exc.headers or {}
            await JSONResponse({'detail':exc.detail},status_code=exc.status_code,headers=headers)(scope,receive,guarded)
        body=None
        try:
            if branch=='origin':
                validate_origin(scope)
            auth=[v for k,v in scope['headers'] if k.lower()==b'authorization']
            if sum(map(len,auth))>8192:
                raise HTTPException(400,detail='Invalid authorization')
            if branch=='direct' and (not path[len('/api/stream/'):] or '/' in path[len('/api/stream/'):]):
                raise HTTPException(404,detail='Not found')
            if scope['method']=='OPTIONS':
                methods,allowed=POLICIES[branch]
                request_methods=[v for k,v in scope['headers'] if k.lower()==b'access-control-request-method']
                request_headers=[v for k,v in scope['headers'] if k.lower()==b'access-control-request-headers']
                headers=set()
                if len(request_headers)>1:
                    raise HTTPException(403,detail='Forbidden')
                if request_headers:
                    headers={h.strip().lower() for h in request_headers[0].decode('latin-1').split(',')}
                if not allowed_origin or len(request_methods)!=1 or request_methods[0].decode('latin-1') not in methods.split(', ') or not headers<=allowed:
                    raise HTTPException(403,detail='Forbidden')
                from starlette.responses import Response
                return await Response(status_code=204)(scope,receive,guarded)
            if branch=='ticket':
                # Bound body before FastAPI's parser and never hold a request
                # lane while waiting on a slow/unbounded upload.
                parts=[]; size=0
                while True:
                    remaining=scope['delivery_deadline']-time.monotonic()
                    message=await asyncio.wait_for(receive(),max(.001,remaining))
                    if message['type']=='http.disconnect':
                        cancel.set()
                        return
                    size+=len(message.get('body',b''))
                    if size>4096:
                        raise HTTPException(413,detail='Request too large')
                    parts.append(message.get('body',b''))
                    if not message.get('more_body'):
                        break
                body=b''.join(parts)
        except HTTPException as exc:
            return await error(exc)
        except asyncio.TimeoutError:
            cancel.set()
            return await error(busy())
        consumed=False
        disconnected=asyncio.Event()
        async def watch_disconnect():
            while True:
                msg=await receive()
                if msg['type']=='http.disconnect':
                    scope['delivery_disconnected']=True
                    cancel.set()
                    disconnected.set()
                    return
        async def bounded_receive():
            nonlocal consumed
            if not consumed:
                consumed=True
                return {'type':'http.request','body':body or b'','more_body':False}
            await disconnected.wait()
            return {'type':'http.disconnect'}
        async def invoke():
            try:
                await self.app(scope,bounded_receive,guarded)
            except HTTPException as exc:
                if not started:
                    await error(exc)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning('delivery_error correlation=%s branch=%s reason=handler_error',correlation,branch)
                if not started:
                    await error(HTTPException(500,detail='Delivery unavailable'))
                else:
                    raise RuntimeError('delivery_stream_failed') from None
        watcher=asyncio.create_task(watch_disconnect())
        task=asyncio.create_task(invoke())
        admitted=asyncio.create_task(admission.wait())
        try:
            done,_=await asyncio.wait((task,admitted),timeout=max(.001,scope['delivery_deadline']-time.monotonic()),return_when=asyncio.FIRST_COMPLETED)
            if not done:
                cancel.set()
                task.cancel()
                await asyncio.gather(task,return_exceptions=True)
                if not started:
                    await error(busy())
                return
            await task
        finally:
            watcher.cancel()
            cancel.set()
            admitted.cancel()
            if not task.done():
                task.cancel()
            await asyncio.gather(admitted,task,watcher,return_exceptions=True)
            pinned=scope.pop('delivery_pinned_response',None)
            if pinned is not None:
                pinned.close()
