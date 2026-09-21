import os
import sys
import unittest
import uuid
from datetime import datetime, timedelta
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД, должен идти до db/config

import db
import auth
from security import hash_password
from api import app, apply_diversity_penalty
from user_profile import compute_user_embedding, should_recompute_embedding
from fastapi.testclient import TestClient
from unittest.mock import MagicMock

class TestWavePersonalization(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.client = TestClient(app)

        # Подготовка тестового пользователя
        test_user_name = f"test_wave_user_{uuid.uuid4().hex[:6]}"
        existing = db.get_user_by_username(test_user_name)
        if existing:
            db.delete_user(existing["id"])

        cls.user_id = db.create_user(test_user_name, hash_password("pass123"), role="admin")

        # Получаем токен
        resp = cls.client.post("/api/auth/login", json={"username": test_user_name, "password": "pass123"})
        cls.token = resp.json()["access_token"]
        cls.headers = {"Authorization": f"Bearer {cls.token}"}

        # Создаем несколько тестовых треков в SQLite
        cls.tracks = []
        for i in range(5):
            tid = str(uuid.uuid4())
            cls.tracks.append(tid)
            db.add_or_update_track(
                track_id=tid,
                file_path=f"music/perso_track_{i}.mp3",
                title=f"Perso Track {i}",
                album_id=None,
                artist=f"Artist {i % 2}",  # Artist 0 и Artist 1
                lyrics="",
                duration=180.0
            )

    def test_01_db_embedding_blob_storage(self):
        """Проверка сохранения и десериализации 400-мерного вектора в SQLite BLOB."""
        test_vec = np.random.randn(400).astype(np.float32)
        test_vec /= np.linalg.norm(test_vec)

        db.set_user_embedding(self.user_id, test_vec, track_count=15)
        retrieved = db.get_user_embedding(self.user_id)

        self.assertIsNotNone(retrieved)
        self.assertEqual(retrieved.shape, (400,))
        self.assertTrue(np.allclose(test_vec, retrieved, atol=1e-5))

        meta = db.get_user_embedding_metadata(self.user_id)
        self.assertIsNotNone(meta)
        self.assertEqual(meta["track_count"], 15)

    def test_02_wave_feedback_and_stats(self):
        """Проверка записи фидбека и обновления track_stats."""
        tid = self.tracks[0]

        # Записываем finish (180 сек / 180 сек)
        db.add_wave_feedback(self.user_id, tid, "finish", 180000, 180000)
        db.update_track_stats(tid, "finish", 1.0)

        # Записываем skip (30 сек / 180 сек)
        db.add_wave_feedback(self.user_id, tid, "skip", 30000, 180000)
        db.update_track_stats(tid, "skip", 30000 / 180000)

        # Записываем like
        db.add_wave_feedback(self.user_id, tid, "like", 90000, 180000)
        db.update_track_stats(tid, "like", 0.5)

        summary = db.get_wave_stats_summary()
        self.assertGreaterEqual(summary["total_events"], 3)

        profile_stats = db.get_user_profile_stats(self.user_id)
        self.assertGreaterEqual(profile_stats["feedback_count"], 3)

    def test_03_recompute_threshold_triggers(self):
        """Проверка логики should_recompute_embedding (10 треков или 24 часа)."""
        # 1. Если нет кэша в БД
        fake_uid = 999999
        self.assertTrue(should_recompute_embedding(fake_uid))

        # 2. Если кэш есть и свежий, но новых треков мало
        db.set_user_embedding(self.user_id, np.zeros(400, dtype=np.float32), track_count=100)
        # История меньше 100 + 10 -> False
        self.assertFalse(should_recompute_embedding(self.user_id, threshold=10, hours=24))

    def test_04_user_embedding_computation_normalization(self):
        """Проверка взвешенного среднего и L2-нормализации вектора пользователя."""
        mock_qdrant = MagicMock()

        # Эмулируем ответ retrieve с 400-мерными векторами
        v1 = np.ones(400, dtype=np.float32)
        v2 = np.ones(400, dtype=np.float32) * 2

        p1 = MagicMock(id=self.tracks[0], vector=v1.tolist())
        p2 = MagicMock(id=self.tracks[1], vector=v2.tolist())
        mock_qdrant.retrieve.return_value = [p1, p2]

        db.add_history(self.user_id, self.tracks[0])
        db.add_favorite(self.user_id, self.tracks[1])

        emb = compute_user_embedding(self.user_id, mock_qdrant, like_weight=2.0)
        self.assertIsNotNone(emb)
        self.assertEqual(emb.shape, (400,))
        norm = np.linalg.norm(emb)
        self.assertAlmostEqual(norm, 1.0, places=5)

    def test_05_diversity_penalty(self):
        """Проверка применения штрафа за повторяющихся исполнителей."""
        class MockScoredPoint:
            def __init__(self, pid, score, artist):
                self.id = pid
                self.score = score
                self.payload = {"artist": artist}

        points = [
            MockScoredPoint("t1", 0.90, "Queen"),
            MockScoredPoint("t2", 0.88, "Queen"),
            MockScoredPoint("t3", 0.85, "Daft Punk")
        ]

        recent_artists = ["Queen", "Queen", "Nirvana"]
        adjusted = apply_diversity_penalty(points, recent_artists, penalty=0.05)

        # Queen имеет 2 повторения в истории -> штраф 0.10
        # t1: 0.90 - 0.10 = 0.80
        # t2: 0.88 - 0.10 = 0.78
        # t3: 0.85 - 0.00 = 0.85
        # Топ должен возглавить Daft Punk!
        self.assertEqual(adjusted[0].id, "t3")
        self.assertAlmostEqual(adjusted[0].score, 0.85)

    def test_06_api_feedback_endpoint(self):
        """Проверка API эндпоинта POST /api/wave/feedback."""
        tid = self.tracks[2]
        payload = {
            "track_id": tid,
            "event_type": "like",
            "listen_duration_ms": 75000,
            "track_duration_ms": 180000
        }
        resp = self.client.post("/api/wave/feedback", json=payload, headers=self.headers)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"status": "ok"})

        # Проверяем, что трек добавился в избранное
        favs = db.get_favorite_track_ids(self.user_id)
        self.assertIn(tid, favs)

    def test_07_api_profile_stats_endpoint(self):
        """Проверка API эндпоинтов GET /api/user/profile-stats и /api/wave/profile-stats."""
        resp1 = self.client.get("/api/user/profile-stats", headers=self.headers)
        self.assertEqual(resp1.status_code, 200)
        data1 = resp1.json()
        self.assertIn("track_count", data1)
        self.assertIn("is_personalized", data1)

        resp2 = self.client.get("/api/wave/profile-stats", headers=self.headers)
        self.assertEqual(resp2.status_code, 200)
        self.assertEqual(data1["track_count"], resp2.json()["track_count"])

    def test_08_api_wave_queue_cold_start(self):
        """Проверка GET /api/wave/queue при холодном старте (без current_track_id или random)."""
        resp = self.client.get("/api/wave/queue", headers=self.headers)
        # Если коллекция Qdrant доступна, возвращает список очереди
        self.assertEqual(resp.status_code, 200)
        self.assertIsInstance(resp.json(), list)

    def test_09_api_admin_wave_stats(self):
        """Проверка GET /api/wave/admin/wave-stats для администратора."""
        resp = self.client.get("/api/wave/admin/wave-stats", headers=self.headers)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("total_events", data)
        self.assertIn("breakdown", data)

    def test_10_rate_limiting(self):
        """Проверка срабатывания rate limiting при частом спаме фидбеком."""
        from routers.wave import feedback_rate_limiter
        rate_key = f"user_{self.user_id}_127.0.0.1"
        # Заполняем лимитер
        for _ in range(100):
            feedback_rate_limiter.is_allowed(rate_key)
        
        # 101-й запрос должен вернуть False
        self.assertFalse(feedback_rate_limiter.is_allowed(rate_key))

    def test_11_e2e_hybrid_blending(self):
        """Проверка смешивания векторов текущего трека и профиля пользователя."""
        from api import get_smart_recommendations, client as qdrant_client
        # Берем реальный трек из Qdrant
        records, _ = qdrant_client.scroll(collection_name="tracks", limit=2, with_vectors=True, with_payload=True)
        if len(records) >= 2:
            seed_id = str(records[0].id)
            fav_id = str(records[1].id)

            # Сохраняем искусственный профиль пользователя, сильно сдвинутый к fav_id
            fav_vector = np.array(records[1].vector, dtype=np.float32)
            db.set_user_embedding(self.user_id, fav_vector, track_count=20)

            # 1. Рекомендации без персонализации (чистый content)
            pure_recs = get_smart_recommendations(
                seed_id, limit=5, existing_track=records[0], user_id=None, personalization_weight=0.0
            )

            # 2. Рекомендации с персонализацией 50%
            hybrid_recs = get_smart_recommendations(
                seed_id, limit=5, existing_track=records[0], user_id=self.user_id, personalization_weight=0.5
            )

            pure_ids = [str(p.id) for p in pure_recs]
            hybrid_ids = [str(p.id) for p in hybrid_recs]

            self.assertTrue(len(hybrid_recs) > 0)
            self.assertIsNotNone(hybrid_recs[0].score)

if __name__ == "__main__":
    unittest.main()
