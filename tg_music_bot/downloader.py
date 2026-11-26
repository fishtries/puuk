import os
import json
import logging
import asyncio
import re
import signal
import sys
from pathlib import Path
from urllib.parse import urlparse
import tempfile
import hashlib

from audio_tags import (
    AUDIO_EXTENSIONS,
    cover_from_itunes,
    fetch_cover,
    parse_filename_metadata,
    read_audio_tags,
    verify_audio_tags,
    write_audio_metadata,
)

def strip_ansi(text: str) -> str:
    ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
    return ansi_escape.sub('', text)

DEFAULT_MUSIC_DIR = os.getenv('MUSIC_DIR', '/mnt/data/projects/puuk/music')


def _snapshot_dir(directory: str) -> dict:
    snapshot = {}
    if not os.path.isdir(directory):
        return snapshot
    for name in os.listdir(directory):
        full = os.path.join(directory, name)
        if os.path.isfile(full) and os.path.splitext(name)[1].lower() in AUDIO_EXTENSIONS:
            stat = os.stat(full)
            snapshot[name] = (stat.st_size, stat.st_mtime_ns)
    return snapshot


def _cleanup_dir(directory: str) -> None:
    import shutil

    shutil.rmtree(directory, ignore_errors=True)


def _changed_audio_files(directory: str, before: dict) -> list:
    changed = []
    if not os.path.isdir(directory):
        return changed
    for name in os.listdir(directory):
        full = os.path.join(directory, name)
        if not os.path.isfile(full):
            continue
        if os.path.splitext(name)[1].lower() not in AUDIO_EXTENSIONS:
            continue
        stat = os.stat(full)
        if before.get(name) != (stat.st_size, stat.st_mtime_ns):
            changed.append(full)
    return sorted(changed)


def _normalize(text: str) -> str:
    return re.sub(r'[^\w]+', ' ', str(text or '').lower()).strip()


def _load_spotdl_songs(save_path: str) -> list:
    if not save_path or not os.path.isfile(save_path):
        return []
    try:
        with open(save_path, 'r', encoding='utf-8') as handle:
            data = json.load(handle)
        return data if isinstance(data, list) else []
    except Exception as exc:
        logging.warning("[metadata] cannot read spotdl save file %s: %s", save_path, exc)
        return []


def _match_song(songs: list, title: str, artist: str, filepath: str) -> dict | None:
    norm_title = _normalize(title)
    norm_artist = _normalize(artist)
    filename = _normalize(os.path.splitext(os.path.basename(filepath))[0])

    def song_artists(song: dict) -> str:
        return _normalize(", ".join(song.get('artists') or []))

    def unique(candidates):
        return candidates[0] if len(candidates) == 1 else None

    if norm_title and norm_artist:
        candidates = [s for s in songs if _normalize(s.get('name')) == norm_title and song_artists(s) == norm_artist]
        if candidates:
            return unique(candidates)
    if norm_artist and not norm_title:
        candidates = [s for s in songs if song_artists(s) == norm_artist and _normalize(s.get('name')) and _normalize(s.get('name')) in filename]
        if candidates:
            return unique(candidates)
    if norm_title:
        candidates = [s for s in songs if _normalize(s.get('name')) == norm_title]
        return unique(candidates)
    return unique([s for s in songs if _normalize(s.get('name')) and _normalize(s.get('name')) in filename])


def _format_number(number, total) -> str:
    if number in (None, ""):
        return ""
    if total in (None, "", 0):
        return str(number)
    return f"{number}/{total}"


