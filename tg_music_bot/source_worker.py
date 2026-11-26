"""One isolated Spotify recording download. Parent owns deadline and process group.

Spotify metadata identifies the requested recording. Search SoundCloud, YouTube Music and finally the
public VK artist catalog. VK recordings must match the Spotify excerpt. JSON result is written
atomically after the downloaded bytes pass the duration check.
"""
import argparse
from dataclasses import asdict, replace
import json
import logging
from pathlib import Path
import re

from source_selection import (
    Candidate, POLICY_VERSION, assess, credited_title, normalized, duration_matches, rank_candidates, version_rejection,
    without_remaster,
)

RECEIPT_TAG = 'PUUK_SOURCE_V1'
DOWNLOAD_UNAVAILABLE = 'не удалось получить проверенный файл'


def candidates_from_results(results):
    candidates = []
    for row in results:
        if not isinstance(row, dict) or row.get('resultType') != 'song' or row.get('isAvailable') is False:
            continue
        duration = row.get('duration_seconds')
        if duration is None:
            try:
                parts = [int(x) for x in str(row.get('duration', '')).split(':')]
                duration = sum(x * 60 ** i for i, x in enumerate(reversed(parts)))
            except ValueError:
                duration = 0
        candidates.append(Candidate(
            video_id=row.get('videoId') or '', title=row.get('title') or '',
            artists=tuple(a['name'] for a in (row.get('artists') or []) if a.get('name')),
            duration=duration, album=(row.get('album') or {}).get('name', ''),
            explicit=row.get('isExplicit') if isinstance(row.get('isExplicit'), bool) else None,
        ))
    return candidates


def find_candidates(song, client, alternatives=None):
    # ISRC is a search hint, not proof of identity. Every result passes the same
    # title / artist / version / explicit / duration checks.
    queries = []
    if song.get('isrc'):
        queries.append(song['isrc'])
    title = credited_title(song['name'], song['artists'])
    queries.append(' '.join([*song['artists'], title]))
    base_title = without_remaster(title)
    if base_title != title:
        queries.append(' '.join([*song['artists'], base_title, song.get('album_name') or '']).strip())
    candidates, errors = [], []
    for query in queries:
        if base_title != title and query == queries[-1] and rank_candidates(song, candidates)[0]:
            break
        try:
            rows = client.search(query, filter='songs', limit=20, ignore_spelling=True)
            candidates.extend(candidates_from_results(rows[:40]))
        except Exception as exc:
            logging.warning('Catalog search failed: %s', type(exc).__name__)
            errors.append('Каталог YouTube Music недоступен')
    ranked, reasons = rank_candidates(song, candidates)
    if alternatives is not None:
        alternatives.extend(candidate for candidate in candidates
                            if without_remaster(candidate.title) != candidate.title
                            and not assess(song, replace(candidate, title=without_remaster(candidate.title)))[1])
    if not ranked:
        expected_artists = {normalized(a) for a in song['artists']}
        expected_title = normalized(credited_title(song['name'], song['artists']))
        relevant = [c for c in candidates if expected_artists <= {normalized(a) for a in c.artists}
                    and normalized(credited_title(c.title, song['artists'])) == expected_title]
        if not relevant and candidates:
            reasons = ['Доступная запись нужного трека и исполнителей не найдена в YouTube Music']
    return ranked[:3], reasons or errors


def soundcloud_candidate(row, song):
    """Credits come from publisher metadata, never a guessed uploader name."""
    artists = row.get('artists') or ([row['artist']] if row.get('artist') else [])
    publisher_artist = row.get('publisher_artist') or ''
    if publisher_artist:
        artists = [publisher_artist]
        # Some publishers deliver all credits as one string. Resolve it only
        # against the exact known Spotify credits, preserving names with commas.
        joined = re.sub(r'\b(?:feat|ft|with)\b', ' ', normalized(publisher_artist))
        if ' '.join(joined.split()) == normalized(' '.join(song['artists'])):
            artists = song['artists']
    return Candidate(
        str(row.get('id') or ''), row.get('track') or row.get('title') or '',
        tuple(artists), row.get('duration') or 0,
        row.get('publisher_album') or row.get('album') or '',
        row.get('explicit') if isinstance(row.get('explicit'), bool) else None,
        'soundcloud', row.get('webpage_url') or '',
        bool(publisher_artist and normalized(row.get('verified_uploader')).replace(' ', '')
             == normalized(publisher_artist).replace(' ', '')),
    )


