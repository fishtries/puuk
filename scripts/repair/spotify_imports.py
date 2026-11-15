"""Repair incident MP3 tags from a spotdl save manifest, without downloading audio.

Dry-run by default. Only files listed in the incident journal and identified by
an exact Spotify WOAS track URL are eligible. Back up originals and SQLite before
--apply. Run with the bot venv; --repo points to the deployed Puuk checkout.
"""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--incident', type=Path, required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--backup', type=Path, required=True)
    parser.add_argument('--music', type=Path, default=Path('/mnt/data/projects/puuk/music'))
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    sys.path.insert(0, str(args.repo / 'tg_music_bot'))
    sys.path.insert(0, str(args.repo / 'brain'))
    from mutagen.id3 import ID3
    from audio_tags import read_audio_tags, write_audio_metadata, fetch_cover
    from downloader import _format_number

    songs = json.loads(args.source.read_text())
    by_url = {}
    for song in songs:
        url = song.get('url', '').split('?')[0]
        if url:
            by_url.setdefault(url, []).append(song)
    paths = set()
    for line in args.incident.read_text().splitlines():
        match = re.search(r'changed_files=(\[.*?\]) tracks=', line)
        if match:
            paths.update(ast.literal_eval(match[1]))
    plan, skipped = [], []
    for name in sorted(paths):
        path = Path(name)
        if path.parent.resolve() != args.music.resolve() or path.suffix != '.mp3' or not path.is_file():
            skipped.append({'file': name, 'reason': 'outside root, absent, or unsupported'})
            continue
        tags = ID3(path)
        url = str(tags.get('WOAS', '')).split('?')[0]
        candidates = [s for s in by_url.get(url, [])
                      if s.get('name') and s.get('artists') and s.get('album_name') and s.get('album_artist')]
        identities = {(s.get('name'), tuple(s.get('artists', [])), s.get('album_name')) for s in candidates}
        if len(identities) != 1:
            skipped.append({'file': name, 'url': url, 'reason': 'no unambiguous provider identity'})
            continue
        song = candidates[0]
        before = read_audio_tags(str(path)).as_metadata()
        plan.append({'file': name, 'song': song, 'before': before})
    args.backup.mkdir(parents=True, exist_ok=True)
    (args.backup / 'plan.json').write_text(json.dumps({'matched': plan, 'skipped': skipped}, ensure_ascii=False, indent=2))
    print(json.dumps({'matched': len(plan), 'skipped': len(skipped), 'missing_covers': sum(not p['before']['has_cover'] for p in plan)}), flush=True)
    if not args.apply:
        return

    import db
    from metadata import read_audio_metadata
    from repositories.artist_credits import CreditSource
    from services.media_locations import resolve_import_album
    backup_db = args.backup / 'before.db'
    if not backup_db.exists():
        connection = db.get_connection()
        with sqlite3.connect(backup_db) as target:
            connection.backup(target)
        connection.close()
    originals = args.backup / 'audio'
    originals.mkdir(exist_ok=True)
    covers = {}
    report = []
    for item in plan:
        path, song = Path(item['file']), item['song']
        backup = originals / path.name
        if not backup.exists():
            shutil.copy2(path, backup)
        url = song.get('cover_url')
        if url not in covers:
            covers[url] = fetch_cover(url) if url else None
        cover = covers[url]
        # Edit a copy and publish atomically, keeping the audio frames intact.
        fd, staged = tempfile.mkstemp(suffix='.mp3', dir=args.backup)
        os.close(fd)
        try:
            shutil.copy2(path, staged)
            write_audio_metadata(staged, title=song['name'], artist=', '.join(song['artists']),
                album=song.get('album_name'), album_artist=song.get('album_artist'),
                date=song.get('date'), track_number=_format_number(song.get('track_number'), song.get('tracks_count')),
                disc_number=(_format_number(song.get('disc_number'), song.get('disc_count'))
                             if song.get('disc_count') else item['before'].get('disc_number')),
                cover_bytes=cover[0] if cover else None, cover_mime=cover[1] if cover else 'image/jpeg', overwrite=True)
            # Verify decoded MPEG payload is byte identical before replacing the file.
            def audio_hash(filename):
                import mutagen.mp3
                offset = mutagen.mp3.MP3(filename).info.frame_offset
                with open(filename, 'rb') as stream:
                    stream.seek(offset)
                    return hashlib.file_digest(stream, 'sha256').hexdigest()
            if audio_hash(staged) != audio_hash(path):
                raise RuntimeError('Audio payload changed: ' + str(path))
            # backup may live on another filesystem: stage beside the music root.
            fd2, publish = tempfile.mkstemp(prefix='.puuk-repair-', dir=args.music.parent)
            os.close(fd2)
            try:
                shutil.copy2(staged, publish)
                os.replace(publish, path)
            finally:
                if os.path.exists(publish):
                    os.unlink(publish)
        finally:
            os.unlink(staged)
        meta = read_audio_metadata(str(path))
        conn = db.get_connection()
        row = conn.execute('SELECT id FROM tracks WHERE file_path = ?', (path.name,)).fetchone()
        conn.close()
        if row:
            artist_source = CreditSource('provider', song['artists'])
            album_artists = song.get('album_artists') or [song.get('album_artist')]
            album_source = CreditSource('provider', [a for a in album_artists if a])
            album_id = resolve_import_album(row['id'], meta.album, meta.album_artist, year=meta.year, artist_source=album_source)
            db.update_track_metadata_from_audio(row['id'], meta, album_id, cover_version_inc=bool(cover), preserve_empty_genre=True,
                artist_source=artist_source, album_artist_source=album_source)
        report.append({'file': str(path), 'cover': meta.has_cover, 'album': meta.album, 'indexed': bool(row), 'audio_unchanged': True})
        (args.backup / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report[-1], ensure_ascii=False), flush=True)
    print('DONE', len(report), flush=True)


if __name__ == '__main__':
    main()
