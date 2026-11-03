"""Unified search: tracks/albums/artists, lyrics providers, metadata providers."""
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request

import db
from auth import get_current_user
from config import get_base_url
from serializers import serialize_track
from services.album_service import serialize_album
from services.external_catalogs import search_lyrics_providers, search_metadata_providers

router = APIRouter(prefix="/api", tags=["search"])


@router.get("/search")
def search_library(
    request: Request,
    q: str = Query(..., description="Поисковый запрос"),
    limit: int = Query(default=30, ge=1, le=100),
    current_user: dict = Depends(get_current_user)
):
    """Полнотекстовый поиск по трекам, альбомам и артистам с учетом лайков пользователя."""
    if not q.strip():
        return {"tracks": [], "albums": [], "artists": []}

    base_url = get_base_url(request)
    data = db.search_all(q.strip(), limit=limit)
    fav_ids = db.get_favorite_track_ids(current_user["id"])

    tracks = [serialize_track(r, base_url, fav_ids) for r in data.get("tracks", [])]

    albums = [serialize_album(a, base_url) for a in data.get("albums", [])]

    artists = []
    seen_artist_ids = set()
    for art in data.get("artists", []):
        cover_track_id = art.get("cover_track_id")
        artist_id = art.get("id")
        if not artist_id or artist_id in seen_artist_ids:
            continue
        seen_artist_ids.add(artist_id)
        artists.append({
            "id": artist_id,
            "artist_id": artist_id,
            "name": art["name"],
            "track_count": art.get("track_count", 0),
            "album_count": art.get("album_count", 0),
            "coverArt": f"{base_url}/api/cover/{cover_track_id}" if cover_track_id else None
        })

    return {
        "tracks": tracks,
        "albums": albums,
        "artists": artists
    }


@router.get("/search/lyrics")
@router.get("/lyrics/search")
def search_lyrics(q: str, current_user: dict = Depends(get_current_user)):
    """Proxy to LRCLIB search with normalized fields and syncedlyrics fallback."""
    return search_lyrics_providers(q)


@router.get("/search/metadata")
@router.get("/metadata/search")
def search_metadata(q: str, current_user: dict = Depends(get_current_user)):
    """Search track metadata (title, artist, album, year, artwork) from iTunes and Deezer."""
    return search_metadata_providers(q)
