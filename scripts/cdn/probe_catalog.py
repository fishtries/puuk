#!/usr/bin/env python3
"""Bounded production JSON/preview verification; credentials stay in memory."""
import gzip
import http.client
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time
import jwt
from PIL import Image


def main():
    pid = subprocess.check_output(['systemctl', 'show', 'puuk-brain', '--property=MainPID', '--value'], text=True, timeout=5).strip()
    env = dict(os.fsdecode(s).split('=', 1) for s in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in s)
    token = jwt.encode({'sub': '1', 'iat': int(time.time()), 'exp': int(time.time()) + 60}, env['JWT_SECRET'], algorithm='HS256')
    with sqlite3.connect('file:/home/fish/apps/puuk/puuk/brain/puuk.db?mode=ro', uri=True, timeout=1) as db:
        tid = db.execute("SELECT t.id FROM tracks t JOIN delivery_versions v ON t.id=v.track_id WHERE v.state='ready' ORDER BY v.content_length LIMIT 1").fetchone()[0]
    c = http.client.HTTPSConnection('web.puuk.fun', timeout=8)
    def request(path, extra=None, authenticated=True):
        headers = {'Authorization': 'Bearer ' + token} if authenticated else {}
        c.request('GET', path, headers={**headers, **(extra or {})})
        r = c.getresponse()
        body = r.read(4 * 1024 * 1024 + 1)
        if len(body) > 4 * 1024 * 1024:
            raise ValueError('response_budget_exceeded')
        return r, body
    try:
        for label, path in [('tracks', '/api/tracks'), ('history', '/api/history?limit=100')]:
            r, body = request(path, {'Accept-Encoding': 'gzip'})
            if r.status != 200 or r.getheader('Content-Encoding') != 'gzip' or not isinstance(json.loads(gzip.decompress(body)), (list, dict)):
                raise ValueError('compressed_catalog_failed')
            print(label, 'wire_bytes=' + str(len(body)), 'decoded_bytes=' + str(len(gzip.decompress(body))), flush=True)
        path = '/api/cover/' + tid + '?size=256'
        r, body = request(path)
        if r.status != 200 or 'private' not in r.getheader('Cache-Control', ''):
            raise ValueError('preview_failed')
        with Image.open(io.BytesIO(body)) as image:
            if max(image.size) > 256:
                raise ValueError('preview_dimensions_failed')
        etag = r.getheader('ETag')
        if 'preview-256' not in (etag or ''):
            raise ValueError('preview_version_failed')
        r, body = request(path, {'If-None-Match': etag})
        if r.status != 304 or body:
            raise ValueError('preview_conditional_failed')
        r, body = request(path, authenticated=False)
        if r.status != 401:
            raise ValueError('preview_auth_failed')
        print('CATALOG_TRANSFER: PASS; compressed JSON, bounded preview, private cache, ETag304 and unauthorized401. No CDN cover/API deployment or device speed claim.')
    finally:
        c.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('Catalog probe stopped:', type(exc).__name__, str(exc) if isinstance(exc, ValueError) else '')
        raise SystemExit(1)
