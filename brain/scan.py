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

    heavy_worker анализирует файлы и пишет результат в свою SQLite и в общий
    Qdrant. Серверный API читает свою SQLite (deploy не синкает *.db), поэтому
    без этого переноса его база остаётся pending для проанализированных треков.
    """
    logger.info("Перенос loudness-результатов из Qdrant в SQLite...")
    import db

    synced = 0
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
        except Exception as e:
            logger.error(f"Ошибка чтения Qdrant: {e}")
            break

        for record in records:
            payload = record.payload or {}
            if payload.get("loudness_status") != "analyzed":
                continue
            if payload.get("normalization_gain_db") is None:
                continue

            point_id = str(record.id)
            try:
                if db.get_track(point_id) is None:
                    file_path = str(payload.get("file_path") or point_id)
                    title = str(payload.get("title") or Path(file_path).stem or point_id)
                    artist = str(payload.get("artist") or "Неизвестный исполнитель")
                    db.add_or_update_track(
                        point_id,
                        file_path,
                        title,
                        None,
                        artist,
                        duration=payload.get("duration"),
                    )
                db.update_track_loudness(
                    track_id=point_id,
                    loudness_lufs=payload.get("loudness_lufs"),
                    true_peak_db=payload.get("true_peak_db"),
                    normalization_gain_db=payload.get("normalization_gain_db"),
                    status="analyzed",
                    analysis_version=payload.get("loudness_analysis_version"),
                    file_size=payload.get("loudness_file_size"),
                    file_mtime_ns=payload.get("loudness_file_mtime_ns"),
                )
                synced += 1
            except Exception as e:
                logger.warning(f"Не удалось перенести loudness для {point_id}: {e}")

        if next_page is None:
            break
        offset = next_page

    logger.info(f"Loudness перенесено для {synced} треков.")
    return synced

def main():
    parser = argparse.ArgumentParser(description="Сканер треков для Puuk")
    parser.add_argument("--reset", action="store_true", help="Принудительно пересоздать коллекцию Qdrant (все векторы будут удалены)")
    parser.add_argument("--resync-loudness", action="store_true", help="Перенести готовые loudness-результаты из Qdrant в локальную SQLite и выйти")
    args = parser.parse_args()

    client = init_qdrant(reset=args.reset)

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

                # Проверяем, существует ли уже трек в Qdrant
                existing = client.retrieve(
                    collection_name=COLLECTION_NAME,
                    ids=[point_id],
                    with_payload=True,
                    with_vectors=True
                )
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
                        from metadata import read_audio_metadata
                        meta = read_audio_metadata(file_path)
                        if meta:
                            album_id = db.resolve_album(meta.album, album_artist=meta.album_artist or meta.artist)
                            db.add_or_update_track(
                                point_id, rel_path, meta.title, album_id, meta.artist, meta.lyrics,
                                duration=meta.duration, genre=meta.genre,
                                file_size=file_size, file_mtime_ns=file_mtime_ns,
                            )
                            db.update_track_metadata_from_audio(point_id, meta, album_id, preserve_empty_genre=True)
                        db.reset_track_loudness_pending(point_id, file_size=file_size, file_mtime_ns=file_mtime_ns)
                        logger.info(f"SQLite метаданные и loudness успешно обновлены для {file_path.name}")
                    except Exception as db_err:
                        logger.warning(f"Не удалось обновить SQLite для {file_path.name}: {db_err}")
                    continue

                logger.info(f"Новый трек обнаружен: {file_path.name}")
                metadata = process_audio_file(file_path, base_path)
                
                if metadata is None:
                    continue
                    
                logger.info(f"Извлечен BPM: {metadata['bpm']} для {metadata['file_path']}")
                
                # Заглушка для эмбеддинга (512 нулей)
                vector_placeholder = [0.0] * VECTOR_SIZE
                
                # Метаданные извлекаются один раз: идут в payload Qdrant (для diversity)
                # и в SQLite, без второго прохода по файлу.
                sql_meta = None
                try:
                    from services.media_locations import extract_full_metadata_with_genre
                    title_, artist_, album_, genre_, lyrics_, duration_ = extract_full_metadata_with_genre(metadata['file_path'])
                    metadata["artist"] = artist_
                    metadata["title"] = title_
                    if genre_:
                        metadata["genre"] = genre_
                    sql_meta = (title_, artist_, album_, genre_, lyrics_, duration_)
                except Exception as meta_err:
                    logger.warning(f"Не удалось извлечь метаданные для {metadata['file_path']}: {meta_err}")
                
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
                    
                    # Также обновляем SQLite базу (puuk.db), чтобы трек сразу отображался в приложении
                    try:
                        import db
                        if sql_meta is not None:
                            title_, artist_, album_, genre_, lyrics_, duration_ = sql_meta
                            album_id = db.resolve_album(album_, album_artist=artist_)
                            db.add_or_update_track(
                                point_id,
                                metadata['file_path'],
                                title_,
                                album_id,
                                artist_,
                                lyrics_,
                                duration=duration_,
                                genre=genre_,
                                file_size=metadata.get('file_size'),
                                file_mtime_ns=metadata.get('file_mtime_ns'),
                            )
                            logger.info(f"Синхронизировано с базой данных SQLite (puuk.db): {title_} - {artist_}")
                    except Exception as db_err:
                        logger.warning(f"Не удалось обновить SQLite для {metadata['file_path']}: {db_err}")
                except Exception as e:
                    logger.error(f"Ошибка при записи в Qdrant для {metadata['file_path']}: {e}")
                    
        except Exception as e:
            logger.error(f"Ошибка во время цикла сканирования: {e}")
            
        logger.info("Цикл завершен. Ожидание 5 минут...")
        time.sleep(300)

if __name__ == "__main__":
    main()
