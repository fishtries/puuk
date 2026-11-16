"""Exposed-version outbox consumer. Every network call is a bounded child.

Provider credentials travel only through <=8KiB stdin, never argv, environment,
logs or persistent jobs. Submission is rate-reserved before network IO.
"""
import json
import logging
import random
import re
import sys
import time
import uuid
import config
from repositories import delivery
from services.cdn_credentials import service_account_key, service_account_token, retry_after
from services.content_version_service import OwnerSupervisor

logger=logging.getLogger('puuk.delivery')
_ID=re.compile(r'[A-Za-z0-9_-]{1,64}')
_PATH=re.compile(r'/cdn/audio/[0-9a-f-]{36}/(?:[0-9a-f]{64})?\*')


class PurgeSupervisor(OwnerSupervisor):
    def __init__(self):
        super().__init__('purge')
        self.job=None
        self.fence=None
        self.renew_at=0

    def renew(self):
        try:
            with delivery.transaction(time.monotonic()+.1,self.stop) as conn:
                conn.execute("INSERT INTO delivery_control(key,value) VALUES ('purge_heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(str(time.time()),))
                if not self.job:
                    return True
                return conn.execute("UPDATE cdn_purge_outbox SET lease_until=? WHERE id=? AND fence=? AND state IN ('submitting','polling')",(time.time()+60,self.job,self.fence)).rowcount==1
        except Exception:
            return False

    def tick(self):
        now=time.time()
        if not self.renew():
            self.job=None
            return
        with delivery.transaction(time.monotonic()+.1,self.stop) as conn:
            delivery.drain_expired(conn,now)
            # Reconcile unmanaged replacement/missing-file intent without ever
            # reopening the stale hash. Capacity remains a concern only here.
            for row in conn.execute('SELECT DISTINCT track_id FROM delivery_exposures WHERE reconciliation_needed=1 LIMIT 10').fetchall():
                delivery.reserve_retirement(conn,row[0],unmanaged=True,now=now)
            conn.execute("DELETE FROM cdn_purge_outbox WHERE state IN ('succeeded','drained') AND changed_at<?",(now-7*86400,))
            conn.execute("DELETE FROM cdn_purge_outbox WHERE state='failed' AND drain_until<? AND changed_at<? AND lease_until IS NULL",(now,now-30*86400))
            conn.execute("""DELETE FROM delivery_exposures WHERE retired_at<? AND max_expires_at+3630<? AND reconciliation_needed=0
                AND NOT EXISTS (SELECT 1 FROM cdn_purge_outbox p WHERE p.track_id=delivery_exposures.track_id AND p.state IN ('pending','submitting','polling','failed'))""",(now-7*86400,now))
            if self.job:
                row=conn.execute('SELECT * FROM cdn_purge_outbox WHERE id=? AND fence=?',(self.job,self.fence)).fetchone()
            else:
                active=conn.execute("SELECT * FROM cdn_purge_outbox WHERE state IN ('polling','submitting') ORDER BY created_at LIMIT 1").fetchone()
                if active:
                    row=active if (active['lease_until'] or 0)<now else None
                else:
                    row=conn.execute("SELECT * FROM cdn_purge_outbox WHERE state='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT 1",(now,)).fetchone()
                if row:
                    self.job=row['id']; self.fence=uuid.uuid4().hex
                    conn.execute('UPDATE cdn_purge_outbox SET fence=?,lease_until=? WHERE id=?',(self.fence,now+60,self.job))
            if not row:
                self.job=None
                return
            row=dict(row)
            if row['state']=='submitting':
                # A predecessor may have sent it; never call that a success.
                self._retry(conn,row,'ambiguous_submission',now)
                self.job=None
                return
            polling=row['state']=='polling'
            if polling and now < row['next_attempt_at']:
                return
            if polling and now-row['operation_started_at']>=900:
                self._retry(conn,row,'operation_timeout',now)
                self.job=None
                return
            if not polling:
                rate=conn.execute("SELECT value FROM delivery_control WHERE key='purge_next_submission'").fetchone()
                if rate and float(rate[0])>now:
                    # Pending rows must not block reclamation of active polling.
                    conn.execute('UPDATE cdn_purge_outbox SET lease_until=NULL,fence=NULL WHERE id=?',(self.job,))
                    self.job=None
                    return
                if row['attempts']>=5 or (row['first_attempt_at'] and now-row['first_attempt_at']>=86400):
                    self._terminal(conn,row,'retry_exhausted',now)
                    self.job=None
                    return
                conn.execute("INSERT INTO delivery_control(key,value) VALUES ('purge_next_submission',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(str(now+65),))
                conn.execute("""UPDATE cdn_purge_outbox SET state='submitting',attempts=attempts+1,
                    first_attempt_at=COALESCE(first_attempt_at,?),submitted_revision=revision,lease_until=?,changed_at=? WHERE id=? AND fence=?""",(now,now+60,now,self.job,self.fence))
                row['attempts']+=1
                row['first_attempt_at']=row['first_attempt_at'] or now
        try:
            data={**credential_payload(),'resource':config.CDN_RESOURCE_ID,
                'operation':row['operation_id'] if polling else None,'paths':[row['path']]}
            raw=json.dumps(data,separators=(',',':')).encode()
            if len(raw)>8192:
                raise ValueError('configuration_invalid')
            result=self.run_child('services.cdn_purge_service',['--http-job'],budget=10,limit=4096,stdin=raw,renew=self.renew)
        except Exception:
            result={'status':'retry','reason':'transport_error'}
        if self.stop.is_set():
            return
        with delivery.transaction(time.monotonic()+.1,self.stop) as conn:
            current=conn.execute('SELECT * FROM cdn_purge_outbox WHERE id=? AND fence=?',(self.job,self.fence)).fetchone()
            if not current:
                self.job=None
                return
            status=result.get('status')
            if status=='succeeded':
                conn.execute("""UPDATE cdn_purge_outbox SET state=CASE WHEN revision>submitted_revision THEN 'pending' ELSE 'succeeded' END,
                    reason=CASE WHEN revision>submitted_revision THEN 'changed_during_operation' ELSE NULL END,
                    operation_id=NULL,operation_started_at=NULL,next_attempt_at=?,lease_until=NULL,fence=NULL,changed_at=? WHERE id=? AND fence=?""",(time.time()+65,time.time(),self.job,self.fence))
                self.job=None
            elif status=='polling' and _ID.fullmatch(result.get('operation_id','')):
                conn.execute("""UPDATE cdn_purge_outbox SET state='polling',operation_id=?,operation_started_at=COALESCE(operation_started_at,?),
                    next_attempt_at=?,lease_until=?,changed_at=? WHERE id=? AND fence=?""",(result['operation_id'],time.time(),time.time()+30,time.time()+60,time.time(),self.job,self.fence))
            elif status=='terminal':
                self._terminal(conn,dict(current),'provider_rejected',time.time())
                self.job=None
            else:
                self._retry(conn,dict(current),'operation_failed' if polling else 'ambiguous_submission',time.time(),result.get('retry_after',0))
                self.job=None

    def _terminal(self,conn,row,reason,now):
        conn.execute("UPDATE cdn_purge_outbox SET state='failed',reason=?,fence=NULL,lease_until=NULL,changed_at=? WHERE id=? AND fence=?",(reason,now,row['id'],self.fence))
        logger.error('delivery_purge reason=%s',reason)

    def _retry(self,conn,row,reason,now,retry_after=0):
        if row['attempts']>=5 or (row['first_attempt_at'] and now-row['first_attempt_at']>=86400):
            return self._terminal(conn,row,'retry_exhausted',now)
        delay=65*(2**max(0,row['attempts']-1))*(1+random.random()*.2)
        if isinstance(retry_after,(int,float)):
            delay=max(delay,min(86400,max(0,retry_after)))
        if row['first_attempt_at'] and now+delay>=row['first_attempt_at']+86400:
            return self._terminal(conn,row,'retry_exhausted',now)
        conn.execute("""UPDATE cdn_purge_outbox SET state='pending',reason=?,operation_id=NULL,operation_started_at=NULL,
            next_attempt_at=?,fence=NULL,lease_until=NULL,changed_at=? WHERE id=? AND fence=?""",(reason,now+delay,now,row['id'],self.fence))
        logger.warning('delivery_purge reason=%s',reason)


def credential_payload():
    if config.CDN_PURGE_SERVICE_ACCOUNT_KEY_PATH:
        return {'service_account_key':service_account_key(config.CDN_PURGE_SERVICE_ACCOUNT_KEY_PATH)}
    return {'token':config.CDN_PURGE_TOKEN}


def http_job():
    # No application/router/Qdrant import. urllib redirect handling is explicitly
    # disabled; HTTPSConnection has no proxy environment or transport retry.
    import http.client
    import ssl
    import socket
    end=time.monotonic()+10
    data=json.loads(sys.stdin.buffer.read(8193))
    token=data.get('token','')
    if not _ID.fullmatch(data.get('resource','')) or not isinstance(token,str) or len(token)>7000 or any(ord(c)<33 or ord(c)>126 for c in token):
        raise ValueError()
    operation=data.get('operation')
    if operation is not None:
        if not _ID.fullmatch(operation):
            raise ValueError()
        host='operation.api.cloud.yandex.net'; path='/operations/'+operation; method='GET'; body=None
    else:
        paths=data.get('paths')
        if not isinstance(paths,list) or not 1<=len(paths)<=10 or any(not isinstance(p,str) or not _PATH.fullmatch(p) for p in paths):
            raise ValueError()
        host='cdn.api.cloud.yandex.net'; path='/cdn/v1/cache/'+data['resource']+':purge'; method='POST'
        body=json.dumps({'paths':paths}).encode()
    if 'service_account_key' in data:
        if token:raise ValueError('ambiguous_credentials')
        token=service_account_token(data['service_account_key'],end)
        if isinstance(token,dict):
            print(json.dumps(token));return
    if not token or time.monotonic()>=end:raise ValueError('credential_unavailable')
    conn=http.client.HTTPSConnection(host,timeout=min(2,end-time.monotonic()),context=ssl.create_default_context())
    try:
        conn.request(method,path,body=body,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','Accept':'application/json'})
        response=conn.getresponse()
        if not 200<=response.status<300:
            retry=response.status==429 or response.status>=500
            print(json.dumps({'status':'retry' if retry else 'terminal','reason':'http_error','retry_after':retry_after(response)}))
            return
        raw=bytearray()
        while True:
            left=end-time.monotonic()
            if left<=0:
                raise TimeoutError()
            if conn.sock:
                conn.sock.settimeout(min(2,left))
            chunk=response.read(min(4096,65537-len(raw)))
            raw.extend(chunk)
            if len(raw)>65536:
                raise ValueError()
            if not chunk:
                break
        obj=json.loads(raw)
        op=obj.get('id','')
        if not isinstance(op,str) or not _ID.fullmatch(op) or not isinstance(obj.get('done'),bool):
            raise ValueError()
        if operation is not None and op!=operation:
            raise ValueError()
        if obj.get('error'):
            code=obj['error'].get('code')
            print(json.dumps({'status':'retry' if code in (4,8,10,13,14) else 'terminal','reason':'operation_error'}))
        elif obj['done'] and 'response' in obj:
            print(json.dumps({'status':'succeeded','operation_id':op}))
        elif not obj['done']:
            print(json.dumps({'status':'polling','operation_id':op}))
        else:
            raise ValueError()
    finally:
        conn.close()


if __name__=='__main__':
    try:
        if sys.argv[1:]==['--http-job']:
            http_job()
        else:
            sys.exit(2)
    except Exception:
        # Only this bounded enum escapes the credential-holding process.
        print('{"status":"retry","reason":"transport_error"}')
