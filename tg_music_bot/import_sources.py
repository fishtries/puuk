"""Resolve incoming messages to immutable, ordered recording selections."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
import hashlib
from pathlib import Path
import re
import shutil
import stat
import time
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit
from zipfile import ZipFile

from spotify_metadata import album_songs, cover_url, fetch_entity, preview_url


MAX_POSITIONS = 1000
MAX_FILE_BYTES = 2000 * 1024 * 1024
AUDIO_SUFFIXES = {'.mp3', '.flac', '.m4a'}


class RecordingUnavailable(ValueError):
    def __init__(self, message, alternative=None, temporary=False):
        super().__init__(message)
        self.alternative = alternative
        self.temporary = temporary


def canonical_link(link):
    try:
        parsed = urlsplit(link.strip())
        host = (parsed.hostname or '').lower()
        if (parsed.scheme not in {'http', 'https'} or parsed.username or parsed.password
                or parsed.port is not None or len(link) > 2048):
            raise ValueError
    except ValueError:
        raise ValueError('Пришлите обычную ссылку на музыкальную площадку') from None

    query = parse_qs(parsed.query)
    path = parsed.path.rstrip('/')
    if host in {'youtu.be', 'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'}:
        video = path.lstrip('/') if host == 'youtu.be' else query.get('v', [''])[0]
        if not video and path.startswith(('/shorts/', '/live/')):
            video = path.split('/')[-1]
        if re.fullmatch(r'[A-Za-z0-9_-]{11}', video):
            return 'https://www.youtube.com/watch?' + urlencode({'v': video})
        if path == '/playlist' and re.fullmatch(r'[A-Za-z0-9_-]+', query.get('list', [''])[0]):
            return 'https://www.youtube.com/playlist?' + urlencode({'list': query['list'][0]})
    if host == 'open.spotify.com':
        match = re.fullmatch(r'/(?:intl-[a-z-]+/|embed/)?(track|album|playlist)/([A-Za-z0-9]{22})', path)
        if match:
            return 'https://open.spotify.com/' + '/'.join(match.groups())
    if host in {'soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com'} and path:
        return urlunsplit(('https', host, path, '', ''))
    if host in {'vk.com', 'm.vk.com', 'vk.ru', 'vk.cc', 'music.vk.com', 'vk.link'} and path:
        legacy_playlist = re.fullmatch(r'/audio_playlist(-?\d+_\d+(?:_[0-9a-fA-F]+)?)', path)
        if legacy_playlist and host in {'vk.com', 'm.vk.com', 'vk.ru'}:
            path = '/music/playlist/' + legacy_playlist[1]
            if host == 'm.vk.com':
                host = 'vk.com'
        return urlunsplit(('https', host, path, parsed.query, ''))
    raise ValueError('Пришлите ссылку на трек, альбом или плейлист YouTube, SoundCloud, Spotify или VK Музыки')


def _spotify_song(track, row):
    names = [a.get('name') for a in track.get('artists', [])]
    duration = track.get('duration')
    if (track.get('uri') != row.get('uri') or not names or not all(names)
            or not isinstance(duration, (int, float)) or duration <= 0 or not track.get('title')):
        raise ValueError('Spotify не вернул данные записи')
    song_id = track['id']
    return {'name': track['title'], 'artists': names, 'artist': names[0],
            'duration': duration / 1000, 'explicit': track.get('isExplicit'),
            'song_id': song_id, 'url': f'https://open.spotify.com/track/{song_id}',
            'preview_url': preview_url(row, track), 'cover_url': cover_url(track)}


def _spotify(url):
    kind, ident = urlsplit(url).path.split('/')[-2:]
    if kind == 'album':
        songs = album_songs(url)
        title = songs[0]['album_name']
        _add_release_hints(songs)
    else:
        entity = fetch_entity(kind, ident)
        title = entity['title']
        if kind == 'track':
            songs = [_spotify_song(entity, entity)]
        else:
            rows = entity.get('trackList') or []
            if not rows or len(rows) >= 100:
                raise ValueError('По этой ссылке мне недоступен полный список треков Spotify')
            ids = [re.fullmatch(r'spotify:track:([A-Za-z0-9]{22})', row.get('uri', '')) for row in rows]
            if not all(ids):
                raise ValueError('Spotify вернул позицию без доступного музыкального трека')
            attributes = {a.get('key'): a.get('value') for a in entity.get('attributes') or []}
            if attributes.get('uri') == f'spotify:user:spotify:playlist:{ident}':
                kind = 'catalog'
            with ThreadPoolExecutor(max_workers=4) as pool:
                tracks = pool.map(lambda match: fetch_entity('track', match[1]), ids)
                songs = [{**_spotify_song(track, row), 'occurrence': row.get('uid')}
                         for row, track in zip(rows, tracks)]
    sources = []
    for song in songs:
        key = f"spotify:track:{song['song_id']}"
        if kind == 'album':
            key = f"spotify:album:{ident}:{song['track_number']}:{song['song_id']}"
        sources.append({'type': 'spotify', 'key': key, 'title': song['name'], 'song': song,
                        'occurrence': song.get('occurrence')})
    return title, kind, sources


def _add_release_hints(songs):
    import logging
    import requests
    from ytmusicapi import YTMusic
    from source_selection import normalized, rank_candidates
    from source_worker import candidates_from_results

    class BoundedSession(requests.Session):
        def request(self, method, url, **kwargs):
            kwargs.setdefault('timeout', (5, 8))
            return super().request(method, url, **kwargs)

    title, artist = songs[0]['album_name'], songs[0]['album_artist']
    if not artist:
        return
    try:
        with BoundedSession() as session:
            client = YTMusic(requests_session=session)
            results = client.search(f'{artist} {title}', filter='albums', limit=5, ignore_spelling=True)
            matching = [result for result in results if normalized(result.get('title')) == normalized(title)
                        and normalized(artist) in {normalized(a.get('name')) for a in result.get('artists') or []}]
            if len(matching) != 1:
                return
            album = client.get_album(matching[0]['browseId'])
    except Exception as exc:
        logging.info('Release lookup unavailable: %s', type(exc).__name__)
        return
    rows = album.get('tracks') or []
    if len(rows) != len(songs):
        return
    for song, row in zip(songs, rows):
        candidates = candidates_from_results([{**row, 'resultType': 'song', 'album': {'name': title}}])
        accepted, _ = rank_candidates(song, candidates)
        if accepted:
            song['release_candidate'] = asdict(accepted[0])


def _ydl_options(**options):
    return {'quiet': True, 'no_warnings': True, 'noprogress': True, 'socket_timeout': 12, 'retries': 1,
            'fragment_retries': 1, 'extractor_retries': 1, 'js_runtimes': {'node': {}},
            **options}


def _direct(url):
    import yt_dlp

    youtube = urlsplit(url).hostname == 'www.youtube.com'
    with yt_dlp.YoutubeDL(_ydl_options(skip_download=True, extract_flat='in_playlist',
                                      playlistend=MAX_POSITIONS + 1,
                                      noplaylist=not urlsplit(url).path.endswith('/playlist'))) as client:
        info = client.extract_info(url, download=False)
    if not info:
        raise ValueError('Площадка не вернула данные ссылки')
    entries = info.get('entries')
    kind = 'track'
    if entries is not None:
        kind = 'album' if info.get('album_type') in {'album', 'ep', 'single', 'compilation'} else 'playlist'
        entries = list(entries)
        count = info.get('playlist_count')
        if (not entries or len(entries) > MAX_POSITIONS or
                (isinstance(count, int) and count != len(entries))):
            raise ValueError('Площадка не вернула полный список треков')
    else:
        entries = [info]
    sources = []
    for item in entries:
        if not item or not item.get('id'):
            sources.append({'type': 'unavailable', 'title': 'Недоступная запись'})
            continue
        if youtube:
            if not re.fullmatch(r'[A-Za-z0-9_-]{11}', str(item['id'])):
                raise ValueError('YouTube вернул неизвестную запись')
            item_url = f"https://www.youtube.com/watch?v={item['id']}"
        else:
            try:
                item_url = canonical_link(item.get('webpage_url') or item.get('url') or url)
            except ValueError:
                raw = urlsplit(item.get('url') or '')
                if raw.hostname != 'api.soundcloud.com' or raw.path != f"/tracks/{item['id']}":
                    sources.append({'type': 'unavailable', 'title': item.get('title') or 'Недоступная запись'})
                    continue
                item_url = raw.geturl()
        label = item.get('title') or urlsplit(item_url).path.rsplit('/', 1)[-1].replace('-', ' ') or 'Трек'
        sources.append({'type': 'direct', 'key': f"{'youtube' if youtube else 'soundcloud'}:{item['id']}",
                        'url': item_url, 'provider_id': str(item['id']), 'title': label,
                        'music_title': item.get('track'), 'artist': item.get('artist'),
                        'album': info.get('title') if kind == 'album' else None,
                        'album_artist': info.get('artist') or info.get('uploader') if kind == 'album' else None})
    return info.get('title') or 'Загрузка', kind, sources


def resolve_link(url):
    host = urlsplit(url).hostname
    if host == 'open.spotify.com':
        title, kind, sources = _spotify(url)
    elif host in {'vk.com', 'm.vk.com', 'vk.ru', 'vk.cc', 'music.vk.com', 'vk.link'}:
        from vk_music import resolve
        title, kind, sources = resolve(url)
    else:
        title, kind, sources = _direct(url)
    if kind == 'playlist':
        counts = Counter()
        for source in sources:
            key = source.get('occurrence') or source.get('key') or 'unavailable'
            counts[key] += 1
            source['slot'] = f'{key}:{counts[key]}'
    return title, kind, sources


def audio_format(path):
    from mutagen import File
    from mutagen.flac import FLAC
    from mutagen.mp3 import MP3
    from mutagen.mp4 import MP4

    audio = File(path)
    for container, suffix in ((MP3, '.mp3'), (FLAC, '.flac'), (MP4, '.m4a')):
        if isinstance(audio, container) and audio.info.length > 0:
            return suffix
    raise ValueError('Файл не содержит читаемого MP3, FLAC или M4A')


def find_album_version(source):
    from ytmusicapi import YTMusic
    from source_selection import normalized, version_rejection
    from source_worker import candidates_from_results

    title, artist = source.get('music_title'), source.get('artist')
    if not title or not artist:
        caption = re.sub(r'\s*[([](?:official (?:music )?video|music video)[])]\s*$',
                         '', source['title'], flags=re.I)
        parts = caption.split(' - ', 1)
        if len(parts) != 2:
            raise ValueError('У клипа нет данных песни для поиска альбомной версии')
        artist, title = (part.strip() for part in parts)
    matches = [candidate for candidate in candidates_from_results(
        YTMusic().search(f'{artist} {title}', filter='songs', limit=15, ignore_spelling=True))
        if candidate.album and normalized(candidate.title) == normalized(title)
        and normalized(artist) in {normalized(name) for name in candidate.artists}
        and not version_rejection(title, candidate.title)]
    if not matches or len({normalized(match.album) for match in matches}) > 1:
        raise ValueError('Не удалось однозначно найти альбомную версию этого клипа')
    track = matches[0]
    item = {'type': 'direct', 'url': track.url, 'provider_id': track.video_id, 'title': track.title,
            'album': track.album, 'artist': ', '.join(track.artists), 'key': f'youtube:{track.video_id}'}
    return track.title, 'track', [item]


def _tag_number(value):
    match = re.match(r'\d+', value or '')
    return int(match[0]) if match else 0


def _read_attachment(path):
    from metadata import read_audio_metadata

    suffix = audio_format(path)
    if path.suffix.lower() != suffix:
        new_path = path.with_name(path.name + suffix)
        path.rename(new_path)
        path = new_path
    return path, read_audio_metadata(str(path))


def _identify_untagged(path, meta):
    from services.external_catalogs import search_metadata_providers
    from source_selection import normalized

    raw = (meta.title or path.stem).removeprefix('original-')
    title = re.sub(r'^\d{1,3}[ ._-]+', '', raw).strip()
    artist = ''
    if raw == path.stem.removeprefix('original-'):
        credit = re.fullmatch(r'(.+?)\s+[-–—]\s+(.+)', title)
        if credit:
            artist, title = (value.strip() for value in credit.groups())
            return title, artist, None
    candidates = {}
    for result in search_metadata_providers(title):
        if normalized(result.get('title')) != normalized(title) or not result.get('album') or not result.get('artist'):
            continue
        fields = ('title', 'artist', 'album', 'album_artist', 'year', 'genre', 'track_number', 'disc_number')
        option = {key: result[key] for key in fields if result.get(key)}
        key = tuple(normalized(option.get(field)) for field in ('title', 'artist', 'album', 'year'))
        candidates.setdefault(key, option)
    return title or raw or 'Без названия', artist, list(candidates.values())[:6] or None


def _catalog_genre(meta, release):
    from services.external_catalogs import search_metadata_providers
    from source_selection import normalized

    if not meta.title or not meta.artist or not release or not meta.year:
        return None
    found = set()
    for item in search_metadata_providers(f'{meta.artist} {release} {meta.title}'):
        if (normalized(item.get('title')) == normalized(meta.title)
                and normalized(item.get('artist')) == normalized(meta.artist)
                and normalized(item.get('album')) == normalized(release)
                and item.get('year') == meta.year[:4]
                and (not item.get('track_number') or _tag_number(item['track_number']) == _tag_number(meta.track_number))
                and (not item.get('disc_number') or _tag_number(item['disc_number']) == _tag_number(meta.disc_number or '1'))
                and item.get('genre')):
            found.add(item['genre'])
    return found.pop() if len(found) == 1 else None


def _release_notes(archive):
    credits, ordering, titles = set(), {}, set()
    for item in archive.infolist():
        path = Path(item.filename.replace('\\', '/'))
        suffix = path.suffix.lower()
        if suffix not in {'.cue', '.m3u', '.m3u8'} or item.file_size > 1024 * 1024:
            continue
        text = archive.read(item).decode('utf-8-sig', errors='replace')
        if suffix == '.cue':
            header = re.split(r'^\s*(?:FILE|TRACK)\s', text, maxsplit=1, flags=re.M | re.I)[0]
            performer = re.search(r'^\s*PERFORMER\s+"([^"]+)"', header, re.M | re.I)
            title = re.search(r'^\s*TITLE\s+"([^"]+)"', header, re.M | re.I)
            if performer:
                credits.add(performer[1])
            if title:
                titles.add(title[1])
            for filename, index in re.findall(r'^\s*FILE\s+"([^"]+)"[^\n]*\n\s*TRACK\s+(\d+)\s',
                                               text, re.M | re.I):
                ordering[(path.parent, Path(filename).stem)] = int(index)
        else:
            lines = [line.strip() for line in text.splitlines() if line.strip() and not line.startswith('#')]
            for index, filename in enumerate(lines, 1):
                ordering.setdefault((path.parent, Path(filename.replace('\\', '/')).stem), index)
    return credits, ordering, titles


def resolve_attachment(path, directory):
    from metadata import MAX_COVER_SIZE_BYTES
    from zipfile import is_zipfile

    if not is_zipfile(path):
        path, meta = _read_attachment(path)
        title = (meta.title or path.stem).removeprefix('original-')
        artist = meta.artist
        options = None
        enrichment = None
        if not meta.artist and not meta.album:
            title, artist, options = _identify_untagged(path, meta)
        elif meta.album and (genre := _catalog_genre(meta, meta.album)):
            if meta.genre and meta.genre != genre:
                options = [{'label': f'Жанр из файла · {meta.genre}', 'genre': meta.genre},
                           {'label': f'Жанр из каталога · {genre}', 'genre': genre}]
            elif not meta.genre:
                enrichment = {'genre': genre}
        return title, 'track', [{'type': 'file', 'path': str(path), 'title': title, 'artist': artist,
                                 'album': meta.album, 'metadata_options': options, 'enrichment': enrichment}]

    results = []
    covers = []
    with ZipFile(path) as archive:
        members = archive.infolist()
        if len(members) > 3000 or sum(member.file_size for member in members) > MAX_FILE_BYTES:
            raise ValueError('ZIP превышает предел размера или числа файлов')
        cue_artists, order, cue_titles = _release_notes(archive)
        for index, member in enumerate(members):
            filename = Path(member.filename.replace('\\', '/'))
            if member.is_dir() or '__MACOSX' in filename.parts:
                continue
            if filename.is_absolute() or '..' in filename.parts or stat.S_ISLNK(member.external_attr >> 16):
                raise ValueError('ZIP содержит недопустимый путь')
            suffix = filename.suffix.lower()
            candidate = filename.stem.casefold() in {'main', 'front', 'cover', 'folder'}
            if suffix in {'.jpg', '.jpeg', '.png', '.webp'} and candidate and member.file_size <= MAX_COVER_SIZE_BYTES:
                cover = directory / f'cover-{index}{suffix}'
                with archive.open(member) as source, cover.open('wb') as target:
                    shutil.copyfileobj(source, target)
                rank = (filename.stem.casefold() == 'folder', len(filename.parts), index)
                covers.append((rank, str(cover)))
            if suffix not in AUDIO_SUFFIXES:
                continue
            target = directory / f'{index}{suffix}'
            with archive.open(member) as source, target.open('wb') as output:
                shutil.copyfileobj(source, output)
            actual, meta = _read_attachment(target)
            disc_hint = re.search(r'\b(?:cd|disc|disk)[ _-]?(\d+)\b', str(filename.parent), re.I)
            track_hint = re.match(r'(\d+)', filename.stem)
            disc = _tag_number(meta.disc_number) or (int(disc_hint[1]) if disc_hint else 1)
            track = _tag_number(meta.track_number) or order.get((filename.parent, filename.stem), 0)
            track = track or (int(track_hint[1]) if track_hint else 0)
            title = meta.title if meta.title and meta.title != actual.stem else filename.stem
            results.append((disc, track, filename.as_posix(), meta, actual, title))
    if not results or len(results) > MAX_POSITIONS:
        raise ValueError('В ZIP не найден список поддерживаемых аудиофайлов')
    results.sort(key=lambda row: row[:3])
    if any(not row[1] for row in results) or len({row[:2] for row in results}) != len(results):
        raise ValueError('Не удалось определить уникальные номера дисков и дорожек')
    tags = {row[3].album for row in results if row[3].album}
    albums = {re.sub(r'\s*\((?:cd|disc|disk)\s*\d+\)\s*$', '', label, flags=re.I)
              for label in tags or cue_titles}
    merged = max(albums, key=lambda title: (len(title), title), default='')
    if not merged:
        raise ValueError('Не удалось определить единое издание по аудиотегам или CUE')
    ambiguous_release = any(title.casefold() not in merged.casefold() for title in albums)
    cover = min(covers)[1] if covers else None
    album_artists = {row[3].album_artist for row in results if row[3].album_artist} or cue_artists
    if not album_artists:
        track_artists = {row[3].artist for row in results if row[3].artist}
        if len(track_artists) == 1:
            album_artists = track_artists
    artist = next(iter(album_artists), None) if len(album_artists) == 1 else None
    sources = [{'type': 'file', 'path': str(path), 'title': title, 'album': merged,
                'album_artist': artist, 'disc': disc, 'track': track, 'cover': cover}
               for disc, track, _, _, path, title in results]
    if ambiguous_release or len(album_artists) > 1:
        options = [{'album': album, 'album_artist': artist} for album in sorted(albums)
                   for artist in sorted(album_artists or {''})]
        sources[0]['metadata_options'] = options[:6]
    elif genre := _catalog_genre(results[0][3], merged):
        file_genres = {row[3].genre for row in results if row[3].genre}
        for source, row in zip(sources, results):
            if not row[3].genre:
                source['enrichment'] = {'genre': genre}
        conflicts = sorted(file_genres - {genre})
        if conflicts:
            sources[0]['metadata_options'] = [
                {'label': 'Жанры из файлов · ' + ', '.join(conflicts)},
                {'label': f'Жанр из каталога · {genre}', 'genre': genre},
            ]
    return merged, 'album', sources


def digest_file(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def download_import_cover(source, directory):
    import requests

    from metadata import MAX_COVER_SIZE_BYTES

    url = source.get('cover_url') or (source.get('song') or {}).get('cover_url')
    if not url:
        return None
    try:
        parsed = urlsplit(url)
    except ValueError:
        return None
    host = parsed.hostname or ''
    if (parsed.scheme != 'https' or parsed.netloc != host
            or not host.endswith(('.scdn.co', '.spotifycdn.com', '.vkuserphoto.ru', '.userapi.com'))):
        return None
    path = directory / 'import-cover'
    try:
        with requests.get(url, timeout=(3, 5), stream=True, allow_redirects=False) as response:
            if response.status_code != 200 or not response.headers.get('Content-Type', '').startswith('image/'):
                return None
            deadline = time.monotonic() + 8
            size = 0
            with path.open('wb') as output:
                for chunk in response.iter_content(65536):
                    size += len(chunk)
                    if size > MAX_COVER_SIZE_BYTES or time.monotonic() >= deadline:
                        raise ValueError('Недопустимый размер или время загрузки обложки')
                    output.write(chunk)
            if size == 0:
                raise ValueError('Пустая обложка')
    except (OSError, ValueError):
        path.unlink(missing_ok=True)
        return None
    return str(path)


def _download_with_cover(source, directory):
    artifact = download_source(source, directory)
    if cover := download_import_cover(source, directory):
        artifact['cover'] = cover
    return artifact


def download_source(source, directory):
    import yt_dlp

    kind = source['type']
    directory.mkdir(parents=True, exist_ok=True)
    if replacement := source.get('replacement'):
        return repair_source(source, replacement, directory)
    if kind == 'file':
        from metadata import read_audio_metadata
        from services.external_catalogs import fetch_lrclib_by_track
        from source_selection import normalized

        path = source['path']
        meta = read_audio_metadata(path)
        chosen = source.get('metadata') or {}
        title = chosen.get('title') or source['title']
        artist = chosen.get('artist') or meta.artist
        album = chosen.get('album') or source.get('album') or meta.album
        lyrics = None
        if not meta.lyrics and title and artist and album:
            try:
                results = fetch_lrclib_by_track(title, artist, timeout=4)
            except (OSError, ValueError):
                results = []
            for item in results:
                if (isinstance(item, dict)
                        and isinstance(item.get('duration'), (float, int))
                        and normalized(item.get('trackName')) == normalized(title)
                        and normalized(item.get('artistName')) == normalized(artist)
                        and normalized(item.get('albumName')) == normalized(album)
                        and abs(item['duration'] - meta.duration) <= 2):
                    lyrics = (item.get('syncedLyrics') or item.get('plainLyrics') or '')[:64000]
                    if lyrics:
                        break
        return {'path': path, 'sha256': digest_file(path), 'lyrics': lyrics}
    if kind == 'unavailable':
        raise ValueError('Площадка пометила запись недоступной')
    if kind == 'vk':
        from vk_music import download
        return download(source, directory)
    if kind == 'spotify':
        from source_worker import download_song

        if candidate := source.get('local_flac'):
            from audio_match import fetch_spotify_preview, matches_excerpt

            preview = directory / 'local-reference.mp3'
            local = Path(candidate['path'])
            song = source['song']
            fetch_spotify_preview(song['preview_url'], preview)
            if matches_excerpt(preview, local, song['duration']) and local.stat().st_mtime_ns == candidate['mtime']:
                return {'path': str(local), 'sha256': digest_file(local), 'reuse': candidate,
                        'evidence': {'audio_match': 'spotify-preview-original-speed', 'provider': 'local'}}
        result = download_song({**source['song'], 'require_audio_match': True}, directory)
        if not result.get('track'):
            raise RecordingUnavailable(result['error'], result.get('alternative'), result.get('temporary', False))
        track = result['track']
        return {'path': track['filepath'], 'sha256': digest_file(track['filepath']), 'evidence': track['source']}

    def check(info, *, incomplete=False):
        if not incomplete and str(info.get('id')) != source['provider_id']:
            return 'Площадка вернула другую запись'
        return None

    options = _ydl_options(format='bestaudio[ext=flac]/bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio',
                           noplaylist=True, match_filter=check, max_filesize=MAX_FILE_BYTES,
                           outtmpl=str(directory / 'audio.%(ext)s'))
    with yt_dlp.YoutubeDL(options) as client:
        info = client.extract_info(source['url'], download=True)
    if not info or check(info):
        raise ValueError('Площадка не вернула выбранную запись')
    files = [file for file in directory.glob('audio.*') if file.suffix not in {'.part', '.ytdl'}]
    if len(files) != 1:
        raise ValueError('Полная аудиодорожка недоступна')
    path = files[0]
    suffix = audio_format(path)
    if path.suffix != suffix:
        renamed = path.with_suffix(suffix)
        path.rename(renamed)
        path = renamed
    return {'path': str(path), 'sha256': digest_file(path),
            'title': source.get('version_label') or info.get('track') or info.get('title'),
            'artist': info.get('artist') or info.get('uploader'),
            'album': info.get('album'), 'evidence': {'url': source['url'], 'id': source['provider_id']}}


def review_source(request, directory):
    from audio_match import fetch_spotify_preview, matches_excerpt

    file = Path(request['path'])
    before = file.stat()
    if f'{before.st_size}:{before.st_mtime_ns}' != request['revision']:
        return 'changed'
    reference = directory / 'reference.mp3'
    fetch_spotify_preview(request['preview_url'], reference)
    confirmed = matches_excerpt(reference, file, request['duration'])
    after = file.stat()
    if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
        return 'changed'
    return 'confirmed' if confirmed else 'mismatch'


def repair_source(source, replacement, directory):
    if 'url' in replacement:
        _, kind, items = resolve_link(replacement['url'])
        if kind != 'track':
            raise ValueError('Для добора нужна ссылка на одну песню')
        if source['type'] == 'vk' and items[0].get('key') != source.get('key'):
            raise ValueError('Выберите ту же запись VK')
        artifact = download_source(items[0], directory / 'replacement')
    else:
        if source['type'] == 'vk':
            raise ValueError('Для позиции VK нужна ссылка на её исходную запись')
        path, _ = _read_attachment(Path(replacement['path']))
        artifact = {'path': str(path), 'sha256': digest_file(path)}
    if source.get('song'):
        from audio_match import fetch_spotify_preview, matches_excerpt

        song = source['song']
        if not song.get('preview_url'):
            raise ValueError('У Spotify нет фрагмента для сверки присланной записи')
        preview = directory / 'repair-reference.mp3'
        fetch_spotify_preview(song['preview_url'], preview)
        if not matches_excerpt(preview, Path(artifact['path']), song['duration']):
            raise ValueError('Звук присланного файла отличается от фрагмента Spotify')
        evidence = {**artifact.get('evidence', {}), 'audio_match': 'spotify-preview-original-speed'}
        artifact['evidence'] = evidence
    return artifact


def main():
    import argparse
    import json
    import sys

    sys.path.insert(1, str(Path(__file__).resolve().parents[1] / 'brain'))

    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('link', 'attachment', 'audio', 'review', 'album-version'))
    parser.add_argument('directory', type=Path)
    parser.add_argument('request', type=Path)
    parser.add_argument('result', type=Path)
    args = parser.parse_args()
    request = json.loads(args.request.read_text())
    actions = {'link': lambda: resolve_link(request['url']),
               'attachment': lambda: resolve_attachment(Path(request['path']), args.directory),
               'audio': lambda: _download_with_cover(request, args.directory),
               'review': lambda: review_source(request, args.directory),
               'album-version': lambda: find_album_version(request)}
    try:
        result = {'data': actions[args.action]()}
    except RecordingUnavailable as exc:
        result = {'error': str(exc)[:700], 'alternative': exc.alternative, 'temporary': exc.temporary}
    except ValueError as exc:
        result = {'error': str(exc)[:700]}
    except Exception as exc:
        result = {'error': 'Площадка или аудио временно недоступны', 'temporary': True}
        if args.action == 'attachment':
            result = {'error': 'Не удалось прочитать вложение'}
        print(type(exc).__name__)
    args.result.write_text(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
