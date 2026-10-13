import argparse
from datetime import datetime, timezone
import getpass
import json
import logging
import os
import shutil
import sys
import uuid
from pathlib import Path
from typing import Optional, Tuple
import urllib.request

os.environ["HF_ENDPOINT"] = "https://hf-api.gitee.com"
import time
import numpy as np
import paramiko
import essentia.standard as es
from qdrant_client import QdrantClient
from qdrant_client.http.models import Filter, FieldCondition, MatchValue, PointStruct

# Добавляем brain в sys.path для корректных импортов
BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

import db
from services.audio_genre_classifier import (
    AudioGenreClassifier,
    AUTO_GENRE_MIN_CONFIDENCE,
    AUTO_GENRE_TOP_K,
)
from services.loudness import (
    measure_file_loudness,
    calculate_normalization_gain,
    LoudnessMeasurement,
    ANALYSIS_VERSION as LOUDNESS_ANALYSIS_VERSION,
)

# --- Конфигурация ---
SERVER_IP = os.getenv("SERVER_IP", "192.168.1.117")
SERVER_SSH_PORT = int(os.getenv("SERVER_SSH_PORT", "59348"))
SERVER_USER = os.getenv("SERVER_USER", "fish")
WORKER_REQUEST_TIMEOUT_SEC = float(os.getenv("WORKER_REQUEST_TIMEOUT_SEC", "30"))
WORKER_SSH_TIMEOUT_SEC = float(os.getenv("WORKER_SSH_TIMEOUT_SEC", "30"))

QDRANT_URL = os.getenv("QDRANT_URL", f"http://{SERVER_IP}:6333")
COLLECTION_NAME = "tracks"

REMOTE_MUSIC_DIR = os.getenv("REMOTE_MUSIC_DIR", "/mnt/data/projects/puuk/music")
WORKER_AUDIO_MODE = os.getenv("WORKER_AUDIO_MODE", "sftp").lower()
WORKER_MUSIC_DIR = os.getenv("WORKER_MUSIC_DIR", os.getenv("MUSIC_DIR", REMOTE_MUSIC_DIR))
TEMP_DIR = Path("./temp_audio")
VECTOR_SIZE = 400

AUTO_GENRE_ENABLED = os.getenv("AUTO_GENRE_ENABLED", "true").lower() in ("true", "1", "yes")
AUTO_GENRE_BACKFILL = os.getenv("AUTO_GENRE_BACKFILL", "false").lower() in ("true", "1", "yes")
AUTO_GENRE_BACKFILL_LIMIT = int(os.getenv("AUTO_GENRE_BACKFILL_LIMIT", "0")) or None

MAX_LOUDNESS_RETRIES = int(os.getenv("MAX_LOUDNESS_RETRIES", "3"))
LOUDNESS_RETRY_COOLDOWN_SEC = int(os.getenv("LOUDNESS_RETRY_COOLDOWN_SEC", "300"))

MODEL_FILENAME = BASE_DIR / "discogs-effnet-bs64-1.pb"
MODEL_URL = "https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb"

GENRE_MODEL_FILENAME = BASE_DIR / "genre_discogs400-discogs-effnet-1.pb"
GENRE_MODEL_URL = "https://essentia.upf.edu/models/classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.pb"

GENRE_LABELS_FILENAME = BASE_DIR / "genre_discogs400-discogs-effnet-1.json"
GENRE_LABELS_URL = "https://essentia.upf.edu/models/classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.json"

