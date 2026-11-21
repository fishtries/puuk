"""Source occurrences, personal edits and confirmed refreshes of imported lists."""
from contextlib import closing
import hashlib
import json

from repositories.base import get_connection


def _snapshot(conn, playlist_id, owner_id):
    playlist = conn.execute("""SELECT p.id,p.name FROM playlists p
        JOIN telegram_playlist_imports i ON i.playlist_id=p.id
        WHERE p.id=? AND p.user_id=?""", (playlist_id, owner_id)).fetchone()
    if not playlist:
        raise ValueError('Приватная копия удалена')
    source = [dict(row) for row in conn.execute("""SELECT * FROM telegram_playlist_positions
        WHERE playlist_id=? ORDER BY source_rank""", (playlist_id,))]
    copy = [dict(row) for row in conn.execute("""SELECT pt.id,pt.import_slot,pt.position,t.title
        FROM playlist_tracks pt JOIN tracks t ON t.id=pt.track_id
        WHERE playlist_id=? ORDER BY position,pt.id""", (playlist_id,))]
    revision = hashlib.sha256(json.dumps([list(playlist), source, copy]).encode()).hexdigest()
    return source, copy, revision


def _copy_order(source, copy, incoming):
    retained = {row['slot']: row for row in source}
    visible = {row['import_slot']: row for row in copy if row['import_slot'] is not None}
    ordered = [(item['slot'], visible.get(item['slot']), item['title'])
               for item in incoming if not retained.get(item['slot'], {}).get('removed')]
    slots = {slot for slot, _, _ in ordered}
    anchors = {slot for slot in slots if slot in visible}
    groups = {}
    previous = None
    next_survivor = None
    upcoming = []
    for row in reversed(copy):
        upcoming.append(next_survivor)
        if row['import_slot'] in anchors:
            next_survivor = row['import_slot']
    for row, following in zip(copy, reversed(upcoming)):
        slot = row['import_slot']
        if slot in anchors:
            previous = slot
        if slot is None:
            key = ('after', previous) if previous else ('before', following)
            groups.setdefault(key, []).append((None, row, row['title']))
    result = []
    for entry in ordered:
        result.extend(groups.get(('before', entry[0]), []))
        result.append(entry)
        result.extend(groups.get(('after', entry[0]), []))
    result.extend(groups.get(('before', None), []))
    return result


def _preview(conn, owner_id, playlist_id, incoming):
    sources, copy, revision = _snapshot(conn, playlist_id, owner_id)
    order = _copy_order(sources, copy, incoming)
    original = [row['slot'] for row in sources]
    refreshed = [row['slot'] for row in incoming]
    if original == refreshed and [row['title'] for row in sources] == [row['title'] for row in incoming]:
        return revision, [], order
    old_positions = {row['id']: index for index, row in enumerate(copy, 1)}
    new_positions = {row['id']: index for index, (_, row, _) in enumerate(order, 1) if row}
    original_slots = set(original)
    lines = []
    for position, (slot, row, title) in enumerate(order, 1):
        if row and old_positions[row['id']] != position:
            lines.append(f"{title} · с {old_positions[row['id']]} на {position}")
        elif not row and slot not in original_slots:
            lines.append(f'{title} · появится на {position}-м месте')
    for row in copy:
        if row['id'] not in new_positions:
            lines.append(f"{row['title']} · уйдёт с {old_positions[row['id']]}-го места")
    for row in sources:
        if row['removed'] and row['slot'] in refreshed:
            lines.append(f"{row['title']} · личное удаление сохранится")
    lines = lines or ['Изменились данные источника.']
    return revision, lines, order


def playlist_preview(owner_id, playlist_id, incoming):
    with closing(get_connection()) as conn, conn:
        conn.execute('BEGIN')
        revision, lines, _ = _preview(conn, owner_id, playlist_id, incoming)
        return revision, lines


def apply_playlist(owner_id, playlist_id, incoming, revision=None):
    with closing(get_connection()) as conn, conn:
        conn.execute('BEGIN IMMEDIATE')
        known, copy, current = _snapshot(conn, playlist_id, owner_id)
        if revision is not None and current != revision:
            return False
        order = _copy_order(known, copy, incoming)
        positions = {slot: index for index, (slot, _, _) in enumerate(order, 1) if slot is not None}
        old_slots = {row['slot']: row for row in known}
        new_slots = {row['slot'] for row in incoming}
        for slot in old_slots.keys() - new_slots:
            conn.execute('DELETE FROM playlist_tracks WHERE playlist_id=? AND import_slot=?', (playlist_id, slot))
            conn.execute('DELETE FROM telegram_playlist_positions WHERE playlist_id=? AND slot=?', (playlist_id, slot))
        for index, (slot, row, _) in enumerate(order, 1):
            if row:
                conn.execute('UPDATE playlist_tracks SET position=? WHERE id=?', (index, row['id']))
        for index, item in enumerate(incoming, 1):
            slot = item['slot']
            conn.execute("""INSERT INTO telegram_playlist_positions
                (playlist_id,slot,source_rank,display_position,title) VALUES (?,?,?,?,?)
                ON CONFLICT(playlist_id,slot) DO UPDATE SET source_rank=excluded.source_rank,
                display_position=excluded.display_position,title=excluded.title""",
                         (playlist_id, slot, index, positions.get(slot, index), item['title']))
        return True


def retained_tracks(owner_id, playlist_id):
    with closing(get_connection()) as conn:
        positions, _, _ = _snapshot(conn, playlist_id, owner_id)
        return {row['slot']: (row['track_id'], bool(row['removed'])) for row in positions}
