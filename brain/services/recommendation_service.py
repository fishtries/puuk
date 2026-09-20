"""«Моя Волна» recommendations: hybrid vector search, BPM re-ranking, diversity penalty."""
import random
from typing import Optional

import numpy as np
from qdrant_client import QdrantClient
from qdrant_client.models import RecommendQuery, RecommendInput, Filter, FieldCondition, MatchValue

import db
from config import QDRANT_URL, COLLECTION_NAME, WAVE_PERSONALIZATION_WEIGHT
from user_profile import get_or_compute_user_embedding

qdrant_client = QdrantClient(url=QDRANT_URL)

client = qdrant_client  # historical alias used by tests and internal callers


def apply_diversity_penalty(scored_points: list, recent_artists: list[str], penalty: float = 0.05) -> list:
    """
    Снижает скор треков исполнителей, которые уже звучали в последних прослушиваниях пользователя.
    Предотвращает зацикливание Моей Волны на одном исполнителе (diversity boost).
    """
    if not recent_artists:
        scored_points.sort(key=lambda x: x.score, reverse=True)
        return scored_points

    from collections import Counter
    artist_counts = Counter(recent_artists)

    adjusted = []
    for p in scored_points:
        cand_payload = p.payload or {}
        artist = cand_payload.get("artist")
        if not artist:
            db_tr = db.get_track(str(p.id))
            artist = db_tr.get("artist") if db_tr else None

        if artist:
            reps = artist_counts.get(artist, 0)
            if reps > 0:
                p.score -= (penalty * reps)
        adjusted.append(p)

    adjusted.sort(key=lambda x: x.score, reverse=True)
    return adjusted


def get_smart_recommendations(
    current_track_id: str,
    limit: int,
    existing_track,
    dislike_ids: set = None,
    user_id: Optional[int] = None,
    personalization_weight: float = WAVE_PERSONALIZATION_WEIGHT
) -> list:
    """
    Гибридные векторные рекомендации:
    blend(current_track, user_embedding) с учетом BPM и штрафа за повторы исполнителей (diversity boost).
    """
    # Определяем базовые значения
    if isinstance(existing_track, list) and existing_track:
        payload = existing_track[0].payload
    else:
        payload = existing_track.payload if hasattr(existing_track, 'payload') else {}

    base_bpm = payload.get("bpm", 0)

    # 1. Извлекаем вектор текущего трека
    current_vector = None
    try:
        current_points = client.retrieve(
            collection_name=COLLECTION_NAME,
            ids=[current_track_id],
            with_vectors=True
        )
        if current_points and current_points[0].vector is not None:
            current_vector = np.array(current_points[0].vector, dtype=np.float32)
    except Exception as e:
        print(f"[SmartRec] Warning retrieving current track vector {current_track_id}: {e}")

    # 2. Если есть вектор трека — строим запрос (смешанный либо чистый)
    query_target = None
    if current_vector is not None:
        query_vector = current_vector
        if user_id is not None and personalization_weight > 0.0:
            user_vec = get_or_compute_user_embedding(user_id, client)
            if user_vec is not None:
                # Blend: (1 - w) * current + w * user_vector
                query_vector = (1.0 - personalization_weight) * current_vector + personalization_weight * user_vec
                norm = np.linalg.norm(query_vector)
                if norm > 0:
                    query_vector = query_vector / norm
        query_target = query_vector.tolist()

    # 3. Выполняем векторный запрос в Qdrant
    if query_target is not None:
        results = client.query_points(
            collection_name=COLLECTION_NAME,
            query=query_target,
            query_filter=Filter(
                must=[
                    FieldCondition(
                        key="needs_embedding",
                        match=MatchValue(value=False)
                    )
                ]
            ),
            limit=max(50, limit * 3),
            with_payload=True,
        )
    else:
        # Fallback на RecommendQuery по ID трека
        results = client.query_points(
            collection_name=COLLECTION_NAME,
            query=RecommendQuery(
                recommend=RecommendInput(positive=[current_track_id], negative=[])
            ),
            query_filter=Filter(
                must=[
                    FieldCondition(
                        key="needs_embedding",
                        match=MatchValue(value=False)
                    )
                ]
            ),
            limit=max(50, limit * 3),
            with_payload=True,
        )

    # 4. BPM re-ranking и исключение самого трека и дизлайков
    scored_points = []
    for p in results.points:
        if str(p.id) == str(current_track_id):
            continue
        if dislike_ids and str(p.id) in dislike_ids:
            continue
        cand_payload = p.payload or {}

        t_bpm = cand_payload.get("bpm", base_bpm)
        if t_bpm == 0 or base_bpm == 0:
            bpm_diff = 0
        else:
            diff1 = abs(t_bpm - base_bpm)
            diff2 = abs(t_bpm - base_bpm * 2)
            diff3 = abs(t_bpm - base_bpm / 2)
            bpm_diff = min(diff1, diff2, diff3)

        penalty = bpm_diff * 0.005
        adjusted_score = p.score - penalty
        p.score = adjusted_score
        scored_points.append(p)

    # 5. Diversity penalty (избегание повторения недавних артистов)
    if user_id:
        recent_artists = db.get_recent_artists(user_id, limit=5)
        scored_points = apply_diversity_penalty(scored_points, recent_artists, penalty=0.05)
    else:
        scored_points.sort(key=lambda x: x.score, reverse=True)

    return scored_points[:limit]


