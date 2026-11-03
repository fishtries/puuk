"""Durable, conditional bulk edits of artist credits."""
import hashlib
import json
import sqlite3
import uuid
from functools import wraps
from fastapi import HTTPException
from repositories import artist_credits as credits
from repositories.base import get_connection, bump_catalog_version
from services.artist_credit_lock import serialize_artist_credit_mutation


def _error(status, code, **fields):
    raise HTTPException(status_code=status, detail={'code': code, **fields})


def _admin(user):
    if not user:
        _error(401, 'unauthorized')
    if user.get('role') != 'admin':
        _error(403, 'forbidden')


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _version(conn):
    row = conn.execute("SELECT value FROM catalog_meta WHERE key='track_catalog'").fetchone()
    return int(row[0]) if row else 0


def _selection(conn, source, scope):
    table, column = ('track_artists', 'track_id') if scope == 'tracks' else ('album_artists', 'album_id')
    return [str(r[0]) for r in conn.execute(f'SELECT {column} FROM {table} WHERE artist_id=? ORDER BY {column}', (source,))]


def _store(conn, plan, user):
    operation = str(uuid.uuid4())
    data = _json(plan)
    conn.execute('INSERT INTO artist_credit_operations(id,actor_user_id,request_hash,plan_json,state) VALUES (?,?,?,?,?)',
                 (operation, user['id'], hashlib.sha256(data.encode()).hexdigest(), data, 'preview'))
    conn.commit()
    return {'operation_id': operation, 'state': 'preview', 'source_artist_id': plan['source'],
            'scope': plan['scope'], 'matched_count': len(plan['entries']),
            'changed_count': sum(e['before'] != e['after'] for e in plan['entries']),
            'entries': [{k: e[k] for k in ('entity_type','entity_id','expected_revision','before','after')} for e in plan['entries']],
            'unresolved': [], 'catalog_version': _version(conn)}


def _entry(conn, kind, key, state, after):
    row = conn.execute('SELECT manual_names_json FROM artist_credit_state WHERE entity_type=? AND entity_id=?', (kind, key)).fetchone()
    return {'entity_type': kind, 'entity_id': key, 'expected_revision': state['revision'],
            'before': state['artists'], 'after': after, 'before_manual': row[0] if row else None}


