"""
Track Metadata Application Service
Coordinates authentication, authorization, SSRF-safe downloads,
two-tier locking, safe file replacement, and SQLite synchronization.
"""

import base64
import io
import ipaddress
import json
import os
import socket
from urllib.parse import urlparse
from typing import Optional, Dict, Any, Tuple
import requests
from fastapi import HTTPException, status
from colorthief import ColorThief

import db
from metadata import (
    AudioMetadata,
    MetadataPatch,
    read_audio_metadata,
    clean_cover_bytes,
    validate_safe_path,
    track_mutation_lock,
    safe_replace_audio_file,
    MAX_COVER_SIZE_BYTES,
)

MUSIC_DIR = os.getenv("MUSIC_DIR", "/mnt/data/projects/puuk/music")


def get_music_dir() -> str:
    path = os.getenv("MUSIC_DIR", "/mnt/data/projects/puuk/music")
    if not os.path.exists(path):
        local_fallback = os.path.join(os.path.dirname(os.path.dirname(__file__)), "temp_audio")
        if os.path.exists(local_fallback):
            return os.path.realpath(local_fallback)
        os.makedirs(path, exist_ok=True)
    return os.path.realpath(path)


def resolve_track_file_path(db_track: Dict[str, Any]) -> Tuple[str, str]:
    """
    Returns (abs_path, effective_music_dir).
    Validates against Path Traversal using commonpath().
    """
    rel_path = db_track.get("file_path", "")
    if not rel_path:
        raise HTTPException(status_code=404, detail="Track has no file_path recorded")

    effective_dir = get_music_dir()
    
    # Try direct relative path inside effective_dir
    try:
        candidate = validate_safe_path(rel_path, effective_dir)
        if os.path.exists(candidate):
            return candidate, effective_dir
    except (PermissionError, ValueError):
        pass

    # Try basename inside effective_dir
    basename = os.path.basename(rel_path)
    try:
        candidate_base = validate_safe_path(basename, effective_dir)
        if os.path.exists(candidate_base):
            return candidate_base, effective_dir
    except (PermissionError, ValueError):
        pass

    # Check local temp_audio fallback
    temp_audio_dir = os.path.realpath(os.path.join(os.path.dirname(os.path.dirname(__file__)), "temp_audio"))
    if os.path.exists(temp_audio_dir):
        try:
            candidate_temp = validate_safe_path(basename, temp_audio_dir)
            if os.path.exists(candidate_temp):
                return candidate_temp, temp_audio_dir
        except Exception:
            pass

    raise HTTPException(status_code=404, detail="Audio file not found on server storage")


def check_track_edit_permissions(db_track: Dict[str, Any], current_user: Dict[str, Any]):
    """
    RBAC:
    - If added_by_user_id IS NULL: only role == 'admin' can edit.
    - If added_by_user_id IS NOT NULL: role == 'admin' OR added_by == user.id.
    """
    user_role = current_user.get("role")
    user_id = current_user.get("id")
    added_by = db_track.get("added_by_user_id")

    if user_role == "admin":
        return

    if added_by is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Недостаточно прав. Системные треки библиотеки может редактировать только администратор."
        )

    if added_by != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Недостаточно прав. Вы можете редактировать метаданные только тех треков, которые добавили сами."
        )


