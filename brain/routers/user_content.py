from fastapi import APIRouter, Depends, HTTPException, Request, status
from typing import List, Optional
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
async def like_track(track_id: str, current_user: dict = Depends(get_current_user)):
    track = db.get_track(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Трек не найден")
    
    db.add_favorite(current_user["id"], track_id)
    return {"status": "liked", "track_id": track_id, "is_liked": True}

@router.delete("/tracks/{track_id}/like", summary="Удалить трек из избранного")
async def unlike_track(track_id: str, current_user: dict = Depends(get_current_user)):
    db.remove_favorite(current_user["id"], track_id)
    return {"status": "unliked", "track_id": track_id, "is_liked": False}

from serializers import serialize_track

@router.get("/favorites", summary="Получить список избранных треков пользователя")
async def get_favorites(request: Request, current_user: dict = Depends(get_current_user)):
    base_url = get_base_url(request)
    raw_tracks = db.get_user_favorites(current_user["id"])
    fav_ids = {r["id"] for r in raw_tracks}
    return [serialize_track(r, base_url, fav_ids) for r in raw_tracks]

# --- История прослушиваний (History) ---

@router.post("/tracks/{track_id}/history", summary="Зафиксировать факт прослушивания трека")
async def log_history(track_id: str, current_user: dict = Depends(get_current_user)):
    track = db.get_track(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Трек не найден")
        
    db.add_history(current_user["id"], track_id)
    return {"status": "logged", "track_id": track_id}

@router.get("/history", summary="История последних прослушиваний")
async def get_history(request: Request, limit: int = 50, current_user: dict = Depends(get_current_user)):
    base_url = get_base_url(request)
    raw_history = db.get_user_history(current_user["id"], limit=limit)
    fav_ids = db.get_favorite_track_ids(current_user["id"])
    return [serialize_track(r, base_url, fav_ids) for r in raw_history]

# --- Дизлайки (Dislikes для алгоритма волны) ---

@router.post("/tracks/{track_id}/dislike", summary="Поставить дизлайк треку (скрыть из волны)")
async def dislike_track(track_id: str, current_user: dict = Depends(get_current_user)):
    track = db.get_track(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Трек не найден")
        
    db.add_dislike(current_user["id"], track_id)
    # Если трек был в лайках — автоматически убираем из лайков
    db.remove_favorite(current_user["id"], track_id)
    return {"status": "disliked", "track_id": track_id}

@router.delete("/tracks/{track_id}/dislike", summary="Снять дизлайк с трека")
async def undislike_track(track_id: str, current_user: dict = Depends(get_current_user)):
    db.remove_dislike(current_user["id"], track_id)
    return {"status": "undisliked", "track_id": track_id}

@router.get("/dislikes", summary="Список ID треков с дизлайками пользователя")
async def get_dislikes(current_user: dict = Depends(get_current_user)):
    dislikes = db.get_user_dislike_ids(current_user["id"])
    return list(dislikes)
