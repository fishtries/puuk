"""Ordered artist identities and their protected, source-aware membership.

Writers use the caller's transaction and never commit or bump catalog metadata.
Indexed links are the effective membership; state survives accidental row loss so
recovery can restore a manual decision, including an intentional empty list.
"""
from dataclasses import dataclass
import hashlib
import json
import logging
import sqlite3
import unicodedata
from typing import Any, Literal, Sequence, TypedDict

from repositories.base import get_connection

EntityType = Literal['track', 'album']
SourceKind = Literal['unknown', 'legacy', 'qdrant', 'tags', 'provider']
SOURCE_RANKS = {'unknown': 0, 'legacy': 10, 'qdrant': 20, 'tags': 30, 'provider': 40}
BATCH_SIZE = 400
MAX_ARTISTS = 100
MAX_NAME_LENGTH = 300
logger = logging.getLogger(__name__)


class ArtistById(TypedDict):
    id: str


class ArtistByName(TypedDict):
    name: str


CreditSelector = ArtistById | ArtistByName


class CreditState(TypedDict):
    artists: list[dict[str, str]]
    revision: int
    manual: bool
    source_kind: str
    source_names: list[str]


@dataclass(frozen=True)
class CreditSource:
    kind: SourceKind
    names: Sequence[str]

    def __post_init__(self):
        if self.kind not in SOURCE_RANKS:
            raise CreditValidationError('invalid_artists', 'Unknown artist source')
        if isinstance(self.names, (str, bytes)) or self.names is None:
            raise CreditValidationError('invalid_artists', 'Artist source must be a sequence of names')
        object.__setattr__(self, 'names', tuple(self.names))


class CreditNotFound(Exception):
    def __init__(self, entity_type, entity_id):
        self.entity_type, self.entity_id = entity_type, entity_id
        super().__init__(f'{entity_type} not found: {entity_id}')


class CreditValidationError(ValueError):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


class CreditConflict(Exception):
    def __init__(self, current_state):
        self.current_state = current_state
        super().__init__('Artist credits revision conflict')


class AlbumCreditsConflict(Exception):
    def __init__(self, source_album_id, target_album_id):
        self.source_album_id, self.target_album_id = source_album_id, target_album_id
        super().__init__('Albums have conflicting manual artist credits')


def normalize_artist_name(value: Any) -> str:
    return ' '.join(unicodedata.normalize('NFKC', str(value)).split()) if value is not None else ''


def artist_id_for_name(value: Any) -> str | None:
    name = normalize_artist_name(value)
    if not name or name.casefold() == 'various artists':
        return None
    return 'art_' + hashlib.sha256(name.encode('utf-8')).hexdigest()[:32]


def _entity(entity_type, entity_id):
    if entity_type == 'track':
        return 'tracks', 'track_artists', 'track_id', str(entity_id)
    if entity_type == 'album':
        return 'albums', 'album_artists', 'album_id', str(int(entity_id))
    raise CreditValidationError('invalid_artists', 'Unknown credit entity type')


def _dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def _canonical_names(names):
    result = []
    seen = set()
    for name in names:
        if not isinstance(name, str):
            raise CreditValidationError('invalid_artists', 'Artist names must be strings')
        normalized = normalize_artist_name(name)
        if artist_id_for_name(normalized) and normalized not in seen:
            result.append(normalized)
            seen.add(normalized)
    return result


def _register(conn, names, *, display_values=None):
    """Keep the historical deterministic minimum spelling for each identity."""
    for value in display_values if display_values is not None else names:
        normalized = normalize_artist_name(value)
        artist_id = artist_id_for_name(normalized)
        if not artist_id:
            continue
        display = str(value).strip()
        if display_values is None:
            conn.execute('INSERT OR IGNORE INTO artists(id,normalized_name,name) VALUES (?,?,?)', (artist_id, normalized, display))
        else:
            conn.execute('''INSERT INTO artists(id, normalized_name, name) VALUES (?, ?, ?)
                            ON CONFLICT(id) DO UPDATE SET name=excluded.name
                            WHERE excluded.name < artists.name''', (artist_id, normalized, display))