def _finalize_track(filepath: str, song: dict | None = None,
                    fallback_title: str = "", fallback_artist: str = "",
                    fallback_cover_url: str | None = None,
                    fallback_date: str = "") -> dict:
    """Дополняет и проверяет теги скачанного файла. Возвращает метаданные трека."""
    song = song or {}
    if not os.path.isfile(filepath):
        logging.warning("[metadata] file not found, skipping finalize: %s", filepath)
        return {
            "filepath": filepath,
            "title": fallback_title,
            "artist": fallback_artist,
            "album": "",
            "album_artist": "",
            "date": fallback_date,
            "duration": 0,
            "has_cover": False,
            "has_lyrics": False,
            "verification": False,
        }
    try:
        tags = read_audio_tags(filepath)
    except Exception as exc:
        logging.warning("[metadata] cannot read tags for %s: %s", filepath, exc)
        tags = None

    original_tags = tags
    title = (tags.title if tags else "") or song.get('name') or fallback_title
    artist = (tags.artist if tags else "") or ", ".join(song.get('artists') or []) or fallback_artist
    if not title or not artist:
        file_artist, file_title = parse_filename_metadata(filepath)
        title = title or file_title
        artist = artist or file_artist

    album = (tags.album if tags else "") or song.get('album_name') or ""
    album_artist = (tags.album_artist if tags else "") or song.get('album_artist') or ""
    date = (tags.date if tags else "") or song.get('date') or (str(song.get('year')) if song.get('year') else "") or fallback_date
    genre = (tags.genre if tags else "") or next((g for g in (song.get('genres') or []) if g), "")
    track_number = (tags.track_number if tags else "") or _format_number(song.get('track_number'), song.get('tracks_count'))
    disc_number = (tags.disc_number if tags else "") or _format_number(song.get('disc_number'), song.get('disc_count'))
    lyrics = (tags.lyrics if tags else "") or song.get('lyrics') or ""

    cover_bytes = None
    cover_mime = "image/jpeg"
    if not (tags and tags.has_cover):
        cover_url = song.get('cover_url') or fallback_cover_url
        fetched = fetch_cover(cover_url) if cover_url else None
        if not fetched:
            fetched = cover_from_itunes(title, artist)
        if fetched:
            cover_bytes, cover_mime = fetched

    try:
        tags = write_audio_metadata(
            filepath,
            title=title,
            artist=artist,
            album=album,
            album_artist=album_artist,
            date=date,
            genre=genre,
            track_number=track_number,
            disc_number=disc_number,
            lyrics=lyrics,
            cover_bytes=cover_bytes,
            cover_mime=cover_mime,
        )
    except Exception as exc:
        logging.error("[metadata] failed to write tags for %s: %s", filepath, exc)

    ok, missing = verify_audio_tags(filepath)
    if not ok:
        logging.warning("[metadata] verification failed for %s, missing=%s", filepath, missing)

    result = tags.as_metadata() if tags else {"filepath": filepath}
    for key, attr in (('artists', 'artists'), ('album_artists', 'album_artists')):
        provider = song.get(key)
        if isinstance(provider, list) and all(isinstance(name, str) for name in provider):
            result[key], result[key + '_kind'] = provider, 'provider'
        else:
            values = getattr(original_tags, attr, None) if original_tags else None
            result[key], result[key + '_kind'] = values, 'tags' if values is not None else None
    result['verification'] = ok
    result['has_lyrics'] = bool(result.get('lyrics'))
    logging.info(
        "[metadata] file=%s title=%r artist=%r album=%r cover=%s lyrics=%s verified=%s",
        os.path.basename(filepath), result.get('title'), result.get('artist'),
        result.get('album'), result.get('has_cover'), result.get('has_lyrics'), ok,
    )
    return result


def _parse_track_number(val) -> int:
    if val is None:
        return 999999
    match = re.match(r'^\s*(\d+)', str(val))
    return int(match.group(1)) if match else 999999


