#!/usr/bin/env python3
"""Bounded read-only live delivery proof. No accounts, track/file edits or cache enablement.

Select one already prepared object <=1 MiB. Compare its exact bytes and ranges;
never print signed URLs, keys, paths, audio bytes or track metadata.
"""
import base64
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
import time

if os.geteuid()!=0:raise SystemExit('Run with sudo')
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

def check(label,method,headers,expected,status,content_range=None):
    connection=http.client.HTTPSConnection('media.puuk.fun',timeout=8,context=ssl.create_default_context())
    try:
        connection.request(method,path+query,headers={'Origin':web,**headers})
        response=connection.getresponse()
        body=response.read(1048577)
        valid=(response.status==status and body==expected and
            'no-store' in response.getheader('Cache-Control','') and
            response.getheader('Access-Control-Allow-Origin')==web)
        if content_range is not None: valid=valid and response.getheader('Content-Range')==content_range
        if status in (200,206):
            valid=valid and response.getheader('ETag')=='"sha256-'+digest+'"'
            valid=valid and response.getheader('Content-Length')==str(total if method=='HEAD' else len(expected))
            valid=valid and response.getheader('Accept-Ranges')=='bytes'
            valid=valid and response.getheader('Content-Type','').startswith('audio/')
        print(label+': '+('PASS' if valid else 'FAIL')+' status='+str(response.status)+' received='+str(len(body)),flush=True)
        if not valid:failed.append(label)
        response.close()
    except Exception:
        print(label+': FAIL transport_error',flush=True);failed.append(label)
    finally:connection.close()

check('full','GET',{},data,200)
check('head','HEAD',{},b'',200)
for label,start,end in [('start',0,99),('middle',total//2,total//2+99),('end',total-100,total-1)]:
    check(label,'GET',{'Range':f'bytes={start}-{end}'},data[start:end+1],206,f'bytes {start}-{end}/{total}')
check('suffix','GET',{'Range':'bytes=-100'},data[-100:],206,f'bytes {total-100}-{total-1}/{total}')
print('AUDIO_READONLY_CHECK: '+('PASS' if not failed else 'FAIL'))
print('One existing prepared file read; no audio, account, metadata, exposure or configuration writes. Cache remains off.')
print('Does not prove warm-cache security, media-ticket auth, pilot, rollback or device behavior.')
raise SystemExit(1 if failed else 0)
