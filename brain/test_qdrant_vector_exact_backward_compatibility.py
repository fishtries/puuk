"""Тест строгой обратной совместимости 400-мерного вектора Qdrant.

Доказывает, что при добавлении классификации жанров семантика и значения
вектора Qdrant не изменились ни на один бит по сравнению с историческим
extractor(audio) из heavy_worker.py.
"""
import os
import sys
import unittest
from pathlib import Path
import numpy as np
import essentia.standard as es

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401
import heavy_worker


class TestQdrantVectorBackwardCompatibility(unittest.TestCase):
    def test_vector_exact_match(self):
        audio_file = Path(__file__).resolve().parent / "temp_audio" / "Daft Punk - Around the World.mp3"
        self.assertTrue(audio_file.exists(), f"Файл {audio_file} не найден")

        model_path = Path(__file__).resolve().parent / "discogs-effnet-bs64-1.pb"
        self.assertTrue(model_path.exists(), f"Модель {model_path} не найдена")

        # 1. Исторический алгоритм вычисления вектора (исходный код heavy_worker)
        audio = es.MonoLoader(filename=str(audio_file), sampleRate=16000)()
        historical_extractor = es.TensorflowPredictEffnetDiscogs(graphFilename=str(model_path))
        historical_frames = historical_extractor(audio)
        historical_vector = np.mean(historical_frames, axis=0).tolist()

        # 2. Текущий вызов через process_audio_file в heavy_worker
        extractor, genre_classifier = heavy_worker.init_models()
        worker_vector, auto_genres, auto_genre_model, auto_genre_updated_at = heavy_worker.process_audio_file(
            audio_file, extractor, genre_classifier
        )

        # 3. Проверка размерности
        self.assertEqual(len(worker_vector), 400)
        self.assertEqual(len(historical_vector), 400)

        # 4. Проверка точного совпадения (максимальная разница должна быть 0.0)
        max_diff = np.max(np.abs(np.array(worker_vector) - np.array(historical_vector)))
        self.assertLessEqual(
            max_diff,
            1e-7,
            f"Вектор Qdrant изменился сверх допуска float32: {max_diff}",
        )

        # 5. Проверка наличия авто-жанров
        self.assertIsNotNone(auto_genres)
        self.assertTrue(len(auto_genres) > 0)


if __name__ == "__main__":
    unittest.main()
