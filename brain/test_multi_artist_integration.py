import test_db_path  # noqa: F401
from types import SimpleNamespace
import pytest
from repositories import schema, tracks, interactions, playlists, albums
from repositories.artist_credits import get_credit_states
from services.artist_credit_service import set_track_artists
from services.recommendation_service import build_wave_track_payload
from serializers import serialize_track
from routers.tracks import get_track_info


@pytest.mark.parametrize('source', ['lookup', 'batch', 'recovered'])
@pytest.mark.parametrize('album_title', ['Album A', None])
def test_wave_preserves_album_navigation(tmp_path, monkeypatch, source, album_title):
    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'db.sqlite'))
    monkeypatch.setenv('MUSIC_DIR', str(tmp_path))
    schema.init_db()
    album_id = albums.add_or_get_album(album_title) if album_title else None
    tracks.add_or_update_track('track', str(tmp_path / 'missing.mp3'), 'Song', album_id, 'A')
    point = SimpleNamespace(id='track', score=1, payload={})
    kwargs = {}
    if source == 'batch':
        kwargs['db_track'] = tracks.get_tracks_by_ids(['track'])['track']
        monkeypatch.setattr('services.recommendation_service.db.get_track', lambda _: pytest.fail('batch must not fetch individual tracks'))
    elif source == 'recovered':
        row = tracks.get_track('track')
        monkeypatch.setattr('services.recommendation_service.db.get_track', lambda _: None)
        monkeypatch.setattr('services.media_locations.ensure_track_in_db', lambda *_: row)

    result = build_wave_track_payload(point, 'http://test', set(), **kwargs)

    assert result['album_id'] == album_id
    assert result['album'] == album_title


def test_credits_across_history_favorites_playlists_and_wave(tmp_path, monkeypatch):
    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'db.sqlite'))
    monkeypatch.setenv('MUSIC_DIR', str(tmp_path))
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
    assert result['artists'] == [{'id': a['id'], 'name': a['name']} for a in dto['artists']]
    assert all(a['share_id'] == a['id'] for a in dto['artists'])
    assert result['artists_revision'] == dto['artists_revision']
    assert result['artist_id'] is None


def test_credit_refresh_does_not_read_missing_audio(tmp_path, monkeypatch):
    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'db.sqlite'))
    monkeypatch.setenv('MUSIC_DIR', str(tmp_path))
    schema.init_db()
    tracks.add_or_update_track('track', str(tmp_path / 'missing.mp3'), 'Song', None, 'A')
    revision = get_credit_states('track', ['track'])['track']['revision']
    dto = set_track_artists('track', [{'name': 'A'}, {'name': 'B'}], revision, {'id': 1, 'role': 'admin'}, '')
    monkeypatch.setattr('routers.tracks.get_base_url', lambda request: '')
    result = get_track_info('track', object(), {'id': 1}, credits_only=True)
    assert result['artists'] == dto['artists']
    assert result['artists_revision'] == dto['artists_revision']