def retrieve_track_point(track_id: str, with_payload: bool = True):
    """Возвращает список точек Qdrant для трека или пустой список."""
    try:
        return client.retrieve(
            collection_name=COLLECTION_NAME,
            ids=[track_id],
            with_payload=with_payload,
        )
    except Exception as exc:
        raise RuntimeError(str(exc))


def scroll_random_ready_track():
    """Случайный готовый трек (needs_embedding=false) из Qdrant с fallback на всю коллекцию."""
    records, _ = client.scroll(
        collection_name=COLLECTION_NAME,
        scroll_filter=Filter(
            must=[FieldCondition(key="needs_embedding", match=MatchValue(value=False))]
        ),
        limit=1,
        with_payload=True,
        with_vectors=False,
    )
    if not records:
        records, _ = client.scroll(collection_name=COLLECTION_NAME, limit=1, with_payload=True, with_vectors=False)
    return records


def scroll_any_track():
    """Простой scroll первой точки коллекции (используется холодным стартом /wave/next)."""
    records, _ = client.scroll(collection_name=COLLECTION_NAME, limit=1, with_payload=True, with_vectors=False)
    return records


def build_wave_track_payload(pick, base_url: str, fav_ids: set[str], include_album: bool = False) -> dict:
    """Формирует JSON-ответ трека Волны из точки Qdrant с обогащением из SQLite."""
    track_id = str(pick.id)
    db_track = db.get_track(track_id)
    if not db_track:
        from services.media_locations import extract_full_metadata
        title, artist, _, _, duration = extract_full_metadata(pick.payload.get("file_path", ""))
        file_path = pick.payload.get("file_path", "")
        cover_color = None
    else:
        title = db_track['title']
        artist = db_track['artist']
        file_path = db_track['file_path']
        cover_color = db_track.get('cover_color')
        duration = db_track.get('duration')

    payload = {
        "id": track_id,
        "track_id": track_id,
        "title": title,
        "artist": artist,
        "duration": duration,
        "file_path": file_path,
        "bpm": pick.payload.get("bpm"),
        "stream_url": f"{base_url}/api/stream/{track_id}",
        "coverArt": f"{base_url}/api/cover/{track_id}",
        "cover_color": cover_color,
        "is_liked": track_id in fav_ids,
        "score": round(pick.score, 3),
    }
    if include_album:
        payload["album"] = None
    return payload
