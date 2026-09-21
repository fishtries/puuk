import os
import sys
import unittest
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД, должен идти до db/config
import db
from security import hash_password, verify_password

class TestPhase1(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()

    def test_01_pragmas(self):
        conn = db.get_connection()
        cursor = conn.cursor()
        
        cursor.execute("PRAGMA journal_mode;")
        journal_mode = cursor.fetchone()[0]
        self.assertEqual(journal_mode.lower(), "wal", "journal_mode должен быть WAL")
        
        cursor.execute("PRAGMA foreign_keys;")
        foreign_keys = cursor.fetchone()[0]
        self.assertEqual(foreign_keys, 1, "foreign_keys должен быть включен (1)")
        conn.close()

    def test_02_admin_user_exists(self):
        admin = db.get_user_by_id(1)
        self.assertIsNotNone(admin, "Пользователь admin (id=1) должен существовать")
        self.assertEqual(admin["username"], "admin")
        self.assertEqual(admin["role"], "admin")
        self.assertTrue(verify_password("admin", admin["password_hash"]))

    def test_03_user_crud_and_auth_security(self):
        test_username = "test_user_phase1"
        # Удаляем если остался от предыдущего запуска
        existing = db.get_user_by_username(test_username)
        if existing:
            db.delete_user(existing["id"])
            
        pwd_hash = hash_password("secret_pass123")
        uid = db.create_user(
            username=test_username,
            password_hash=pwd_hash,
            telegram_id=987654321,
            role="user"
        )
        self.assertIsInstance(uid, int)
        
        # Получение
        user = db.get_user_by_username(test_username)
        self.assertIsNotNone(user)
        self.assertEqual(user["telegram_id"], 987654321)
        self.assertTrue(verify_password("secret_pass123", user["password_hash"]))
        self.assertFalse(verify_password("wrong_pass", user["password_hash"]))

    def test_04_telegram_otp_codes(self):
        user = db.get_user_by_username("test_user_phase1")
        code = "123456"
        expires_at = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        
        db.create_auth_code(user["id"], code, expires_at)
        
        # Первое потребление — успешно
        verified = db.verify_and_consume_auth_code(code)
        self.assertIsNotNone(verified)
        self.assertEqual(verified["id"], user["id"])
        
        # Второе потребление — должно вернуть None (уже использован)
        consumed_again = db.verify_and_consume_auth_code(code)
        self.assertIsNone(consumed_again, "Одноразовый код не должен срабатывать дважды")

    def test_05_favorites_and_history(self):
        user = db.get_user_by_username("test_user_phase1")
        track_id = "test-track-uuid-phase1"
        
        # Создаем тестовый трек
        db.add_or_update_track(
            track_id=track_id,
            file_path="music/test.mp3",
            title="Test Song",
            album_id=None,
            artist="Test Artist",
            lyrics="Sample lyrics",
            added_by_user_id=user["id"],
            cover_color="#abcdef"
        )
        
        # Проверяем избранное
        self.assertFalse(db.is_favorite(user["id"], track_id))
        success = db.add_favorite(user["id"], track_id)
        self.assertTrue(success)
        self.assertTrue(db.is_favorite(user["id"], track_id))
        
        favs = db.get_user_favorites(user["id"])
        self.assertEqual(len(favs), 1)
        self.assertEqual(favs[0]["id"], track_id)
        self.assertEqual(favs[0]["cover_color"], "#abcdef")
        
        # Проверяем историю
        db.add_history(user["id"], track_id)
        history = db.get_user_history(user["id"])
        self.assertGreaterEqual(len(history), 1)
        self.assertEqual(history[0]["id"], track_id)
        
        # Проверяем дизлайки
        db.add_dislike(user["id"], track_id)
        dislikes = db.get_user_dislike_ids(user["id"])
        self.assertIn(track_id, dislikes)
        db.remove_dislike(user["id"], track_id)
        self.assertNotIn(track_id, db.get_user_dislike_ids(user["id"]))

    def test_06_playlists_and_cascade_delete(self):
        user = db.get_user_by_username("test_user_phase1")
        track_id = "test-track-uuid-phase1"
        
        # Создаем плейлист пользователя
        playlist_id = db.create_playlist("Test Playlist", user_id=user["id"], is_public=False)
        db.add_track_to_playlist(playlist_id, track_id)
        
        user_playlists = db.get_all_playlists(user_id=user["id"])
        self.assertTrue(any(p["id"] == playlist_id for p in user_playlists))
        
        # Другой юзер не должен видеть этот приватный плейлист
        admin_playlists = db.get_all_playlists(user_id=1)
        self.assertFalse(any(p["id"] == playlist_id for p in admin_playlists))
        
        # Проверяем каскадное удаление: удаляем пользователя
        deleted = db.delete_user(user["id"])
        self.assertTrue(deleted)
        
        # Проверяем, что плейлист и лайки пользователя удалились каскадно
        self.assertIsNone(db.get_playlist(playlist_id))
        self.assertFalse(db.is_favorite(user["id"], track_id))
        
        # Чистим тестовый трек
        conn = db.get_connection()
        conn.cursor().execute("DELETE FROM tracks WHERE id = ?", (track_id,))
        conn.commit()
        conn.close()

if __name__ == "__main__":
    unittest.main(verbosity=2)
