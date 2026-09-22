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
        
        return {
            "file_path": rel_path,
            "bpm": bpm_rounded,
            "needs_embedding": True
        }
    except Exception as e:
        logger.error(f"Ошибка при обработке файла {file_path.name}: {e}")
        return None

import argparse
import time

def main():
    parser = argparse.ArgumentParser(description="Сканер треков для Puuk")
    parser.add_argument("--reset", action="store_true", help="Принудительно пересоздать коллекцию Qdrant (все векторы будут удалены)")
    args = parser.parse_args()

    client = init_qdrant(reset=args.reset)
    base_path = Path(MUSIC_DIR)
    
    logger.info("Скрипт запущен в режиме постоянного мониторинга (каждые 5 минут).")
    
    while True:
        try:
            logger.info(f"Начинаем сканирование директории: {MUSIC_DIR}")
            for file_path in scan_directory(MUSIC_DIR):
                rel_path = str(file_path.relative_to(base_path))
                point_id = str(uuid.uuid5(uuid.NAMESPACE_URL, rel_path))
                
                # Проверяем, существует ли уже трек в Qdrant
                existing = client.retrieve(
                    collection_name=COLLECTION_NAME,
                    ids=[point_id],
                    with_payload=False,
                    with_vectors=False
                )
                if existing:
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
                            album_id = db.add_or_get_album(album_, None)
                            db.add_or_update_track(point_id, metadata['file_path'], title_, album_id, artist_, lyrics_, duration=duration_, genre=genre_)
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
