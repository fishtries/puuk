#!/usr/bin/env python3
"""Install an exact four-file catalog transfer candidate, preserving live flags.

Run as root from the staged release directory. Source predecessors and candidate
hashes are mandatory; failed readiness restores only these sources. No DB restore,
environment change, bot restart or audio modification.
"""
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import time
from datetime import datetime, timezone
import http.client

ROOT = Path('/home/fish/apps/puuk/puuk/brain')
FILES = {'api.py', 'routers/streaming.py', 'services/cover_extractor.py',
         'services/catalog_compression.py'}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def command(*args):
    result = subprocess.run(args, capture_output=True, timeout=45)
    if result.returncode:
        raise RuntimeError('service_command_failed')
    return result.stdout.decode().strip()


def live_flags():
    pid = command('systemctl', 'show', 'puuk-brain', '--property=MainPID', '--value')
    env = dict(os.fsdecode(s).split('=', 1) for s in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in s)
    return {k: env.get(k) for k in ('CDN_DELIVERY_ENABLED', 'CDN_ORIGIN_ENABLED',
            'CDN_PURGE_ENABLED', 'CDN_PILOT_USER_IDS', 'CDN_DELIVERY_EPOCH')}


def publish(path, data, account):
    pending = path.with_name(path.name + '.catalog-pending')
    fd = os.open(pending, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o644)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
            os.fchown(f.fileno(), account.pw_uid, account.pw_gid)
        os.replace(pending, path)
    finally:
        pending.unlink(missing_ok=True)


def main():
    if os.geteuid() != 0:
        raise ValueError('root_required')
    stage = Path(__file__).resolve().parent
    manifest = json.loads((stage / 'manifest.json').read_bytes())
    if set(manifest) != FILES:
        raise ValueError('invalid_manifest')
    for name, hashes in manifest.items():
        if digest(stage / name) != hashes['candidate'] or digest(ROOT / name) != hashes['predecessor']:
            raise ValueError('source_hash_mismatch')
        compile((stage / name).read_bytes(), name, 'exec')
    flags = live_flags()
    backup = Path('/var/backups/puuk-cdn') / ('catalog-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    backup.mkdir(mode=0o700)
    for name in FILES:
        if (ROOT / name).exists():
            (backup / name).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, backup / name)
    shutil.copy2(stage / 'manifest.json', backup / 'manifest.json')
    print('Protected source rollback backup:', backup, flush=True)
    account = pwd.getpwnam('fish')
    try:
        command('systemctl', 'stop', 'puuk-brain')
        for name in FILES:
            publish(ROOT / name, (stage / name).read_bytes(), account)
        command('systemctl', 'start', 'puuk-brain')
        deadline = time.monotonic() + 30
        while True:
            c = http.client.HTTPConnection('127.0.0.1', 8000, timeout=1)
            try:
                c.request('GET', '/api/tracks')
                r = c.getresponse()
                r.read(8192)
                if r.status == 401 and live_flags() == flags:
                    break
            except OSError:
                pass
            finally:
                c.close()
            if time.monotonic() >= deadline:
                raise ValueError('readiness_failed')
            time.sleep(.5)
        print('CATALOG_INSTALL: PASS; auth readiness, exact sources, live CDN flags preserved; no bot restart or DB restore.')
    except BaseException:
        command('systemctl', 'stop', 'puuk-brain')
        for name in FILES:
            if manifest[name]['predecessor'] is None:
                (ROOT / name).unlink(missing_ok=True)
            else:
                publish(ROOT / name, (backup / name).read_bytes(), account)
        command('systemctl', 'start', 'puuk-brain')
        print('Previous exact sources restored.', flush=True)
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('Catalog install stopped:', type(exc).__name__, str(exc) if isinstance(exc, ValueError) else '')
        raise SystemExit(1)
