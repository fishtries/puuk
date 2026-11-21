"""Persistent import snapshots and per-position state transitions."""
import json
import time

from download_queue import DownloadQueue


class ImportJobs(DownloadQueue):
    def __init__(self, path):
        super().__init__(path)
        with self.connect() as conn:
            conn.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS import_preferences (
                    user_id INTEGER PRIMARY KEY, mode TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS import_jobs (
                    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, owner_id INTEGER NOT NULL,
                    chat_id INTEGER NOT NULL, status_message INTEGER, request TEXT NOT NULL,
                    mode TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'new', kind TEXT,
                    title TEXT, error TEXT, result_id TEXT, playlist_id INTEGER
                );
                CREATE TABLE IF NOT EXISTS import_messages (
                    chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, job_id INTEGER NOT NULL,
                    PRIMARY KEY (chat_id, message_id)
                );
                CREATE TABLE IF NOT EXISTS import_positions (
                    job_id INTEGER NOT NULL, position INTEGER NOT NULL, source TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT 'pending', artifact TEXT, track_id TEXT,
                    error TEXT, retry_until REAL, run_after REAL NOT NULL DEFAULT 0,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (job_id, position)
                );
                CREATE TABLE IF NOT EXISTS import_repair_prompts (
                    chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, job_id INTEGER NOT NULL,
                    position INTEGER NOT NULL, PRIMARY KEY(chat_id,message_id)
                );
                CREATE TABLE IF NOT EXISTS import_album_batches (
                    chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, owner_id INTEGER NOT NULL,
                    files TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(chat_id,user_id,owner_id)
                );
                CREATE INDEX IF NOT EXISTS import_jobs_owner ON import_jobs(user_id, owner_id, state);
                CREATE INDEX IF NOT EXISTS import_positions_work ON import_positions(state, run_after);
            """)
            columns = {column[1] for column in conn.execute('PRAGMA table_info(import_jobs)')}
            if 'review' not in columns:
                conn.execute('ALTER TABLE import_jobs ADD COLUMN review TEXT')
            if 'initial_playlist' not in columns:
                conn.execute('ALTER TABLE import_jobs ADD COLUMN initial_playlist INTEGER NOT NULL DEFAULT 0')
            position_columns = {column[1] for column in conn.execute('PRAGMA table_info(import_positions)')}
            if 'sha256' not in position_columns:
                conn.execute('ALTER TABLE import_positions ADD COLUMN sha256 TEXT')
            if 'evidence' not in position_columns:
                conn.execute('ALTER TABLE import_positions ADD COLUMN evidence TEXT')
            if 'alternative' not in position_columns:
                conn.execute('ALTER TABLE import_positions ADD COLUMN alternative TEXT')

    def start_worker(self):
        super().start_worker()
        with self.connect() as conn:
            conn.execute("UPDATE import_jobs SET state='new' WHERE state='resolving'")
            conn.execute("UPDATE import_positions SET state='pending' WHERE state='downloading'")
            conn.execute("""UPDATE import_positions SET state='skipped',run_after=0,
                error='Доставка не подтверждена. Проверьте чат перед повтором.'
                WHERE state='sending'""")

    def mode(self, owner_id, value=None):
        with self.connect() as conn:
            if value is not None:
                if value not in {'server', 'chat'}:
                    raise ValueError('Неизвестный режим')
                conn.execute("""INSERT INTO import_preferences VALUES (?,?)
                    ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode""", (owner_id, value))
            row = conn.execute('SELECT mode FROM import_preferences WHERE user_id=?', (owner_id,)).fetchone()
            return row[0] if row else 'server'

    def submit(self, telegram_id, owner_id, chat_id, message_id, request, mode):
        payload = json.dumps(request, sort_keys=True)
        with self.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            duplicate = conn.execute('SELECT job_id FROM import_messages WHERE chat_id=? AND message_id=?',
                                     (chat_id, message_id)).fetchone()
            if duplicate:
                return duplicate[0], 'duplicate'
            active = conn.execute("""SELECT id, state FROM import_jobs
                WHERE user_id=? AND owner_id=? AND chat_id=? AND request=? AND mode=?
                AND state IN ('new','resolving','active','paused','review') ORDER BY id DESC LIMIT 1""",
                                  (telegram_id, owner_id, chat_id, payload, mode)).fetchone()
            if active:
                job_id = active['id']
                outcome = 'resumed' if active['state'] == 'paused' else 'duplicate'
                if outcome == 'resumed':
                    conn.execute("UPDATE import_jobs SET state='active' WHERE id=?", (job_id,))
            else:
                count = conn.execute("""SELECT COUNT(*) FROM import_jobs
                    WHERE state IN ('new','resolving','active','paused','review')""").fetchone()[0]
                if count >= 100:
                    raise ValueError('Очередь заполнена. Повторите позже.')
                job_id = conn.execute("""INSERT INTO import_jobs
                    (user_id,owner_id,chat_id,request,mode) VALUES (?,?,?,?,?)""",
                                      (telegram_id, owner_id, chat_id, payload, mode)).lastrowid
                outcome = 'created'
            conn.execute('INSERT INTO import_messages VALUES (?,?,?)', (chat_id, message_id, job_id))
            return job_id, outcome

    def job(self, job_id):
        with self.connect() as conn:
            return conn.execute('SELECT * FROM import_jobs WHERE id=?', (job_id,)).fetchone()

    def positions(self, job_id):
        with self.connect() as conn:
            return conn.execute('SELECT * FROM import_positions WHERE job_id=? ORDER BY position', (job_id,)).fetchall()

    def outstanding(self, telegram_id, owner_id):
        with self.connect() as conn:
            return conn.execute("""SELECT * FROM import_jobs j WHERE user_id=? AND owner_id=?
                AND (state IN ('new','resolving','active','paused','review') OR
                    (state='finished' AND EXISTS (SELECT 1 FROM import_positions p
                        WHERE p.job_id=j.id AND p.state!='done')))
                ORDER BY id DESC""", (telegram_id, owner_id)).fetchall()

    def set_message(self, job_id, message_id):
        with self.connect() as conn:
            conn.execute('UPDATE import_jobs SET status_message=? WHERE id=?', (message_id, job_id))

    def start_batch(self, chat_id, telegram_id, owner_id):
        with self.connect() as conn:
            conn.execute('INSERT OR IGNORE INTO import_album_batches(chat_id,user_id,owner_id) VALUES (?,?,?)',
                         (chat_id, telegram_id, owner_id))

    def batch_files(self, chat_id, telegram_id, owner_id):
        with self.connect() as conn:
            row = conn.execute('SELECT files FROM import_album_batches WHERE chat_id=? AND user_id=? AND owner_id=?',
                               (chat_id, telegram_id, owner_id)).fetchone()
            return json.loads(row['files']) if row else None

    def add_batch_file(self, chat_id, telegram_id, owner_id, message_id, file):
        with self.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute('SELECT files FROM import_album_batches WHERE chat_id=? AND user_id=? AND owner_id=?',
                               (chat_id, telegram_id, owner_id)).fetchone()
            if not row:
                return None
            files = json.loads(row['files'])
            if len(files) >= 1000 and str(message_id) not in files:
                raise ValueError('В одном альбоме можно собрать до 1000 файлов')
            files[str(message_id)] = file
            conn.execute('UPDATE import_album_batches SET files=? WHERE chat_id=? AND user_id=? AND owner_id=?',
                         (json.dumps(files), chat_id, telegram_id, owner_id))
            return len(files)

    def finish_batch(self, chat_id, telegram_id, owner_id):
        with self.connect() as conn:
            conn.execute('DELETE FROM import_album_batches WHERE chat_id=? AND user_id=? AND owner_id=?',
                         (chat_id, telegram_id, owner_id))

    def recoverable(self):
        with self.connect() as conn:
            return [row[0] for row in conn.execute("""SELECT id FROM import_jobs
                WHERE state='active' OR (state='finished' AND EXISTS (
                    SELECT 1 FROM import_positions p WHERE p.job_id=import_jobs.id AND p.state='ready'
                ))""")]

    def pending_cancellations(self):
        with self.connect() as conn:
            return conn.execute("""SELECT id,owner_id,playlist_id FROM import_jobs
                WHERE state='cancelled' AND initial_playlist=1 AND playlist_id IS NOT NULL""").fetchall()

    def cancellation_cleaned(self, job_id):
        with self.connect() as conn:
            conn.execute("UPDATE import_jobs SET initial_playlist=0 WHERE state='cancelled' AND id=?", (job_id,))

    def claim_snapshot(self):
        with self.connect() as conn:
            return conn.execute("""UPDATE import_jobs SET state='resolving' WHERE id=(
                SELECT id FROM import_jobs WHERE state='new' AND status_message IS NOT NULL
                ORDER BY id LIMIT 1) RETURNING *""").fetchone()

    def snapshot(self, job_id, title, kind, sources, playlist_id=None, *, initial=False, review=None,
                 retained=None):
        if not sources or len(sources) > 1000:
            raise ValueError('Недоступен полный список треков или превышен лимит в 1000 позиций')
        with self.connect() as conn:
            state = 'review' if review else 'active'
            changed = conn.execute("""UPDATE import_jobs SET title=?,kind=?,state=?,playlist_id=?,
                initial_playlist=?,review=? WHERE id=? AND state IN ('resolving','review')""",
                                   (title, kind, state, playlist_id, int(initial),
                                    json.dumps(review) if review else None, job_id)).rowcount
            if changed:
                conn.execute('DELETE FROM import_positions WHERE job_id=?', (job_id,))
                rows = []
                for index, source in enumerate(sources, 1):
                    track_id, removed = (retained or {}).get(source.get('slot'), (None, False))
                    rows.append((job_id, index, json.dumps(source),
                                 'done' if track_id or removed else 'pending', track_id))
                conn.executemany("""INSERT INTO import_positions(job_id,position,source,state,track_id)
                    VALUES (?,?,?,?,?)""", rows)
            return bool(changed)

    def claim_position(self):
        now = time.time()
        with self.connect() as conn:
            return conn.execute("""UPDATE import_positions SET state='downloading' WHERE (job_id,position)=(
                SELECT p.job_id,p.position FROM import_positions p JOIN import_jobs j ON j.id=p.job_id
                WHERE j.state IN ('active','finished') AND
                    (p.state='pending' OR (p.state='skipped' AND p.run_after>0 AND p.run_after<=?
                                          AND p.retry_until>?))
                    AND (j.mode='server' OR p.position<(
                        SELECT COALESCE(MIN(head.position),p.position)+12 FROM import_positions head
                        WHERE head.job_id=p.job_id AND head.state IN ('pending','downloading','ready')
                    ))
                ORDER BY (j.kind='track') DESC,p.job_id,p.position LIMIT 1) RETURNING *""", (now, now)).fetchone()

    def expire_retries(self):
        with self.connect() as conn:
            return {row[0] for row in conn.execute("""UPDATE import_positions SET run_after=0
                WHERE state='skipped' AND run_after>0 AND retry_until<=? RETURNING job_id""",
                                                  (time.time(),))}

    def mark_wrong_version(self, track_id):
        with self.connect() as conn:
            rows = conn.execute("""UPDATE import_positions SET state='skipped',run_after=0,
                error='Подтвердилась другая версия. Повторите поиск оригинала.'
                WHERE track_id=? AND state='done' AND job_id IN (
                    SELECT id FROM import_jobs WHERE mode='server' AND state IN ('active','finished')
                ) RETURNING job_id""", (track_id,))
            return {row[0] for row in rows}

    def remember_repair(self, chat_id, message_id, job_id, position):
        with self.connect() as conn:
            conn.execute('INSERT INTO import_repair_prompts VALUES (?,?,?,?)',
                         (chat_id, message_id, job_id, position))

    def repair(self, chat_id, reply_id, message_id, telegram_id, owner_id, replacement):
        with self.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            prompt = conn.execute("""SELECT r.job_id,r.position,p.source,p.state,j.state AS job_state
                FROM import_repair_prompts r JOIN import_positions p
                  ON p.job_id=r.job_id AND p.position=r.position JOIN import_jobs j ON j.id=r.job_id
                WHERE r.chat_id=? AND r.message_id=? AND j.user_id=? AND j.owner_id=?""",
                                  (chat_id, reply_id, telegram_id, owner_id)).fetchone()
            if not prompt:
                return None
            job_id = prompt['job_id']
            duplicate = conn.execute('SELECT job_id FROM import_messages WHERE chat_id=? AND message_id=?',
                                     (chat_id, message_id)).fetchone()
            if duplicate:
                return job_id
            if prompt['state'] != 'skipped' or prompt['job_state'] not in {'active', 'finished'}:
                raise ValueError('Эта позиция уже обрабатывается или импорт закрыт')
            source = json.loads(prompt['source'])
            source['replacement'] = replacement
            conn.execute("""UPDATE import_positions SET state='pending',source=?,retry_until=0,run_after=0
                WHERE job_id=? AND position=?""", (json.dumps(source), job_id, prompt['position']))
            conn.execute('INSERT INTO import_messages VALUES (?,?,?)', (chat_id, message_id, job_id))
            return job_id

    def interrupt(self, job_id, position):
        with self.connect() as conn:
            conn.execute("""UPDATE import_positions SET state='pending' WHERE job_id=?
                AND position=? AND state='downloading'""", (job_id, position))

    def downloaded(self, job_id, position, artifact):
        with self.connect() as conn:
            return bool(conn.execute("""UPDATE import_positions SET state='ready',artifact=?,error=NULL,
                sha256=?,evidence=?
                WHERE job_id=? AND position=? AND state='downloading'
                AND (SELECT state FROM import_jobs WHERE id=?) IN ('active','finished')""",
                                     (json.dumps(artifact), artifact['sha256'],
                                      json.dumps(artifact.get('evidence') or {}), job_id, position, job_id)).rowcount)

    def skip(self, job_id, position, reason, *, temporary=False, alternative=None):
        now = time.time()
        with self.connect() as conn:
            row = conn.execute("""SELECT retry_until, attempts FROM import_positions p
                JOIN import_jobs j ON p.job_id=j.id WHERE j.id=? AND p.position=?
                AND j.state IN ('active','finished') AND p.state IN ('ready','downloading','sending')""",
                               (job_id, position)).fetchone()
            if row is None:
                return
            deadline = row['retry_until']
            if temporary and deadline is None:
                deadline = now + 86400
            attempts = row['attempts'] + 1
            next_try = now + min(3600, 30 * 2 ** min(attempts, 7))
            conn.execute("""UPDATE import_positions SET state='skipped',error=?,artifact=NULL,
                attempts=?,retry_until=?,run_after=?,alternative=? WHERE job_id=? AND position=?""",
                         (reason, attempts, deadline, next_try if temporary and next_try < deadline else 0,
                          json.dumps(alternative) if alternative else None, job_id, position))

    def deliverable(self, job_id, mode):
        with self.connect() as conn:
            return conn.execute("""SELECT p.* FROM import_positions p
                WHERE p.job_id=? AND p.state='ready' AND (?='server' OR NOT EXISTS (
                    SELECT 1 FROM import_positions earlier WHERE earlier.job_id=p.job_id
                    AND earlier.position<p.position AND earlier.state IN ('pending','downloading','ready','sending')
                )) ORDER BY p.position LIMIT 1""", (job_id, mode)).fetchone()

    def chat_sending(self, job_id, position, *, delayed=False):
        old, new = ('sending', 'ready') if delayed else ('ready', 'sending')
        with self.connect() as conn:
            return bool(conn.execute("""UPDATE import_positions SET state=? WHERE job_id=?
                AND position=? AND state=?""", (new, job_id, position, old)).rowcount)

    def delivered(self, job_id, position, track_id=None, result_id=None):
        with self.connect() as conn:
            conn.execute("""UPDATE import_positions SET state='done',artifact=NULL,track_id=?
                WHERE job_id=? AND position=? AND state IN ('ready','sending')""", (track_id, job_id, position))
            if result_id is not None:
                conn.execute('UPDATE import_jobs SET result_id=? WHERE id=?', (str(result_id), job_id))

    def settle(self, job_id):
        with self.connect() as conn:
            conn.execute("""UPDATE import_jobs SET state='finished' WHERE id=? AND state='active'
                AND NOT EXISTS (SELECT 1 FROM import_positions WHERE job_id=?
                    AND state IN ('pending','downloading','ready','sending'))""", (job_id, job_id))

    def fail(self, job_id, reason):
        with self.connect() as conn:
            conn.execute("""UPDATE import_jobs SET state='failed',error=?
                WHERE id=? AND state IN ('resolving','active','finished','review')""", (reason, job_id))

    def control(self, job_id, telegram_id, owner_id, action, position=0):
        with self.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            job = conn.execute('SELECT * FROM import_jobs WHERE id=? AND user_id=? AND owner_id=?',
                               (job_id, telegram_id, owner_id)).fetchone()
            if not job:
                return False
            if action == 'retry' and job['state'] in {'active', 'finished'}:
                return bool(conn.execute("""UPDATE import_positions SET state='pending',run_after=0,
                    retry_until=0 WHERE job_id=? AND state='skipped' AND run_after=0
                    AND (?=0 OR position=?)""", (job_id, position, position)).rowcount)
            transitions = {'pause': ('active', 'paused'), 'resume': ('paused', 'active')}
            if action in transitions and job['kind'] == 'playlist':
                previous, target = transitions[action]
                return bool(conn.execute('UPDATE import_jobs SET state=? WHERE id=? AND state=?',
                                         (target, job_id, previous)).rowcount)
            if action == 'cancel' and (job['kind'] == 'playlist' or job['state'] == 'review'):
                return bool(conn.execute("""UPDATE import_jobs SET state='cancelled' WHERE id=?
                    AND state IN ('active','paused','review')""", (job_id,)).rowcount)
            return False