def _set_links(conn, entity_type, entity_id, names):
    _, table, column, key = _entity(entity_type, entity_id)
    desired = [artist_id_for_name(name) for name in names]
    current = [r[0] for r in conn.execute(
        f'SELECT artist_id FROM {table} WHERE {column}=? ORDER BY position', (key,))]
    if current == desired:
        return
    conn.execute(f'DELETE FROM {table} WHERE {column}=?', (key,))
    conn.executemany(f'INSERT INTO {table}({column},artist_id,position) VALUES (?,?,?)',
                     [(key, artist_id, position) for position, artist_id in enumerate(desired)])


def _state_row(conn, entity_type, key):
    return conn.execute('SELECT * FROM artist_credit_state WHERE entity_type=? AND entity_id=?',
                        (entity_type, key)).fetchone()


def get_credit_states(entity_type: EntityType, entity_ids: Sequence[str | int], *, conn=None) -> dict[str, CreditState]:
    table, links, column, _ = _entity(entity_type, 0)
    ids = list(dict.fromkeys(_entity(entity_type, entity_id)[3] for entity_id in entity_ids))
    if not ids:
        return {}
    own = conn is None
    conn = get_connection() if own else conn
    try:
        result = {}
        for offset in range(0, len(ids), BATCH_SIZE):
            chunk = ids[offset:offset+BATCH_SIZE]
            bind = ','.join('?' for _ in chunk)
            for row in conn.execute(f'''SELECT e.id,s.revision,s.manual_names_json,s.source_kind,s.source_names_json
                    FROM {table} e LEFT JOIN artist_credit_state s
                      ON s.entity_type=? AND s.entity_id=CAST(e.id AS TEXT)
                    WHERE e.id IN ({bind})''', (entity_type, *chunk)):
                result[str(row['id'])] = {
                    'artists': [], 'revision': row['revision'] or 0,
                    'manual': row['manual_names_json'] is not None,
                    'source_kind': row['source_kind'] or 'unknown',
                    'source_names': json.loads(row['source_names_json'] or '[]'),
                }
            for row in conn.execute(f'''SELECT l.{column} AS entity_id,a.id,a.name
                    FROM {links} l JOIN artists a ON a.id=l.artist_id
                    WHERE l.{column} IN ({bind}) ORDER BY l.{column},l.position''', chunk):
                key = str(row['entity_id'])
                if key in result:
                    result[key]['artists'].append({'id': row['id'], 'name': row['name']})
        return result
    finally:
        if own:
            conn.close()


def _require_entity(conn, entity_type, entity_id):
    table, _, _, key = _entity(entity_type, entity_id)
    if conn.execute(f'SELECT id FROM {table} WHERE id=?', (key,)).fetchone() is None:
        raise CreditNotFound(entity_type, entity_id)
    return key


def _selectors(conn, selectors):
    if not isinstance(selectors, (list, tuple)) or len(selectors) > MAX_ARTISTS:
        raise CreditValidationError('invalid_artists', 'Provide at most 100 artist items')
    names = []
    for selector in selectors:
        if not isinstance(selector, dict) or set(selector) not in ({'id'}, {'name'}):
            raise CreditValidationError('invalid_artists', 'Each artist needs exactly id or name')
        if 'id' in selector:
            if not isinstance(selector['id'], str):
                raise CreditValidationError('invalid_artists', 'Artist id must be a string')
            row = conn.execute('SELECT normalized_name FROM artists WHERE id=?', (selector['id'],)).fetchone()
            if row is None:
                raise CreditValidationError('unknown_artist', 'Unknown artist id')
            name = row[0]
        else:
            if not isinstance(selector['name'], str):
                raise CreditValidationError('invalid_artists', 'Artist name must be a string')
            name = normalize_artist_name(selector['name'])
            if not artist_id_for_name(name) or len(name) > MAX_NAME_LENGTH:
                raise CreditValidationError('invalid_artists', 'Artist name must contain 1 to 300 characters and not be reserved')
        if name not in names:
            names.append(name)
    return names


