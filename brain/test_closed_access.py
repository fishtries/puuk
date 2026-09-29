"""Закрытый режим: без валидного JWT закрыт КАЖДЫЙ маршрут, кроме login/verify-code."""
import os
import sys
import unittest
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД, должен идти до db/config

import db
from api import app
from auth import create_access_token
from security import hash_password

PUBLIC_PATHS = {"/api/auth/login", "/api/auth/verify-code"}
SAMPLE_MP3 = os.path.join(os.path.dirname(__file__), "temp_audio", "Daft Punk - Around the World.mp3")


def _api_get_routes() -> list[str]:
    """Все GET-маршруты /api/* без path-параметров (параметризованные проверяются отдельно)."""
    paths = []
    for route in app.routes:
        path = getattr(route, "path", "")
        methods = getattr(route, "methods", set())
        if path.startswith("/api") and "GET" in methods and "{" not in path:
            paths.append(path)
    return sorted(set(paths))


class TestClosedAccess(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        from fastapi.testclient import TestClient
        cls.client = TestClient(app)

        for name, role in (("closed_admin", "admin"), ("closed_user", "user")):
            existing = db.get_user_by_username(name)
            if existing:
                db.delete_user(existing["id"])
        cls.admin_id = db.create_user("closed_admin", hash_password("pass"), role="admin")
        cls.user_id = db.create_user("closed_user", hash_password("pass"), role="user")

        resp = cls.client.post("/api/auth/login", json={"username": "closed_user", "password": "pass"})
        cls.user_token = resp.json()["access_token"]
        cls.user_headers = {"Authorization": f"Bearer {cls.user_token}"}

        resp = cls.client.post("/api/auth/login", json={"username": "closed_admin", "password": "pass"})
        cls.admin_headers = {"Authorization": f"Bearer {resp.json()['access_token']}"}

        # Тестовый трек с реальным файлом (абсолютный путь резолвится без Qdrant)
        cls.track_id = str(uuid.uuid4())
        db.add_or_update_track(
            track_id=cls.track_id,
            file_path=os.path.abspath(SAMPLE_MP3),
            title="Closed Access Track",
            album_id=None,
            artist="Closed Artist",
            lyrics="",
            added_by_user_id=cls.user_id,
        )

    def test_01_every_get_route_requires_jwt(self):
        """Без JWT каждый GET-маршрут /api/* -> 401 (кроме публичных auth-эндпоинтов)."""
        for path in _api_get_routes():
            if path in PUBLIC_PATHS:
                continue
            resp = self.client.get(path)
            self.assertEqual(
                resp.status_code, 401,
                f"GET {path} должен требовать JWT, получил {resp.status_code}"
            )

    def test_02_parametrized_routes_require_jwt(self):
        """Параметризованные маршруты (включая stream/cover/color и оба алиаса search) -> 401."""
        tid = self.track_id
        paths = [
            f"/api/tracks/{tid}",
            f"/api/tracks/{tid}/lyrics",
            "/api/albums/999999",
            f"/api/stream/{tid}",
            f"/api/cover/{tid}",
            f"/api/color/{tid}",
            "/api/search/lyrics?q=test",
            "/api/lyrics/search?q=test",
            "/api/search/metadata?q=test",
            "/api/metadata/search?q=test",
            f"/api/tracks/{tid}/like",
        ]
        for path in paths:
            resp = self.client.get(path) if not path.endswith("/like") else self.client.post(path)
            self.assertEqual(
                resp.status_code, 401,
                f"{path} должен требовать JWT, получил {resp.status_code}"
            )

    def test_03_only_auth_endpoints_are_public(self):
        """login/verify-code доступны без JWT -> 200 (verify-code по одноразовому коду из БД)."""
        resp = self.client.post("/api/auth/login", json={"username": "closed_user", "password": "pass"})
        self.assertEqual(resp.status_code, 200)
        self.assertIn("access_token", resp.json())
        self.assertEqual(resp.json()["token_type"], "bearer")

        expires_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        db.create_auth_code(self.user_id, "654321", expires_at)
        resp = self.client.post("/api/auth/verify-code", json={"code": "654321"})
        self.assertEqual(resp.status_code, 200)
        self.assertIn("access_token", resp.json())

        # Код одноразовый: повторное использование -> 401 (маршрут остаётся публичным)
        resp = self.client.post("/api/auth/verify-code", json={"code": "654321"})
        self.assertEqual(resp.status_code, 401)

    def test_04_valid_user_gets_catalog(self):
        """Валидный пользователь (role=user) -> 200 на каталог/поиск/альбомы/stream/cover."""
        checks = [
            ("GET", "/api/tracks", None),
            ("GET", "/api/library/tracks", None),
            ("GET", "/api/search?q=Closed", None),
            ("GET", "/api/albums", None),
            ("GET", f"/api/tracks/{self.track_id}", None),
            ("GET", f"/api/stream/{self.track_id}", None),
            ("GET", f"/api/cover/{self.track_id}", None),
        ]
        for method, path, _ in checks:
            resp = self.client.get(path, headers=self.user_headers)
            self.assertEqual(
                resp.status_code, 200,
                f"{path} с валидным токеном должен вернуть 200, получил {resp.status_code}"
            )

    def test_05_invalid_and_expired_jwt_rejected(self):
        """Битый и просроченный JWT -> 401."""
        bad = self.client.get("/api/tracks", headers={"Authorization": "Bearer invalid.token.payload"})
        self.assertEqual(bad.status_code, 401)

        expired_token = create_access_token(
            {"id": self.user_id, "username": "closed_user", "role": "user"},
            expires_delta=timedelta(days=-1),
        )
        expired = self.client.get("/api/tracks", headers={"Authorization": f"Bearer {expired_token}"})
        self.assertEqual(expired.status_code, 401)

        # Токен несуществующего пользователя -> 401
        ghost_token = create_access_token({"id": 987654321, "username": "ghost", "role": "user"})
        ghost = self.client.get("/api/tracks", headers={"Authorization": f"Bearer {ghost_token}"})
        self.assertEqual(ghost.status_code, 401)

    def test_06_scan_is_admin_only(self):
        """/api/library/scan: гость 401, user 403, admin 200."""
        self.assertEqual(self.client.post("/api/library/scan").status_code, 401)
        self.assertEqual(
            self.client.post("/api/library/scan", headers=self.user_headers).status_code, 403
        )
        resp = self.client.post("/api/library/scan", headers=self.admin_headers)
        self.assertEqual(resp.status_code, 200)

    @classmethod
    def tearDownClass(cls):
        db.delete_user(cls.admin_id)
        db.delete_user(cls.user_id)
        conn = db.get_connection()
        conn.cursor().execute("DELETE FROM tracks WHERE id = ?", (cls.track_id,))
        conn.commit()
        conn.close()


if __name__ == "__main__":
    unittest.main()
