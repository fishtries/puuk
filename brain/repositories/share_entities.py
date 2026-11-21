"""Permanent catalog identity. Callers own the short write transaction.

Registry rows never cascade or get reused. Path ownership is retired separately,
so a deliberate import after deletion obtains a fresh identity.
"""
import os
import uuid
from repositories.base import get_connection


class IdentityNotClaimed(ValueError):
    pass


def normalize_rel_path(path):
    from config import get_effective_music_dir
    if not isinstance(path, str) or not path or '\\' in path or '\x00' in path:
        raise IdentityNotClaimed('identity_not_claimed')
    if os.path.isabs(path):
        root = os.path.realpath(get_effective_music_dir())
        target = os.path.realpath(path)
        if os.path.commonpath((root, target)) != root:
            raise IdentityNotClaimed('identity_not_claimed')
        path = os.path.relpath(target, root)
    if any(part in ('', '.', '..') for part in path.split('/')):
        raise IdentityNotClaimed('identity_not_claimed')
    return path


def register(conn, entity_type, public_id):
    key = str(public_id)
    row = conn.execute('SELECT state FROM share_entities WHERE entity_type=? AND public_id=?', (entity_type,key)).fetchone()
    if row and row['state'] != 'active':
        raise IdentityNotClaimed('identity_not_claimed')
    conn.execute("INSERT OR IGNORE INTO share_entities(entity_type,public_id,state) VALUES (?,?,'active')", (entity_type,key))


def recovery_allowed(track_id, *, conn=None):
    own = conn is None
    conn = get_connection() if own else conn
    try:
        row = conn.execute("SELECT state FROM share_entities WHERE entity_type='track' AND public_id=?", (str(track_id),)).fetchone()
        return row is None or row['state'] == 'active'
    finally:
        if own:
            conn.close()


def claim_track_identity(conn, rel_path, source, expected_track_id=None):
    rel_path = normalize_rel_path(rel_path)
    if source not in ('import','recovery'):
        raise ValueError('invalid_ingest_source')
    if conn.execute('SELECT 1 FROM retired_import_paths WHERE rel_path=?', (rel_path,)).fetchone():
        return None
    claim = conn.execute('SELECT track_id FROM track_path_claims WHERE rel_path=?', (rel_path,)).fetchone()
    if source == 'recovery':
        if expected_track_id is None or not recovery_allowed(expected_track_id, conn=conn):
            return None
        candidate = str(expected_track_id)
        if claim and claim['track_id'] != candidate:
            return None
        other = conn.execute('SELECT rel_path FROM track_path_claims WHERE track_id=?', (candidate,)).fetchone()
        if other and other['rel_path'] != rel_path:
            return None
    elif claim:
        candidate = claim['track_id']
        if not recovery_allowed(candidate, conn=conn):
            return None
    else:
        candidate = str(uuid.uuid5(uuid.NAMESPACE_URL, rel_path))
        if conn.execute("SELECT 1 FROM share_entities WHERE entity_type='track' AND public_id=?", (candidate,)).fetchone():
            candidate = str(expected_track_id or uuid.uuid4())
            try:
                chosen=uuid.UUID(candidate)
                if chosen.version!=4 or str(chosen)!=candidate:
                    return None
            except (ValueError,AttributeError):
                return None
            if conn.execute("SELECT 1 FROM share_entities WHERE entity_type='track' AND public_id=?", (candidate,)).fetchone():
                return None
    register(conn,'track',candidate)
    conn.execute('INSERT OR IGNORE INTO track_path_claims(rel_path,track_id) VALUES (?,?)', (rel_path,candidate))
    return candidate


def tombstone(conn, entity_type, public_id):
    key = str(public_id)
    conn.execute("""INSERT INTO share_entities(entity_type,public_id,state) VALUES (?,?,'deleted')
        ON CONFLICT(entity_type,public_id) DO UPDATE SET state='deleted',target_id=NULL,changed_at=unixepoch()""", (entity_type,key))
    if entity_type == 'track':
        conn.execute('DELETE FROM track_path_claims WHERE track_id=?', (key,))


def alias_album(conn, source, target):
    source, target = str(source), str(target)
    register(conn,'album',target)
    # Resolve and compress all incoming aliases in this same merge transaction.
    conn.execute("UPDATE share_entities SET target_id=?,changed_at=unixepoch() WHERE entity_type='album' AND state='alias' AND target_id=?", (target,source))
    conn.execute("""INSERT INTO share_entities(entity_type,public_id,state,target_id) VALUES ('album',?,'alias',?)
        ON CONFLICT(entity_type,public_id) DO UPDATE SET state='alias',target_id=excluded.target_id,changed_at=unixepoch()""", (source,target))


def resolve(conn, entity_type, public_id):
    current = str(public_id)
    seen = set()
    for _ in range(9):
        if current in seen:
            return None, 'unavailable'
        seen.add(current)
        row = conn.execute('SELECT state,target_id FROM share_entities WHERE entity_type=? AND public_id=?', (entity_type,current)).fetchone()
        if not row:
            return None,'unknown'
        if row['state'] == 'deleted':
            return None,'deleted'
        if row['state'] == 'active':
            return current,'active'
        if len(seen)>8:
            break
        current = row['target_id']
    return None,'unavailable'


def backfill(conn):
    # INSERT OR IGNORE deliberately never revives an interrupted/deleted identity.
    for kind, table in (('track','tracks'),('album','albums'),('artist','artists')):
        conn.execute(f"INSERT OR IGNORE INTO share_entities(entity_type,public_id,state) SELECT ?,CAST(id AS TEXT),'active' FROM {table}", (kind,))
    for row in conn.execute('SELECT id,file_path FROM tracks ORDER BY id').fetchall():
        if not recovery_allowed(row['id'],conn=conn):
            continue
        try:
            path = normalize_rel_path(row['file_path'])
        except IdentityNotClaimed:
            continue
        conn.execute('INSERT OR IGNORE INTO track_path_claims(rel_path,track_id) VALUES (?,?)', (path,row['id']))