def replace_artist_credits(conn, entity_type, entity_id, artists, *, expected_revision):
    key = _require_entity(conn, entity_type, entity_id)
    if isinstance(expected_revision, bool) or not isinstance(expected_revision, int) or expected_revision < 0:
        raise CreditValidationError('invalid_artists', 'Expected revision must be a nonnegative integer')
    names = _selectors(conn, artists)
    current = get_credit_states(entity_type, [key], conn=conn)[key]
    row = _state_row(conn, entity_type, key)
    same_manual = row is not None and row['manual_names_json'] is not None and json.loads(row['manual_names_json']) == names
    if current['revision'] != expected_revision:
        if same_manual:
            return current
        raise CreditConflict(current)
    if same_manual:
        return current
    if row is None:
        ingest_artist_credits(conn, entity_type, key, None)
    _register(conn, names)
    _set_links(conn, entity_type, key, names)
    conn.execute('''UPDATE artist_credit_state SET manual_names_json=?, revision=revision+1
                    WHERE entity_type=? AND entity_id=?''', (_dumps(names), entity_type, key))
    return get_credit_states(entity_type, [key], conn=conn)[key]


def ingest_artist_credits(conn, entity_type, entity_id, source):
    key = _require_entity(conn, entity_type, entity_id)
    row = _state_row(conn, entity_type, key)
    if row is None:
        album = conn.execute('SELECT album_id FROM tracks WHERE id=?', (key,)).fetchone() if entity_type == 'track' else None
        conn.execute('''INSERT INTO artist_credit_state(entity_type,entity_id,revision,recovery_album_id)
                        VALUES (?,?,1,?)''', (entity_type, key, album[0] if album else None))
        row = _state_row(conn, entity_type, key)
        created = True
    else:
        created = False
    accepted_names = json.loads(row['source_names_json'])
    accepted_kind = row['source_kind']
    if source is not None:
        if not isinstance(source, CreditSource):
            raise CreditValidationError('invalid_artists', 'Expected CreditSource')
        if len(source.names) > MAX_ARTISTS:
            logger.warning('Invalid artist observation: too many credits entity_type=%s entity_id=%s count=%s', entity_type, key, len(source.names))
        else:
            names = _canonical_names(source.names)
            conn.execute('''UPDATE artist_credit_state SET observed_kind=?,observed_names_json=?
                            WHERE entity_type=? AND entity_id=?''', (source.kind, _dumps(names), entity_type, key))
            _register(conn, names, display_values=source.names)
            if SOURCE_RANKS[source.kind] >= SOURCE_RANKS[accepted_kind]:
                changed = source.kind != accepted_kind or names != accepted_names
                accepted_kind, accepted_names = source.kind, names
                if changed:
                    conn.execute('''UPDATE artist_credit_state SET source_kind=?,source_names_json=?,revision=revision+?
                                    WHERE entity_type=? AND entity_id=?''',
                                 (accepted_kind, _dumps(accepted_names), 0 if created else 1, entity_type, key))
    manual = row['manual_names_json']
    effective = json.loads(manual) if manual is not None else accepted_names
    _register(conn, effective)
    _set_links(conn, entity_type, key, effective)
    return get_credit_states(entity_type, [key], conn=conn)[key]


def legacy_artist_source(value):
    """A missing scalar is not an authoritative source clear."""
    return CreditSource('legacy', [value]) if normalize_artist_name(value) else None


def audio_artist_source(meta, *, album=False):
    values = getattr(meta, 'album_artists' if album else 'artists', None)
    return CreditSource('tags', values) if values is not None else legacy_artist_source(
        getattr(meta, 'album_artist' if album else 'artist', None))


def backfill_artist_credits(conn):
    for entity_type, table, source_column in [('track', 'tracks', 'artist'), ('album', 'albums', 'album_artist')]:
        for row in conn.execute(f'''SELECT e.id,e.{source_column} AS source FROM {table} e
                WHERE NOT EXISTS (SELECT 1 FROM artist_credit_state s
                    WHERE s.entity_type=? AND s.entity_id=CAST(e.id AS TEXT))''', (entity_type,)).fetchall():
            ingest_artist_credits(conn, entity_type, row['id'], CreditSource('legacy', [row['source']] if row['source'] is not None else []))


