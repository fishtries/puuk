"""Регрессии кредов в жанровых подборках «Мне понравится» (F1).

Закрывают дефект: SQLite-fallback DTO теряли artist_id/artists/
artists_revision/album_artists/album_artists_revision, а смешанный
Qdrant+SQLite refill отдавал незагидратированные строки.
"""
import test_db_path  # noqa: F401
from types import SimpleNamespace

import pytest

from repositories import schema, tracks, artist_credits as credits
from repositories.base import get_connection
from services import personalized_recommendation_service as personal


CREDIT_FIELDS = (
    'artist_id',
    'artists',
    'artists_revision',
    'album_artists',
    'album_artists_revision',
)


@pytest.fixture
def library(tmp_path):
    schema.init_db()
    with get_connection() as conn:
        for table in ('tracks', 'albums', 'artist_credit_state', 'track_artists',
                      'album_artists', 'artists', 'user_history', 'user_favorites',
                      'user_dislikes'):
            try:
                conn.execute(f'DELETE FROM {table}')
            except Exception:
                pass
    with get_connection() as conn:
        conn.execute("INSERT INTO albums(id,title,album_artist) VALUES (1,'Shared','Album Owner')")
        conn.execute("INSERT INTO albums(id,title,album_artist) VALUES (2,'Other','Other Owner')")
        conn.execute("INSERT INTO albums(id,title,album_artist) VALUES (3,'Empty','Empty Owner')")
    # (track_id, album_id, order_names) — порядок задаёт ожидаемый artists.
    spec = [
        ('solo', 1, ['Solo']),
        ('duo', 1, ['First', 'Second']),
        ('empty', 2, []),
        ('manual', 3, ['Manual']),
        ('alb', 3, ['Alb']),
    ]
    for tid, album_id, names in spec:
        tracks.add_or_update_track(
            tid, str(tmp_path / (tid + '.mp3')), tid, album_id, 'stale', genre='Rock')
        with get_connection() as conn:
            if names:
                state = credits.get_credit_states('track', [tid], conn=conn)[tid]
                credits.replace_artist_credits(
                    conn, 'track', tid, [{'name': n} for n in names],
                    expected_revision=state['revision'])
    # Ручное обнуление трековых кредов, в т.ч. пустой список [].
    with get_connection() as conn:
        state = credits.get_credit_states('track', ['empty'], conn=conn)['empty']
        credits.replace_artist_credits(conn, 'track', 'empty', [], expected_revision=state['revision'])
        # Независимые альбомные креды (не совпадают с именем исполнителя).
        credits.ingest_artist_credits(
            conn, 'album', 1, credits.CreditSource('tags', ['Album One', 'Album Two']))
        credits.ingest_artist_credits(
            conn, 'album', 3, credits.CreditSource('tags', []))
    return tmp_path


def _offline_qdrant(monkeypatch):
    monkeypatch.setattr(personal, 'get_or_compute_user_embedding_fresh', lambda *a, **k: None)


def _no_user_signal(monkeypatch):
    monkeypatch.setattr(personal.db, 'get_user_dislike_ids', lambda u: set())
    monkeypatch.setattr(personal.db, 'get_favorite_track_ids', lambda u: set())
    monkeypatch.setattr(personal.db, 'get_user_listening_history', lambda u: [])


def _by_id(payloads):
    return {p['id']: p for p in payloads}


def _assert_credit_fields(payload, row):
    for field in CREDIT_FIELDS:
        assert field in payload, f'{payload["id"]}: missing {field}'
    assert payload['artists'] == row['artists']
    assert payload['artists_revision'] == row['artists_revision']
    assert payload['artist_id'] == row['artist_id']
    assert payload['album_artists'] == row['album_artists']
    assert payload['album_artists_revision'] == row['album_artists_revision']


def test_sqlite_fallback_preserves_all_credit_fields(library, monkeypatch):
    _no_user_signal(monkeypatch)
    _offline_qdrant(monkeypatch)
    result = personal.generate_genre_playlist(1, 'Rock', limit=10)
    payloads = _by_id(result)
    assert set(payloads) == {'solo', 'duo', 'empty', 'manual', 'alb'}
    expected = tracks.get_tracks_by_ids(list(payloads))
    for tid, payload in payloads.items():
        _assert_credit_fields(payload, expected[tid])

    # Порядок и ревизии, ручные оверрайды и пустой список.
    assert [a['name'] for a in payloads['duo']['artists']] == ['First', 'Second']
    assert payloads['solo']['artist_id'] == credits.artist_id_for_name('Solo')
    assert payloads['duo']['artist_id'] is None
    assert payloads['empty']['artists'] == []
    assert payloads['empty']['artists_revision'] == expected['empty']['artists_revision']
    assert [a['name'] for a in payloads['manual']['artists']] == ['Manual']

    # Альбомные креды независимы от трековых.
    assert [a['name'] for a in payloads['solo']['album_artists']] == ['Album One', 'Album Two']
    assert payloads['alb']['album_artists'] == []


def test_mixed_qdrant_ranked_and_unhydrated_refill(library, monkeypatch):
    _no_user_signal(monkeypatch)
    monkeypatch.setattr(
        personal, 'get_or_compute_user_embedding_fresh', lambda *a, **k: object())

    ranked_row = tracks.get_tracks_by_ids(['solo'])['solo']
    assert 'artists' in ranked_row

    def fake_points(user_vec):
        return [SimpleNamespace(id='solo', score=1.0, payload={})]

    monkeypatch.setattr(personal, '_query_genre_points', fake_points)

    result = personal.generate_genre_playlist(1, 'Rock', limit=10)
    payloads = _by_id(result)
    assert set(payloads) == {'solo', 'duo', 'empty', 'manual', 'alb'}
    assert payloads['solo']['score'] == pytest.approx(personal.FAVORITE_BONUS + 1.0) or \
        payloads['solo']['score'] == pytest.approx(1.0)

    expected = tracks.get_tracks_by_ids(list(payloads))
    for tid, payload in payloads.items():
        _assert_credit_fields(payload, expected[tid])
    assert [a['name'] for a in payloads['duo']['artists']] == ['First', 'Second']
    assert payloads['empty']['artists'] == []


def test_unhydrated_rows_are_hydrated_in_single_batch(library, monkeypatch):
    _no_user_signal(monkeypatch)
    _offline_qdrant(monkeypatch)
    # Эмулируем незагидратированные строки (как refill смешанного пути).
    catalog = [
        {k: v for k, v in row.items() if k not in CREDIT_FIELDS}
        for row in tracks.get_catalog_tracks()
    ]
    assert all('artists' not in row for row in catalog)

    calls = []
    original = personal.db.get_tracks_by_ids

    def traced(ids):
        calls.append(list(ids))
        return original(ids)

    monkeypatch.setattr(personal.db, 'get_tracks_by_ids', traced)
    result = personal.generate_genre_playlist(1, 'Rock', limit=10, catalog=catalog)
    assert len(result) == 5
    assert len(calls) == 1
    assert sorted(calls[0]) == ['alb', 'duo', 'empty', 'manual', 'solo']
    expected = tracks.get_tracks_by_ids(list(calls[0]))
    for payload in result:
        _assert_credit_fields(payload, expected[payload['id']])
