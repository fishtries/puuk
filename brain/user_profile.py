import os
import sys
from datetime import datetime, timezone
from typing import Optional
import numpy as np
from qdrant_client import QdrantClient

# Ensure brain path is available
sys.path.insert(0, os.path.dirname(__file__))
import db
from repositories.wave import get_taste_revision, taste_snapshot
from services.taste_profile import track_weights, centroid, instant

COLLECTION_NAME = "tracks"

def compute_user_embedding(
    user_id: int, 
    qdrant_client: QdrantClient,
    max_history: int = 100,
    like_weight: float = 2.0
) -> Optional[np.ndarray]:
    """400-dimensional taste centroid with bounded repeats and active-day decay.

    Explicit dislikes exclude tracks. Context weakens browsing skips; no Qdrant
    schema or candidate selection behavior changes here.
    """
    snapshot = taste_snapshot(user_id, limit=max(100, min(max_history * 20, 2000)))
    weights = track_weights(snapshot, like_weight=like_weight)
    if not weights:
        return None
    try:
        points = []
        ids = list(weights)
        for offset in range(0, len(ids), 256):
            points.extend(qdrant_client.retrieve(
                collection_name=COLLECTION_NAME, ids=ids[offset:offset+256], with_vectors=True))
    except Exception as exc:
        print(f"[UserProfile] Qdrant unavailable: {exc}")
        return None
    return centroid({str(p.id):p.vector for p in points if p.vector is not None}, weights)

def _usable_fallback(user_id, cached):
    # Keep a stale vector during a Qdrant outage, but not after the last
    # positive signal was removed or explicitly disliked.
    return cached if track_weights(taste_snapshot(user_id)) else None


def get_or_compute_user_embedding(user_id: int, qdrant_client: QdrantClient) -> Optional[np.ndarray]:
    """
    Возвращает кэшированный эмбеддинг пользователя из SQLite.
    Если кэш отсутствует, вычисляет и сохраняет его в БД.
    """
    cached = db.get_user_embedding(user_id)
    if cached is not None and not should_recompute_embedding(user_id):
        return cached

    revision = get_taste_revision(user_id)
    computed = compute_user_embedding(user_id, qdrant_client)
    if computed is not None:
        history_tracks = db.get_user_listening_history(user_id, limit=100)
        db.set_user_embedding(user_id, computed, len(history_tracks), source_revision=revision)
    return computed if computed is not None else _usable_fallback(user_id, cached)

def get_or_compute_user_embedding_fresh(
    user_id: int,
    qdrant_client: QdrantClient,
    threshold: int = 10,
    hours: int = 24,
) -> Optional[np.ndarray]:
    """Возвращает актуальный эмбеддинг пользователя с учётом свежести.

    В отличие от get_or_compute_user_embedding() (возвращает кэш без проверки),
    пересчитывает вектор, если профиль устарел по should_recompute_embedding().
    При недоступности Qdrant/пустой истории возвращает None (или кэш как fallback).
    """
    if should_recompute_embedding(user_id, threshold=threshold, hours=hours):
        revision = get_taste_revision(user_id)
        computed = compute_user_embedding(user_id, qdrant_client)
        if computed is not None:
            history_tracks = db.get_user_listening_history(user_id, limit=100)
            db.set_user_embedding(user_id, computed, len(history_tracks), source_revision=revision)
            return computed
        # Qdrant недоступен / пустая история — не теряем уже кэшированный вектор,
        # чтобы ранжирование не деградировало до SQLite-порядка.
        return _usable_fallback(user_id, db.get_user_embedding(user_id))
    return get_or_compute_user_embedding(user_id, qdrant_client)


def should_recompute_embedding(user_id: int, threshold: int = 10, hours: int = 24) -> bool:
    """
    Проверяет, нужно ли пересчитать профиль пользователя:
    1. Если профиль еще не создан.
    2. Если добавлено >= threshold новых треков.
    3. Если прошло >= hours часов с последнего обновления.
    """
    cached = db.get_user_embedding_metadata(user_id)
    if cached is None:
        return True

    # 1. Проверка по количеству новых прослушиваний
    revision = cached.get("source_revision")
    if revision is None or get_taste_revision(user_id) - revision >= threshold:
        return True

    updated_at = cached.get('updated_at')
    if updated_at:
        try:
            return (datetime.now(timezone.utc) - instant(updated_at)).total_seconds() >= hours * 3600
        except (ValueError, TypeError):
            return True  # corrupt timestamps must not pin a stale profile

    return False

def update_user_embedding_async(user_id: int, qdrant_client: QdrantClient):
    """
    Фоновый пересчет вектора пользователя и сохранение в БД.
    """
    try:
        revision = get_taste_revision(user_id)
        embedding = compute_user_embedding(user_id, qdrant_client)
        if embedding is not None:
            track_count = len(db.get_user_listening_history(user_id, limit=100))
            db.set_user_embedding(user_id, embedding, track_count, source_revision=revision)
            print(f"[UserProfile] Профиль вкусов пользователя #{user_id} успешно обновлен ({track_count} треков).")
    except Exception as e:
        print(f"[UserProfile] Ошибка при фоновом обновлении профиля пользователя #{user_id}: {e}")
