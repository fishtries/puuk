"""E2E интеграционный тест жизненного цикла жанров:
Редактор -> Сохранение тега -> Приоритеты рекомендательного профиля.

Проверяет:
1. Трек без ручного жанра использует Essentia auto_genres.
2. Прослушивание трека формирует профиль жанров пользователя из auto_genres.
3. GET /api/tracks/{id} возвращает DTO с auto_genres, auto_genre_model и auto_genre_updated_at.
4. PATCH /api/tracks/{id} с ручным genre="Jazz":
   - физически обновляет аудиофайл на диске;
   - обновляет tracks.genre в SQLite;
   - НЕ затирает auto_genres;
   - профиль рекомендаций мгновенно переключается на "Jazz" с приоритетным весом 1.0.
5. PATCH /api/tracks/{id} с пустым genre="":
   - удаляет тег жанра из аудиофайла и tracks.genre;
   - сохраняет auto_genres неизменными;
   - профиль рекомендаций возвращается к fallback на auto_genres.
"""
import os
import shutil
import sys
import unittest
import uuid
from mutagen.id3 import ID3

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД

from fastapi.testclient import TestClient
from api import app
import db
from security import hash_password
from metadata import read_audio_metadata
from services.personalized_recommendation_service import get_user_genre_affinity, get_effective_genres


