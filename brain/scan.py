import os
import uuid
import logging
from pathlib import Path

import librosa
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct

# Настройка логирования
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger(__name__)

SERVER_IP = os.getenv("SERVER_IP", "192.168.1.117")
MUSIC_DIR = os.getenv("MUSIC_DIR", "/mnt/data/projects/puuk/music")
QDRANT_URL = os.getenv("QDRANT_URL", f"http://{SERVER_IP}:6333")
COLLECTION_NAME = "tracks"
VECTOR_SIZE = 400
SUPPORTED_EXTENSIONS = {'.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus'}

def init_qdrant(reset: bool = False) -> QdrantClient:
    logger.info(f"Подключение к Qdrant по адресу {QDRANT_URL}...")
    client = QdrantClient(url=QDRANT_URL)
    
    if reset and client.collection_exists(collection_name=COLLECTION_NAME):
        logger.warning(f"Флаг --reset передан! Удаляем коллекцию '{COLLECTION_NAME}'...")
        client.delete_collection(collection_name=COLLECTION_NAME)
        logger.info("Старая коллекция удалена.")
    
    if not client.collection_exists(collection_name=COLLECTION_NAME):
        logger.info(f"Создание коллекции '{COLLECTION_NAME}'...")
        client.create_collection(
            collection_name=COLLECTION_NAME,
            vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE),
        )
        logger.info(f"Коллекция '{COLLECTION_NAME}' успешно создана.")
    else:
        logger.info(f"Коллекция '{COLLECTION_NAME}' уже существует.")
        
    return client

def scan_directory(music_dir: str):
    base_path = Path(music_dir)
    if not base_path.exists() or not base_path.is_dir():
        logger.error(f"Директория с музыкой не найдена: {music_dir}")
        return

    logger.info(f"Начинаем сканирование директории: {music_dir}")
    
    for file_path in base_path.rglob("*"):
        if file_path.is_file() and file_path.suffix.lower() in SUPPORTED_EXTENSIONS:
            yield file_path

def process_audio_file(file_path: Path, base_path: Path) -> dict:
    try:
        # Загружаем аудиофайл
        y, sr = librosa.load(file_path, sr=None)
        
        # Вычисление темпа (BPM)
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        
        # Извлекаем скалярное значение
        if hasattr(tempo, "item"):
            bpm = tempo.item()
        else:
            bpm = float(tempo)
            
        bpm_rounded = round(bpm, 2)
        rel_path = str(file_path.relative_to(base_path))
        stat = file_path.stat()
        
        return {
            "file_path": rel_path,
            "bpm": bpm_rounded,
            "needs_embedding": True,
            "file_size": stat.st_size,
            "file_mtime_ns": stat.st_mtime_ns,
            "loudness_status": "pending",
            "loudness_lufs": None,
            "true_peak_db": None,
            "normalization_gain_db": None,
            "loudness_analysis_version": "r128-v1",
            "loudness_error": None,
            "loudness_retry_count": 0,
        }
    except Exception as e:
        logger.error(f"Ошибка при обработке файла {file_path.name}: {e}")
        return None

import argparse
import time

def resync_loudness_from_qdrant(client: QdrantClient) -> int:
    """Переносит готовые loudness-результаты из общего Qdrant в локальную SQLite.

    Тонкая обёртка над серверным сервисом
    ``services.loudness_sync_service.sync_loudness_from_qdrant``, чтобы у ручного
    CLI и автоматической периодической доставки был один проверяемый код:
    валидация метрик, сверка идентичности файла (size/mtime с учётом
    секундного разрешения SFTP) и идемпотентность.
    """
    from services.loudness_sync_service import sync_loudness_from_qdrant

    counters = sync_loudness_from_qdrant(client)
    logger.info(f"Loudness перенесено для {counters['synced']} треков.")
    return counters["synced"]

def _index_scanned_file(file_path, rel_path, track_id):
    """Commit source metadata before publishing a queue point."""
    import db
    from metadata import read_audio_metadata
    from repositories.artist_credits import audio_artist_source
    from services.media_locations import resolve_import_album

    meta = read_audio_metadata(str(file_path))
    previous = db.get_track(track_id)
    file_changed = bool(previous and (
        (previous.get('file_size') is not None and previous['file_size'] != meta.file_size) or
        (previous.get('file_mtime_ns') is not None and previous['file_mtime_ns'] != meta.file_mtime_ns)
    ))
    album_id = resolve_import_album(track_id, meta.album, meta.album_artist,
                                    year=meta.year, artist_source=audio_artist_source(meta, album=True))
    db.add_or_update_track(track_id, rel_path, meta.title, album_id, meta.artist, meta.lyrics,
                           duration=meta.duration, genre=meta.genre, file_size=meta.file_size,
                           file_mtime_ns=meta.file_mtime_ns, track_number=meta.track_number,
                           disc_number=meta.disc_number, artist_source=audio_artist_source(meta))
    db.update_track_metadata_from_audio(track_id, meta, album_id, preserve_empty_genre=True)
    if file_changed:
        db.reset_track_loudness_pending(track_id, file_size=meta.file_size, file_mtime_ns=meta.file_mtime_ns)
    return db.get_tracks_by_ids([track_id])[str(track_id)]


