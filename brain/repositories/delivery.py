"""Durable version preparation, actual CDN exposure, and purge reservation.

Prepared/direct versions never consume purge capacity. All mutating helpers with
``conn`` execute within the caller's transaction and never commit it.
"""
import json
import time
import uuid
from contextlib import contextmanager
from repositories.base import get_connection, check_deadline

CAPACITY = 10000
DRAIN_SECONDS = 3630


def fingerprint(st):
    return [st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns]


@contextmanager
def transaction(deadline=None,cancel=None):
    conn = get_connection(deadline=deadline,cancel=cancel)
    try:
        conn.execute('BEGIN IMMEDIATE')
        yield conn
        check_deadline(deadline,cancel)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_version(track_id, *, conn=None):
    own = conn is None
    conn = get_connection() if own else conn
    try:
        row = conn.execute('SELECT * FROM delivery_versions WHERE track_id=?',(track_id,)).fetchone()
        return dict(row) if row else None
    finally:
        if own:
            conn.close()


def ready_version(track_id, st, *, conn=None):
    own=conn is None
    conn=get_connection() if own else conn
    try:
        if conn.execute("SELECT 1 FROM track_mutation_journal WHERE track_id=? AND status IN ('prepared','replaced','failed') LIMIT 1",(track_id,)).fetchone():
            return None
        row=get_version(track_id,conn=conn)
        if (row and row['state']=='ready' and row['fingerprint']==json.dumps(fingerprint(st),separators=(',',':'))
                and row['content_length']==st.st_size):
            return row
        return None
    finally:
        if own:
            conn.close()


def enqueue(track_id, *, conn=None, retry_failed=False):
    if conn is None:
        with transaction() as tx:
            return enqueue(track_id,conn=tx,retry_failed=retry_failed)
    row = get_version(track_id,conn=conn)
    if row and row['state'] in ('ready','pending','hashing'):
        return True
    if row and row['state']=='failed' and not retry_failed:
        return False
    if conn.execute("SELECT COUNT(*) FROM delivery_versions WHERE state IN ('pending','hashing')").fetchone()[0] >= CAPACITY:
        return False
    conn.execute("""INSERT INTO delivery_versions(track_id,state) VALUES (?,'pending')
        ON CONFLICT(track_id) DO UPDATE SET state='pending',attempts=0,fence=NULL,lease_until=NULL,reason=NULL,next_attempt_at=0,changed_at=unixepoch()""",(track_id,))
    return True


def expose(conn, track_id, version, expires):
    conn.execute("""INSERT INTO delivery_exposures(track_id,content_version,max_expires_at) VALUES (?,?,?)
        ON CONFLICT(track_id,content_version) DO UPDATE SET max_expires_at=MAX(max_expires_at,excluded.max_expires_at)""",(track_id,version,expires))


def drain_expired(conn, now=None):
    now = time.time() if now is None else now
    conn.execute("""UPDATE cdn_purge_outbox SET state='drained',reason='expired_without_confirmed_purge',changed_at=?
        WHERE state IN ('pending','failed') AND drain_until<=? AND (lease_until IS NULL OR lease_until<?)""",(now,now,now))


