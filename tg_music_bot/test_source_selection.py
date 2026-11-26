"""Recording mismatches reported for MILITANTUM, plus explicit-status cases."""
from dataclasses import replace
import pytest
from source_selection import Candidate, assess, duration_matches, rank_candidates, version_rejection
from source_worker import candidates_from_results, download_song, source_rejection


def song(title='завтра', artists=None, duration=91, explicit=True):
    return {'name': title, 'artists': artists or ['тёмный принц'], 'duration': duration,
            'explicit': explicit, 'album_name': 'MILITANTUM',
            'url': 'https://open.spotify.com/track/example'}


def candidate(title='завтра', artists=('тёмный принц',), duration=91, explicit=True):
    return Candidate('aaaaaaaaaaa', title, artists, duration, 'MILITANTUM', explicit)


@pytest.mark.parametrize('title', [
    'завтра (текст песни sped up)', 'завтра speed up', 'завтра (ускоренная версия)',
    'завтра (slowed + reverb)', 'завтра (nightcore)', 'завтра (live)',
    'завтра (clean)', 'завтра [цензурная версия]', 'завтра (radio edit)',
    'завтра (cover)', 'завтра (караоке)', 'завтра (без вокала)',
])
def test_rejects_wrong_recordings_even_with_matching_duration(title):
    assert assess(song(), candidate(title=title))[1]


def test_militantum_live_and_guitar_cover():
    dance = song('танцуй', ['тёмный принц', 'VILLIAN'], 116)
    assert assess(dance, candidate('танцуй (Live)', ('тёмный принц', 'VILLIAN'), 116))[1]
    hunt = song('охота на уток', ['тёмный принц', 'ashleyrossmith'], 99)
    assert assess(hunt, candidate('охота на уток (на гитаре)', ('тёмный принц', 'ashleyrossmith'), 99))[1]
    # Even a misleading plain title does not make another artist the original.
    assert assess(hunt, candidate('охота на уток', ('Guitar Covers',), 99))[1]


@pytest.mark.parametrize('explicit', [False, None])
def test_explicit_status_is_optional(explicit):
    assert assess(song(), candidate(explicit=explicit))[1] is None


def test_accepts_original_and_yo_normalization():
    assert assess(song(), candidate(artists=('темный принц',)))[1] is None
    assert assess(song(), candidate(title='завтра (Explicit)'))[1] is None
    assert assess(song(), candidate(title='завтра (без цензуры)'))[1] is None


def test_no_censorship_assumption_from_age_gate_or_duration():
    assert assess(song(), candidate(explicit=None))[1] is None
    assert not duration_matches(91, 80)
    assert duration_matches(91, 92)
    for bad in [0, None, float('nan'), float('inf'), -91]:
        assert not duration_matches(91, bad)


def test_literal_song_titles_are_not_version_markers():
    for title in ['Live Forever', 'Clean', 'Cover Me']:
        assert assess(song(title, explicit=False), candidate(title, explicit=False))[1] is None
    assert version_rejection('Live Forever', 'Live Forever (Live at Wembley)') is not None


def test_explicitly_requested_live_must_remain_live():
    requested = song('Track (Live)')
    assert assess(requested, candidate('Track'))[1]
    assert assess(requested, candidate('Track (Live)'))[1] is None


def test_every_credited_artist_must_match():
    assert assess(song(artists=['тёмный принц', 'VILLIAN']), candidate())[1]


def test_invalid_id_and_unknown_duration_are_not_downloadable():
    assert assess(song(), replace(candidate(), video_id='../bad'))[1]
    assert assess(song(), replace(candidate(), duration=0))[1]


def test_rank_never_promotes_bad_version_and_deduplicates():
    original = candidate()
    ranked, reasons = rank_candidates(song(), [replace(original, video_id='bbbbbbbbbbb', title='завтра live'), original, original])
    assert ranked == [original]
    assert reasons


def test_actual_extractor_metadata_rechecked():
    assert source_rejection(song(), {'title': 'завтра', 'duration': 91, 'was_live': True})
    assert source_rejection(song(), {'title': 'завтра sped up', 'duration': 91})
    assert source_rejection(song(), {'title': 'завтра', 'duration': 80})
    assert source_rejection(song(), {'title': 'тёмный принц — завтра', 'duration': 91}) is None


def rows():
    return [{'resultType': 'song', 'videoId': 'aaaaaaaaaaa', 'title': 'завтра',
             'artists': [{'name': 'тёмный принц'}], 'duration': '1:31',
             'isExplicit': True, 'album': {'name': 'MILITANTUM'}}]


