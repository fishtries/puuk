#!/usr/bin/env python3
"""Closed, bounded warm-cache proof against the recorded generated fixture only.

Exposure must be registered first. No global delivery enablement, original-file
mutation, signed URLs, keys, account metadata or response bodies in output.
"""
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import sqlite3
import ssl
import stat
import subprocess
import time
import jwt

STAGE = Path('/home/fish/puuk-cdn-setup')
LOG = Path('/var/log/nginx/puuk-origin-media.access.log')


def main():
    if os.geteuid() != 0:
        raise ValueError('root_required')
    pid = subprocess.run(['systemctl', 'show', 'puuk-brain', '--property=MainPID', '--value'],
                         capture_output=True, text=True, check=True, timeout=5).stdout.strip()
    env = dict(os.fsdecode(s).split('=', 1) for s in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in s)
    if any(env.get(k) != v for k, v in {'CDN_DELIVERY_ENABLED': 'false', 'CDN_ORIGIN_ENABLED': 'true', 'CDN_PURGE_ENABLED': 'true'}.items()):
        raise ValueError('closed_probe_flags_required')
    fixture = json.loads((STAGE / 'acceptance-fixture.json').read_bytes())
    if fixture['phase'] != 'exposed':
        raise ValueError('fixture_exposure_required')
    tid = fixture['track_id']
    digest = fixture['sha256']
    if not re.fullmatch(r'[0-9a-f-]{36}', tid) or not re.fullmatch(r'[0-9a-f]{64}', digest):
        raise ValueError('invalid_fixture')
    path = '/cdn/audio/' + tid + '/' + digest
    root = Path(env.get('MUSIC_DIR', '/mnt/data/projects/puuk/music')).resolve()
    file = root / fixture['relative_path']
    if file.is_symlink() or file.parent.is_symlink() or file.resolve().parent != root / '.cdn-acceptance':
        raise ValueError('unsafe_fixture')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        st = os.fstat(source.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_size != 81127:
            raise ValueError('fixture_changed')
        data = source.read(81128)
    if len(data) != 81127 or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('fixture_changed')
    db = sqlite3.connect('file:' + env.get('PUUK_DB_PATH', '/home/fish/apps/puuk/puuk/brain/puuk.db') + '?mode=ro', uri=True, timeout=1)
    try:
        exposure = db.execute('SELECT max_expires_at FROM delivery_exposures WHERE track_id=? AND content_version=? AND ever_exposed=1', (tid, digest)).fetchone()
        users = [db.execute('SELECT id,username,role FROM users WHERE id=?', (uid,)).fetchone() for uid in [1, fixture['user_id']]]
    finally:
        db.close()
    if not exposure or exposure[0] < time.time() + 120 or any(user is None for user in users) or users[0][1] != 'admin' or users[1][1] != fixture['username']:
        raise ValueError('fixture_authorization_not_ready')
    key = env['CDN_SIGNING_SECRET']
    expires = min(int(time.time()) + 600, int(exposure[0]) - 1)

    def query(expiry, target=path):
        token = base64.urlsafe_b64encode(hashlib.md5((str(expiry) + target + ' ' + key).encode(), usedforsecurity=False).digest()).decode().rstrip('=')
        return '?md5=' + token + '&expires=' + str(expiry)

    q = query(expires)
    web = 'https://web.puuk.fun'
    # Verify both actual sessions can request this fixture; tickets stay direct.
    api = http.client.HTTPSConnection('web.puuk.fun', timeout=5, context=ssl.create_default_context())
    try:
        for user in users:
            now = int(time.time())
            session = jwt.encode({'sub': str(user[0]), 'username': user[1], 'role': user[2], 'iat': now, 'exp': now + 60}, env['JWT_SECRET'], algorithm='HS256')
            api.request('POST', '/api/media-ticket', body=json.dumps({'track_id': tid}), headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session})
            r = api.getresponse()
            raw = r.read(8193)
            if r.status != 200 or len(raw) > 8192 or json.loads(raw).get('delivery') != 'direct':
                raise ValueError('closed_session_not_authorized')
    finally:
        api.close()

    def count_origin():
        st = LOG.stat()
        if st.st_size > 8 * 1024 * 1024:
            raise ValueError('origin_log_interval_too_large')
        count = 0
        for line in LOG.read_text().splitlines():
            parts = line.split()
            if len(parts) == 5 and parts[1] in ('GET', 'HEAD') and parts[2] == path:
                count += 1
        after = LOG.stat()
        if (st.st_dev, st.st_ino) != (after.st_dev, after.st_ino):
            raise ValueError('origin_log_rotated')
        return st.st_dev, st.st_ino, count

    connection = None
    for _ in range(8):
        candidate = http.client.HTTPSConnection('media.puuk.fun', timeout=5, context=ssl.create_default_context())
        try:
            candidate.request('HEAD', path + q, headers={'Origin': web, 'Range': 'bytes=0-99'})
            r = candidate.getresponse()
            r.read()
            ready = r.status == 200 and r.getheader('Content-Length') == str(len(data))
            r.close()
            if ready:
                candidate.request('OPTIONS', path + q, headers={'Origin': web,
                    'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Range, If-Range, If-None-Match'})
                r = candidate.getresponse()
                r.read()
                ready = r.status == 204 and r.getheader('Access-Control-Max-Age') == '300'
                r.close()
            if ready:
                connection = candidate
                break
        except (OSError, http.client.HTTPException):
            pass
        candidate.close()
    if connection is None:
        raise ValueError('no_updated_node_observed')
    before = count_origin()
    hits = 0
    nodes = set()
    reported_headers = False

    def request(label, method, target, headers=None, expected=None, status=None, deny=False):
        nonlocal hits, reported_headers
        connection.request(method, target, headers={'Origin': web, **(headers or {})})
        r = connection.getresponse()
        body = r.read(1048577)
        if not reported_headers:
            names=sorted({name.lower() for name,value in r.getheaders() if re.fullmatch('[A-Za-z0-9-]{1,80}',name)})
            print('response_header_names: '+','.join(names),flush=True)
            reported_headers=True
        node = r.getheader('cache-host', 'unknown')
        if not re.fullmatch('[A-Za-z0-9_.-]{1,80}', node):
            node = 'unknown'
        policy = ('no-store' in r.getheader('Cache-Control', '') and
            r.getheader('Access-Control-Allow-Origin') == web and r.getheader('Set-Cookie') is None)
        if deny:
            ok = policy and 400 <= r.status < 500 and not r.getheader('Content-Type', '').startswith('audio/') and len(body) < 8192
        else:
            exposed = {v.strip().lower() for v in r.getheader('Access-Control-Expose-Headers', '').split(',')}
            ok = (policy and r.status == status and body == expected and
                r.getheader('ETag') == '"sha256-' + digest + '"' and
                r.getheader('Content-Length') == str(len(data) if method == 'HEAD' else len(expected)) and
                all(v.strip().lower() == 'bytes' for v in r.getheader('Accept-Ranges', '').split(',')) and
                {'accept-ranges', 'content-range', 'content-length', 'etag', 'last-modified', 'age', 'cache-host'} <= exposed and
                r.getheader('Content-Encoding', 'identity') == 'identity' and
                r.getheader('Access-Control-Allow-Credentials') is None)
            if status == 206:
                ok = ok and r.getheader('Content-Range') == 'bytes 0-99/' + str(len(data))
            nodes.add(node)
        cache_status = ' '.join(r.getheader(h, '') for h in ('X-Cache-Status', 'X-Cache', 'CDN-Cache-Status')).upper()
        age = r.getheader('Age', '')
        hit = bool(re.search(r'\bHIT\b', cache_status) or (age.isdigit() and int(age) > 0))
        if hit and not deny:
            hits += 1
        print(label + ': ' + ('PASS' if ok else 'FAIL') + ' status=' + str(r.status) + ' bytes=' + str(len(body)) + ' cache_evidence=' + str(hit).lower() + ' node=' + node, flush=True)
        r.close()
        if not ok:
            raise ValueError('closed_cache_case_failed_' + label)

    try:
        for i in range(4):
            # Independent expiries represent two authorized closed capabilities;
            # all public issuance remains off and exposure already covers both.
            request('warm_session_' + str(i % 2 + 1), 'GET', path + query(expires - i % 2), expected=data, status=200)
            time.sleep(1)
        after = count_origin()
        delta = after[2] - before[2]
        print('warm_interval: requests=4 origin_reads='+str(delta)+' cache_evidence='+str(hits)+' nodes='+str(len(nodes)),flush=True)
        if before[:2] != after[:2] or delta < 0 or delta >= 4 or hits == 0 or len(nodes) != 1:
            raise ValueError('warm_hit_or_origin_reduction_not_proven')
        print('WARM_CACHE: PASS; provider_evidence=' + str(hits) + ' four_full_requests_origin_reads=' + str(delta), flush=True)
        request('warm_range', 'GET', path + q, {'Range': 'bytes=0-99'}, data[:100], 206)
        request('warm_head', 'HEAD', path + q, expected=b'', status=200)
        token = q.split('md5=', 1)[1].split('&', 1)[0]
        wrong = ('A' if token[0] != 'A' else 'B') + token[1:]
        bad_path = path.replace(tid, ('0' if tid[0] != '0' else '1') + tid[1:])
        bad_version = path[:-1] + ('0' if path[-1] != '0' else '1')
        cases = [
            ('unsigned', path), ('missing_token', path + '?expires=' + str(expires)),
            ('missing_expiry', path + '?md5=' + token),
            ('wrong_signature', path + '?md5=' + wrong + '&expires=' + str(expires)),
            ('expired', path + query(int(time.time()) - 60)),
            ('path_substituted', bad_path + q), ('version_substituted', bad_version + q),
            ('extra_query', path + q + '&probe_extra=1'),
            ('duplicate_token', path + q + '&md5=' + token),
            ('duplicate_expiry', path + q + '&expires=' + str(expires)),
            ('encoded_key', path + q.replace('md5=', '%6Dd5=')),
            ('encoded_path', path.replace('/audio/', '/%61udio/') + q),
            ('trailing_slash', path + '/' + q),
        ]
        for label, target in cases:
            request(label, 'GET', target, deny=True)
        for label, headers in [('unsigned_range', {'Range': 'bytes=0-99'}), ('unsigned_conditional', {'If-None-Match': '"sha256-' + digest + '"'})]:
            request(label, 'GET', path, headers, deny=True)
        request('unsigned_head', 'HEAD', path, deny=True)
    finally:
        connection.close()
    print('CLOSED_WARM_CACHE_MATRIX: PASS; fixture only. Purge/retirement/rollback and device/geographic gates remain separate.')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('Cache probe stopped:', type(exc).__name__, str(exc) if isinstance(exc, ValueError) else '')
        raise SystemExit(1)
