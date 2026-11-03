"""Shared artist catalog, profiles, playback starts, and admin artwork."""
import io
import os
import tempfile
from typing import Literal

import db
from pydantic import BaseModel, ConfigDict, Field
from routers.tracks import ArtistSelector

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response
from PIL import Image, UnidentifiedImageError

from auth import get_current_admin_user, get_current_user, get_cover_user
from config import ARTIST_ARTWORK_DIR, get_base_url
from repositories import artists
from serializers import serialize_track

router = APIRouter(prefix="/api", tags=["artists"])
MAX_ARTWORK_BYTES = 5 * 1024 * 1024
ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP"}
ARTWORK_CACHE = "private, max-age=86400, must-revalidate"


def _artist_or_404(artist_id: str) -> dict:
    artist = artists.find_artist_by_id(artist_id)
    if not artist:
        raise HTTPException(status_code=404, detail="Артист не найден")
    return artist


def _artwork_path(artist_id: str) -> str:
    return os.path.join(ARTIST_ARTWORK_DIR, f"{artist_id}.jpg")


def _read_and_normalize_image(data: bytes) -> bytes:
    if not data:
        raise HTTPException(status_code=400, detail="Изображение пустое")
    if len(data) > MAX_ARTWORK_BYTES:
        raise HTTPException(status_code=413, detail="Изображение должно быть не больше 5 MiB")
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in ALLOWED_FORMATS:
                raise HTTPException(status_code=415, detail="Разрешены JPEG, PNG и WebP")
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            image = image.convert("RGB")
            image.thumbnail((1600, 1600))
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=88, optimize=True)
            return output.getvalue()
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(status_code=415, detail="Файл не является корректным изображением")


@router.get("/artists")
def list_artists(
    request: Request,
    q: str | None = Query(default=None, max_length=100),
    current_user: dict = Depends(get_current_user),
):
    base_url = get_base_url(request)
    # Treat whitespace-only query as no query (omitted)
    query = q.strip() if q else None
    return [artists.public_artist(item, base_url) for item in artists.get_artist_catalog(query if query else None)]


@router.get("/artists/{artist_id}")
def get_artist(artist_id: str, request: Request, current_user: dict = Depends(get_current_user)):
    detail = artists.get_artist_detail(artist_id, get_base_url(request))
    if not detail:
        raise HTTPException(status_code=404, detail="Артист не найден")
    base_url = get_base_url(request)
    favorite_ids = db.get_favorite_track_ids(current_user["id"])
    detail["popular_tracks"] = [serialize_track(track, base_url, favorite_ids, include_lyrics=False) | {"play_count": track["play_count"]} for track in detail["popular_tracks"]]
    return detail


@router.post("/tracks/{track_id}/play-start")
def log_play_start(track_id: str, current_user: dict = Depends(get_current_user)):
    status = artists.record_play_start(current_user["id"], track_id)
    if status is None:
        raise HTTPException(status_code=404, detail="Трек не найден")
    return {"status": status, "track_id": track_id}


@router.get("/artists/{artist_id}/artwork")
def get_artist_artwork(artist_id: str, request: Request, current_user: dict = Depends(get_cover_user)):
    _artist_or_404(artist_id)
    metadata = artists.get_artwork_metadata(artist_id)
    path = _artwork_path(artist_id)
    if not metadata:
        raise HTTPException(status_code=404, detail="Изображение артиста отсутствует")
    etag = f'"{artist_id}-{metadata["version"]}"'
    headers = {"ETag": etag, "Cache-Control": ARTWORK_CACHE}
    if _etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=headers)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Изображение артиста отсутствует")
    return FileResponse(path, media_type="image/jpeg", headers=headers)


def _etag_matches(if_none_match: str | None, etag: str) -> bool:
    if not if_none_match:
        return False
    candidates = [candidate.strip() for candidate in if_none_match.split(",")]
    return etag in candidates or "*" in candidates


@router.put("/artists/{artist_id}/artwork")
async def put_artist_artwork(artist_id: str, file: UploadFile = File(...), admin: dict = Depends(get_current_admin_user)):
    _artist_or_404(artist_id)
    try:
        data = await file.read(MAX_ARTWORK_BYTES + 1)
    finally:
        await file.close()
    normalized = _read_and_normalize_image(data)
    os.makedirs(ARTIST_ARTWORK_DIR, mode=0o750, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=f".{artist_id}.", suffix=".tmp", dir=ARTIST_ARTWORK_DIR)
    path = _artwork_path(artist_id)
    try:
        with os.fdopen(fd, "wb") as target:
            target.write(normalized)
            target.flush()
            os.fsync(target.fileno())
        version = artists.replace_artwork_atomically(artist_id, temp_path, path)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
    return {"status": "updated", "artist_id": artist_id, "artwork_version": version}


@router.delete("/artists/{artist_id}/artwork")
def delete_artist_artwork(artist_id: str, admin: dict = Depends(get_current_admin_user)):
    _artist_or_404(artist_id)
    path = _artwork_path(artist_id)
    artists.remove_artwork_atomically(artist_id, path)
    return {"status": "removed", "artist_id": artist_id}


class ReplacementPreview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope: Literal["tracks", "albums"]
    artists: list[ArtistSelector] = Field(max_length=100)

class ReplacementOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation_id: str

@router.post("/artists/{artist_id}/credits/preview")
def preview_credits(artist_id: str, payload: ReplacementPreview, current_user: dict = Depends(get_current_admin_user)):
    from services.artist_credit_bulk_service import preview_artist_replacement
    return preview_artist_replacement(artist_id, payload.scope, [a.model_dump(exclude_unset=True) for a in payload.artists], current_user)

@router.post("/artists/{artist_id}/credits/apply")
def apply_credits(artist_id: str, payload: ReplacementOperation, current_user: dict = Depends(get_current_admin_user)):
    from services.artist_credit_bulk_service import apply_artist_replacement
    return apply_artist_replacement(artist_id, payload.operation_id, current_user)

@router.post("/artists/{artist_id}/credits/undo")
def undo_credits(artist_id: str, payload: ReplacementOperation, current_user: dict = Depends(get_current_admin_user)):
    from services.artist_credit_bulk_service import undo_artist_replacement
    return undo_artist_replacement(artist_id, payload.operation_id, current_user)
