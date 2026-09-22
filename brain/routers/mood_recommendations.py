"""Эндпоинты «You'll like this»: каталог настроений и генерация mood-плейлистов."""
from fastapi import APIRouter, Depends, HTTPException, Query, Request

import db
from auth import get_current_user
from config import get_base_url
from mood_profiles import DEFAULT_MOODS, MOODS
from services import mood_recommendation_service
from services.mood_recommendation_service import generate_mood_playlist
from services.recommendation_service import build_wave_track_payload

router = APIRouter(prefix="/api/recommendations", tags=["mood-recommendations"])

MAX_EXCLUDE_IDS = 100


def _normalize_ids(raw_ids: list[str] | None) -> set[str]:
    if not raw_ids:
        return set()
    cleaned = [i.strip() for i in raw_ids if i and i.strip()]
    return set(cleaned[-MAX_EXCLUDE_IDS:])


@router.get("/moods")
def list_moods():
    """Возвращает каталог доступных настроений."""
    return [
        {"id": mood_id, "title": mood["title"], "description": mood["description"]}
        for mood_id, mood in MOODS.items()
    ]


@router.get("/moods/{mood_id}/playlist")
def get_mood_playlist(
    request: Request,
    mood_id: str,
    limit: int = Query(20, ge=1, le=50),
    save: bool = Query(False, description="Сохранить результат как пользовательский плейлист"),
    exclude_track_ids: list[str] = Query(default=[], description="ID недавно проигранных треков"),
    queued_track_ids: list[str] = Query(default=[], description="ID треков в очереди клиента"),
    current_user: dict = Depends(get_current_user),
):
    """Генерирует персональный плейлист под настроение mood_id."""
    mood = MOODS.get(mood_id)
    if not mood:
        raise HTTPException(status_code=404, detail=f"Настроение '{mood_id}' не найдено.")

    base_url = get_base_url(request)
    user_id = current_user["id"]
    dislike_ids = db.get_user_dislike_ids(user_id)
    exclude_ids = _normalize_ids(exclude_track_ids)
    queued_ids = _normalize_ids(queued_track_ids)

    recommendations = generate_mood_playlist(
        mood_id=mood_id,
        limit=limit,
        user_id=user_id,
        dislike_ids=dislike_ids,
        exclude_ids=exclude_ids,
        queued_ids=queued_ids,
    )

    fav_ids = db.get_favorite_track_ids(user_id)
    tracks = [build_wave_track_payload(p, base_url, fav_ids) for p in recommendations]

    playlist_id = None
    playlist_name = f"{mood['title']} mix"
    if save:
        playlist_id = db.create_playlist(playlist_name, user_id=user_id, is_public=False)
        for p in recommendations:
            db.add_track_to_playlist(playlist_id, str(p.id))

    return {
        "mood": {"id": mood_id, "title": mood["title"]},
        "playlist": {"id": playlist_id, "name": playlist_name},
        "tracks": tracks,
    }


@router.get("/youll-like-this")
def youll_like_this(
    request: Request,
    moods: str = Query(",".join(DEFAULT_MOODS), description="Список mood_id через запятую"),
    limit: int = Query(8, ge=1, le=30),
    current_user: dict = Depends(get_current_user),
):
    """Агрегирующий эндпоинт: несколько mood-подборок одной пачкой для главной."""
    base_url = get_base_url(request)
    user_id = current_user["id"]
    dislike_ids = db.get_user_dislike_ids(user_id)
    fav_ids = db.get_favorite_track_ids(user_id)

    mood_ids = [m.strip() for m in moods.split(",") if m.strip()]
    sections = []
    for mood_id in mood_ids:
        mood = MOODS.get(mood_id)
        if not mood:
            continue
        recommendations = generate_mood_playlist(
            mood_id=mood_id,
            limit=limit,
            user_id=user_id,
            dislike_ids=dislike_ids,
        )
        tracks = [build_wave_track_payload(p, base_url, fav_ids) for p in recommendations]
        sections.append(
            {
                "type": "mood_playlist",
                "mood": mood_id,
                "title": f"{mood['title']} for you",
                "tracks": tracks,
            }
        )

    return {"sections": sections}