def main():
    parser = argparse.ArgumentParser(description="Сканер треков для Puuk")
    parser.add_argument("--reset", action="store_true", help="Принудительно пересоздать коллекцию Qdrant (все векторы будут удалены)")
    parser.add_argument("--resync-loudness", action="store_true", help="Перенести готовые loudness-результаты из Qdrant в локальную SQLite и выйти")
    args = parser.parse_args()

    try:
        client = init_qdrant(reset=args.reset)
    except Exception as exc:
        if args.reset or args.resync_loudness:
            raise
        logger.warning("Qdrant initialization failed; scanning SQLite: %s", exc)
        client = QdrantClient(url=QDRANT_URL)

    if args.resync_loudness:
        resync_loudness_from_qdrant(client)
        return

    base_path = Path(MUSIC_DIR)
    
    logger.info("Скрипт запущен в режиме постоянного мониторинга (каждые 5 минут).")
    
    while True:
        try:
            logger.info(f"Начинаем сканирование директории: {MUSIC_DIR}")
            for file_path in scan_directory(MUSIC_DIR):
                rel_path = str(file_path.relative_to(base_path))
                point_id = str(uuid.uuid5(uuid.NAMESPACE_URL, rel_path))
                
                stat = file_path.stat()
                file_size = stat.st_size
                file_mtime_ns = stat.st_mtime_ns

                try:
                    indexed = _index_scanned_file(file_path, rel_path, point_id)
                except Exception as db_err:
                    logger.warning("SQLite ingest failed for %s: %s", file_path.name, db_err)
                    continue

                # Qdrant failure must not prevent SQLite ingest.
                try:
                    existing = client.retrieve(
                        collection_name=COLLECTION_NAME, ids=[point_id],
                        with_payload=True, with_vectors=True,
                    )
                except Exception as qdrant_err:
                    logger.warning("Qdrant unavailable for %s: %s", file_path.name, qdrant_err)
                    continue
                if existing:
                    record = existing[0]
                    payload = record.payload or {}
                    stored_size = payload.get("file_size")
                    stored_mtime = payload.get("file_mtime_ns")

                    file_changed = False
                    if (
                        stored_size is None
                        or stored_mtime is None
                        or stored_size != file_size
                        or stored_mtime != file_mtime_ns
                    ):
                        file_changed = True

                    if not file_changed:
                        continue

                    logger.info(
                        f"Файл изменился: {file_path.name} (size: {stored_size} -> {file_size}, mtime: {stored_mtime} -> {file_mtime_ns}). Обновляем метаданные и loudness..."
                    )
                    payload["artist"] = indexed.get("artist") or ""
                    payload["artists"] = indexed.get("artists", [])
                    payload["album_artists"] = indexed.get("album_artists", [])
                    payload["file_size"] = file_size
                    payload["file_mtime_ns"] = file_mtime_ns
                    payload["loudness_status"] = "pending"
                    payload["normalization_gain_db"] = None
                    payload["loudness_lufs"] = None
                    payload["true_peak_db"] = None
                    payload["loudness_analysis_version"] = "r128-v1"
                    payload["loudness_error"] = None
                    payload["loudness_retry_count"] = 0

                    client.upsert(
                        collection_name=COLLECTION_NAME,
                        points=[
                            PointStruct(
                                id=point_id,
                                vector=record.vector or ([0.0] * VECTOR_SIZE),
                                payload=payload,
                            )
                        ],
                    )

                    try:
                        import db
                        db.reset_track_loudness_pending(point_id, file_size=file_size, file_mtime_ns=file_mtime_ns)
                    except Exception as db_err:
                        logger.warning("Loudness reset failed for %s: %s", file_path.name, db_err)
                    continue

                logger.info(f"Новый трек обнаружен: {file_path.name}")
                metadata = process_audio_file(file_path, base_path)
                
                if metadata is None:
                    continue
                    
                logger.info(f"Извлечен BPM: {metadata['bpm']} для {metadata['file_path']}")
                
                # Заглушка для эмбеддинга (512 нулей)
                vector_placeholder = [0.0] * VECTOR_SIZE
                
                # Publish the effective SQLite decision, including manual empty lists.
                metadata["title"] = indexed.get("title")
                metadata["artist"] = indexed.get("artist") or ""
                metadata["artists"] = indexed.get("artists", [])
                metadata["album_artists"] = indexed.get("album_artists", [])
                if indexed.get("genre"):
                    metadata["genre"] = indexed["genre"]

                try:
                    client.upsert(
                        collection_name=COLLECTION_NAME,
                        points=[
                            PointStruct(
                                id=point_id,
                                vector=vector_placeholder,
                                payload=metadata
                            )
                        ]
                    )
                    logger.info(f"Успешно сохранено в Qdrant: {metadata['file_path']} с needs_embedding=True")
                    
                except Exception as e:
                    logger.error(f"Ошибка при записи в Qdrant для {metadata['file_path']}: {e}")
                    
        except Exception as e:
            logger.error(f"Ошибка во время цикла сканирования: {e}")
            
        logger.info("Цикл завершен. Ожидание 5 минут...")
        time.sleep(300)

if __name__ == "__main__":
    main()
