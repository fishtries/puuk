import os
import sqlite3
import sys
import time
from collections import defaultdict
from threading import Lock
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Request, status
from pydantic import BaseModel, Field, field_validator
from datetime import datetime, timezone, timedelta
from repositories.wave import record_listening_event

# Ensure brain path is available
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import db
from auth import get_current_admin_user, get_current_user
from user_profile import should_recompute_embedding, update_user_embedding_async
from qdrant_client import QdrantClient

from config import QDRANT_URL, SERVER_IP

router = APIRouter(prefix="/api/wave", tags=["wave"])

# In-memory sliding window rate limiter
class InMemoryRateLimiter:
    def __init__(self, max_requests: int = 100, window_seconds: int = 60):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.requests = defaultdict(list)
        self.lock = Lock()

    def is_allowed(self, key: str) -> bool:
        now = time.time()
        with self.lock:
            # Очищаем устаревшие запросы
            valid_window = now - self.window_seconds
            self.requests[key] = [t for t in self.requests[key] if t > valid_window]
            
            if len(self.requests[key]) >= self.max_requests:
                return False
            
            self.requests[key].append(now)
            return True

feedback_rate_limiter = InMemoryRateLimiter(max_requests=100, window_seconds=60)

class WaveFeedbackRequest(BaseModel):
    track_id: str
    event_type: Literal["like", "skip", "finish"]
    listen_duration_ms: int = Field(default=0, ge=0, le=86400000)
    track_duration_ms: int = Field(default=0, ge=0, le=86400000)
    event_id: str | None = Field(default=None, min_length=1, max_length=128)
    occurred_at: datetime | None = None
    context: Literal['wave', 'manual', 'unknown'] = 'unknown'
    client: str | None = Field(default=None, max_length=64)

    @field_validator('occurred_at')
    @classmethod
    def validate_event_time(cls, value):
        if value is not None:
            if value.tzinfo is None or value > datetime.now(timezone.utc) + timedelta(minutes=5):
                raise ValueError('occurred_at must have a timezone and cannot be in the future')
            return value.astimezone(timezone.utc)
        return value

def get_qdrant_client():
    return QdrantClient(url=QDRANT_URL)

@router.post("/feedback")
def record_wave_feedback(
    request: Request,
    feedback: WaveFeedbackRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user)
):
    """
    Записывает телеметрию действий пользователя в Волне ('like', 'skip', 'finish').
    Используется для построения персонального вектора вкусов и агрегированной статистики.
    """
    user_id = current_user["id"]
    client_ip = request.client.host if request.client else "unknown"
    rate_key = f"user_{user_id}_{client_ip}"

    if not feedback_rate_limiter.is_allowed(rate_key):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Слишком много запросов фидбека. Пожалуйста, подождите."
        )

    # 1. Сохраняем событие в user_wave_feedback
    try:
        inserted = record_listening_event(
            user_id=user_id,
            track_id=feedback.track_id,
            event_type=feedback.event_type,
            listen_duration_ms=feedback.listen_duration_ms,
            track_duration_ms=feedback.track_duration_ms,
            event_id=feedback.event_id,
            occurred_at=feedback.occurred_at.isoformat() if feedback.occurred_at else None,
            context=feedback.context, client=feedback.client,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except sqlite3.IntegrityError as exc:
        # Check after the failed INSERT: deletion may race a preflight lookup.
        # Other constraints (including a missing user) remain visible errors.
        if (exc.sqlite_errorcode == sqlite3.SQLITE_CONSTRAINT_FOREIGNKEY
                and db.get_track(feedback.track_id) is None):
            raise HTTPException(status_code=404, detail="Трек не найден") from exc
        raise

    if not inserted:
        return {"status": "ok"}

    # 4. Проверяем триггер пересчета профиля вкусов (10 треков, 24 часа или немедленный лайк)
    needs_recompute = (feedback.event_type == "like") or should_recompute_embedding(user_id, threshold=10, hours=24)
    if needs_recompute:
        qdrant = get_qdrant_client()
        background_tasks.add_task(update_user_embedding_async, user_id, qdrant)

    return {"status": "ok"}

@router.get("/profile-stats")
def get_profile_statistics(current_user: dict = Depends(get_current_user)):
    """
    Возвращает статус готовности профиля вкусов текущего пользователя.
    Используется веб-клиентом для отображения бейджа адаптации.
    """
    user_id = current_user["id"]
    stats = db.get_user_profile_stats(user_id)
    return stats

# Алиас для совместимости с /api/user/profile-stats
user_router = APIRouter(prefix="/api/user", tags=["user"])

@user_router.get("/profile-stats")
def get_user_profile_statistics(current_user: dict = Depends(get_current_user)):
    user_id = current_user["id"]
    return db.get_user_profile_stats(user_id)

@router.get("/admin/wave-stats")
def get_wave_admin_statistics(current_user: dict = Depends(get_current_admin_user)):
    """
    Сводная аналитика эффективности Моей Волны (доступна администратору).
    """
    return db.get_wave_stats_summary()
