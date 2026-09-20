"""Playlist endpoints: CRUD and track membership with owner/admin RBAC."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

import db
from auth import get_current_user
from config import get_base_url
from serializers import serialize_track

router = APIRouter(prefix="/api/playlists", tags=["playlists"])


class PlaylistCreate(BaseModel):
    name: str
    is_public: bool = False


class TrackAdd(BaseModel):
    track_id: str


class PlaylistEditPayload(BaseModel):
    name: str
    is_public: Optional[bool] = None


def _require_owned_playlist(playlist_id: int, current_user: dict, action_error: str):
    playlist = db.get_playlist(playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if playlist.get("user_id") != current_user["id"] and current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail=action_error)
    return playlist


@router.get("")
def get_all_playlists(current_user: dict = Depends(get_current_user)):
    """Возвращает плейлисты текущего пользователя и публичные плейлисты."""
    return db.get_all_playlists(user_id=current_user["id"])


@router.post("")
def create_playlist(payload: PlaylistCreate, current_user: dict = Depends(get_current_user)):
    """Создает новый плейлист, привязанный к текущему пользователю."""
    playlist_id = db.create_playlist(payload.name, user_id=current_user["id"], is_public=payload.is_public)
    return {
        "id": playlist_id,
        "name": payload.name,
        "user_id": current_user["id"],
        "is_public": payload.is_public
    }


@router.get("/{playlist_id}")
def get_playlist_details(playlist_id: int, request: Request, current_user: dict = Depends(get_current_user)):
    playlist = db.get_playlist(playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")

    # Проверка доступа к приватному плейлисту
    if not playlist.get("is_public") and playlist.get("user_id") != current_user["id"] and current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Доступ к данному плейлисту ограничен")

    records = db.get_playlist_tracks(playlist_id)
    fav_ids = db.get_favorite_track_ids(current_user["id"])
    base_url = get_base_url(request)
    tracks = [serialize_track(r, base_url, fav_ids) for r in records]
    return {"playlist": playlist, "tracks": tracks}


@router.patch("/{playlist_id}")
def update_playlist(playlist_id: int, payload: PlaylistEditPayload, current_user: dict = Depends(get_current_user)):
    """Обновляет название и публичность плейлиста (только владелец или админ)."""
    _require_owned_playlist(playlist_id, current_user, "Вы можете редактировать только свои плейлисты")
    db.update_playlist(playlist_id, payload.name, is_public=payload.is_public)
    return {"status": "success"}


@router.delete("/{playlist_id}")
def delete_playlist(playlist_id: int, current_user: dict = Depends(get_current_user)):
    """Удаляет плейлист (только владелец или админ)."""
    _require_owned_playlist(playlist_id, current_user, "Вы можете удалять только свои плейлисты")
    db.delete_playlist(playlist_id)
    return {"status": "success"}


@router.post("/{playlist_id}/tracks")
def add_track_to_playlist(playlist_id: int, payload: TrackAdd, current_user: dict = Depends(get_current_user)):
    _require_owned_playlist(playlist_id, current_user, "Вы можете изменять только свои плейлисты")
    success = db.add_track_to_playlist(playlist_id, payload.track_id)
    if not success:
        return {"status": "already_exists"}
    return {"status": "added"}


@router.delete("/{playlist_id}/tracks/{track_id}")
def remove_track_from_playlist(playlist_id: int, track_id: str, current_user: dict = Depends(get_current_user)):
    _require_owned_playlist(playlist_id, current_user, "Вы можете изменять только свои плейлисты")
    db.remove_track_from_playlist(playlist_id, track_id)
    return {"status": "removed"}
