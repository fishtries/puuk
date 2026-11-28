from pathlib import Path
from zipfile import ZipFile

import numpy as np
import pytest

from audio_match import SAMPLE_RATE, matches_excerpt
from import_sources import canonical_link, resolve_attachment, resolve_link


def test_track_link_takes_precedence_over_playlist():
    for url in ('https://music.youtube.com/watch?v=abcdef01234&list=PL-example',
                'https://youtu.be/abcdef01234?list=PL-example'):
        assert canonical_link(url) == 'https://www.youtube.com/watch?v=abcdef01234'


def test_vk_legacy_playlist_link_keeps_access_parameters():
    assert (canonical_link('https://vk.ru/audio_playlist429568221_15')
            == 'https://vk.ru/music/playlist/429568221_15')
    assert (canonical_link('https://m.vk.com/audio_playlist-123_4_a1b2/?access_key=x%2By#share')
            == 'https://vk.com/music/playlist/-123_4_a1b2?access_key=x%2By')


def test_large_spotify_playlist_keeps_order_repeats_and_unavailable_positions(monkeypatch):
    playlist_id, track_id = 'a' * 22, 'b' * 22
    uri = f'spotify:track:{track_id}'
    track = {'uri': uri, 'name': 'Track', 'trackDuration': {'totalMilliseconds': 240000},
             'artists': {'items': [{'profile': {'name': 'Artist'}}]}, 'contentRating': {'label': 'EXPLICIT'}}
    items = [{'uid': 'first', 'itemV2': {'data': track}}, {'uid': 'missing'},
             {'uid': 'second', 'itemV2': {'data': track}}]
    monkeypatch.setattr('import_sources.fetch_entity', lambda *_: {'title': 'Playlist', 'trackList': [{}] * 100})
    monkeypatch.setattr('import_sources.read_public_playlist', lambda *_: ({'name': 'Playlist'}, items))

    title, kind, sources = resolve_link(f'https://open.spotify.com/playlist/{playlist_id}')

    assert (title, kind) == ('Playlist', 'playlist')
    assert [(source['type'], source['slot']) for source in sources] == [
        ('spotify', 'first:1'), ('unavailable', 'missing:1'), ('spotify', 'second:1')]
    assert sources[0]['song']['duration'] == 240
    assert sources[0]['song']['explicit'] is True
    assert sources[0]['spotify_preview_from_track'] is True


@pytest.mark.parametrize('last_page_total', [3, 4])
def test_spotify_pages_must_agree_on_total(monkeypatch, last_page_total):
    from contextlib import nullcontext
    import spotify_playlist

    class Browser:
        def execute_cdp_cmd(self, *_):
            pass

        def get(self, _):
            pass

    def pages(_, uri, __):
        yield 2, {'content': {'totalCount': last_page_total, 'pagingInfo': {'offset': 2},
                              'items': [{'uid': 'third'}]}}
        yield 0, {'name': 'Playlist', 'uri': uri, 'content': {'totalCount': 3, 'pagingInfo': {'offset': 0},
                                                             'items': [{'uid': 'first'}, {'uid': 'second'}]}}

    monkeypatch.setattr(spotify_playlist, 'music_browser', lambda _: nullcontext(Browser()))
    monkeypatch.setattr(spotify_playlist, '_pages', pages)

    if last_page_total == 3:
        _, rows = spotify_playlist.read_public_playlist('a' * 22, 1000)
        assert [row['uid'] for row in rows] == ['first', 'second', 'third']
    else:
        with pytest.raises(ValueError, match='не показал полный список'):
            spotify_playlist.read_public_playlist('a' * 22, 1000)


def test_deferred_spotify_preview_is_saved_with_checked_audio(monkeypatch, tmp_path):
    from import_sources import _download_with_cover

    uri = 'spotify:track:' + 'b' * 22
    url = 'https://p.scdn.co/mp3-preview/example'
    source = {'key': uri, 'song': {'song_id': 'b' * 22, 'duration': 240},
              'spotify_preview_from_track': True}
    monkeypatch.setattr('import_sources.fetch_entity', lambda *_: {'uri': uri, 'audioPreview': {'url': url}})
    monkeypatch.setattr('import_sources.download_import_cover', lambda *_: None)

    def download(resolved, _, *, progress=None):
        assert resolved['song']['preview_url'] == url
        return {'evidence': {'audio_match': 'spotify-preview-original-speed'}}

    monkeypatch.setattr('import_sources.download_source', download)

    assert _download_with_cover(source, tmp_path)['evidence']['reference'] == {'preview_url': url, 'duration': 240}


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


@pytest.mark.parametrize('cdn', ['https://vd685.okcdn.ru/audio', 'https://ok2-16.vkuser.net/audio'])
def test_vk_mp4_selects_started_stream_instead_of_prefetch(cdn):
    import json

    from vk_music import Playback, _selected_playback

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


