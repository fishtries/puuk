"""Download the selected recording from the public VK Music player."""
import base64
import json
from pathlib import Path
import re
import subprocess
import time
from typing import NamedTuple
from urllib.parse import quote, unquote_plus, urljoin, urlsplit
from xml.etree import ElementTree

import requests

from music_browser import music_browser
from source_selection import Candidate, normalized, rank_candidates


PLAYLIST_TITLE = '[data-testid="MusicPlaylistPage_Title"]'
PLAYLIST_COUNT = '[data-testid="musicplayliststatistics-count"]'
PLAYLIST_ROWS = '[data-testid="MusicPlaylistTracks_Items"] [data-testid="MusicTrackRow"]'
TRACK_TITLE = '[data-testid="MusicTrackRow_Title"]'
SINGLE_TITLE = '[data-testid="AudioAudioPage_Title"]'
SINGLE_PLAY = '[data-testid="MusicAudio_TogglePlaying"]'
PLAY = '[data-testid="audiorow-tappable"]'
TRACK_ID = re.compile(r'/audio(-?\d+_\d+)(?:_[0-9a-fA-F]+)?/?$')
MAX_POSITIONS = 1000
MAX_AUDIO_BYTES = 512 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024
CONTENT_RANGE = re.compile(r'bytes (\d{1,10})-(\d{1,10})/(\d{1,10})')


class Playback(NamedTuple):
    url: str
    size: int | None = None
    duration: float | None = None


class ExpiredMedia(OSError):
    pass


def _source(base, row, album=None, track=None):
    url = urljoin(base, row['href'])
    parsed = urlsplit(url)
    match = TRACK_ID.fullmatch(parsed.path)
    if not match or parsed.hostname not in {'vk.com', 'vk.ru', 'm.vk.com'}:
        raise ValueError('VK Музыка вернула позицию без идентификатора записи')
    length = row['duration'].split(':')
    seconds = sum(int(part) * 60 ** i for i, part in enumerate(reversed(length))) if all(
        part.isdecimal() for part in length) else None
    return {'type': 'vk', 'key': f'vk:track:{match[1]}', 'title': row['title'],
            'artist': row['artist'], 'url': url, 'provider_id': match[1], 'duration': seconds,
            'album': album, 'track': track, 'cover_url': row.get('cover_url')}


def _rows(browser, selector):
    return browser.execute_script("""
        const rows = document.querySelectorAll(arguments[0]);
        return Array.from(rows, row => {
            const title = row.querySelector(arguments[1]);
            const artists = Array.from(row.querySelectorAll('[data-testid="MusicTrackRow_Authors"]'),
                a => a.textContent.trim()).filter(Boolean);
            return {href: title?.getAttribute('href') ?? '',
                    title: title?.textContent.trim() ?? '',
                    artist: artists.join(', '), artists,
                    cover_url: row.querySelector('[data-testid="MusicTrackRow_PlaybackControls"] img')?.src,
                    duration: row.querySelector('[data-testid="MusicTrackRow_Duration"]')?.textContent.trim() ?? ''};
        });
    """, selector, TRACK_TITLE)


def _wait_for(browser, action, message, timeout=15):
    from selenium.common.exceptions import TimeoutException
    from selenium.webdriver.support.ui import WebDriverWait

    try:
        return WebDriverWait(browser, timeout).until(action)
    except TimeoutException:
        raise ValueError(message) from None


def find_spotify_candidates(song):
    """Search the public artist track lists, which are available to guest listeners."""
    selector = '[data-testid="MusicTrackRow"]'
    opened_catalog = False
    with music_browser('VK Музыки') as browser:
        for artist in song['artists'][:2]:
            slug = normalized(artist).replace(' ', '')
            if not slug:
                continue
            browser.get('https://vk.com/artist/' + quote(slug, safe='') + '/top_audios')
            try:
                rows = _wait_for(browser, lambda d: _rows(d, selector), 'Нет списка треков', timeout=15)
            except ValueError:
                continue
            opened_catalog = True
            candidates = []
            for row in rows:
                if not TRACK_ID.fullmatch(row['href']):
                    continue
                track = _source(browser.current_url, row)
                ident = track['provider_id']
                candidates.append(Candidate(ident, track['title'], tuple(row['artists']),
                                            track['duration'], provider='vk', source_url=f'https://vk.ru/audio{ident}'))
            ranked, reasons = rank_candidates(song, candidates)
            if ranked:
                return ranked, reasons
    return [], [] if opened_catalog else ['Каталог VK Музыка недоступен']


