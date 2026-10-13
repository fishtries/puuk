import os
import sys
import shutil
import tempfile
import unittest
import uuid

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../brain")))
sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД и отключает доставку в рабочий Qdrant

from unittest.mock import patch

from fastapi.testclient import TestClient
import db
from api import app
from bot import get_puuk_user, is_user_allowed, generate_otp_code, index_downloaded_tracks

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

    def test_04_spotify_tracks_indexed_with_real_metadata(self):
        music_dir = tempfile.mkdtemp(prefix="puuk_spotify_idx_")
        self.addCleanup(shutil.rmtree, music_dir, ignore_errors=True)

        real_file = os.path.join(music_dir, "Artist One - Song One.mp3")
        with open(real_file, "wb") as handle:
            handle.write(b"x")

        track_info = {
            "is_spotify": True,
            "tracks": [
                {
                    "filepath": real_file,
                    "title": "Song One",
                    "artist": "Artist One",
                    "album": "Album One",
                    "album_artist": "Artist One",
                    "duration": 180,
                },
                {
                    "filepath": os.path.join(music_dir, "not-on-disk.mp3"),
                    "title": "Song Two",
                    "artist": "Artist Two",
                    "album": "",
                    "duration": 200,
                },
            ],
        }

        user = dict(db.get_user_by_telegram_id(self.tg_id))
        indexed = index_downloaded_tracks(track_info, user, music_dir=music_dir)
        self.assertEqual(indexed, 2)

        rel_path = os.path.relpath(real_file, music_dir)
        track_id = str(uuid.uuid5(uuid.NAMESPACE_URL, rel_path))
        track = db.get_track(track_id)
        self.assertIsNotNone(track)
        self.assertEqual(track["title"], "Song One")
        self.assertEqual(track["artist"], "Artist One")
        self.assertNotEqual(track["artist"], "Spotify")
        self.assertIsNotNone(track["album_id"])
        self.assertTrue(db.is_favorite(self.user_id, track_id))

        conn = db.get_connection()
        second_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "Song Two - Artist Two.mp3"))
        for tid in (track_id, second_id):
            conn.cursor().execute("DELETE FROM user_favorites WHERE track_id = ?", (tid,))
            conn.cursor().execute("DELETE FROM tracks WHERE id = ?", (tid,))
        conn.commit()
        conn.close()

    def test_05_tracks_outside_music_dir_are_not_indexed(self):
        music_dir = tempfile.mkdtemp(prefix="puuk_music_dir_")
        outside_dir = tempfile.mkdtemp(prefix="puuk_outside_")
        self.addCleanup(shutil.rmtree, music_dir, ignore_errors=True)
        self.addCleanup(shutil.rmtree, outside_dir, ignore_errors=True)

        outside_file = os.path.join(outside_dir, "evil.mp3")
        with open(outside_file, "wb") as handle:
            handle.write(b"x")

        track_info = {
            "is_spotify": True,
            "tracks": [{
                "filepath": outside_file,
                "title": "Evil",
                "artist": "Hacker",
                "album": "",
                "duration": 10,
            }],
        }

        user = dict(db.get_user_by_telegram_id(self.tg_id))
        indexed = index_downloaded_tracks(track_info, user, music_dir=music_dir)
        self.assertEqual(indexed, 0)

        phantom_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "Evil - Hacker.mp3"))
        self.assertIsNone(db.get_track(phantom_id))

    def test_06_spotify_playlist_indexed_but_not_favorited(self):
        music_dir = tempfile.mkdtemp(prefix="puuk_playlist_")
        self.addCleanup(shutil.rmtree, music_dir, ignore_errors=True)

        files = []
        for name in ("Playlist Artist - Track A.mp3", "Playlist Artist - Track B.mp3"):
            path = os.path.join(music_dir, name)
            with open(path, "wb") as handle:
                handle.write(b"x")
            files.append(path)

        track_info = {
            "is_spotify": True,
            "total_tracks": 2,
            "tracks": [
                {"filepath": files[0], "title": "Track A", "artist": "Playlist Artist",
                 "album": "Playlist Album", "album_artist": "Playlist Artist", "duration": 120},
                {"filepath": files[1], "title": "Track B", "artist": "Playlist Artist",
                 "album": "Playlist Album", "album_artist": "Playlist Artist", "duration": 130},
            ],
        }

        user = dict(db.get_user_by_telegram_id(self.tg_id))
        indexed = index_downloaded_tracks(track_info, user, music_dir=music_dir)
        self.assertEqual(indexed, 2)

        conn = db.get_connection()
        track_ids = []
        for path in files:
            rel_path = os.path.relpath(path, music_dir)
            track_id = str(uuid.uuid5(uuid.NAMESPACE_URL, rel_path))
            track_ids.append(track_id)
            track = db.get_track(track_id)
            self.assertIsNotNone(track)
            self.assertEqual(track["artist"], "Playlist Artist")
            self.assertFalse(db.is_favorite(self.user_id, track_id))

        for track_id in track_ids:
            conn.cursor().execute("DELETE FROM user_favorites WHERE track_id = ?", (track_id,))
            conn.cursor().execute("DELETE FROM tracks WHERE id = ?", (track_id,))
        conn.commit()
        conn.close()

    def test_07_downloaded_playlist_enqueues_only_real_files(self):
        music_dir = tempfile.mkdtemp(prefix="puuk_enqueue_")
        self.addCleanup(shutil.rmtree, music_dir, ignore_errors=True)

        real_file = os.path.join(music_dir, "A - One.mp3")
        with open(real_file, "wb") as handle:
            handle.write(b"x")

        track_info = {
            "is_spotify": True,
            "total_tracks": 2,
            "tracks": [
                {"filepath": real_file, "title": "One", "artist": "A", "album": "", "duration": 10},
                {"filepath": os.path.join(music_dir, "missing.mp3"),
                 "title": "Two", "artist": "B", "album": "", "duration": 20},
            ],
        }

        captured = {}

        def fake_enqueue(client, tracks, music_root, **kwargs):
            captured["tracks"] = list(tracks)
            captured["root"] = music_root
            return {"enqueued": len(captured["tracks"])}

        user = dict(db.get_user_by_telegram_id(self.tg_id))
        with patch.dict(os.environ, {"EMBEDDING_QUEUE_ENABLED": "true"}), \
             patch("services.embedding_queue_service.get_qdrant_client", return_value=object()), \
             patch("services.embedding_queue_service.enqueue_missing_tracks", side_effect=fake_enqueue):
            indexed = index_downloaded_tracks(track_info, user, music_dir=music_dir)

        self.assertEqual(indexed, 2)
        self.assertEqual(len(captured["tracks"]), 1)
        self.assertEqual(captured["tracks"][0]["file_path"], "A - One.mp3")
        self.assertEqual(captured["root"], music_dir)

        conn = db.get_connection()
        for rel in ("A - One.mp3", "Two - B.mp3"):
            track_id = str(uuid.uuid5(uuid.NAMESPACE_URL, rel))
            conn.cursor().execute("DELETE FROM user_favorites WHERE track_id = ?", (track_id,))
            conn.cursor().execute("DELETE FROM tracks WHERE id = ?", (track_id,))
        conn.commit()
        conn.close()

    @classmethod
    def tearDownClass(cls):
        db.delete_user(cls.user_id)


if __name__ == "__main__":
    unittest.main(verbosity=2)
