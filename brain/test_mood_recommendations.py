"""Тесты генерации mood-плейлистов («You'll like this»)."""
import os
import sys
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изоляция тестовой БД, до db/config

import db
from security import hash_password
from fastapi.testclient import TestClient
from api import app


class MockPoint:
    def __init__(self, pid, score, artist):
        self.id = pid
        self.score = score
        self.payload = {"artist": artist}


class TestMoodRecommendations(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.client = TestClient(app)

        name = f"mood_{uuid.uuid4().hex[:6]}"
        existing = db.get_user_by_username(name)
        if existing:
            db.delete_user(existing["id"])
        cls.user_id = db.create_user(name, hash_password("pass123"), role="admin")

        resp = cls.client.post("/api/auth/login", json={"username": name, "password": "pass123"})
        cls.headers = {"Authorization": f"Bearer {resp.json()['access_token']}"}

    def test_01_moods_catalog(self):
        """GET /api/recommendations/moods возвращает непустой каталог с полями."""
        resp = self.client.get("/api/recommendations/moods", headers=self.headers)
        self.assertEqual(resp.status_code, 200)
        moods = resp.json()
        self.assertIsInstance(moods, list)
        self.assertGreater(len(moods), 0)
        for m in moods:
            self.assertIn("id", m)
            self.assertIn("title", m)
            self.assertIn("description", m)

    def test_02_unknown_mood_404(self):
        resp = self.client.get(
            "/api/recommendations/moods/not-a-mood/playlist", headers=self.headers
        )
        self.assertEqual(resp.status_code, 404)

    def test_03_resolve_seed_ids_matches_keywords(self):
        """_resolve_mood_seed_ids находит треки по artist/title/genre/album."""
        from services.mood_recommendation_service import _resolve_mood_seed_ids

        db.add_or_update_track(
            "seed-ambient-1", "x.mp3", "Deep Ambient Space", None, "Some Artist", None
        )
        db.add_or_update_track(
            "seed-rock-1", "y.mp3", "Loud Rock", None, "Other Artist", None
        )

        mood = {"seed_keywords": ["ambient"]}
        ids = _resolve_mood_seed_ids(mood)
        self.assertIn("seed-ambient-1", ids)
        self.assertNotIn("seed-rock-1", ids)

    def test_04_mood_vector_fallback_when_no_seeds(self):
        """Без seed-треков mood-вектор падает на случайный готовый трек, а не на None."""
        import numpy as np
        from services import mood_recommendation_service as mrs

        class FakePoint:
            def __init__(self):
                self.id = "fallback-1"
                self.vector = np.ones(400, dtype=np.float32)

        with patch.object(mrs.db, "get_all_tracks", return_value=[]), \
             patch.object(mrs.recommendation_service, "scroll_random_ready_track", return_value=[FakePoint()]), \
             patch.object(mrs.client, "retrieve", return_value=[FakePoint()]):
            vec = mrs._compute_mood_vector("chill", {"seed_keywords": ["ambient"]})

        self.assertIsNotNone(vec)
        self.assertAlmostEqual(float(np.linalg.norm(vec)), 1.0, places=3)

    def test_05_generate_excludes_dislikes_and_dedups(self):
        """Генерация уважает дизлайки, не дублирует ID и укладывается в limit."""
        import numpy as np
        from services import mood_recommendation_service as mrs

        mood_vec = np.ones(400, dtype=np.float32) / 20

        candidates = [MockPoint(f"cand-{i}", 0.95 - i * 0.01, f"Artist {i}") for i in range(10)]

        class FakeResults:
            points = candidates

        with patch.object(mrs, "get_mood_vector", return_value=mood_vec), \
             patch.object(mrs.client, "query_points", return_value=FakeResults()), \
             patch.object(mrs.db, "get_recent_artists", return_value=[]):
            selected = mrs.generate_mood_playlist(
                mood_id="chill",
                limit=5,
                user_id=None,
                personalization_weight=0.0,
                dislike_ids={"cand-1"},
            )

        ids = [str(p.id) for p in selected]
        self.assertEqual(len(ids), 5)
        self.assertEqual(len(ids), len(set(ids)))
        self.assertNotIn("cand-1", ids)

    def test_06_save_creates_playlist(self):
        """save=true создаёт пользовательский плейлист с треками."""
        import numpy as np
        from services import mood_recommendation_service as mrs

        mood_vec = np.ones(400, dtype=np.float32) / 20
        candidates = [MockPoint(f"save-{i}", 0.95 - i * 0.01, f"Artist S{i}") for i in range(3)]

        class FakeResults:
            points = candidates

        with patch.object(mrs, "get_mood_vector", return_value=mood_vec), \
             patch.object(mrs.client, "query_points", return_value=FakeResults()), \
             patch.object(mrs.db, "get_recent_artists", return_value=[]):
            resp = self.client.get(
                "/api/recommendations/moods/chill/playlist?limit=3&save=true",
                headers=self.headers,
            )

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertIsNotNone(body["playlist"]["id"])
        self.assertEqual(len(body["tracks"]), 3)

        playlist = db.get_playlist(body["playlist"]["id"])
        self.assertIsNotNone(playlist)
        self.assertEqual(playlist["user_id"], self.user_id)


if __name__ == "__main__":
    unittest.main()
