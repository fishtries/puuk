import os
import sys
import unittest
import uuid

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД, должен идти до db/config

from fastapi.testclient import TestClient
import db
import auth
from security import hash_password
from api import app

class TestPhase3MultiUserLibrary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.client = TestClient(app)

        # Создаем двух тестовых пользователей: alice и bob
        for name in ["alice_p3", "bob_p3"]:
            existing = db.get_user_by_username(name)
            if existing:
                db.delete_user(existing["id"])

        cls.alice_id = db.create_user("alice_p3", hash_password("pass_alice"), role="user")
        cls.bob_id = db.create_user("bob_p3", hash_password("pass_bob"), role="user")

        # Получаем токены
        resp_alice = cls.client.post("/api/auth/login", json={"username": "alice_p3", "password": "pass_alice"})
        cls.token_alice = resp_alice.json()["access_token"]
        cls.headers_alice = {"Authorization": f"Bearer {cls.token_alice}"}

        resp_bob = cls.client.post("/api/auth/login", json={"username": "bob_p3", "password": "pass_bob"})
        cls.token_bob = resp_bob.json()["access_token"]
        cls.headers_bob = {"Authorization": f"Bearer {cls.token_bob}"}

        resp_admin = cls.client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
        cls.token_admin = resp_admin.json()["access_token"]
        cls.headers_admin = {"Authorization": f"Bearer {cls.token_admin}"}

        # Тестовый трек с валидным UUID
        cls.track_id = str(uuid.uuid4())
        db.add_or_update_track(
            track_id=cls.track_id,
            file_path="music/track3.mp3",
            title="Phase 3 Anthem",
            album_id=None,
            artist="Phase 3 Artist",
            lyrics="Sample",
            added_by_user_id=cls.alice_id,
            cover_color="#336699"
        )

    def test_01_playlist_permissions_and_isolation(self):
        # 1. Алиса создает приватный плейлист
        create_resp = self.client.post("/api/playlists", json={
            "name": "Alice Private Mix",
            "is_public": False
        }, headers=self.headers_alice)
        self.assertEqual(create_resp.status_code, 200)
        playlist_id = create_resp.json()["id"]

        # Алиса видит свой плейлист в списке
        alice_pls = self.client.get("/api/playlists", headers=self.headers_alice).json()
        self.assertTrue(any(p["id"] == playlist_id for p in alice_pls))

        # Боб НЕ видит приватный плейлист Алисы
        bob_pls = self.client.get("/api/playlists", headers=self.headers_bob).json()
        self.assertFalse(any(p["id"] == playlist_id for p in bob_pls))

        # Боб пытается получить детали приватного плейлиста Алисы -> 403 Forbidden
        bob_details = self.client.get(f"/api/playlists/{playlist_id}", headers=self.headers_bob)
        self.assertEqual(bob_details.status_code, 403)

        # Боб пытается изменить плейлист Алисы -> 403 Forbidden
        bob_patch = self.client.patch(f"/api/playlists/{playlist_id}", json={"name": "Hacked"}, headers=self.headers_bob)
        self.assertEqual(bob_patch.status_code, 403)

        # Боб пытается удалить плейлист Алисы -> 403 Forbidden
        bob_del = self.client.delete(f"/api/playlists/{playlist_id}", headers=self.headers_bob)
        self.assertEqual(bob_del.status_code, 403)

        # Админ МОЖЕТ получить детали плейлиста Алисы
        admin_details = self.client.get(f"/api/playlists/{playlist_id}", headers=self.headers_admin)
        self.assertEqual(admin_details.status_code, 200)

        # Алиса добавляет трек в свой плейлист
        add_resp = self.client.post(f"/api/playlists/{playlist_id}/tracks", json={"track_id": self.track_id}, headers=self.headers_alice)
        self.assertEqual(add_resp.status_code, 200)

        # Алиса удаляет свой плейлист
        del_resp = self.client.delete(f"/api/playlists/{playlist_id}", headers=self.headers_alice)
        self.assertEqual(del_resp.status_code, 200)

    def test_02_likes_and_favorites(self):
        # Алиса ставит лайк
        like_resp = self.client.post(f"/api/tracks/{self.track_id}/like", headers=self.headers_alice)
        self.assertEqual(like_resp.status_code, 200)
        self.assertEqual(like_resp.json()["status"], "liked")

        # В списке избранного Алисы трек есть и помечен is_liked: True
        favs_alice = self.client.get("/api/favorites", headers=self.headers_alice).json()
        self.assertEqual(len(favs_alice), 1)
        self.assertEqual(favs_alice[0]["id"], self.track_id)
        self.assertTrue(favs_alice[0]["is_liked"])

        # У Боба в избранном пусто
        favs_bob = self.client.get("/api/favorites", headers=self.headers_bob).json()
        self.assertEqual(len(favs_bob), 0)

        # В выдаче общего каталога Алиса видит is_liked=True, Боб видит False.
        # limit задан явно: puuk.db накапливает тестовые треки между прогонами
        # (БД не изолирована), и свежий трек выпадает за дефолтную страницу 50.
        tracks_alice = self.client.get("/api/tracks?limit=500", headers=self.headers_alice).json()
        alice_track = next((t for t in tracks_alice if t["id"] == self.track_id), None)
        self.assertIsNotNone(alice_track)
        self.assertTrue(alice_track["is_liked"])

        tracks_bob = self.client.get("/api/tracks?limit=500", headers=self.headers_bob).json()
        bob_track = next((t for t in tracks_bob if t["id"] == self.track_id), None)
        self.assertIsNotNone(bob_track)
        self.assertFalse(bob_track["is_liked"])

        # Алиса снимает лайк
        unlike_resp = self.client.delete(f"/api/tracks/{self.track_id}/like", headers=self.headers_alice)
        self.assertEqual(unlike_resp.status_code, 200)
        self.assertEqual(unlike_resp.json()["status"], "unliked")
        favs_after = self.client.get("/api/favorites", headers=self.headers_alice).json()
        self.assertEqual(len(favs_after), 0)

    def test_03_history_and_dislikes(self):
        # Фиксация истории
        hist_resp = self.client.post(f"/api/tracks/{self.track_id}/history", headers=self.headers_alice)
        self.assertEqual(hist_resp.status_code, 200)

        history = self.client.get("/api/history", headers=self.headers_alice).json()
        self.assertGreaterEqual(len(history), 1)
        self.assertEqual(history[0]["id"], self.track_id)

        # Дизлайк
        dislike_resp = self.client.post(f"/api/tracks/{self.track_id}/dislike", headers=self.headers_alice)
        self.assertEqual(dislike_resp.status_code, 200)
        dislikes = self.client.get("/api/dislikes", headers=self.headers_alice).json()
        self.assertIn(self.track_id, dislikes)

        # Снятие дизлайка
        undislike_resp = self.client.delete(f"/api/tracks/{self.track_id}/dislike", headers=self.headers_alice)
        self.assertEqual(undislike_resp.status_code, 200)
        dislikes_after = self.client.get("/api/dislikes", headers=self.headers_alice).json()
        self.assertNotIn(self.track_id, dislikes_after)

    def test_04_color_caching(self):
        # Цвет был задан как #336699
        color_resp = self.client.get(f"/api/color/{self.track_id}", headers=self.headers_alice)
        self.assertEqual(color_resp.status_code, 200)
        self.assertEqual(color_resp.json()["color"], "#336699")

    def test_05_track_metadata_rbac(self):
        # Трек добавлен Алисой. Боб пытается изменить метаданные -> 403 Forbidden
        payload = {
            "title": "Hacked Title",
            "artist": "Hacked Artist",
            "album": "Hacked Album",
            "lyrics": "None"
        }
        bob_edit = self.client.patch(f"/api/tracks/{self.track_id}", json=payload, headers=self.headers_bob)
        self.assertEqual(bob_edit.status_code, 403)
        self.assertIn("Недостаточно прав", bob_edit.json()["detail"])

    @classmethod
    def tearDownClass(cls):
        db.delete_user(cls.alice_id)
        db.delete_user(cls.bob_id)
        conn = db.get_connection()
        conn.cursor().execute("DELETE FROM tracks WHERE id = ?", (cls.track_id,))
        conn.commit()
        conn.close()

if __name__ == "__main__":
    unittest.main(verbosity=2)
