"""Генерация плейлистов под настроение («You'll like this»).

Mood-вектор строится как среднее CLAP-эмбеддингов seed-треков (см. mood_profiles.py)
и кэшируется в памяти с TTL. Финальная пачка получается через тот же
query_points + diversity/exclude-механики, что и «Моя Волна»:
    services.recommendation_service.select_diverse_recommendations,
    apply_diversity_penalty, build_wave_track_payload.
"""
import time
from typing import Optional

import numpy as np
from qdrant_client.models import Filter, FieldCondition, MatchValue

import db
from config import COLLECTION_NAME, WAVE_EXPLORE_RATIO, WAVE_PERSONALIZATION_WEIGHT
from mood_profiles import MOODS
from services import recommendation_service
from services.recommendation_service import (
    CANDIDATE_POOL_CEILING,
    CANDIDATE_POOL_FLOOR,
    CANDIDATE_POOL_MULTIPLIER,
    SELECT_BAND_SCORE_EPS,
    _ArtistResolver,
    _merge_candidate_points,
    apply_diversity_penalty,
    client,
    select_diverse_recommendations,
)
from user_profile import get_or_compute_user_embedding

# Кэш mood-векторов: id -> (vector, timestamp). Обновляется раз в час.
MOOD_VECTOR_TTL_SECONDS = 3600
_mood_vector_cache: dict[str, Optional[np.ndarray]] = {}
_mood_vector_ts: dict[str, float] = {}


def _resolve_mood_seed_ids(mood: dict) -> list[str]:
    """Матчит seed-ключевые слова mood по artist/title/genre/album в SQLite."""
    keywords = [str(k).casefold() for k in mood.get("seed_keywords", []) if k]
    if not keywords:
        return []
    try:
        tracks = db.get_all_tracks()
    except Exception as e:
        print(f"[MoodRec] Warning resolving seeds: {e}")
        return []

    matched = []
    for t in tracks:
        haystack = " ".join(
            str(t.get(f) or "") for f in ("title", "artist", "genre", "album")
        ).casefold()
        if any(k in haystack for k in keywords):
            matched.append(str(t["id"]))
    return matched


def _compute_mood_vector(mood_id: str, mood: dict) -> Optional[np.ndarray]:
    """Строит нормализованный mood-вектор из CLAP-эмбеддингов seed-треков."""
    seed_ids = _resolve_mood_seed_ids(mood)
    if not seed_ids:
        # Fallback: случайный готовый трек, чтобы mood всё же имел якорь.
        picked = recommendation_service.scroll_random_ready_track()
        if not picked:
            return None
        seed_ids = [str(picked[0].id)]

    try:
        points = client.retrieve(
            collection_name=COLLECTION_NAME,
            ids=seed_ids,
            with_vectors=True,
        )
    except Exception as e:
        print(f"[MoodRec] Warning retrieving mood '{mood_id}' vectors: {e}")
        return None

    vecs = [np.array(p.vector, dtype=np.float32) for p in points if p.vector is not None]
    if not vecs:
        return None

    mean = np.mean(vecs, axis=0).astype(np.float32)
    norm = np.linalg.norm(mean)
    if norm > 0:
        mean = mean / norm
    return mean


def get_mood_vector(mood_id: str, force: bool = False) -> Optional[np.ndarray]:
    """Возвращает mood-вектор из кэша (с TTL) или пересчитывает его."""
    mood = MOODS.get(mood_id)
    if not mood:
        return None

    now = time.time()
    cached = _mood_vector_cache.get(mood_id)
    if cached is not None and not force and now - _mood_vector_ts.get(mood_id, 0.0) < MOOD_VECTOR_TTL_SECONDS:
        return cached

    vec = _compute_mood_vector(mood_id, mood)
    _mood_vector_cache[mood_id] = vec
    _mood_vector_ts[mood_id] = now
    return vec


