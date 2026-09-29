"""«Моя Волна» endpoints: next track, personalized queue."""
import random
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request

import db
from auth import get_current_user
from config import WAVE_PERSONALIZATION_WEIGHT, get_base_url
from services import recommendation_service
from services.recommendation_service import (
    build_wave_track_payload,
    client,
    get_smart_recommendations,
    scroll_any_track,
    retrieve_track_point,
)

router = APIRouter(prefix="/api/wave", tags=["wave-recommendations"])

# Максимум исключаемых ID за один запрос (protection против раздутого клиента).
MAX_EXCLUDE_IDS = 100


def _normalize_exclude_ids(raw_ids: list[str] | None) -> set[str]:
    """Дедуплицирует и ограничивает список exclude_track_ids от клиента."""
    if not raw_ids:
        return set()
    cleaned = [track_id.strip() for track_id in raw_ids if track_id and track_id.strip()]
    return set(cleaned[-MAX_EXCLUDE_IDS:])


def _resolve_random_start():
    """Холодный старт /wave/next: случайный трек из коллекции. Возвращает (id, existing_records)."""
    records = scroll_any_track()
    if not records:
        raise HTTPException(status_code=404, detail="Коллекция пуста.")
    return records[0].id, records


@router.get("/next")
def get_next_track(
    request: Request,
    current_track_id: str = Query(..., description="UUID текущего трека (или 'random' для старта)"),
    exclude_track_ids: list[str] = Query(default=[], description="ID недавно проигранных треков"),
    queued_track_ids: list[str] = Query(default=[], description="ID треков, уже стоящих в очереди клиента"),
    current_user: dict = Depends(get_current_user)
):
    """Возвращает следующий трек для «Моей волны» на основе CLAP-эмбеддингов с учетом дизлайков."""
    base_url = get_base_url(request)
    existing = None

    if current_track_id.lower() == "random":
        current_track_id, existing = _resolve_random_start()

    try:
        uuid.UUID(current_track_id)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"ID '{current_track_id}' не является валидным UUID.")

    try:
        existing = retrieve_track_point(current_track_id, with_payload=True)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

    if not existing:
        raise HTTPException(status_code=404, detail=f"Трек {current_track_id} не найден.")

    dislike_ids = db.get_user_dislike_ids(current_user["id"])
    exclude_ids = _normalize_exclude_ids(exclude_track_ids)
    queued_ids = _normalize_exclude_ids(queued_track_ids)
    queued_ids.discard(str(current_track_id))

    recommendations = get_smart_recommendations(
        current_track_id=current_track_id,
        limit=5,
        existing_track=existing,
        dislike_ids=dislike_ids,
        exclude_ids=exclude_ids,
        queued_ids=queued_ids,
        user_id=current_user["id"],
        personalization_weight=WAVE_PERSONALIZATION_WEIGHT
    )

    if not recommendations:
        raise HTTPException(status_code=404, detail="Похожих треков не найдено.")

    pick = random.choice(recommendations[:3])
    fav_ids = db.get_favorite_track_ids(current_user["id"])
    return build_wave_track_payload(pick, base_url, fav_ids, include_album=True)


@router.get("/queue")
def get_wave_queue_endpoint(
    request: Request,
    current_track_id: str = Query(None, description="UUID текущего трека (или 'random' / None для холодного старта)"),
    limit: int = Query(10, ge=1, le=50),
    exclude_track_ids: list[str] = Query(default=[], description="ID недавно проигранных треков"),
    queued_track_ids: list[str] = Query(default=[], description="ID треков, уже стоящих в очереди клиента"),
    current_user: dict = Depends(get_current_user)
):
    """Возвращает персонализированную очередь треков Моей Волны."""
    base_url = get_base_url(request)
    user_id = current_user["id"]
    existing = None

    if not current_track_id or current_track_id.lower() == "random":
        recent_tracks = db.get_user_listening_history(user_id, limit=5)
        for tid in recent_tracks:
            try:
                pts = client.retrieve(collection_name=recommendation_service.COLLECTION_NAME, ids=[tid])
                if pts:
                    current_track_id = tid
                    existing = pts
                    break
            except Exception:
                continue

        if not existing:
            records = recommendation_service.scroll_random_ready_track()
            if not records:
                return []
            current_track_id = str(records[0].id)
            existing = records
    else:
        try:
            existing = retrieve_track_point(current_track_id)
        except RuntimeError as e:
            raise HTTPException(status_code=500, detail=str(e))

        if not existing:
            raise HTTPException(status_code=404, detail=f"Трек {current_track_id} не найден.")

    dislike_ids = db.get_user_dislike_ids(user_id)
    exclude_ids = _normalize_exclude_ids(exclude_track_ids)
    queued_ids = _normalize_exclude_ids(queued_track_ids)
    queued_ids.discard(str(current_track_id))

    recommendations = get_smart_recommendations(
        current_track_id=current_track_id,
        limit=limit,
        existing_track=existing,
        dislike_ids=dislike_ids,
        exclude_ids=exclude_ids,
        queued_ids=queued_ids,
        user_id=user_id,
        personalization_weight=WAVE_PERSONALIZATION_WEIGHT
    )

    if not recommendations:
        return []

    fav_ids = db.get_favorite_track_ids(user_id)
    # Один batch-SELECT на пачку вместо db.get_track на каждый трек.
    tracks_by_id = db.get_tracks_by_ids([str(pick.id) for pick in recommendations])
    return [
        build_wave_track_payload(pick, base_url, fav_ids, db_track=tracks_by_id.get(str(pick.id)))
        for pick in recommendations
    ]
