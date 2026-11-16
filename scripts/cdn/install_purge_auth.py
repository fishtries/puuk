#!/usr/bin/env python3
"""Install the reviewed four-file IAM update, keeping user delivery disabled.

Run from an iam-release directory containing manifest.json and source/. The
separately transferred authorized key is never included in the source package.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path('/home/fish/apps/puuk/puuk/brain')
ENV = Path('/etc/puuk/cdn.env')
KEY = Path('/etc/puuk/cdn-purge-account.json')
STAGE = Path(__file__).resolve().parent
INPUT_KEY = STAGE.parent / 'purge-authorized-key.json'
FILES = {'config.py', 'repositories/delivery.py', 'services/cdn_purge_service.py',
         'services/cdn_credentials.py'}


def run(*args, **options):
    result = subprocess.run(args, capture_output=True, timeout=45, **options)
    if result.returncode:
        raise RuntimeError('operator_command_failed')
    return result


def atomic(path, raw, mode, uid=0, gid=0):
    tmp = path.with_name(path.name + '.iam-pending')
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


def ready():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    end = time.monotonic() + 30
    while time.monotonic() < end:
        try:
            request = urllib.request.Request('http://127.0.0.1:8000/cdn/audio/' +
                '11111111-1111-4111-8111-111111111111/' + 'a' * 64, method='HEAD')
            response = opener.open(request, timeout=1)
            response.close()
        except urllib.error.HTTPError as response:
            ok = response.code == 403 and 'no-store' in response.headers.get('Cache-Control', '')
            response.close()
            if ok:
                return
        except (OSError, TimeoutError):
            pass
        time.sleep(.5)
    raise RuntimeError('readiness_failed')


def main():
    if os.geteuid() != 0:
        raise ValueError('root_required')
    account = pwd.getpwnam('fish')
    env_stat = ENV.lstat()
    if not stat.S_ISREG(env_stat.st_mode) or env_stat.st_uid != 0 or env_stat.st_mode & 0o077:
        raise ValueError('unsafe_env')
    old_env = ENV.read_bytes()
    values = dict(line.split('=', 1) for line in old_env.decode().splitlines() if '=' in line and not line.startswith('#'))
    if values.get('CDN_ORIGIN_ENABLED') != 'true' or any(values.get(k) != 'false' for k in ('CDN_DELIVERY_ENABLED', 'CDN_PURGE_ENABLED')):
        raise ValueError('unexpected_flags')
    if values.get('CDN_PURGE_TOKEN') or KEY.exists() or KEY.is_symlink():
        raise ValueError('existing_credential')
    manifest = json.loads((STAGE / 'manifest.json').read_bytes())
    if set(manifest) != FILES:
        raise ValueError('manifest_allowlist')
    for name, item in manifest.items():
        target = ROOT / name
        candidate = (STAGE / 'source' / name).read_bytes()
        compile(candidate, name, 'exec')
        if hashlib.sha256(candidate).hexdigest() != item['sha256']:
            raise ValueError('candidate_drift')
        if target.is_symlink():
            raise ValueError('target_symlink')
        actual = hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None
        if actual != item['predecessor']:
            raise ValueError('predecessor_drift')
    key_stat = INPUT_KEY.lstat()
    if not stat.S_ISREG(key_stat.st_mode) or key_stat.st_uid != account.pw_uid or key_stat.st_mode & 0o077 or key_stat.st_size > 8192:
        raise ValueError('unsafe_input_key')
    key_bytes = INPUT_KEY.read_bytes()
    key = json.loads(key_bytes)
    if key.get('service_account_id') != 'aje82fsqnvfiqfp8s97e' or key.get('id') != 'ajermrc66edqlnf7rg8b':
        raise ValueError('wrong_identity')
    changes = {'CDN_RESOURCE_ID': 'bc8rblqq55f6agqt4y6s',
               'CDN_PURGE_SERVICE_ACCOUNT_KEY_PATH': str(KEY), 'CDN_PILOT_USER_IDS': '1'}
    new_env = old_env.decode()
    for name, value in changes.items():
        pattern = r'(?m)^' + re.escape(name) + r'=.*$'
        if len(re.findall(pattern, new_env)) > 1:
            raise ValueError('duplicate_env')
        if re.search(pattern, new_env):
            new_env = re.sub(pattern, lambda _: name + '=' + value, new_env)
        else:
            new_env = new_env.rstrip('\n') + '\n' + name + '=' + value + '\n'
    backup = Path('/var/backups/puuk-cdn') / ('iam-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    backup.mkdir(mode=0o700)
    shutil.copy2(ENV, backup / 'cdn.env')
    for name in FILES:
        if (ROOT / name).exists():
            (backup / name).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copy2(ROOT / name, backup / name)
    (backup / 'manifest.json').write_text(json.dumps(manifest))
    print('Protected rollback backup:', backup, flush=True)
    try:
        ENV.parent.chmod(0o750)
        os.chown(ENV.parent, 0, account.pw_gid)
        atomic(KEY, key_bytes, 0o600, account.pw_uid, account.pw_gid)
        run('systemctl', 'stop', 'puuk-brain')
        for name in FILES:
            atomic(ROOT / name, (STAGE / 'source' / name).read_bytes(), 0o644, account.pw_uid, account.pw_gid)
        # Validate the exact installed credential as the service's user.
        run(str(ROOT / 'venv/bin/python'), '-c',
            'from services.cdn_credentials import service_account_key; service_account_key("/etc/puuk/cdn-purge-account.json")',
            cwd=ROOT, user=account.pw_uid, group=account.pw_gid)
        atomic(ENV, new_env.encode(), 0o600)
        run('systemctl', 'start', 'puuk-brain')
        ready()
    except BaseException:
        run('systemctl', 'stop', 'puuk-brain')
        atomic(ENV, old_env, 0o600)
        for name, item in manifest.items():
            if item['predecessor'] is None:
                (ROOT / name).unlink(missing_ok=True)
            else:
                atomic(ROOT / name, (backup / name).read_bytes(), 0o644, account.pw_uid, account.pw_gid)
        KEY.unlink(missing_ok=True)
        run('systemctl', 'start', 'puuk-brain')
        print('Restored source and environment; origin remains protected.', flush=True)
        raise
    INPUT_KEY.unlink()
    print('Four verified sources installed; private service-account key validated as fish.')
    print('Origin ON; CDN issuance and purge OFF. Pilot membership prepared for admin ID 1. No bot restart.')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('IAM installation stopped:', type(exc).__name__)
        sys.exit(1)
