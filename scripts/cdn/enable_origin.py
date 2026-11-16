#!/usr/bin/env python3
"""Operator-only scoped origin activation. Keys never leave memory or root backups."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import urllib.request
import urllib.error

ENV = Path('/etc/puuk/cdn.env')
ORIGIN = Path('/etc/nginx/sites-available/puuk-origin-media')
WEB = Path('/etc/nginx/sites-available/puuk-web')
STAGE = Path('/home/fish/puuk-cdn-setup')

def run(*args):
    result = subprocess.run(args, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError('operator_command_failed')

def replace(path, text, mode):
    tmp = path.with_name(path.name + '.cdn-pending')
    with tmp.open('x') as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    tmp.chmod(mode)
    os.replace(tmp, path)

if os.geteuid() != 0:
    raise SystemExit('Run with sudo')
try:
    st = ENV.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077:
        raise ValueError('unsafe_env_file')
    env_text = ENV.read_text()
    values = dict(line.split('=',1) for line in env_text.splitlines() if '=' in line and not line.startswith('#'))
    if any(values.get(k) != 'false' for k in ['CDN_DELIVERY_ENABLED','CDN_ORIGIN_ENABLED','CDN_PURGE_ENABLED']):
        raise ValueError('expected_all_flags_off')
    if not re.fullmatch('[0-9a-f]{64}', values.get('CDN_ORIGIN_SECRET','')) or not re.fullmatch('[0-9a-f]{32}',values.get('CDN_SIGNING_SECRET','')):
        raise ValueError('invalid_secret_configuration')
    web_text = WEB.read_text()
    if hashlib.sha256(web_text.encode()).hexdigest() != 'f4057ca4d1fa450f97184e1b4e8f3ffd0c5479ae9001dcbdd561a28546919716':
        raise ValueError('web_config_drift')
    origin_text = ORIGIN.read_text()
    if origin_text != (STAGE / 'origin-https-closed.conf').read_text():
        raise ValueError('origin_config_drift')
    proxy_text = (STAGE / 'origin-proxy.conf').read_text()
    if 'proxy_pass http://127.0.0.1:8000;' not in proxy_text or proxy_text.count('{') != proxy_text.count('}'):
        raise ValueError('invalid_proxy_candidate')
    deny = 'server {\n    access_log /var/log/nginx/puuk-web.access.log puuk_web_safe;\n    error_log /dev/null;\n    # Puuk origin paths are unavailable on the web vhost.\n    location = /cdn { return 404; }\n    location ^~ /cdn/ { return 404; }'
    new_web, count = re.subn(r'(?m)^server\s*\{', lambda _: deny, web_text)
    new_web = "log_format puuk_web_safe '$status $request_method $uri $body_bytes_sent $request_time';\n" + new_web
    if count != 2:
        raise ValueError('unexpected_web_server_blocks')
    new_env, count = re.subn(r'(?m)^CDN_ORIGIN_ENABLED=false$', 'CDN_ORIGIN_ENABLED=true', env_text)
    if count != 1:
        raise ValueError('ambiguous_origin_flag')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = Path('/var/backups/puuk-cdn') / ('origin-' + stamp)
    backup.mkdir(mode=0o700)
    for src,name in [(ENV,'cdn.env'),(ORIGIN,'origin.conf'),(WEB,'web.conf')]:
        shutil.copy2(src,backup/name)
    print('Protected rollback backup:', backup, flush=True)
    try:
        # Proxy is published while backend origin flag is still OFF.
        replace(ORIGIN, proxy_text, 0o644)
        replace(WEB, new_web, 0o644)
        run('/usr/sbin/nginx','-t')
        run('systemctl','reload','nginx')
        replace(ENV,new_env,0o600)
        run('systemctl','restart','puuk-brain')
        run('systemctl','is-active','--quiet','puuk-brain')
        ready=False
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        end=time.monotonic()+30
        while time.monotonic()<end:
            try:
                request=urllib.request.Request('http://127.0.0.1:8000/cdn/audio/11111111-1111-4111-8111-111111111111/'+'a'*64,method='HEAD')
                response=opener.open(request,timeout=1)
                response.close()
            except urllib.error.HTTPError as response:
                ready=response.code==403 and 'no-store' in response.headers.get('Cache-Control','')
                response.close()
            except Exception:
                pass
            if ready:break
            time.sleep(.5)
        if not ready:raise ValueError('protected_origin_readiness_failed')
        print('Origin ON and denies missing secret with 403/no-store. CDN issuance and purge remain OFF. No bot restart.')
    except BaseException:
        replace(ENV,env_text,0o600)
        replace(ORIGIN,origin_text,0o644)
        replace(WEB,web_text,0o644)
        run('/usr/sbin/nginx','-t')
        run('systemctl','reload','nginx')
        run('systemctl','restart','puuk-brain')
        print('Restored previous closed origin and off flags.')
        raise
except Exception as exc:
    print('Origin activation stopped:',str(exc) if isinstance(exc,ValueError) else type(exc).__name__)
    sys.exit(1)
