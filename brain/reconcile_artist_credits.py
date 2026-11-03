"""Read-only candidate report for reviewing existing artist credits.

Punctuation is evidence for review, never evidence that a name should be split.
"""
import argparse
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

from config import DB_PATH


def report(path=DB_PATH):
    uri = Path(path).resolve().as_uri() + '?mode=ro'
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    proposals = []
    try:
        for kind, table, links, column in (('track', 'tracks', 'track_artists', 'track_id'),
                                            ('album', 'albums', 'album_artists', 'album_id')):
            rows = conn.execute(f'''SELECT e.id, s.revision, s.source_kind, s.source_names_json,
                        a.id AS artist_id, a.name
                    FROM {table} e JOIN artist_credit_state s
                      ON s.entity_type=? AND s.entity_id=CAST(e.id AS TEXT)
                    JOIN {links} l ON l.{column}=e.id
                    JOIN artists a ON a.id=l.artist_id
                    ORDER BY e.id,l.position''', (kind,)).fetchall()
            groups = {}
            for row in rows:
                groups.setdefault(str(row['id']), []).append(row)
            for entity_id, group in groups.items():
                before = [{'id': row['artist_id'], 'name': row['name']} for row in group]
                suspicious = [item['name'] for item in before if any(c in item['name'] for c in '/&,;')]
                if not suspicious:
                    continue
                proposal = {
                    'entity_type': kind, 'entity_id': entity_id,
                    'expected_revision': group[0]['revision'], 'before': before, 'after': before,
                    'source_kind': group[0]['source_kind'],
                    'source_names': json.loads(group[0]['source_names_json']),
                    'reason': 'Punctuation requires manual review; no split inferred',
                    'evidence': 'Current registered artist name contains punctuation: ' + ', '.join(suspicious),
                    'ambiguity': 'ambiguous'}
                proposal['id'] = hashlib.sha256(json.dumps(proposal, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
                proposals.append(proposal)
    finally:
        conn.close()
    return {'version': 1, 'proposals': proposals, 'unresolved': [p['id'] for p in proposals]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command')
    report_parser = sub.add_parser('report')
    report_parser.add_argument('--json', metavar='PATH')
    preview = sub.add_parser('preview')
    preview.add_argument('--report', required=True)
    preview.add_argument('--select', required=True)
    for name in ('preview', 'apply', 'undo'):
        command = preview if name == 'preview' else sub.add_parser(name)
        command.add_argument('--actor-user-id', required=True, type=int)
        if name != 'preview':
            command.add_argument('--operation-id', required=True)
    args = parser.parse_args(argv)
    try:
        if args.command in ('preview', 'apply', 'undo'):
            from repositories.base import get_connection
            from services import artist_credit_bulk_service as bulk
            conn = get_connection()
            try:
                actor = conn.execute('SELECT id,role FROM users WHERE id=?', (args.actor_user_id,)).fetchone()
                actor = dict(actor) if actor else None
            finally:
                conn.close()
            if args.command == 'preview':
                data = json.loads(Path(args.report).read_text(encoding='utf-8'))
                result = bulk.preview_artist_report(data, args.select.split(','), actor)
            elif args.command == 'apply':
                result = bulk.apply_artist_replacement(None, args.operation_id, actor)
            else:
                result = bulk.undo_artist_replacement(None, args.operation_id, actor)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        result = report()
        if args.command == 'report' and args.json:
            Path(args.json).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        else:
            print(f"Review candidates: {len(result['proposals'])}")
            for item in result['proposals']:
                print(f"{item['entity_type']} {item['entity_id']}: {', '.join(a['name'] for a in item['before'])} (ambiguous)")
        return 0
    except Exception as exc:
        from fastapi import HTTPException
        if isinstance(exc, HTTPException):
            print(json.dumps(exc.detail, ensure_ascii=False), file=sys.stderr)
            return 3 if exc.status_code == 409 else (1 if exc.status_code >= 500 else 2)

        print(f'report failed: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
