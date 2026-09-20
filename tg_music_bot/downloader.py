import os
import logging
import asyncio
import re

def strip_ansi(text: str) -> str:
    ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
    return ansi_escape.sub('', text)

DEFAULT_MUSIC_DIR = os.getenv('MUSIC_DIR', '/mnt/data/projects/puuk/music')

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
            
            return {
                'title': title,
                'artist': uploader,
                'duration': duration,
                'url': url,
                'filepath': final_mp3,
                'is_spotify': False
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
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "spotdl", "download", url, "--output", output_dir,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    
    total_tracks = 0
    downloaded_tracks = 0
    track_history = []
    
    while True:
        line = await process.stdout.readline()
        if not line:
            break
            
        line_str = strip_ansi(line.decode('utf-8')).strip()
        
        # Parsing spotdl output
        if "Found" in line_str and "songs" in line_str:
            m = re.search(r'Found (\d+) songs', line_str)
            if m:
                total_tracks = int(m.group(1))
                if progress_cb:
                    await progress_cb(f"Найдено {total_tracks} треков. Начинаю скачивание...")
        elif "Downloaded" in line_str or "Skipping" in line_str or "Skipped" in line_str:
            downloaded_tracks += 1
            
            track_name = ""
            m_track = re.search(r'(?:Downloaded|Skipping|Skipped).*?"(.*?)"', line_str)
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
                        await progress_cb(f"Трек уже существует. Завершаю...")
                    else:
                        await progress_cb(f"Трек загружен. Обработка...")
                    
    await process.wait()
    
    if process.returncode != 0:
        err = await process.stderr.read()
        raise Exception(f"SpotDL Error: {err.decode('utf-8')}")
        
    if downloaded_tracks == 0:
        raise Exception("Ни один трек не был загружен. Возможно, трек заблокирован на YouTube или недоступен.")
        
    return {
        'title': f"Spotify {'Плейлист' if total_tracks > 1 else 'Трек'}",
        'artist': 'Spotify',
        'duration': 0,
        'url': url,
        'is_spotify': True,
        'total_tracks': downloaded_tracks
    }
