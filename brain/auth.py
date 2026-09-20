import os
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from fastapi import Depends, HTTPException, status
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
JWT_SECRET = os.getenv("JWT_SECRET", "puuk-super-secret-jwt-key-2026-safe-production-default")
JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_DAYS = int(os.getenv("JWT_EXPIRATION_DAYS", "30"))

# Флаг строгого режима: если False, запросы без токена получают аккаунт admin (id=1)
REQUIRE_AUTH = os.getenv("REQUIRE_AUTH", "false").lower() in ("true", "1", "yes")

def set_require_auth(value: bool):
    global REQUIRE_AUTH
    REQUIRE_AUTH = bool(value)

# auto_error=False позволяет обрабатывать запросы без токена в мягком fallback-режиме
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

# --- FastAPI Dependencies ---

async def get_current_user(token: Optional[str] = Depends(oauth2_scheme)) -> dict:
    """
    Извлекает и верифицирует пользователя из заголовка Authorization.
    При отсутствии токена в режиме REQUIRE_AUTH=False обеспечивает плавный переход,
    возвращая дефолтного пользователя (admin, id=1).
    """
    if token:
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

    # Токен отсутствует в запросе
    if REQUIRE_AUTH:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Требуется авторизация",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    # Мягкий fallback-режим для текущих клиентов
    admin_user = db.get_user_by_id(1)
    if admin_user:
        user_dict = dict(admin_user)
    else:
        user_dict = {"id": 1, "username": "admin", "role": "admin", "telegram_id": None}
        
    user_dict["is_authenticated"] = False
    return user_dict

async def get_current_admin_user(current_user: dict = Depends(get_current_user)) -> dict:
    """Проверяет, что текущий пользователь обладает правами администратора."""
    if current_user.get("role") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Требуются права администратора",
        )
    return current_user
