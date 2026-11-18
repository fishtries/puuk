"""Physical media location resolution: SQLite -> Qdrant fallback for track files."""
import os
import uuid
from typing import Optional

import db
from config import get_effective_music_dir, COLLECTION_NAME
from services.recommendation_service import client


def _qdrant_point_id(track_id):
    """Return an ID accepted by Qdrant, or None for SQLite-only identifiers."""
    value = str(track_id).strip()
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError):
        if len(value) <= 20 and value.isascii() and value.isdecimal():
            number = int(value)
            if number <= 2**64 - 1:
                return number
        return None


def resolve_safe_music_file(path: Optional[str], music_dir: Optional[str] = None) -> Optional[str]:
    """
    Разрешает путь к файлу (абсолютный или относительный) и строго проверяет,
    что он находится внутри музыкальной директории (без Path Traversal) и существует на диске.
    Возвращает канонический абсолютный путь или None.
    """
    if not path or not isinstance(path, str) or not path.strip():
        return None
    base_dir = music_dir or get_effective_music_dir()
    try:
        root = os.path.realpath(base_dir)
        target = os.path.realpath(path if os.path.isabs(path) else os.path.join(root, path.lstrip("/")))
        if os.path.commonpath((root, target)) == root and os.path.isfile(target):
            return target
    except Exception:
        return None
    return None


def resolve_existing_file_path(file_path_value: Optional[str]) -> Optional[str]:
    """
    Разрешает абсолютный путь аудиофайла из записи БД или имени файла.
    Гарантирует, что путь валиден на диске и не выходит за пределы MUSIC_DIR.
    """
    if not file_path_value:
        return None
    cand = resolve_safe_music_file(file_path_value)
    if cand:
        return cand
    cand_base = resolve_safe_music_file(os.path.basename(file_path_value))
    if cand_base:
        return cand_base
    return None


def locate_track_file(track_id: str, fallback_to_qdrant: bool = True) -> Optional[str]:
    """
    Быстрый поиск пути файла по track_id: сначала SQLite, затем (опционально) payload Qdrant.
    Возвращает None, если файл нигде не найден или выходит за пределы MUSIC_DIR.
    """
    file_path = None
    db_track = db.get_track(track_id)
    if db_track and db_track.get("file_path"):
        file_path = resolve_existing_file_path(db_track["file_path"])

    point_id = _qdrant_point_id(track_id) if track_id is not None else None
    if not file_path and fallback_to_qdrant and point_id is not None:
        try:
            records = client.retrieve(
                collection_name=COLLECTION_NAME,
                ids=[point_id],
                with_payload=True,
            )
            if records and records[0].payload:
                file_path = resolve_existing_file_path(records[0].payload.get("file_path", ""))
        except Exception as e:
            print(f"[locate_track_file] Qdrant retrieve error for track {track_id}: {e}")

    return file_path


def _resolve_music_file_candidates(cand_path: Optional[str]) -> Optional[str]:
    """Один путь -> три кандидата (abs, rel, basename), все строго внутри MUSIC_DIR."""
    if not cand_path:
        return None
    cand = resolve_safe_music_file(cand_path)
    if cand:
        return cand
    cand_rel = resolve_safe_music_file(os.path.join(get_effective_music_dir(), cand_path.lstrip("/")))
    if cand_rel:
        return cand_rel
    return resolve_safe_music_file(os.path.join(get_effective_music_dir(), os.path.basename(cand_path)))


def locate_track_file_strict_candidates(db_file_path: Optional[str], track_id: str) -> Optional[str]:
    """
    Резолв пути аудиофайла с проверкой принадлежности к MUSIC_DIR:
    db_file_path -> Qdrant payload (по track_id).
    """
    resolved = _resolve_music_file_candidates(db_file_path)
    if resolved:
        return resolved

    if track_id and str(track_id).strip():
        try:
            records = client.retrieve(
                collection_name=COLLECTION_NAME,
                ids=[track_id],
                with_payload=True,
            )
            if records and records[0].payload:
                return _resolve_music_file_candidates(records[0].payload.get("file_path", ""))
        except Exception as e:
            print(f"Qdrant retrieve error for track {track_id}: {e}")

    return None


def extract_full_metadata_with_genre(file_path: str):
    """Извлекает (title, artist, album, genre, lyrics, duration) с деградацией до имени файла."""
    try:
        from services.track_metadata_service import resolve_track_file_path
        from metadata import read_audio_metadata
        full_path, _ = resolve_track_file_path({"file_path": file_path})
        meta = read_audio_metadata(full_path)
        return (
            meta.title or os.path.splitext(os.path.basename(file_path))[0],
            meta.artist or "Неизвестный исполнитель",
            meta.album or "Неизвестный альбом",
            meta.genre,
            meta.lyrics,
            meta.duration
        )
    except Exception:
        name_without_ext = os.path.splitext(os.path.basename(file_path))[0]
        title_val = name_without_ext
        artist_val = "Неизвестный исполнитель"
        if " - " in name_without_ext:
            parts = name_without_ext.split(" - ", 1)
            title_val = parts[0].strip()
            artist_val = parts[-1].strip()
        return title_val, artist_val, "Неизвестный альбом", None, None, None