def test_catalog_parser_excludes_videos_and_missing_explicit_stays_unknown():
    data = rows()
    data[0].pop('isExplicit')
    data.append({**data[0], 'resultType': 'video'})
    parsed = candidates_from_results(data)
    assert len(parsed) == 1 and parsed[0].duration == 91
    assert parsed[0].explicit is None


def test_download_tries_next_checked_candidate_after_failure(tmp_path):
    class Client:
        def search(self, query, **kwargs):
            assert kwargs['filter'] == 'songs'
            return rows() + [{**rows()[0], 'videoId': 'bbbbbbbbbbb'}]
    calls = []
    def fetch(s, c, directory):
        calls.append(c.video_id)
        if len(calls) == 1:
            raise RuntimeError('unavailable')
        return {'filepath': 'checked.mp3'}
    result = download_song(song(), tmp_path, client=Client(), primary=lambda s: ([], []), download=fetch)
    assert result['track']['filepath'] == 'checked.mp3'
    assert calls == ['aaaaaaaaaaa', 'bbbbbbbbbbb']


def test_unknown_explicit_does_not_block_matching_recording(tmp_path):
    class Client:
        def search(self, query, **kwargs):
            return [{**rows()[0], 'isExplicit': None}]
    result = download_song(song(), tmp_path, client=Client(),
        download=lambda *args: {'filepath': 'accepted.mp3'}, primary=lambda s: ([], []))
    assert result['track']['filepath'] == 'accepted.mp3'


def test_soundcloud_primary_keeps_identity_gates(tmp_path):
    class Client:
        def search(self, *args, **kwargs):
            raise AssertionError('Reserve catalog must not be queried')
    good = Candidate('12345', 'завтра', ('тёмный принц',), 91, 'MILITANTUM', True,
                     'soundcloud', 'https://soundcloud.com/artist/track')
    assert assess(song(), good)[1] is None
    assert assess(song(), replace(good, explicit=None))[1] is None
    assert assess(song(), replace(good, title='завтра live'))[1]
    assert assess(song(), replace(good, source_url='https://evil.test/a/b'))[1]
    result = download_song(song(), tmp_path, client=Client(),
        primary=lambda s: ([good], []), download=lambda s, c, d: {'url': c.url})
    assert result['track']['url'] == good.url


def test_soundcloud_skips_unavailable_results(monkeypatch):
    import yt_dlp
    from source_worker import find_soundcloud_candidates
    class Search:
        def add_info_extractor(self, extractor): pass
        def __init__(self, options):
            assert options['ignoreerrors'] is True
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def extract_info(self, *args, **kwargs):
            return {'entries': [None, {'id': '12345', 'track': 'завтра',
                'artists': ['тёмный принц'], 'duration': 91,
                'webpage_url': 'https://soundcloud.com/artist/track'}]}
    monkeypatch.setattr(yt_dlp, 'YoutubeDL', Search)
    found, _ = find_soundcloud_candidates(song(explicit=False))
    assert len(found) == 1 and found[0].provider == 'soundcloud'
    found, reasons = find_soundcloud_candidates(song(explicit=True))
    assert len(found) == 1


def test_feature_credit_spelling_does_not_change_recording_identity():
    s = song('CRUSH (with Travis Scott)', ['Playboi Carti', 'Travis Scott'],173.32)
    c = candidate('CRUSH', ('Playboi Carti', 'Travis Scott'), 174)
    assert assess(s,c)[1] is None
    assert assess(s,replace(c,artists=('Playboi Carti',)))[1]
    assert assess(s,replace(c,title='CRUSH (Live)'))[1]
    assert assess(s,replace(c,title='CRUSH (with Another Artist)'))[1]


def test_wrong_artist_is_not_reported_as_a_censorship_problem():
    reason = assess(song('POP OUT',['Playboi Carti'],161.7),candidate('POP OUT',('Someone else',),162,False))[1]
    assert 'исполнители' in reason and 'explicit' not in reason


def test_explicit_is_preferred_without_blocking_other_candidates():
    unknown = replace(candidate(),video_id='bbbbbbbbbbb',explicit=None)
    ranked,_ = rank_candidates(song(),[unknown,candidate()])
    assert ranked == [candidate(),unknown]


