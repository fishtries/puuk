"""Serialize manual credit writes with file-backed album mutations per SQLite DB.

The sidecar is stable and must not be unlinked: unlinking a locked inode would
let a new process acquire a different lock. Always acquire before SQLite write
transactions. Re-entry by the same thread is safe (legacy PATCH calls PUT).
"""
from contextlib import contextmanager
from functools import wraps
import errno
import hashlib
import fcntl
import os
import stat
import threading
import time

from fastapi import HTTPException
from config import DB_PATH, MUSIC_DIR

_LOCK_TIMEOUT = 5.0
_POLL_INTERVAL = 0.05
_guard = threading.Lock()
_locks = {}
_local = threading.local()


def _busy():
    return HTTPException(503, detail={'code': 'credits_busy', 'message': 'База занята'},
                         headers={'Retry-After': '1'})


def _lock_path(db_path):
    # Keep coordination artifacts out of the media tree, even when a test or
    # deployment stores its DB there. All writers must share this temp root.
    music_dir = os.path.realpath(os.environ.get('MUSIC_DIR') or MUSIC_DIR)
    root = '/var/tmp'
    if os.path.commonpath((root, music_dir)) == music_dir:
        raise RuntimeError('Coordination directory is inside the music directory')
    lock_dir = os.path.join(root, 'puuk-artist-credit-locks-v2')
    try:
        os.mkdir(lock_dir, mode=0o1777)
    except FileExistsError:
        pass
    else:
        # mkdir respects umask; sticky bit keeps one user from unlinking another's lock.
        os.chmod(lock_dir, 0o1777)
    if not stat.S_ISDIR(os.lstat(lock_dir).st_mode):
        raise OSError(errno.ENOTDIR, 'Invalid lock directory')
    return os.path.join(lock_dir, hashlib.sha256(os.fsencode(db_path)).hexdigest() + '.lock')


@contextmanager
def artist_credit_mutation_lock():
    # Resolve the exact same runtime DB selection used by repositories.base.
    path = os.path.realpath(os.environ.get('PUUK_DB_PATH') or DB_PATH)
    deadline = time.monotonic() + _LOCK_TIMEOUT
    if not _guard.acquire(timeout=max(0.0, deadline - time.monotonic())):
        raise _busy()
    try:
        local_lock = _locks.setdefault(path, threading.RLock())
    finally:
        _guard.release()
    if not local_lock.acquire(timeout=max(0.0, deadline - time.monotonic())):
        raise _busy()
    held = getattr(_local, 'held', None)
    if held is None:
        held = _local.held = {}
    try:
        if path in held:
            held[path][1] += 1
        else:
            try:
                lock_path = _lock_path(path)
                try:
                    fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
                except FileExistsError:
                    # On Linux flock on a read-only descriptor can acquire LOCK_EX.
                    fd = os.open(lock_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
                else:
                    try:
                        os.fchmod(fd, 0o644)
                    except BaseException:
                        os.close(fd)
                        raise
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    os.close(fd)
                    raise OSError(errno.EINVAL, 'Invalid lock file')
            except OSError:
                # A process unable to access the shared namespace must fail closed.
                raise _busy() from None
            try:
                while True:
                    try:
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except OSError as exc:
                        if exc.errno not in (errno.EACCES, errno.EAGAIN):
                            raise
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise _busy() from None
                        time.sleep(min(_POLL_INTERVAL, remaining))
            except BaseException:
                os.close(fd)
                raise
            held[path] = [fd, 1]
        try:
            yield
        finally:
            held[path][1] -= 1
            if held[path][1] == 0:
                fd = held.pop(path)[0]
                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                finally:
                    os.close(fd)
    finally:
        local_lock.release()


def serialize_artist_credit_mutation(function):
    """Hold the same bounded lock across the operation and its SQLite writes."""
    @wraps(function)
    def wrapped(*args, **kwargs):
        with artist_credit_mutation_lock():
            return function(*args, **kwargs)
    return wrapped
