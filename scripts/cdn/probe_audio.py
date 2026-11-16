#!/usr/bin/env python3
"""Bounded read-only live delivery proof. No accounts, track/file edits or cache enablement.

Select one already prepared object <=1 MiB. Compare its exact bytes and ranges;
never print signed URLs, keys, paths, audio bytes or track metadata.
"""
import base64
from email.parser import BytesParser
from email.policy import default
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import sqlite3
import ssl
import stat
import subprocess
import sys
import time

if os.geteuid()!=0:raise SystemExit('Run with sudo')
if sys.argv[1:] not in ([],['--origin']):raise SystemExit('Usage: probe-audio.py [--origin]')
origin_only=sys.argv[1:]==['--origin']
p=Path('/etc/puuk/cdn.env');st=p.lstat()
if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o077:raise SystemExit('Unsafe environment file')
values=dict(s.split('=',1) for s in p.read_text().splitlines() if '=' in s and not s.startswith('#'))
key=values.get('CDN_SIGNING_SECRET','')
if not re.fullmatch('[0-9a-f]{32}',key):raise SystemExit('Invalid signing configuration')
pid=subprocess.run(['systemctl','show','puuk-brain','--property=MainPID','--value'],capture_output=True,text=True,check=True).stdout.strip()
env=dict(s.split(b'=',1) for s in Path('/proc/'+pid+'/environ').read_bytes().split(b'\0') if b'=' in s)
root=Path(os.fsdecode(env.get(b'MUSIC_DIR',b'/mnt/data/projects/puuk/music'))).resolve()
dbpath=Path(os.fsdecode(env.get(b'PUUK_DB_PATH',b'/home/fish/apps/puuk/puuk/brain/puuk.db')))
conn=sqlite3.connect('file:'+str(dbpath)+'?mode=ro',uri=True,timeout=2)
try:
    row=conn.execute("""SELECT t.id,t.file_path,v.content_version,v.content_length FROM tracks t
        JOIN delivery_versions v ON v.track_id=t.id
        WHERE v.state='ready' AND v.content_length BETWEEN 1024 AND 1048576
        ORDER BY v.content_length LIMIT 1""").fetchone()
finally:conn.close()
if not row:raise SystemExit('No bounded ready object available; no changes made')
tid,rel,digest,total=row
if not re.fullmatch('[0-9a-f-]{36}',tid) or not re.fullmatch('[0-9a-f]{64}',digest):raise SystemExit('Noncanonical descriptor')
file=(root/rel).resolve()
if not file.is_relative_to(root):raise SystemExit('Unsafe descriptor')
fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
try:
    with os.fdopen(fd,'rb') as source: data=source.read(1048577)
except Exception:raise SystemExit('Cannot read bounded descriptor') from None
if len(data)!=total or hashlib.sha256(data).hexdigest()!=digest:raise SystemExit('Descriptor changed; no requests made')
path='/cdn/audio/'+tid+'/'+digest
expiry=int(time.time())+120
signature=base64.urlsafe_b64encode(hashlib.md5((str(expiry)+path+' '+key).encode(),usedforsecurity=False).digest()).decode().rstrip('=')
query='?md5='+signature+'&expires='+str(expiry)
web='https://web.puuk.fun'
failed=[]

def supports_bytes(response):
    # RFC 9110 14.3 defines a list of range units. The edge may append its own
    # identical bytes value; reject missing/none/unknown units, allow repetition.
    return all(v.strip().lower()=='bytes' for v in response.getheader('Accept-Ranges','').split(','))

def preflight_ok(response):
    methods={v.strip() for v in response.getheader('Access-Control-Allow-Methods','').split(',')}
    allowed={v.strip().lower() for v in response.getheader('Access-Control-Allow-Headers','').split(',')}
    return (response.status==204 and {'GET','HEAD','OPTIONS'}<=methods and
        {'range','if-range','if-none-match'}<=allowed and response.getheader('Access-Control-Max-Age')=='300')

