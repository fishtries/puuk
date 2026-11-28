"""Тесты исключений и диверсификации «Моей Волны» (Этап 2)."""
import os
import sys
import unittest
import uuid

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД, должен идти до db/config

import db
from security import hash_password
from services.recommendation_service import (
    MAX_TRACKS_PER_ARTIST,
    apply_diversity_penalty,
    select_diverse_recommendations,
)
from fastapi.testclient import TestClient
from api import app


class MockPoint:
    def __init__(self, pid, score, artist):
        self.id = pid
        self.score = score
        self.payload = {"artist": artist}


class TestWaveExclusionsAndDiversity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.client = TestClient(app)

        name = f"wave_stage2_{uuid.uuid4().hex[:6]}"
        existing = db.get_user_by_username(name)
        if existing:
            db.delete_user(existing["id"])
        cls.user_id = db.create_user(name, hash_password("pass123"), role="admin")

        resp = cls.client.post("/api/auth/login", json={"username": name, "password": "pass123"})
        cls.headers = {"Authorization": f"Bearer {resp.json()['access_token']}"}

    def test_restart_uses_playing_track_as_contrast(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from routers import wave_recommendations as route

        tid = str(uuid.uuid4())
        point = SimpleNamespace(id=tid)
        with patch.object(route, 'retrieve_track_point', return_value=[point]), \
             patch.object(route.wave_mix, 'mixed_queue', return_value=[]) as mix:
            response = self.client.get('/api/wave/queue', params={'mode': 'start', 'previous_track_id': tid},
                                       headers=self.headers)
        self.assertEqual(response.status_code, 200)
        user, previous, restart, _, hard, _, _ = mix.call_args.args
        self.assertEqual(user, self.user_id)
        self.assertIs(previous, point)
        self.assertTrue(restart)
        self.assertIn(tid, hard)

    def test_00_artist_key_falls_back_to_file_path(self):
        """Если artist нет ни в payload, ни в SQLite — извлекаем его из имени файла."""
        from services.recommendation_service import (
            _ArtistResolver,
            _artist_from_file_path,
        )

        self.assertEqual(_artist_from_file_path("Daft Punk - Around the World.mp3"), "Daft Punk")
        self.assertIsNone(
            _artist_from_file_path("plain_track.mp3"),
            "Имя без разделителя не должно выдаваться за исполнителя",
        )
        self.assertIsNone(_artist_from_file_path(None))

        resolver = _ArtistResolver()
        from repositories.artist_credits import artist_id_for_name
        resolver.prefetch(["unknown-id", "unknown-id-2"])
        key = resolver.keys({"file_path": "Daft Punk - Around the World.mp3"}, "unknown-id")
        self.assertEqual(key, frozenset([artist_id_for_name("Daft Punk")]))
        self.assertEqual(resolver.keys({"file_path": "plain_track.mp3"}, "unknown-id-2"), frozenset())

    def test_01_normalize_exclude_ids_dedup_and_cap(self):
        """_normalize_exclude_ids дедуплицирует и ограничивает список 100 ID."""
        from routers.wave_recommendations import MAX_EXCLUDE_IDS, _normalize_exclude_ids

        self.assertEqual(_normalize_exclude_ids(None), set())
        self.assertEqual(_normalize_exclude_ids(["", "  ", "a"]), {"a"})
        self.assertEqual(_normalize_exclude_ids(["a", "a", "b"]), {"a", "b"})

        many = [f"id-{i}" for i in range(150)]
        capped = _normalize_exclude_ids(many)
        self.assertEqual(len(capped), MAX_EXCLUDE_IDS)
        self.assertIn("id-149", capped)
        self.assertNotIn("id-0", capped)

    def test_02_select_diverse_limits_one_artist(self):
        """При достаточном числе альтернатив один артист не превышает лимит."""
        points = [
            MockPoint("a1", 0.95, "Artist A"),
            MockPoint("a2", 0.94, "Artist A"),
            MockPoint("a3", 0.93, "Artist A"),
            MockPoint("b1", 0.92, "Artist B"),
            MockPoint("c1", 0.91, "Artist C"),
            MockPoint("d1", 0.90, "Artist D"),
        ]

        selected = select_diverse_recommendations(points, limit=5)
        ids = [p.id for p in selected]

        self.assertEqual(len(ids), 5)
        self.assertEqual(ids.count("a1") + ids.count("a2") + ids.count("a3"), MAX_TRACKS_PER_ARTIST)
        self.assertIn("b1", ids)
        self.assertIn("c1", ids)
        self.assertIn("d1", ids)

    def test_03_select_diverse_fallback_when_catalog_is_narrow(self):
        """Если кандидатов мало, лимит исполнителя ослабляется — пачка не пустая."""
        points = [MockPoint("a1", 0.9, "Artist A"), MockPoint("a2", 0.8, "Artist A"), MockPoint("a3", 0.7, "Artist A")]

        selected = select_diverse_recommendations(points, limit=3)
        self.assertEqual([p.id for p in selected], ["a1", "a2", "a3"])

    def test_04_select_diverse_normalizes_artist_case(self):
        """Artist identity preserves case; whitespace is normalized."""
        points = [
            MockPoint("a1", 0.9, "Artist A"),
            MockPoint("a2", 0.8, " artist a "),
            MockPoint("a3", 0.7, "ARTIST A"),
            MockPoint("b1", 0.6, "Artist B"),
        ]

        selected = select_diverse_recommendations(points, limit=3)
        ids = [p.id for p in selected]
        same_artist = sum(1 for i in ids if i.startswith("a"))
        self.assertEqual(same_artist, 3)

    def test_05_diversity_penalty_is_case_insensitive(self):
        """Recent counts apply to the matching case-sensitive artist ID."""
        points = [MockPoint("t1", 0.90, "Queen"), MockPoint("t2", 0.85, "Daft Punk")]

        from repositories.artist_credits import artist_id_for_name
        adjusted = apply_diversity_penalty(points, {artist_id_for_name("Queen"): 2}, penalty=0.05)
        self.assertEqual(adjusted[0].id, "t2")

    def test_06_queue_endpoint_accepts_exclude_ids(self):
        """GET /api/wave/queue принимает exclude_track_ids и не падает при малом каталоге."""
        response = self.client.get(
            "/api/wave/queue?limit=5&exclude_track_ids=00000000-0000-0000-0000-000000000001"
            "&exclude_track_ids=00000000-0000-0000-0000-000000000002",
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(response.json(), list)

    def test_07_queue_endpoint_excludes_current_track(self):
        """Реальный трек из истории: он не должен вернуться в своей же выдаче."""
        from services.recommendation_service import client as qdrant

        records, _ = qdrant.scroll(collection_name="tracks", limit=2, with_payload=True, with_vectors=False)
        if len(records) < 2:
            self.skipTest("Qdrant недоступен или коллекция пуста")

        current_id = str(records[0].id)
        response = self.client.get(
            f"/api/wave/queue?current_track_id={current_id}&limit=8",
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 200)
        returned_ids = [track["id"] for track in response.json()]
        self.assertNotIn(current_id, returned_ids)

    def test_08_service_excludes_passed_ids_and_dislikes(self):
        """Сервис не возвращает exclude_ids, пока хватает уникальных кандидатов, и никогда — дизлайки."""
        from unittest.mock import patch
        from services import recommendation_service

        current = MockPoint("current", 1.0, "Seed Artist")
        candidates = [MockPoint("current", 0.99, "Seed Artist")] + [
            MockPoint(f"cand-{i}", 0.95 - i * 0.01, f"Artist {i}") for i in range(10)
        ]

        class FakeResults:
            points = candidates

        with patch.object(recommendation_service.client, "retrieve", return_value=[current]), \
             patch.object(recommendation_service.client, "query_points", return_value=FakeResults()):
            recommendations = recommendation_service.get_smart_recommendations(
                current_track_id="current",
                limit=5,
                existing_track=current,
                dislike_ids={"cand-1"},
                exclude_ids={"cand-2", "cand-3"},
                user_id=None,
                personalization_weight=0.0,
            )

        ids = [p.id for p in recommendations]
        self.assertNotIn("current", ids)
        self.assertNotIn("cand-1", ids)
        self.assertNotIn("cand-2", ids)
        self.assertNotIn("cand-3", ids)
        self.assertEqual(len(ids), 5)

    def test_09_service_relaxes_exclude_when_unique_pool_is_small(self):
        """Если уникальных кандидатов не хватает, сервис мягко добирает из exclude_ids."""
        from unittest.mock import patch
        from services import recommendation_service

        current = MockPoint("current", 1.0, "Seed Artist")
        candidates = [
            MockPoint("current", 0.99, "Seed Artist"),
            MockPoint("cand-1", 0.90, "Artist 1"),
            MockPoint("cand-2", 0.80, "Artist 2"),
        ]

        class FakeResults:
            points = candidates

        with patch.object(recommendation_service.client, "retrieve", return_value=[current]), \
             patch.object(recommendation_service.client, "query_points", return_value=FakeResults()):
            recommendations = recommendation_service.get_smart_recommendations(
                current_track_id="current",
                limit=5,
                existing_track=current,
                dislike_ids=set(),
                exclude_ids={"cand-2"},
                user_id=None,
                personalization_weight=0.0,
            )

        ids = [p.id for p in recommendations]
        self.assertNotIn("current", ids)
        self.assertIn("cand-2", ids)

    def test_12_profile_can_only_rerank_seed_neighbours(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        import numpy as np
        from services import recommendation_service as service

        seed = SimpleNamespace(vector=[1., 0.], payload={})
        with patch.object(service.client, "query_points", return_value=SimpleNamespace(points=[])) as query, \
             patch.object(service, "get_or_compute_user_embedding", return_value=np.array([0., 1.])):
            service.get_smart_recommendations("seed", 8, seed, user_id=self.user_id)
        query.assert_called_once()
        args = query.call_args.kwargs
        self.assertEqual(args["prefetch"].query, seed.vector)
        self.assertEqual(args["prefetch"].filter, args["query_filter"])
        self.assertGreater(args["query"][1], 0)
        self.assertGreater(args["query"][0], args["query"][1])

    def test_13_no_second_query_when_user_vector_is_absent(self):
        """Без вектора пользователя exploration-запрос не выполняется (один вызов Qdrant)."""
        from unittest.mock import patch
        from services import recommendation_service

        current = MockPoint("current", 1.0, "Seed Artist")
        main_pool = [MockPoint("current", 0.99, "Seed Artist"), MockPoint("near-1", 0.9, "Near Artist 1")]

        class FakeResults:
            points = main_pool

        with patch.object(recommendation_service.client, "retrieve", return_value=[current]), \
             patch.object(recommendation_service.client, "query_points", return_value=FakeResults()) as qp_mock, \
             patch.object(recommendation_service, "get_or_compute_user_embedding", return_value=None):
            recommendation_service.get_smart_recommendations(
                current_track_id="current",
                limit=2,
                existing_track=current,
                user_id=1,
                personalization_weight=0.3,
            )

        self.assertEqual(qp_mock.call_count, 1)

    def test_14_band_shuffle_disabled_with_zero_eps(self):
        """eps=0 отключает перемешивание — порядок строго по score (детерминизм тестов)."""
        points = [
            MockPoint("p1", 0.9, "A"),
            MockPoint("p2", 0.5, "B"),
            MockPoint("p3", 0.3, "C"),
        ]
        selected = select_diverse_recommendations(points, limit=3, band_score_eps=0.0)
        self.assertEqual([p.id for p in selected], ["p1", "p2", "p3"])

    def test_15_cold_start_picks_from_pool_not_first_point(self):
        """scroll_random_ready_track выбирает случайный трек из пула, а не всегда первую точку."""
        from unittest.mock import patch
        from services import recommendation_service

        pool = [MockPoint(f"pt-{i}", 0.9, f"A{i}") for i in range(5)]

        class Captured:
            calls = []

        def fake_scroll(**kwargs):
            Captured.calls.append(kwargs)
            return pool, None

        def fake_choice(seq):
            Captured.chosen = seq
            return seq[2]

        with patch.object(recommendation_service.client, "scroll", side_effect=fake_scroll), \
             patch.object(recommendation_service.random, "choice", side_effect=fake_choice):
            picked = recommendation_service.scroll_random_ready_track()

        self.assertEqual(len(picked), 1)
        self.assertEqual(picked[0].id, "pt-2")
        # Пул должен быть больше 1 (random meaningful) и отфильтрован по needs_embedding.
        self.assertGreater(Captured.calls[0]["limit"], 1)
        self.assertIn("scroll_filter", Captured.calls[0])

    def test_16_scan_payload_contains_artist(self):
        """process_audio_file-путь в scan.py обогащает payload artist/title из имени файла."""
        scan_path = os.path.join(os.path.dirname(__file__), "scan.py")
        with open(scan_path, encoding="utf-8") as fh:
            source = fh.read()
        self.assertIn('metadata["artist"]', source, "scan.py пишет artist в payload перед upsert")
        self.assertIn('metadata["title"]', source)

    def test_10_queued_ids_beat_recent_ids_in_relax_order(self):
        """queued_ids возвращаются только после exclude_ids: порядок ослабления строгий."""
        from unittest.mock import patch
        from services import recommendation_service

        current = MockPoint("current", 1.0, "Seed Artist")
        candidates = [
            MockPoint("current", 0.99, "Seed Artist"),
            MockPoint("queued-1", 0.90, "Artist Q"),
            MockPoint("recent-1", 0.80, "Artist R"),
        ]

        class FakeResults:
            points = candidates

        def run(limit):
            with patch.object(recommendation_service.client, "retrieve", return_value=[current]), \
                 patch.object(recommendation_service.client, "query_points", return_value=FakeResults()):
                return recommendation_service.get_smart_recommendations(
                    current_track_id="current",
                    limit=limit,
                    existing_track=current,
                    dislike_ids=set(),
                    exclude_ids={"recent-1"},
                    queued_ids={"queued-1"},
                    user_id=None,
                    personalization_weight=0.0,
                )

        # 1 свободное место: первым возвращается недавно проигранный, не трек из очереди.
        ids_one = [p.id for p in run(1)]
        self.assertEqual(ids_one, ["recent-1"])

        # 2 свободных места: сначала recent, затем queued — порядок ослабления строгий.
        ids_two = [p.id for p in run(2)]
        self.assertEqual(ids_two, ["recent-1", "queued-1"])

    def test_11_diversity_prefers_known_artists_over_unknown(self):
        """Кандидаты без исполнителя не занимают места раньше известных артистов."""
        points = [
            MockPoint("u1", 0.96, None),
            MockPoint("u2", 0.95, None),
            MockPoint("b1", 0.90, "Artist B"),
            MockPoint("c1", 0.85, "Artist C"),
        ]

        selected = select_diverse_recommendations(points, limit=3)
        ids = [p.id for p in selected]

        self.assertIn("b1", ids)
        self.assertIn("c1", ids)
        self.assertEqual(len([i for i in ids if i.startswith("u")]), 1)


def test_repeated_skips_cool_down_other_tracks_by_the_artist(monkeypatch):
    from types import SimpleNamespace
    from services import recommendation_service as service
    from repositories.artist_credits import artist_id_for_name

    seed = SimpleNamespace(vector=[1., 0.], payload={})
    def candidates(**kwargs):
        return SimpleNamespace(points=[MockPoint('new-a', .94, 'A'), MockPoint('new-b', .90, 'B')])
    monkeypatch.setattr(service.client, 'query_points', candidates)
    monkeypatch.setattr(service, 'get_recent_artist_counts', lambda *a, **kw: {})
    monkeypatch.setattr(service, 'get_credit_states', lambda kind, ids: {
        key: {'artists': [{'id': artist_id_for_name('A')}]} for key in ids if key.startswith('skip')
    })
    history = {'skip1': (1., True)}
    monkeypatch.setattr(service, 'recent_wave_exposure', lambda user: history)
    def first():
        return service.get_smart_recommendations('seed', 1, seed, user_id=1, personalization_weight=0)[0].id
    assert first() == 'new-a'
    history['skip2'] = (1., True)
    assert first() == 'new-b'
    history.clear()
    history['new-a'] = (2., False)
    assert first() == 'new-b'


def test_sparkle_neighbourhood_widens_before_repeating_artist(monkeypatch):
    from types import SimpleNamespace
    from services import recommendation_service as service

    artist = '山下達郎'
    seed = SimpleNamespace(vector=[1., 0.], payload={'artist': artist})
    pool = [MockPoint(f'album-{i}', .99, artist) for i in range(service.CANDIDATE_POOL_FLOOR)]
    pool.extend(MockPoint(f'other-{i}', .85, f'Artist {i}') for i in range(12))
    limits = []

    def query(**kwargs):
        limits.append(kwargs['limit'])
        return SimpleNamespace(points=pool[:kwargs['limit']])

    monkeypatch.setattr(service.client, 'query_points', query)
    result = service.get_smart_recommendations('sparkle', 8, seed, dislike_ids={'other-0'})
    artists = [p.payload['artist'] for p in result]
    assert len(limits) == 2
    assert len(result) == 8
    assert artists[0] != artist
    assert artists.count(artist) <= 1
    assert 'other-0' not in {p.id for p in result}


def test_mix_gives_a_transition_four_tracks_to_develop(monkeypatch):
    from types import SimpleNamespace
    from services import wave_mix as mix

    a, b, weak = [str(uuid.uuid4()) for _ in range(3)]
    seed = SimpleNamespace(id=a, vector=[1., 0.], payload={})
    contrast = SimpleNamespace(id=b, vector=[0., 1.], payload={})
    snapshot = dict(likes={a, b}, dislikes=set(), events=[])
    monkeypatch.setattr(mix, 'taste_snapshot', lambda _: snapshot)
    monkeypatch.setattr(mix, 'track_weights', lambda s: {a: 2., b: 2., weak: .81})

    def anchors(**kw):
        assert set(kw['ids']) == {a, b}
        return [seed, contrast]
    monkeypatch.setattr(mix.reco.client, 'retrieve', anchors)
    def neighbours(tid, limit, point, **kw):
        assert a in kw['dislike_ids']
        return [SimpleNamespace(id=f'{tid}/{n}') for n in range(limit)]
    monkeypatch.setattr(mix.reco, 'get_smart_recommendations', neighbours)
    trace = {}
    result = mix.mixed_queue(1, seed, True, 8, set(), set(), set(), trace=trace)
    assert [p.id.split('/')[0] for p in result] == [b]*4 + [a]*4
    for position, point in enumerate(result, 1):
        assert trace[point.id] == {
            'anchor_id': b if position <= 4 else a,
            'source': 'taste' if position <= 4 else 'alternate',
            'mix_position': position,
        }


def test_mix_extends_a_good_run_and_shortens_it_after_early_skips():
    from datetime import datetime, timezone
    from services.wave_mix import _run_length

    event = dict(ts=datetime.now(timezone.utc).isoformat(), context='wave',
                 event_type='finish', listen_duration_ms=240000, track_duration_ms=240000)
    assert _run_length([event]) == 4
    assert _run_length([event, event]) == 6
    skipped = dict(event, event_type='skip', listen_duration_ms=4000)
    assert _run_length([skipped, skipped]) == 2
    old = dict(skipped, ts='2020-01-01')
    assert _run_length([old, old]) == 4


def test_uncredited_slowed_edits_can_lead_a_matching_run(monkeypatch):
    from types import SimpleNamespace
    from services import recommendation_service as service

    seed = SimpleNamespace(vector=[1., 0.], payload={'title': '9 AM (slowed and reverb)'})
    edit = MockPoint('edit', .90, None)
    edit.payload['title'] = 'ILoveUIHateU (Slowed + Reverb)'
    named = MockPoint('named', .92, 'Known Artist')
    monkeypatch.setattr(service.client, 'query_points', lambda **kw: SimpleNamespace(points=[named, edit]))
    result = service.get_smart_recommendations('seed', 2, seed, personal_mix=True)
    assert result[0].id == 'edit'


def test_legacy_and_new_wave_launchers_share_a_rotation_without_feedback(tmp_path, monkeypatch):
    import test_db_path
    from concurrent.futures import ThreadPoolExecutor
    from types import SimpleNamespace
    from routers import wave_recommendations as route
    from repositories.wave_openings import recent_openings, reserve_opening

    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'rotate.db'))
    db.init_db()
    uid = db.create_user('rotate', hash_password('pass123'), role='admin')
    ids = [str(uuid.uuid4()) for _ in range(4)]
    points = [SimpleNamespace(id=tid) for tid in ids]
    def mixed_queue(*args, trace=None):
        if trace is not None:
            for i, point in enumerate(points, 1):
                trace[point.id] = dict(anchor_id='anchor', source='taste', mix_position=i)
        return list(points)

    monkeypatch.setattr(route.wave_mix, 'mixed_queue', mixed_queue)
    monkeypatch.setattr(route, 'recent_wave_exposure', lambda user: {ids[0]: (6., False)})
    monkeypatch.setattr(route, 'build_wave_track_payload', lambda p, *a, **kw: {'id': str(p.id)})
    client = TestClient(app)
    token = client.post('/api/auth/login', json={'username': 'rotate', 'password': 'pass123'}).json()['access_token']
    headers = {'Authorization': f'Bearer {token}'}
    heads = []
    for path in ['/api/wave/next?current_track_id=random', '/api/wave/queue?limit=1'] * 2:
        response = client.get(path, headers=headers)
        assert response.status_code == 200, response.text
        data = response.json()
        first = data[0] if isinstance(data, list) else data
        assert 'wave_trace' not in first
        heads.append(first['id'])
    assert heads[0] != ids[0]
    assert len(set(heads)) == 4
    assert recent_openings(uid) == heads
    with ThreadPoolExecutor(max_workers=2) as pool:
        picks = list(pool.map(lambda _: reserve_opening(uid, ids, set(), set()), range(2)))
    assert set(picks) == set(heads[:2])
    assert db.get_user_listening_history(uid) == []
    monkeypatch.setattr(route, 'reserve_opening', lambda *args: ids[2])
    monkeypatch.setattr(db, 'get_tracks_by_ids', lambda keys: {'anchor': {'title': 'Anchor'}} if 'anchor' in keys else {})
    explained = client.get('/api/wave/queue?mode=start&limit=2&explain=true', headers=headers)
    assert explained.status_code == 200, explained.text
    assert [p['id'] for p in explained.json()] == [ids[2], ids[0]]
    assert [p['wave_trace'] for p in explained.json()] == [
        dict(source='taste', anchor_id='anchor', anchor_title='Anchor', mix_position=3, server_position=1),
        dict(source='taste', anchor_id='anchor', anchor_title='Anchor', mix_position=1, server_position=2),
    ]
