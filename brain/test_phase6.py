import os
import sys
import unittest
import uuid

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД, должен идти до db/config

from fastapi.testclient import TestClient
import db
from security import hash_password
from api import app

class TestPhase6StrictModeAndIsolation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.client = TestClient(app)

        # Подготовим пользователей
        for name in ["charlie_p6", "diana_p6"]:
            existing = db.get_user_by_username(name)
            if existing:
                db.delete_user(existing["id"])

        cls.charlie_id = db.create_user("charlie_p6", hash_password("pass_c6"), role="user")
        cls.diana_id = db.create_user("diana_p6", hash_password("pass_d6"), role="user")

        # Токены
        resp_c = cls.client.post("/api/auth/login", json={"username": "charlie_p6", "password": "pass_c6"})
        cls.token_c = resp_c.json()["access_token"]
        cls.headers_c = {"Authorization": f"Bearer {cls.token_c}"}

        resp_d = cls.client.post("/api/auth/login", json={"username": "diana_p6", "password": "pass_d6"})
        cls.token_d = resp_d.json()["access_token"]
        cls.headers_d = {"Authorization": f"Bearer {cls.token_d}"}

        # Тестовый трек
        cls.track_id = str(uuid.uuid4())
        db.add_or_update_track(
            track_id=cls.track_id,
            file_path="music/track_p6.mp3",
            title="Phase 6 Track",
            album_id=None,
            artist="Phase 6 Artist",
            lyrics="",
            added_by_user_id=cls.charlie_id
        )

    def test_01_anonymous_requests_rejected(self):
        # Запрос без токена к /api/auth/me -> 401 (авторизация всегда обязательна)
        resp_me = self.client.get("/api/auth/me")
        self.assertEqual(resp_me.status_code, 401)
        self.assertIn("Требуется авторизация", resp_me.json()["detail"])

        # Запрос без токена к /api/favorites -> 401
        resp_favs = self.client.get("/api/favorites")
        self.assertEqual(resp_favs.status_code, 401)

    def test_02_anonymous_rejected_on_protected_endpoints(self):
        # Запросы без токена к защищенным эндпоинтам -> 401
        endpoints_to_test = [
            ("GET", "/api/auth/me"),
            ("GET", "/api/favorites"),
            ("GET", "/api/playlists"),
            ("POST", "/api/playlists"),
            ("GET", "/api/history"),
            ("GET", "/api/dislikes")
        ]

        for method, ep in endpoints_to_test:
            if method == "GET":
                r = self.client.get(ep)
            else:
                r = self.client.post(ep, json={"name": "Test"})
            self.assertEqual(
                r.status_code, 401,
                f"Endpoint {method} {ep} should return 401 without token, got {r.status_code}"
            )

        # Запрос с битым токеном -> 401
        invalid_resp = self.client.get("/api/favorites", headers={"Authorization": "Bearer invalid.token.payload"})
        self.assertEqual(invalid_resp.status_code, 401)

    def test_03_valid_tokens_accepted(self):
        # Чарли делает запрос с валидным токеном
        resp_me = self.client.get("/api/auth/me", headers=self.headers_c)
        self.assertEqual(resp_me.status_code, 200)
        self.assertEqual(resp_me.json()["username"], "charlie_p6")
        self.assertTrue(resp_me.json()["is_authenticated"])

        # Чарли создает плейлист
        pl_resp = self.client.post("/api/playlists", json={
            "name": "Charlie Strict Mix",
            "is_public": False
        }, headers=self.headers_c)
        self.assertEqual(pl_resp.status_code, 200)
        pl_id = pl_resp.json()["id"]

        # Диана пытается получить плейлист Чарли -> 403 Forbidden
        d_get = self.client.get(f"/api/playlists/{pl_id}", headers=self.headers_d)
        self.assertEqual(d_get.status_code, 403)

        # Чарли лайкает трек
        like_resp = self.client.post(f"/api/tracks/{self.track_id}/like", headers=self.headers_c)
        self.assertEqual(like_resp.status_code, 200)

        # В избранном Чарли трек есть
        c_favs = self.client.get("/api/favorites", headers=self.headers_c).json()
        self.assertTrue(any(t["id"] == self.track_id for t in c_favs))

        # В избранном Дианы трека нет
        d_favs = self.client.get("/api/favorites", headers=self.headers_d).json()
        self.assertFalse(any(t["id"] == self.track_id for t in d_favs))

        # Очистка плейлиста
        self.client.delete(f"/api/playlists/{pl_id}", headers=self.headers_c)

    def test_04_public_routes_remain_open(self):
        # Логин работает без токена
        login_resp = self.client.post("/api/auth/login", json={"username": "charlie_p6", "password": "pass_c6"})
        self.assertEqual(login_resp.status_code, 200)
        self.assertIn("access_token", login_resp.json())

        # Проверка неверного пароля -> 401
        bad_login = self.client.post("/api/auth/login", json={"username": "charlie_p6", "password": "wrong"})
        self.assertEqual(bad_login.status_code, 401)

    def test_05_catalog_requires_auth(self):
        # Каталог закрыт: без токена -> 401 на все читающие маршруты
        for ep in ("/api/tracks", "/api/albums", "/api/library/tracks"):
            r = self.client.get(ep)
            self.assertEqual(r.status_code, 401, f"{ep} должен требовать JWT")

        # Валидный пользователь читает каталог
        resp = self.client.get("/api/tracks", headers=self.headers_c)
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(len(resp.json()) > 0)
        # Валидному пользователю треки приходят с его лайками (здесь - без лайков)
        self.assertTrue(all(t["is_liked"] is False for t in resp.json()))

        # Поиск доступен только с токеном
        resp_search = self.client.get("/api/search", params={"q": "Phase"})
        self.assertEqual(resp_search.status_code, 401)
        resp_search = self.client.get("/api/search", params={"q": "Phase"}, headers=self.headers_c)
        self.assertEqual(resp_search.status_code, 200)

        # Битый токен отклоняется
        bad = self.client.get("/api/tracks", headers={"Authorization": "Bearer invalid.token.payload"})
        self.assertEqual(bad.status_code, 401)

    def test_06_guest_protected_writes_rejected(self):
        # Гостевые запросы к персональным эндпоинтам -> 401
        endpoints_to_test = [
            ("GET", "/api/favorites", None),
            ("GET", "/api/history", None),
            ("POST", f"/api/tracks/{self.track_id}/like", None),
            ("GET", "/api/recommendations/youll-like-this", None),
        ]

        for method, ep, payload in endpoints_to_test:
            if method == "GET":
                r = self.client.get(ep)
            else:
                r = self.client.post(ep)
            self.assertEqual(
                r.status_code, 401,
                f"Endpoint {method} {ep} should return 401 without token, got {r.status_code}"
            )

        # Скан библиотеки теперь только для админа: гость -> 401, пользователь -> 403
        self.assertEqual(self.client.post("/api/library/scan").status_code, 401)
        self.assertEqual(self.client.post("/api/library/scan", headers=self.headers_c).status_code, 403)

    def test_07_authenticated_tracks_reflect_likes(self):
        # Чарли лайкает трек
        like_resp = self.client.post(f"/api/tracks/{self.track_id}/like", headers=self.headers_c)
        self.assertEqual(like_resp.status_code, 200)

        # С валидным токеном /api/tracks отражает лайк (лимит выше — в общей тестовой БД много треков)
        resp = self.client.get("/api/tracks", params={"limit": 1000}, headers=self.headers_c)
        self.assertEqual(resp.status_code, 200)
        target = next(t for t in resp.json() if t["id"] == self.track_id)
        self.assertTrue(target["is_liked"])

        # Другой пользователь видит тот же трек без лайка
        other = self.client.get("/api/tracks", params={"limit": 1000}, headers=self.headers_d)
        target_other = next(t for t in other.json() if t["id"] == self.track_id)
        self.assertFalse(target_other["is_liked"])

    @classmethod
    def tearDownClass(cls):
        db.delete_user(cls.charlie_id)
        db.delete_user(cls.diana_id)
        conn = db.get_connection()
        conn.cursor().execute("DELETE FROM tracks WHERE id = ?", (cls.track_id,))
        conn.commit()
        conn.close()

if __name__ == "__main__":
    unittest.main(verbosity=2)