def _build_tracks(changed_files: list, songs: list) -> list:
    """Синхронная финализация файлов (может ходить в сеть за обложкой).

    Вызывается через asyncio.to_thread, чтобы не блокировать event loop бота.
    """
    tracks = []
    matches = []
    for filepath in changed_files:
        try:
            tags = read_audio_tags(filepath)
            matches.append((filepath, _match_song(songs, tags.title, tags.artist, filepath)))
        except Exception as exc:
            logging.error("[metadata] failed to read %s: %s", filepath, exc)
    # A provider result can identify at most one changed file in this batch.
    counts = {}
    for _, song in matches:
        if song is not None:
            counts[id(song)] = counts.get(id(song), 0) + 1
    song_index_map = {id(s): i for i, s in enumerate(songs)} if songs else {}
    for filepath, song in matches:
        try:
            if song is not None and counts[id(song)] != 1:
                song = None
            metadata = _finalize_track(filepath, song=song)
        except Exception as exc:
            logging.error("[metadata] failed to finalize %s: %s", filepath, exc)
            continue
        tracks.append({
            'verified_metadata': metadata,
            'filepath': filepath,
            'title': metadata.get('title', ''),
            'artist': metadata.get('artist', ''),
            'album': metadata.get('album', ''),
            'album_artist': metadata.get('album_artist', ''),
            'artists': metadata.get('artists'),
            'artists_kind': metadata.get('artists_kind'),
            'album_artists': metadata.get('album_artists'),
            'album_artists_kind': metadata.get('album_artists_kind'),
            'track_number': metadata.get('track_number', ''),
            'disc_number': metadata.get('disc_number', ''),
            'duration': metadata.get('duration', 0),
            'has_cover': metadata.get('has_cover', False),
            'has_lyrics': metadata.get('has_lyrics', False),
            'verification': metadata.get('verification', False),
            '_source_order': song_index_map.get(id(song)) if song is not None else None,
        })
    if songs:
        tracks.sort(key=lambda t: (
            t['_source_order'] if t['_source_order'] is not None else 999999,
            _parse_track_number(t.get('disc_number')),
            _parse_track_number(t.get('track_number')),
            t.get('filepath', ''),
        ))
    else:
        tracks.sort(key=lambda t: (
            _parse_track_number(t.get('disc_number')),
            _parse_track_number(t.get('track_number')),
            t.get('filepath', ''),
        ))
    for t in tracks:
        t.pop('_source_order', None)
    return tracks


def _existing_spotify_tracks(output_dir: str, songs: list, exclude: set) -> list:
    """Reuse only files with a checked audio source, without editing their tags."""
    from mutagen.id3 import ID3
    from source_selection import Candidate, POLICY_VERSION, assess, duration_matches

    wanted = {song['url'].split('?')[0]: song for song in songs if song.get('url')}
    if not wanted:
        return []
    existing = []
    for name in sorted(os.listdir(output_dir)):
        path = os.path.join(output_dir, name)
        if path in exclude or not name.lower().endswith('.mp3') or not os.path.isfile(path):
            continue
        try:
            tags = ID3(path)
            url = str(tags.get('WOAS', '')).split('?')[0]
            if url not in wanted:
                continue
            raw_receipt = tags.get('TXXX:PUUK_SOURCE_V1')
            if raw_receipt is None:
                continue
            receipt = json.loads(str(raw_receipt))
            if receipt.get('policy') != POLICY_VERSION or receipt.get('spotify_url') != url:
                continue
            candidate = Candidate(**receipt['candidate'])
            audio_matched = receipt.get('audio_match') == 'spotify-preview-original-speed'
            if candidate.provider == 'vk' and not audio_matched:
                continue
            verified_song = {**wanted[url], 'require_audio_match': audio_matched}
            if assess(verified_song, candidate)[1]:
                continue
            meta = read_audio_tags(path).as_metadata()
            if not meta.get('title') or not meta.get('artist') or meta.get('duration', 0) <= 0:
                continue
            if not duration_matches(wanted[url].get('duration'), meta.get('duration')):
                continue
            meta['verification'] = True
            meta['has_lyrics'] = bool(meta.get('lyrics'))
            for key in ('artists', 'album_artists'):
                meta[key + '_kind'] = 'tags' if meta.get(key) is not None else None
            existing.append({**meta, 'filepath': path, 'verified_metadata': meta, 'source': receipt})
            del wanted[url]
        except Exception as exc:
            logging.warning('[spotdl] cannot reuse %s: %s', path, exc)
    return existing


def _publish_tracks(tracks: list, output_dir: str) -> list:
    """Publish complete files atomically; never replace an existing library file.

    Staging lives on the same filesystem. link() arbitrates concurrent imports
    of the same filename without exposing incomplete files to the scanner.
    """
    published = []
    for track in tracks:
        source = track['filepath']
        target = os.path.join(output_dir, os.path.basename(source))
        try:
            os.link(source, target)
        except FileExistsError:
            # A filename collision does not establish recording identity. Keep
            # the old file but never return it as the newly checked recording.
            def digest(path):
                with open(path, 'rb') as handle:
                    return hashlib.file_digest(handle, 'sha256').hexdigest()
            checksum = digest(source)
            if digest(target) != checksum:
                base, ext = os.path.splitext(target)
                target = f'{base}-{checksum[:16]}{ext}'
                try:
                    os.link(source, target)
                except FileExistsError:
                    if digest(target) != checksum:
                        raise ValueError('Конфликт файлов при публикации записи')
        track['filepath'] = target
        track['verified_metadata']['filepath'] = target
        published.append(track)
    return published


