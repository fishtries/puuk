import test_db_path  # noqa: F401
from datetime import datetime, timezone, timedelta
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import numpy as np
import pytest
import db
from repositories.wave import record_listening_event, get_taste_revision, taste_snapshot
from services.taste_profile import track_weights, centroid, taste_centers
from user_profile import should_recompute_embedding


@pytest.fixture
def subject():
    user=db.create_user('taste_'+uuid.uuid4().hex)
    track=str(uuid.uuid4())
    db.add_or_update_track(track,track+'.mp3','Track',None,'Artist')
    yield user,track
    db.delete_user(user)
    db.delete_track(track)


def test_repeated_delivery_is_atomic_and_concurrent(subject):
    user,track=subject
    def send(_):
        return record_listening_event(user,track,'like',1000,2000,event_id='same')
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert sum(pool.map(send,range(8)))==1
    c=db.get_connection()
    try:
        assert c.execute('SELECT COUNT(*) FROM user_wave_feedback WHERE user_id=?',(user,)).fetchone()[0]==1
        assert c.execute('SELECT like_count FROM track_stats WHERE track_id=?',(track,)).fetchone()[0]==1
    finally:c.close()
    with pytest.raises(ValueError):record_listening_event(user,track,'finish',event_id='same')


def test_revision_keeps_advancing_after_100(subject):
    user,track=subject
    for _ in range(105):db.add_history(user,track)
    db.set_user_embedding(user,np.ones(400,dtype=np.float32),100)
    assert not should_recompute_embedding(user)
    for _ in range(10):db.add_history(user,track)
    assert should_recompute_embedding(user)
    db.set_user_embedding(user,np.ones(400,dtype=np.float32),100)
    db.add_dislike(user,track)
    assert should_recompute_embedding(user)
    assert not track_weights(taste_snapshot(user))


def test_failed_stats_rolls_back_event_like_and_revision(subject):
    user,track=subject
    revision=get_taste_revision(user)
    with patch('repositories.wave.update_track_stats',side_effect=RuntimeError('failed')):
        with pytest.raises(RuntimeError):record_listening_event(user,track,'like',event_id='rollback')
    assert get_taste_revision(user)==revision
    assert not db.is_favorite(user,track)


def snapshot(events):
    return {'events':events,'likes':set(),'dislikes':set()}


def event(key='a',kind='finish',day=0,**extra):
    at=datetime(2026,1,1,tzinfo=timezone.utc)+timedelta(days=day)
    return {'track_id':key,'event_type':kind,'ts':at.isoformat(),'received_at':at.isoformat(),
            'listen_duration_ms':100000,'track_duration_ms':100000,**extra}


def test_repeat_saturation_activity_decay_and_future_exclusion():
    now=datetime(2026,12,1,tzinfo=timezone.utc)
    single=track_weights(snapshot([event()]),now=now)['a']
    repeated=track_weights(snapshot([event()]*100),now=now)['a']
    assert single < repeated < 2*single
    assert track_weights(snapshot([event()]),now=now+timedelta(days=300))['a']==single
    active=[event('b',day=d) for d in range(1,31) for _ in range(5)]
    assert track_weights(snapshot([event(),*active]),now=now)['a']< single*.6
    late=event();late['received_at']='2027-01-01T00:00:00+00:00'
    assert not track_weights(snapshot([late]),now=now)


def test_manual_skip_is_weaker_than_recommended_skip_and_import_ignored():
    positive=event()
    skip=event(kind='skip',listen_duration_ms=1000,context='wave')
    a=track_weights(snapshot([positive,skip]))['a']
    b=track_weights(snapshot([positive,{**skip,'context':'manual'}]))['a']
    assert b>a
    assert not track_weights(snapshot([event(provenance='import')]))


def test_invalid_vectors_and_distinct_centers():
    a=np.zeros(400);a[0]=1
    b=np.zeros(400);b[1]=1
    vectors={**{f'a{i}':a for i in range(5)},**{f'b{i}':b for i in range(5)}}
    weights={k:1 for k in vectors}
    centers=taste_centers(vectors,weights)
    assert len(centers)==2
    assert sorted(len(c['tracks']) for c in centers)==[5,5]
    assert centroid({'x':[float('nan')]*400},{'x':1}) is None