connection=None
host='origin-media.puuk.fun' if origin_only else 'media.puuk.fun'
request_headers={'Origin':web}
if origin_only:request_headers['X-Puuk-Origin-Secret']=values['CDN_ORIGIN_SECRET']
for _ in range(8):
    candidate=http.client.HTTPSConnection(host,timeout=8,context=ssl.create_default_context())
    try:
        candidate.request('HEAD',path+query,headers={**request_headers,'Range':'bytes=0-99'})
        response=candidate.getresponse();response.read()
        applied=(response.status==200 and response.getheader('Content-Length')==str(total)
            and supports_bytes(response))
        node=response.getheader('cache-host','unknown')
        if re.fullmatch('[A-Za-z0-9_.-]{1,80}',node):
            print('header_policy_probe: node='+node+' status='+str(response.status)+
                  ' range_values='+str(sum(k.lower()=='accept-ranges' for k,v in response.getheaders()))+
                  ' expose_values='+str(sum(k.lower()=='access-control-expose-headers' for k,v in response.getheaders())),flush=True)
        response.close()
        if applied:
            candidate.request('OPTIONS',path+query,headers={**request_headers,
                'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'Range, If-Range, If-None-Match'})
            response=candidate.getresponse();response.read()
            applied=preflight_ok(response)
            print('preflight_policy_probe: status='+str(response.status)+' ready='+str(applied).lower(),flush=True)
            response.close()
        if applied:
            connection=candidate
            break
    except Exception:pass
    candidate.close()
if connection is None:raise SystemExit('No node with corrected HEAD/Range and preflight policy observed in eight bounded attempts; no configuration changed.')

def check(label,method,headers,expected,status,content_range=None,cors=web):
    try:
        connection.request(method,path+query,headers={**request_headers,**headers})
        response=connection.getresponse()
        body=response.read(1048577)
        checks={'status':response.status==status,'bytes':expected(body,response) if callable(expected) else body==expected,
            'cache':'no-store' in response.getheader('Cache-Control',''),
            'cors':response.getheader('Access-Control-Allow-Origin')==cors,
            'no_cookie':response.getheader('Set-Cookie') is None,
            'identity':response.getheader('Content-Encoding','identity')=='identity'}
        if content_range is not None:checks['content_range']=response.getheader('Content-Range')==content_range
        if status in (200,206):
            checks['etag']=response.getheader('ETag')=='"sha256-'+digest+'"'
            checks['length']=response.getheader('Content-Length')==str(total if method=='HEAD' else len(body))
            checks['accept_ranges']=supports_bytes(response)
            checks['mime']=response.getheader('Content-Type','').startswith('multipart/byteranges' if callable(expected) else 'audio/')
        if cors==web:
            exposed={s.strip().lower() for s in response.getheader('Access-Control-Expose-Headers','').split(',')}
            required={'accept-ranges','content-range','content-length','etag','last-modified','age'}
            if not origin_only:required.add('cache-host')
            checks['exposed']=required<=exposed
        if method=='OPTIONS' and status==204:
            checks['preflight']=preflight_ok(response)
            if not checks['preflight']:
                for header in ['Access-Control-Allow-Methods','Access-Control-Allow-Headers','Access-Control-Max-Age']:
                    value=response.getheader(header,'missing')
                    if re.fullmatch('[A-Za-z0-9 ,;-]{1,150}',value):print('preflight_header: '+header+'='+value,flush=True)
        valid=all(checks.values())
        node=response.getheader('cache-host','unknown')
        if not re.fullmatch('[A-Za-z0-9_.-]{1,80}',node):node='unknown'
        reasons=','.join(k for k,v in checks.items() if not v) or 'none'
        print(label+': '+('PASS' if valid else 'FAIL')+' status='+str(response.status)+' received='+str(len(body))+' mismatch='+reasons+' node='+node,flush=True)
        if not checks.get('accept_ranges',True):
            ranges=response.getheader('Accept-Ranges','missing')
            if re.fullmatch('[A-Za-z ,;-]{1,100}',ranges):print('accept_ranges_received: '+ranges,flush=True)
        if not valid:failed.append(label)
        response.close()
    except Exception:
        print(label+': FAIL transport_error',flush=True);failed.append(label)
    finally:pass

check('full','GET',{},data,200)
check('head','HEAD',{},b'',200)
for label,start,end in [('start',0,99),('middle',total//2,total//2+99),('end',total-100,total-1)]:
    check(label,'GET',{'Range':f'bytes={start}-{end}'},data[start:end+1],206,f'bytes {start}-{end}/{total}')
check('suffix','GET',{'Range':'bytes=-100'},data[-100:],206,f'bytes {total-100}-{total-1}/{total}')
check('open_end','GET',{'Range':f'bytes={total-100}-'},data[-100:],206,f'bytes {total-100}-{total-1}/{total}')
check('head_ignores_range','HEAD',{'Range':'bytes=0-99'},b'',200)
check('if_range_match','GET',{'Range':'bytes=0-99','If-Range':'"sha256-'+digest+'"'},data[:100],206,f'bytes 0-99/{total}')
check('if_range_mismatch','GET',{'Range':'bytes=0-99','If-Range':'"other-validator"'},data,200)
check('conditional','GET',{'If-None-Match':'"sha256-'+digest+'"'},b'',304)
check('unsatisfiable','GET',{'Range':f'bytes={total}-'},b'',416,f'bytes */{total}')
check('malformed_range','GET',{'Range':'bytes=broken'},b'',400)

def multipart(body,response):
    content_type=response.getheader('Content-Type','')
    if len(content_type)>200:return False
    message=BytesParser(policy=default).parsebytes(('Content-Type: '+content_type+'\r\n\r\n').encode()+body)
    parts=list(message.iter_parts())
    if len(parts)!=2:return False
    return all(part.get('Content-Range')==f'bytes {start}-{end}/{total}' and part.get_payload(decode=True)==data[start:end+1]
               for part,(start,end) in zip(parts,[(0,99),(1000,1099)]))

check('multipart','GET',{'Range':'bytes=0-99,1000-1099'},multipart,206)
preflight={'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'Range, If-Range, If-None-Match'}
check('preflight','OPTIONS',preflight,b'',204)
check('preflight_denied','OPTIONS',{'Origin':'https://untrusted.invalid',**preflight},lambda b,r:len(b)<4096 and not r.getheader('Content-Type','').startswith('audio/'),403,cors=None)
connection.close()
print('AUDIO_READONLY_CHECK: '+('PASS' if not failed else 'FAIL'))
print('One prepared file read; no source-file, account, metadata, exposure or configuration writes. Use only while edge cache is OFF.')
print('Does not prove warm-cache security, media-ticket auth, pilot, rollback or device behavior.')
raise SystemExit(1 if failed else 0)