def extract_full_metadata(file_path: str):
    """Извлекает (title, artist, album, lyrics, duration) с деградацией до имени файла."""
    title, artist, album, _genre, lyrics, duration = extract_full_metadata_with_genre(file_path)
    return title, artist, album, lyrics, duration


def ingest_music_file(file_path, *, source, expected_track_id=None, payload=None, deadline=None, cancel=None):
    """Canonical creating ingest; parse outside SQL, claim before dependent writes."""
    import hashlib
    import sqlite3
    import time
    from metadata import read_audio_metadata, AudioMetadata, track_mutation_lock
    from repositories import share_entities, delivery
    from repositories.base import get_connection, check_deadline, deadline_context
    from repositories.artist_credits import audio_artist_source
    from services.content_version_service import open_safe
    check_deadline(deadline,cancel)
    safe_path = _resolve_music_file_candidates(str(file_path)) if source == 'recovery' else resolve_safe_music_file(str(file_path))
    if not safe_path:
        return None
    root=os.path.realpath(get_effective_music_dir())
    rel_path=os.path.relpath(safe_path,root)
    fd,initial,_=open_safe(rel_path,root)
    os.close(fd)
    if source == 'import' or deadline is None:
        meta=read_audio_metadata(safe_path)
        if payload:
            # File tags win when present; payload only fills unknown legacy tags.
            for field in ('title','artist','album','album_artist','year'):
                if not getattr(meta,field,None) or getattr(meta,field,None) in ('Неизвестный исполнитель','Неизвестный альбом') or (field=='title' and meta.title==os.path.splitext(os.path.basename(safe_path))[0]):
                    setattr(meta,field,payload.get(field) or getattr(meta,field,None))
    else:
        data=payload or {}
        meta=AudioMetadata(title=str(data.get('title') or os.path.splitext(os.path.basename(safe_path))[0]),
            artist=str(data.get('artist') or ''),album=str(data.get('album') or data.get('album_title') or ''),
            album_artist=data.get('album_artist') or data.get('albumartist'),year=data.get('year'),
            genre=data.get('genre'),duration=float(data.get('duration') or 0),lyrics=data.get('lyrics'))
        if payload:
            if not meta.duration:
                meta.duration=float(payload.get('duration') or 0)
            if not meta.genre:
                meta.genre=payload.get('genre')
    meta.file_size=initial.st_size; meta.file_mtime_ns=initial.st_mtime_ns
    check_deadline(deadline,cancel)
    lock_end=min(deadline or float('inf'),time.monotonic()+.25)
    with deadline_context(deadline,cancel), track_mutation_lock('ingest-path-'+hashlib.sha256(rel_path.encode()).hexdigest(),root,lock_end,cancel):
        for attempt in range(2):
            conn=get_connection(deadline=deadline,cancel=cancel)
            try:
                claim=conn.execute('SELECT track_id FROM track_path_claims WHERE rel_path=?',(rel_path,)).fetchone()
                historical=str(uuid.uuid5(uuid.NAMESPACE_URL,rel_path))
                used=conn.execute("SELECT 1 FROM share_entities WHERE entity_type='track' AND public_id=?",(historical,)).fetchone()
                planned=(str(expected_track_id) if source=='recovery' else claim[0] if claim else str(uuid.uuid4()) if used else historical)
            finally:
                conn.close()
            with track_mutation_lock(planned,root,lock_end,cancel):
                fd,current,_=open_safe(rel_path,root)
                os.close(fd)
                if delivery.fingerprint(initial)!=delivery.fingerprint(current):
                    return None
                try:
                    with delivery.transaction(deadline,cancel) as conn:
                        canonical=share_entities.claim_track_identity(conn,rel_path,source,planned)
                        if canonical is None:
                            return None
                        if canonical!=planned:
                            raise sqlite3.IntegrityError('identity_changed')
                        previous=db.get_track(canonical,conn=conn)
                        album_id=resolve_import_album(canonical,meta.album,meta.album_artist,year=meta.year,
                            artist_source=payload_artist_source(payload,'album_artists') if payload else audio_artist_source(meta,album=True),conn=conn) if meta.album else None
                        db.add_or_update_track(canonical,rel_path,meta.title,album_id,meta.artist,meta.lyrics,
                            duration=meta.duration,genre=meta.genre,file_size=meta.file_size,file_mtime_ns=meta.file_mtime_ns,
                            track_number=meta.track_number,disc_number=meta.disc_number,
                            artist_source=payload_artist_source(payload,'artists') if payload else audio_artist_source(meta),conn=conn)
                        db.update_track_metadata_from_audio(canonical,meta,album_id,preserve_empty_genre=True,
                            artist_source=payload_artist_source(payload,'artists') if payload else audio_artist_source(meta),
                            album_artist_source=payload_artist_source(payload,'album_artists') if payload else audio_artist_source(meta,album=True),conn=conn)
                        version=delivery.get_version(canonical,conn=conn)
                        if version and version['state']=='ready' and not delivery.ready_version(canonical,current,conn=conn):
                            delivery.reserve_retirement(conn,canonical,unmanaged=True)
                        delivery.enqueue(canonical,conn=conn)
                        result=db.get_track(canonical,conn=conn)
                    # Returned ID is the sole ID callers may publish downstream.
                    if previous and (previous.get('file_size')!=meta.file_size or previous.get('file_mtime_ns')!=meta.file_mtime_ns):
                        db.reset_track_loudness_pending(canonical,file_size=meta.file_size,file_mtime_ns=meta.file_mtime_ns)
                    if payload and payload.get('loudness_status')=='analyzed':
                        db.update_track_loudness(canonical,payload.get('loudness_lufs'),payload.get('true_peak_db'),
                            payload.get('normalization_gain_db'),status='analyzed',analysis_version=payload.get('loudness_analysis_version'),
                            file_size=payload.get('loudness_file_size'),file_mtime_ns=payload.get('loudness_file_mtime_ns'))
                        result=db.get_track(canonical)
                    return result
                except sqlite3.IntegrityError:
                    if attempt:
                        raise
                    check_deadline(deadline,cancel)
    return None


