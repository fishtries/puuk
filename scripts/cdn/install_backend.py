#!/usr/bin/env python3
"""Install only a frozen Puuk backend manifest, off by default, with source rollback.

Run --check as fish, --apply as root. Artifact directory contains manifest.json
and brain/<relative source>. No environment values or request URLs are printed.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import stat
import subprocess
import sys
import time
import urllib.request
import urllib.error

ROOT = Path('/home/fish/apps/puuk/puuk/brain')
DROPIN = Path('/etc/systemd/system/puuk-brain.service.d/40-cdn.conf')
ALLOWED = set('''api.py auth.py config.py metadata.py migrations/016_cdn_share_contract.sql
repositories/albums.py repositories/artists.py repositories/base.py repositories/delivery.py
repositories/schema.py repositories/share_entities.py repositories/tracks.py repositories/users.py
routers/search.py routers/share.py routers/streaming.py scan.py serializers.py services/album_service.py
services/cdn_purge_service.py services/content_version_service.py services/delivery_boundary.py
services/delivery_service.py services/library_service.py services/media_locations.py
services/track_deletion_service.py services/track_metadata_service.py'''.split())
DROPIN_TEXT = '''[Service]
EnvironmentFile=/etc/puuk/cdn.env
ExecStart=
ExecStart=/home/fish/apps/puuk/puuk/brain/venv/bin/uvicorn api:app --host 127.0.0.1 --port 8000 --no-access-log
'''


def digest(p):
    if not p.exists():
        return None
    if not stat.S_ISREG(p.lstat().st_mode):
        raise ValueError('nonregular_file')
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run(*args):
    result = subprocess.run(args, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError('operator_command_failed: ' + args[0])


def publish(source, target, owner):
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + '.cdn-install')
    # Refuse to reuse unknown leftovers from an earlier install.
    with temp.open('xb') as f:
        f.write(source.read_bytes())
        f.flush()
        os.fsync(f.fileno())
    os.chmod(temp, 0o644)
    os.chown(temp, *owner)
    os.replace(temp, target)


def check(artifact):
    entries = json.loads((artifact / 'manifest.json').read_text())['files']
    if len(entries) != len(ALLOWED) or {e['path'] for e in entries} != ALLOWED:
        raise ValueError('invalid_manifest_allowlist')
    for entry in entries:
        name = entry['path']
        if digest(artifact / 'brain' / name) != entry['sha256']:
            raise ValueError('artifact_checksum_mismatch: ' + name)
        if digest(ROOT / name) != entry['before']:
            raise ValueError('remote_source_drift: ' + name)
        if (ROOT / name).with_name(Path(name).name + '.cdn-install').exists():
            raise ValueError('unknown_install_leftover: ' + name)
        if name.endswith('.py'):
            compile((artifact / 'brain' / name).read_bytes(), name, 'exec')
    print('Verified 27 source hashes, remote predecessors, allowlist and Python syntax.')
    return entries


def apply(artifact, entries):
    if os.geteuid() != 0:
        raise ValueError('apply_requires_sudo')
    env_file = Path('/etc/puuk/cdn.env')
    st = env_file.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077:
        raise ValueError('unsafe_secret_file')
    env = dict(line.split('=', 1) for line in env_file.read_text().splitlines()
               if line and not line.startswith('#') and '=' in line)
    for key in ['CDN_DELIVERY_ENABLED', 'CDN_ORIGIN_ENABLED', 'CDN_PURGE_ENABLED']:
        if env.get(key) != 'false':
            raise ValueError('initial_flags_must_be_off')
    # This release is reviewed for the exact existing unit command; reject custom overrides.
    command = subprocess.run(['systemctl', 'show', 'puuk-brain', '--property=ExecStart', '--value'],
                             capture_output=True, text=True, check=True).stdout
    expected = str(ROOT / 'venv/bin/uvicorn') + ' api:app --host 127.0.0.1 --port 8000'
    if ('argv[]=' + expected + ' ;') not in command or DROPIN.exists():
        raise ValueError('service_command_or_dropin_changed')
    result = subprocess.run(['systemctl', 'show', 'puuk-brain', '--property=MainPID', '--value'],
                            capture_output=True, text=True, check=True)
    pid = int(result.stdout.strip())
    process_env = dict(item.split(b'=', 1) for item in Path('/proc/' + str(pid) + '/environ').read_bytes().split(b'\0') if b'=' in item)
    database = Path(os.fsdecode(process_env.get(b'PUUK_DB_PATH', os.fsencode(ROOT / 'puuk.db'))))
    if not database.is_absolute() or not database.is_file():
        raise ValueError('database_path_unconfirmed')
    if process_env.get(b'WEB_CONCURRENCY', b'1') != b'1':
        raise ValueError('worker_count_changed')
    uid, gid = ROOT.stat().st_uid, ROOT.stat().st_gid
    if uid != pwd.getpwnam('fish').pw_uid:
        raise ValueError('unexpected_source_owner')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = Path('/var/backups/puuk-cdn') / stamp
    backup.mkdir(parents=True, mode=0o700)
    backup.parent.chmod(0o700)
    (backup / 'manifest.json').write_bytes((artifact / 'manifest.json').read_bytes())
    for entry in entries:
        if entry['before'] is not None:
            dst = backup / 'brain' / entry['path']
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / entry['path'], dst)
    print('Backup directory:', backup, flush=True)
    stopped = False
    changed = []
    try:
        run('systemctl', 'stop', 'puuk-brain')
        stopped = True
        # Online SQLite backup remains consistent if the bot writes concurrently.
        backup_code = '''import sqlite3,sys
source=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True,timeout=5)
target=sqlite3.connect(sys.argv[2],timeout=5)
try: source.backup(target,pages=128,sleep=.05)
finally: target.close(); source.close()
'''
        run(str(ROOT / 'venv/bin/python'), '-c', backup_code, str(database), str(backup / 'database.sqlite'))
        (backup / 'database.sqlite').chmod(0o600)
        # Recheck after stopping; never overwrite concurrent source edits.
        for entry in entries:
            if digest(ROOT / entry['path']) != entry['before']:
                raise ValueError('source_changed_before_publication')
        for entry in entries:
            name = entry['path']
            publish(artifact / 'brain' / name, ROOT / name, (uid, gid))
            changed.append(entry)
        lock = ROOT / '.delivery-locks'
        if not lock.exists():
            lock.mkdir(mode=0o700)
            os.chown(lock, uid, gid)
        if lock.is_symlink() or lock.stat().st_uid != uid or stat.S_IMODE(lock.stat().st_mode) != 0o700:
            raise ValueError('unsafe_delivery_lock_directory')
        DROPIN.parent.mkdir(parents=True, exist_ok=True)
        DROPIN.write_text(DROPIN_TEXT)
        DROPIN.chmod(0o644)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'start', 'puuk-brain')
        run('systemctl', 'is-active', '--quiet', 'puuk-brain')
        ready = False
        until = time.monotonic() + 30
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        while time.monotonic() < until:
            try:
                response = opener.open('http://127.0.0.1:8000/api/share/track/11111111-1111-4111-8111-111111111111', timeout=1)
                response.close()
            except urllib.error.HTTPError as response:
                ready = response.code == 401 and 'no-store' in response.headers.get('Cache-Control', '')
                response.close()
            except Exception:
                pass
            if ready:
                break
            time.sleep(.5)
        if not ready:
            raise ValueError('readiness_failed')
        for entry in entries:
            if digest(ROOT / entry['path']) != entry['sha256']:
                raise ValueError('post_install_hash_mismatch')
        print('Backend started with CDN/origin/purge OFF. Database backup retained; no bot restart.')
        print('Coordinator must verify HTTP readiness and effective flags before further configuration.')
    except BaseException:
        if stopped:
            run('systemctl', 'stop', 'puuk-brain')
            for entry in reversed(changed):
                target = ROOT / entry['path']
                if entry['before'] is None:
                    target.unlink()
                else:
                    publish(backup / 'brain' / entry['path'], target, (uid, gid))
            # Keep additive DB state; never restore the database over new user data.
            if DROPIN.exists():
                DROPIN.unlink()
            run('systemctl', 'daemon-reload')
            run('systemctl', 'start', 'puuk-brain')
            print('Source rollback performed; database was not restored.')
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        artifact = Path(__file__).resolve().parent
        rows = check(artifact)
        if args.apply:
            apply(artifact, rows)
        else:
            print('Check only. No service, source or database writes.')
    except BaseException as exc:
        if isinstance(exc, (KeyboardInterrupt, SystemExit)):
            raise
        print('Install stopped:', type(exc).__name__, str(exc) if isinstance(exc, ValueError) else 'operator step failed; inspect backup/service locally')
        sys.exit(1)
