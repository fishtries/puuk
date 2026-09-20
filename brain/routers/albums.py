"""Album catalog endpoints."""
from fastapi import APIRouter, Depends, Request

import db
from auth import get_current_user
from config import get_base_url
from serializers import serialize_track

router = APIRouter(prefix="/api/albums", tags=["albums"])


@router.get("")
def get_all_albums(request: Request):
    base_url = get_base_url(request)
    albums = db.get_all_albums()
    for album in albums:
        tracks = db.get_album_tracks(album['id'])
        if tracks:
            album['coverArt'] = f"{base_url}/api/cover/{tracks[0]['id']}"
    return albums


@router.get("/{album_id}")
def get_album_tracks(album_id: int, request: Request, current_user: dict = Depends(get_current_user)):
    base_url = get_base_url(request)
    records = db.get_album_tracks(album_id)
    fav_ids = db.get_favorite_track_ids(current_user["id"])
    return [serialize_track(r, base_url, fav_ids) for r in records]
