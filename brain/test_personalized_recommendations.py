"""Тесты персональных жанровых подборок «You'll like this»."""
import os
import sys
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изоляция тестовой БД, до db/config

import db
import auth
from security import hash_password
from services.genre_normalization import extract_genres, normalize_genre
from services import personalized_recommendation_service as prs
from fastapi.testclient import TestClient
from api import app


def _make_track(title, artist, genre, album_title=None):
    """Создает трек с жанром (add_or_update_track не пишет genre) и возвращает id."""
    track_id = f"trk_{uuid.uuid4().hex[:10]}"
    album_id = db.add_or_get_album(album_title) if album_title else None
    db.add_or_update_track(track_id, f"{track_id}.mp3", title, album_id, artist)
    conn = db.get_connection()
    conn.execute("UPDATE tracks SET genre = ? WHERE id = ?", (genre, track_id))
    conn.commit()
    conn.close()
    return track_id


def _unique_genre(prefix):
    """Уникальный жанр на тест: каталог БД общий, пересечений кандидатов быть не должно."""
    return f"{prefix} {uuid.uuid4().hex[:8]}"


class FakePoint:
    def __init__(self, pid, score, artist):
        self.id = pid
        self.score = score
        self.payload = {"artist": artist}


class FakeResults:
    def __init__(self, points):
        self.points = points


class TestGenreNormalization(unittest.TestCase):
    def test_none_and_empty_variants(self):
        self.assertIsNone(normalize_genre(None))
        self.assertIsNone(normalize_genre(""))
        self.assertIsNone(normalize_genre("   "))
        self.assertIsNone(normalize_genre("Unknown"))
        self.assertIsNone(normalize_genre("unknown"))
        self.assertIsNone(normalize_genre("?"))
        self.assertEqual(extract_genres(None), [])
        self.assertEqual(extract_genres(""), [])

    def test_case_and_whitespace(self):
        self.assertEqual(normalize_genre("  Jazz  "), "Jazz")
        self.assertEqual(normalize_genre("jazz"), "Jazz")
        self.assertEqual(normalize_genre("LO-FI"), "Lo-fi")
        self.assertEqual(normalize_genre("lo-fi"), "Lo-fi")

    def test_aliases(self):
        for raw in ("hip hop", "Hip-Hop", "HIPHOP", "Rap"):
            self.assertEqual(normalize_genre(raw), "Hip-Hop")
        for raw in ("electronic", "Electronica", "electronica music"):
            self.assertEqual(normalize_genre(raw), "Electronic")
        for raw in ("indie rock", "Indie-Rock"):
            self.assertEqual(normalize_genre(raw), "Indie Rock")
        for raw in ("alternative", "Alternative Rock", "alt rock"):
            self.assertEqual(normalize_genre(raw), "Alternative Rock")
        for raw in ("r&b", "RnB", "rhythm and blues"):
            self.assertEqual(normalize_genre(raw), "R&B")
        for raw in ("house", "Deep House", "progressive house"):
            self.assertEqual(normalize_genre(raw), "House")

    def test_unknown_subgenre_stays_itself(self):
        self.assertEqual(normalize_genre("JAZZ"), "Jazz")
        self.assertEqual(normalize_genre("Drum And Bass"), "Drum And Bass")
        self.assertEqual(normalize_genre("Synthwave"), "Synthwave")

    def test_extract_multiple_genres(self):
        self.assertEqual(extract_genres("Electronic; House"), ["Electronic", "House"])
        self.assertEqual(extract_genres("Rock / Jazz"), ["Rock", "Jazz"])
        self.assertEqual(extract_genres("Pop, Rock;Jazz"), ["Pop", "Rock", "Jazz"])

    def test_extract_dedup_stable_order(self):
        self.assertEqual(extract_genres("hip-hop / Rap"), ["Hip-Hop"])
        self.assertEqual(extract_genres("Rock; rock / ROCK"), ["Rock"])
        self.assertEqual(extract_genres("Electronic; House; Electronic"), ["Electronic", "House"])