def reserve_retirement(conn, track_id, *, deleting=False, unmanaged=False, now=None):
    """Reserve exposed intent before mutation, or retain reconciliation on unmanaged loss."""
    now = time.time() if now is None else now
    rows = conn.execute('SELECT * FROM delivery_exposures WHERE track_id=? AND ever_exposed=1',(track_id,)).fetchall()
    live = [row for row in rows if now < row['max_expires_at']+DRAIN_SECONDS]
    if live:
        drain_expired(conn,now)
        active = conn.execute("SELECT * FROM cdn_purge_outbox WHERE track_id=? AND state IN ('pending','submitting','polling','failed') ORDER BY created_at LIMIT 1",(track_id,)).fetchone()
        until = max(r['max_expires_at']+DRAIN_SECONDS for r in live)
        # Track-wide wildcard also safely coalesces every retired version/slice.
        path = f'/cdn/audio/{track_id}/*'
        if active:
            # A retirement arriving during submission/polling must survive that
            # operation's success: revision fencing schedules another purge.
            conn.execute("UPDATE cdn_purge_outbox SET path=?,revision=revision+1,drain_until=MAX(drain_until,?),changed_at=? WHERE id=?",(path,until,now,active['id']))
        else:
            count=conn.execute("SELECT COUNT(*) FROM cdn_purge_outbox WHERE state IN ('pending','submitting','polling','failed')").fetchone()[0]
            if count>=CAPACITY:
                if not unmanaged:
                    raise TimeoutError('delivery_busy')
                conn.execute('UPDATE delivery_exposures SET retired_at=COALESCE(retired_at,?),reconciliation_needed=1 WHERE track_id=?',(now,track_id))
                conn.execute("UPDATE delivery_versions SET state='unprepared',fingerprint=NULL,fence=NULL,changed_at=? WHERE track_id=?",(now,track_id))
                return False
            conn.execute("""INSERT INTO cdn_purge_outbox(id,track_id,path,drain_until) VALUES (?,?,?,?)""",(uuid.uuid4().hex,track_id,path,until))
    conn.execute('UPDATE delivery_exposures SET retired_at=COALESCE(retired_at,?),reconciliation_needed=0 WHERE track_id=?',(now,track_id))
    conn.execute("UPDATE delivery_versions SET state=?,fingerprint=NULL,fence=NULL,lease_until=NULL,attempts=0,next_attempt_at=0,changed_at=? WHERE track_id=?",('retired' if deleting else 'unprepared',now,track_id))
    return True


def invalidate(track_id, *, deleting=False, unmanaged=False, deadline=None, cancel=None):
    from repositories.share_entities import tombstone
    with transaction(deadline,cancel) as conn:
        reserve_retirement(conn,track_id,deleting=deleting,unmanaged=unmanaged)
        if deleting:
            tombstone(conn,'track',track_id)
        else:
            enqueue(track_id,conn=conn)


def purge_healthy(conn=None):
    import config
    if not config.CDN_PURGE_ENABLED or not config.CDN_RESOURCE_ID or not config.CDN_PURGE_TOKEN:
        return False
    own = conn is None
    conn = get_connection() if own else conn
    try:
        row = conn.execute("SELECT value FROM delivery_control WHERE key='purge_heartbeat'").fetchone()
        now = time.time()
        if not row or not 0<=now-float(row[0])<=120:
            return False
        if conn.execute('SELECT 1 FROM delivery_exposures WHERE reconciliation_needed=1 AND max_expires_at+3630>? LIMIT 1',(now,)).fetchone():
            return False
        if conn.execute("SELECT 1 FROM cdn_purge_outbox WHERE state='failed' AND drain_until>? LIMIT 1",(now,)).fetchone():
            return False
        return conn.execute("SELECT COUNT(*) FROM cdn_purge_outbox WHERE state IN ('pending','submitting','polling','failed') AND drain_until>?",(now,)).fetchone()[0]<CAPACITY
    finally:
        if own:
            conn.close()


def requeue_failed(job_id, incident_id):
    """Operator-only explicit incident acknowledgment; never called by Play.

    The caller records reviewed remediation in the runbook under incident_id.
    Preserve the failed budget in audit before starting a fresh finite budget.
    """
    import re
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}',incident_id):
        raise ValueError('invalid_incident_id')
    with transaction(time.monotonic()+.1) as conn:
        row=conn.execute("SELECT * FROM cdn_purge_outbox WHERE id=? AND state='failed' AND lease_until IS NULL",(job_id,)).fetchone()
        if not row:
            return False
        conn.execute('INSERT INTO cdn_purge_requeues(budget_id,job_id,incident_id,previous_attempts,previous_reason) VALUES (?,?,?,?,?)',
            (uuid.uuid4().hex,job_id,incident_id,row['attempts'],row['reason']))
        conn.execute("""UPDATE cdn_purge_outbox SET state='pending',attempts=0,first_attempt_at=NULL,operation_started_at=NULL,
            operation_id=NULL,fence=NULL,next_attempt_at=0,reason='operator_requeue',changed_at=? WHERE id=?""",(time.time(),job_id))
        return True
