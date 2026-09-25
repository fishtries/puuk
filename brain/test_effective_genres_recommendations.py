"""Тесты логики fallback автоматических жанров и интеграционный тест персональных рекомендаций."""
import json
import os
import sys
import unittest
import uuid

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД

import db
from services.personalized_recommendation_service import (
    get_effective_genres,
    get_user_genre_affinity,
    _track_in_genre,
    _genre_candidates,
    get_personalized_genre_sections,
)


class TestEffectiveGenres(unittest.TestCase):
    def test_manual_genre_has_strict_priority(self):
        """Ручной genre всегда имеет приоритет и вес 1.0, даже если auto_genres не пуст."""
        track = {
            "genre": "Rock",
            "auto_genres": json.dumps([
                {"name": "Metal", "confidence": 0.80},
                {"name": "Hard Rock", "confidence": 0.65},
            ]),
        }
        effective = get_effective_genres(track)
        self.assertEqual(effective, [("Rock", 1.0)])

    def test_fallback_to_auto_genres_when_manual_empty(self):
        """При отсутствии ручного жанра используются auto_genres с весами confidence."""
        track = {
            "genre": None,
            "auto_genres": json.dumps([
                {"name": "House", "confidence": 0.82},
                {"name": "Electronic", "confidence": 0.51},
            ]),
        }
        effective = get_effective_genres(track)
        # Порядок в списке (дедуплицированный словарь)
        names = {g for g, _ in effective}
        self.assertEqual(names, {"House", "Electronic"})
        conf_map = dict(effective)
        self.assertAlmostEqual(conf_map["House"], 0.82)
        self.assertAlmostEqual(conf_map["Electronic"], 0.51)

    def test_both_empty_returns_empty_list(self):
        """Если нет ни ручного, ни авто-жанра, возвращается пустой список."""
        track_1 = {"genre": None, "auto_genres": None}
        track_2 = {"genre": "", "auto_genres": "[]"}
        self.assertEqual(get_effective_genres(track_1), [])
        self.assertEqual(get_effective_genres(track_2), [])

    def test_corrupted_auto_genres_json_handled_gracefully(self):
        """Невалидный JSON не ломает функцию и возвращает пустой список."""
        track = {"genre": None, "auto_genres": "invalid{json]"}
        self.assertEqual(get_effective_genres(track), [])


class TestGenreRecommendationsIntegration(unittest.TestCase):
    """Интеграционный тест:
    Создать 6 треков:
    track 1: genre = null, auto = House
    track 2: genre = null, auto = House
    track 3: genre = null, auto = House
    track 4: genre = null, auto = House
    track 5: genre = null, auto = House
    track 6: genre = Rock, auto = House
    Проверить:
    1. пользователь слушает track 1;
    2. профиль получает House;
    3. track 6 не попадает в House-секцию из-за ручного Rock;
    4. пять auto-House треков формируют секцию;
    5. ручное изменение track 1 на Jazz убирает его из auto-House-профиля;
    6. очистка ручного жанра возвращает fallback на auto-House.
    """

    def setUp(self):
        username = f"test_genre_user_{uuid.uuid4().hex[:8]}"
        self.user_id = db.create_user(username=username, password_hash="hash")
        self.tracks = []
        for i in range(1, 7):
            tid = f"test-genre-track-{uuid.uuid4().hex[:8]}-{i}"
            artist = f"Artist_{i}"
            manual_genre = "Rock" if i == 6 else None
            auto_json = json.dumps([{"name": "House", "confidence": 0.85}])
            db.add_or_update_track(
                track_id=tid,
                file_path=f"music/track_{i}.mp3",
                title=f"Test Track {i}",
                album_id=None,
                artist=artist,
                genre=manual_genre,
            )
            db.update_track_auto_genres(tid, json.loads(auto_json), "discogs-effnet")
            self.tracks.append(tid)

    def test_full_scenario(self):
        t1, t2, t3, t4, t5, t6 = self.tracks

        # 1. Пользователь слушает track 1 (у него genre=null, auto=House)
        db.add_history(self.user_id, t1)

        # 2. Профиль аффинности получает House
        affinity = get_user_genre_affinity(self.user_id)
        self.assertTrue(len(affinity) > 0)
        self.assertEqual(affinity[0]["genre"], "House")

        # 3. track 6 (genre=Rock, auto=House) НЕ попадает в кандидаты House
        track_6_db = db.get_track(t6)
        self.assertFalse(_track_in_genre(track_6_db, "house"))
        self.assertTrue(_track_in_genre(track_6_db, "rock"))

        candidates = _genre_candidates("house", set(), set())
        candidate_ids = {str(c["id"]) for c in candidates}
        self.assertNotIn(t6, candidate_ids)

        # 4. Пять auto-House треков (t1..t5) доступны как кандидаты House
        for t in [t1, t2, t3, t4, t5]:
            self.assertIn(t, candidate_ids)

        # 5. Ручное изменение track 1 на Jazz убирает его из House-профиля
        db.update_track_metadata(t1, "Test Track 1", "Artist_1", None, None)
        conn = db.get_connection()
        cur = conn.cursor()
        cur.execute("UPDATE tracks SET genre = 'Jazz' WHERE id = ?", (t1,))
        conn.commit()
        conn.close()

        # Теперь профиль слушателя t1 должен иметь Jazz, а не House
        affinity_after_jazz = get_user_genre_affinity(self.user_id)
        top_genres = [a["genre"] for a in affinity_after_jazz]
        self.assertIn("Jazz", top_genres)
        self.assertNotIn("House", top_genres)

        # 6. Очистка ручного жанра возвращает fallback на auto-House
        conn = db.get_connection()
        cur = conn.cursor()
        cur.execute("UPDATE tracks SET genre = NULL WHERE id = ?", (t1,))
        conn.commit()
        conn.close()

        affinity_after_clear = get_user_genre_affinity(self.user_id)
        top_genres_cleared = [a["genre"] for a in affinity_after_clear]
        self.assertIn("House", top_genres_cleared)
        self.assertNotIn("Jazz", top_genres_cleared)


if __name__ == "__main__":
    unittest.main()