class TestApiGenreOverrideE2E(unittest.TestCase):
    def setUp(self):
        self.temp_audio_dir = os.path.join(os.path.dirname(__file__), "temp_audio")
        self.sample_mp3 = os.path.join(self.temp_audio_dir, "Daft Punk - Around the World.mp3")
        if not os.path.exists(self.sample_mp3):
            self.skipTest("Sample MP3 not found in temp_audio")

        # Создаем уникальную копию файла для теста
        self.track_id = f"e2e_genre_{uuid.uuid4().hex[:8]}"
        self.test_filename = f"{self.track_id}.mp3"
        self.test_file_path = os.path.join(self.temp_audio_dir, self.test_filename)
        shutil.copy2(self.sample_mp3, self.test_file_path)

        # Очищаем исходный genre тег в копии MP3
        try:
            tags = ID3(self.test_file_path)
            tags.delall("TCON")
            tags.save()
        except Exception:
            pass

        # Создаем тестового администратора
        self.username = f"admin_{uuid.uuid4().hex[:6]}"
        self.password = "secret_pass_123"
        self.user_id = db.create_user(self.username, hash_password(self.password), role="admin")

        self.client = TestClient(app)
        login_res = self.client.post("/api/auth/login", json={"username": self.username, "password": self.password})
        self.assertEqual(login_res.status_code, 200)
        self.token = login_res.json()["access_token"]
        self.headers = {"Authorization": f"Bearer {self.token}"}

        # Добавляем трек в БД без ручного жанра, но с Essentia auto_genres
        db.add_or_update_track(
            track_id=self.track_id,
            file_path=self.test_filename,
            title="Around the World (E2E)",
            artist="Daft Punk",
            album_id=None,
            genre=None,
            added_by_user_id=self.user_id,
        )

        self.initial_auto_genres = [
            {"name": "Electronic", "confidence": 0.88},
            {"name": "Deep House", "confidence": 0.65},
        ]
        self.model_name = "genre_discogs400-discogs-effnet-1"
        db.update_track_auto_genres(self.track_id, self.initial_auto_genres, self.model_name)

    def tearDown(self):
        if hasattr(self, "test_file_path") and os.path.exists(self.test_file_path):
            try:
                os.remove(self.test_file_path)
            except Exception:
                pass

    def test_full_genre_lifecycle_api_and_recommendations(self):
        # 1. Проверяем начальное состояние через db.get_track и get_effective_genres
        track = db.get_track(self.track_id)
        self.assertIsNotNone(track)
        self.assertIsNone(track.get("genre"))
        effective = get_effective_genres(track)
        genre_names = [name for name, _ in effective]
        self.assertIn("Electronic", genre_names)
        self.assertIn("House", genre_names)  # "Deep House" normalizes to canonical "House"

        # 2. Пользователь слушает трек -> формируется аффинность из auto_genres
        db.add_history(self.user_id, self.track_id)
        affinities = get_user_genre_affinity(self.user_id)
        self.assertGreater(len(affinities), 0)
        affinity_genres = [a["genre"] for a in affinities]
        self.assertIn("Electronic", affinity_genres)
        self.assertNotIn("Jazz", affinity_genres)

        # 3. GET /api/tracks/{id} возвращает DTO с auto_genres и метаданными
        get_res = self.client.get(f"/api/tracks/{self.track_id}", headers=self.headers)
        self.assertEqual(get_res.status_code, 200)
        dto = get_res.json()
        self.assertEqual(dto["id"], self.track_id)
        self.assertFalse(dto.get("genre"))
        self.assertEqual(len(dto["auto_genres"]), 2)
        self.assertEqual(dto["auto_genres"][0]["name"], "Electronic")
        self.assertEqual(dto["auto_genre_model"], self.model_name)
        self.assertIsNotNone(dto["auto_genre_updated_at"])

        # 4. PATCH /api/tracks/{id} устанавливает ручной жанр "Jazz"
        patch_payload = {
            "genre": "Jazz",
            "cover_action": "keep",
        }
        patch_res = self.client.patch(f"/api/tracks/{self.track_id}", json=patch_payload, headers=self.headers)
        self.assertEqual(patch_res.status_code, 200)
        patched_data = patch_res.json()["track"]
        self.assertEqual(patched_data["genre"], "Jazz")
        # auto_genres НЕ затерты в ответе API
        self.assertEqual(len(patched_data["auto_genres"]), 2)
        self.assertEqual(patched_data["auto_genre_model"], self.model_name)

        # 4a. Проверяем файл на диске
        disk_meta = read_audio_metadata(self.test_file_path)
        self.assertEqual(disk_meta.genre, "Jazz")

        # 4b. Проверяем SQLite
        updated_db_track = db.get_track(self.track_id)
        self.assertEqual(updated_db_track["genre"], "Jazz")
        # auto_genres сохранены в SQLite
        self.assertIsNotNone(updated_db_track["auto_genres"])

        # 4c. Рекомендательный профиль пользователя: ручной жанр строго переопределил auto-жанры
        affinities_after_patch = get_user_genre_affinity(self.user_id)
        affinity_names_after = [a["genre"] for a in affinities_after_patch]
        self.assertEqual(affinity_names_after, ["Jazz"])
        self.assertNotIn("Electronic", affinity_names_after)
        self.assertNotIn("House", affinity_names_after)

        # 5. PATCH /api/tracks/{id} с пустым genre="" (пользователь очистил жанр)
        clear_payload = {
            "genre": "",
            "cover_action": "keep",
        }
        clear_res = self.client.patch(f"/api/tracks/{self.track_id}", json=clear_payload, headers=self.headers)
        self.assertEqual(clear_res.status_code, 200)
        cleared_data = clear_res.json()["track"]
        self.assertFalse(cleared_data.get("genre"))
        # auto_genres по-прежнему на месте
        self.assertEqual(len(cleared_data["auto_genres"]), 2)

        # 5a. Проверяем файл на диске: жанр удален
        disk_meta_cleared = read_audio_metadata(self.test_file_path)
        self.assertIsNone(disk_meta_cleared.genre)

        # 5b. Проверяем SQLite: ручной жанр None, auto_genres сохранены
        cleared_db_track = db.get_track(self.track_id)
        self.assertIsNone(cleared_db_track["genre"])
        self.assertIsNotNone(cleared_db_track["auto_genres"])

        # 5c. Рекомендательный профиль: fallback снова активирует auto_genres
        affinities_after_clear = get_user_genre_affinity(self.user_id)
        affinity_names_clear = [a["genre"] for a in affinities_after_clear]
        self.assertIn("Electronic", affinity_names_clear)
        self.assertNotIn("Jazz", affinity_names_clear)


if __name__ == "__main__":
    unittest.main()
