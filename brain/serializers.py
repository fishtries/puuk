import json
import os
from typing import Dict, Any, Set, Optional


def serialize_track(r: Dict[str, Any], base_url: str, fav_ids: Optional[Set[str]] = None, include_lyrics: bool = True) -> Dict[str, Any]:
    """
    Standardized, unified serializer for Track objects across all endpoints:
    /api/tracks, /api/albums/{id}, /api/playlists/{id}, /api/favorites, /api/history, /api/search.

    include_lyrics=False для списков: плеер берёт текст из /tracks/{id}/lyrics,
    поэтому списковым DTO килобайты LRC не нужны.
    """
    track_id = str(r.get("id") or r.get("track_id") or "")
    fav_ids = fav_ids or set()
    cover_ver = r.get("cover_version") or 0

    raw_auto_genres = r.get("auto_genres")
    auto_genres_val = None
    if isinstance(raw_auto_genres, list):
        auto_genres_val = raw_auto_genres
    elif isinstance(raw_auto_genres, str) and raw_auto_genres.strip():
        try:
            auto_genres_val = json.loads(raw_auto_genres)
        except Exception:
            auto_genres_val = None

    rel_sanitized = r.get("file_path", "")
    if os.path.isabs(rel_sanitized):
        rel_sanitized = os.path.basename(rel_sanitized)

    album_name = r.get("album") or r.get("album_title") or "Unknown Album"

    return {
        "id": track_id,
        "title": r.get("title", ""),
        "artist": r.get("artist", ""),
        "album": album_name,
        "album_id": r.get("album_id"),
        "album_artist": r.get("album_artist"),
        "year": r.get("year"),
        "genre": r.get("genre"),
        "track_number": r.get("track_number"),
        "disc_number": r.get("disc_number"),
        "comment": r.get("comment"),
        "lyrics": (r.get("lyrics") or "") if include_lyrics else "",
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
        "auto_genres": auto_genres_val,
        "auto_genre_model": r.get("auto_genre_model"),
        "auto_genre_updated_at": r.get("auto_genre_updated_at"),
        "is_liked": track_id in fav_ids,
        "normalization_gain_db": r.get("normalization_gain_db"),
        "loudness_status": r.get("loudness_status") or "pending",
        "loudness_lufs": r.get("loudness_lufs"),
        "true_peak_db": r.get("true_peak_db"),
        "added_at": r.get("added_at"),
        "favorited_at": r.get("favorited_at"),
        "played_at": r.get("played_at")
    }