def find_soundcloud_candidates(song):
    """Search metadata first; only checked recordings proceed to format loading."""
    import yt_dlp
    from soundcloud_source import register
    options = {'quiet': True, 'no_warnings': True, 'skip_download': True,
               'extract_flat': True, 'ignoreerrors': True,
               'socket_timeout': 10, 'retries': 1, 'extractor_retries': 1,
               'playlistend': 10}
    title = credited_title(song['name'], song['artists'])
    queries = [' '.join([*song['artists'], title])]
    if len(song['artists']) > 1 and song.get('require_audio_match'):
        queries.append(f"{song['artists'][0]} {title}")
    with yt_dlp.YoutubeDL(options) as ydl:
        register(ydl)
        candidates = []
        for query in queries:
            result = ydl.extract_info('scsearch10:' + query, download=False)
            candidates.extend(soundcloud_candidate(row, song) for row in (result or {}).get('entries', []) if row)
            ranked, reasons = rank_candidates(song, candidates)
            if ranked:
                return ranked, reasons
    return [], reasons


def source_rejection(song, info):
    if not isinstance(info, dict) or info.get('entries') is not None:
        return 'Источник не является одиночной записью'
    if info.get('is_live') or info.get('was_live') or info.get('live_status') in {'is_live', 'is_upcoming', 'post_live', 'was_live'}:
        return 'Источник является трансляцией / записью эфира'
    reason = version_rejection(song['name'], info.get('title') or '')
    if reason:
        return reason
    if not duration_matches(song['duration'], info.get('duration')):
        return 'Длительность аудио не совпадает с исходным треком'
    return None


def _download_ytdlp(song, candidate, directory, basename, progress):
    import yt_dlp
    options = {
        'format': 'bestaudio/best', 'outtmpl': str(directory / (basename + '.%(ext)s')),
        'noplaylist': True, 'quiet': True, 'no_warnings': True, 'noprogress': True,
        'socket_timeout': 15, 'retries': 2, 'fragment_retries': 2,
        'extractor_retries': 1, 'js_runtimes': {'node': {}},
        'postprocessors': [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '0'}],
    }

    def check(info, *, incomplete=False):
        if incomplete:
            return None
        if str(info.get('id')) != candidate.video_id:
            return 'Источник изменился'
        if candidate.provider == 'soundcloud':
            reason = assess(song, soundcloud_candidate(info, song))[1]
            if reason:
                return reason
        return source_rejection(song, info)

    options['match_filter'] = check
    if progress:
        from import_progress import ytdlp_progress

        options['progress_hooks'] = [ytdlp_progress(progress)]
    with yt_dlp.YoutubeDL(options) as ydl:
        if candidate.provider == 'soundcloud':
            from soundcloud_source import register
            register(ydl)
        info = ydl.extract_info(candidate.url, download=False)
        reason = check(info or {})
        if reason:
            raise ValueError(reason)
        # process_ie_result uses the metadata just checked; the match_filter is
        # also retained for redirects/extractor processing during the download.
        ydl.process_ie_result(info, download=True)


def download_candidate(song, candidate, directory, *, progress=None):
    from mutagen.id3 import ID3, TXXX, WOAS
    from downloader import _finalize_track

    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    spotify_id = str(song.get('song_id') or song.get('url', '').split('?')[0].rstrip('/').rsplit('/', 1)[-1])
    if not re.fullmatch(r'[A-Za-z0-9]+', spotify_id):
        raise ValueError('Некорректный Spotify ID')
    basename = f'{spotify_id}-{candidate.provider}-{candidate.video_id}'
    path = directory / (basename + '.mp3')
    reference = song.get('reference_audio')
    if candidate.provider == 'vk':
        import subprocess
        from tempfile import TemporaryDirectory
        from audio_match import fetch_spotify_preview
        from vk_music import download

        if not reference:
            reference = directory / 'spotify-reference.mp3'
            fetch_spotify_preview(song.get('preview_url') or '', reference)
        source = {'provider_id': candidate.video_id, 'url': candidate.url, 'title': candidate.title,
                  'artist': ', '.join(candidate.artists), 'duration': candidate.duration}
        with TemporaryDirectory(dir=directory) as tmp:
            artifact = download(source, Path(tmp), progress=progress)
            audio = Path(artifact['path'])
            if audio.suffix == '.mp3':
                audio.replace(path)
            else:
                subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(audio),
                                '-map', '0:a:0', '-c:a', 'libmp3lame', '-q:a', '0', str(path)],
                               check=True, capture_output=True, timeout=60)
    else:
        _download_ytdlp(song, candidate, directory, basename, progress)
    if not path.is_file():
        raise ValueError('Аудиофайл не получен')
    metadata = _finalize_track(str(path), song=song)
    if not duration_matches(song['duration'], metadata.get('duration')):
        path.unlink()
        raise ValueError('Длительность полученного файла не совпадает с оригиналом')
    if not metadata.get('verification'):
        path.unlink()
        raise ValueError('Не удалось проверить метаданные аудиофайла')
    receipt = {
        'policy': POLICY_VERSION, 'spotify_url': song['url'].split('?')[0],
        'candidate': asdict(candidate),
    }
    if song.get('require_audio_match') or candidate.provider == 'vk':
        from audio_match import matches_excerpt

        if not matches_excerpt(Path(reference), path, song['duration']):
            raise ValueError('Звук отличается от фрагмента Spotify')
        receipt['audio_match'] = 'spotify-preview-original-speed'
    tags = ID3(path)
    tags.add(WOAS(url=receipt['spotify_url']))
    tags.add(TXXX(encoding=3, desc=RECEIPT_TAG, text=json.dumps(receipt, ensure_ascii=False)))
    tags.save(path)
    return {**metadata, 'filepath': str(path), 'verified_metadata': metadata, 'source': receipt}


