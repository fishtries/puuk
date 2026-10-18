import os
import json
import logging
import asyncio
import re
import shlex
import tempfile

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

    # 1. Точное совпадение пары title + artist — самый надёжный вариант,
    #    защищает от одноимённых треков разных исполнителей в одном плейлисте.
    if norm_title and norm_artist:
        for song in songs:
            if _normalize(song.get('name')) == norm_title and song_artists(song) == norm_artist:
                return song
    # 2. Совпадение по artist + вхождению названия в имя файла.
    if norm_artist:
        for song in songs:
            if song_artists(song) == norm_artist and _normalize(song.get('name')) in filename:
                return song
    # 3. Только по названию (artist неизвестен/не совпал).
    if norm_title:
        for song in songs:
            if _normalize(song.get('name')) == norm_title:
                return song
    # 4. Название встречается в имени файла.
    for song in songs:
        if _normalize(song.get('name')) and _normalize(song.get('name')) in filename:
            return song
    return None


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
    result['verification'] = ok
    result['has_lyrics'] = bool(result.get('lyrics'))
    logging.info(
        "[metadata] file=%s title=%r artist=%r album=%r cover=%s lyrics=%s verified=%s",
        os.path.basename(filepath), result.get('title'), result.get('artist'),
        result.get('album'), result.get('has_cover'), result.get('has_lyrics'), ok,
    )
    return result


def _build_tracks(changed_files: list, songs: list) -> list:
    """Синхронная финализация файлов (может ходить в сеть за обложкой).

    Вызывается через asyncio.to_thread, чтобы не блокировать event loop бота.
    """
    tracks = []
    for filepath in changed_files:
        try:
            tags = read_audio_tags(filepath)
            song = _match_song(songs, tags.title, tags.artist, filepath)
            metadata = _finalize_track(filepath, song=song)
        except Exception as exc:
            logging.error("[metadata] failed to finalize %s: %s", filepath, exc)
            continue
        tracks.append({
            'filepath': filepath,
            'title': metadata.get('title', ''),
            'artist': metadata.get('artist', ''),
            'album': metadata.get('album', ''),
            'album_artist': metadata.get('album_artist', ''),
            'track_number': metadata.get('track_number', ''),
            'disc_number': metadata.get('disc_number', ''),
            'duration': metadata.get('duration', 0),
            'has_cover': metadata.get('has_cover', False),
            'has_lyrics': metadata.get('has_lyrics', False),
            'verification': metadata.get('verification', False),
        })
    return tracks


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
        'extractor_args': {'youtube': {'player_client': ['android', 'web']}},
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info_dict = ydl.extract_info(url, download=True)
            
            if 'entries' in info_dict:
                info_dict = info_dict['entries'][0]
                
            title = info_dict.get('title', 'Unknown Title')
            uploader = info_dict.get('uploader', info_dict.get('artist', 'Unknown Artist'))
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
                'duration': duration,
                'url': url,
                'filepath': final_mp3,
                'is_spotify': False,
                'metadata': metadata,
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
        'extractor_args': {'youtube': {'player_client': ['android', 'web']}},
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

