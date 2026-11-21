"""Publish verified Telegram import artifacts using the catalog's identities."""
from contextlib import closing
import json
from pathlib import Path
import shutil
import tempfile
import uuid

import db
from metadata import clean_cover_bytes, read_audio_metadata
from repositories import delivery
from repositories.artist_credits import CreditSource
from repositories.base import bump_catalog_version, get_connection
from repositories.share_entities import claim_track_identity
from services.media_locations import resolve_import_album


def prepare_playlist(owner_id, source, title):
    with closing(get_connection()) as conn, conn:
        conn.execute('BEGIN IMMEDIATE')
        current = conn.execute('SELECT playlist_id FROM telegram_playlist_imports WHERE user_id=? AND source=?',
                               (owner_id, source)).fetchone()
        if current:
            return current[0], False
        playlist_id = conn.execute('INSERT INTO playlists(name,user_id,is_public) VALUES (?,?,0)',
                                   (title[:100], owner_id)).lastrowid
        conn.execute('INSERT INTO telegram_playlist_imports VALUES (?,?,?)', (owner_id, source, playlist_id))
        return playlist_id, True


def cancel_playlist(owner_id, playlist_id):
    with closing(get_connection()) as conn, conn:
        conn.execute('DELETE FROM playlists WHERE id=? AND user_id=?', (playlist_id, owner_id))


def save_result(owner_id, kind, result_id):
    if kind == 'album':
        with closing(get_connection()) as conn, conn:
            conn.execute('INSERT OR IGNORE INTO user_saved_albums(user_id,album_id) VALUES (?,?)',
                         (owner_id, int(result_id)))
    elif kind == 'track':
        db.add_favorite(owner_id, result_id, provenance='import')
    elif kind == 'playlist':
        with closing(get_connection()) as conn, conn:
            conn.execute("""INSERT OR IGNORE INTO user_saved_playlists(user_id,playlist_id)
                SELECT user_id,id FROM playlists WHERE user_id=? AND id=?""", (owner_id, int(result_id)))


def is_saved(owner_id, kind, result_id):
    if kind == 'track':
        return result_id in db.get_favorite_track_ids(owner_id)
    if kind == 'album':
        return int(result_id) in saved_album_ids(owner_id)
    if kind == 'playlist':
        with closing(get_connection()) as conn:
            return conn.execute('SELECT 1 FROM user_saved_playlists WHERE user_id=? AND playlist_id=?',
                                (owner_id, int(result_id))).fetchone() is not None
    return False


def saved_album_ids(owner_id):
    with closing(get_connection()) as conn:
        return {row[0] for row in conn.execute('SELECT album_id FROM user_saved_albums WHERE user_id=?',
                                             (owner_id,))}


def album_cover(album_id):
    with closing(get_connection()) as conn:
        row = conn.execute('SELECT image,mime FROM telegram_album_covers WHERE album_id=?', (album_id,)).fetchone()
        return tuple(row) if row else (None, None)


def track_cover(track_id):
    with closing(get_connection()) as conn:
        row = conn.execute('SELECT image,mime FROM telegram_track_covers WHERE track_id=?',
                           (track_id,)).fetchone()
        return tuple(row) if row else (None, None)


def store_track_cover(conn, track_id, image, mime):
    changed = conn.execute("""INSERT INTO telegram_track_covers VALUES (?,?,?)
        ON CONFLICT(track_id) DO UPDATE SET image=excluded.image,mime=excluded.mime
        WHERE image<>excluded.image OR mime<>excluded.mime""", (track_id, image, mime)).rowcount
    if changed:
        conn.execute('UPDATE tracks SET cover_version=COALESCE(cover_version,0)+1,cover_color=NULL WHERE id=?',
                     (track_id,))
        bump_catalog_version(conn)


def find_release_flac(source, music_dir):
    from repositories.albums import normalize_text

    song = source.get('song') or {}
    if not song.get('album_name') or not song.get('preview_url'):
        return None
    with closing(get_connection()) as conn:
        rows = conn.execute("""SELECT t.id,t.file_path,t.title FROM tracks t JOIN albums a ON a.id=t.album_id
            WHERE a.title_normalized=? AND a.album_artist_normalized=?
            AND (t.album_track_position=? OR t.track_number=?)
            AND lower(t.file_path) LIKE '%.flac'""",
                            (normalize_text(song['album_name']), normalize_text(song['album_artist']),
                             song['track_number'], str(song['track_number']))).fetchall()
    normalized = normalize_text(song['name'])
    matches = [row for row in rows if normalize_text(row['title']) == normalized]
    if len(matches) != 1:
        return None
    row = matches[0]
    root = Path(music_dir).resolve()
    path = (root / row['file_path']).resolve()
    if path.is_relative_to(root) and path.is_file():
        return {'id': row['id'], 'path': str(path), 'mtime': path.stat().st_mtime_ns}
    return None