def test_vk_metadata_matching_checks_recording_and_keeps_distinct_editions(monkeypatch):
    from import_sources import vk_catalog_matches

    track = {'title': 'Teardrop', 'artist': 'Massive Attack', 'duration': 331}
    edition = {**track, 'album': 'Mezzanine', 'year': '1998', 'source': 'iTunes',
               'cover_url': 'https://is1-ssl.mzstatic.com/art.jpg'}
    results = [
        edition,
        {**edition, 'year': '', 'source': 'Deezer'},
        {**edition, 'artist': 'Another artist'},
        {**edition, 'duration': 270},
        {**edition, 'album': 'Live in London'},
        {**edition, 'title': 'Teardrop (Remastered 2018)', 'year': '2018'},
    ]
    monkeypatch.setattr('services.external_catalogs.search_metadata_providers',
                        lambda query, *, search_both: results if query == 'Massive Attack Teardrop' and search_both else [])
    matches = vk_catalog_matches(track)
    assert [(item['year'], item['confirm']) for item in matches] == [('1998', False), ('2018', True)]
    assert vk_catalog_matches({**track, 'duration': None}) == []


def test_reviewed_candidate_requires_full_audio(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from import_sources import repair_source

    candidate = {'key': 'youtube:00000000001', 'title': 'Version', 'artist': 'Artist', 'duration': 205,
                 'provider_id': '00000000001', 'url': 'https://www.youtube.com/watch?v=00000000001'}
    returned = {'path': str(tmp_path / 'audio.mp3'), 'evidence': {'id': candidate['provider_id']}}
    monkeypatch.setattr('import_sources.download_source', lambda *_args, **_kwargs: returned.copy())
    sound = SimpleNamespace(info=SimpleNamespace(length=20))
    monkeypatch.setattr('mutagen.File', lambda *_: sound)
    source = {'type': 'vk', 'key': 'vk:track:1_111'}
    with pytest.raises(ValueError, match='полную выбранную запись'):
        repair_source(source, {'candidate': candidate}, tmp_path)

    sound.info.length = 205
    result = repair_source(source, {'candidate': candidate}, tmp_path)
    assert result['evidence']['selection'] == 'user-replacement'
    assert result['evidence']['candidate']['key'] == candidate['key']


def test_vk_album_lookup_matches_edition_by_title_and_duration_and_preserves_playlist_positions():
    from release_metadata import match_release, vk_release_request

    artist = '山下達郎'
    rows = [
        {'title': 'Your Eyes', 'duration': 198},
        {'title': 'Loveland,Island', 'duration': 269},
        {'title': 'あまく危険な香り [TV用インスト1 –TV Instrumental Version 1–]', 'duration': 179},
    ]
    request = vk_release_request('Tatsuro Yamashita - For You, 1982', [
        {**row, 'artist': artist, 'type': 'vk', 'position': index} for index, row in enumerate(rows, 1)
    ])
    assert request['album'] == 'For You'
    release = {
        'title': 'FOR YOU', 'date': '2002-02-14', 'id': '6de2423a-d4b2-4382-9bde-4f21b09dbc79',
        'status': 'Official', 'artist-credit': [{'name': artist}], 'cover-art-archive': {'front': True},
        'media': [{'position': 1, 'tracks': [
            {'position': 1, 'title': 'LOVELAND, ISLAND', 'length': 270000},
            {'position': 2, 'title': 'YOUR EYES', 'length': 199000},
            {'position': 3, 'title': 'あまく危険な香り［TV用インスト 1］', 'length': 180000},
        ]}],
    }
    mapping = match_release(request, release)
    assert [mapping[str(position)]['track_number'] for position in (1, 2, 3)] == ['2', '1', '3']
    assert mapping['3']['year'] == '2002'
    release['media'][0]['tracks'][2]['title'] = 'あまく危険な香り［TV用インスト 2］'
    assert match_release(request, release) == {}


def test_cover_art_archive_redirect_is_limited_to_the_same_release(monkeypatch, tmp_path):
    from unittest.mock import MagicMock
    from import_sources import download_import_cover

    release_id = '6de2423a-d4b2-4382-9bde-4f21b09dbc79'
    cover_url = f'https://coverartarchive.org/release/{release_id}/front-500'
    redirect_path = f'mbid-{release_id}/mbid-{release_id}-123_thumb500.jpg'
    responses = []

    def reply(location=None):
        response = MagicMock()
        response.__enter__.return_value = response
        response.is_redirect = location is not None
        response.status_code = 307 if location else 200
        response.headers = {'Location': location} if location else {'Content-Type': 'image/jpeg'}
        response.iter_content.return_value = [b'image']
        responses.append(response)

    reply(f'https://archive.org/download/{redirect_path}')
    reply(f'https://dn721602.ca.archive.org/0/items/{redirect_path}')
    reply()
    monkeypatch.setattr('requests.get', lambda *_args, **_kwargs: responses.pop(0))
    assert Path(download_import_cover({'cover_url': cover_url}, tmp_path, catalog=True)).read_bytes() == b'image'

    reply('https://archive.org/download/mbid-other/mbid-other-123_thumb500.jpg')
    assert download_import_cover({'cover_url': cover_url}, tmp_path, catalog=True) is None