async def download_spotify(url: str, output_dir: str = DEFAULT_MUSIC_DIR, progress_cb=None) -> dict:
    """
    Downloads Spotify tracks or playlists using spotdl.
    progress_cb is an asynchronous callback.
    """
    if not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    import sys
    save_dir = tempfile.mkdtemp(prefix="spotdl_meta_")
    save_file = os.path.join(save_dir, "metadata.spotdl")
    cmd = [
        sys.executable, "-m", "spotdl", "download", url,
        "--output", output_dir,
        "--audio", "youtube", "piped",
        "--lyrics",
        "--overwrite", "metadata",
        "--save-file", save_file,
        "--yt-dlp-args", "--js-runtimes node:/usr/bin/node --extractor-args youtube:player_client=android,web"
    ]

    logging.info(
        "[spotdl] starting: url=%s output_dir=%s command=%s",
        url,
        output_dir,
        shlex.join(cmd),
    )

    before_snapshot = _snapshot_dir(output_dir)

    process = None
    stderr_task = None
    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        total_tracks = 0
        downloaded_tracks = 0
        track_history = []
        output_lines = []
        error_lines = []

        async def read_stderr() -> None:
            """Drain spotdl stderr while stdout is being processed."""
            while True:
                line = await process.stderr.readline()
                if not line:
                    break

                line_str = strip_ansi(line.decode('utf-8', errors='replace')).strip()
                if not line_str:
                    continue

                error_lines.append(line_str)
                logging.warning("[spotdl][stderr] %s", line_str)

        stderr_task = asyncio.create_task(read_stderr())

        while True:
            line = await process.stdout.readline()
            if not line:
                break

            line_str = strip_ansi(line.decode('utf-8', errors='ignore')).strip()
            if not line_str:
                continue

            output_lines.append(line_str)
            logging.info("[spotdl][stdout] %s", line_str)
            if any(err_kw in line_str.lower() for err_kw in ("error:", "exception:", "failed", "unavailable", "blocked", "http error")):
                error_lines.append(line_str)

            # Parsing spotdl output
            if "Found" in line_str and "songs" in line_str:
                m = re.search(r'Found (\d+) songs', line_str)
                if m:
                    total_tracks = int(m.group(1))
                    if progress_cb:
                        await progress_cb(f"Найдено {total_tracks} треков. Начинаю скачивание...")
            elif "Downloaded" in line_str or "Skipping" in line_str or "Skipped" in line_str or "Updated" in line_str:
                downloaded_tracks += 1

                track_name = ""
                m_track = re.search(r'(?:Downloaded|Skipping|Skipped|Updated).*?"(.*?)"', line_str)
                if not m_track:
                    m_track = re.search(r'"(.*?)"', line_str)
                if m_track:
                    track_name = m_track.group(1)

                if progress_cb:
                    if total_tracks > 1:
                        icon = "⏩ (пропуск)" if "Skip" in line_str else "✅"
                        if track_name:
                            track_history.append(f"{icon} {track_name}")

                        display_history = track_history[-20:]
                        history_str = "\n".join(display_history)
                        if len(track_history) > 20:
                            history_str = f"... и еще {len(track_history) - 20} треков\n" + history_str

                        msg = f"Обработано {downloaded_tracks} из {total_tracks} треков...\n\n{history_str}"
                        await progress_cb(msg)
                    else:
                        if "Skip" in line_str:
                            await progress_cb(f"Трек уже существует. Обновляю метаданные...")
                        else:
                            await progress_cb(f"Трек загружен. Обработка метаданных...")

        await process.wait()
        await stderr_task

        if process.returncode != 0:
            logging.error("[spotdl] failed with return code %s", process.returncode)
            relevant_errors = "\n".join(error_lines[-5:]) if error_lines else ("\n".join(output_lines[-5:]) if output_lines else "Неизвестная ошибка")
            raise Exception(f"SpotDL Error:\n{relevant_errors}")

        songs = _load_spotdl_songs(save_file)
        changed_files = _changed_audio_files(output_dir, before_snapshot)

        # Финализация ходит в сеть за обложкой — уводим из event loop.
        tracks = await asyncio.to_thread(_build_tracks, changed_files, songs)

        logging.info(
            "[spotdl] finished: returncode=%s total_tracks=%s processed_tracks=%s changed_files=%s tracks=%s",
            process.returncode,
            total_tracks,
            downloaded_tracks,
            changed_files,
            [t['filepath'] for t in tracks],
        )

        if downloaded_tracks == 0 and not tracks:
            logging.error("[spotdl] completed without processed tracks")
            if error_lines:
                detail = "\n".join(error_lines[-3:])
                raise Exception(f"Ни один трек не был загружен:\n{detail}")
            raise Exception("Ни один трек не был загружен. Возможно, трек заблокирован на YouTube или недоступен.")

        return {
            'title': f"Spotify {'Плейлист' if total_tracks > 1 else 'Трек'}",
            'artist': 'Spotify',
            'duration': 0,
            'url': url,
            'is_spotify': True,
            'total_tracks': len(tracks) or downloaded_tracks,
            'tracks': tracks,
        }
    finally:
        if process is not None and process.returncode is None:
            try:
                process.kill()
                await process.wait()
            except Exception:
                pass
        if stderr_task is not None and not stderr_task.done():
            stderr_task.cancel()
            try:
                await stderr_task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        _cleanup_dir(save_dir)
