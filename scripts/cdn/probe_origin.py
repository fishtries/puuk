#!/usr/bin/env python3
"""HEAD-only operator probes; no audio read, keys, request URLs or exceptions emitted."""
import base64
import hashlib
import http.client
import os
from pathlib import Path
import re
import ssl
import stat
import time

if os.geteuid() != 0:
    raise SystemExit('Run with sudo')
p=Path('/etc/puuk/cdn.env')
st=p.lstat()
if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o077:
    raise SystemExit('Unsafe secret file')
values=dict(s.split('=',1) for s in p.read_text().splitlines() if '=' in s and not s.startswith('#'))
key=values.get('CDN_SIGNING_SECRET','')
origin_key=values.get('CDN_ORIGIN_SECRET','')
if not re.fullmatch('[0-9a-f]{32}',key) or not re.fullmatch('[0-9a-f]{64}',origin_key):
    raise SystemExit('Invalid key configuration')
path='/cdn/audio/11111111-1111-4111-8111-111111111111/'+'a'*64
expires=int(time.time())+120
token=base64.urlsafe_b64encode(hashlib.md5((str(expires)+path+' '+key).encode(),usedforsecurity=False).digest()).decode().rstrip('=')
query='?md5='+token+'&expires='+str(expires)
origin='https://web.puuk.fun'
observed = {}

def probe(label,host,suffix,headers=()):
    conn=http.client.HTTPSConnection(host,timeout=8,context=ssl.create_default_context())
    try:
        conn.putrequest('HEAD',path+suffix)
        conn.putheader('Origin',origin)
        for k,v in headers:conn.putheader(k,v)
        conn.endheaders()
        response=conn.getresponse()
        cors='web' if response.getheader('Access-Control-Allow-Origin')==origin else 'absent_or_unexpected'
        cache='no-store' if 'no-store' in response.getheader('Cache-Control','') else 'other'
        observed[label] = (response.status, cors, cache)
        print(label+': '+str(response.status)+' cors='+cors+' client_cache='+cache,flush=True)
        response.close()
    except Exception:
        observed[label] = (None, 'absent', 'other')
        print(label+': transport_error',flush=True)
    finally:conn.close()

probe('origin_missing_secret','origin-media.puuk.fun',query)
probe('origin_wrong_secret','origin-media.puuk.fun',query,[('X-Puuk-Origin-Secret','probe-wrong')])
probe('origin_correct_secret','origin-media.puuk.fun',query,[('X-Puuk-Origin-Secret',origin_key)])
probe('origin_duplicate_secret','origin-media.puuk.fun',query,[('X-Puuk-Origin-Secret',origin_key),('X-Puuk-Origin-Secret','probe-wrong')])
probe('cdn_unsigned','media.puuk.fun','')
probe('cdn_valid','media.puuk.fun',query)
probe('cdn_client_wrong_secret','media.puuk.fun',query,[('X-Puuk-Origin-Secret','probe-wrong')])
probe('cdn_client_duplicate_secret','media.puuk.fun',query,[('X-Puuk-Origin-Secret','probe-wrong-a'),('X-Puuk-Origin-Secret','probe-wrong-b')])
probe('cdn_extra_query','media.puuk.fun',query+'&probe_extra=1')
print('Expected statuses: origin missing/wrong/duplicate 403; correct 404; CDN unsigned 403; valid/client-wrong/client-duplicate 404; extra query 400.')
print('Synthetic missing path only. Actual audio bytes, warm cache and final acceptance remain unverified.')

expected = {'origin_missing_secret': 403, 'origin_wrong_secret': 403,
    'origin_correct_secret': 404, 'origin_duplicate_secret': 403,
    'cdn_unsigned': 403, 'cdn_valid': 404, 'cdn_client_wrong_secret': 404,
    'cdn_client_duplicate_secret': 404, 'cdn_extra_query': 400}
failures = [label for label, status in expected.items()
            if observed.get(label) != (status, 'web', 'no-store')]
print('INITIAL_BOUNDARY_CHECK: ' + ('PASS' if not failures else 'FAIL: ' + ', '.join(failures)))
raise SystemExit(1 if failures else 0)
