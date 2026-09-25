"""Тесты изолированного классификатора жанров AudioGenreClassifier."""
import json
import os
import sys
import unittest
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))

from services.audio_genre_classifier import AudioGenreClassifier


class TestAudioGenreClassifier(unittest.TestCase):
    def setUp(self):
        # Создаем синтетический список меток на 400 классов для тестов
        self.dummy_labels = [f"Genre---Style_{i}" for i in range(400)]
        self.dummy_labels[0] = "Electronic---House"
        self.dummy_labels[1] = "Electronic---Deep House"  # Алиас к House в genre_normalization
        self.dummy_labels[2] = "Electronic---Electro"
        self.dummy_labels[3] = "Rock---Indie Rock"
        self.dummy_labels[4] = "Hip Hop---Pop Rap"

        self.classifier = AudioGenreClassifier(min_confidence=0.20, top_k=3)
        self.classifier.labels = self.dummy_labels

    def test_top_k_and_confidence_sorting(self):
        """Результаты должны быть отсортированы по убыванию confidence и ограничены top_k."""
        preds = np.zeros((1, 400), dtype=np.float32)
        preds[0, 0] = 0.65  # House
        preds[0, 2] = 0.85  # Electro
        preds[0, 3] = 0.40  # Indie Rock
        preds[0, 4] = 0.30  # Pop Rap

        results = self.classifier.predict(preds)
        self.assertEqual(len(results), 3)
        # Electro (0.85) -> House (0.65) -> Indie Rock (0.40)
        self.assertEqual(results[0]["name"], "Electro")
        self.assertAlmostEqual(results[0]["confidence"], 0.85)
        self.assertEqual(results[1]["name"], "House")
        self.assertAlmostEqual(results[1]["confidence"], 0.65)
        self.assertEqual(results[2]["name"], "Indie Rock")
        self.assertAlmostEqual(results[2]["confidence"], 0.40)

    def test_confidence_threshold_filtering(self):
        """Жанры с confidence ниже min_confidence отбрасываются."""
        classifier = AudioGenreClassifier(min_confidence=0.50, top_k=5)
        classifier.labels = self.dummy_labels

        preds = np.zeros((1, 400), dtype=np.float32)
        preds[0, 0] = 0.70  # House
        preds[0, 2] = 0.45  # Electro (ниже 0.50)
        preds[0, 3] = 0.25  # Indie Rock (ниже 0.50)

        results = classifier.predict(preds)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["name"], "House")
        self.assertAlmostEqual(results[0]["confidence"], 0.70)

    def test_all_below_threshold_returns_empty(self):
        """Если все предсказания ниже порога, возвращается пустой список."""
        classifier = AudioGenreClassifier(min_confidence=0.80, top_k=3)
        classifier.labels = self.dummy_labels

        preds = np.full((1, 400), 0.10, dtype=np.float32)
        results = classifier.predict(preds)
        self.assertEqual(results, [])

    def test_deduplication_after_normalization(self):
        """Если несколько классов нормализуются в одно имя (алиасы), дубликаты исключаются."""
        preds = np.zeros((1, 400), dtype=np.float32)
        # Deep House нормализуется в House с более высоким confidence 0.82
        preds[0, 1] = 0.82  # Deep House -> House
        preds[0, 0] = 0.64  # House -> House
        preds[0, 2] = 0.51  # Electro -> Electro

        results = self.classifier.predict(preds)
        # Должны остаться только уникальные нормализованные жанры: House (0.82) и Electro (0.51)
        names = [r["name"] for r in results]
        self.assertEqual(names, ["House", "Electro"])
    def test_deduplication_continues_until_top_k_unique_genres(self):
        """Если первые классы схлопываются в один алиас, обход продолжается до набора top_k уникальных жанров."""
        self.dummy_labels[5] = "Electronic---Progressive House"
        preds = np.zeros((1, 400), dtype=np.float32)
        preds[0, 1] = 0.90  # Deep House -> House
        preds[0, 0] = 0.85  # House -> House (дубль)
        preds[0, 5] = 0.80  # Progressive House -> House (дубль)
        preds[0, 2] = 0.75  # Electro -> Electro (уникальный 2)
        preds[0, 3] = 0.70  # Indie Rock -> Indie Rock (уникальный 3)
        preds[0, 4] = 0.65  # Pop Rap -> Pop Rap (лишний)

        results = self.classifier.predict(preds)
        self.assertEqual(len(results), 3)
        names = [r["name"] for r in results]
        self.assertEqual(names, ["House", "Electro", "Indie Rock"])
        self.assertAlmostEqual(results[0]["confidence"], 0.90)
        self.assertAlmostEqual(results[1]["confidence"], 0.75)
        self.assertAlmostEqual(results[2]["confidence"], 0.70)

    def test_frame_aggregation(self):
        """Предсказания по нескольким фреймам усредняются вдоль оси времени."""
        preds = np.zeros((3, 400), dtype=np.float32)
        preds[0, 0] = 0.90
        preds[1, 0] = 0.60
        preds[2, 0] = 0.30
        # Среднее: (0.9 + 0.6 + 0.3) / 3 = 0.60

        results = self.classifier.predict(preds)
        self.assertEqual(results[0]["name"], "House")
        self.assertAlmostEqual(results[0]["confidence"], 0.60)

    def test_empty_input_handling(self):
        """Пустые входные данные и None возвращают пустой список без падения."""
        self.assertEqual(self.classifier.predict(None), [])
        self.assertEqual(self.classifier.predict([]), [])
        self.assertEqual(self.classifier.predict(np.array([])), [])

    def test_nan_and_inf_handling(self):
        """NaN и бесконечности не приводят к сбою классификатора."""
        preds = np.zeros((1, 400), dtype=np.float32)
        preds[0, 0] = np.nan
        preds[0, 2] = np.inf
        preds[0, 3] = 0.55  # Indie Rock

        results = self.classifier.predict(preds)
        # Indie Rock должен корректно определиться
        names = [r["name"] for r in results]
        self.assertIn("Indie Rock", names)

    def test_unexpected_shape_handling(self):
        """Неожиданные размерности не вызывают исключений."""
        preds = np.zeros((1, 100), dtype=np.float32)  # Не 400 и не 1280
        self.assertEqual(self.classifier.predict(preds), [])


if __name__ == "__main__":
    unittest.main()
