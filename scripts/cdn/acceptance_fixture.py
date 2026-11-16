#!/usr/bin/env python3
"""Manage one generated silent fixture for closed CDN cache/purge acceptance.

Requires delivery OFF and protected origin/purge ON. Only the recorded generated
file, test account and track are created/retired; original music is untouched.
Permanent tombstones, exposures and purge audit survive cleanup.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import secrets
import subprocess
import sys
import time
import uuid

ROOT = Path('/home/fish/apps/puuk/puuk/brain')
STAGE = Path('/home/fish/puuk-cdn-setup')
STATE = STAGE / 'acceptance-fixture.json'
SOURCE = STAGE / 'acceptance-silence.mp3'
SOURCE_HASH = 'c7ae4cf635c5742e03e2647322cc268432198c011cfd8ab8ffccfc57bacddb86'


def save(obj):
    pending = STATE.with_suffix('.pending')
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(obj, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(pending, STATE)
    finally:
        pending.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['create', 'expose', 'retire', 'status', 'cleanup'])
    mode = parser.parse_args().mode
    if os.geteuid() != 0:
        raise ValueError('root_required')
    pid = subprocess.run(['systemctl', 'show', 'puuk-brain', '--property=MainPID', '--value'],
                         capture_output=True, text=True, check=True, timeout=5).stdout.strip()
    env = dict(os.fsdecode(s).split('=', 1) for s in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in s)
    if any(env.get(k) != v for k, v in {'CDN_DELIVERY_ENABLED': 'false', 'CDN_ORIGIN_ENABLED': 'true', 'CDN_PURGE_ENABLED': 'true'}.items()):
        raise ValueError('closed_probe_flags_required')
    account = pwd.getpwnam('fish')
    os.environ.clear()
    os.environ.update(env)
    os.setgroups([])
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
    os.chdir(ROOT)
    sys.path.insert(0, str(ROOT))
    import config
    import db
    import metadata
    from repositories import delivery
    music = Path(config.get_effective_music_dir()).resolve()
    if mode == 'create':
        existing = json.loads(STATE.read_bytes()) if STATE.exists() else None
        if existing and (existing.get('phase') != 'creating' or 'user_id' not in existing):
            raise ValueError('fixture_already_recorded_do_not_duplicate')
        data = SOURCE.read_bytes()
        if len(data) != 81127 or hashlib.sha256(data).hexdigest() != SOURCE_HASH:
            raise ValueError('unexpected_synthetic_source')
        tid = existing['track_id'] if existing else str(uuid.uuid4())
        if str(uuid.UUID(tid)) != tid:
            raise ValueError('invalid_fixture_identity')
        relative = Path('.cdn-acceptance') / (tid + '.mp3')
        directory = music / relative.parent
        directory.mkdir(mode=0o700, exist_ok=True)
        if directory.is_symlink() or directory.resolve().parent != music:
            raise ValueError('unsafe_fixture_directory')
        path = music / relative
        username = existing['username'] if existing else 'cdn-probe-' + uuid.uuid4().hex
        state = {'track_id': tid, 'relative_path': str(relative), 'sha256': SOURCE_HASH,
                 'length': len(data), 'username': username, 'created_at': time.time(), 'phase': 'creating'}
        if existing:
            state = existing
            user = db.get_user_by_id(state['user_id'])
            if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != SOURCE_HASH or not user or user['username'] != username:
                raise ValueError('partial_fixture_changed_refuse_resume')
        else:
            save(state)  # interruption remains discoverable; never silently duplicate
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            from security import hash_password
            state['user_id'] = db.create_user(username, hash_password(secrets.token_urlsafe(32)), role='user')
        save(state)
        with metadata.track_mutation_lock(tid, str(music)):
            st = path.stat()
            with delivery.transaction() as conn:
                db.add_or_update_track(tid, str(relative), 'CDN acceptance — generated silence', None,
                    '', added_by_user_id=1, duration=5, file_size=st.st_size, file_mtime_ns=st.st_mtime_ns, conn=conn)
                conn.execute("UPDATE delivery_versions SET state='ready',content_version=?,fingerprint=?,content_length=?,fence=NULL,lease_until=NULL WHERE track_id=?",
                    (SOURCE_HASH, json.dumps(delivery.fingerprint(st), separators=(',', ':')), len(data), tid))
        state['phase'] = 'ready'
        save(state)
        print('FIXTURE_CREATE: PASS; one generated silent five-second MP3 and one disposable non-pilot account.')
        return
    state = json.loads(STATE.read_bytes())
    tid = state['track_id']
    if str(uuid.UUID(tid)) != tid or state['relative_path'] != '.cdn-acceptance/' + tid + '.mp3' or state['sha256'] != SOURCE_HASH:
        raise ValueError('invalid_fixture_manifest')
    path = music / state['relative_path']
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError('unsafe_fixture_path')
    if mode == 'expose':
        if state['phase'] not in ('ready', 'exposed') or hashlib.sha256(path.read_bytes()).hexdigest() != SOURCE_HASH:
            raise ValueError('fixture_not_ready')
        expiry = int(time.time()) + 1800
        with metadata.track_mutation_lock(tid, str(music)):
            with delivery.transaction() as conn:
                version = delivery.ready_version(tid, path.stat(), conn=conn)
                if not version or version['content_version'] != SOURCE_HASH:
                    raise ValueError('fixture_version_changed')
                delivery.expose(conn, tid, SOURCE_HASH, expiry)
        state.update(phase='exposed', expires_at=expiry)
        save(state)
        print('FIXTURE_EXPOSURE: PASS; durable ledger precedes every closed signed URL; global issuance remains OFF.')
        return
    if mode == 'retire':
        if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() != SOURCE_HASH:
            raise ValueError('fixture_changed_refuse_delete')
        if db.get_track(tid):
            # Exercise the real authenticated deletion path, including its
            # shared path lock, tombstone, generated-file removal and outbox.
            from datetime import timedelta
            import http.client
            import ssl
            from auth import create_access_token
            user = db.get_user_by_id(1)
            if not user or user['username'] != 'admin' or user['role'] != 'admin':
                raise ValueError('pilot_identity_changed')
            token = create_access_token(user, timedelta(seconds=60))
            connection = http.client.HTTPSConnection('web.puuk.fun', timeout=20, context=ssl.create_default_context())
            try:
                connection.request('DELETE', '/api/tracks/' + tid, headers={'Authorization': 'Bearer ' + token})
                response = connection.getresponse()
                raw = response.read(8193)
                if response.status != 200 or len(raw) > 8192 or json.loads(raw).get('status') != 'success':
                    raise ValueError('fixture_deletion_not_confirmed')
            finally:
                connection.close()
        if db.get_track(tid) or path.exists():
            raise ValueError('fixture_retirement_incomplete')
        state['phase'] = 'retired'
        save(state)
        print('FIXTURE_RETIRE: PASS; only generated track tombstoned; exposed purge intent retained.')
        return
    conn = db.get_connection()
    try:
        track = conn.execute('SELECT 1 FROM tracks WHERE id=?', (tid,)).fetchone()
        jobs = [dict(row) for row in conn.execute('SELECT state,attempts,reason FROM cdn_purge_outbox WHERE track_id=?', (tid,))]
    finally:
        conn.close()
    if mode == 'status':
        print(json.dumps({'phase': state['phase'], 'track_present': bool(track), 'purge_jobs': jobs}))
        return
    if track or state['phase'] not in ('retired', 'cleaned') or any(j['state'] not in ('succeeded', 'drained') for j in jobs):
        raise ValueError('retirement_still_pending')
    if path.exists():
        if hashlib.sha256(path.read_bytes()).hexdigest() != SOURCE_HASH:
            raise ValueError('fixture_file_changed_refuse_cleanup')
        path.unlink()
    user = db.get_user_by_id(state.get('user_id', -1))
    if user:
        if user['username'] != state['username'] or not user['username'].startswith('cdn-probe-') or user['role'] != 'user':
            raise ValueError('test_account_identity_changed')
        db.delete_user(user['id'])
    state['phase'] = 'cleaned'
    save(state)
    print('FIXTURE_CLEANUP: PASS; only generated file/test account removed; tombstones and purge audit retained.')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('Fixture action stopped:', type(exc).__name__, str(exc) if isinstance(exc, ValueError) else '')
        raise SystemExit(1)
