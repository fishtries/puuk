import os
import sys
import unittest
import asyncio
from datetime import datetime, timezone, timedelta

# Добавляем brain в sys.path
sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД, должен идти до db/config

from fastapi.testclient import TestClient
import db
import auth
from api import app

class TestPhase2Auth(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.client = TestClient(app)

    def test_01_login_success(self):
        # Вход под дефолтным админом (admin / admin)
        resp = self.client.post("/api/auth/login", json={
            "username": "admin",
            "password": "admin"
        })
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("access_token", data)
        self.assertEqual(data["token_type"], "bearer")
        self.assertEqual(data["user"]["username"], "admin")
        self.assertEqual(data["user"]["role"], "admin")
        self.assertTrue(data["user"]["is_authenticated"])

    def test_02_login_invalid_password(self):
        resp = self.client.post("/api/auth/login", json={
            "username": "admin",
            "password": "wrongpassword123"
        })
        self.assertEqual(resp.status_code, 401)
        self.assertIn("Неверный логин или пароль", resp.json()["detail"])

    def test_03_login_nonexistent_user(self):
        resp = self.client.post("/api/auth/login", json={
            "username": "ghost_user_does_not_exist",
            "password": "somepassword"
        })
        self.assertEqual(resp.status_code, 401)

    def test_04_telegram_otp_verification(self):
        # Создаем тестового пользователя
        test_user = db.get_user_by_username("test_tg_user")
        if not test_user:
            uid = db.create_user("test_tg_user", role="user", telegram_id=11223344)
        else:
            uid = test_user["id"]

        # Генерируем 6-значный код
        code = "654321"
        expires_at = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        db.create_auth_code(uid, code, expires_at)

        # 1. Валидный запрос с кодом
        resp = self.client.post("/api/auth/verify-code", json={"code": code})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("access_token", data)
        self.assertEqual(data["user"]["username"], "test_tg_user")

        # 2. Повторный запрос с тем же кодом должен вернуть 401 (код уже погашен)
        resp_again = self.client.post("/api/auth/verify-code", json={"code": code})
        self.assertEqual(resp_again.status_code, 401)

    def test_05_get_me_with_token(self):
        # Получаем токен
        login_resp = self.client.post("/api/auth/login", json={
            "username": "admin",
            "password": "admin"
        })
        token = login_resp.json()["access_token"]

        # Запрос с токеном
        resp = self.client.get("/api/auth/me", headers={
            "Authorization": f"Bearer {token}"
        })
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["username"], "admin")
        self.assertTrue(data["is_authenticated"])

    def test_06_get_me_without_token_returns_401(self):
        # Авторизация теперь всегда обязательна: запрос без токена -> 401
        resp = self.client.get("/api/auth/me")
        self.assertEqual(resp.status_code, 401)
        self.assertIn("Требуется авторизация", resp.json()["detail"])

    def test_07_get_optional_current_user_no_token_returns_none(self):
        # Прямой юнит-тест: get_optional_current_user без токена -> None
        self.assertIsNone(asyncio.run(auth.get_optional_current_user(token=None)))

        # Опциональная зависимость строго валидирует плохой токен -> 401
        with self.assertRaises(Exception) as ctx:
            asyncio.run(auth.get_optional_current_user(token="invalid_gibberish_token_123"))
        self.assertEqual(getattr(ctx.exception, "status_code", None), 401)

    def test_08_get_me_invalid_token(self):
        resp = self.client.get("/api/auth/me", headers={
            "Authorization": "Bearer invalid_gibberish_token_123"
        })
        self.assertEqual(resp.status_code, 401)

if __name__ == "__main__":
    unittest.main(verbosity=2)
