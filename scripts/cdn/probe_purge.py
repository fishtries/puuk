#!/usr/bin/env python3
"""One durable, bounded purge of a verified nonexistent track prefix.

Run repeatedly to poll the same operation. Never purges the resource as a whole,
never changes audio/catalog/exposures, and reserves the production rate limiter.
"""
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys
import time
import uuid

ROOT = Path('/home/fish/apps/puuk/puuk/brain')
MARKER = Path('/home/fish/puuk-cdn-setup/purge-smoke.json')


def save(obj):
    tmp = MARKER.with_suffix('.pending')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(obj, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, MARKER)
    finally:
        tmp.unlink(missing_ok=True)


def main():
    if os.geteuid() != 0:
        raise ValueError('root_required')
    pid = subprocess.run(['systemctl', 'show', 'puuk-brain', '--property=MainPID', '--value'],
                         capture_output=True, text=True, check=True, timeout=5).stdout.strip()
    env = dict(os.fsdecode(s).split('=', 1) for s in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in s)
    if env.get('CDN_DELIVERY_ENABLED') != 'false' or env.get('CDN_ORIGIN_ENABLED') != 'true':
        raise ValueError('unexpected_flags')
    account = pwd.getpwnam('fish')
    os.environ.clear()
    os.environ.update(env)
    os.setgroups([])
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
    os.chdir(ROOT)
    sys.path.insert(0, str(ROOT))
    import config
    from repositories import delivery
    from services.cdn_purge_service import credential_payload
    from services.content_version_service import OwnerSupervisor
    owner = OwnerSupervisor('operator-probe')
    owner.owner_fd = os.open(Path(config.get_delivery_lock_dir()) / 'operator-probe.lock',
                             os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(owner.owner_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if MARKER.exists():
            state = json.loads(MARKER.read_bytes())
            if state['status'] not in ('polling', 'succeeded'):
                raise ValueError('ambiguous_previous_submission_no_automatic_repeat')
        else:
            now = time.time()
            track = str(uuid.uuid4())
            with delivery.transaction() as conn:
                if conn.execute('SELECT 1 FROM tracks WHERE id=?', (track,)).fetchone():
                    raise ValueError('test_identity_collision')
                rate = conn.execute("SELECT value FROM delivery_control WHERE key='purge_next_submission'").fetchone()
                if rate and float(rate[0]) > now:
                    raise ValueError('submission_rate_reserved_try_later')
                conn.execute("INSERT INTO delivery_control(key,value) VALUES ('purge_next_submission',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(now + 65),))
            state = {'status': 'submitting', 'track': track, 'started_at': now}
            save(state)
        if state['status'] != 'succeeded' and time.time() - state['started_at'] >= 900:
            raise ValueError('operation_deadline_exceeded')
        data = {**credential_payload(), 'resource': config.CDN_RESOURCE_ID,
                'paths': ['/cdn/audio/' + state['track'] + '/*'],
                'operation': state.get('operation_id')}
        raw = json.dumps(data, separators=(',', ':')).encode()
        if len(raw) > 8192:
            raise ValueError('oversized_credentials')
        result = owner.run_child('services.cdn_purge_service', ['--http-job'],
                                 budget=10, limit=4096, stdin=raw)
        status = result.get('status')
        if status not in ('polling', 'succeeded') or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', result.get('operation_id', '')):
            raise ValueError('provider_operation_not_successful')
        if state.get('operation_id') and result['operation_id'] != state['operation_id']:
            raise ValueError('operation_identity_mismatch')
        state.update(status=status, operation_id=result['operation_id'])
        save(state)
        print('PURGE_AUTH_SMOKE: ' + ('PASS' if status == 'succeeded' else 'POLLING'))
        print('One nonexistent track prefix; no catalog/audio/exposure writes. Durable rate reservation retained.')
    finally:
        os.close(owner.owner_fd)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('Purge probe stopped:', type(exc).__name__, str(exc) if isinstance(exc, ValueError) else '')
        sys.exit(1)
