import test_db_path  # noqa: F401
import logging
from types import SimpleNamespace
import pytest
from repositories import schema, tracks, wave, artist_credits as credits
from repositories.base import get_connection
from services import recommendation_service as reco
from services import personalized_recommendation_service as personal


def aid(name):
    return credits.artist_id_for_name(name)


@pytest.fixture
def library(tmp_path, monkeypatch):
    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'test.db'))
    schema.init_db()
    for tid, names in [('a',['A']), ('b',['B']), ('ab',['A','B']), ('ac',['A','C']), ('d',['D']), ('empty',[])]:
        tracks.add_or_update_track(tid, str(tmp_path / (tid + '.mp3')), tid, None, 'stale', genre='Rock')
        with get_connection() as conn:
            state = credits.get_credit_states('track', [tid], conn=conn)[tid]
            credits.replace_artist_credits(conn, 'track', tid, [{'name': n} for n in names], expected_revision=state['revision'])
    return tmp_path


def point(tid, score, **payload):
    return SimpleNamespace(id=tid, score=score, payload=payload)


def test_resolver_sqlite_first_missing_empty_and_invalid_payload(library, monkeypatch, caplog):
    r = reco._ArtistResolver()
    r.prefetch(['ab', 'empty', 'missing'])
    assert r.keys({'artist':'stale'}, 'ab') == frozenset([aid('A'), aid('B')])
    assert r.keys({'artist':'stale'}, 'empty') == frozenset()
    assert r.keys({'artists':[],'artist':'stale'}, 'missing') == frozenset()
    assert r.keys({'artists':[{'id':aid('A'),'name':'B'}]}, 'missing') == frozenset([aid('B')])
    assert r.keys({'artist':'Various Artists'}, 'missing') == frozenset()
    assert r.keys({'file_path':'A - track.mp3'}, 'missing') == frozenset([aid('A')])
    monkeypatch.setattr(reco, 'get_credit_states', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('failure')))
    failed = reco._ArtistResolver()
    with caplog.at_level(logging.WARNING):
        failed.prefetch(['x']); failed.prefetch(['y'])
    assert failed.keys({'artist':'A'}, 'x') == frozenset([aid('A')])
    assert len([r for r in caplog.records if 'lookup failed' in r.message]) == 1


def test_caps_penalty_and_unique_refill(library):
    points = [point(t, 1-i/100, artist='stale') for i,t in enumerate(['a','b','ab','ac','d'])]
    selected = reco.select_diverse_recommendations(points, 4)
    assert [p.id for p in selected] == ['a','b','ab','d']
    p = point('ab', 1.0, artist='stale')
    reco.apply_diversity_penalty([p], {aid('A'):2, aid('B'):3})
    assert p.score == pytest.approx(.85)
    only = [point('a', 1), point('a', .99), point('ac', .98), point('ab', .97)]
    assert [p.id for p in reco.select_diverse_recommendations(only, 4)] == ['a','ac','ab']


def test_recent_counts_event_window_and_tiebreak(library):
    with get_connection() as conn:
        for tid in ['a','b','ab','ac']:
            conn.execute("INSERT INTO user_history(user_id,track_id,played_at) VALUES (1,?, '2025-01-01')", (tid,))
        conn.execute("INSERT INTO user_wave_feedback(user_id,track_id,event_type,created_at) VALUES (1,'ab','skip','2025-01-01')")
        conn.execute("INSERT INTO user_history(user_id,track_id,played_at) VALUES (1,'d','2024-01-01')")
    assert wave.get_recent_artist_counts(1) == {aid('A'):4, aid('B'):3, aid('C'):1}


def test_prefetch_is_chunked_and_keys_do_not_query(library, monkeypatch):
    sql = []
    original = credits.get_connection
    def traced():
        conn = original(); conn.set_trace_callback(sql.append); return conn
    monkeypatch.setattr(credits, 'get_connection', traced)
    r = reco._ArtistResolver()
    ids = ['a'] + [f'missing{i}' for i in range(1000)]
    r.prefetch(ids)
    count = len(sql)
    for tid in ids: r.keys({'artist':'A'}, tid)
    assert len(sql) == count
    assert len([q for q in sql if q.lstrip().upper().startswith('SELECT')]) == 6


def test_personalized_breadth_caps_and_qdrant_outage(library, monkeypatch):
    catalog = list(tracks.get_tracks_by_ids(['a','b','ab','ac','d']).values())
    for track in catalog: track['auto_genres'] = [{'name':'Rock','confidence':1}]
    assert personal.get_catalog_genre_affinity(catalog)[0]['artist_count'] == 4
    selected = personal._apply_diversity([next(t for t in catalog if t['id']==x) for x in ['a','b','ab','ac','d']], 4)
    assert [t['id'] for t in selected] == ['a','b','ab','d']
    monkeypatch.setattr(personal.db, 'get_user_dislike_ids', lambda u:set())
    monkeypatch.setattr(personal.db, 'get_favorite_track_ids', lambda u:set())
    monkeypatch.setattr(personal.db, 'get_user_listening_history', lambda u:[])
    monkeypatch.setattr(personal, 'get_or_compute_user_embedding_fresh', lambda *args: (_ for _ in ()).throw(RuntimeError('Qdrant unavailable')))
    result = personal.generate_genre_playlist(1, 'Rock', limit=5, catalog=catalog)
    assert len(result) == len({p['id'] for p in result}) == 5


def test_credit_edits_continue_during_qdrant_outage(library, monkeypatch):
    from services.artist_credit_service import set_track_artists
    from services.artist_credit_bulk_service import preview_artist_replacement, apply_artist_replacement
    class Offline:
        def __getattr__(self, name):
            raise AssertionError('credit edits must not access Qdrant')
    monkeypatch.setattr(reco, 'client', Offline())
    state = credits.get_credit_states('track', ['a'])['a']
    admin = {'id': 1, 'role': 'admin'}
    result = set_track_artists('a', [{'name':'A'}, {'name':'C'}], state['revision'], admin, '')
    assert [artist['name'] for artist in result['artists']] == ['A','C']
    preview = preview_artist_replacement(aid('B'), 'tracks', [{'name':'D'}], admin)
    result = apply_artist_replacement(aid('B'), preview['operation_id'], admin)
    assert result['changed_count'] == 2
