"""Artist identities, catalog reads, artwork metadata, and play-start events."""
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from repositories.base import get_connection
from repositories.albums import REPRESENTATIVE_TRACK_SQL

POPULAR_TRACK_LIMIT = 10
VARIOUS_ARTISTS = "various artists"


from repositories.artist_credits import normalize_artist_name, artist_id_for_name

def _register_normalize_function(conn) -> None:
    conn.create_function("artist_norm", 1, normalize_artist_name, deterministic=True)
    conn.create_function("is_various_artists", 1, lambda v: is_various_artists(v), deterministic=True)
    conn.create_function("artist_id_for_name", 1, lambda v: artist_id_for_name(v), deterministic=True)
    conn.create_function("lower_utf", 1, lambda v: v.casefold() if v else "", deterministic=True)


def _year_sort_value(value: Any) -> tuple[int, int]:
    match = re.search(r"\d{4}", str(value or ""))
    return (0, -int(match.group())) if match else (1, 0)


def is_various_artists(value: Any) -> bool:
    """Reserved compilation label: never an artist identity, in any case/spacing.

    Identity itself stays case-sensitive (normalize_artist_name never casefolds);
    casefold is used here only to recognise the reserved placeholder label.
    """
    return normalize_artist_name(value).casefold() == VARIOUS_ARTISTS



def album_attribution_clause(album_alias: str = "al") -> str:
    """SQL condition for album membership (contract §5).

    An album belongs to the track artist only when it has a track by that artist
    and its album_artist is empty/NULL or normalizes to the same name. Guarded
    compilation albums (album_artist of another act) are excluded, so catalog
    `album_count` and detail `albums[]` share one definition.
    """
    return (
        f"(artist_norm({album_alias}.album_artist) = '' "
        f"OR artist_norm({album_alias}.album_artist) = artist_norm(t.artist))"
    )


def get_artist_catalog(query: str | None = None) -> list[dict]:
    conn = get_connection()
    try:
        rows = conn.execute("""
            SELECT ar.id, ar.name, ar.normalized_name,
                (SELECT COUNT(*) FROM track_artists ta WHERE ta.artist_id=ar.id) AS track_count,
                (SELECT COUNT(*) FROM album_artists aa WHERE aa.artist_id=ar.id
                    AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id=aa.album_id)) AS album_count,
                COALESCE((SELECT MIN(track_id) FROM track_artists ta WHERE ta.artist_id=ar.id),
                    (SELECT MIN(t.id) FROM album_artists aa JOIN tracks t ON t.album_id=aa.album_id WHERE aa.artist_id=ar.id)) AS cover_track_id,
                COALESCE((SELECT CASE WHEN has_artwork THEN version ELSE 0 END FROM artist_artwork aw WHERE aw.artist_id=ar.id), 0) AS artwork_version
            FROM artists ar
            WHERE EXISTS (SELECT 1 FROM track_artists ta WHERE ta.artist_id=ar.id)
               OR EXISTS (SELECT 1 FROM album_artists aa JOIN tracks t ON t.album_id=aa.album_id WHERE aa.artist_id=ar.id)
            ORDER BY ar.name COLLATE NOCASE, ar.name, ar.id
        """).fetchall()
        needle = normalize_artist_name(query).casefold() if query else ''
        return [dict(row) for row in rows if needle in row['normalized_name'].casefold()]
    finally:
        conn.close()


def find_artist_by_id(artist_id: str) -> dict | None:
    return next((item for item in get_artist_catalog() if item['id'] == artist_id), None)


def get_artist_summary(artist_id: str) -> dict | None:
    """Public alias for find_artist_by_id (EV-8 public API)."""
    return find_artist_by_id(artist_id)


def get_artwork_metadata(artist_id: str) -> dict | None:
    """Get artwork metadata (version, has_artwork) for an artist."""
    if not artist_id:
        return None
    conn = get_connection()
    try:
        row = conn.execute("SELECT version, has_artwork FROM artist_artwork WHERE artist_id = ?", (artist_id,)).fetchone()
        return dict(row) if row and row["has_artwork"] else None
    finally:
        conn.close()


