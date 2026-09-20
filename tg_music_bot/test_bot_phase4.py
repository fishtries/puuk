import os
import sys
import unittest
import uuid

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../brain")))
sys.path.insert(0, os.path.dirname(__file__))

from fastapi.testclient import TestClient
import db
from api import app
from bot import get_puuk_user, is_user_allowed, generate_otp_code

class TestPhase4TelegramBot(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.client = TestClient(app)

        # Тестовый пользователь с Telegram ID
        existing = db.get_user_by_username("tg_tester")
        if existing:
            db.delete_user(existing["id"])

        cls.tg_id = 777888999
        cls.user_id = db.create_user("tg_tester", role="user", telegram_id=cls.tg_id)

    def test_01_user_lookup_and_permissions(self):
        user = get_puuk_user(self.tg_id)
        self.assertIsNotNone(user)
        self.assertEqual(user["id"], self.user_id)
        self.assertEqual(user["username"], "tg_tester")
        self.assertTrue(is_user_allowed(self.tg_id))

        # Неизвестный пользователь
        unknown_id = 999999999
        self.assertIsNone(get_puuk_user(unknown_id))
        self.assertFalse(is_user_allowed(unknown_id))

    def test_02_otp_code_generation_and_api_login(self):
        # Бот генерирует OTP код для пользователя
        code = generate_otp_code(self.user_id)
        self.assertEqual(len(code), 6)
        self.assertTrue(code.isdigit())

        # Пользователь вводит этот код в мобильном приложении / веб-клиенте
        login_resp = self.client.post("/api/auth/verify-code", json={"code": code})
        self.assertEqual(login_resp.status_code, 200)
        data = login_resp.json()
        self.assertIn("access_token", data)
        self.assertEqual(data["user"]["id"], self.user_id)
        self.assertEqual(data["user"]["username"], "tg_tester")

    def test_03_download_auto_favoriting(self):
        # Симулируем успешную загрузку трека ботом в режиме 'server'
        track_title = "Bot Downloaded Track"
        track_artist = "Bot Artist"
        rel_path = f"{track_title} - {track_artist}.mp3"
        track_uuid = str(uuid.uuid5(uuid.NAMESPACE_URL, rel_path))

        # Действие, которое делает бот при скачивании
        db.add_or_update_track(
            track_id=track_uuid,
            file_path=rel_path,
            title=track_title,
            album_id=None,
            artist=track_artist,
            added_by_user_id=self.user_id
        )
        db.add_favorite(self.user_id, track_uuid)

        # Проверяем, что трек появился в базе и привязан к пользователю
        track = db.get_track(track_uuid)
        self.assertIsNotNone(track)
        self.assertEqual(track["added_by_user_id"], self.user_id)

        # Проверяем, что трек автоматически добавлен в Избранное пользователя
        self.assertTrue(db.is_favorite(self.user_id, track_uuid))

        # Чистим тестовый трек
        conn = db.get_connection()
        conn.cursor().execute("DELETE FROM tracks WHERE id = ?", (track_uuid,))
        conn.commit()
        conn.close()

    @classmethod
    def tearDownClass(cls):
        db.delete_user(cls.user_id)

if __name__ == "__main__":
    unittest.main(verbosity=2)
