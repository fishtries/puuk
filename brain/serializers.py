import os
from typing import Dict, Any, Set, Optional


def serialize_track(r: Dict[str, Any], base_url: str, fav_ids: Optional[Set[str]] = None) -> Dict[str, Any]:
    """
    Standardized, unified serializer for Track objects across all endpoints:
    /api/tracks, /api/albums/{id}, /api/playlists/{id}, /api/favorites, /api/history, /api/search.
    """
    track_id = str(r.get("id") or r.get("track_id") or "")
    fav_ids = fav_ids or set()
    cover_ver = r.get("cover_version") or 0

    rel_sanitized = r.get("file_path", "")
    if os.path.isabs(rel_sanitized):
        rel_sanitized = os.path.basename(rel_sanitized)

    album_name = r.get("album") or r.get("album_title") or "Unknown Album"

    return {
        "id": track_id,
        "title": r.get("title", ""),
        "artist": r.get("artist", ""),
        "album": album_name,
        "album_artist": r.get("album_artist"),
        "year": r.get("year"),
        "genre": r.get("genre"),
        "track_number": r.get("track_number"),
        "disc_number": r.get("disc_number"),
        "comment": r.get("comment"),
        "lyrics": r.get("lyrics") or "",
        "duration": r.get("duration") or 0.0,
        "bitrate": r.get("bitrate"),
        "sample_rate": r.get("sample_rate"),
        "channels": r.get("channels"),
        "format": r.get("format") or os.path.splitext(rel_sanitized)[1].lstrip("."),
        "file_size": r.get("file_size"),
        "bpm": r.get("bpm", 0),
        "file_path": rel_sanitized,
        "stream_url": f"{base_url}/api/stream/{track_id}",
        "coverArt": f"{base_url}/api/cover/{track_id}?v={cover_ver}",
        "cover_version": cover_ver,
        "cover_color": r.get("cover_color"),
        "is_liked": track_id in fav_ids,
        "added_at": r.get("added_at"),
        "favorited_at": r.get("favorited_at"),
        "played_at": r.get("played_at")
    }
