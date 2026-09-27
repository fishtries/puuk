import argparse
from datetime import datetime, timezone
import getpass
import json
import logging
import os
import sys
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

QDRANT_URL = os.getenv("QDRANT_URL", f"http://{SERVER_IP}:6333")
COLLECTION_NAME = "tracks"

REMOTE_MUSIC_DIR = os.getenv("REMOTE_MUSIC_DIR", "/mnt/data/projects/puuk/music")
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
                    ]
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
            break

    return unprocessed


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
            break

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

                if db_track:
                    db_status = db_track.get("loudness_status")
                    if db_status:
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
            break

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

    remote_path = f"{REMOTE_MUSIC_DIR}/{file_path}"
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
        ssh, sftp = setup_sftp()
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
        ssh, sftp = setup_sftp()
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

            remote_path = f"{REMOTE_MUSIC_DIR}/{file_path}"
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
    parser.add_argument("--genre-backfill", action="store_true", help="Запустить backfill авто-жанров для существующих треков")
    parser.add_argument("--retry-failed-genres", action="store_true", help="Повторно классифицировать треки с failed статусом")
    parser.add_argument("--loudness-backfill", action="store_true", help="Запустить backfill нормализации громкости для треков")
    parser.add_argument("--retry-failed-loudness", action="store_true", help="Повторно анализировать треки со статусом failed")
    parser.add_argument("--limit", type=int, default=None, help="Ограничение количества треков для backfill")
    parser.add_argument("--retry-qdrant-sync", action="store_true", help="Повторить доставку pending auto_genres из SQLite в Qdrant")
    parser.add_argument("--resync-sqlite", action="store_true", help="Синхронизировать auto_genres из Qdrant в SQLite")
    args = parser.parse_args()

    TEMP_DIR.mkdir(parents=True, exist_ok=True)

    logger.info(f"Подключаюсь к Qdrant по адресу {QDRANT_URL}...")
    try:
        qdrant_client = QdrantClient(url=QDRANT_URL)
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
        unprocessed_tracks = get_unprocessed_tracks(qdrant_client)
        loudness_tracks = get_loudness_tracks(qdrant_client, limit=10)

        if not unprocessed_tracks and not loudness_tracks:
            logger.debug("Нет треков для обработки. Ожидание 30 секунд...")
            time.sleep(30)
            continue

        try:
            ssh, sftp = setup_sftp()
        except Exception as e:
            logger.error("Завершение цикла из-за ошибки SSH. Повтор через 30с.")
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

                    remote_path = f"{REMOTE_MUSIC_DIR}/{file_path}"
                    local_filename = Path(file_path).name
                    local_path = TEMP_DIR / local_filename

                    # Скачиваем файл через SFTP
                    try:
                        logger.info(f"Скачивание {remote_path} -> {local_path} ...")
                        sftp.get(remote_path, str(local_path))
                    except Exception as e:
                        logger.error(f"Не удалось скачать {remote_path}: {e}")
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
            sftp.close()
            ssh.close()
            logger.info("SFTP соединение закрыто.")

        logger.info("Пакет треков обработан. Проверка новых...")
        if not processed_any:
            time.sleep(10)


if __name__ == "__main__":
    main()
