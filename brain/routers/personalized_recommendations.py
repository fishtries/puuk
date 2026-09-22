"""Эндпоинт «You'll like this»: персональные жанровые подборки."""
from fastapi import APIRouter, Depends, Query, Request

from auth import get_current_user
from config import get_base_url
from services.personalized_recommendation_service import get_personalized_genre_sections

router = APIRouter(prefix="/api/recommendations", tags=["personalized-recommendations"])


@router.get("/youll-like-this")
def youll_like_this(
    request: Request,
    limit: int = Query(20, ge=1, le=20, description="Треков в каждой секции"),
    sections: int = Query(3, ge=1, le=3, description="Максимум жанровых секций"),
    current_user: dict = Depends(get_current_user),
):
    """Агрегирующий эндпоинт: жанровые подборки одной пачкой для главной."""
    base_url = get_base_url(request)
    result = get_personalized_genre_sections(
        current_user["id"], section_limit=sections, track_limit=limit, base_url=base_url
    )
    return {"sections": result}
