import downloader


def test_match_rejects_ambiguous_title_and_neighbour():
    songs = [{'name': 'Same', 'artists': ['A']}, {'name': 'Same', 'artists': ['B']}]
    assert downloader._match_song(songs, 'Same', '', 'Same.mp3') is None
    assert downloader._match_song(songs, 'Same', 'B', 'Same.mp3') == songs[1]
    assert downloader._match_song(songs, 'Other', '', 'Other.mp3') is None

from types import SimpleNamespace


def test_build_tracks_only_uses_provider_for_unique_file(monkeypatch):
    songs = [{'name': 'Same', 'artists': ['A', 'B']}]
    tag = SimpleNamespace(title='Same', artist='A, B')
    monkeypatch.setattr(downloader, 'read_audio_tags', lambda path: tag)
    seen = []
    def finalize(path, song=None):
        seen.append((path, song))
        return {'filepath': path, 'artists': song['artists'] if song else None,
                'artists_kind': 'provider' if song else None}
    monkeypatch.setattr(downloader, '_finalize_track', finalize)
    tracks = downloader._build_tracks(['one.mp3', 'neighbor.mp3'], songs)
    assert [song for _, song in seen] == [None, None]
    assert all(track['artists_kind'] is None for track in tracks)
    tracks = downloader._build_tracks(['one.mp3'], songs)
    assert tracks[0]['artists'] == ['A', 'B']
    assert tracks[0]['artists_kind'] == 'provider'


def test_known_title_never_matches_neighbour_filename():
    song = {'name': 'Neighbour', 'artists': ['A']}
    assert downloader._match_song([song], 'Different', 'A', 'A - Neighbour.mp3') is None


def test_finalized_provider_arrays_survive_verified_metadata(monkeypatch, tmp_path):
    import audio_tags
    path = tmp_path / 'song.mp3'
    path.write_bytes(b'fixture')
    tags = audio_tags.AudioTags(path=str(path), title='Title', artist='tag name', album='Album', album_artist='Album Lead', has_cover=True)
    monkeypatch.setattr(downloader, 'read_audio_tags', lambda _: tags)
    monkeypatch.setattr(downloader, 'write_audio_metadata', lambda *args, **kwargs: tags)
    monkeypatch.setattr(downloader, 'verify_audio_tags', lambda _: (True, []))
    song = {'name': 'Title', 'artists': ['Provider A', 'Provider B']}
    result = downloader._build_tracks([str(path)], [song])[0]
    verified = result['verified_metadata']
    assert verified['artist'] == 'tag name'
    assert verified['artists'] == ['Provider A', 'Provider B']
    assert verified['artists_kind'] == 'provider'
    assert verified['album_artists'] is None
    assert path.read_bytes() == b'fixture'
