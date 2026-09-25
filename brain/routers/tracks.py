"""Track catalog endpoints: listing, details, metadata editing, resync."""
import uuid
from typing import Optional, Literal, Union

from fastapi import APIRouter, Depends, HTTPException, Request, Query
from pydantic import BaseModel, ConfigDict, model_validator

import db
from auth import get_current_user, get_optional_current_user
from config import get_base_url
from serializers import serialize_track
from services.lyrics_service import get_track_lyrics_payload

router = APIRouter(prefix="/api", tags=["tracks"])


class TrackEditPayload(BaseModel):
    model_config = ConfigDict(extra='forbid')

    title: Optional[str] = None
    artist: Optional[str] = None
    album: Optional[str] = None
    album_artist: Optional[str] = None
    year: Optional[Union[str, int]] = None
    genre: Optional[str] = None
    track_number: Optional[str] = None
    disc_number: Optional[str] = None
    comment: Optional[str] = None
    lyrics: Optional[str] = None

    cover_action: Literal["keep", "replace", "remove"] = "keep"
    cover_base64: Optional[str] = None
    cover_url: Optional[str] = None
    cover_mime: Optional[str] = None

    @model_validator(mode="after")
    def validate_cover_semantics(self):
        if self.cover_action in ("keep", "remove"):
            if self.cover_base64 is not None or self.cover_url is not None:
                raise ValueError(f"cover_base64 and cover_url must be null when cover_action is '{self.cover_action}'")
        elif self.cover_action == "replace":
            if not self.cover_base64 and not self.cover_url:
                raise ValueError("Either cover_base64 or cover_url must be provided when cover_action is 'replace'")
            if self.cover_base64 and self.cover_url:
                raise ValueError("Provide either cover_base64 or cover_url, not both")
        return self


def _validate_uuid(track_id: str):
    try:
        uuid.UUID(track_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Невалидный track_id")


@router.get("/tracks")
def get_all_tracks(request: Request, limit: int = 50, current_user: Optional[dict] = Depends(get_optional_current_user)):
    """Возвращает список треков из базы данных SQLite с персональными лайками."""
    try:
        records = db.get_all_tracks()
        fav_ids = db.get_favorite_track_ids(current_user["id"]) if current_user else set()
        base_url = get_base_url(request)
        return [serialize_track(r, base_url, fav_ids) for r in records[:limit]]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/tracks/{track_id}")
def get_track_info(track_id: str, request: Request, current_user: Optional[dict] = Depends(get_optional_current_user)):
    """Retrieve track details including full ID3 metadata and tech specs."""
    from services.track_metadata_service import get_track_metadata_details
    base_url = get_base_url(request)
    return get_track_metadata_details(track_id, current_user, base_url)


@router.patch("/tracks/{track_id}")
def update_track_metadata(track_id: str, payload: TrackEditPayload, request: Request, current_user: dict = Depends(get_current_user)):
    """Safe-Write Protocol for File Mutation using mutagen with RBAC."""
    from services.track_metadata_service import mutate_track_metadata
    base_url = get_base_url(request)
    updated_track = mutate_track_metadata(track_id, payload, current_user, base_url)
    return {"status": "success", "message": "File and database updated successfully", "track": updated_track}


@router.post("/tracks/{track_id}/resync")
def resync_track(track_id: str, request: Request, current_user: dict = Depends(get_current_user)):
    """Idempotent reconciliation of track metadata from disk to SQLite."""
    from services.track_metadata_service import resync_track_from_disk
    base_url = get_base_url(request)
    return resync_track_from_disk(track_id, current_user, base_url)


@router.get("/tracks/{track_id}/lyrics")
def get_track_lyrics(
    track_id: str,
    force: bool = Query(False, description="Принудительно повторить поиск в LRCLIB"),
    current_user: Optional[dict] = Depends(get_optional_current_user)
):
    """Fetches lyrics from DB. If empty (or forced), queries LRCLIB/syncedlyrics."""
    payload = get_track_lyrics_payload(track_id, force)
    if payload is None:
        raise HTTPException(status_code=404, detail="Track not found")
    return payload
