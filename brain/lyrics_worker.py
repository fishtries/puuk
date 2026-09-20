"""
LyricsWorker: GPU-воркер для караоке (WhisperAnchorBackend).
Запускается на рабочей станции с NVIDIA RTX 4070 SUPER.
Взаимодействует с домашним сервером Puuk (192.168.1.117):
- опрашивает очередь /api/lyrics-jobs/pending;
- скачивает аудиофайл через /api/stream/{track_id};
- производит высокоточный Forced Alignment на GPU;
- сохраняет результат на сервере через /api/tracks/{track_id}/save-word-lyrics.
"""

import os
import sys
import time
import json
import logging
import argparse
import requests
from pathlib import Path
from typing import Optional, Dict, Any

from alignment_types import AlignmentResult
from lyrics_normalizer import parse_reference_lrc, is_synced_lrc, inspect_reference_anchors
from whisper_anchor_backend import WhisperAnchorBackend

# Конфигурация
DEFAULT_SERVER_URL = os.getenv("SERVER_URL", "http://192.168.1.117:8000")
TEMP_DIR = Path(os.path.dirname(__file__)) / "temp_audio"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [LyricsWorker] [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)


def fetch_lrclib_lyrics(title: str, artist: str) -> Optional[str]:
    """Fallback поиск синхронизированного или обычного текста в LRCLIB."""
    queries = [
        {"track_name": title, "artist_name": artist},
        {"q": f"{title} {artist}".strip()},
        {"q": title},
    ]
    for p in queries:
        try:
            res = requests.get("https://lrclib.net/api/search", params=p, timeout=5)
            if res.status_code == 200:
                data = res.json()
                if isinstance(data, list) and data:
                    for item in data:
                        synced = item.get("syncedLyrics")
                        if synced:
                            return synced
                    for item in data:
                        plain = item.get("plainLyrics")
                        if plain:
                            return plain
        except Exception as e:
            logger.debug(f"LRCLIB search query {p} error: {e}")
    return None


