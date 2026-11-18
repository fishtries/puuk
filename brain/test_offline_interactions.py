import test_db_path  # noqa: F401
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from unittest.mock import Mock

import numpy as np
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import db
from repositories.wave import get_taste_revision, taste_snapshot
from routers import user_content, wave
from services.taste_profile import track_weights
from user_profile import should_recompute_embedding


@pytest.fixture
def subject(monkeypatch):
    user = db.create_user('offline_' + uuid4().hex)
    other_user = db.create_user('offline_' + uuid4().hex)
    track, other_track = str(uuid4()), str(uuid4())
    for track_id in (track, other_track):
        db.add_or_update_track(track_id, track_id + '.mp3', 'Track', None, 'Artist')
    app = FastAPI()
    app.include_router(user_content.router, prefix='/api')
    app.include_router(wave.router)
    app.dependency_overrides[user_content.get_current_user] = lambda: {'id': user}
    monkeypatch.setattr(wave, 'should_recompute_embedding', lambda *args, **kwargs: False)
    monkeypatch.setattr(wave, 'feedback_rate_limiter', wave.InMemoryRateLimiter())
    try:
        with TestClient(app) as client:
            yield app, client, user, other_user, track, other_track
    finally:
        db.delete_user(user)
        db.delete_user(other_user)
        db.delete_track(track)
        db.delete_track(other_track)


def test_rating_late_exact_retry_keeps_later_server_change(subject):
    _, client, user, _, track, _ = subject
    url = f'/api/tracks/{track}/rating'
    like = {'operation_id': 'first', 'rating': 'like'}
    dislike = {'operation_id': 'other-device', 'rating': 'dislike'}
    db.set_user_embedding(user, np.ones(400, dtype=np.float32), 1)
    before = get_taste_revision(user)
    assert client.put(url, json=like).json() == {
        'status': 'ok', 'track_id': track, **like, 'applied': True,
    }
    assert track in track_weights(taste_snapshot(user))
    assert should_recompute_embedding(user)
    assert client.put(url, json=dislike).json()['applied']
    after_dislike = get_taste_revision(user)
    assert after_dislike > before
    assert not client.put(url, json=like).json()['applied']
    assert get_taste_revision(user) == after_dislike
    snap = taste_snapshot(user)
    assert snap['likes'] == set() and snap['dislikes'] == {track}
    assert not track_weights(snap)
    assert client.put(url, json={**like, 'rating': 'neutral'}).status_code == 409
    assert client.put(url, json={'operation_id': 'last', 'rating': 'neutral'}).json()['applied']
    assert taste_snapshot(user)['dislikes'] == set()
    assert client.post(f'/api/tracks/{track}/like').json()['is_liked']
    assert client.post(f'/api/tracks/{track}/dislike').json()['status'] == 'disliked'
    assert not db.is_favorite(user, track)
    assert client.delete(f'/api/tracks/{track}/dislike').status_code == 200


@pytest.mark.parametrize('history_first', [True, False])
@pytest.mark.parametrize('outcome', ['finish', 'skip'])
def test_playback_identity_pairs_exactly_and_keeps_distinct_play(subject, history_first, outcome):
    _, client, user, _, track, other_track = subject
    occurred = datetime.now(timezone.utc) - timedelta(days=45)
    history = {'playback_id': 'play-1', 'occurred_at': occurred.isoformat(), 'context': 'wave'}
    feedback = {**history, 'event_id': 'play-1', 'track_id': track, 'event_type': outcome,
                'listen_duration_ms': 99500 if outcome == 'finish' else 500, 'track_duration_ms': 100000}
    history_url = f'/api/tracks/{track}/history'
    calls = [(history_url, history), ('/api/wave/feedback', feedback)]
    if not history_first:
        calls.reverse()
    for url, payload in calls:
        first = client.put(url, json=payload)
        assert first.status_code == 200
        after_first = get_taste_revision(user)
        assert client.put(url, json=payload).json() == first.json()
        assert get_taste_revision(user) == after_first
    events = taste_snapshot(user)['events']
    assert [e['event_type'] for e in events] == [outcome]
    assert events[0]['ts'] == occurred.isoformat()
    assert list(track_weights(taste_snapshot(user))) == ([track] if outcome == 'finish' else [])
    assert db.get_user_listening_history(user) == ([track] if outcome == 'finish' else [])
    assert client.put(history_url, json={**history, 'playback_id': 'play-2'}).status_code == 200
    assert {e['event_type'] for e in taste_snapshot(user)['events']} == {outcome, 'start'}
    assert client.put(f'/api/tracks/{other_track}/history', json=history).status_code == 409
    assert client.put('/api/wave/feedback', json={**feedback, 'listen_duration_ms': 250}).status_code == 409


