import test_db_path  # noqa: F401
from types import SimpleNamespace
from repositories import schema, tracks, interactions, playlists
from repositories.artist_credits import get_credit_states
from services.artist_credit_service import set_track_artists
from services.recommendation_service import build_wave_track_payload
from serializers import serialize_track
from routers.tracks import get_track_info


def test_credits_across_history_favorites_playlists_and_wave(tmp_path, monkeypatch):
    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'db.sqlite'))
    schema.init_db()
    tracks.add_or_update_track('track', str(tmp_path / 'missing.mp3'), 'Song', None, 'A')
    revision = get_credit_states('track', ['track'])['track']['revision']
    dto = set_track_artists('track', [{'name': 'A'}, {'name': 'B'}], revision, {'id': 1, 'role': 'admin'}, 'http://test')
    interactions.add_favorite(1, 'track')
    interactions.add_history(1, 'track')
    playlist = playlists.create_playlist('test', 1)
    playlists.add_track_to_playlist(playlist, 'track')
    for row in [interactions.get_user_favorites(1)[0], interactions.get_user_history(1)[0], playlists.get_playlist_tracks(playlist)[0]]:
        result = serialize_track(row, 'http://test')
        assert result['artists'] == dto['artists']
        assert result['artists_revision'] == dto['artists_revision']
        assert result['artist_id'] is None
    point = SimpleNamespace(id='track', score=1, payload={})
    result = build_wave_track_payload(point, 'http://test', set(), db_track=tracks.get_track('track'))
    assert result['artists'] == dto['artists']
    assert result['artists_revision'] == dto['artists_revision']
    assert result['artist_id'] is None


def test_credit_refresh_does_not_read_missing_audio(tmp_path, monkeypatch):
    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'db.sqlite'))
    schema.init_db()
    tracks.add_or_update_track('track', str(tmp_path / 'missing.mp3'), 'Song', None, 'A')
    revision = get_credit_states('track', ['track'])['track']['revision']
    dto = set_track_artists('track', [{'name': 'A'}, {'name': 'B'}], revision, {'id': 1, 'role': 'admin'}, '')
    monkeypatch.setattr('routers.tracks.get_base_url', lambda request: '')
    result = get_track_info('track', object(), {'id': 1}, credits_only=True)
    assert result['artists'] == dto['artists']
    assert result['artists_revision'] == dto['artists_revision']
