"""Durable imports with one OS-locked worker; SQLite transactions never span I/O."""
from contextlib import contextmanager
import fcntl
import json
from pathlib import Path
import sqlite3
import shutil
import time


class DownloadQueue:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as c:
            c.execute('''CREATE TABLE IF NOT EXISTS downloads (
                id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
                message_id INTEGER NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
                attempts INTEGER NOT NULL DEFAULT 0, run_after REAL NOT NULL DEFAULT 0,
                result TEXT, error TEXT, updated REAL NOT NULL)''')
        self.lock = None

    @contextmanager
    def connect(self):
        c = sqlite3.connect(self.path, timeout=5)
        c.row_factory = sqlite3.Row
        try:
            with c:
                yield c
        finally:
            c.close()

    def start_worker(self):
        lock = open(str(self.path) + '.lock', 'a')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock.close()
            raise RuntimeError('Очередь уже обрабатывается другим процессом')
        self.lock = lock
        # Keep recent history and incomplete imports; completed snapshots need
        # not occupy disk indefinitely. The worker lock excludes other cleanup.
        with self.connect() as c:
            expired = c.execute("SELECT id FROM downloads WHERE status='done' AND updated<?", (time.time() - 30 * 86400,)).fetchall()
            for row in expired:
                shutil.rmtree(self.path.parent / 'imports' / str(row['id']), ignore_errors=True)
                c.execute('DELETE FROM downloads WHERE id=?', (row['id'],))
        # Only the exclusive worker may recover abandoned jobs.
        with self.connect() as c:
            c.execute("UPDATE downloads SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END WHERE status='running'")

    def close(self):
        if self.lock:
            self.lock.close()
            self.lock = None

    def enqueue(self, user_id, chat_id, message_id, url):
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            found = c.execute("SELECT id FROM downloads WHERE user_id=? AND url=? AND status IN ('queued','running')", (user_id, url)).fetchone()
            if found:
                return found['id']
            if c.execute("SELECT COUNT(*) FROM downloads WHERE status IN ('queued','running')").fetchone()[0] >= 100:
                raise ValueError('Очередь заполнена. Повтори позже.')
            return c.execute('INSERT INTO downloads(user_id,chat_id,message_id,url,updated) VALUES(?,?,?,?,?)',
                             (user_id, chat_id, message_id, url, time.time())).lastrowid

    def claim(self):
        if self.lock is None:
            raise RuntimeError('Worker lock required')
        with self.connect() as c:
            return c.execute("""UPDATE downloads SET status='running',attempts=attempts+1,updated=?
                WHERE id=(SELECT id FROM downloads WHERE status='queued' AND run_after<=? AND attempts<3
                ORDER BY id LIMIT 1) RETURNING *""", (time.time(), time.time())).fetchone()

    def finish(self, job, result=None, error=None, transient=False):
        if result is not None:
            result = {k: result[k] for k in ('total_tracks', 'failed_tracks', 'failures') if k in result}
        retry = error is not None and transient and job['attempts'] < 3
        status = 'queued' if retry else 'failed' if error else 'partial' if result.get('failed_tracks') else 'done'
        with self.connect() as c:
            c.execute('UPDATE downloads SET status=?,result=?,error=?,run_after=?,updated=? WHERE id=?',
                      (status, json.dumps(result, ensure_ascii=False), str(error)[:1000] if error else None,
                       time.time() + 15 * 2 ** job['attempts'] if retry else 0, time.time(), job['id']))

    def list_user(self, user_id):
        with self.connect() as c:
            return [dict(row) for row in c.execute('SELECT id,status,attempts,error FROM downloads WHERE user_id=? ORDER BY id DESC LIMIT 10', (user_id,))]

    def retry(self, job_id, user_id):
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            if c.execute("SELECT COUNT(*) FROM downloads WHERE status IN ('queued','running')").fetchone()[0] >= 100:
                return False
            return bool(c.execute("UPDATE downloads SET status='queued',attempts=0,error=NULL,run_after=0 WHERE id=? AND user_id=? AND status IN ('partial','failed') AND NOT EXISTS (SELECT 1 FROM downloads active WHERE active.user_id=downloads.user_id AND active.url=downloads.url AND active.status IN ('queued','running'))", (job_id, user_id)).rowcount)
