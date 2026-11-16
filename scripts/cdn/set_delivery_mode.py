#!/usr/bin/env python3
"""Scoped operator modes: enable only purge, or stop new CDN permissions.

Neither mode enables delivery. Ordinary rollback retains origin, purge and durable
exposures; it never restores a database snapshot or touches the Telegram bot.
"""
import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

ENV = Path('/etc/puuk/cdn.env')
DB = Path('/home/fish/apps/puuk/puuk/brain/puuk.db')


def command(*args):
    result = subprocess.run(args, capture_output=True, timeout=45)
    if result.returncode:
        raise RuntimeError('service_command_failed')
    return result.stdout.decode().strip()


def publish(raw):
    tmp = ENV.with_suffix('.mode-pending')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, ENV)
    finally:
        tmp.unlink(missing_ok=True)


def check(purge, started):
    pid = command('systemctl', 'show', 'puuk-brain', '--property=MainPID', '--value')
    env = dict(os.fsdecode(s).split('=', 1) for s in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in s)
    if env.get('CDN_DELIVERY_ENABLED') != 'false' or env.get('CDN_PURGE_ENABLED') != purge or env.get('CDN_ORIGIN_ENABLED') != 'true':
        return False
    db = sqlite3.connect('file:' + str(DB) + '?mode=ro', uri=True, timeout=.1)
    try:
        row = db.execute("SELECT value FROM delivery_control WHERE key='purge_heartbeat'").fetchone()
        if purge == 'true' and (not row or not started <= float(row[0]) <= time.time()):
            return False
    finally:
        db.close()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        response = opener.open(urllib.request.Request('http://127.0.0.1:8000/cdn/audio/' +
            '11111111-1111-4111-8111-111111111111/' + 'a' * 64, method='HEAD'), timeout=1)
        response.close()
        return False
    except urllib.error.HTTPError as response:
        ok = response.code == 403 and 'no-store' in response.headers.get('Cache-Control', '')
        response.close()
        return ok


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['purge-on', 'direct'])
    mode = parser.parse_args().mode
    if os.geteuid() != 0:
        raise ValueError('root_required')
    st = ENV.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077:
        raise ValueError('unsafe_environment')
    old = ENV.read_bytes()
    values = dict(line.split('=', 1) for line in old.decode().splitlines() if '=' in line and not line.startswith('#'))
    if values.get('CDN_ORIGIN_ENABLED') != 'true':
        raise ValueError('protected_origin_required')
    changes = {'CDN_DELIVERY_ENABLED': 'false'}
    if mode == 'purge-on':
        if values.get('CDN_DELIVERY_ENABLED') != 'false':
            raise ValueError('stop_delivery_before_purge_configuration')
        if not values.get('CDN_RESOURCE_ID') or not (values.get('CDN_PURGE_TOKEN') or values.get('CDN_PURGE_SERVICE_ACCOUNT_KEY_PATH')):
            raise ValueError('missing_purge_auth')
        changes['CDN_PURGE_ENABLED'] = 'true'
    else:
        changes.update(CDN_PILOT_USER_IDS='', CDN_DELIVERY_EPOCH='direct-' + str(int(time.time())))
    new = old.decode()
    for name, value in changes.items():
        pattern = r'(?m)^' + re.escape(name) + r'=.*$'
        if len(re.findall(pattern, new)) != 1:
            raise ValueError('ambiguous_or_absent_flag')
        new = re.sub(pattern, lambda _: name + '=' + value, new)
    backup = Path('/var/backups/puuk-cdn') / ('mode-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    backup.mkdir(mode=0o700)
    shutil.copy2(ENV, backup / 'cdn.env')
    print('Protected rollback backup:', backup, flush=True)
    started = time.time()
    try:
        publish(new.encode())
        command('systemctl', 'restart', 'puuk-brain')
        end = time.monotonic() + 30
        while time.monotonic() < end:
            try:
                if check(changes.get('CDN_PURGE_ENABLED', values.get('CDN_PURGE_ENABLED')), started):
                    print('MODE_CHECK: PASS; delivery OFF, protected origin ON, purge=' + changes.get('CDN_PURGE_ENABLED', values.get('CDN_PURGE_ENABLED')))
                    print('No database restore or bot restart.')
                    return
            except (OSError, sqlite3.Error, urllib.error.URLError):
                pass
            time.sleep(.5)
        raise RuntimeError('readiness_failed')
    except BaseException:
        publish(old)
        command('systemctl', 'restart', 'puuk-brain')
        print('Previous environment restored.')
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('Mode change stopped:', type(exc).__name__)
        sys.exit(1)
