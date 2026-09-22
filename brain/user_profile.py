import os
import sys
from datetime import datetime
from typing import Optional
import numpy as np
from qdrant_client import QdrantClient

# Ensure brain path is available
sys.path.insert(0, os.path.dirname(__file__))
import db

COLLECTION_NAME = "tracks"

def compute_user_embedding(
    user_id: int, 
    qdrant_client: QdrantClient,
    max_history: int = 100,
    like_weight: float = 2.0
) -> Optional[np.ndarray]:
    """
    Строит 400-мерный вектор вкусов пользователя как взвешенное среднее
    векторов прослушанных и добавленных в избранное треков.

    Стратегия:
    1. Запрашиваем треки из позитивной истории и лайков.
    2. Извлекаем их векторы из Qdrant пакетом.
    3. Лайки весят в 2.0 раза больше обычных прослушиваний.
    4. Нормализуем результат по L2 для косинусной метрики сходства.
    """
    history_track_ids = db.get_user_listening_history(user_id, limit=max_history)
    liked_track_ids = list(db.get_favorite_track_ids(user_id))

    if not history_track_ids and not liked_track_ids:
        return None  # Холодный старт без истории

    # Уникальные ID треков для пакетного извлечения
    all_ids = list(set(history_track_ids + liked_track_ids))
    try:
        points = qdrant_client.retrieve(
            collection_name=COLLECTION_NAME,
            ids=all_ids,
            with_vectors=True
        )
    except Exception as e:
        print(f"[UserProfile] Ошибка извлечения векторов из Qdrant: {e}")
        return None

    if not points:
        return None

    weighted_sum = np.zeros(400, dtype=np.float32)
    total_weight = 0.0
    liked_set = set(liked_track_ids)

    for point in points:
        if point.vector is None:
            continue
        
        vec = np.array(point.vector, dtype=np.float32)
        weight = like_weight if str(point.id) in liked_set else 1.0
        weighted_sum += vec * weight
        total_weight += weight

    if total_weight == 0.0:
        return None

    user_vector = weighted_sum / total_weight

    # L2-нормализация для Cosine Similarity
    norm = np.linalg.norm(user_vector)
    if norm > 0:
        user_vector = user_vector / norm

    return user_vector

def get_or_compute_user_embedding(user_id: int, qdrant_client: QdrantClient) -> Optional[np.ndarray]:
    """
    Возвращает кэшированный эмбеддинг пользователя из SQLite.
    Если кэш отсутствует, вычисляет и сохраняет его в БД.
    """
    cached = db.get_user_embedding(user_id)
    if cached is not None:
        return cached

    computed = compute_user_embedding(user_id, qdrant_client)
    if computed is not None:
        history_tracks = db.get_user_listening_history(user_id, limit=100)
        db.set_user_embedding(user_id, computed, len(history_tracks))
    return computed

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
        computed = compute_user_embedding(user_id, qdrant_client)
        if computed is not None:
            history_tracks = db.get_user_listening_history(user_id, limit=100)
            db.set_user_embedding(user_id, computed, len(history_tracks))
            return computed
        # Qdrant недоступен / пустая история — не теряем уже кэшированный вектор,
        # чтобы ранжирование не деградировало до SQLite-порядка.
        return db.get_user_embedding(user_id)
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
    current_count = len(db.get_user_listening_history(user_id, limit=100))
    if current_count - cached["track_count"] >= threshold:
        return True

    # 2. Проверка по времени (свежесть профиля)
    updated_at_val = cached.get("updated_at")
    if updated_at_val:
        try:
            if isinstance(updated_at_val, str):
                for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S"):
                    try:
                        updated_dt = datetime.strptime(updated_at_val.split(".")[0], fmt)
                        break
                    except ValueError:
                        continue
                else:
                    updated_dt = datetime.now()
            else:
                updated_dt = updated_at_val

            elapsed_seconds = (datetime.now() - updated_dt).total_seconds()
            if elapsed_seconds >= hours * 3600:
                return True
        except Exception:
            pass

    return False

def update_user_embedding_async(user_id: int, qdrant_client: QdrantClient):
    """
    Фоновый пересчет вектора пользователя и сохранение в БД.
    """
    try:
        embedding = compute_user_embedding(user_id, qdrant_client)
        if embedding is not None:
            track_count = len(db.get_user_listening_history(user_id, limit=100))
            db.set_user_embedding(user_id, embedding, track_count)
            print(f"[UserProfile] Профиль вкусов пользователя #{user_id} успешно обновлен ({track_count} треков).")
    except Exception as e:
        print(f"[UserProfile] Ошибка при фоновом обновлении профиля пользователя #{user_id}: {e}")