def ensure_track_from_file(file_path: str, track_id: Optional[str] = None) -> Optional[dict]:
    return ingest_music_file(file_path, source='recovery' if track_id else 'import', expected_track_id=track_id)


def payload_artist_source(payload, key):
    from repositories.artist_credits import CreditSource, legacy_artist_source
    if key in payload and isinstance(payload[key], list):
        names = []
        for item in payload[key]:
            if isinstance(item, dict) and isinstance(item.get('name'), str):
                names.append(item['name'])
            elif isinstance(item, str):
                names.append(item)
            else:
                return None
        return CreditSource('qdrant', names)
    return legacy_artist_source(payload.get('album_artist' if key == 'album_artists' else 'artist'))


def resolve_import_album(track_id, title, album_artist, year=None, artist_source=None, *, conn=None):
    if not title:
        return None
    from repositories.albums import normalize_text
    from repositories.artist_credits import get_recovery_album
    if not album_artist:
        existing=db.get_track(track_id,conn=conn)
        if existing and existing.get('album_id'):
            if conn is None:
                album=db.get_album(existing['album_id'])
            else:
                row=conn.execute('SELECT * FROM albums WHERE id=?',(existing['album_id'],)).fetchone()
                album=dict(row) if row else None
        else:
            album=get_recovery_album(track_id,conn=conn) if not existing else None
        if album and normalize_text(album.get('title'))==normalize_text(title):
            album_artist=album.get('album_artist') or ''
    return db.resolve_album(title,album_artist=album_artist or '',year=year,artist_source=artist_source,conn=conn)


def ensure_track_in_db(track_id: str, payload: Optional[dict] = None, *, deadline=None, cancel=None) -> Optional[dict]:
    from repositories.share_entities import recovery_allowed
    from repositories.base import deadline_context, check_deadline
    import time
    with deadline_context(deadline,cancel):
        if not track_id or not recovery_allowed(track_id):
            return None
        try:
            row=db.get_track(track_id)
        except Exception:
            # Legacy callers treat a failed lookup as unavailable and must not
            # attempt recovery. Deadline-bound delivery needs the failure to
            # propagate so its admission policy can return the correct error.
            if deadline is not None:
                raise
            return None
        if row:
            return row
        point_id=_qdrant_point_id(track_id)
        if payload is None and point_id is not None:
            dedicated=None
            try:
                check_deadline(deadline,cancel)
                if deadline is not None:
                    if deadline-time.monotonic()<1:
                        return None
                    from qdrant_client import QdrantClient
                    import httpx
                    from config import QDRANT_CONNECTION
                    dedicated = QdrantClient(
                        **QDRANT_CONNECTION, timeout=1, check_compatibility=False,
                        transport=httpx.HTTPTransport(retries=0),
                    )
                records=(dedicated or client).retrieve(collection_name=COLLECTION_NAME,ids=[point_id],with_payload=True)
                if records and records[0].payload:
                    payload=records[0].payload
                check_deadline(deadline,cancel)
            except (TimeoutError,):
                raise
            except Exception:
                return None
            finally:
                if dedicated is not None:
                    dedicated.close()
        if not payload or not recovery_allowed(track_id):
            return None
        path=_resolve_music_file_candidates(payload.get('file_path'))
        if not path:
            return None
        return ingest_music_file(path,source='recovery',expected_track_id=track_id,payload=payload,deadline=deadline,cancel=cancel)