def _busy_as_503(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except sqlite3.OperationalError as exc:
            if getattr(exc, 'sqlite_errorcode', 0) & 0xff in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
                raise HTTPException(503, detail={'code': 'credits_busy', 'message': 'База занята'},
                                    headers={'Retry-After': '1'}) from exc
            raise
    return wrapped


@_busy_as_503
def preview_artist_replacement(source_artist_id, scope, artists, current_user):
    _admin(current_user)
    if scope not in ('tracks', 'albums'):
        _error(422, 'invalid_scope')
    conn = get_connection()
    try:
        conn.execute('BEGIN IMMEDIATE')
        if not conn.execute('SELECT 1 FROM artists WHERE id=?', (source_artist_id,)).fetchone():
            _error(404, 'artist_not_found')
        try:
            names = credits._selectors(conn, artists)
        except credits.CreditValidationError as exc:
            _error(422, exc.code)
        replacement = []
        for name in names:
            artist_id = credits.artist_id_for_name(name)
            existing = conn.execute('SELECT name FROM artists WHERE id=?', (artist_id,)).fetchone()
            replacement.append({'id': artist_id, 'name': existing[0] if existing else name})
        ids = _selection(conn, source_artist_id, scope)
        if len(ids) > 5000:
            _error(422, 'bulk_scope_too_large')
        kind = 'track' if scope == 'tracks' else 'album'
        states = credits.get_credit_states(kind, ids, conn=conn)
        entries = []
        for key in ids:
            state = states[key]
            expanded = []
            for item in state['artists']:
                expanded.extend(replacement if item['id'] == source_artist_id else [item])
            seen = set()
            after = [item for item in expanded if not (item['id'] in seen or seen.add(item['id']))]
            if len(after) > 100:
                _error(422, 'bulk_result_too_large', entity_id=key)
            entries.append(_entry(conn, kind, key, state, after))
        return _store(conn, {'kind': 'replacement', 'source': source_artist_id, 'scope': scope,
                             'replacement': replacement, 'entries': entries}, current_user)
    finally:
        conn.close()


@_busy_as_503
def preview_artist_report(report, proposal_ids, current_user):
    _admin(current_user)
    if not isinstance(report, dict) or report.get('version') != 1 or not isinstance(proposal_ids, (list, tuple)) or len(set(proposal_ids)) != len(proposal_ids):
        _error(422, 'invalid_report')
    proposals = report.get('proposals', [])
    by_id = {p.get('id'): p for p in proposals if isinstance(p, dict)}
    if len(by_id) != len(proposals) or any(i not in by_id for i in proposal_ids):
        _error(422, 'invalid_report')
    conn = get_connection()
    try:
        conn.execute('BEGIN IMMEDIATE')
        entries, seen = [], set()
        for ident in proposal_ids:
            p = by_id[ident]
            expected_id = hashlib.sha256(_json({k: v for k, v in p.items() if k != 'id'}).encode()).hexdigest()
            if ident != expected_id:
                _error(422, 'invalid_report')
            if p.get('ambiguity') != 'confirmed' or not isinstance(p.get('evidence'), str) or not p['evidence'].strip():
                _error(422, 'ambiguous_proposal')
            kind, key = p.get('entity_type'), str(p.get('entity_id'))
            if kind not in ('track','album') or (kind,key) in seen:
                _error(422, 'invalid_report')
            seen.add((kind,key))
            state = credits.get_credit_states(kind, [key], conn=conn).get(key)
            if not state or state['revision'] != p.get('expected_revision') or state['artists'] != p.get('before'):
                _error(409, 'bulk_revision_conflict')
            try:
                names = credits._selectors(conn, [{'id': a['id']} if conn.execute('SELECT 1 FROM artists WHERE id=?', (a.get('id'),)).fetchone() else {'name': a['name']} for a in p['after']])
            except (credits.CreditValidationError, KeyError, TypeError):
                _error(422, 'invalid_report')
            after = [{'id': credits.artist_id_for_name(n), 'name': n} for n in names]
            if [a['id'] for a in after] != [a.get('id') for a in p['after']]:
                _error(422, 'invalid_report')
            entries.append(_entry(conn, kind, key, state, after))
        if len(entries) > 5000:
            _error(422, 'bulk_scope_too_large')
        return _store(conn, {'kind':'report','source':None,'scope':'report','entries':entries}, current_user)
    finally:
        conn.close()


def _operation(conn, source, operation):
    row = conn.execute('SELECT * FROM artist_credit_operations WHERE id=?', (operation,)).fetchone()
    if not row:
        _error(404, 'operation_not_found')
    if hashlib.sha256(row['plan_json'].encode()).hexdigest() != row['request_hash']:
        _error(409, 'operation_plan_corrupt')
    plan = json.loads(row['plan_json'])
    if plan['source'] != source or (source is not None and plan['kind'] != 'replacement'):
        _error(409, 'operation_source_mismatch')
    return row, plan


def _affected(conn, entries):
    tracks, albums, artists = set(), set(), set()
    for e in entries:
        artists.update(a['id'] for a in e['before'] + e['after'])
        if e['entity_type'] == 'track':
            tracks.add(e['entity_id'])
            row = conn.execute('SELECT album_id FROM tracks WHERE id=?', (e['entity_id'],)).fetchone()
            if row and row[0] is not None: albums.add(row[0])
        else:
            albums.add(int(e['entity_id']))
            tracks.update(r[0] for r in conn.execute('SELECT id FROM tracks WHERE album_id=?', (e['entity_id'],)))
    return {'track_ids': sorted(tracks), 'album_ids': sorted(albums), 'artist_ids': sorted(artists)}


def _result(conn, operation, state, plan, changed):
    return {'operation_id': operation, 'state': state, 'scope': plan['scope'], 'matched_count': len(plan['entries']),
            'changed_count': len(changed), 'catalog_version': _version(conn), 'affected': _affected(conn, changed)}


@serialize_artist_credit_mutation
@_busy_as_503
def apply_artist_replacement(source_artist_id, operation_id, current_user):
    _admin(current_user)
    conn = get_connection()
    try:
        conn.execute('BEGIN IMMEDIATE')
        row, plan = _operation(conn, source_artist_id, operation_id)
        if row['state'] != 'preview': return json.loads(row['result_json'])
        entries = plan['entries']
        if plan['kind'] == 'replacement' and set(_selection(conn, plan['source'], plan['scope'])) != {e['entity_id'] for e in entries}:
            _error(409, 'bulk_selection_changed')
        conflicts = []
        for kind in ('track','album'):
            group = [e for e in entries if e['entity_type'] == kind]
            states = credits.get_credit_states(kind, [e['entity_id'] for e in group], conn=conn)
            for e in group:
                state = states.get(e['entity_id'])
                if not state or state['revision'] != e['expected_revision']:
                    conflicts.append({'entity_type':kind,'entity_id':e['entity_id'],'current_revision':state['revision'] if state else None})
        if conflicts: _error(409, 'bulk_revision_conflict', conflicts=conflicts)
        changed = [e for e in entries if e['before'] != e['after']]
        for e in changed:
            state = credits.replace_artist_credits(conn, e['entity_type'], e['entity_id'], [{'id': a['id']} if conn.execute('SELECT 1 FROM artists WHERE id=?', (a['id'],)).fetchone() else {'name': a['name']} for a in e['after']], expected_revision=e['expected_revision'])
            e['after_revision'] = state['revision']
        if changed: bump_catalog_version(conn)
        result = _result(conn, operation_id, 'applied', plan, changed)
        data = _json(plan)
        conn.execute("UPDATE artist_credit_operations SET state='applied', plan_json=?, request_hash=?, result_json=?, applied_at=CURRENT_TIMESTAMP WHERE id=?", (data, hashlib.sha256(data.encode()).hexdigest(), _json(result), operation_id))
        conn.commit()
        return result
    finally:
        conn.close()


@serialize_artist_credit_mutation
@_busy_as_503
def undo_artist_replacement(source_artist_id, operation_id, current_user):
    _admin(current_user)
    conn = get_connection()
    try:
        conn.execute('BEGIN IMMEDIATE')
        row, plan = _operation(conn, source_artist_id, operation_id)
        if row['state'] == 'preview': _error(409, 'operation_not_applied')
        if row['state'] == 'undone': return json.loads(row['undo_result_json'])
        changed = [e for e in plan['entries'] if e['before'] != e['after']]
        for e in changed:
            state = credits.get_credit_states(e['entity_type'], [e['entity_id']], conn=conn).get(e['entity_id'])
            manual = conn.execute('SELECT manual_names_json FROM artist_credit_state WHERE entity_type=? AND entity_id=?', (e['entity_type'], e['entity_id'])).fetchone()
            if not state or state['revision'] != e['after_revision'] or [a['id'] for a in state['artists']] != [a['id'] for a in e['after']] or not manual or manual[0] is None or [credits.artist_id_for_name(n) for n in json.loads(manual[0])] != [a['id'] for a in e['after']]:
                _error(409, 'bulk_undo_conflict')
        for e in changed:
            conn.execute('UPDATE artist_credit_state SET manual_names_json=?, revision=revision+1 WHERE entity_type=? AND entity_id=?', (e['before_manual'], e['entity_type'], e['entity_id']))
            credits._set_links(conn, e['entity_type'], e['entity_id'], [a['name'] for a in e['before']])
        if changed: bump_catalog_version(conn)
        result = _result(conn, operation_id, 'undone', plan, changed)
        conn.execute("UPDATE artist_credit_operations SET state='undone', undo_result_json=?, undone_at=CURRENT_TIMESTAMP WHERE id=?", (_json(result), operation_id))
        conn.commit()
        return result
    finally:
        conn.close()
