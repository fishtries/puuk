"""Library maintenance: scanning and basic track listings."""
import db
from auth import get_current_admin_user, get_current_user
from config import get_base_url
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from serializers import serialize_track
from services.library_service import scan_library as scan_library_impl

router = APIRouter(prefix="/api/library", tags=["library"])


@router.post("/scan")
def scan_library(current_user: dict = Depends(get_current_admin_user)):
    """Сканирует MUSIC_DIR, извлекает теги и заполняет базу SQLite. Только для администраторов."""
    try:
        return scan_library_impl()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Music directory not found")


@router.get("/tracks")
def get_all_tracks(
    request: Request,
    limit: int = Query(50, ge=0),
    offset: int = Query(0, ge=0),
    current_user: dict = Depends(get_current_user),
):
    """Возвращает страницу треков из базы данных SQLite (без lyrics) с персональными лайками."""
    try:
        records = db.get_tracks_page(limit=limit, offset=offset)
        fav_ids = db.get_favorite_track_ids(current_user["id"])
        base_url = get_base_url(request)
        return [serialize_track(r, base_url, fav_ids, include_lyrics=False) for r in records]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