def download_audio(url: str, output_dir: str = DEFAULT_MUSIC_DIR, progress_cb=None) -> dict:
    """
    Downloads audio from the given URL via yt-dlp.
    progress_cb is a synchronous callback.
    """
    import yt_dlp
    
    if 'vk.ru/' in url:
        url = url.replace('vk.ru/', 'vk.com/')

    if not os.path.exists(output_dir):
        try:
            os.makedirs(output_dir, exist_ok=True)
        except Exception as e:
            logging.error(f"Failed to create directory {output_dir}: {e}")
            raise

    def yt_dlp_hook(d):
        if d['status'] == 'downloading':
            p = strip_ansi(d.get('_percent_str', '')).strip()
            if progress_cb and p:
                progress_cb(f"Загрузка: {p}")
        elif d['status'] == 'finished':
            if progress_cb:
                progress_cb("Конвертация в аудио...")

    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(output_dir, '%(title)s - %(uploader)s.%(ext)s'),
        'writethumbnail': True,
        'postprocessors': [
            {
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'mp3',
                'preferredquality': '320',
            },
            {
                'key': 'EmbedThumbnail',
            },
            {
                'key': 'FFmpegMetadata',
            }
        ],
        'progress_hooks': [yt_dlp_hook],
        'quiet': True,
        'no_warnings': True,
        'nooverwrites': True,
        'retries': 10,
        'fragment_retries': 10,
        'js_runtimes': {'node': {}},
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            if urlparse(url).hostname in ('soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com'):
                from soundcloud_source import register
                register(ydl)
            info_dict = ydl.extract_info(url, download=True)
            
            if 'entries' in info_dict:
                info_dict = info_dict['entries'][0]
                
            title = info_dict.get('track') or info_dict.get('title', 'Unknown Title')
            uploader = (info_dict.get('artist') or ', '.join(info_dict.get('artists') or [])
                        or info_dict.get('uploader') or 'Unknown Artist')
            duration = info_dict.get('duration', 0)
            
            # Определяем точный путь к созданному mp3 файлу
            base_fn = ydl.prepare_filename(info_dict)
            final_mp3 = os.path.splitext(base_fn)[0] + '.mp3'

            upload_date = info_dict.get('upload_date') or ""
            if len(upload_date) == 8:
                upload_date = f"{upload_date[0:4]}-{upload_date[4:6]}-{upload_date[6:8]}"

            metadata = _finalize_track(
                final_mp3,
                fallback_title=title,
                fallback_artist=uploader,
                fallback_cover_url=info_dict.get('thumbnail'),
                fallback_date=upload_date,
            )
            
            return {
                'title': metadata.get('title') or title,
                'artist': metadata.get('artist') or uploader,
                'album': metadata.get('album', ''),
                'album_artist': metadata.get('album_artist', ''),
                'artists': metadata.get('artists'),
                'artists_kind': metadata.get('artists_kind'),
                'album_artists': metadata.get('album_artists'),
                'album_artists_kind': metadata.get('album_artists_kind'),
                'duration': duration,
                'url': url,
                'filepath': final_mp3,
                'is_spotify': False,
                'source_provider': 'soundcloud' if urlparse(url).hostname in ('soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com') else None,
                'source_explicit': info_dict.get('explicit'),
                'metadata': metadata,
                'verified_metadata': metadata,
            }
    except Exception as e:
        logging.error(f"Error downloading {url}: {e}")
        raise e