def test_migration_reapplication_is_idempotent(subject):
    c=db.get_connection()
    try:
        c.execute('DELETE FROM schema_migrations WHERE version=15');c.commit()
        db.apply_migrations(c)
        assert c.execute('SELECT COUNT(*) FROM schema_migrations WHERE version=15').fetchone()[0]==1
    finally:c.close()


def test_history_and_feedback_are_not_both_positive_for_same_play(subject):
    user,track=subject
    db.add_history(user,track)
    record_listening_event(user,track,'finish',100000,100000,event_id='finish')
    rows=taste_snapshot(user)['events']
    assert len(rows)==1 and rows[0]['event_type']=='finish'


def test_imported_favorite_is_not_a_manual_like(subject):
    user,track=subject
    db.add_favorite(user,track,provenance='import')
    assert track not in taste_snapshot(user)['likes']
    record_listening_event(user,track,'like',event_id='actual-like')
    assert track in taste_snapshot(user)['likes']


def test_stale_computation_cannot_overwrite_newer_revision(subject):
    user,track=subject
    revision=get_taste_revision(user)
    db.add_history(user,track)
    db.set_user_embedding(user,np.ones(400,dtype=np.float32),100,source_revision=revision)
    assert db.get_user_embedding(user) is None


def test_feedback_http_retry_conflict_and_validation(subject,monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers import wave
    user,track=subject
    app=FastAPI();app.include_router(wave.router)
    app.dependency_overrides[wave.get_current_user]=lambda:{'id':user}
    monkeypatch.setattr(wave,'should_recompute_embedding',lambda *a,**k:False)
    client=TestClient(app)
    payload={'track_id':track,'event_type':'finish','event_id':'http-retry',
             'occurred_at':'2026-01-01T00:00:00Z','context':'manual',
             'listen_duration_ms':100000,'track_duration_ms':100000}
    assert client.post('/api/wave/feedback',json=payload).status_code==200
    revision=get_taste_revision(user)
    assert client.post('/api/wave/feedback',json=payload).status_code==200
    assert get_taste_revision(user)==revision
    assert client.post('/api/wave/feedback',json={**payload,'event_type':'skip'}).status_code==409
    assert client.post('/api/wave/feedback',json={**payload,'listen_duration_ms':-1}).status_code==422
    assert client.post('/api/wave/feedback',json={**payload,'occurred_at':'2099-01-01T00:00:00Z'}).status_code==422


def test_compare_freezes_inputs_and_reports_missing_vectors():
    from taste_compare import compare
    import copy
    v=np.zeros(400);v[0]=1
    data={'events':[event('known'),event('missing')],'likes':[],'dislikes':[],
          'vectors':{'known':v.tolist()}}
    frozen=copy.deepcopy(data)
    report=compare(data,datetime(2026,12,1,tzinfo=timezone.utc))
    assert data==frozen
    assert report['missing_vector_ids']==['missing']
    assert report['cosine_to_baseline']==pytest.approx(1.)
    assert report['limitations']


def test_reset_preserves_library_and_replay_memory_and_relearns(subject):
    from repositories.wave import reset_taste, recent_wave_exposure

    user, track = subject
    db.add_history(user, track)
    db.add_favorite(user, track)
    revision = get_taste_revision(user)
    db.set_user_embedding(user, np.ones(400), 1, source_revision=revision)
    reset_taste(user)
    assert db.get_favorite_track_ids(user) == {track}
    assert not db.get_favorite_track_ids(user, for_taste=True)
    assert db.get_user_listening_history(user) == []
    assert track in recent_wave_exposure(user)
    db.set_user_embedding(user, np.ones(400), 1, source_revision=revision)
    assert db.get_user_embedding(user) is None
    record_listening_event(user, track, 'finish', occurred_at='2020-01-01T00:00:00Z')
    assert not track_weights(taste_snapshot(user))
    record_listening_event(user, track, 'finish')
    assert track in track_weights(taste_snapshot(user))
    db.remove_favorite(user, track)
    db.add_favorite(user, track)
    assert taste_snapshot(user)['likes'] == {track}
