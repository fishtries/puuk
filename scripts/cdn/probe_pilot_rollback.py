#!/usr/bin/env python3
"""Disposable-account issuance acceptance; always return to direct delivery.

Only the recorded silent fixture and disposable user are eligible during this
probe. Credentials and URLs remain in memory. Run with the backend venv as root.
"""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time
from datetime import datetime, timezone
import shutil
from urllib.parse import urlsplit
import http.client
import jwt

STAGE = Path('/home/fish/puuk-cdn-setup')


def main():
    if os.geteuid() != 0:
        raise ValueError('root_required')
    spec = importlib.util.spec_from_file_location('mode', STAGE / 'set-delivery-mode.py')
    mode = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mode)
    old = mode.ENV.read_bytes()
    values = dict(s.split('=', 1) for s in old.decode().splitlines() if '=' in s and not s.startswith('#'))
    if values.get('CDN_DELIVERY_ENABLED') != 'false':
        raise ValueError('delivery_must_start_off')
    state = json.loads((STAGE / 'acceptance-fixture.json').read_bytes())
    db = sqlite3.connect('file:' + str(mode.DB) + '?mode=ro', uri=True)
    try:
        identity = db.execute('SELECT username,role FROM users WHERE id=?', (state['user_id'],)).fetchone()
    finally:
        db.close()
    if identity != (state['username'], 'user') or not state['username'].startswith('cdn-probe-'):
        raise ValueError('disposable_identity_changed')
    pid = mode.command('systemctl', 'show', 'puuk-brain', '--property=MainPID', '--value')
    env = dict(os.fsdecode(s).split('=', 1) for s in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in s)
    def ticket(uid, delivery='cdn'):
        now = int(time.time())
        token = jwt.encode({'sub': str(uid), 'iat': now, 'exp': now + 60}, env['JWT_SECRET'], algorithm='HS256')
        c = http.client.HTTPSConnection('web.puuk.fun', timeout=5)
        try:
            payload = {'track_id': state['track_id']}
            if delivery:
                payload['delivery'] = delivery
            c.request('POST', '/api/media-ticket', json.dumps(payload), {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
            r = c.getresponse()
            data = r.read(8193)
            if r.status != 200 or len(data) > 8192:
                raise ValueError('ticket_failed')
            return json.loads(data)
        finally:
            c.close()
    def audio(url):
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or parsed.hostname != 'media.puuk.fun':
            raise ValueError('unexpected_cdn_host')
        c = http.client.HTTPSConnection(parsed.hostname, timeout=5)
        try:
            c.request('GET', parsed.path + '?' + parsed.query, headers={'Range': 'bytes=0-99'})
            r = c.getresponse()
            data = r.read(1024)
            expected = (STAGE / 'acceptance-silence.mp3').read_bytes()[:100]
            if r.status != 206 or data != expected or 'no-store' not in r.getheader('Cache-Control', ''):
                raise ValueError('cdn_range_failed')
        finally:
            c.close()
    import re
    changed = old.decode()
    for name, value in {'CDN_DELIVERY_ENABLED': 'true', 'CDN_PILOT_USER_IDS': str(state['user_id'])}.items():
        changed, count = re.subn(r'(?m)^' + name + '=.*$', name + '=' + value, changed)
        if count != 1:
            raise ValueError('ambiguous_flag')
    backup = Path('/var/backups/puuk-cdn') / ('closed-pilot-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    backup.mkdir(mode=0o700)
    shutil.copy2(mode.ENV, backup / 'cdn.env')
    try:
        mode.publish(changed.encode())
        mode.command('systemctl', 'restart', 'puuk-brain')
        end = time.monotonic() + 30
        while True:
            try:
                issued = ticket(state['user_id'])
                if issued.get('delivery') == 'cdn':
                    break
            except (OSError, ValueError):
                pass
            if time.monotonic() >= end:
                raise ValueError('pilot_readiness_failed')
            time.sleep(.5)
        if not 1501 <= issued['expires_in'] <= 1800:
            raise ValueError('expiry_outside_bounds')
        second = ticket(state['user_id'])
        if issued['server_time'] // 300 == second['server_time'] // 300 and second['url'] != issued['url']:
            raise ValueError('cohort_url_changed')
        if ticket(1)['delivery'] != 'direct' or ticket(state['user_id'], None)['delivery'] != 'direct':
            raise ValueError('pilot_isolation_failed')
        audio(issued['url'])
        print('CLOSED_PILOT: PASS; disposable user CDN, admin non-pilot direct, legacy direct, bounded expiry and exact Range bytes.', flush=True)
    finally:
        result = subprocess.run(['/usr/bin/python3', str(STAGE / 'set-delivery-mode.py'), 'direct'], timeout=90)
        if result.returncode:
            raise RuntimeError('direct_rollback_failed')
    if ticket(state['user_id'])['delivery'] != 'direct':
        raise ValueError('rollback_ticket_failed')
    audio(issued['url'])
    print('ROLLBACK: PASS; new tickets direct; prior unexpired capability drains with exact bytes; no database restore.')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('Pilot probe stopped:', type(exc).__name__, str(exc) if isinstance(exc, ValueError) else '')
        raise SystemExit(1)