# Настройка логирования
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [HeavyWorker] [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger(__name__)

# Глобальный кэш пароля для SSH
SSH_PASSWORD = None


class LocalAudioSource:
    """SFTP-compatible adapter for audio files on the worker host."""

    def __init__(self, root: str):
        self.root = Path(root).resolve()

    def _path(self, file_path: str) -> Path:
        path = (self.root / file_path).resolve()
        if path != self.root and self.root not in path.parents:
            raise ValueError(f"Путь аудио выходит за пределы MUSIC_DIR: {file_path}")
        return path

    def stat(self, file_path: str):
        return self._path(file_path).stat()

    def get(self, file_path: str, local_path: str):
        source = self._path(file_path)
        if not source.is_file():
            raise FileNotFoundError(source)
        shutil.copyfile(source, local_path)

    def close(self):
        return None


def setup_audio_source():
    """Returns (optional SSH client, file source) for the selected mode."""
    if WORKER_AUDIO_MODE == "local":
        logger.info("Режим аудио: local (%s), SFTP не используется.", WORKER_MUSIC_DIR)
        return None, LocalAudioSource(WORKER_MUSIC_DIR)
    if WORKER_AUDIO_MODE != "sftp":
        raise ValueError("WORKER_AUDIO_MODE должен быть 'local' или 'sftp'")
    return setup_sftp()


def audio_source_path(file_path: str) -> str:
    if WORKER_AUDIO_MODE == "local":
        return file_path
    return f"{REMOTE_MUSIC_DIR}/{file_path}"


def setup_sftp() -> Tuple[paramiko.SSHClient, paramiko.SFTPClient]:
    """Установка SSH и SFTP соединения с сервером."""
    global SSH_PASSWORD
    logger.info(f"Подключение по SSH к {SERVER_USER}@{SERVER_IP}:{SERVER_SSH_PORT}...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    connect_kwargs = {
        "hostname": SERVER_IP,
        "port": SERVER_SSH_PORT,
        "username": SERVER_USER,
        "look_for_keys": True,
        "timeout": WORKER_SSH_TIMEOUT_SEC,
        "banner_timeout": WORKER_SSH_TIMEOUT_SEC,
        "auth_timeout": WORKER_SSH_TIMEOUT_SEC,
    }

    ssh_config_path = os.path.expanduser("~/.ssh/config")
    if os.path.exists(ssh_config_path):
        ssh_config = paramiko.SSHConfig()
        with open(ssh_config_path) as f:
            ssh_config.parse(f)
        host_config = ssh_config.lookup(SERVER_IP)
        if "identityfile" in host_config:
            connect_kwargs["key_filename"] = host_config["identityfile"]

    if SSH_PASSWORD is not None:
        connect_kwargs["password"] = SSH_PASSWORD
        connect_kwargs["look_for_keys"] = False

    try:
        ssh.connect(**connect_kwargs)
    except paramiko.ssh_exception.AuthenticationException:
        if SSH_PASSWORD is not None:
            logger.error("Сохраненный пароль SSH не подходит. Запрашиваем заново.")
            SSH_PASSWORD = None

        logger.warning("Аутентификация по ключам не удалась. Переход на ввод пароля.")
        password = getpass.getpass(f"Пароль для {SERVER_USER}@{SERVER_IP}: ")
        connect_kwargs["password"] = password
        connect_kwargs["look_for_keys"] = False
        try:
            ssh.connect(**connect_kwargs)
            SSH_PASSWORD = password
        except Exception as e:
            logger.error(f"Ошибка подключения по паролю: {e}")
            raise e
    except Exception as e:
        logger.error(f"Ошибка подключения по SSH: {e}")
        raise e

    sftp = ssh.open_sftp()
    logger.info("SFTP соединение успешно установлено.")
    return ssh, sftp


def parse_artist_from_path(file_path: str) -> Optional[str]:
    """Извлекает исполнителя из имени файла вида 'Artist - Title.ext'.

    Без обращения к диску. Используется как fallback для точек, у которых
    payload ещё не содержит 'artist'.
    """
    if not file_path:
        return None
    name = Path(file_path).stem
    if " - " not in name:
        return None
    return name.split(" - ", 1)[0].strip() or None


def ensure_model_file(filepath: Path, url: str, description: str) -> bool:
    """Проверяет наличие файла модели, при отсутствии пытается скачать."""
    if filepath.exists():
        return True
    logger.info(f"Скачивание {description} из {url}...")
    try:
        urllib.request.urlretrieve(url, str(filepath))
        logger.info(f"{description} успешно скачан: {filepath}")
        return True
    except Exception as e:
        logger.error(f"Не удалось скачать {description} из {url}: {e}")
        return False


def init_models():
    """Загрузка моделей для экстракции эмбеддингов и классификации жанров."""
    if not ensure_model_file(MODEL_FILENAME, MODEL_URL, "модель discogs-effnet"):
        logger.error("Критическая ошибка: отсутствует основная модель эмбеддингов.")
        return None, None

    logger.info("Инициализация исторической модели discogs-effnet...")
    try:
        # Исторический экстрактор puuk: возвращает напрямую 400-мерные предсказания PartitionedCall
        extractor = es.TensorflowPredictEffnetDiscogs(graphFilename=str(MODEL_FILENAME))
    except Exception as e:
        logger.error(f"Ошибка загрузки модели discogs-effnet: {e}")
        return None, None

    genre_classifier = None
    if AUTO_GENRE_ENABLED:
        has_pb = ensure_model_file(GENRE_MODEL_FILENAME, GENRE_MODEL_URL, "модель жанров Discogs-400 (.pb)")
        has_json = ensure_model_file(GENRE_LABELS_FILENAME, GENRE_LABELS_URL, "метки жанров Discogs-400 (.json)")
        if has_json:
            try:
                genre_classifier = AudioGenreClassifier(
                    model_path=str(GENRE_MODEL_FILENAME) if has_pb else None,
                    labels_path=str(GENRE_LABELS_FILENAME),
                    min_confidence=AUTO_GENRE_MIN_CONFIDENCE,
                    top_k=AUTO_GENRE_TOP_K,
                )
                logger.info("Классификатор авто-жанров успешно инициализирован.")
            except Exception as e:
                logger.error(f"Ошибка инициализации AudioGenreClassifier: {e}")
                genre_classifier = None
        else:
            logger.warning("Файлы меток жанров недоступны, классификация жанров отключена.")

    return extractor, genre_classifier


def get_unprocessed_tracks(client: QdrantClient) -> list:
    """Поиск всех треков с needs_embedding=True через Scroll API."""
    logger.info("Ищу треки, ожидающие ML-анализа (needs_embedding=True)...")
    unprocessed = []
    offset = None

    while True:
        try:
            records, next_page = client.scroll(
                collection_name=COLLECTION_NAME,
                scroll_filter=Filter(
                    must=[
                        FieldCondition(
                            key="needs_embedding",
                            match=MatchValue(value=True),
                        )
                    ],
                    must_not=[FieldCondition(key="embedding_status", match=MatchValue(value="missing_file"))],
                ),
                limit=100,
                offset=offset,
                with_payload=True,
                with_vectors=False,
            )
            unprocessed.extend(records)
            if next_page is None:
                break
            offset = next_page
        except Exception as e:
            logger.error(f"Ошибка при запросе к Qdrant: {e}")
            raise

    return unprocessed


def sync_sqlite_tracks_to_qdrant(
    client: QdrantClient,
    limit: Optional[int] = None,
    source=None,
) -> int:
    """Creates queue points for tracks known to SQLite but absent in Qdrant.

    NOTE: this reads the SQLite file of the machine the worker runs on, which is
    not the server catalog. For server-side recovery use
    ``brain/reconcile_embedding_queue.py`` (or the API periodic reconciliation),
    which read the server database.

    The API/library scanner owns SQLite metadata, while the legacy audio
    scanner owns Qdrant queue points. New files can therefore be visible in
    the catalog without ever entering the embedding worker queue.
    """
    existing_ids = set()
    existing_paths = set()
    offset = None
    while True:
        records, next_page = client.scroll(
            collection_name=COLLECTION_NAME,
            limit=250,
            offset=offset,
            with_payload=True,
            with_vectors=False,
        )
        existing_ids.update(str(record.id) for record in records)
        existing_paths.update(
            str((record.payload or {}).get("file_path"))
            for record in records
            if (record.payload or {}).get("file_path")
        )
        if next_page is None:
            break
        offset = next_page

    missing_points = []
    for track in db.get_all_tracks():
        track_id = str(track["id"])
        file_path = str(track.get("file_path") or track_id)
        if track_id in existing_ids or file_path in existing_paths:
            continue
        try:
            uuid.UUID(track_id)
            point_id = track_id
        except ValueError:
            if track_id.isascii() and track_id.isdecimal() and int(track_id) < 2**64:
                point_id = int(track_id)
            else:
                logger.debug("Пропускаю SQLite-запись с невалидным Qdrant ID: %s", track_id)
                continue
        # A worker's local SQLite can contain deleted tracks or old test data.
        # Only a file still present on the audio host may enter the queue.
        if source is None:
            raise ValueError("Для восстановления очереди нужен источник аудиофайлов")
        try:
            source.stat(audio_source_path(file_path))
        except FileNotFoundError:
            logger.info("Не восстанавливаю отсутствующий аудиофайл: %s", file_path)
            continue

        loudness_status = track.get("loudness_status") or "pending"
        payload = {
            "file_path": file_path,
            "title": track.get("title") or track_id,
            "artist": track.get("artist") or "Неизвестный исполнитель",
            "duration": track.get("duration"),
            "genre": track.get("genre"),
            "lyrics": track.get("lyrics"),
            "needs_embedding": True,
            "loudness_status": loudness_status,
            "loudness_lufs": track.get("loudness_lufs"),
            "true_peak_db": track.get("true_peak_db"),
            "normalization_gain_db": track.get("normalization_gain_db"),
            "loudness_analysis_version": track.get("loudness_analysis_version"),
            "loudness_file_size": track.get("loudness_file_size"),
            "loudness_file_mtime_ns": track.get("loudness_file_mtime_ns"),
            "loudness_error": track.get("loudness_error"),
            "loudness_retry_count": track.get("loudness_retry_count") or 0,
            "file_size": track.get("file_size"),
            "file_mtime_ns": track.get("file_mtime_ns"),
        }
        missing_points.append(
            PointStruct(id=point_id, vector=[0.0] * VECTOR_SIZE, payload=payload)
        )
        existing_paths.add(file_path)
        if limit and len(missing_points) >= limit:
            break

    if not missing_points:
        return 0

    client.upsert(collection_name=COLLECTION_NAME, points=missing_points)
    logger.info("Добавлено в очередь Qdrant из SQLite: %d треков.", len(missing_points))
    return len(missing_points)


def get_backfill_tracks(
    client: QdrantClient,
    limit: Optional[int] = None,
    include_failed: bool = False,
) -> list:
    """Поиск обработанных треков, у которых еще нет auto_genres."""
    logger.info("Ищу треки для backfill авто-жанров...")
    backfill_tracks = []
    offset = None

    while True:
        try:
            records, next_page = client.scroll(
                collection_name=COLLECTION_NAME,
                scroll_filter=Filter(
                    must=[
                        FieldCondition(
                            key="needs_embedding",
                            match=MatchValue(value=False),
                        )
                    ]
                ),
                limit=100,
                offset=offset,
                with_payload=True,
                with_vectors=True,
            )
            for r in records:
                payload = r.payload or {}
                # Empty [] is a valid completed classification. Only retry points
                # that have never received a classification result.
                status = payload.get("auto_genre_status")
                if status == "classified":
                    continue
                if status == "failed":
                    if not include_failed:
                        continue
                # Payloads written before status tracking already contain a
                # completed result. Do not re-run ML for those tracks.
                elif payload.get("auto_genres"):
                    continue
                backfill_tracks.append(r)
                if limit and len(backfill_tracks) >= limit:
                    return backfill_tracks

            if next_page is None:
                break
            offset = next_page
        except Exception as e:
            logger.error(f"Ошибка при поиске треков для backfill в Qdrant: {e}")
            raise

    return backfill_tracks


def should_retry_failed_loudness(db_track: Optional[dict]) -> bool:
    """Проверяет, можно ли повторить анализ трека со статусом failed."""
    if not db_track:
        return False
    retries = db_track.get("loudness_retry_count") or 0
    if retries >= MAX_LOUDNESS_RETRIES:
        return False
    analyzed_at_str = db_track.get("loudness_analyzed_at")
    if not analyzed_at_str:
        return True
    try:
        analyzed_dt = datetime.strptime(analyzed_at_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        now_dt = datetime.now(timezone.utc)
        elapsed = (now_dt - analyzed_dt).total_seconds()
        return elapsed >= LOUDNESS_RETRY_COOLDOWN_SEC
    except Exception:
        return True


def get_loudness_tracks(
    client: QdrantClient,
    limit: Optional[int] = None,
    include_failed: bool = False,
    version: str = LOUDNESS_ANALYSIS_VERSION,
) -> list:
    """Поиск треков, требующих анализа нормализации громкости."""
    logger.info("Ищу треки для анализа громкости (loudness_status=pending)...")
    loudness_tracks = []
    offset = None

    while True:
        try:
            records, next_page = client.scroll(
                collection_name=COLLECTION_NAME,
                scroll_filter=Filter(
                    should=[
                        FieldCondition(key="loudness_status", match=MatchValue(value="pending")),
                        FieldCondition(key="loudness_status", match=MatchValue(value="failed")),
                        FieldCondition(key="loudness_status", match=MatchValue(value="processing")),
                    ],
                ),
                limit=100,
                offset=offset,
                with_payload=True,
                with_vectors=False,
            )
            for r in records:
                payload = r.payload or {}
                status = payload.get("loudness_status")
                analyzed_ver = payload.get("loudness_analysis_version")

                # Сверяемся со SQLite, если возможно (создаем запись при отсутствии)
                point_id = str(r.id)
                db_track = db.get_track(point_id)
                if not db_track:
                    ensure_track_in_sqlite(point_id, payload)
                    db_track = db.get_track(point_id)

                payload_status = status
                if db_track:
                    db_status = db_track.get("loudness_status")
                    # Qdrant is the work queue shared with the scanner/API.
                    # Never hide an explicit queued state from it with a
                    # stale local "analyzed" value (the worker and API may
                    # intentionally use different SQLite files).
                    if payload_status in ("pending", "failed", "processing"):
                        status = payload_status
                    elif db_status:
                        status = db_status
                    db_ver = db_track.get("loudness_analysis_version")
                    if db_ver:
                        analyzed_ver = db_ver

                needs_analysis = False
                if status in (None, "pending"):
                    needs_analysis = True
                elif status == "failed":
                    if include_failed or should_retry_failed_loudness(db_track):
                        needs_analysis = True
                elif status == "analyzed" and analyzed_ver != version:
                    needs_analysis = True

                # Проверка изменения файла: size/mtime (по SQLite или payload)
                if not needs_analysis:
                    curr_size = (db_track.get("file_size") if db_track else None) or payload.get("file_size")
                    curr_mtime = (db_track.get("file_mtime_ns") if db_track else None) or payload.get("file_mtime_ns")
                    l_size = (db_track.get("loudness_file_size") if db_track else None) or payload.get("loudness_file_size")
                    l_mtime = (db_track.get("loudness_file_mtime_ns") if db_track else None) or payload.get("loudness_file_mtime_ns")
                    if curr_size is not None and l_size is not None and curr_size != l_size:
                        needs_analysis = True
                    elif curr_mtime is not None and l_mtime is not None and curr_mtime != l_mtime:
                        needs_analysis = True

                if needs_analysis:
                    loudness_tracks.append(r)
                    if limit and len(loudness_tracks) >= limit:
                        return loudness_tracks

            if next_page is None:
                break
            offset = next_page
        except Exception as e:
            logger.error(f"Ошибка при поиске треков для анализа громкости в Qdrant: {e}")
            raise

    return loudness_tracks


def process_loudness_for_track(
    qdrant_client: QdrantClient,
    record,
    sftp: paramiko.SFTPClient,
) -> bool:
    """Выполняет ffmpeg loudnorm анализ одного трека, обновляет SQLite и Qdrant."""
    point_id = str(record.id)
    payload = record.payload or {}
    file_path = payload.get("file_path")
    if not file_path:
        logger.warning(f"[Loudness] У записи {point_id} нет file_path. Пропускаем.")
        return False

    ensure_track_in_sqlite(point_id, payload)
    db.set_track_loudness_status(point_id, "processing")

    remote_path = audio_source_path(file_path)
    local_filename = f"loud_{Path(file_path).name}"
    local_path = TEMP_DIR / local_filename

    # 1. Скачиваем файл через SFTP
    try:
        logger.info(f"[Loudness] Скачивание {remote_path} -> {local_path} ...")
        remote_stat = sftp.stat(remote_path)
        remote_size = remote_stat.st_size
        remote_mtime_sec = int(remote_stat.st_mtime)

        # Унификация mtime со SQLite, чтобы не было расхождений nanoseconds vs seconds
        db_track = db.get_track(point_id)
        if db_track and db_track.get("file_mtime_ns"):
            db_mtime_sec = db_track["file_mtime_ns"] // 1_000_000_000
            if db_mtime_sec == remote_mtime_sec:
                remote_mtime_ns = db_track["file_mtime_ns"]
            else:
                remote_mtime_ns = remote_mtime_sec * 1_000_000_000
        else:
            remote_mtime_ns = remote_mtime_sec * 1_000_000_000

        sftp.get(remote_path, str(local_path))
    except Exception as e:
        logger.error(f"[Loudness] Не удалось скачать {remote_path}: {e}")
        db.set_track_loudness_status(point_id, "failed", error=str(e))
        updated_track = db.get_track(point_id) or {}
        try:
            qdrant_client.set_payload(
                collection_name=COLLECTION_NAME,
                points=[point_id],
                payload={
                    "loudness_status": "failed",
                    "normalization_gain_db": None,
                    "loudness_error": str(e),
                    "loudness_retry_count": updated_track.get("loudness_retry_count", 1),
                },
            )
        except Exception:
            pass
        if local_path.exists():
            try:
                os.remove(local_path)
            except Exception:
                pass
        return False

    try:
        # 2. Выполняем анализ loudnorm
        logger.info(f"[Loudness] Анализ громкости для {file_path} ...")
        measurement = measure_file_loudness(local_path)
        logger.info(
            f"[Loudness] {file_path}: I={measurement.loudness_lufs} LUFS, "
            f"TP={measurement.true_peak_db} dBTP -> gain={measurement.normalization_gain_db} dB"
        )

        # 3. Сохраняем в SQLite
        db.update_track_loudness(
            track_id=point_id,
            loudness_lufs=measurement.loudness_lufs,
            true_peak_db=measurement.true_peak_db,
            normalization_gain_db=measurement.normalization_gain_db,
            status="analyzed",
            analysis_version=measurement.analysis_version,
            file_size=remote_size,
            file_mtime_ns=remote_mtime_ns,
        )

        # 4. Обновляем Qdrant payload
        qdrant_client.set_payload(
            collection_name=COLLECTION_NAME,
            points=[point_id],
            payload={
                "loudness_status": "analyzed",
                "loudness_lufs": measurement.loudness_lufs,
                "true_peak_db": measurement.true_peak_db,
                "normalization_gain_db": measurement.normalization_gain_db,
                "loudness_analysis_version": measurement.analysis_version,
                "loudness_file_size": remote_size,
                "loudness_file_mtime_ns": remote_mtime_ns,
                "loudness_error": None,
                "loudness_retry_count": 0,
            },
        )
        return True
    except Exception as e:
        logger.error(f"[Loudness] Ошибка анализа громкости для {file_path}: {e}")
        db.set_track_loudness_status(point_id, "failed", error=str(e))
        updated_track = db.get_track(point_id) or {}
        try:
            qdrant_client.set_payload(
                collection_name=COLLECTION_NAME,
                points=[point_id],
                payload={
                    "loudness_status": "failed",
                    "normalization_gain_db": None,
                    "loudness_error": str(e),
                    "loudness_retry_count": updated_track.get("loudness_retry_count", 1),
                },
            )
        except Exception:
            pass
        return False
    finally:
        if local_path.exists():
            try:
                os.remove(local_path)
            except Exception:
                pass


def run_loudness_backfill(
    qdrant_client: QdrantClient,
    limit: Optional[int] = None,
    retry_failed: bool = False,
) -> int:
    """Запускает процесс backfill нормализации громкости для треков."""
    logger.info(f"[Loudness Backfill] Поиск треков (limit={limit}, retry_failed={retry_failed})...")
    tracks = get_loudness_tracks(qdrant_client, limit=limit, include_failed=retry_failed)
    if not tracks:
        logger.info("[Loudness Backfill] Нет треков для анализа громкости.")
        return 0

    logger.info(f"[Loudness Backfill] Найдено {len(tracks)} треков для анализа.")
    try:
        ssh, sftp = setup_audio_source()
    except Exception as e:
        logger.error(f"[Loudness Backfill] Ошибка SSH подключения: {e}")
        return 0

    processed_count = 0
    try:
        for r in tracks:
            success = process_loudness_for_track(qdrant_client, r, sftp)
            if success:
                processed_count += 1
    finally:
        sftp.close()
        if ssh:
            ssh.close()
        logger.info(f"[Loudness Backfill] Завершено. Успешно обработано: {processed_count}/{len(tracks)}")

    return processed_count


def process_audio_file(
    local_path: Path,
    extractor,
    genre_classifier: Optional[AudioGenreClassifier],
) -> Tuple[list[float], Optional[list[dict]], Optional[str], Optional[str]]:
    """Загружает аудио, получает исходный 400-мерный вектор и авто-жанры.

    Гарантирует 100% обратную совместимость векторного пространства:
    new_vector вычисляется напрямую из выхода исторического extractor(audio).
    """
    audio = es.MonoLoader(filename=str(local_path), sampleRate=16000)()

    # 1. Исторический 400-d вектор (PartitionedCall)
    frame_predictions = extractor(audio)
    new_vector = np.mean(frame_predictions, axis=0).tolist()

    auto_genres = None
    auto_genre_model = None
    auto_genre_updated_at = None

    # 2. Определение жанров из предсказаний фреймов
    if genre_classifier is not None:
        try:
            auto_genres = genre_classifier.predict(frame_predictions)
            auto_genre_model = genre_classifier.model_name
            from datetime import datetime, timezone
            auto_genre_updated_at = datetime.now(timezone.utc).isoformat()
        except Exception as e:
            logger.error(f"Ошибка классификации жанров через genre_classifier: {e}")

    return new_vector, auto_genres, auto_genre_model, auto_genre_updated_at


def update_database_records(
    qdrant_client: QdrantClient,
    point_id: str,
    vector: list[float],
    payload: dict,
    auto_genres: Optional[list[dict]],
    auto_genre_model: Optional[str],
    auto_genre_updated_at: Optional[str] = None,
) -> bool:
    """Обновляет запись в SQLite и Qdrant.

    Сначала обновляет SQLite; если SQLite завершился ошибкой, прерывает операцию,
    предотвращая рассинхронизацию баз данных.
    """
    ensure_track_in_sqlite(str(point_id), payload)

    # SQLite is the durable source for pending delivery. An empty list is still
    # a completed classification and must not be confused with "not processed".
    if auto_genres is not None:
        try:
            db.update_track_auto_genres(
                str(point_id),
                auto_genres,
                auto_genre_model,
                auto_genre_updated_at,
                sync_pending=True,
            )
        except Exception as e:
            logger.error(f"Критическая ошибка обновления SQLite auto_genres для {point_id}: {e}")
            raise e
    else:
        db.mark_auto_genre_failed(str(point_id))

    # 2. Обновление Qdrant
    payload["needs_embedding"] = False

    if auto_genres is not None:
        payload["auto_genres"] = auto_genres
        payload["auto_genre_model"] = auto_genre_model
        payload["auto_genre_status"] = "classified"
        if auto_genre_updated_at:
            payload["auto_genre_updated_at"] = auto_genre_updated_at
    else:
        payload.pop("auto_genres", None)
        payload.pop("auto_genre_model", None)
        payload.pop("auto_genre_updated_at", None)
        payload["auto_genre_status"] = "failed"

    # Удаляем старые эвристические поля
    keys_to_remove = ["energy", "danceability", "acousticness", "vocal", "aggressive", "happy", "relaxed"]
    for k in keys_to_remove:
        payload.pop(k, None)

    try:
        qdrant_client.upsert(
            collection_name=COLLECTION_NAME,
            points=[
                PointStruct(
                    id=point_id,
                    vector=vector,
                    payload=payload,
                )
            ],
        )
    except Exception:
        # Keep the SQLite pending flag set. The resync command will retry the
        # delivery from the durable local record without re-running audio ML.
        raise

    if auto_genres is not None:
        db.mark_auto_genre_sync_complete(str(point_id))

    return True


def ensure_track_in_sqlite(track_id: str, payload: dict) -> None:
    """Создаёт минимальную SQLite-запись для точки, пришедшей только из Qdrant.

    Qdrant может быть заполнен отдельным сканером раньше SQLite. Без этого
    шага UPDATE auto_genres молча затронет ноль строк, и рекомендации не
    увидят результаты классификации.
    """
    if db.get_track(track_id):
        return

    file_path = str(payload.get("file_path") or "")
    title = str(payload.get("title") or Path(file_path).stem or track_id)
    artist = payload.get("artist") or parse_artist_from_path(file_path) or "Неизвестный исполнитель"
    album_title = payload.get("album") or payload.get("album_title")
    album_artist = payload.get("album_artist") or payload.get("albumartist")
    album_id = (
        db.resolve_album(str(album_title), album_artist=(album_artist or artist) if album_title else None)
        if album_title else None
    )
    db.add_or_update_track(
        track_id=track_id,
        file_path=file_path or track_id,
        title=title,
        album_id=album_id,
        artist=str(artist),
        lyrics=payload.get("lyrics"),
        duration=payload.get("duration"),
        genre=payload.get("genre"),
        file_size=payload.get("file_size"),
        file_mtime_ns=payload.get("file_mtime_ns"),
    )


def resync_auto_genres_to_qdrant(client: QdrantClient) -> int:
    """Повторно доставляет pending auto-жанры из SQLite в Qdrant."""
    logger.info("Запуск повторной синхронизации auto_genres из SQLite в Qdrant...")
    synced_count = 0
    for row in db.get_pending_auto_genre_syncs():
        try:
            records = client.retrieve(
                collection_name=COLLECTION_NAME,
                ids=[str(row["id"])],
                with_payload=True,
                with_vectors=True,
            )
            if not records:
                logger.warning("Трек %s отсутствует в Qdrant, пропускаем", row["id"])
                continue
            point = records[0]
            payload = dict(point.payload or {})
            ensure_track_in_sqlite(str(row["id"]), payload)
            payload.update(
                {
                    "auto_genres": json.loads(row["auto_genres"] or "[]"),
                    "auto_genre_model": row["auto_genre_model"],
                    "auto_genre_status": "classified",
                    "auto_genre_updated_at": row["auto_genre_updated_at"],
                }
            )
            client.upsert(
                collection_name=COLLECTION_NAME,
                points=[PointStruct(id=point.id, vector=point.vector, payload=payload)],
            )
            db.mark_auto_genre_sync_complete(str(row["id"]))
            synced_count += 1
        except Exception as e:
            logger.error(f"Ошибка повторной синхронизации трека {row['id']}: {e}")
    logger.info(f"Синхронизировано треков в SQLite: {synced_count}")
    return synced_count


def resync_auto_genres_from_qdrant_to_sqlite(client: QdrantClient) -> int:
    """Восстанавливает SQLite из Qdrant, не перезаписывая локальные pending-данные."""
    logger.info("Запуск синхронизации auto_genres из Qdrant в SQLite...")
    synced_count = 0
    offset = None
    while True:
        records, next_page = client.scroll(
            collection_name=COLLECTION_NAME,
            limit=100,
            offset=offset,
            with_payload=True,
            with_vectors=False,
        )
        for record in records:
            payload = record.payload or {}
            if payload.get("auto_genre_status") != "classified":
                continue
            local = db.get_track(str(record.id))
            if local and local.get("auto_genre_sync_pending"):
                continue
            ensure_track_in_sqlite(str(record.id), payload)
            db.update_track_auto_genres(
                str(record.id),
                payload.get("auto_genres") or [],
                payload.get("auto_genre_model"),
                payload.get("auto_genre_updated_at"),
            )
            synced_count += 1
        if next_page is None:
            break
        offset = next_page
    logger.info(f"Синхронизировано треков в SQLite: {synced_count}")
    return synced_count


def run_backfill(
    qdrant_client: QdrantClient,
    extractor,
    genre_classifier: Optional[AudioGenreClassifier],
    limit: Optional[int] = None,
    retry_failed: bool = False,
):
    """Выполняет классификацию жанров для уже существующих треков без изменения их векторов."""
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    backfill_tracks = get_backfill_tracks(qdrant_client, limit=limit, include_failed=retry_failed)
    logger.info(f"Найдено треков для backfill: {len(backfill_tracks)}")

    if not backfill_tracks:
        return

    ssh, sftp = None, None
    try:
        ssh, sftp = setup_audio_source()
    except Exception as e:
        logger.error(f"Ошибка SSH для backfill: {e}")
        return

    try:
        for record in backfill_tracks:
            point_id = record.id
            payload = record.payload or {}
            file_path = payload.get("file_path")
            if not file_path:
                continue

            remote_path = audio_source_path(file_path)
            local_filename = Path(file_path).name
            local_path = TEMP_DIR / local_filename

            try:
                logger.info(f"[Backfill] Скачивание {remote_path} -> {local_path} ...")
                sftp.get(remote_path, str(local_path))
            except Exception as e:
                logger.error(f"[Backfill] Не удалось скачать {remote_path}: {e}")
                if local_path.exists():
                    try:
                        os.remove(local_path)
                    except Exception:
                        pass
                continue

            try:
                logger.info(f"[Backfill] Анализ жанров для {file_path}...")
                new_vector, auto_genres, auto_genre_model, auto_genre_updated_at = process_audio_file(
                    local_path, extractor, genre_classifier
                )
                # Сохраняем существующий вектор в Qdrant, если он есть
                existing_vector = record.vector if record.vector is not None else new_vector
                update_database_records(
                    qdrant_client, point_id, existing_vector, payload, auto_genres, auto_genre_model, auto_genre_updated_at
                )
                logger.info(f"[Backfill] Авто-жанры для {file_path} успешно сохранены: {auto_genres}")
            except Exception as e:
                logger.error(f"[Backfill] Ошибка обработки {file_path}: {e}")
            finally:
                if local_path.exists():
                    try:
                        os.remove(local_path)
                    except Exception:
                        pass
    finally:
        if sftp:
            sftp.close()
        if ssh:
            ssh.close()
        logger.info("[Backfill] SFTP соединение закрыто. Завершено.")


def main():
    parser = argparse.ArgumentParser(description="Heavy Worker ML analysis & auto genre classification")
    parser.add_argument(
        "--embedding-backfill",
        action="store_true",
        help=(
            "Синхронизировать локальную (машины запуска) SQLite в Qdrant и обработать "
            "очередь embedding один раз. Для восстановления серверного каталога "
            "используйте reconcile_embedding_queue.py"
        ),
    )
    parser.add_argument("--genre-backfill", action="store_true", help="Запустить backfill авто-жанров для существующих треков")
    parser.add_argument("--retry-failed-genres", action="store_true", help="Повторно классифицировать треки с failed статусом")
    parser.add_argument("--loudness-backfill", action="store_true", help="Запустить backfill нормализации громкости для треков")
    parser.add_argument("--retry-failed-loudness", action="store_true", help="Повторно анализировать треки со статусом failed")
    parser.add_argument("--limit", type=int, default=None, help="Ограничение количества треков для backfill")
    parser.add_argument("--retry-qdrant-sync", action="store_true", help="Повторить доставку pending auto_genres из SQLite в Qdrant")
    parser.add_argument("--resync-sqlite", action="store_true", help="Синхронизировать auto_genres из Qdrant в SQLite")
    parser.add_argument("--once", action="store_true", help="Обработать текущую очередь один раз и выйти")
    args = parser.parse_args()

    TEMP_DIR.mkdir(parents=True, exist_ok=True)

    logger.info(f"Подключаюсь к Qdrant по адресу {QDRANT_URL}...")
    try:
        qdrant_client = QdrantClient(
            url=QDRANT_URL,
            timeout=WORKER_REQUEST_TIMEOUT_SEC,
        )
    except Exception as e:
        logger.error(f"Не удалось подключиться к Qdrant: {e}")
        return

    if args.loudness_backfill:
        run_loudness_backfill(qdrant_client, limit=args.limit, retry_failed=args.retry_failed_loudness)
        return

    if args.retry_failed_loudness:
        run_loudness_backfill(qdrant_client, limit=args.limit, retry_failed=True)
        return

    if args.retry_qdrant_sync:
        resync_auto_genres_to_qdrant(qdrant_client)
        return
    if args.resync_sqlite:
        resync_auto_genres_from_qdrant_to_sqlite(qdrant_client)
        return
    extractor, genre_classifier = init_models()
    if extractor is None:
        logger.error("Завершение работы из-за ошибки инициализации моделей.")
        return

    is_backfill = args.genre_backfill or AUTO_GENRE_BACKFILL
    backfill_limit = args.limit or AUTO_GENRE_BACKFILL_LIMIT

    if is_backfill:
        logger.info("Запуск в режиме BACKFILL авто-жанров.")
        run_backfill(
            qdrant_client,
            extractor,
            genre_classifier,
            limit=backfill_limit,
            retry_failed=args.retry_failed_genres,
        )
        return

    if args.retry_failed_genres:
        run_backfill(qdrant_client, extractor, genre_classifier, limit=backfill_limit, retry_failed=True)
        return

    logger.info("Скрипт запущен в режиме постоянного мониторинга новых треков.")
    while True:
        try:
            if args.embedding_backfill:
                sync_ssh, sync_source = setup_audio_source()
                try:
                    sync_sqlite_tracks_to_qdrant(
                        qdrant_client, limit=args.limit, source=sync_source,
                    )
                finally:
                    sync_source.close()
                    if sync_ssh:
                        sync_ssh.close()
            unprocessed_tracks = get_unprocessed_tracks(qdrant_client)
            if args.embedding_backfill and args.limit:
                unprocessed_tracks = unprocessed_tracks[:args.limit]
            loudness_tracks = get_loudness_tracks(qdrant_client, limit=10)
        except Exception as e:
            # Qdrant may close an idle keep-alive connection. Do not leave the
            # worker alive with a poisoned client: rebuild the pool next loop.
            logger.error("Ошибка чтения очередей Qdrant: %s. Пересоздаю клиент.", e)
            try:
                qdrant_client.close()
            except Exception:
                pass
            try:
                qdrant_client = QdrantClient(
                    url=QDRANT_URL,
                    timeout=WORKER_REQUEST_TIMEOUT_SEC,
                )
            except Exception as reconnect_error:
                logger.error("Не удалось пересоздать клиент Qdrant: %s", reconnect_error)
            time.sleep(5)
            continue

        if not unprocessed_tracks and not loudness_tracks:
            if args.once or args.embedding_backfill:
                logger.info("Очередь пуста, завершаю одноразовый запуск.")
                return
            logger.debug("Нет треков для обработки. Ожидание 30 секунд...")
            time.sleep(30)
            continue

        try:
            ssh, sftp = setup_audio_source()
        except Exception as e:
            logger.error("Завершение цикла из-за ошибки SSH. Повтор через 30с.")
            if args.once or args.embedding_backfill:
                raise RuntimeError("Одноразовая обработка остановлена: SFTP недоступен") from e
            time.sleep(30)
            continue

        try:
            processed_any = False

            # 1. Выполнение ML-анализа для новых треков
            if unprocessed_tracks:
                logger.info(f"Найдено треков для ML-обработки: {len(unprocessed_tracks)}.")
                for record in unprocessed_tracks:
                    point_id = record.id
                    payload = record.payload or {}
                    file_path = payload.get("file_path")

                    if not file_path:
                        logger.warning(f"У записи {point_id} нет file_path. Пропускаем.")
                        continue

                    if not payload.get("artist"):
                        parsed_artist = parse_artist_from_path(file_path)
                        if parsed_artist:
                            payload["artist"] = parsed_artist

                    remote_path = audio_source_path(file_path)
                    local_filename = Path(file_path).name
                    local_path = TEMP_DIR / local_filename

                    # Скачиваем файл через SFTP
                    try:
                        logger.info(f"Скачивание {remote_path} -> {local_path} ...")
                        sftp.get(remote_path, str(local_path))
                    except Exception as e:
                        logger.error(f"Не удалось скачать {remote_path}: {e}")
                        if isinstance(e, FileNotFoundError):
                            qdrant_client.set_payload(
                                collection_name=COLLECTION_NAME,
                                points=[point_id],
                                payload={"embedding_status": "missing_file"},
                            )
                        if local_path.exists():
                            try:
                                os.remove(local_path)
                            except Exception:
                                pass
                        continue

                    try:
                        # ML-анализ и предсказание жанров
                        logger.info(f"Файл скачан: {file_path}, начинаю ML-анализ...")
                        new_vector, auto_genres, auto_genre_model, auto_genre_updated_at = process_audio_file(
                            local_path, extractor, genre_classifier
                        )

                        # Обновление Qdrant и SQLite
                        update_database_records(
                            qdrant_client, point_id, new_vector, payload, auto_genres, auto_genre_model, auto_genre_updated_at
                        )
                        logger.info(f"Вектор и метаданные для {file_path} успешно обновлены.")
                        processed_any = True
                    except Exception as e:
                        logger.error(f"Ошибка ML-инференса для {file_path}: {e}")
                    finally:
                        try:
                            if local_path.exists():
                                os.remove(local_path)
                                logger.debug(f"Временный файл удален: {local_path}")
                        except Exception as e:
                            logger.warning(f"Не удалось удалить временный файл {local_path}: {e}")

            # 2. Обработка очереди анализа громкости через единый метод
            if loudness_tracks:
                logger.info(f"Найдено треков для анализа громкости: {len(loudness_tracks)}.")
                for r in loudness_tracks:
                    ok = process_loudness_for_track(qdrant_client, r, sftp)
                    if ok:
                        processed_any = True

        finally:
            try:
                sftp.close()
            finally:
                if ssh:
                    ssh.close()
            logger.info("SFTP соединение закрыто.")

        logger.info("Пакет треков обработан. Проверка новых...")
        if args.once or args.embedding_backfill:
            return
        if not processed_any:
            time.sleep(10)


if __name__ == "__main__":
    main()