def test_history_order_and_legacy_clients(subject):
    _, client, user, _, track, other_track = subject
    url = f'/api/tracks/{track}/history'
    assert client.post(url).json() == {'status': 'logged', 'track_id': track}
    assert client.put(url).status_code == 422
    assert client.put('/api/wave/feedback', json={'track_id': track, 'event_type': 'finish'}).status_code == 422
    assert client.post('/api/wave/feedback', json={'track_id': track, 'event_type': 'finish'}).json() == {'status': 'ok'}
    assert [e['event_type'] for e in taste_snapshot(user)['events']] == ['finish']
    old = datetime.now(timezone.utc) - timedelta(days=2)
    assert client.put(url, json={'playback_id': 'late', 'occurred_at': old.isoformat()}).status_code == 200
    assert len(taste_snapshot(user)['events']) == 2
    assert db.get_user_history(user)[0]['played_at'] != old.isoformat()
    assert client.put(f'/api/tracks/{other_track}/history', json={
        'playback_id': 'future', 'occurred_at': (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(),
    }).status_code == 422


def test_feedback_exact_retry_reschedules_after_committed_response_loss(subject, monkeypatch):
    _, client, user, _, track, _ = subject
    payload = {'track_id': track, 'event_type': 'finish', 'event_id': 'play',
               'playback_id': 'play', 'occurred_at': datetime.now(timezone.utc).isoformat(),
               'listen_duration_ms': 1000, 'track_duration_ms': 1000}
    monkeypatch.setattr(wave, 'should_recompute_embedding', lambda *a, **k: True)
    monkeypatch.setattr(wave, 'get_qdrant_client', Mock(side_effect=[RuntimeError('factory failed'), object()]))
    recompute = Mock()
    monkeypatch.setattr(wave, 'update_user_embedding_async', recompute)
    with pytest.raises(RuntimeError, match='factory failed'):
        client.put('/api/wave/feedback', json=payload)
    committed = get_taste_revision(user)
    assert client.put('/api/wave/feedback', json=payload).json()['playback_id'] == 'play'
    assert get_taste_revision(user) == committed
    recompute.assert_called_once()
    assert len(taste_snapshot(user)['events']) == 1


def test_http_boundaries_and_account_scoped_identity(subject, monkeypatch):
    app, client, user, other_user, track, _ = subject
    def unauthorized():
        raise HTTPException(401)
    app.dependency_overrides[user_content.get_current_user] = unauthorized
    url = f'/api/tracks/{track}/rating'
    like = {'operation_id': 'first', 'rating': 'like'}
    assert client.put(url, json=like).status_code == 401
    app.dependency_overrides[user_content.get_current_user] = lambda: {'id': user}
    assert client.put(url, json=like).json()['applied']
    app.dependency_overrides[user_content.get_current_user] = lambda: {'id': other_user}
    assert client.put(url, json={**like, 'rating': 'dislike'}).json()['applied']
    assert taste_snapshot(user)['likes'] == {track}
    assert taste_snapshot(other_user)['dislikes'] == {track}

    payload = {'track_id': track, 'event_type': 'finish', 'event_id': 'play',
               'playback_id': 'play', 'occurred_at': datetime.now(timezone.utc).isoformat()}
    monkeypatch.setattr(wave, 'feedback_rate_limiter', wave.InMemoryRateLimiter(max_requests=1))
    assert client.put('/api/wave/feedback', json=payload).status_code == 200
    limited = client.put('/api/wave/feedback', json=payload)
    assert limited.status_code == 429
    assert limited.headers['Retry-After'] == '60'
    monkeypatch.setattr(wave, 'feedback_rate_limiter', wave.InMemoryRateLimiter())
    db.delete_track(track)
    assert client.put('/api/wave/feedback', json=payload).status_code == 404
    assert client.post(f'/api/tracks/{track}/history').status_code == 404
    assert client.put(url, json={**like, 'operation_id': 'fresh'}).status_code == 404
    assert not client.put(url, json={**like, 'rating': 'dislike'}).json()['applied']


def test_migration_reapplication(subject):
    with db.get_connection() as conn:
        conn.execute('DELETE FROM schema_migrations WHERE version=17')
        conn.commit()
        db.apply_migrations(conn)
        assert conn.execute('SELECT count(*) FROM schema_migrations WHERE version=17').fetchone()[0] == 1
    conn.close()