class TestGenreAffinity(unittest.TestCase):
    def setUp(self):
        db.init_db()
        name = f"aff_{uuid.uuid4().hex[:8]}"
        self.user_id = db.create_user(name, hash_password("pass123"), role="admin")

    def test_empty_profile(self):
        self.assertEqual(prs.get_user_genre_affinity(self.user_id), [])

    def test_dislike_does_not_form_positive(self):
        track = _make_track("Hated Song", "Nickelback", "Rock")
        db.add_history(self.user_id, track)
        db.add_history(self.user_id, track)
        db.add_dislike(self.user_id, track)
        self.assertEqual(prs.get_user_genre_affinity(self.user_id), [])

    def test_favorite_beats_listening(self):
        fav_track = _make_track("Loved Jazz", "Miles Davis", "Jazz")
        listened = _make_track("Heard Rock", "AC/DC", "Rock")
        db.add_favorite(self.user_id, fav_track)
        db.add_history(self.user_id, listened)

        by_genre = {a["genre"]: a for a in prs.get_user_genre_affinity(self.user_id)}
        self.assertGreater(by_genre["Jazz"]["score"], by_genre["Rock"]["score"])

    def test_repeated_listens_capped(self):
        single = _make_track("One Track Loop", "Loop Artist", "Jazz")
        for _ in range(5):
            db.add_history(self.user_id, single)

        rock_ids = [
            _make_track(f"Rock Hit {i}", f"Rock Artist {i}", "Rock") for i in range(4)
        ]
        for tid in rock_ids:
            db.add_history(self.user_id, tid)

        by_genre = {a["genre"]: a for a in prs.get_user_genre_affinity(self.user_id)}
        # Без капа Jazz весил бы 5.0 против 4.0; с капом (3.0) Rock выигрывает.
        self.assertGreater(by_genre["Rock"]["score"], by_genre["Jazz"]["score"])

    def test_score_formula_and_breadth(self):
        single = _make_track("Formula Song", "Formula Artist", "Jazz")
        db.add_history(self.user_id, single)
        affinity = prs.get_user_genre_affinity(self.user_id)
        self.assertEqual(len(affinity), 1)
        expected = 1.0 * 0.85 + min(1 / 5, 1.0) * 0.15
        self.assertAlmostEqual(affinity[0]["score"], expected, places=6)
        self.assertEqual(affinity[0]["track_count"], 1)
        self.assertEqual(affinity[0]["artist_count"], 1)

        for i in range(4):
            db.add_history(
                self.user_id, _make_track(f"Breadth {i}", f"Breadth Artist {i}", "House")
            )
        by_genre = {a["genre"]: a for a in prs.get_user_genre_affinity(self.user_id)}
        self.assertEqual(by_genre["House"]["artist_count"], 4)
        self.assertGreater(by_genre["House"]["score"], by_genre["Jazz"]["score"])

    def test_sorted_by_score_desc_and_multi_genre_track(self):
        shared = _make_track("Shared Song", "Shared Artist", "Techno; House")
        db.add_favorite(self.user_id, shared)
        for i in range(3):
            db.add_history(self.user_id, _make_track(f"Pop Song {i}", f"Pop Artist {i}", "Pop"))

        affinity = prs.get_user_genre_affinity(self.user_id)
        scores = [a["score"] for a in affinity]
        self.assertEqual(scores, sorted(scores, reverse=True))
        # Трек с двумя жанрами учитывается в обоих.
        genres = {a["genre"] for a in affinity}
        self.assertLessEqual({"Techno", "House"}, genres)

    def test_multi_genre_weight_split_evenly(self):
        multi = _make_track("Both Worlds", "Split Artist", "Hip-Hop; Trap")
        single = _make_track("Pure Rock", "Rock Artist", "Rock")
        db.add_favorite(self.user_id, multi)
        db.add_favorite(self.user_id, single)

        by_genre = {a["genre"]: a for a in prs.get_user_genre_affinity(self.user_id)}
        self.assertEqual(set(by_genre), {"Hip-Hop", "Trap", "Rock"})

        total_weight = 2 * prs.FAVORITE_TOTAL_WEIGHT  # два лайка по 3.0

        def recovered_weight(a):
            """Обратная формула score -> вклад жанра в общий вес профиля."""
            breadth = (
                min(a["artist_count"] / prs.ARTIST_BREADTH_TARGET_ARTISTS, 1.0)
                * prs.ARTIST_BREADTH_WEIGHT
            )
            return (a["score"] - breadth) / prs.GENRE_SCORE_WEIGHT * total_weight

        # Чистый жанр получает полный вес лайка.
        self.assertAlmostEqual(recovered_weight(by_genre["Rock"]), prs.FAVORITE_TOTAL_WEIGHT, places=6)
        # Лайк мультижанрового трека даёт суммарно 3.0 по жанрам (1.5 + 1.5), а не 6.0.
        self.assertAlmostEqual(recovered_weight(by_genre["Hip-Hop"]), 1.5, places=6)
        self.assertAlmostEqual(recovered_weight(by_genre["Trap"]), 1.5, places=6)