def test_remaster_fallback_requires_same_album_and_recording():
    requested = {**song('Faith - Remastered', ['George Michael'], 193.2), 'album_name': 'Faith'}
    original = Candidate('aaaaaaaaaaa', 'Faith', ('George Michael',), 194, 'Faith')
    exact = replace(original, video_id='bbbbbbbbbbb', title='Faith (Remastered)')
    assert rank_candidates(requested, [original, exact])[0] == [exact, original]
    assert assess(requested, replace(original, title='Faith (2010 Remastered Version)'))[1] is None
    for wrong in [replace(original, album='Twenty Five'), replace(original, duration=30),
                  replace(original, title='Faith (Live)'), replace(original, title='Faith (Remix)'),
                  replace(original, title='Faithful'), replace(original, artists=('Someone else',))]:
        assert assess(requested, wrong)[1]
    assert source_rejection(requested, {'title': 'Faith (2010 Remastered Version)', 'duration': 194}) is None


def test_soundcloud_failure_uses_youtube_music(tmp_path):
    calls = []
    def primary(s):
        calls.append('soundcloud')
        raise RuntimeError('unavailable')
    class Client:
        def search(self, *args, **kwargs):
            calls.append('youtube')
            return rows()
    result = download_song(song(), tmp_path, primary=primary, client=Client(),
                           download=lambda s, c, d: {'provider': c.provider})
    assert result['track']['provider'] == 'youtube'
    assert calls == ['soundcloud', 'youtube']


def test_report_explains_unavailable_original_and_omits_rejected_covers(tmp_path):
    from yt_dlp.utils import DownloadError

    original = Candidate('12345', 'завтра', ('тёмный принц',), 91, 'MILITANTUM', True,
                         'soundcloud', 'https://soundcloud.com/artist/track')

    class Client:
        def search(self, *args, **kwargs):
            return [{**rows()[0], 'artists': [{'name': 'Cover Artist'}]}]

    def protected(*args):
        raise DownloadError('ERROR: This video is DRM protected')

    result = download_song(song(), tmp_path, primary=lambda s: ([original], ['Не совпадает длительность']),
                           client=Client(), download=protected)
    assert result['error'] == 'SoundCloud: запись защищена DRM; YouTube Music: нужная версия не найдена'


def test_vk_reserve_preserves_all_artist_credits_and_skips_remixes(monkeypatch, tmp_path):
    from contextlib import nullcontext
    import vk_music

    requested = {**song('Let Me Love You', ['DJ Snake', 'Justin Bieber'], 206),
                 'preview_url': 'https://p.scdn.co/mp3-preview/example'}
    row = {'href': '/audio-2001667369_6667369', 'title': 'Let Me Love You', 'duration': '3:26',
           'artists': ['DJ Snake', 'Justin Bieber'], 'artist': 'DJ Snake, Justin Bieber'}
    class Browser:
        def get(self, url):
            assert url == 'https://vk.com/artist/djsnake/top_audios'
            self.current_url = url

    monkeypatch.setattr(vk_music, 'music_browser', lambda _: nullcontext(Browser()))
    monkeypatch.setattr(vk_music, '_rows', lambda *_: [
        {**row, 'href': '/audio-1_1', 'title': 'Let Me Love You Remix'},
        {**row, 'href': '/audio-1_2', 'artists': ['DJ Snake']}, row])
    class Empty:
        def search(self, *args, **kwargs):
            return []

    result = download_song(requested, tmp_path, primary=lambda s: ([], []), client=Empty(),
                           download=lambda s, c, d: c)
    chosen = result['track']
    assert chosen.provider == 'vk'
    assert chosen.url == 'https://vk.ru/audio-2001667369_6667369'
    assert assess(requested, replace(chosen, source_url='https://other.example/audio-2001667369_6667369'))[1]


def test_vk_audio_mismatch_is_never_accepted(monkeypatch, tmp_path):
    import audio_match
    import downloader
    import vk_music
    from source_worker import download_candidate

    requested = {**song(), 'reference_audio': str(tmp_path / 'preview.mp3')}
    recording = replace(candidate(), provider='vk', video_id='-1_2', source_url='https://vk.ru/audio-1_2')
    def download(source, directory, **kwargs):
        path = directory / 'audio.mp3'
        path.write_bytes(b'fake')
        return {'path': str(path)}

    monkeypatch.setattr(vk_music, 'download', download)
    monkeypatch.setattr(downloader, '_finalize_track', lambda *a, **kw: {'verification': True, 'duration': 91})
    monkeypatch.setattr(audio_match, 'matches_excerpt', lambda *a: False)
    with pytest.raises(ValueError, match='отличается от фрагмента Spotify'):
        download_candidate(requested, recording, tmp_path)
