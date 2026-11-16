#!/usr/bin/env python3
"""Enable the explicitly selected admin/ID1 pilot, with verified rollback.

Root operator tool. Existing media is read only; no library warm-up, credentials
or signed URLs in output. Leaves delivery enabled only after readiness and a real
admin CDN ticket/range check pass. Physical client acceptance remains separate.
"""
from datetime import datetime, timezone
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import time
from urllib.parse import urlsplit
import jwt

STAGE = Path('/home/fish/puuk-cdn-setup')


def main():
    if os.geteuid() != 0:
        raise ValueError('root_required')
    spec = importlib.util.spec_from_file_location('mode', STAGE / 'set-delivery-mode.py')
    mode = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mode)
    st = mode.ENV.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077:
        raise ValueError('unsafe_environment')
    old = mode.ENV.read_bytes()
    values = dict(s.split('=', 1) for s in old.decode().splitlines() if '=' in s and not s.startswith('#'))
    if any(values.get(k) != v for k, v in {'CDN_DELIVERY_ENABLED': 'false', 'CDN_ORIGIN_ENABLED': 'true', 'CDN_PURGE_ENABLED': 'true'}.items()):
        raise ValueError('direct_protected_origin_purge_required')
    with sqlite3.connect('file:' + str(mode.DB) + '?mode=ro', uri=True, timeout=1) as db:
        if db.execute('SELECT username,role FROM users WHERE id=1').fetchone() != ('admin', 'admin'):
            raise ValueError('admin_identity_changed')
        track = db.execute("SELECT t.id,t.file_path,v.content_version,v.content_length FROM tracks t JOIN delivery_versions v ON t.id=v.track_id WHERE v.state='ready' AND v.content_length>100 AND t.file_path NOT LIKE '.cdn-acceptance/%' ORDER BY v.content_length LIMIT 1").fetchone()
        if not track:
            raise ValueError('no_ready_media_for_probe')
    changed = old.decode()
    epoch = 'admin-pilot-' + str(int(time.time()))
    for name, value in {'CDN_DELIVERY_ENABLED': 'true', 'CDN_PILOT_USER_IDS': '1', 'CDN_DELIVERY_EPOCH': epoch}.items():
        changed, count = re.subn(r'(?m)^' + name + '=.*$', name + '=' + value, changed)
        if count != 1:
            raise ValueError('ambiguous_flag')
    backup = Path('/var/backups/puuk-cdn') / ('admin-pilot-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    backup.mkdir(mode=0o700)
    shutil.copy2(mode.ENV, backup / 'cdn.env')
    print('Protected rollback backup:', backup, flush=True)
    started = time.time()
    try:
        mode.publish(changed.encode())
        mode.command('systemctl', 'restart', 'puuk-brain')
        deadline = time.monotonic() + 35
        while True:
            try:
                pid = mode.command('systemctl', 'show', 'puuk-brain', '--property=MainPID', '--value')
                env = dict(os.fsdecode(s).split('=', 1) for s in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in s)
                flags = all(env.get(k) == v for k, v in {'CDN_DELIVERY_ENABLED': 'true', 'CDN_PILOT_USER_IDS': '1', 'CDN_DELIVERY_EPOCH': epoch, 'CDN_ORIGIN_ENABLED': 'true', 'CDN_PURGE_ENABLED': 'true'}.items())
                with sqlite3.connect('file:' + str(mode.DB) + '?mode=ro', uri=True, timeout=1) as db:
                    row = db.execute("SELECT value FROM delivery_control WHERE key='purge_heartbeat'").fetchone()
                if flags and row and started <= float(row[0]) <= time.time():
                    break
            except (OSError, sqlite3.Error):
                pass
            if time.monotonic() >= deadline:
                raise ValueError('readiness_timeout')
            time.sleep(.5)
        tid, relative, digest, total = track
        root = Path(env.get('MUSIC_DIR', '/mnt/data/projects/puuk/music')).resolve()
        file = (root / relative).resolve()
        if not file.is_relative_to(root):
            raise ValueError('unsafe_media_path')
        with file.open('rb') as f:
            expected = f.read(100)
        token = jwt.encode({'sub': '1', 'iat': int(time.time()), 'exp': int(time.time()) + 60}, env['JWT_SECRET'], algorithm='HS256')
        c = http.client.HTTPSConnection('web.puuk.fun', timeout=5)
        try:
            for delivery in (None, 'cdn'):
                payload = {'track_id': tid}
                if delivery:
                    payload['delivery'] = delivery
                c.request('POST', '/api/media-ticket', json.dumps(payload), {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
                r = c.getresponse()
                raw = r.read(8193)
                if r.status != 200 or len(raw) > 8192:
                    raise ValueError('ticket_failed')
                ticket = json.loads(raw)
                if ticket.get('delivery') != ('cdn' if delivery else 'direct'):
                    raise ValueError('unexpected_delivery')
        finally:
            c.close()
        url = urlsplit(ticket['url'])
        if url.scheme != 'https' or url.netloc != 'media.puuk.fun' or url.path != '/cdn/audio/' + tid + '/' + digest:
            raise ValueError('unexpected_cdn_target')
        c = http.client.HTTPSConnection(url.netloc, timeout=5)
        try:
            c.request('GET', url.path + '?' + url.query, headers={'Range': 'bytes=0-99'})
            r = c.getresponse()
            data = r.read(101)
            if r.status != 206 or data != expected or r.getheader('Content-Range') != f'bytes 0-99/{total}' or 'no-store' not in r.getheader('Cache-Control', ''):
                raise ValueError('cdn_range_failed')
        finally:
            c.close()
        print('ADMIN_PILOT: PASS; delivery ON only for ID1; actual API CDN ticket and exact Range bytes; legacy direct; fresh purge heartbeat.')
        print('Pilot started UTC:', datetime.now(timezone.utc).isoformat())
        print('No bot restart or database restore. Physical playback/seek and 24-hour observation pending.')
    except BaseException:
        mode.publish(old)
        mode.command('systemctl', 'restart', 'puuk-brain')
        print('Pilot check failed; previous direct environment restored.', flush=True)
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('Admin pilot stopped:', type(exc).__name__, str(exc) if isinstance(exc, ValueError) else '')
        raise SystemExit(1)
