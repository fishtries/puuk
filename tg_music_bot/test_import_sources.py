from pathlib import Path
from zipfile import ZipFile

import numpy as np
import pytest

from audio_match import SAMPLE_RATE, matches_excerpt
from import_sources import canonical_link, resolve_attachment


def test_track_link_takes_precedence_over_playlist():
    for url in ('https://music.youtube.com/watch?v=abcdef01234&list=PL-example',
                'https://youtu.be/abcdef01234?list=PL-example'):
        assert canonical_link(url) == 'https://www.youtube.com/watch?v=abcdef01234'


def test_vk_legacy_playlist_link_keeps_access_parameters():
    assert (canonical_link('https://vk.ru/audio_playlist429568221_15')
            == 'https://vk.ru/music/playlist/429568221_15')
    assert (canonical_link('https://m.vk.com/audio_playlist-123_4_a1b2/?access_key=x%2By#share')
            == 'https://vk.com/music/playlist/-123_4_a1b2?access_key=x%2By')


def test_original_speed_passes_and_slowed_version_fails(monkeypatch):
    rng = np.random.default_rng(15)
    audio = rng.normal(size=23 * SAMPLE_RATE)
    excerpt = audio[4 * SAMPLE_RATE:20 * SAMPLE_RATE]
    slowed = np.interp(np.arange(0, len(audio), 0.98), np.arange(len(audio)), audio)
    reference, correct, wrong = map(Path, ('reference', 'correct', 'wrong'))
    data = {reference: excerpt, correct: audio, wrong: slowed}
    monkeypatch.setattr('audio_match._decode', lambda file, _: data[file])
    assert matches_excerpt(reference, correct, 23)
    assert not matches_excerpt(reference, wrong, 24)


def test_archive_paths_are_validated_before_extraction(tmp_path):
    path = tmp_path / 'upload.zip'
    with ZipFile(path, 'w') as archive:
        archive.writestr('../outside.flac', b'audio')
    with pytest.raises(ValueError, match='недопустимый путь'):
        resolve_attachment(path, tmp_path)
    assert not (tmp_path.parent / 'outside.flac').exists()


@pytest.mark.parametrize(('filename', 'title', 'artist'), [
    ('original-ксд — инди басист.mp3', 'инди басист', 'ксд'),
    ('original-Твой свет extended.mp3', 'Твой свет extended', ''),
])
def test_single_untagged_attachment_can_import_without_identifying_album(tmp_path, monkeypatch,
                                                                    filename, title, artist):
    from metadata import AudioMetadata

    audio = tmp_path / filename
    audio.write_bytes(b'audio')
    monkeypatch.setattr('import_sources._read_attachment',
                        lambda path: (path, AudioMetadata(title=path.stem)))
    monkeypatch.setattr('services.external_catalogs.search_metadata_providers', lambda _: [])
    name, kind, (source,) = resolve_attachment(audio, tmp_path)
    assert (name, kind, source['artist'], source['metadata_options']) == (title, 'track', artist, None)


def test_vk_range_requires_matching_version_and_exact_end(tmp_path, monkeypatch):
    import json

    from vk_music import _download_bytes

    url = 'https://audio.vkuseraudio.ru/s/example'
    part = tmp_path / 'vk-audio.part'
    state = tmp_path / 'vk-audio.json'
    part.write_bytes(b'1234')
    state.write_text(json.dumps({'resource': url, 'etag': '"stable"', 'total': 6}))

    class Response:
        status_code = 206
        headers = {'Content-Length': '2', 'Content-Range': 'bytes 4-5/6', 'ETag': '"stable"'}

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def iter_content(self, _):
            yield b'56'

    response = Response()

    def serve(_url, headers, **_):
        assert headers['Range'] == 'bytes=4-'
        assert headers['If-Range'] == '"stable"'
        return response

    monkeypatch.setattr('vk_music.requests.get', serve)
    assert _download_bytes(url, tmp_path).read_bytes() == b'123456'

    part.write_bytes(b'1234')
    response.headers = {**response.headers, 'Content-Range': 'bytes 3-4/6'}
    assert _download_bytes(url, tmp_path) is None
    assert part.read_bytes() == b'1234'
    assert not state.exists()


def test_vk_mp4_selects_started_stream_instead_of_prefetch():
    import json

    from vk_music import Playback, _selected_playback

    cdn = 'https://vd685.okcdn.ru/audio'
    manifest = f"""<MPD mediaPresentationDuration="PT157.283S">
      <Period><AdaptationSet mimeType="audio/mp4">
        <Representation><BaseURL>/audio?id=1&amp;sig=a%2bb</BaseURL></Representation>
        <Representation><BaseURL>/audio?id=2&amp;sig=a%2bb</BaseURL></Representation>
      </AdaptationSet></Period>
    </MPD>"""

    def event(method, **params):
        return {'message': json.dumps({'message': {'method': 'Network.' + method, 'params': params}})}

    def response(query, content_range):
        return event('responseReceived', response={'url': f'{cdn}?{query}', 'status': 200,
                     'mimeType': 'audio/mp4', 'headers': {'content-range': content_range}})

    class Browser:
        def get_log(self, name):
            assert name == 'performance'
            return [
                event('responseReceived', requestId='mpd',
                      response={'url': cdn, 'status': 200, 'mimeType': 'application/dash+xml'}),
                event('loadingFinished', requestId='mpd'),
                response('id=2&bytes=0-1382&sig=a%2bb', 'bytes 0-1382/5072531'),
                response('id=1&bytes=0-1382&sig=a%2bb', 'bytes 0-1382/2556923'),
                response('id=1&bytes=1383-109515&sig=a%2bb', 'bytes 1383-109515/2556923'),
            ]

        def execute_cdp_cmd(self, method, params):
            assert method == 'Network.getResponseBody' and params == {'requestId': 'mpd'}
            return {'body': manifest, 'base64Encoded': False}

    assert _selected_playback(Browser(), 157) == Playback(f'{cdn}?id=1&sig=a%2bb', 2556923, 157.283)


def test_vk_mp4_requires_full_range_and_exact_body_size(tmp_path, monkeypatch):
    from vk_music import Playback, _download_mp4

    class Response:
        status_code = 200
        headers = {'Content-Range': 'bytes 0-1/6', 'Content-Length': '2'}
        content = b'12'

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def raise_for_status(self):
            pass

        def iter_content(self, _):
            yield self.content

    response = Response()
    url = 'https://vd685.okcdn.ru/audio?id=1'

    def serve(request, headers, **_):
        assert request == url and headers['Range'] == 'bytes=0-5'
        return response

    monkeypatch.setattr('vk_music.requests.get', serve)
    playback = Playback(url, 6, 157.283)
    with pytest.raises(ValueError, match='полный диапазон'):
        _download_mp4(playback, tmp_path)

    response.status_code = 206
    response.headers = {'Content-Range': 'bytes 0-5/6', 'Content-Length': '6'}
    with pytest.raises(OSError, match='Неполный ответ'):
        _download_mp4(playback, tmp_path)

    response.content = b'123456'
    assert _download_mp4(playback, tmp_path).read_bytes() == response.content