def _is_ip_private(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
        return (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or str(ip) in ("0.0.0.0", "::")
        )
    except ValueError:
        return True


def fetch_cover_from_url_safe(url: str) -> bytes:
    """
    Downloads image from external URL with strict SSRF protection:
    - http/https only
    - forbids private/localhost/loopback IP resolutions
    - limits response size to MAX_COVER_SIZE_BYTES (10 MB)
    - timeouts: connect 5s, read 10s
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("Invalid URL scheme. Only HTTP and HTTPS are allowed.")

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("Invalid URL: missing hostname.")

    try:
        addr_infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror as e:
        raise ValueError(f"Could not resolve cover URL hostname: {e}")

    for addr in addr_infos:
        ip = addr[4][0]
        if _is_ip_private(ip):
            raise ValueError(f"Access to private/local network address is forbidden ({ip})")

    # Stream with size limit
    try:
        with requests.get(
            url,
            stream=True,
            timeout=(5, 10),
            headers={"User-Agent": "PuukMusic/1.0 (ArtworkFetcher)"},
            allow_redirects=True
        ) as resp:
            resp.raise_for_status()
            
            # Check Content-Length if reported
            cl = resp.headers.get("Content-Length")
            if cl and int(cl) > MAX_COVER_SIZE_BYTES:
                raise ValueError("Remote image exceeds maximum allowed size of 10MB")

            data = io.BytesIO()
            downloaded = 0
            for chunk in resp.iter_content(chunk_size=65536):
                downloaded += len(chunk)
                if downloaded > MAX_COVER_SIZE_BYTES:
                    raise ValueError("Remote image exceeded maximum allowed size during download")
                data.write(chunk)

            return data.getvalue()
    except Exception as e:
        raise ValueError(f"Failed to fetch cover from URL: {e}")


def get_track_metadata_details(track_id: str, current_user: Dict[str, Any], base_url: str = "") -> Dict[str, Any]:
    """
    Reads track details. For the editor, reads live from audio file on disk
    and reconciles SQLite if desynchronization is detected.
    Never exposes absolute server filesystem path.
    """
    db_track = db.get_track(track_id)
    if not db_track:
        raise HTTPException(status_code=404, detail="Track not found")

    abs_path, effective_dir = resolve_track_file_path(db_track)
    
    # Read live from disk
    actual_meta = read_audio_metadata(abs_path)

    # Check for desynchronization
    stat = os.stat(abs_path)
    if stat.st_mtime_ns != db_track.get("file_mtime_ns") or stat.st_size != db_track.get("file_size"):
        # Auto-resync SQLite with actual file state
        album_id = db.add_or_get_album(actual_meta.album, None) if actual_meta.album else db_track.get("album_id")
        db.update_track_metadata_from_audio(track_id, actual_meta, album_id=album_id, cover_version_inc=False)
        db_track = db.get_track(track_id)

    album_name = actual_meta.album or "Unknown Album"
    if not actual_meta.album and db_track.get("album_id"):
        conn = db.get_connection()
        c = conn.cursor()
        c.execute("SELECT title FROM albums WHERE id = ?", (db_track["album_id"],))
        alb = c.fetchone()
        conn.close()
        if alb and alb["title"]:
            album_name = alb["title"]

    cover_ver = db_track.get("cover_version") or 0
    cover_art_url = f"{base_url}/api/cover/{track_id}?v={cover_ver}" if base_url else f"/api/cover/{track_id}?v={cover_ver}"

    # Sanitized relative path (strip any system prefixes)
    rel_sanitized = db_track.get("file_path", "")
    if os.path.isabs(rel_sanitized):
        rel_sanitized = os.path.basename(rel_sanitized)

    raw_auto_genres = db_track.get("auto_genres")
    auto_genres_val = None
    if isinstance(raw_auto_genres, list):
        auto_genres_val = raw_auto_genres
    elif isinstance(raw_auto_genres, str) and raw_auto_genres.strip():
        try:
            auto_genres_val = json.loads(raw_auto_genres)
        except Exception:
            auto_genres_val = None

    return {
        "id": track_id,
        "title": actual_meta.title or db_track["title"],
        "artist": actual_meta.artist or db_track["artist"],
        "album": album_name,
        "album_artist": actual_meta.album_artist or db_track.get("album_artist"),
        "year": actual_meta.year or db_track.get("year"),
        "genre": actual_meta.genre or db_track.get("genre"),
        "auto_genres": auto_genres_val,
        "auto_genre_model": db_track.get("auto_genre_model"),
        "auto_genre_updated_at": db_track.get("auto_genre_updated_at"),
        "track_number": actual_meta.track_number or db_track.get("track_number"),
        "disc_number": actual_meta.disc_number or db_track.get("disc_number"),
        "comment": actual_meta.comment or db_track.get("comment"),
        "lyrics": actual_meta.lyrics or db_track.get("lyrics") or "",
        "duration": actual_meta.duration or db_track.get("duration") or 0.0,
        "bitrate": actual_meta.bitrate or db_track.get("bitrate"),
        "sample_rate": actual_meta.sample_rate or db_track.get("sample_rate"),
        "channels": actual_meta.channels or db_track.get("channels"),
        "format": actual_meta.format or db_track.get("format") or os.path.splitext(abs_path)[1].lstrip("."),
        "file_size": actual_meta.file_size or db_track.get("file_size"),
        "file_path": rel_sanitized,
        "has_cover": actual_meta.has_cover,
        "coverArt": cover_art_url,
        "cover_version": cover_ver,
        "cover_color": db_track.get("cover_color"),
        "added_by_user_id": db_track.get("added_by_user_id")
    }


def mutate_track_metadata(track_id: str, payload, current_user: Dict[str, Any], base_url: str = "") -> Dict[str, Any]:
    """
    Executes full safe mutation workflow:
    1. RBAC verification
    2. Sidecar locking
    3. Cover processing & SSRF protection
    4. Safe file replacement & verification
    5. Re-reading verified tags
    6. SQLite commit & journal logging
    7. Dominant color recalculation
    """
    db_track = db.get_track(track_id)
    if not db_track:
        raise HTTPException(status_code=404, detail="Track not found")

    check_track_edit_permissions(db_track, current_user)

    abs_path, effective_dir = resolve_track_file_path(db_track)

    # Process cover if requested
    cover_bytes = None
    cover_mime = None
    cover_action = getattr(payload, "cover_action", "keep")

    if cover_action == "replace":
        raw_cover = None
        if getattr(payload, "cover_base64", None):
            raw_b64 = payload.cover_base64
            if "," in raw_b64:
                raw_b64 = raw_b64.split(",", 1)[1]
            try:
                raw_cover = base64.b64decode(raw_b64)
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Invalid base64 cover encoding: {e}")
        elif getattr(payload, "cover_url", None):
            try:
                raw_cover = fetch_cover_from_url_safe(payload.cover_url)
            except ValueError as ve:
                raise HTTPException(status_code=400, detail=str(ve))

        if not raw_cover:
            raise HTTPException(status_code=400, detail="cover_action is 'replace' but no valid image data received")

        try:
            cover_bytes, cover_mime = clean_cover_bytes(raw_cover)
        except ValueError as ve:
            raise HTTPException(status_code=400, detail=f"Invalid image: {ve}")

    # Build MetadataPatch with explicit model_fields_set
    fs = set(payload.model_fields_set) if hasattr(payload, "model_fields_set") else set()
    patch = MetadataPatch(
        fields_set=fs,
        title=getattr(payload, "title", None),
        artist=getattr(payload, "artist", None),
        album=getattr(payload, "album", None),
        album_artist=getattr(payload, "album_artist", None),
        year=getattr(payload, "year", None),
        genre=getattr(payload, "genre", None),
        track_number=getattr(payload, "track_number", None),
        disc_number=getattr(payload, "disc_number", None),
        comment=getattr(payload, "comment", None),
        lyrics=getattr(payload, "lyrics", None),
        cover_action=cover_action,
        cover_bytes=cover_bytes,
        cover_mime=cover_mime
    )

    # Two-tier lock (Process + Sidecar file lock)
    with track_mutation_lock(track_id, effective_dir):
        stat = os.stat(abs_path)
        journal_id = db.log_mutation_journal(track_id, "prepared", stat.st_size, stat.st_mtime_ns)

        try:
            actual_meta = safe_replace_audio_file(abs_path, patch)
            db.update_mutation_journal(journal_id, "replaced")

            # Sync SQLite with actual metadata
            album_id = None
            if "album" in fs:
                album_id = db.add_or_get_album(actual_meta.album or "Unknown Album", None)

            cover_inc = (cover_action in ("replace", "remove"))
            db.update_track_metadata_from_audio(
                track_id=track_id,
                meta=actual_meta,
                album_id=album_id,
                lyrics=actual_meta.lyrics,
                cover_version_inc=cover_inc
            )

            # Update cover color
            if cover_action == "remove":
                db.update_track_cover_color(track_id, None)
            elif cover_action == "replace" and cover_bytes:
                try:
                    with io.BytesIO(cover_bytes) as bio:
                        thief = ColorThief(bio)
                        dom = thief.get_color(quality=1)
                        hex_col = "#%02x%02x%02x" % dom
                        db.update_track_cover_color(track_id, hex_col)
                except Exception as e:
                    print(f"[metadata] Warning calculating cover color: {e}")

            db.update_mutation_journal(journal_id, "committed")

        except Exception as e:
            db.update_mutation_journal(journal_id, "failed")
            raise HTTPException(status_code=500, detail=f"Failed to update audio file tags: {e}")

    # Return updated track
    return get_track_metadata_details(track_id, current_user, base_url)


def resync_track_from_disk(track_id: str, current_user: Optional[Dict[str, Any]] = None, base_url: str = "") -> Dict[str, Any]:
    """
    Idempotent recovery: re-reads actual audio file and updates SQLite.
    """
    db_track = db.get_track(track_id)
    if not db_track:
        raise HTTPException(status_code=404, detail="Track not found")

    if current_user:
        check_track_edit_permissions(db_track, current_user)

    abs_path, effective_dir = resolve_track_file_path(db_track)

    with track_mutation_lock(track_id, effective_dir):
        actual_meta = read_audio_metadata(abs_path)
        album_id = db.add_or_get_album(actual_meta.album, None) if actual_meta.album else db_track.get("album_id")
        
        db.update_track_metadata_from_audio(
            track_id=track_id,
            meta=actual_meta,
            album_id=album_id,
            cover_version_inc=False
        )

    updated = get_track_metadata_details(track_id, current_user or {"role": "admin"}, base_url)
    return {
        "status": "success",
        "changed": True,
        "track": updated
    }


def reconcile_uncommitted_mutations():
    """Recovers any operations that succeeded on disk but were left uncommitted in SQLite."""
    try:
        uncommitted = db.get_uncommitted_mutations()
        for rec in uncommitted:
            tid = rec["track_id"]
            print(f"[recovery] Found uncommitted mutation for track {tid}, resyncing from disk...")
            try:
                resync_track_from_disk(tid)
                db.update_mutation_journal(rec["id"], "committed")
            except Exception as e:
                print(f"[recovery] Could not resync track {tid}: {e}")
    except Exception as e:
        print(f"[recovery] Warning during reconciliation: {e}")
