"""«Моя Волна» endpoints: next track, personalized queue."""
import random
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

import db
from auth import get_current_user
from config import WAVE_PERSONALIZATION_WEIGHT, get_base_url
from repositories.wave import recent_wave_exposure
from repositories.wave_openings import recent_openings, reserve_opening
from repositories.recording_reviews import blocked_track_ids
from services.offline_wave import rank_downloads
from services.media_locations import qdrant_point_id
from services import wave_mix
from services.recommendation_service import (
    build_wave_track_payload,
    client,
    get_smart_recommendations,
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


def _start_queue(user_id, last, limit, hard, recent, queued, *, trace=None):
    last = last or next(iter(db.get_user_listening_history(user_id, limit=1)), None)
    previous = None
    if last and (point_id := qdrant_point_id(last)) is not None:
        records = retrieve_track_point(point_id)
        previous = records[0] if records else None
    if last:
        hard = hard | {str(last)}
    exposure = recent_wave_exposure(user_id)
    avoid = recent | {tid for tid, (plays, skipped) in exposure.items() if plays >= 3 or skipped}
    withheld = avoid | set(recent_openings(user_id))
    points = wave_mix.mixed_queue(user_id, previous, True, max(limit, 8), hard, withheld, queued, trace=trace)
    if not points:
        return []
    ids = [str(p.id) for p in points]
    index = ids.index(reserve_opening(user_id, ids, avoid, queued))
    return [points[index], *points[:index], *points[index + 1:]][:limit]


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
    user_id = current_user["id"]
    dislike_ids = db.get_user_dislike_ids(user_id) | blocked_track_ids()
    exclude_ids = _normalize_exclude_ids(exclude_track_ids)
    queued_ids = _normalize_exclude_ids(queued_track_ids)
    if current_track_id.lower() == "random":
        points = _start_queue(user_id, None, 1, dislike_ids, exclude_ids, queued_ids)
        if not points:
            raise HTTPException(status_code=404, detail="Похожих треков не найдено.")
        return build_wave_track_payload(points[0], base_url, db.get_favorite_track_ids(user_id))

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
    return build_wave_track_payload(pick, base_url, fav_ids)


@router.get("/queue")
def get_wave_queue_endpoint(
    request: Request,
    current_track_id: str = Query(None, description="UUID текущего трека (или 'random' / None для холодного старта)"),
    limit: int = Query(10, ge=1, le=50),
    exclude_track_ids: list[str] = Query(default=[], description="ID недавно проигранных треков"),
    queued_track_ids: list[str] = Query(default=[], description="ID треков, уже стоящих в очереди клиента"),
    mode: Literal["start", "mix", "similar"] | None = None,
    previous_track_id: str | None = None,
    explain: bool = False,
    current_user: dict = Depends(get_current_user)
):
    """Возвращает персонализированную очередь треков Моей Волны."""
    base_url = get_base_url(request)
    user_id = current_user["id"]
    restart = mode == "start" or not current_track_id or current_track_id.lower() == "random"
    hard = db.get_user_dislike_ids(user_id) | blocked_track_ids()
    recent = _normalize_exclude_ids(exclude_track_ids)
    queued = _normalize_exclude_ids(queued_track_ids)
    trace = {} if explain else None
    if restart:
        recommendations = _start_queue(user_id, previous_track_id, limit, hard, recent, queued, trace=trace)
    else:
        try:
            existing = retrieve_track_point(current_track_id)
        except RuntimeError as e:
            raise HTTPException(status_code=500, detail=str(e))
        if not existing:
            raise HTTPException(status_code=404, detail=f"Трек {current_track_id} не найден.")
        queued.discard(current_track_id)
        if mode == "mix":
            recommendations = wave_mix.mixed_queue(user_id, existing[0], False, limit, hard, recent, queued, trace=trace)
        else:
            recommendations = get_smart_recommendations(
                current_track_id=current_track_id, limit=limit, existing_track=existing,
                dislike_ids=hard, exclude_ids=recent, queued_ids=queued, user_id=user_id,
                personalization_weight=WAVE_PERSONALIZATION_WEIGHT,
            )
            if explain:
                trace = {str(p.id): dict(anchor_id=current_track_id, source='current', mix_position=i)
                         for i, p in enumerate(recommendations, 1)}

    if not recommendations:
        return []

    fav_ids = db.get_favorite_track_ids(user_id)
    # Один batch-SELECT на пачку вместо db.get_track на каждый трек.
    ids = [str(pick.id) for pick in recommendations]
    lookup_ids = set(ids)
    if trace:
        lookup_ids.update(trace[tid]['anchor_id'] for tid in ids if tid in trace)
    tracks_by_id = db.get_tracks_by_ids(lookup_ids)
    result = []
    for position, pick in enumerate(recommendations, 1):
        tid = str(pick.id)
        track = build_wave_track_payload(pick, base_url, fav_ids, db_track=tracks_by_id.get(tid))
        if trace and tid in trace:
            origin = trace[tid]
            anchor = tracks_by_id.get(origin['anchor_id']) or {}
            track['wave_trace'] = dict(origin, anchor_title=anchor.get('title'), server_position=position)
        result.append(track)
    return result


class OfflineWaveLibrary(BaseModel):
    track_ids: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(max_length=512)


@router.post("/offline-plan")
def offline_wave_plan(library: OfflineWaveLibrary, current_user: dict = Depends(get_current_user)):
    return rank_downloads(current_user["id"], library.track_ids, client)