def generate_mood_playlist(
    mood_id: str,
    limit: int = 20,
    user_id: Optional[int] = None,
    personalization_weight: float = WAVE_PERSONALIZATION_WEIGHT,
    dislike_ids: Optional[set] = None,
    exclude_ids: Optional[set] = None,
    queued_ids: Optional[set] = None,
) -> list:
    """
    Возвращает список точек Qdrant под настроение mood_id.

    Запрос идёт по blend(mood_vector, user_vector), затем применяются
    те же уровни исключений и diversity-фильтры, что и в «Моей Волне».
    """
    mood_vec = get_mood_vector(mood_id)
    if mood_vec is None:
        return []

    user_vec = None
    if user_id is not None:
        try:
            user_vec = get_or_compute_user_embedding(user_id, client)
        except Exception as e:
            print(f"[MoodRec] Warning computing user embedding: {e}")

    query_vector = mood_vec
    if user_vec is not None and personalization_weight > 0.0:
        blended = (1.0 - personalization_weight) * mood_vec + personalization_weight * user_vec
        norm = np.linalg.norm(blended)
        if norm > 0:
            blended = blended / norm
        query_vector = blended

    candidate_limit = min(
        CANDIDATE_POOL_CEILING,
        max(CANDIDATE_POOL_FLOOR, limit * CANDIDATE_POOL_MULTIPLIER),
    )
    ready_filter = Filter(
        must=[FieldCondition(key="needs_embedding", match=MatchValue(value=False))]
    )

    try:
        results = client.query_points(
            collection_name=COLLECTION_NAME,
            query=query_vector.tolist(),
            query_filter=ready_filter,
            limit=candidate_limit,
            with_payload=True,
        )
    except Exception as e:
        print(f"[MoodRec] Warning querying mood '{mood_id}': {e}")
        return []

    candidate_points = list(results.points)

    # Exploration-пул от чистого вектора вкуса (как в Волне).
    if user_vec is not None and WAVE_EXPLORE_RATIO > 0:
        explore_limit = max(1, int(candidate_limit * WAVE_EXPLORE_RATIO))
        try:
            explore_results = client.query_points(
                collection_name=COLLECTION_NAME,
                query=user_vec.tolist(),
                query_filter=ready_filter,
                limit=explore_limit,
                with_payload=True,
            )
            candidate_points = _merge_candidate_points(candidate_points, explore_results.points)
        except Exception as e:
            print(f"[MoodRec] Warning explore pool: {e}")

    dislike_ids = dislike_ids or set()
    exclude_ids = exclude_ids or set()
    queued_ids = queued_ids or set()

    resolver = _ArtistResolver()
    scored_points: list = []
    recent_excluded: list = []
    queued_excluded: list = []
    seen_ids: set = set()

    for p in candidate_points:
        tid = str(p.id)
        if tid in seen_ids:
            continue
        if dislike_ids and tid in dislike_ids:
            continue
        seen_ids.add(tid)

        if tid in queued_ids:
            queued_excluded.append(p)
        elif tid in exclude_ids:
            recent_excluded.append(p)
        else:
            scored_points.append(p)

    recent_artists = db.get_recent_artists(user_id, limit=5) if user_id else []

    if recent_artists:
        scored_points = apply_diversity_penalty(scored_points, recent_artists, penalty=0.05, resolver=resolver)
    else:
        scored_points.sort(key=lambda x: x.score, reverse=True)

    selected = select_diverse_recommendations(
        scored_points, limit, resolver=resolver, band_score_eps=SELECT_BAND_SCORE_EPS
    )

    # Мягкое ослабление исключений строго по уровням: recent -> queued.
    for candidates in (recent_excluded, queued_excluded):
        if len(selected) >= limit or not candidates:
            continue
        if recent_artists:
            candidates = apply_diversity_penalty(candidates, recent_artists, penalty=0.05, resolver=resolver)
        else:
            candidates.sort(key=lambda x: x.score, reverse=True)

        chosen = {str(p.id) for p in selected}
        for point in candidates:
            if len(selected) >= limit:
                break
            if str(point.id) in chosen:
                continue
            selected.append(point)
            chosen.add(str(point.id))

    return selected
