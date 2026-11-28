"""Find and audition plausible recordings for an explicit import repair."""
from dataclasses import replace
import logging
import re

from source_selection import assess, credited_title, normalized, versions
from source_worker import find_candidates, find_soundcloud_candidates


logger = logging.getLogger(__name__)
PROVIDER_NAMES = {'soundcloud': 'SoundCloud', 'youtube': 'YouTube Music', 'vk': 'VK Музыка'}
PREVIEW_SECONDS = 20


def find_recovery_candidates(source, alternative=None):
    song = source.get('song') or {
        'name': source.get('music_title') or source.get('title'),
        'artists': source.get('artists') or ([source['artist']] if source.get('artist') else []),
        'duration': source.get('duration'),
        'album_name': source.get('album'),
    }
    found = []
    failures = 0
    if song.get('name') and song.get('artists'):
        try:
            find_soundcloud_candidates(song, observed=found)
        except Exception as exc:
            logger.info('Recovery SoundCloud search: %s', type(exc).__name__)
            failures += 1
        try:
            from ytmusicapi import YTMusic

            _, reasons = find_candidates(song, YTMusic(), observed=found)
            failures += 'Каталог YouTube Music недоступен' in reasons
        except Exception as exc:
            logger.info('Recovery YouTube Music search: %s', type(exc).__name__)
            failures += 1

    ranked = {}
    for candidate in found:
        if candidate.url == source.get('url') or f'{candidate.provider}:{candidate.video_id}' == source.get('key'):
            continue
        duration_known = bool(song.get('duration'))
        expected = song if duration_known else {**song, 'duration': candidate.duration}
        score, reason = assess(expected, candidate)
        if reason:
            # Only a clearly labeled version of the same recording is eligible
            # for manual selection. Other artist/title/duration gates still apply.
            title = credited_title(candidate.title, song['artists'])
            base = re.split(r'\s*\(|\s*\[|\s+[-–—]\s+', title, maxsplit=1)[0]
            if normalized(base) != normalized(credited_title(song['name'], song['artists'])):
                continue
            if not (versions(title) - versions(base)):
                continue
            score, reason = assess(expected, replace(candidate, title=base))
            if reason:
                continue
            description = 'Другая версия'
            score -= .5
        else:
            description = ('Подходит по названию, исполнителю и длительности' if duration_known else
                           'Совпадают название и исполнитель')
        key = f'{candidate.provider}:{candidate.video_id}'
        entry = {
            'key': key, 'url': candidate.url, 'provider': candidate.provider, 'provider_id': candidate.video_id,
            'title': candidate.title, 'artist': ', '.join(candidate.artists), 'duration': candidate.duration,
            'description': description,
        }
        if key not in ranked or score > ranked[key][0]:
            ranked[key] = (score, entry)

    if alternative and alternative['key'] not in ranked:
        key = alternative['key']
        ranked[key] = (0, {'artist': '', **alternative, 'description': 'Ремастер', 'provider': key.split(':', 1)[0]})
    options = sorted(ranked.values(), key=lambda item: (-item[0], item[1]['key']))
    return {'options': [entry for _, entry in options[:3]], 'unavailable': failures == 2}


def download_recovery_preview(candidate, directory):
    """Download a short segment of the displayed candidate without importing it."""
    from import_sources import _ydl_options, canonical_link

    import yt_dlp
    from mutagen.mp3 import MP3
    from yt_dlp.utils import download_range_func

    provider = candidate['provider']
    if provider not in {'soundcloud', 'youtube'}:
        return None
    url = canonical_link(candidate['url'])
    if not url.startswith({'soundcloud': 'https://soundcloud.com/', 'youtube': 'https://www.youtube.com/watch?'}[provider]):
        return None

    def check(info, *, incomplete=False):
        if not incomplete and (str(info.get('id')) != candidate['provider_id']
                               or info.get('live_status') not in {None, 'not_live', 'was_live'}):
            return 'Площадка вернула другую запись'
        return None

    options = _ydl_options(
        format='bestaudio', noplaylist=True, match_filter=check,
        outtmpl=str(directory / 'preview.%(ext)s'), max_filesize=8 * 1024 * 1024,
        download_ranges=download_range_func(None, [(0, PREVIEW_SECONDS)]),
        postprocessors=[{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '96'}],
    )
    with yt_dlp.YoutubeDL(options) as downloader:
        if provider == 'soundcloud':
            from soundcloud_source import register
            register(downloader)
        info = downloader.extract_info(url, download=True)
    path = directory / 'preview.mp3'
    if info and not check(info) and path.is_file() and 0 < MP3(path).info.length <= PREVIEW_SECONDS + 2:
        return str(path)
    return None