class LyricsWorker:
    def __init__(self, server_url: str = DEFAULT_SERVER_URL):
        self.server_url = server_url.rstrip("/")
        TEMP_DIR.mkdir(parents=True, exist_ok=True)
        logger.info(f"Инициализация LyricsWorker. Подключение к серверу: {self.server_url}")
        logger.info("Загрузка модели WhisperAnchorBackend на GPU...")
        self.backend = WhisperAnchorBackend()
        logger.info("LyricsWorker готов к работе.")

    def get_pending_job(self) -> Optional[Dict[str, Any]]:
        """Запрашивает у сервера следующую задачу из очереди."""
        try:
            url = f"{self.server_url}/api/lyrics-jobs/pending"
            res = requests.get(url, timeout=5)
            if res.status_code == 200:
                data = res.json()
                return data.get("job")
        except Exception as e:
            logger.warning(f"Ошибка проверки очереди на сервере {self.server_url}: {e}")
        return None

    def update_job_status(
        self,
        track_id: str,
        status: str,
        stage: Optional[str] = None,
        progress: int = 0,
        error: Optional[str] = None,
    ):
        """Отправляет промежуточный статус на сервер для отображения в UI."""
        try:
            url = f"{self.server_url}/api/tracks/{track_id}/lyrics-job-update"
            requests.post(
                url,
                json={
                    "status": status,
                    "stage": stage,
                    "progress": progress,
                    "error": error,
                },
                timeout=5,
            )
        except Exception as e:
            logger.warning(f"Не удалось обновить статус задачи для трека {track_id}: {e}")

    def download_track_audio(self, track_id: str) -> Path:
        """Скачивает аудиофайл трека через стриминговый эндпоинт сервера."""
        stream_url = f"{self.server_url}/api/stream/{track_id}"
        dest_path = TEMP_DIR / f"worker_{track_id}.mp3"
        
        logger.info(f"Скачивание аудио: {stream_url} -> {dest_path}")
        with requests.get(stream_url, stream=True, timeout=30) as r:
            r.raise_for_status()
            with open(dest_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=65536):
                    if chunk:
                        f.write(chunk)

        if not dest_path.is_file() or dest_path.stat().st_size < 1024:
            raise RuntimeError(f"Скачанный файл пустой или повреждён: {dest_path}")

        return dest_path

    def get_reference_lyrics(self, track_id: str, title: str, artist: str) -> tuple[str, str]:
        """
        Получает канонический reference-текст:
        1. С сервера /api/tracks/{track_id}/lyrics
        2. Из внешнего LRCLIB
        """
        lyrics_text = ""
        lyrics_source = "embedded_plain"

        try:
            res = requests.get(f"{self.server_url}/api/tracks/{track_id}/lyrics", timeout=5)
            if res.status_code == 200:
                data = res.json()
                synced = data.get("syncedLyrics")
                plain = data.get("plainLyrics")
                server_source = data.get("lyricsSource") or data.get("referenceSource")
                if synced and is_synced_lrc(synced):
                    lyrics_text = synced
                    lyrics_source = server_source or "embedded_synced_lrc"
                elif plain:
                    # Point 2: Server only has plain lyrics. Check LRCLIB for true synced LRC before accepting plain!
                    if title:
                        found_synced = fetch_lrclib_lyrics(title, artist)
                        if found_synced and is_synced_lrc(found_synced):
                            lyrics_text = found_synced
                            lyrics_source = "lrclib_synced_lrc"
                    if not lyrics_text:
                        lyrics_text = plain
                        lyrics_source = server_source or "embedded_plain"
        except Exception as e:
            logger.warning(f"Ошибка получения текста с сервера: {e}")

        if not lyrics_text and title:
            logger.info(f"Текст отсутствует на сервере. Поиск в LRCLIB для '{title} - {artist}'...")
            found = fetch_lrclib_lyrics(title, artist)
            if found:
                lyrics_text = found
                lyrics_source = "lrclib_synced_lrc" if is_synced_lrc(found) else "lrclib_plain"

        if not lyrics_text:
            raise ValueError(f"Не найден референтный текст для трека '{title}' (id={track_id})")

        return lyrics_text, lyrics_source

    def save_result_to_server(
        self,
        track_id: str,
        result: AlignmentResult,
        lyrics_source: str,
        plain_lyrics: Optional[str] = None,
    ):
        """Отправляет готовые результаты на сервер."""
        url = f"{self.server_url}/api/tracks/{track_id}/save-word-lyrics"
        if lyrics_source == "whisper_generated":
            lyrics_status = "draft_generated"
        elif result.anchor_coverage < 0.80:
            lyrics_status = "partial_anchor"
        else:
            lyrics_status = "word_synced"

        payload = {
            "word_data": result.to_dict(),
            "lyrics_source": lyrics_source,
            "lyrics_status": lyrics_status,
            "lyrics_language": result.language,
            "lyrics": plain_lyrics,
        }
        res = requests.post(url, json=payload, timeout=15)
        res.raise_for_status()
        logger.info(f"✅ Результаты для трека {track_id} успешно сохранены на сервере (status={lyrics_status}).")

    def process_track(self, track_id: str, language: Optional[str] = None):
        """Полный цикл выравнивания одного трека на GPU."""
        logger.info(f"==================================================")
        logger.info(f"Начало обработки трека: {track_id}")
        t0 = time.time()

        local_audio: Optional[Path] = None
        try:
            # 1. Получение метаданных
            track_meta_res = requests.get(f"{self.server_url}/api/tracks/{track_id}", timeout=5)
            if track_meta_res.status_code == 200:
                meta = track_meta_res.json()
                title = meta.get("title", "")
                artist = meta.get("artist", "")
            else:
                title, artist = "", ""

            # 2. Получение референса
            self.update_job_status(track_id, status="processing", stage="Поиск референтного текста...", progress=10)
            lyrics_text, lyrics_source = self.get_reference_lyrics(track_id, title, artist)
            ref_lines = parse_reference_lrc(lyrics_text)
            anchors_info = inspect_reference_anchors(ref_lines)
            logger.info(f"Референтный текст: {len(ref_lines)} строк, anchors={anchors_info['anchored_lines']}, coverage={anchors_info['coverage']}, источник: {lyrics_source}")

            # Point 3: If coverage == 0, refuse anchored alignment and honestly save plain lyrics
            if anchors_info["coverage"] == 0.0:
                logger.info(f"Трек {track_id} не имеет line anchors (plain text). Сохраняем без word alignment.")
                url = f"{self.server_url}/api/tracks/{track_id}/save-word-lyrics"
                requests.post(url, json={
                    "word_data": None,
                    "lyrics_source": lyrics_source,
                    "lyrics_status": "plain",
                    "lyrics_language": "ru",
                    "lyrics": lyrics_text,
                }, timeout=15)
                self.update_job_status(track_id, status="completed", stage="Готово (текст без таймингов)", progress=100)
                return

            # 3. Скачивание аудио
            self.update_job_status(track_id, status="processing", stage="Скачивание аудио...", progress=25)
            local_audio = self.download_track_audio(track_id)

            # 4. GPU Forced Alignment
            self.update_job_status(track_id, status="processing", stage="Инференс на GPU (RTX 4070)...", progress=50)
            logger.info("Запуск WhisperAnchorBackend на RTX 4070...")
            align_t0 = time.time()
            result = self.backend.align(str(local_audio), ref_lines, language=language)
            result.reference_source = lyrics_source
            align_dur = round(time.time() - align_t0, 2)

            stats = result.stats
            logger.info(
                f"Инференс завершен за {align_dur}с! "
                f"Слов: {stats.get('reference_words_count')}, "
                f"Matched: {stats.get('matched_words')} ({stats.get('final_word_level_match_rate_pct')}%), "
                f"Interpolated: {stats.get('interpolated_words')}"
            )

            # 5. Сохранение на сервер
            self.update_job_status(track_id, status="processing", stage="Сохранение на сервере...", progress=90)
            self.save_result_to_server(track_id, result, lyrics_source, plain_lyrics=lyrics_text)

            total_dur = round(time.time() - t0, 2)
            logger.info(f"🎉 Задача завершена за {total_dur}с! (id={track_id})")

        except Exception as e:
            logger.error(f"❌ Ошибка обработки трека {track_id}: {e}", exc_info=True)
            self.update_job_status(track_id, status="failed", stage="Ошибка", progress=100, error=str(e))
        finally:
            if local_audio and local_audio.is_file():
                try:
                    local_audio.unlink()
                    logger.debug(f"Временный аудиофайл удален: {local_audio}")
                except Exception:
                    pass

    def run_daemon(self, poll_interval: float = 2.0):
        """Фоновый цикл опроса очереди задач."""
        logger.info(f"Запущен фоновый демон LyricsWorker. Опрос сервера {self.server_url} каждые {poll_interval}с.")
        while True:
            try:
                job = self.get_pending_job()
                if job:
                    track_id = job.get("track_id")
                    lang = job.get("language")
                    logger.info(f"Получена новая задача из очереди: {track_id} (lang={lang})")
                    self.process_track(track_id, language=lang)
                else:
                    time.sleep(poll_interval)
            except KeyboardInterrupt:
                logger.info("Остановка LyricsWorker по сигналу пользователя.")
                break
            except Exception as e:
                logger.error(f"Ошибка в цикле демона: {e}")
                time.sleep(poll_interval)


def main():
    parser = argparse.ArgumentParser(description="Puuk Lyrics GPU Worker (RTX 4070)")
    parser.add_argument("--server", default=DEFAULT_SERVER_URL, help=f"URL сервера Puuk (по умолчанию {DEFAULT_SERVER_URL})")
    parser.add_argument("--track", help="Обработать конкретный track_id и выйти")
    parser.add_argument("--interval", type=float, default=2.0, help="Интервал опроса очереди (сек)")
    args = parser.parse_args()

    worker = LyricsWorker(server_url=args.server)

    if args.track:
        worker.process_track(args.track)
    else:
        worker.run_daemon(poll_interval=args.interval)


if __name__ == "__main__":
    main()