def _load_playlist(browser, expected):
    def identities(items):
        return [(item['href'], item['title'], item['artist'], item['duration']) for item in items]

    rows = _rows(browser, PLAYLIST_ROWS)
    if len(rows) < expected:
        browser.execute_script('document.querySelector(\'[data-testid="audiolistitems-expandbutton"]\')?.click()')
    deadline = time.monotonic() + 90
    while len(rows) < expected and time.monotonic() < deadline:
        browser.execute_script("""
            const rows = document.querySelectorAll(arguments[0]);
            rows[rows.length - 1]?.scrollIntoView({block: 'end'});
        """, PLAYLIST_ROWS)
        updated = _wait_for(browser, lambda d: (items if len(items := _rows(d, PLAYLIST_ROWS)) > len(rows) else None),
                            'VK Музыка не вернула все позиции плейлиста', timeout=8)
        if identities(updated[:len(rows)]) != identities(rows):
            raise ValueError('Порядок плейлиста VK изменился во время чтения')
        rows = updated
    if len(rows) != expected:
        raise ValueError('Число прочитанных позиций расходится со счётчиком VK Музыки')
    return rows


def resolve(url):
    with music_browser('VK Музыки') as browser:
        browser.get(url)
        selector = PLAYLIST_TITLE + ', ' + SINGLE_TITLE
        _wait_for(browser, lambda d: d.execute_script('return document.querySelector(arguments[0]) != null', selector),
                  'По этой ссылке VK Музыка не показывает трек или состав плейлиста')
        href = browser.current_url
        title = browser.execute_script('return document.querySelector(arguments[0])?.textContent.trim()', PLAYLIST_TITLE)
        if title:
            count_value = _wait_for(browser, lambda d: d.execute_script(
                'return document.querySelector(arguments[0])?.textContent.trim()', PLAYLIST_COUNT),
                'VK Музыка не показала число позиций')
            count = re.sub(r'[\s,.]', '', count_value)
            if not count.isdecimal() or not 0 < int(count) <= MAX_POSITIONS:
                raise ValueError('Не удалось подтвердить размер плейлиста VK')
            rows = _load_playlist(browser, int(count))
            album = browser.execute_script("""
                return Array.from(document.querySelectorAll('script[type="application/ld+json"]')).some(script => {
                    try { return JSON.parse(script.textContent)['@type'] === 'MusicAlbum'; }
                    catch { return false; }
                });
            """)
            sources = [{**_source(href, row, title if album else None, i if album else None),
                        'playlist_url': href}
                       for i, row in enumerate(rows, 1)]
            return title, 'album' if album else 'playlist', sources

        id_match = TRACK_ID.fullmatch(urlsplit(href).path)
        if not id_match:
            raise ValueError('Ссылка VK не указывает на конкретную запись')
        row = browser.execute_script("""
            const selectorText = selector => document.querySelector(selector)?.textContent.trim() ?? '';
            return {title: selectorText(arguments[0]),
                    artist: selectorText('[data-testid="MusicAudio_Author"]'),
                    cover_url: document.querySelector('[data-testid="MusicAudio_Cover"] img')?.src};
        """, SINGLE_TITLE)
        row.update(href=href, duration='')
        return row['title'], 'track', [_source(href, row)]


def _content_range(value):
    if match := CONTENT_RANGE.fullmatch(value):
        start, end, total = map(int, match.groups())
        if 0 <= start <= end < total <= MAX_AUDIO_BYTES:
            return start, end, total
    return None