def _download_failure(exc):
    message = str(exc)
    details = message.casefold()
    if 'drm protected' in details:
        return 'запись защищена DRM'
    if 'not made this video available in your country' in details:
        return 'запись недоступна в регионе сервера'
    if 'video unavailable' in details:
        return 'запись недоступна'
    return message[:90] if isinstance(exc, ValueError) and message else DOWNLOAD_UNAVAILABLE


def download_song(song, directory, *, client=None, download=None, primary=None, progress=None):
    if song.get('require_audio_match'):
        from audio_match import fetch_spotify_preview

        if not song.get('preview_url'):
            return {'error': 'Spotify не предоставил фрагмент для проверки звука'}
        reference = Path(directory) / 'spotify-reference.mp3'
        reference.parent.mkdir(parents=True, exist_ok=True)
        try:
            fetch_spotify_preview(song['preview_url'], reference)
        except (OSError, ValueError) as exc:
            return {'error': 'Не удалось получить фрагмент Spotify для проверки звука',
                    'temporary': isinstance(exc, OSError)}
        song = {**song, 'reference_audio': str(reference)}
    if download is None:
        from functools import partial

        download = partial(download_candidate, progress=progress) if progress else download_candidate
    reports, alternatives = [], []
    providers = ['SoundCloud', 'YouTube Music']
    if song.get('preview_url'):
        providers.append('VK Музыка')
    for provider in providers:
        if progress:
            progress('search')
        failures = []
        try:
            if provider == 'SoundCloud':
                candidates, provider_reasons = (primary or find_soundcloud_candidates)(song)
            elif provider == 'YouTube Music':
                if client is None:
                    from ytmusicapi import YTMusic
                    client = YTMusic()
                candidates, provider_reasons = find_candidates(song, client, alternatives)
                if hint := song.get('release_candidate'):
                    release = Candidate(**hint)
                    candidates = [release, *(candidate for candidate in candidates if candidate.video_id != release.video_id)]
            else:
                from vk_music import find_spotify_candidates

                candidates, provider_reasons = find_spotify_candidates(song)
        except Exception as exc:
            logging.warning('%s unavailable: %s', provider, type(exc).__name__)
            reports.append(f'{provider}: каталог недоступен')
            continue
        if provider_reasons:
            logging.info('%s candidate filters: %s', provider, '; '.join(provider_reasons))
        for candidate in candidates[:3]:
            if assess(song, candidate)[1]:
                continue
            try:
                return {'track': download(song, candidate, directory)}
            except Exception as exc:
                logging.warning('Rejected/failed audio %s/%s: %s', candidate.provider, candidate.video_id, exc)
                for partial in Path(directory).glob(f'*-{candidate.provider}-{candidate.video_id}.*'):
                    if partial.is_file():
                        partial.unlink()
                failures.append(_download_failure(exc))
                if progress:
                    progress('search')
        if failures:
            reason = next((failure for failure in failures if failure != DOWNLOAD_UNAVAILABLE),
                          DOWNLOAD_UNAVAILABLE)
        elif f'Каталог {provider} недоступен' in provider_reasons:
            reason = 'каталог недоступен'
        else:
            reason = 'нужная версия не найдена'
        reports.append(f'{provider}: {reason}')
    result = {'error': '; '.join(reports)}
    if alternatives and without_remaster(song['name']) == song['name']:
        candidate = alternatives[0]
        years = re.findall(r'\b(?:19|20)\d{2}\b', candidate.title)
        result['alternative'] = {
            'type': 'direct', 'key': f'{candidate.provider}:{candidate.video_id}',
            'provider_id': candidate.video_id, 'url': candidate.url, 'title': candidate.title,
            'album': candidate.album, 'version_label': candidate.title, 'year': years[0] if years else None,
        }
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--song', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--result', required=True)
    args = parser.parse_args()
    song = json.loads(Path(args.song).read_text())
    result = download_song(song, args.output)
    destination = Path(args.result)
    temporary = destination.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, ensure_ascii=False))
    temporary.replace(destination)


if __name__ == '__main__':
    main()
