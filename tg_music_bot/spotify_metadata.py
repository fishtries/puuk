"""Bounded Spotify embed metadata for albums; no audio URLs or guessed credits."""
from concurrent.futures import ThreadPoolExecutor
import argparse
import json
from pathlib import Path
import re
from urllib.parse import urlparse

import requests


def fetch_entity(kind, ident):
    with requests.get(f'https://open.spotify.com/embed/{kind}/{ident}', timeout=(5, 12)) as response:
        response.raise_for_status()
        if len(response.content) > 8 * 1024 * 1024:
            raise ValueError('Слишком большой ответ Spotify')
        match = re.search(r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>', response.text, re.S)
        if not match:
            raise ValueError('Spotify изменил формат списка альбома')
        entity = json.loads(match.group(1))['props']['pageProps']['state']['data']['entity']
    if entity.get('type') != kind or entity.get('id') != ident:
        raise ValueError('Spotify вернул другой объект')
    return entity


def album_songs(url, fetch=fetch_entity, progress=None):
    path = urlparse(url).path.rstrip('/').split('/')
    ident = path[-1]
    if path[-2] != 'album' or not re.fullmatch(r'[A-Za-z0-9]{22}', ident):
        raise ValueError('Некорректная ссылка альбома Spotify')
    album = fetch('album', ident)
    rows = album.get('trackList') or []
    # Embed has no pagination contract. Refuse the boundary where a truncated
    # list could otherwise silently masquerade as a complete large album.
    if not rows or len(rows) >= 100:
        raise ValueError('Spotify не вернул полный список небольшого альбома')
    ids = []
    for row in rows:
        match = re.fullmatch(r'spotify:track:([A-Za-z0-9]{22})', row.get('uri', ''))
        if not match:
            raise ValueError('В альбоме есть недоступная позиция Spotify')
        ids.append(match.group(1))
    if progress:
        progress(f'Получен список: {len(ids)} треков. Проверяю метаданные...')
    images = (album.get('visualIdentity') or {}).get('image') or []
    cover = max(images, key=lambda x: x.get('maxWidth', 0), default={}).get('url')
    songs = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for index, track in enumerate(pool.map(lambda key: fetch('track', key), ids)):
            artists = [a.get('name') for a in track.get('artists', [])]
            duration = track.get('duration')
            if (not artists or not all(isinstance(a, str) and a.strip() for a in artists)
                    or not isinstance(duration, (int, float)) or duration <= 0
                    or not isinstance(track.get('isExplicit'), bool) or not track.get('title')):
                raise ValueError('Не удалось проверить исполнителей/длительность/explicit в Spotify')
            if track.get('uri') != rows[index]['uri']:
                raise ValueError('Изменилась идентичность трека Spotify')
            songs.append({
                'name': track['title'], 'artists': artists, 'artist': artists[0],
                'duration': duration / 1000, 'explicit': track['isExplicit'],
                'url': 'https://open.spotify.com/track/' + ids[index], 'song_id': ids[index],
                'album_name': album['title'], 'album_artist': album.get('subtitle') or '',
                'track_number': index + 1, 'tracks_count': len(ids),
                'cover_url': cover, 'date': (track.get('releaseDate') or {}).get('isoString', '')[:10],
            })
            if progress:
                progress(f'Проверены метаданные {index + 1}/{len(ids)}: {track["title"]}')
    return songs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('url')
    parser.add_argument('--output', required=True)
    parser.add_argument('--progress', required=True)
    args = parser.parse_args()
    def progress(message):
        path = Path(args.progress)
        temporary = path.with_suffix('.tmp')
        temporary.write_text(message)
        temporary.replace(path)
    songs = album_songs(args.url, progress=progress)
    Path(args.output).write_text(json.dumps(songs, ensure_ascii=False))


if __name__ == '__main__':
    main()
