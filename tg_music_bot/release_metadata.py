"""Find a documented release whose complete track list matches a VK collection."""
import re
import time
from uuid import UUID

import requests

from source_selection import duration_matches, normalized


MUSICBRAINZ_URL = 'https://musicbrainz.org/ws/2/release'
HEADERS = {'User-Agent': 'PuukMusic/1.0 (+https://web.puuk.fun)'}


def vk_release_request(collection_title, rows):
    if not 3 <= len(rows) <= 100 or any(row.get('type') != 'vk' for row in rows):
        return None
    artist = rows[0].get('artist')
    if not artist or any(normalized(row.get('artist')) != normalized(artist) for row in rows):
        return None
    named_album = rows[0].get('album')
    if named_album and all(normalized(row.get('album')) == normalized(named_album) for row in rows):
        title = named_album
    else:
        parts = re.split(r'\s+[-–—]\s+', collection_title, maxsplit=1)
        if len(parts) != 2:
            return None
        title = re.sub(r'(?:,\s*|\s*\()\d{4}\)?\s*$', '', parts[1]).strip()
    if not title or any(not row.get('title') or not row.get('duration') for row in rows):
        return None
    return {'album': title, 'artist': artist,
            'tracks': [{key: row[key] for key in ('position', 'title', 'duration')} for row in rows]}


def _title(value):
    # VK may append an English gloss to a Japanese instrumental annotation.
    match = re.search(r'[\[［](?P<local>[^\]］–—]+)[–—]\s*TV Instrumental Version (?P<part>\d+)\s*[–—]?[\]］]$',
                      value, flags=re.IGNORECASE)
    if match:
        part = re.search(r'インスト\s*(\d+)\s*$', match['local'])
        if part and part[1] == match['part']:
            value = value[:match.start()] + match['local']
    return normalized(re.sub(r'インスト\s*(\d+)', lambda count: f'インスト {count[1]}', value))


def _credits_match(credits, artist):
    return any(normalized(artist) in {
        normalized(item.get('name')),
        normalized((item.get('artist') or {}).get('name')),
        normalized((item.get('artist') or {}).get('sort-name')),
    } for item in credits)


def match_release(request, release):
    if (normalized(release.get('title')) != normalized(request['album'])
            or release.get('status') != 'Official'
            or not _credits_match(release.get('artist-credit', []), request['artist'])
            or not (release.get('cover-art-archive') or {}).get('front')):
        return {}
    edition_tracks = [(medium, item) for medium in release.get('media', []) for item in medium.get('tracks', [])]
    if len(request['tracks']) != len(edition_tracks):
        return {}
    cover_url = f"https://coverartarchive.org/release/{UUID(release['id'])}/front-500"
    year = (release.get('date') or '')[:4]
    used = set()
    mapping = {}
    for row in request['tracks']:
        matches = []
        for medium, item in edition_tracks:
            length = item.get('length') or (item.get('recording') or {}).get('length')
            if (isinstance(length, (int, float)) and _title(item['title']) == _title(row['title'])
                    and duration_matches(row['duration'], length / 1000)):
                matches.append((medium, item))
        if len(matches) != 1:
            return {}
        medium, item = matches[0]
        key = medium['position'], item['position']
        if key in used:
            return {}
        used.add(key)
        mapping[str(row['position'])] = {
            'title': item['title'], 'artist': request['artist'], 'album': release['title'],
            'album_artist': request['artist'], 'year': year, 'disc_number': str(medium['position']),
            'track_number': str(item['position']), 'cover_url': cover_url, 'source': 'MusicBrainz',
        }
    return mapping


def find_vk_release(request):
    """Return per-position metadata only for a unique, fully matched release."""
    album = re.sub(r'([\\"])', r'\\\1', request['album'])
    artist = re.sub(r'([\\"])', r'\\\1', request['artist'])
    query = f'release:"{album}" AND artist:"{artist}" AND tracks:{len(request["tracks"])}'
    params = {'query': query, 'fmt': 'json', 'limit': 8}
    listing = requests.get(MUSICBRAINZ_URL, params=params, headers=HEADERS, timeout=6)
    if listing.status_code in {429, 503}:
        time.sleep(2)
        listing = requests.get(MUSICBRAINZ_URL, params=params, headers=HEADERS, timeout=6)
    listing.raise_for_status()
    results = listing.json()
    if results.get('count', 0) > params['limit']:
        return {}
    likely = [item for item in results.get('releases', [])
              if normalized(item.get('title')) == normalized(request['album'])
              and item.get('track-count') == len(request['tracks'])
              and _credits_match(item.get('artist-credit', []), request['artist'])]
    if len(likely) > 3:
        return {}
    result = {}
    for item in likely:
        time.sleep(1.1)
        release_id = UUID(item['id'])
        response = requests.get(f'{MUSICBRAINZ_URL}/{release_id}',
                                params={'inc': 'recordings+artist-credits', 'fmt': 'json'},
                                headers=HEADERS, timeout=6)
        response.raise_for_status()
        matched = match_release(request, response.json())
        if matched:
            if result:
                return {}
            result = matched
    return result
