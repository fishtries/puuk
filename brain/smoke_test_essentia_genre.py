"""Smoke-тест интеграции Essentia и авто-жанров на реальном аудиофайле.

Проверяет:
1. Модели загружаются без ошибок.
2. Predictions имеют ожидаемую форму (N, 400).
3. 400-мерный вектор для Qdrant вычисляется корректно (len == 400).
4. Auto-жанры отбираются (top-k, threshold, normalizer).
5. Auto-жанры сохраняются в SQLite (миграция 005, tracks.auto_genres).
6. Ручной genre не изменяется и сохраняет значение.
7. В Qdrant payload передаются auto_genres и auto_genre_model.
"""
import json
import os
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД

import db
import heavy_worker


class SmokeTestEssentiaGenre(unittest.TestCase):
    def test_real_audio_pipeline(self):
        audio_file = Path(__file__).resolve().parent / "temp_audio" / "Daft Punk - Around the World.mp3"
        self.assertTrue(audio_file.exists(), f"Файл {audio_file} не найден")

        # 1. Загрузка моделей
        extractor, extractor_fallback, genre_classifier = heavy_worker.init_models()
        self.assertIsNotNone(extractor, "Основной экстрактор discogs-effnet не загрузился")
        self.assertIsNotNone(genre_classifier, "Классификатор жанров не загрузился")
        self.assertIsNotNone(genre_classifier.genre_model, "TensorflowPredict2D не инициализирован")

        # 2. Обработка реального аудиофайла
        vec, auto_genres, model_name = heavy_worker.process_audio_file(
            audio_file, extractor, extractor_fallback, genre_classifier
        )

        # 3. Проверка формы вектора
        self.assertIsInstance(vec, list)
        self.assertEqual(len(vec), 400, "Вектор Qdrant должен иметь размерность 400")

        # 4. Проверка авто-жанров
        self.assertIsNotNone(auto_genres, "Авто-жанры не должны быть пустыми для Daft Punk")
        self.assertTrue(len(auto_genres) >= 1)
        genre_names = [g["name"] for g in auto_genres]
        self.assertIn("House", genre_names, f"House должен быть среди предсказанных жанров: {genre_names}")
        self.assertEqual(model_name, "genre_discogs400-discogs-effnet-1")

        # 5. Проверка сохранения в SQLite с защитой ручного genre
        track_id = f"smoke-track-{uuid.uuid4().hex[:8]}"
        db.add_or_update_track(
            track_id=track_id,
            file_path="temp_audio/Daft Punk - Around the World.mp3",
            title="Around the World",
            album_id=None,
            artist="Daft Punk",
            genre="Electronic (Manual)",
        )

        mock_qdrant = MagicMock()
        payload = {"file_path": "temp_audio/Daft Punk - Around the World.mp3", "title": "Around the World"}
        heavy_worker.update_database_records(
            mock_qdrant, track_id, vec, payload, auto_genres, model_name
        )

        # 6. Проверка SQLite записи
        track = db.get_track(track_id)
        self.assertIsNotNone(track)
        self.assertEqual(track["genre"], "Electronic (Manual)", "Ручной genre не должен быть затерт!")
        self.assertEqual(track["auto_genre_model"], "genre_discogs400-discogs-effnet-1")
        self.assertIsNotNone(track["auto_genres"])
        saved_auto = json.loads(track["auto_genres"])
        self.assertEqual(saved_auto, auto_genres)

        # 7. Проверка Qdrant payload
        mock_qdrant.upsert.assert_called_once()
        call_kwargs = mock_qdrant.upsert.call_args[1]
        upserted_points = call_kwargs["points"]
        self.assertEqual(len(upserted_points), 1)
        pt = upserted_points[0]
        self.assertEqual(len(pt.vector), 400)
        self.assertEqual(pt.payload["auto_genres"], auto_genres)
        self.assertEqual(pt.payload["auto_genre_model"], "genre_discogs400-discogs-effnet-1")
        self.assertFalse(pt.payload["needs_embedding"])


if __name__ == "__main__":
    unittest.main()
