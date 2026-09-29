import os
import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel

try:
    import db
    from security import verify_password
except ImportError:
    from . import db
    from .security import verify_password

logger = logging.getLogger("puuk.auth")

# Настройки JWT
# Секрет задается только через окружение. Без него используется случайный
# временный секрет (никакого известного дефолта в коде): токены остаются
# недействительными после перезапуска, поэтому в production JWT_SECRET обязателен.
JWT_SECRET = os.getenv("JWT_SECRET")
if not JWT_SECRET:
    JWT_SECRET = secrets.token_hex(32)
    logger.warning(
        "JWT_SECRET не задан — используется случайный временный секрет. "
        "Выданные токены перестанут действовать после перезапуска. "
        "Задайте JWT_SECRET в переменных окружения."
    )
JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_DAYS = int(os.getenv("JWT_EXPIRATION_DAYS", "30"))

# Media-ticket: короткоживущий подписанный токен для стриминга одного трека.
# Нужен, потому <audio> не может отправлять Authorization-заголовок, а полная
# blob-загрузка блокировала переключение треков на время скачивания файла.
# Тикет привязан к track_id (tid) и не даёт доступа к остальному API.
MEDIA_TICKET_SCOPE = "media"
MEDIA_TICKET_TTL_SECONDS = int(os.getenv("MEDIA_TICKET_TTL_SECONDS", "600"))

# auto_error=False: обе зависимости (строгая и опциональная) сами решают,
# как обрабатывать запрос без токена
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

# --- Pydantic модели ---

class LoginRequest(BaseModel):
    username: str
    password: str

class VerifyCodeRequest(BaseModel):
    code: str

class UserProfile(BaseModel):
    id: int
    username: str
    role: str
    telegram_id: Optional[int] = None
    is_authenticated: bool = True

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserProfile

# --- Функции токенов ---

def create_access_token(user: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Генерирует JWT токен с длительным сроком жизни (по умолчанию 30 дней)."""
    now = datetime.now(timezone.utc)
    expires = now + (expires_delta or timedelta(days=JWT_EXPIRATION_DAYS))
    
    payload = {
        "sub": str(user["id"]),
        "username": user["username"],
        "role": user.get("role", "user"),
        "iat": int(now.timestamp()),
        "exp": int(expires.timestamp())
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def decode_access_token(token: str) -> Optional[dict]:
    """Расшифровывает и валидирует JWT токен."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except jwt.PyJWTError:
        return None


def create_media_ticket(user: dict, track_id: str) -> str:
    """Подписанный media-тикет для стриминга конкретного трека (короткий TTL)."""
    now = datetime.now(timezone.utc)
    expires = now + timedelta(seconds=MEDIA_TICKET_TTL_SECONDS)
    payload = {
        "sub": str(user["id"]),
        "tid": track_id,
        "scope": MEDIA_TICKET_SCOPE,
        "jti": uuid.uuid4().hex,
        "iat": int(now.timestamp()),
        "exp": int(expires.timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def verify_media_ticket(token: str, track_id: str) -> Optional[dict]:
    """
    Возвращает пользователя, если media-тикет подписан, не истёк, имеет
    media-scope и выпущен именно для этого track_id. Иначе None.
    Обычный access-токен (без scope) тикетом служить не может.
    """
    payload = decode_access_token(token)
    if not payload or payload.get("scope") != MEDIA_TICKET_SCOPE:
        return None
    if payload.get("tid") != track_id or "sub" not in payload:
        return None
    try:
        user_id = int(payload["sub"])
    except ValueError:
        return None
    user = db.get_user_by_id(user_id)
    if not user:
        return None
    return dict(user)

# --- FastAPI Dependencies ---

def get_current_user(token: Optional[str] = Depends(oauth2_scheme)) -> dict:
    """
    Строго извлекает и верифицирует пользователя из заголовка Authorization.
    Отсутствие токена, недействительный/просроченный токен или несуществующий
    пользователь -> 401 Unauthorized.
    """
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Требуется авторизация",
            headers={"WWW-Authenticate": "Bearer"},
        )

    payload = decode_access_token(token)
    if not payload or "sub" not in payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Недействительный или истекший токен авторизации",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        user_id = int(payload["sub"])
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Некорректный идентификатор пользователя в токене",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = db.get_user_by_id(user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Пользователь из токена больше не существует",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user_dict = dict(user)
    user_dict["is_authenticated"] = True
    return user_dict

def get_stream_user(
    track_id: str,
    request: Request,
    token: Optional[str] = Depends(oauth2_scheme),
) -> dict:
    """
    Аутентификация стриминга: Bearer JWT либо media-тикет (?mt=).
    Тикет существует для <audio>, который не умеет отправлять заголовки.
    Приоритет у Bearer: веб-клиенты и iOS продолжают работать как раньше.
    """
    if token:
        return get_current_user(token)

    media_ticket = request.query_params.get("mt")
    if media_ticket:
        user = verify_media_ticket(media_ticket, track_id)
        if user:
            user["is_authenticated"] = True
            return user
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Недействительный или истекший media-тикет",
        )

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Требуется авторизация",
        headers={"WWW-Authenticate": "Bearer"},
    )

def get_optional_current_user(token: Optional[str] = Depends(oauth2_scheme)) -> Optional[dict]:
    """
    Опциональная аутентификация: для публичных эндпоинтов, которым известен
    пользователь, если токен передан.
    Нет токена -> None (эндпоинт сам решает, как отвечать);
    недействительный/просроченный токен или несуществующий пользователь -> 401.
    """
    if not token:
        return None
    return get_current_user(token)

def get_current_admin_user(current_user: dict = Depends(get_current_user)) -> dict:
    """Проверяет, что текущий пользователь обладает правами администратора."""
    if current_user.get("role") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Требуются права администратора",
        )
    return current_user