class TestGenreSections(unittest.TestCase):
    def setUp(self):
        db.init_db()
        name = f"sec_{uuid.uuid4().hex[:8]}"
        self.user_id = db.create_user(name, hash_password("pass123"), role="admin")
        patcher = patch.object(prs, "get_or_compute_user_embedding_fresh", return_value=None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _genre_with_tracks(self, genre, count, artist_prefix="Artist", favorite=True):
        ids = []
        for i in range(count):
            tid = _make_track(f"{genre} Track {i}", f"{artist_prefix} {i}", genre)
            ids.append(tid)
            if favorite:
                db.add_favorite(self.user_id, tid)
        return ids

    def test_four_tracks_no_section_five_give_section(self):
        genre = _unique_genre("Testjazz")
        self._genre_with_tracks(genre, 4)
        self.assertEqual(
            prs.get_personalized_genre_sections(self.user_id, base_url="http://x"), []
        )

        extra = _make_track("Jazz Track 5", "Artist 5", genre)
        sections = prs.get_personalized_genre_sections(self.user_id, base_url="http://x")
        self.assertEqual(len(sections), 1)
        self.assertEqual(len(sections[0]["tracks"]), 5)
        self.assertIn(extra, [t["id"] for t in sections[0]["tracks"]])
        self.assertEqual(sections[0]["type"], "genre")
        self.assertEqual(sections[0]["genre"], genre)

    def test_section_tracks_not_exceed_limit(self):
        genre = _unique_genre("Testrock")
        self._genre_with_tracks(genre, 7)
        sections = prs.get_personalized_genre_sections(
            self.user_id, section_limit=1, track_limit=6, base_url="http://x"
        )
        self.assertEqual(len(sections), 1)
        self.assertEqual(len(sections[0]["tracks"]), 6)

    def test_small_limit_does_not_drop_section(self):
        # Жанр с достаточным числом кандидатов (>= MIN_SECTION_TRACKS) публикуется
        # даже при явном limit < 5: секция содержит ровно limit треков.
        genre = _unique_genre("Testsmall")
        self._genre_with_tracks(genre, 6)
        sections = prs.get_personalized_genre_sections(
            self.user_id, section_limit=1, track_limit=3, base_url="http://x"
        )
        self.assertEqual(len(sections), 1)
        self.assertEqual(len(sections[0]["tracks"]), 3)

    def test_max_three_sections_by_default(self):
        for genre in (_unique_genre("Testjazz"), _unique_genre("Testrock"),
                      _unique_genre("Testhouse"), _unique_genre("Testpop")):
            self._genre_with_tracks(genre, 5, artist_prefix=f"{genre} Artist")
        sections = prs.get_personalized_genre_sections(self.user_id, base_url="http://x")
        self.assertEqual(len(sections), 3)

    def test_top_genre_without_enough_candidates_skipped(self):
        # Топ-1 жанр с 4 треками не должен занимать слот: секции строятся
        # из следующих подходящих жанров (сначала фильтр, потом топ-N).
        thin = _unique_genre("Testthin")
        self._genre_with_tracks(thin, 4)
        rich_genres = [_unique_genre("Testrich") for _ in range(3)]
        for rich in rich_genres:
            for i in range(5):
                tid = _make_track(f"{rich} Track {i}", f"{rich} Artist {i}", rich)
                db.add_history(self.user_id, tid)

        sections = prs.get_personalized_genre_sections(self.user_id, base_url="http://x")
        self.assertEqual(len(sections), 3)
        section_genres = {s["genre"] for s in sections}
        self.assertNotIn(thin, section_genres)
        self.assertEqual(section_genres, set(rich_genres))

    def test_genre_guard_excludes_foreign_and_empty_genre(self):
        genre = _unique_genre("Testguard")
        good = _make_track("Guard Good", "Guard Good Artist", genre)
        foreign = _make_track("Guard Foreign", "Guard Foreign Artist", "Polka")
        empty = _make_track("Guard Empty", "Guard Empty Artist", "")
        # Имитация утечки: _genre_candidates вернул треки без жанрового фильтра —
        # guard при сборке секции обязан отсечь чужой/пустой genre.
        leaked = [db.get_track(tid) for tid in (good, foreign, empty)]
        with patch.object(prs, "_genre_candidates", return_value=leaked):
            result = prs.generate_genre_playlist(
                self.user_id, genre, limit=10, base_url="http://x"
            )
        self.assertEqual([t["id"] for t in result], [good])

    def test_recent_listened_excluded_only_with_enough_alternatives(self):
        # 3 свежепрослушанных + 5 чистых: альтернатив хватает (5 >= MIN_SECTION_TRACKS).
        genre = _unique_genre("Testfresh")
        fresh_ids = []
        for i in range(3):
            tid = _make_track(f"Fresh Hit {i}", f"Fresh Artist {i}", genre)
            db.add_history(self.user_id, tid)
            fresh_ids.append(tid)
        clean_ids = [
            _make_track(f"Clean Hit {i}", f"Clean Artist {i}", genre) for i in range(5)
        ]

        result = prs.generate_genre_playlist(
            self.user_id, genre, limit=10, base_url="http://x"
        )
        # Свежепрослушанные исключены, секция собрана из альтернатив.
        self.assertEqual(sorted(t["id"] for t in result), sorted(clean_ids))

        # Альтернатив не хватает (4 < 5): недавно прослушанные возвращаются.
        small = _unique_genre("Testfreshsmall")
        small_ids = []
        for i in range(4):
            tid = _make_track(f"Only Fresh {i}", f"Only Artist {i}", small)
            db.add_history(self.user_id, tid)
            small_ids.append(tid)

        result_small = prs.generate_genre_playlist(
            self.user_id, small, limit=10, base_url="http://x"
        )
        self.assertEqual(sorted(t["id"] for t in result_small), sorted(small_ids))

    def test_dislikes_and_exclude_ids_excluded(self):
        genre = _unique_genre("Testrock")
        ids = self._genre_with_tracks(genre, 6)
        db.add_dislike(self.user_id, ids[0])
        result = prs.generate_genre_playlist(
            self.user_id, genre, limit=10, exclude_ids={ids[1]}, base_url="http://x"
        )
        result_ids = [t["id"] for t in result]
        self.assertNotIn(ids[0], result_ids)
        self.assertNotIn(ids[1], result_ids)
        self.assertEqual(len(result_ids), len(set(result_ids)))

    def test_no_duplicate_ids_between_sections(self):
        rock_genre = _unique_genre("Testrock")
        jazz_genre = _unique_genre("Testjazz")
        shared = _make_track("Shared Multi", "Aaa Multi", f"{rock_genre}; {jazz_genre}")
        db.add_favorite(self.user_id, shared)
        self._genre_with_tracks(rock_genre, 5, artist_prefix="Bbb Rock")
        self._genre_with_tracks(jazz_genre, 5, artist_prefix="Ccc Jazz")

        sections = prs.get_personalized_genre_sections(self.user_id, base_url="http://x")
        self.assertEqual(len(sections), 2)
        seen: set[str] = set()
        for section in sections:
            for track in section["tracks"]:
                self.assertNotIn(track["id"], seen, "Трек попал в две секции")
                seen.add(track["id"])

    def test_artist_cap_two_with_alternatives(self):
        genre = _unique_genre("Testalt")
        for i in range(6):
            tid = _make_track(f"Dup Song {i}", "Dup Artist", genre)
            db.add_favorite(self.user_id, tid)
        for i in range(4):
            tid = _make_track(f"Alt Song {i}", f"Unique Artist {i}", genre)
            db.add_favorite(self.user_id, tid)

        result = prs.generate_genre_playlist(
            self.user_id, genre, limit=6, base_url="http://x"
        )
        # При наличии альтернатив (2 Dup + 4 Unique >= limit) кап соблюдается.
        dup_count = sum(1 for t in result if t["artist"] == "Dup Artist")
        self.assertLessEqual(dup_count, prs.MAX_TRACKS_PER_ARTIST)
        self.assertEqual(len(result), 6)

    def test_sqlite_fallback_order_deterministic(self):
        genre = _unique_genre("Testelectronic")
        hist_track = _make_track("Zzz History", "Aaa History", genre)
        db.add_history(self.user_id, hist_track)
        for artist in ("Zed", "Alpha", "Mid"):
            tid = _make_track(f"Fav {artist}", artist, genre)
            db.add_favorite(self.user_id, tid)

        result = prs.generate_genre_playlist(
            self.user_id, genre, limit=10, base_url="http://x"
        )
        # Избранные (по artist) идут раньше просто прослушанного.
        self.assertEqual(
            [t["artist"] for t in result], ["Alpha", "Mid", "Zed", "Aaa History"]
        )
        # Честный локальный рейтинг из favorite/history бонусов, без random:
        # лайк = FAVORITE_BONUS, прослушивание = RECENT_POSITIVE_BONUS.
        self.assertEqual([t["score"] for t in result], [0.15, 0.15, 0.15, 0.05])
        # Детерминизм: повторный вызов даёт идентичный ответ.
        again = prs.generate_genre_playlist(
            self.user_id, genre, limit=10, base_url="http://x"
        )
        self.assertEqual(again, result)


class TestQdrantRanking(unittest.TestCase):
    def setUp(self):
        db.init_db()
        name = f"qdr_{uuid.uuid4().hex[:8]}"
        self.user_id = db.create_user(name, hash_password("pass123"), role="admin")
        import numpy as np

        self.vec = np.ones(400, dtype=np.float32) / 20

    def test_ranking_with_bonuses_and_penalties(self):
        genre = _unique_genre("Testjazz")
        j1 = _make_track("Jazz One", "Jazz Artist One", genre)
        j2 = _make_track("Jazz Two", "Jazz Artist Two", genre)
        j3 = _make_track("Jazz Three", "Jazz Artist Three", genre)
        j4 = _make_track("Jazz Four", "Jazz Artist Four", genre)
        j5 = _make_track("Jazz Five", "Jazz Artist Five", genre)
        db.add_favorite(self.user_id, j1)
        db.add_history(self.user_id, j2)
        seed = _make_track("Seed Pop", "Jazz Artist Five", "Pop")
        db.add_history(self.user_id, seed)

        points = [
            FakePoint(j1, 0.5, "Jazz Artist One"),
            FakePoint(j2, 0.5, "Jazz Artist Two"),
            FakePoint(j3, 0.5, "Jazz Artist Three"),
            FakePoint(j4, 0.5, "Jazz Artist Four"),
            FakePoint(j5, 0.5, "Jazz Artist Five"),
        ]
        with patch.object(prs, "get_or_compute_user_embedding_fresh", return_value=self.vec), \
             patch.object(prs.client, "query_points", return_value=FakeResults(points)):
            result = prs.generate_genre_playlist(self.user_id, genre, limit=5, base_url="http://x")

        # j1: +0.15 лайк; j4/j3: чистый 0.5, tie-break по artist (Four < Three);
        # j5: -0.05 недавний артист;
        # j2: +0.05 история -0.10 свежесть -0.05 артист (в истории = недавний артист).
        self.assertEqual([t["id"] for t in result], [j1, j4, j3, j5, j2])
        self.assertEqual(result[0]["score"], 0.65)
        self.assertTrue(result[0]["is_liked"])
        self.assertEqual(result[0]["stream_url"], f"http://x/api/stream/{j1}")

    def test_fill_from_sqlite_when_qdrant_pool_small(self):
        genre = _unique_genre("Testhouse")
        ids = [_make_track(f"House Hit {i}", f"House Artist {i}", genre) for i in range(6)]
        points = [FakePoint(ids[0], 0.9, "House Artist 0"), FakePoint(ids[1], 0.8, "House Artist 1")]

        with patch.object(prs, "get_or_compute_user_embedding_fresh", return_value=self.vec), \
             patch.object(prs.client, "query_points", return_value=FakeResults(points)):
            result = prs.generate_genre_playlist(self.user_id, genre, limit=5, base_url="http://x")

        result_ids = [t["id"] for t in result]
        self.assertEqual(len(result_ids), 5)
        self.assertEqual(result_ids[:2], ids[:2])
        self.assertEqual(result[0]["score"], 0.9)
        self.assertEqual(len(result_ids), len(set(result_ids)))

    def test_qdrant_failure_falls_back_to_sqlite(self):
        genre = _unique_genre("Testtrap")
        ids = [_make_track(f"Trap Hit {i}", f"Trap Artist {i}", genre) for i in range(5)]
        for tid in ids:
            db.add_favorite(self.user_id, tid)

        with patch.object(prs, "get_or_compute_user_embedding_fresh", return_value=self.vec), \
             patch.object(prs.client, "query_points", side_effect=RuntimeError("qdrant down")):
            result = prs.generate_genre_playlist(self.user_id, genre, limit=5, base_url="http://x")

        self.assertEqual([t["id"] for t in result], ids)

    def test_equal_scores_tiebreak_by_artist_album_title(self):
        genre = _unique_genre("Testtie")
        beta = _make_track("Tie Song", "Beta Artist", genre)
        alpha_tie = _make_track("Tie Song", "Alpha Artist", genre)
        alpha_first = _make_track("Aaa Song", "Alpha Artist", genre)
        # Qdrant вернул равные score в неудобном порядке.
        points = [
            FakePoint(beta, 0.5, "Beta Artist"),
            FakePoint(alpha_tie, 0.5, "Alpha Artist"),
            FakePoint(alpha_first, 0.5, "Alpha Artist"),
        ]
        with patch.object(prs, "get_or_compute_user_embedding_fresh", return_value=self.vec), \
             patch.object(prs.client, "query_points", return_value=FakeResults(points)):
            result = prs.generate_genre_playlist(self.user_id, genre, limit=5, base_url="http://x")
            again = prs.generate_genre_playlist(self.user_id, genre, limit=5, base_url="http://x")

        # При равном score — tie-break по (artist, album, title, id), без random.
        self.assertEqual([t["id"] for t in result], [alpha_first, alpha_tie, beta])
        self.assertEqual([t["id"] for t in again], [alpha_first, alpha_tie, beta])


class TestPersonalizedRecommendationsAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.client = TestClient(app)
        patcher = patch.object(prs, "get_or_compute_user_embedding_fresh", return_value=None)
        patcher.start()
        cls.addClassCleanup(patcher.stop)

        name = f"rec_api_{uuid.uuid4().hex[:8]}"
        existing = db.get_user_by_username(name)
        if existing:
            db.delete_user(existing["id"])
        cls.user_id = db.create_user(name, hash_password("pass123"), role="admin")

        resp = cls.client.post("/api/auth/login", json={"username": name, "password": "pass123"})
        cls.headers = {"Authorization": f"Bearer {resp.json()['access_token']}"}

    def test_01_unauthorized_401(self):
        # Мягкий fallback (REQUIRE_AUTH=false) отвечает admin; в строгом режиме — 401.
        with patch.object(auth, "REQUIRE_AUTH", True):
            resp = self.client.get("/api/recommendations/youll-like-this")
        self.assertEqual(resp.status_code, 401)

    def test_02_param_validation_422(self):
        resp = self.client.get(
            "/api/recommendations/youll-like-this?limit=25", headers=self.headers
        )
        self.assertEqual(resp.status_code, 422)
        resp = self.client.get(
            "/api/recommendations/youll-like-this?sections=5", headers=self.headers
        )
        self.assertEqual(resp.status_code, 422)

    def test_03_empty_profile_returns_no_sections(self):
        # Пользователь setUpClass пока без истории и лайков.
        resp = self.client.get(
            "/api/recommendations/youll-like-this", headers=self.headers
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"sections": []})

    def test_04_success_sections_format(self):
        rap_genre = "rap"  # алиас: секция должна назваться "Hip-Hop for you"
        indie_genre = "indie rock"
        for i in range(6):
            tid = _make_track(f"Rap Hit {i}", f"Rap Artist {i}", rap_genre)
            db.add_favorite(self.user_id, tid)
        for i in range(5):
            tid = _make_track(f"Indie Hit {i}", f"Indie Artist {i}", indie_genre)
            db.add_favorite(self.user_id, tid)

        resp = self.client.get(
            "/api/recommendations/youll-like-this?sections=2", headers=self.headers
        )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        # Строго {"sections": [...]} — поле настроений не переносится.
        self.assertEqual(list(body.keys()), ["sections"])
        self.assertEqual(len(body["sections"]), 2)

        for section in body["sections"]:
            self.assertEqual(
                list(section.keys()),
                ["id", "type", "title", "description", "genre", "tracks"],
            )
            self.assertEqual(section["type"], "genre")
            self.assertTrue(section["id"].startswith("genre-"))
            self.assertTrue(section["title"].endswith("for you"))
            self.assertLessEqual(len(section["tracks"]), 20)
            for track in section["tracks"]:
                self.assertIn("stream_url", track)
                self.assertIn("coverArt", track)
                self.assertIn("is_liked", track)
                self.assertIn("score", track)

        titles = {s["genre"] for s in body["sections"]}
        self.assertEqual(titles, {"Hip-Hop", "Indie Rock"})

    def test_05_limit_and_sections_params_applied(self):
        resp = self.client.get(
            "/api/recommendations/youll-like-this?limit=5&sections=1", headers=self.headers
        )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(len(body["sections"]), 1)
        self.assertEqual(len(body["sections"][0]["tracks"]), 5)
        self.assertEqual(body["sections"][0]["genre"], "Hip-Hop")


if __name__ == "__main__":
    unittest.main()