def _copy_artifact(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.incoming-', delete=False) as output:
        path = Path(output.name)
        try:
            with source.open('rb') as audio:
                shutil.copyfileobj(audio, output, 1024 * 1024)
            output.close()
            path.replace(target)
        finally:
            path.unlink(missing_ok=True)


def publish(owner_id, source, artifact, music_dir, *, position, playlist_id=None, album=False):
    audio = Path(artifact['path'])
    checksum = artifact['sha256']
    source_key = source.get('key') or f'file:{checksum}'
    song = source.get('song') or {}
    root = Path(music_dir).resolve()
    metadata = read_audio_metadata(str(audio))
    imported_cover = None
    if artifact.get('cover') and not metadata.has_cover and not source.get('cover'):
        try:
            imported_cover = clean_cover_bytes(Path(artifact['cover']).read_bytes())
        except (OSError, ValueError):
            pass
    if metadata.duration <= 0:
        raise ValueError('Аудиодорожка повреждена')
    metadata.title = song.get('name') or artifact.get('title') or source.get('title') or metadata.title
    metadata.artist = song.get('artist') or source.get('artist') or artifact.get('artist') or metadata.artist
    metadata.album = source.get('album') or song.get('album_name') or metadata.album or artifact.get('album') or ''
    metadata.album_artist = source.get('album_artist') or song.get('album_artist') or metadata.album_artist
    metadata.year = metadata.year or source.get('year') or (song.get('date') or '')[:4] or None
    metadata.genre = metadata.genre or song.get('genre')
    metadata.genre = metadata.genre or (source.get('enrichment') or {}).get('genre')
    metadata.lyrics = metadata.lyrics or artifact.get('lyrics')
    if source.get('disc'):
        metadata.disc_number = str(source['disc'])
    if source.get('track') or song.get('track_number'):
        metadata.track_number = str(source.get('track') or song['track_number'])
    for field in ('title', 'artist', 'album', 'album_artist', 'year', 'genre', 'disc_number', 'track_number'):
        if value := source.get('metadata', {}).get(field):
            setattr(metadata, field, value)
    album_artist = metadata.album_artist or ('' if album else metadata.artist)
    artist_source = CreditSource('provider', song['artists']) if song.get('artists') else None
    with closing(get_connection()) as conn, conn:
        conn.execute('BEGIN IMMEDIATE')
        prior = conn.execute("""SELECT i.sha256,t.id,t.file_path,t.album_id FROM telegram_track_imports i
            JOIN tracks t ON t.id=i.track_id WHERE i.source=?""", (source_key,)).fetchone()
        if prior is None:
            prior = conn.execute("""SELECT i.sha256,t.id,t.file_path,t.album_id FROM telegram_track_imports i
                JOIN tracks t ON t.id=i.track_id WHERE i.sha256=? ORDER BY t.id LIMIT 1""", (checksum,)).fetchone()
        if prior is None and (reuse := artifact.get('reuse')):
            existing = conn.execute('SELECT id,file_path,album_id FROM tracks WHERE id=?',
                                    (reuse['id'],)).fetchone()
            if (not existing or (root / existing['file_path']).resolve() != audio
                    or audio.stat().st_mtime_ns != reuse['mtime']):
                raise ValueError('Локальный FLAC изменился после сверки')
            prior = {**dict(existing), 'sha256': checksum}
        if prior and prior['sha256'] == checksum and (root / prior['file_path']).is_file():
            track_id, rel_path = prior['id'], prior['file_path']
            target = root / rel_path
            album_id = prior['album_id']
        else:
            expected_album = resolve_import_album(prior['id'] if prior else '', metadata.album,
                                                  album_artist, year=metadata.year, conn=conn)
            if prior is None and album and song and expected_album:
                same = conn.execute("""SELECT t.id,t.file_path,t.album_id FROM tracks t
                    WHERE t.album_id=? AND t.title=? COLLATE NOCASE AND t.artist=? COLLATE NOCASE
                    AND (t.album_track_position=? OR
                        (t.album_track_position IS NULL AND CAST(t.track_number AS INTEGER)=?
                         AND COALESCE(CAST(t.disc_number AS INTEGER),1)=1))""",
                                    (expected_album, metadata.title, metadata.artist, position, position)).fetchall()
                if len(same) == 1 and Path(same[0]['file_path']).suffix.lower() != '.flac':
                    prior = same[0]
            rel_path = f'telegram/{checksum[:2]}/{checksum}{audio.suffix.lower()}'
            target = (root / rel_path).resolve()
            if not target.is_relative_to(root):
                raise ValueError('Недопустимый путь публикации')
            if prior:
                track_id = prior['id']
                if prior['file_path'] != rel_path:
                    delivery.reserve_retirement(conn, track_id, unmanaged=True)
                    conn.execute('INSERT OR REPLACE INTO retired_import_paths VALUES (?,?)',
                                 (prior['file_path'], track_id))
                conn.execute('DELETE FROM retired_import_paths WHERE rel_path=? AND track_id=?',
                             (rel_path, track_id))
                conn.execute('UPDATE track_path_claims SET rel_path=? WHERE track_id=?', (rel_path, track_id))
            else:
                track_id = claim_track_identity(conn, rel_path, 'import', str(uuid.uuid4()))
            if not track_id:
                raise ValueError('Не удалось выделить запись каталога')
            if not target.is_file():
                _copy_artifact(audio, target)
            album_id = expected_album
        # A user file may already have been published with another placement.
        # Preserve that placement for plain playlist uses and standalone downloads.
        if not prior or album or source['type'] == 'file' or 'sha256' not in prior.keys() or prior['sha256'] != checksum:
            file_stat = target.stat()
            metadata.file_size, metadata.file_mtime_ns = file_stat.st_size, file_stat.st_mtime_ns
            existing = db.get_track(track_id, conn=conn) if prior else None
            if existing:
                for field in ('genre', 'lyrics', 'comment', 'album_artist', 'year', 'disc_number', 'track_number'):
                    if not getattr(metadata, field):
                        setattr(metadata, field, existing[field])
            db.add_or_update_track(track_id, rel_path, metadata.title, album_id, metadata.artist,
                                   lyrics=metadata.lyrics, added_by_user_id=owner_id, duration=metadata.duration,
                                   artist_source=artist_source, conn=conn)
            db.update_track_metadata_from_audio(track_id, metadata, album_id=album_id,
                                                preserve_empty_genre=True, cover_version_inc=True,
                                                album_track_position=position if album else None,
                                                artist_source=artist_source, conn=conn)
            replaced = bool(prior and prior['file_path'] != rel_path)
            if replaced:
                conn.execute("""UPDATE tracks SET loudness_status='pending',normalization_gain_db=NULL,
                    loudness_lufs=NULL,true_peak_db=NULL,loudness_error=NULL,loudness_retry_count=0,
                    auto_genres=NULL,auto_genre_status=NULL,auto_genre_sync_pending=0 WHERE id=?""", (track_id,))
            if not existing or replaced:
                revision = f'{file_stat.st_size}:{file_stat.st_mtime_ns}'
                conn.execute("""INSERT INTO telegram_import_analysis VALUES (?,?,?)
                    ON CONFLICT(track_id) DO UPDATE SET revision=excluded.revision,
                    refresh=MAX(telegram_import_analysis.refresh,excluded.refresh)""",
                             (track_id, revision, int(replaced)))
        evidence = {**(artifact.get('evidence') or {})}
        if song.get('preview_url') and evidence.get('audio_match'):
            evidence['reference'] = {'preview_url': song['preview_url'], 'duration': song['duration']}
            conn.execute('UPDATE tracks SET audio_review_blocked=0 WHERE id=?', (track_id,))
        conn.execute("""INSERT INTO telegram_track_imports(source,track_id,sha256,evidence) VALUES (?,?,?,?)
            ON CONFLICT(source) DO UPDATE SET track_id=excluded.track_id,sha256=excluded.sha256,
            evidence=excluded.evidence""",
                     (source_key, track_id, checksum, json.dumps(evidence, ensure_ascii=False)))
        if imported_cover:
            store_track_cover(conn, track_id, *imported_cover)
        if album_id and source.get('cover'):
            try:
                cover, mime = clean_cover_bytes(Path(source['cover']).read_bytes())
            except (OSError, ValueError):
                pass
            else:
                conn.execute('INSERT OR REPLACE INTO telegram_album_covers VALUES (?,?,?)', (album_id, cover, mime))
        if playlist_id is not None:
            slot = str(source.get('slot') or position)
            conn.execute("""UPDATE telegram_playlist_positions SET track_id=? WHERE playlist_id=? AND slot=?""",
                         (track_id, playlist_id, slot))
            conn.execute("""INSERT OR IGNORE INTO playlist_tracks(playlist_id,track_id,position,import_slot)
                SELECT playlist_id,track_id,display_position,slot FROM telegram_playlist_positions
                WHERE playlist_id=? AND slot=? AND removed=0""", (playlist_id, slot))
        return track_id, album_id
