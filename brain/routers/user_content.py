from fastapi import APIRouter, Depends, HTTPException, Request, status
from datetime import datetime, timedelta, timezone
from typing import Literal
from pydantic import BaseModel, Field, field_validator
import sqlite3
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import db
from auth import get_current_user

router = APIRouter()

def get_base_url(request: Request) -> str:
    explicit_base = os.getenv("BASE_URL")
    if explicit_base:
        return explicit_base.rstrip("/")
    try:
        return str(request.base_url).rstrip("/")
    except Exception:
        server_ip = os.getenv("SERVER_IP", "192.168.1.117")
        return f"http://{server_ip}:8000"

# --- Избранное (Favorites / Likes) ---

@router.post("/tracks/{track_id}/like", summary="Добавить трек в избранное")
def like_track(track_id: str, current_user: dict = Depends(get_current_user)):
    track = db.get_track(track_id)
    if not track:
        from services.media_locations import ensure_track_in_db
        track = ensure_track_in_db(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Трек не найден")
    
    db.add_favorite(current_user["id"], track_id)
    return {"status": "liked", "track_id": track_id, "is_liked": True}

@router.delete("/tracks/{track_id}/like", summary="Удалить трек из избранного")
def unlike_track(track_id: str, current_user: dict = Depends(get_current_user)):
    db.remove_favorite(current_user["id"], track_id)
    return {"status": "unliked", "track_id": track_id, "is_liked": False}

from serializers import serialize_track

@router.get("/favorites", summary="Получить список избранных треков пользователя")
def get_favorites(request: Request, current_user: dict = Depends(get_current_user)):
    base_url = get_base_url(request)
    raw_tracks = db.get_user_favorites(current_user["id"])
    fav_ids = {r["id"] for r in raw_tracks}
    return [serialize_track(r, base_url, fav_ids, include_lyrics=False) for r in raw_tracks]

class TrackRatingRequest(BaseModel):
    rating: Literal["like", "dislike", "neutral"]
    operation_id: str = Field(min_length=1, max_length=128)


@router.put("/tracks/{track_id}/rating", summary="Установить явную оценку трека")
def put_track_rating(track_id: str, payload: TrackRatingRequest,
                     current_user: dict = Depends(get_current_user)):
    user_id = current_user["id"]
    try:
        try:
            applied = db.set_track_rating(user_id, track_id, payload.rating, payload.operation_id)
        except LookupError:
            from services.media_locations import ensure_track_in_db
            if not ensure_track_in_db(track_id):
                raise
            applied = db.set_track_rating(user_id, track_id, payload.rating, payload.operation_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail="Трек не найден") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"status": "ok", "track_id": track_id, **payload.model_dump(), "applied": applied}


# --- История прослушиваний (History) ---

class TrackHistoryRequest(BaseModel):
    playback_id: str = Field(min_length=1, max_length=128)
    occurred_at: datetime
    context: Literal["wave", "manual", "unknown"] = "unknown"

    @field_validator("occurred_at")
    @classmethod
    def validate_event_time(cls, value):
        if value.tzinfo is None or value > datetime.now(timezone.utc) + timedelta(minutes=5):
            raise ValueError("occurred_at must have a timezone and cannot be in the future")
        return value.astimezone(timezone.utc)


def _log_history(track_id: str, current_user: dict, payload: TrackHistoryRequest | None = None):
    track = db.get_track(track_id)
    if not track:
        from services.media_locations import ensure_track_in_db
        track = ensure_track_in_db(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Трек не найден")

    result = {"status": "logged", "track_id": track_id}
    try:
        if payload is None:
            db.add_history(current_user["id"], track_id)
        else:
            db.add_history(current_user["id"], track_id, playback_id=payload.playback_id,
                           occurred_at=payload.occurred_at.isoformat(), context=payload.context)
            result["playback_id"] = payload.playback_id
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except sqlite3.IntegrityError as exc:
        if (exc.sqlite_errorcode == sqlite3.SQLITE_CONSTRAINT_FOREIGNKEY
                and db.get_track(track_id) is None):
            raise HTTPException(status_code=404, detail="Трек не найден") from exc
        raise
    return result

@router.post("/tracks/{track_id}/history", summary="Зафиксировать факт прослушивания трека")
def log_history(track_id: str, current_user: dict = Depends(get_current_user)):
    return _log_history(track_id, current_user)


@router.put("/tracks/{track_id}/history", summary="Идемпотентно зафиксировать прослушивание")
def put_track_history(track_id: str, payload: TrackHistoryRequest,
                      current_user: dict = Depends(get_current_user)):
    return _log_history(track_id, current_user, payload)


@router.get("/history", summary="История последних прослушиваний")
def get_history(request: Request, limit: int = 50, current_user: dict = Depends(get_current_user)):
    base_url = get_base_url(request)
    raw_history = db.get_user_history(current_user["id"], limit=limit)
    fav_ids = db.get_favorite_track_ids(current_user["id"])
    return [serialize_track(r, base_url, fav_ids, include_lyrics=False) for r in raw_history]

# --- Дизлайки (Dislikes для алгоритма волны) ---

@router.post("/tracks/{track_id}/dislike", summary="Поставить дизлайк треку (скрыть из волны)")
def dislike_track(track_id: str, current_user: dict = Depends(get_current_user)):
    track = db.get_track(track_id)
    if not track:
        from services.media_locations import ensure_track_in_db
        track = ensure_track_in_db(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Трек не найден")
        
    db.add_dislike(current_user["id"], track_id)
    # Если трек был в лайках — автоматически убираем из лайков
    db.remove_favorite(current_user["id"], track_id)
    return {"status": "disliked", "track_id": track_id}

@router.delete("/tracks/{track_id}/dislike", summary="Снять дизлайк с трека")
def undislike_track(track_id: str, current_user: dict = Depends(get_current_user)):
    db.remove_dislike(current_user["id"], track_id)
    return {"status": "undisliked", "track_id": track_id}

@router.get("/dislikes", summary="Список ID треков с дизлайками пользователя")
def get_dislikes(current_user: dict = Depends(get_current_user)):
    dislikes = db.get_user_dislike_ids(current_user["id"])
    return list(dislikes)