def _cdn_url(url, domain):
    parsed = urlsplit(url)
    return (parsed.scheme == 'https' and not parsed.username and not parsed.password
            and parsed.netloc == parsed.hostname and (parsed.hostname or '').endswith('.' + domain))


def _dash_cdn_url(url):
    return (_cdn_url(url, 'okcdn.ru') or
            (_cdn_url(url, 'vkuser.net') and
             re.fullmatch(r'ok[0-9]+-[0-9]+\.vkuser\.net', urlsplit(url).hostname) is not None))


def _without_range(url):
    parsed = urlsplit(url)
    query = '&'.join(field for field in parsed.query.split('&')
                     if unquote_plus(field.partition('=')[0]) != 'bytes')
    return parsed._replace(query=query, fragment='').geturl()


def _manifest_playback(browser, request_id, url):
    from selenium.common.exceptions import WebDriverException

    try:
        body = browser.execute_cdp_cmd('Network.getResponseBody', {'requestId': request_id})
    except WebDriverException:
        return {}
    data = body['body']
    if len(data) > MAX_MANIFEST_BYTES:
        return {}
    data = base64.b64decode(data) if body['base64Encoded'] else data.encode()
    if not data.startswith((b'<', b'\xef\xbb\xbf')) or b'<!DOCTYPE' in data:
        return {}
    try:
        manifest = ElementTree.fromstring(data)
    except ElementTree.ParseError:
        return {}
    value = manifest.get('mediaPresentationDuration', '')
    match = re.fullmatch(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?', value)
    if not match:
        return {}
    hours, minutes, seconds = (float(item or 0) for item in match.groups())
    duration = hours * 3600 + minutes * 60 + seconds
    if not 0 < duration < 24 * 3600:
        return {}
    streams = {}
    for audio in manifest.findall('./{*}Period/{*}AdaptationSet'):
        if audio.find('{*}ContentProtection') is not None:
            continue
        for representation in audio.findall('{*}Representation'):
            if (representation.get('mimeType', audio.get('mimeType')) != 'audio/mp4'
                    or representation.find('{*}ContentProtection') is not None):
                continue
            resource = representation.findtext('{*}BaseURL')
            if resource and _dash_cdn_url(target := urljoin(url, resource.strip())):
                streams[target] = (url, duration)
    return streams


def _selected_playback(browser, expected_duration):
    manifests, streams, ranges = {}, {}, {}

    def observe(d):
        for entry in d.get_log('performance'):
            message = json.loads(entry['message'])['message']
            event, params = message['method'], message.get('params', {})
            if event == 'Network.loadingFinished':
                if manifest := manifests.pop(params['requestId'], None):
                    streams.update(_manifest_playback(d, params['requestId'], manifest))
                continue
            if event != 'Network.responseReceived':
                continue
            response = params['response']
            url, mime = response['url'], response['mimeType']
            if response['status'] not in {200, 206}:
                continue
            if _cdn_url(url, 'vkuseraudio.ru') and mime.startswith('audio/'):
                return Playback(url)
            if not _dash_cdn_url(url):
                continue
            if mime == 'application/dash+xml':
                manifests[params['requestId']] = url
            elif mime == 'audio/mp4':
                header = next((value for key, value in response['headers'].items()
                               if key.lower() == 'content-range'), '')
                if span := _content_range(header):
                    key = _without_range(url), span[2]
                    ranges.setdefault(key, set()).add(span[:2])

        candidates = {}
        for (url, total), spans in ranges.items():
            if url not in streams:
                continue
            manifest, duration = streams[url]
            if expected_duration and abs(duration - expected_duration) > 1.5:
                continue
            # The player can prefetch just the initialization of other streams.
            starts = {start for start, _ in spans}
            if any(start == 0 and (end == total - 1 or end + 1 in starts) for start, end in spans):
                candidates.setdefault(manifest, Playback(url, total, duration))
        if len(candidates) == 1:
            return next(iter(candidates.values()))
        return None

    return _wait_for(browser, observe, 'VK не выдал полный файл выбранной записи')


def _media(browser, source):
    playlist = source.get('playlist_url')
    browser.get(playlist or source['url'])

    def matching_row(d):
        return d.execute_script(r"""
        return Array.from(document.querySelectorAll('[data-testid="MusicTrackRow"]')).find(row => {
            const href = row.querySelector(arguments[0])?.getAttribute('href') ?? '';
            return href.split('?')[0].match(/^\/audio(-?\d+_\d+)(?:_[a-f0-9]+)?$/i)?.[1] === arguments[1];
        });
        """, TRACK_TITLE, source['provider_id'])

    if playlist:
        _wait_for(browser, lambda d: _rows(d, PLAYLIST_ROWS), 'VK не открыл плейлист')
        browser.execute_script("""document.querySelector('[data-testid="audiolistitems-expandbutton"]')?.click()""")
        deadline = time.monotonic() + 80
        row = matching_row(browser)
        while row is None and time.monotonic() < deadline:
            previous_count = len(_rows(browser, PLAYLIST_ROWS))
            browser.execute_script("""const rows = document.querySelectorAll(arguments[0]);
                rows[rows.length - 1]?.scrollIntoView({block: 'end'});""", PLAYLIST_ROWS)
            _wait_for(browser, lambda d: len(_rows(d, PLAYLIST_ROWS)) > previous_count,
                      'Выбранная запись больше не открывается из плейлиста VK', timeout=7)
            row = matching_row(browser)
        if row is None:
            raise ValueError('Выбранная запись VK недоступна')
        playing = browser.execute_script('return arguments[0].querySelector(arguments[1])', row, PLAY)
    else:
        playing = _wait_for(browser, lambda d: d.execute_script(
            'return document.querySelector(arguments[0])', SINGLE_PLAY), 'Выбранная запись VK недоступна')
        match = TRACK_ID.fullmatch(urlsplit(browser.current_url).path)
        if not match or match[1] != source['provider_id']:
            raise ValueError('VK открыл другую запись')
    browser.execute_cdp_cmd('Network.enable', {})
    browser.get_log('performance')
    browser.execute_script('arguments[0].click()', playing)
    return _selected_playback(browser, source.get('duration'))


def _strong_etag(etag):
    return bool(etag and re.fullmatch(r'"[^"]*"', etag))


def _download_bytes(url, directory, expected_sha256=None, *, progress=None):
    from import_sources import digest_file

    part = directory / 'vk-audio.part'
    validator = directory / 'vk-audio.json'
    try:
        saved = json.loads(validator.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        saved = {}
    offset = part.stat().st_size if part.exists() else 0
    resource = urlsplit(url)._replace(query='', fragment='').geturl()
    etag = saved.get('etag')
    known_total = saved.get('total')
    strict = _strong_etag(etag) and saved.get('resource') == resource
    can_resume = (offset > 0 and (strict or expected_sha256)
                  and isinstance(known_total, int) and offset < known_total)
    headers = {'Accept-Encoding': 'identity'}
    if can_resume:
        headers['Range'] = f'bytes={offset}-'
        if strict:
            headers['If-Range'] = etag
    with requests.get(url, headers=headers, stream=True, allow_redirects=False, timeout=(7, 20)) as response:
        length = response.headers.get('Content-Length', '')
        length = int(length) if length.isdecimal() else None
        if response.status_code == 206 and can_resume:
            value = response.headers.get('Content-Range', '')
            expected = f'bytes {offset}-{known_total - 1}/{known_total}'
            if (value != expected or length != known_total - offset
                    or (strict and response.headers.get('ETag') != etag)):
                validator.unlink(missing_ok=True)
                return None
            total, mode = known_total, 'ab'
        elif response.status_code == 200 and length is not None:
            total, mode = length, 'wb'
        elif can_resume:
            validator.unlink(missing_ok=True)
            return None
        else:
            raise ValueError('VK не выдал полный файл с проверяемым размером')
        if not 0 < total <= MAX_AUDIO_BYTES:
            raise ValueError('Недопустимый размер файла VK')
        with part.open(mode) as fd:
            details = {'resource': resource, 'etag': response.headers.get('ETag'), 'total': total}
            temporary = validator.with_suffix('.tmp')
            temporary.write_text(json.dumps(details))
            temporary.replace(validator)
            size = offset if mode == 'ab' else 0
            for chunk in response.iter_content(131072):
                size += len(chunk)
                if size > total:
                    raise ValueError('VK выдал больше байтов, чем объявил')
                fd.write(chunk)
                if progress:
                    progress('download', size * 100 // total)
        if size != total or part.stat().st_size != total:
            raise OSError('Неполный ответ VK')
        if mode == 'ab' and expected_sha256 and digest_file(part) != expected_sha256:
            validator.unlink(missing_ok=True)
            return None
    return part


def _download_mp4(playback, directory, *, progress=None):
    total = playback.size
    headers = {'Accept-Encoding': 'identity', 'Range': f'bytes=0-{total - 1}'}
    path = directory / 'vk-fragmented.mp4'
    with requests.get(playback.url, headers=headers, stream=True, allow_redirects=False,
                      timeout=(7, 20)) as response:
        if response.status_code in {403, 404, 410}:
            raise ExpiredMedia('Истёк адрес аудиофайла VK')
        response.raise_for_status()
        length = response.headers.get('Content-Length')
        span = response.headers.get('Content-Range')
        if (response.status_code not in {200, 206}
                or (length is not None and length != str(total))
                or (span is not None and _content_range(span) != (0, total - 1, total))
                or (span is None and (response.status_code == 206 or length is None))
                or response.headers.get('Content-Encoding', 'identity').lower() != 'identity'):
            raise ValueError('VK не выдал полный диапазон выбранной записи')
        deadline = time.monotonic() + 65
        size = 0
        with path.open('wb') as audio:
            for chunk in response.iter_content(131072):
                if time.monotonic() >= deadline:
                    raise requests.Timeout('Истекло время получения аудио VK')
                size += len(chunk)
                if size > total:
                    raise ValueError('VK выдал больше байтов, чем объявил')
                audio.write(chunk)
                if progress:
                    progress('download', size * 100 // total)
        if size != total:
            raise OSError('Неполный ответ VK')
    return path


def download(source, directory, *, progress=None):
    from import_sources import audio_format, digest_file
    from mutagen import File

    evidence = {'provider': 'vk', 'recording': source['provider_id']}
    with music_browser('VK Музыки') as browser:
        for attempt in range(2):
            playback = _media(browser, source)
            if playback.size is None:
                path = (_download_bytes(playback.url, directory, source.get('expected_sha256'), progress=progress)
                        or _download_bytes(playback.url, directory, progress=progress))
                break
            try:
                path = _download_mp4(playback, directory, progress=progress)
                break
            except (ExpiredMedia, requests.ConnectionError, requests.Timeout,
                    requests.exceptions.ChunkedEncodingError):
                if attempt:
                    raise
    if path is None:
        raise ValueError('VK не подтвердил версию файла')
    if progress:
        progress('check')
    try:
        suffix = audio_format(path)
    except ValueError:
        if playback.size is None:
            raise
        remuxed = directory / 'vk-remuxed.m4a'
        subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-nostdin', '-y', '-i', str(path),
                        '-map', '0:a:0', '-c:a', 'copy', str(remuxed)],
                       check=True, capture_output=True, timeout=35)
        suffix = audio_format(remuxed)
        evidence.update(provider_sha256=digest_file(path), container='remuxed-m4a')
        path.unlink()
        path = remuxed
    duration = float(File(path).info.length)
    for expected in (source.get('duration'), playback.duration):
        if expected and abs(duration - expected) > 1.5:
            raise ValueError('Длительность ответа VK отличается от выбранной записи')
    subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-nostdin', '-i', str(path),
                    '-map', '0:a:0', '-f', 'null', '-'], check=True, capture_output=True, timeout=60)
    target = directory / ('vk-audio' + suffix)
    path.replace(target)
    return {'path': str(target), 'sha256': digest_file(target), 'title': source['title'],
            'artist': source['artist'], 'evidence': evidence}
