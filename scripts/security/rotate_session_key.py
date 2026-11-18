"""One-time migration of the Puuk systemd signing key after journal exposure."""
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import tempfile


UNIT = Path('/etc/systemd/system/puuk-brain.service')
SECRET = Path('/etc/puuk/session-signing.env')
DROPIN = UNIT.with_name(UNIT.name + '.d') / '90-session-signing.conf'
DROPIN_TEXT = f'[Service]\nEnvironmentFile={SECRET}\n'
INLINE_KEY = re.compile(r"""^[ \t]*Environment=["']?JWT_SECRET=[^\s]+[ \t]*$""", re.MULTILINE)


def replace(path, text, mode):
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run as root on the Puuk service host.')
    for path in (UNIT, SECRET.parent, DROPIN.parent):
        st = path.lstat()
        if path.is_symlink() or st.st_uid != 0 or st.st_mode & 0o022:
            raise SystemExit(f'Unexpected owner or permissions on {path}')
    unit = UNIT.read_text()
    safe_unit, count = INLINE_KEY.subn('', unit)
    if count > 1 or 'JWT_SECRET' in safe_unit or (not count and not DROPIN.exists()):
        raise SystemExit('Unexpected service configuration. Inspect the unit locally.')
    if DROPIN.exists() and DROPIN.read_text() != DROPIN_TEXT:
        raise SystemExit('Existing signing-key override differs.')
    if not SECRET.exists():
        replace(SECRET, 'JWT_SECRET=' + secrets.token_hex(48) + '\n', 0o600)
    st = SECRET.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or stat.S_IMODE(st.st_mode) != 0o600:
        raise SystemExit('Unexpected signing-key file permissions.')
    value = SECRET.read_text()
    if not re.fullmatch(r'JWT_SECRET=[a-f0-9]{96}\n', value):
        raise SystemExit('Unexpected signing-key file format.')
    replace(DROPIN, DROPIN_TEXT, 0o644)
    if count:
        replace(UNIT, safe_unit, stat.S_IMODE(UNIT.stat().st_mode))
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'restart', 'puuk-brain', 'puuk-telegram-bot'], check=True)
    pid = subprocess.check_output(['systemctl', 'show', 'puuk-brain', '-p', 'MainPID', '--value'], text=True).strip()
    if value.strip().encode() not in Path('/proc', pid, 'environ').read_bytes().split(b'\0'):
        raise SystemExit('Backend did not receive the new session key.')
    print('Session signing key migrated. Backend and bot restarted.')


if __name__ == '__main__':
    main()