def get_artist_detail(artist_id: str, base_url: str) -> dict | None:
    if not artist_id:
        return None
    artist_summary = find_artist_by_id(artist_id)
    if not artist_summary:
        return None
    if is_various_artists(artist_summary.get("name")):
        return None
    from repositories.artist_credits import hydrate_track_credits, hydrate_album_credits
    from services.album_service import serialize_album
    conn = get_connection()
    try:
        tracks = conn.execute("""
            SELECT t.*, a.title AS album, COALESCE(s.play_count, 0) AS play_count
            FROM tracks t JOIN track_artists ta ON ta.track_id=t.id
            LEFT JOIN albums a ON a.id=t.album_id
            LEFT JOIN (SELECT track_id, COUNT(*) AS play_count FROM artist_play_starts GROUP BY track_id) s ON s.track_id=t.id
            WHERE ta.artist_id=? ORDER BY play_count DESC, t.title COLLATE NOCASE, t.id LIMIT ?
        """, (artist_id, POPULAR_TRACK_LIMIT)).fetchall()
        albums = conn.execute(f"""
            SELECT a.*, (SELECT COUNT(*) FROM tracks t WHERE t.album_id=a.id) AS track_count,
                (SELECT SUM(duration) FROM tracks t WHERE t.album_id=a.id) AS total_duration,
                ({REPRESENTATIVE_TRACK_SQL}) AS cover_track_id
            FROM albums a JOIN album_artists aa ON aa.album_id=a.id
            WHERE aa.artist_id=? AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id=a.id)
        """, (artist_id,)).fetchall()
        albums = hydrate_album_credits(albums, conn=conn)
        albums.sort(key=lambda album: (*_year_sort_value(album.get('year')), (album.get('title') or '').casefold(), album['id']))
        return {'artist': public_artist(artist_summary, base_url),
                'popular_tracks': hydrate_track_credits(tracks, conn=conn),
                'albums': [serialize_album(album, base_url) for album in albums]}
    finally:
        conn.close()


def public_artist(artist: dict, base_url: str) -> dict:
    item = {
        "id": artist["id"],
        "name": artist["name"],
        "track_count": artist["track_count"],
        "album_count": artist["album_count"],
        "artwork_version": artist.get("artwork_version", 0),
        "artwork_url": None,
        "cover_track_id": artist.get("cover_track_id"),
    }
    if item["artwork_version"]:
        item["artwork_url"] = f"{base_url}/api/artists/{item['id']}/artwork?v={item['artwork_version']}"
    item.pop("cover_track_id")
    return item


def record_play_start(user_id: int, track_id: str) -> str | None:
    """Record a play start event.
    
    Returns:
        "recorded" - new play start recorded
        "duplicate" - play start already exists for this user/track/day
        "ignored" - track has empty or Various Artists artist (not recorded)
        None - track not found (caller should return 404)
    """
    played_on = datetime.now(timezone.utc).date().isoformat()
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM tracks WHERE id = ?", (track_id,))
        track = cursor.fetchone()
        if not track:
            return None
        if not cursor.execute("SELECT 1 FROM track_artists WHERE track_id = ? LIMIT 1", (track_id,)).fetchone():
            return "ignored"
        cursor.execute("""
            INSERT OR IGNORE INTO artist_play_starts (user_id, track_id, played_on)
            VALUES (?, ?, ?)
        """, (user_id, track_id, played_on))
        conn.commit()
        return "recorded" if cursor.rowcount == 1 else "duplicate"
    finally:
        conn.close()


def replace_artwork_atomically(artist_id: str, staged_path: str, target_path: str) -> int:
    """Serialize artwork replacement and its version update across processes."""
    conn = get_connection()
    backup_path = f"{target_path}.{uuid.uuid4().hex}.bak"
    had_previous = False
    installed = False
    try:
        conn.execute("BEGIN IMMEDIATE")
        if os.path.exists(target_path):
            os.replace(target_path, backup_path)
            had_previous = True
        os.replace(staged_path, target_path)
        installed = True
        conn.execute("""
            INSERT INTO artist_artwork (artist_id, version, has_artwork) VALUES (?, 1, 1)
            ON CONFLICT(artist_id) DO UPDATE SET version = artist_artwork.version + 1,
                has_artwork = 1, updated_at = CURRENT_TIMESTAMP
        """, (artist_id,))
        version = conn.execute("SELECT version FROM artist_artwork WHERE artist_id = ?", (artist_id,)).fetchone()["version"]
        conn.commit()
    except Exception:
        try:
            # Restore while the write lock still excludes other artwork writers.
            if had_previous:
                os.replace(backup_path, target_path)
            elif installed:
                os.unlink(target_path)
        finally:
            conn.rollback()
        raise
    finally:
        conn.close()
    _discard_artwork_backup(backup_path)
    return version


def _discard_artwork_backup(path: str) -> None:
    # Cleanup after commit must never roll back an already published file/version.
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError:
        logging.getLogger(__name__).warning("Artwork backup cleanup failed: %s", path, exc_info=True)


def remove_artwork_atomically(artist_id: str, path: str) -> None:
    conn = get_connection()
    backup_path = f"{path}.{uuid.uuid4().hex}.bak"
    moved = False
    try:
        conn.execute("BEGIN IMMEDIATE")
        if os.path.exists(path):
            os.replace(path, backup_path)
            moved = True
        conn.execute("""
            UPDATE artist_artwork SET version = version + 1, has_artwork = 0,
                   updated_at = CURRENT_TIMESTAMP WHERE artist_id = ?
        """, (artist_id,))
        conn.commit()
    except Exception:
        try:
            if moved:
                os.replace(backup_path, path)
        finally:
            conn.rollback()
        raise
    finally:
        conn.close()
    _discard_artwork_backup(backup_path)