def merge_album_credits(conn, source_album_id, target_album_id):
    if source_album_id == target_album_id:
        return
    source_key = _require_entity(conn, 'album', source_album_id)
    target_key = _require_entity(conn, 'album', target_album_id)
    for key in (source_key, target_key):
        if _state_row(conn, 'album', key) is None:
            raw = conn.execute('SELECT album_artist FROM albums WHERE id=?', (key,)).fetchone()[0]
            ingest_artist_credits(conn, 'album', key, legacy_artist_source(raw))
    source, target = _state_row(conn, 'album', source_key), _state_row(conn, 'album', target_key)
    sm, tm = source['manual_names_json'], target['manual_names_json']
    if sm is not None and tm is not None and json.loads(sm) != json.loads(tm):
        raise AlbumCreditsConflict(source_album_id, target_album_id)
    chosen_source = source if SOURCE_RANKS[source['source_kind']] > SOURCE_RANKS[target['source_kind']] else target
    manual = tm if tm is not None else sm
    source_names = chosen_source['source_names_json']
    changed = (manual != tm or chosen_source['source_kind'] != target['source_kind'] or source_names != target['source_names_json'])
    if changed:
        conn.execute('''UPDATE artist_credit_state SET manual_names_json=?,source_kind=?,source_names_json=?,
                        observed_kind=?,observed_names_json=?,revision=revision+1 WHERE entity_type='album' AND entity_id=?''',
                     (manual, chosen_source['source_kind'], source_names, chosen_source['observed_kind'], chosen_source['observed_names_json'], target_key))
    names = json.loads(manual if manual is not None else source_names)
    _register(conn, names)
    _set_links(conn, 'album', target_key, names)
    forget_artist_credits(conn, 'album', source_key)


def forget_artist_credits(conn, entity_type, entity_id):
    _, links, column, key = _entity(entity_type, entity_id)
    conn.execute(f'DELETE FROM {links} WHERE {column}=?', (key,))
    conn.execute('DELETE FROM artist_credit_state WHERE entity_type=? AND entity_id=?', (entity_type, key))


def _fields(state, *, album=False):
    artists = state['artists']
    display = ', '.join(a['name'] for a in artists)
    result = {'artists': artists, 'artists_revision': state['revision'],
              'artist': display or ('Various Artists' if album else ''),
              'artist_id': artists[0]['id'] if len(artists) == 1 else None}
    if album:
        result['album_artist'] = display
    return result


def hydrate_album_credits(rows, *, conn=None):
    rows = [dict(row) for row in rows]
    states = get_credit_states('album', [row['id'] for row in rows], conn=conn)
    for row in rows:
        row.setdefault('_source_album_artist', row.get('album_artist'))
        state = states.get(str(row['id']))
        if state is not None:
            row.update(_fields(state, album=True))
    return rows


def hydrate_track_credits(rows, *, conn=None):
    rows = [dict(row) for row in rows]
    own = conn is None
    conn = get_connection() if own else conn
    try:
        states = get_credit_states('track', [row.get('id') or row['track_id'] for row in rows], conn=conn)
        albums = get_credit_states('album', [row['album_id'] for row in rows if row.get('album_id') is not None], conn=conn)
        for row in rows:
            row.setdefault('_source_artist', row.get('artist'))
            row.setdefault('_source_album_artist', row.get('album_artist'))
            state = states.get(str(row.get('id') or row['track_id']))
            if state is not None:
                row.update(_fields(state))
            album = albums.get(str(row.get('album_id')))
            row['album_artists'] = album['artists'] if album else []
            row['album_artists_revision'] = album['revision'] if album else 0
            row['album_artist'] = ', '.join(a['name'] for a in row['album_artists'])
        return rows
    finally:
        if own:
            conn.close()


def get_recovery_album(track_id: str, *, conn=None) -> dict | None:
    """Read the surviving album identity recorded for a track, without recovery writes."""
    own = conn is None
    conn = get_connection() if own else conn
    try:
        row = conn.execute("""SELECT a.* FROM artist_credit_state s
            JOIN albums a ON a.id = s.recovery_album_id
            WHERE s.entity_type = 'track' AND s.entity_id = ?""", (str(track_id),)).fetchone()
        return dict(row) if row is not None else None
    finally:
        if own:
            conn.close()