def search_youtube(query: str, max_results: int = 5) -> list:
    import yt_dlp
    ydl_opts = {
        'format': 'bestaudio/best',
        'extract_flat': True,
        'quiet': True,
        'no_warnings': True,
        'js_runtimes': {'node': {}},
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            result = ydl.extract_info(f"ytsearch{max_results}:{query}", download=False)
            if 'entries' in result:
                entries = result['entries']
                res = []
                for e in entries:
                    if not e.get('id'):
                        continue
                    res.append({
                        'id': e.get('id'),
                        'title': e.get('title', 'Unknown'),
                        'uploader': e.get('uploader', 'Unknown'),
                        'duration': e.get('duration', 0)
                    })
                return res
            return []
    except Exception as e:
        logging.error(f"Search failed: {e}")
        return []

def search_soundcloud(query: str, max_results: int = 5) -> list:
    import yt_dlp
    from soundcloud_source import register
    options = {'extract_flat': True, 'quiet': True, 'no_warnings': True,
               'ignoreerrors': True, 'socket_timeout': 10, 'retries': 1,
               'extractor_retries': 1, 'playlistend': max_results}
    with yt_dlp.YoutubeDL(options) as ydl:
        register(ydl)
        result = ydl.extract_info(f'scsearch{max_results}:{query}', download=False)
    return [{'id': row['id'], 'url': row['webpage_url'],
             'title': row.get('title') or 'Unknown',
             'uploader': row.get('uploader') or row.get('artist') or 'Unknown',
             'duration': row.get('duration') or 0}
            for row in (result or {}).get('entries', [])
            if row and row.get('id') and row.get('webpage_url')]


async def _run_download_process(cmd: list[str], log_path: str, timeout: float) -> None:
    """Bound the entire child process tree, including ffmpeg, and disk-backed logs."""
    process = None
    try:
        with open(log_path, 'wb') as log:
            process = await asyncio.create_subprocess_exec(
                *cmd, stdout=log, stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
            )
            async with asyncio.timeout(timeout):
                await process.wait()
        if process.returncode != 0:
            with open(log_path, 'rb') as log:
                log.seek(0, os.SEEK_END)
                log.seek(max(0, log.tell() - 4000))
                detail = strip_ansi(log.read().decode('utf-8', errors='replace'))
            logging.warning('[download] child failed (%s): %s', process.returncode, detail)
            raise RuntimeError('Сервис загрузки недоступен; подробности записаны в журнал')
    finally:
        if process is not None and process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await process.wait()


async def download_spotify(url: str, output_dir: str = DEFAULT_MUSIC_DIR, progress_cb=None, checkpoint_dir=None) -> dict:
    """Spotify supplies identity, not audio. Publish only checked recording results.

    Metadata and each recording run in separate killable processes. A failed item
    does not discard other songs. No arbitrary-video fallback and no legacy file
    reuse based solely on the Spotify tag (those tags can describe wrong audio).
    """
    parsed = urlparse(url)
    if parsed.scheme != 'https' or parsed.hostname != 'open.spotify.com' or not re.fullmatch(
        r'/(?:intl-[a-z-]+/)?(?:track|album|playlist)/[A-Za-z0-9]+/?', parsed.path,
    ):
        raise ValueError('Нужна ссылка Spotify на трек, альбом или плейлист')
    os.makedirs(output_dir, exist_ok=True)
    stage = tempfile.mkdtemp(prefix='puuk_spotify_', dir=os.path.dirname(os.path.abspath(output_dir)))
    save_file = os.path.join(checkpoint_dir or stage, 'metadata.spotdl')
    if checkpoint_dir:
        os.makedirs(checkpoint_dir, exist_ok=True)
    deadline = asyncio.get_running_loop().time() + 1800
    tracks, failures = [], []
    try:
        if progress_cb:
            await progress_cb('Получаю список треков и проверяю версии...')
        # Metadata only. No spotDL audio matcher, Piped or automatic video fallback.
        if not os.path.isfile(save_file):
            pending_file = save_file + '.pending.spotdl'
            if '/album/' in parsed.path:
                progress_file = os.path.join(stage, 'metadata-progress.txt')
                command = [sys.executable, os.path.join(os.path.dirname(__file__), 'spotify_metadata.py'),
                           url, '--output', pending_file, '--progress', progress_file]
                task = asyncio.create_task(_run_download_process(command, os.path.join(stage, 'metadata.log'), 90))
                last_progress = ''
                try:
                    while not task.done():
                        await asyncio.wait([task], timeout=2)
                        if os.path.isfile(progress_file):
                            message = Path(progress_file).read_text()
                            if message != last_progress and progress_cb:
                                await progress_cb(message)
                                last_progress = message
                    await task
                finally:
                    if not task.done():
                        task.cancel()
                        try:
                            await task
                        except asyncio.CancelledError:
                            pass
            else:
                await _run_download_process([
                    sys.executable, '-m', 'spotdl', 'save', url,
                    '--save-file', pending_file, '--lyrics', '--threads', '2', '--audio', 'youtube',
                ], os.path.join(stage, 'metadata.log'), 180)
            os.replace(pending_file, save_file)
        songs = _load_spotdl_songs(save_file)
        if not songs or len(songs) > 1000 or any(
            not isinstance(song, dict) or not song.get('url') or not song.get('name')
            or not song.get('artists') or not song.get('duration') for song in songs
        ):
            raise ValueError('Spotify не вернул проверяемый список треков (максимум 1000)')
        # Repeated playlist positions refer to the same file; preserve first order.
        songs = list({song['url']: song for song in songs}.values())
        reused = await asyncio.to_thread(_existing_spotify_tracks, output_dir, songs, set())
        existing = {t['source']['spotify_url']: t for t in reused}
        for index, song in enumerate(songs):
            label = f"{', '.join(song['artists'])} — {song['name']}"
            if progress_cb:
                await progress_cb(f'Проверяю {index + 1}/{len(songs)}: {label}')
            known = existing.get(song['url'].split('?')[0])
            if known:
                tracks.append(known)
                continue
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                failures.extend({'title': s['name'], 'reason': 'Истёк срок загрузки альбома'} for s in songs[index:])
                break
            item_dir = os.path.join(stage, str(index))
            os.mkdir(item_dir)
            song_file = os.path.join(item_dir, 'song.json')
            result_file = os.path.join(item_dir, 'result.json')
            Path(song_file).write_text(json.dumps(song, ensure_ascii=False))
            try:
                await _run_download_process([
                    sys.executable, os.path.join(os.path.dirname(__file__), 'source_worker.py'),
                    '--song', song_file, '--output', item_dir, '--result', result_file,
                ], os.path.join(item_dir, 'worker.log'), min(180, remaining))
                result = json.loads(Path(result_file).read_text())
                if not result.get('track'):
                    raise ValueError(result.get('error') or 'Подтверждённая запись не найдена')
                track = result['track']
                file_path = Path(track['filepath']).resolve()
                if file_path.parent != Path(item_dir).resolve() or not file_path.is_file():
                    raise ValueError('Некорректный результат загрузки')
                # Verify provenance again at the publication boundary.
                checked = _existing_spotify_tracks(item_dir, [song], set())
                if len(checked) != 1 or Path(checked[0]['filepath']).resolve() != file_path:
                    raise ValueError('Нет подтверждения соответствия записи')
                # Publish each verified song before advancing. A restart reuses
                # the receipt instead of downloading the completed part again.
                tracks.append(_publish_tracks([track], output_dir)[0])
            except TimeoutError:
                failures.append({'title': song['name'], 'reason': 'Источник не ответил за отведённое время'})
            except Exception as exc:
                logging.warning('[download] %s: %s', label, exc)
                failures.append({'title': song['name'], 'reason': str(exc)[:500]})
        if not tracks:
            titles = ', '.join(str(f['title'])[:100] for f in failures[:6])
            more = f' и ещё {len(failures) - 6}' if len(failures) > 6 else ''
            raise ValueError(f'Не найдено: {titles}{more}.\nПришли ссылку на нужную версию в YouTube или SoundCloud.')
        return {
            'title': f"Spotify {'Плейлист' if len(songs) > 1 else 'Трек'}",
            'artist': 'Spotify', 'duration': 0, 'url': url, 'is_spotify': True,
            'total_tracks': len(tracks), 'reused_tracks': len(reused),
            'expected_tracks': len(songs), 'failed_tracks': len(failures),
            'failures': failures,
            'source_type': 'альбом' if '/album/' in url else ('плейлист' if '/playlist/' in url else 'трек'),
            'tracks': tracks,
        }
    finally:
        _cleanup_dir(stage)
