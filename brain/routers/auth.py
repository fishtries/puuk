from fastapi import APIRouter, Depends, HTTPException, status
import sys
import os

# Поддержка импорта как внутри пакета brain, так и снаружи
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import db
from security import verify_password
from auth import (
    LoginRequest,
    VerifyCodeRequest,
    TokenResponse,
    UserProfile,
    create_access_token,
    get_current_user
)

router = APIRouter()

@router.post("/login", response_model=TokenResponse, summary="Вход по логину и паролю")
async def login(req: LoginRequest):
    user = db.get_user_by_username(req.username)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неверный логин или пароль"
        )
    
    if not user.get("password_hash") or not verify_password(req.password, user["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неверный логин или пароль"
        )
        
    token = create_access_token(user)
    return TokenResponse(
        access_token=token,
        token_type="bearer",
        user=UserProfile(
            id=user["id"],
            username=user["username"],
            role=user["role"],
            telegram_id=user["telegram_id"],
            is_authenticated=True
        )
    )

@router.post("/verify-code", response_model=TokenResponse, summary="Вход по одноразовому Telegram-коду (OTP)")
async def verify_code(req: VerifyCodeRequest):
    code_clean = req.code.strip()
    user = db.verify_and_consume_auth_code(code_clean)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неверный, использованный или просроченный код подтверждения"
        )
        
    token = create_access_token(user)
    return TokenResponse(
        access_token=token,
        token_type="bearer",
        user=UserProfile(
            id=user["id"],
            username=user["username"],
            role=user["role"],
            telegram_id=user["telegram_id"],
            is_authenticated=True
        )
    )

@router.get("/me", response_model=UserProfile, summary="Профиль текущего пользователя")
async def get_my_profile(current_user: dict = Depends(get_current_user)):
    return UserProfile(
        id=current_user["id"],
        username=current_user["username"],
        role=current_user["role"],
        telegram_id=current_user.get("telegram_id"),
        is_authenticated=current_user.get("is_authenticated", False)
    )
