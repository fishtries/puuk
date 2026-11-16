#!/usr/bin/env python3
"""Root-only direct compatibility smoke for the user-selected admin pilot.

Uses a 60-second operator-issued session only in memory. No password change,
stored session, signed URL, track metadata or credential is printed.
"""
import hashlib
import http.client
import json
import os
from pathlib import Path
import sqlite3
import ssl
import stat
import subprocess
import time
import jwt


def main():
    if os.geteuid() != 0:
        raise ValueError('root_required')
    pid = subprocess.run(['systemctl', 'show', 'puuk-brain', '--property=MainPID', '--value'],
                         capture_output=True, text=True, check=True, timeout=5).stdout.strip()
    env = dict(os.fsdecode(s).split('=', 1) for s in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in s)
    if env.get('CDN_DELIVERY_ENABLED') != 'false' or env.get('CDN_PURGE_ENABLED') != 'true':
        raise ValueError('expected_direct_with_purge_on')
    db = sqlite3.connect('file:' + env.get('PUUK_DB_PATH', '/home/fish/apps/puuk/puuk/brain/puuk.db') + '?mode=ro', uri=True, timeout=1)
    try:
        user = db.execute("SELECT id,username,role FROM users WHERE username='admin'").fetchone()
        if not user or user != (1, 'admin', 'admin'):
            raise ValueError('pilot_identity_changed')
        row = db.execute("SELECT t.id,t.file_path,v.content_version,v.content_length FROM tracks t JOIN delivery_versions v ON v.track_id=t.id WHERE v.state='ready' AND v.content_length BETWEEN 1024 AND 1048576 ORDER BY v.content_length LIMIT 1").fetchone()
        heartbeat = db.execute("SELECT value FROM delivery_control WHERE key='purge_heartbeat'").fetchone()
        healthy = bool(heartbeat and 0 <= time.time() - float(heartbeat[0]) <= 120)
        counts = {name: db.execute('SELECT COUNT(*) FROM ' + name).fetchone()[0]
                  for name in ('delivery_exposures', 'cdn_purge_outbox')}
    finally:
        db.close()
    if not row or not healthy:
        raise ValueError('preconditions_not_ready')
    tid, relative, digest, total = row
    root = Path(env.get('MUSIC_DIR', '/mnt/data/projects/puuk/music')).resolve()
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise ValueError('unsafe_descriptor')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError('unsafe_descriptor')
        audio = source.read(1048577)
    if len(audio) != total or hashlib.sha256(audio).hexdigest() != digest:
        raise ValueError('descriptor_changed')
    now = int(time.time())
    token = jwt.encode({'sub': '1', 'username': 'admin', 'role': 'admin', 'iat': now, 'exp': now + 60}, env['JWT_SECRET'], algorithm='HS256')
    connection = http.client.HTTPSConnection('web.puuk.fun', timeout=5, context=ssl.create_default_context())
    try:
        headers = {'Content-Type': 'application/json', 'Origin': 'https://web.puuk.fun'}
        connection.request('POST', '/api/media-ticket', body=json.dumps({'track_id': tid}), headers=headers)
        response = connection.getresponse()
        denied = response.status == 401 and 'no-store' in response.getheader('Cache-Control', '')
        response.read(8193)
        if not denied:
            raise ValueError('unauthenticated_ticket_not_denied')
        headers['Authorization'] = 'Bearer ' + token
        ticket = None
        for mode in (None, 'direct', 'cdn'):
            body = {'track_id': tid}
            if mode:
                body['delivery'] = mode
            connection.request('POST', '/api/media-ticket', body=json.dumps(body), headers=headers)
            response = connection.getresponse()
            raw = response.read(8193)
            if response.status != 200 or len(raw) > 8192 or 'no-store' not in response.getheader('Cache-Control', ''):
                raise ValueError('ticket_not_ready')
            ticket = json.loads(raw)
            if ticket.get('delivery') != 'direct' or not ticket.get('url', '').startswith('/api/stream/' + tid + '?mt='):
                raise ValueError('unexpected_delivery')
        connection.request('GET', ticket['url'], headers={'Range': 'bytes=0-99', 'Origin': 'https://web.puuk.fun'})
        response = connection.getresponse()
        body = response.read(1048577)
        if response.status != 206 or body != audio[:100] or response.getheader('Content-Range') != f'bytes 0-99/{total}' or 'no-store' not in response.getheader('Cache-Control', ''):
            raise ValueError('direct_range_mismatch')
        connection.request('GET', ticket['url'], headers={'If-Match': '"sha256-' + digest + '"'})
        response = connection.getresponse()
        body = response.read(1048577)
        if response.status != 200 or body != audio or response.getheader('ETag') != '"sha256-' + digest + '"':
            raise ValueError('version_bound_transfer_mismatch')
    finally:
        connection.close()
    print('DIRECT_COMPATIBILITY: PASS; unauthorized=401, default/direct/cdn-request=direct, Range bytes and version-bound full bytes match.')
    print('HEALTH: purge heartbeat fresh; delivery OFF, origin/purge ON; counts=' + json.dumps(counts, sort_keys=True))
    print('Admin ID 1 verified. One 60-second in-memory session; no account/catalog/audio/configuration writes.')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('Direct probe stopped:', type(exc).__name__, str(exc) if isinstance(exc, ValueError) else '')
        raise SystemExit(1)
