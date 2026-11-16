#!/usr/bin/env python3
"""One-file reviewed expiry update; user delivery must remain disabled."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path('/home/fish/apps/puuk/puuk/brain')
TARGET = ROOT / 'services/delivery_service.py'
ENV = Path('/etc/puuk/cdn.env')
STAGE = Path(__file__).resolve().parent


def run(*args):
    result = subprocess.run(args, capture_output=True, timeout=45)
    if result.returncode:
        raise RuntimeError('service_command_failed')
    return result.stdout.decode().strip()


def publish(path, raw, mode, uid=0, gid=0):
    tmp = path.with_name(path.name + '.cohort-pending')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
            os.fchmod(f.fileno(), mode)
            os.fchown(f.fileno(), uid, gid)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def ready(started):
    pid = run('systemctl', 'show', 'puuk-brain', '--property=MainPID', '--value')
    env = dict(os.fsdecode(s).split('=', 1) for s in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in s)
    if any(env.get(k) != v for k, v in {'CDN_DELIVERY_ENABLED': 'false', 'CDN_ORIGIN_ENABLED': 'true', 'CDN_PURGE_ENABLED': 'true', 'CDN_DELIVERY_EPOCH': 'raw-query-v1'}.items()):
        return False
    db = sqlite3.connect('file:' + env.get('PUUK_DB_PATH', str(ROOT / 'puuk.db')) + '?mode=ro', uri=True, timeout=.1)
    try:
        row = db.execute("SELECT value FROM delivery_control WHERE key='purge_heartbeat'").fetchone()
        if not row or not started <= float(row[0]) <= time.time():
            return False
    finally:
        db.close()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        r = opener.open(urllib.request.Request('http://127.0.0.1:8000/cdn/audio/' + '11111111-1111-4111-8111-111111111111/' + 'a' * 64, method='HEAD'), timeout=1)
        r.close()
        return False
    except urllib.error.HTTPError as r:
        ok = r.code == 403 and 'no-store' in r.headers.get('Cache-Control', '')
        r.close()
        return ok


def main():
    if os.geteuid() != 0:
        raise ValueError('root_required')
    st = ENV.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077:
        raise ValueError('unsafe_environment')
    old_env = ENV.read_bytes()
    values = dict(s.split('=', 1) for s in old_env.decode().splitlines() if '=' in s and not s.startswith('#'))
    if any(values.get(k) != v for k, v in {'CDN_DELIVERY_ENABLED': 'false', 'CDN_ORIGIN_ENABLED': 'true', 'CDN_PURGE_ENABLED': 'true'}.items()):
        raise ValueError('unexpected_flags')
    candidate = (STAGE / 'delivery_service.py').read_bytes()
    old = TARGET.read_bytes()
    manifest = json.loads((STAGE / 'manifest.json').read_bytes())
    if TARGET.is_symlink() or hashlib.sha256(old).hexdigest() != manifest['predecessor_sha256'] or hashlib.sha256(candidate).hexdigest() != manifest['source_sha256']:
        raise ValueError('source_drift')
    compile(candidate, 'delivery_service.py', 'exec')
    new_env, count = re.subn(r'(?m)^CDN_DELIVERY_EPOCH=.*$', 'CDN_DELIVERY_EPOCH=raw-query-v1', old_env.decode())
    if count != 1:
        raise ValueError('ambiguous_epoch')
    backup = Path('/var/backups/puuk-cdn') / ('expiry-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    backup.mkdir(mode=0o700)
    shutil.copy2(TARGET, backup / 'delivery_service.py')
    shutil.copy2(ENV, backup / 'cdn.env')
    shutil.copy2(STAGE / 'manifest.json', backup / 'manifest.json')
    account = pwd.getpwnam('fish')
    print('Protected rollback backup:', backup, flush=True)
    started = time.time()
    try:
        run('systemctl', 'stop', 'puuk-brain')
        publish(TARGET, candidate, 0o644, account.pw_uid, account.pw_gid)
        publish(ENV, new_env.encode(), 0o600)
        run('systemctl', 'start', 'puuk-brain')
        end = time.monotonic() + 30
        while time.monotonic() < end:
            try:
                if ready(started):
                    print('EXPIRY_INSTALL: PASS; verified source/epoch, fresh purge heartbeat, protected origin; delivery OFF. No bot restart or DB restore.')
                    return
            except (OSError, sqlite3.Error, urllib.error.URLError):
                pass
            time.sleep(.5)
        raise RuntimeError('readiness_failed')
    except BaseException:
        run('systemctl', 'stop', 'puuk-brain')
        publish(TARGET, old, 0o644, account.pw_uid, account.pw_gid)
        publish(ENV, old_env, 0o600)
        run('systemctl', 'start', 'puuk-brain')
        print('Previous source and environment restored.')
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('Expiry installation stopped:', type(exc).__name__)
        raise SystemExit(1)
