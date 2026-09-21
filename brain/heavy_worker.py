import os
os.environ["HF_ENDPOINT"] = "https://hf-api.gitee.com"
import time
import getpass
import logging
import paramiko
import urllib.request
import numpy as np
import essentia.standard as es
from pathlib import Path
from qdrant_client import QdrantClient
from qdrant_client.http.models import Filter, FieldCondition, MatchValue, PointStruct

# --- Конфигурация ---
# Можно переопределить через переменные окружения, если нужно
SERVER_IP = os.getenv("SERVER_IP", "192.168.1.117")
SERVER_SSH_PORT = int(os.getenv("SERVER_SSH_PORT", "59348"))
SERVER_USER = os.getenv("SERVER_USER", "fish")

QDRANT_URL = os.getenv("QDRANT_URL", f"http://{SERVER_IP}:6333")
COLLECTION_NAME = "tracks"

REMOTE_MUSIC_DIR = os.getenv("REMOTE_MUSIC_DIR", "/mnt/data/projects/puuk/music")
TEMP_DIR = Path("./temp_audio")
VECTOR_SIZE = 400

# Настройка логирования
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [HeavyWorker] [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger(__name__)

# Глобальный кэш пароля для SSH
SSH_PASSWORD = None

def setup_sftp() -> tuple[paramiko.SSHClient, paramiko.SFTPClient]:
    """Установка SSH и SFTP соединения с сервером."""
    global SSH_PASSWORD
    logger.info(f"Подключение по SSH к {SERVER_USER}@{SERVER_IP}:{SERVER_SSH_PORT}...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    # Чтение ~/.ssh/config для поиска кастомных ключей
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

    # Если пароль уже вводили ранее, сразу подставляем его
    if SSH_PASSWORD is not None:
        connect_kwargs["password"] = SSH_PASSWORD
        connect_kwargs["look_for_keys"] = False

    try:
        ssh.connect(**connect_kwargs)
    except paramiko.ssh_exception.AuthenticationException as auth_err:
        # Если мы пробовали сохраненный пароль и он не подошел (например, сбросился/неверный)
        if SSH_PASSWORD is not None:
            logger.error("Сохраненный пароль SSH не подходит. Запрашиваем заново.")
            SSH_PASSWORD = None
            
        logger.warning("Аутентификация по ключам не удалась. Переход на ввод пароля.")
        password = getpass.getpass(f"Пароль для {SERVER_USER}@{SERVER_IP}: ")
        connect_kwargs["password"] = password
        connect_kwargs["look_for_keys"] = False
        try:
            ssh.connect(**connect_kwargs)
            SSH_PASSWORD = password  # Сохраняем успешный пароль
        except Exception as e:
            logger.error(f"Ошибка подключения по паролю: {e}")
            raise e
    except Exception as e:
        logger.error(f"Ошибка подключения по SSH: {e}")
        raise e
        
    sftp = ssh.open_sftp()
    logger.info("SFTP соединение успешно установлено.")
    return ssh, sftp

def parse_artist_from_path(file_path: str) -> str | None:
    """
    Извлекает исполнителя из имени файла вида "Artist - Title.ext".
    Без обращения к диску. Используется как fallback для точек, у которых
    payload ещё не содержит 'artist' (сканированных до обогащения).
    """
    if not file_path:
        return None
    name = Path(file_path).stem
    if " - " not in name:
        return None
    return name.split(" - ", 1)[0].strip() or None


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
                            match=MatchValue(value=True)
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

def main():
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    
    MODEL_FILENAME = "discogs-effnet-bs64-1.pb"
    MODEL_URL = "https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb"

    if not os.path.exists(MODEL_FILENAME):
        logger.info(f"Скачивание модели из {MODEL_URL}...")
        try:
            urllib.request.urlretrieve(MODEL_URL, MODEL_FILENAME)
            logger.info("Модель успешно скачана.")
        except Exception as e:
            logger.error(f"Ошибка при скачивании модели: {e}")
            return

    logger.info("Инициализация модели discogs-effnet...")
    try:
        extractor = es.TensorflowPredictEffnetDiscogs(graphFilename=MODEL_FILENAME)
    except Exception as e:
        logger.error(f"Ошибка загрузки модели discogs-effnet: {e}")
        return
    
    logger.info(f"Подключаюсь к Qdrant по адресу {QDRANT_URL}...")
    try:
        qdrant_client = QdrantClient(url=QDRANT_URL)
    except Exception as e:
        logger.error(f"Не удалось подключиться к Qdrant: {e}")
        return

    logger.info("Скрипт запущен в режиме постоянного мониторинга новых треков.")
    while True:
        unprocessed_tracks = get_unprocessed_tracks(qdrant_client)
        
        if not unprocessed_tracks:
            logger.debug("Нет треков для обработки. Ожидание 30 секунд...")
            time.sleep(30)
            continue
            
        logger.info(f"Найдено треков для обработки: {len(unprocessed_tracks)}.")
        
        try:
            ssh, sftp = setup_sftp()
        except Exception as e:
            logger.error("Завершение работы из-за ошибки SSH. Повтор через 30с.")
            time.sleep(30)
            continue

        try:
            processed_any = False
            for record in unprocessed_tracks:
                point_id = record.id
                payload = record.payload
                file_path = payload.get("file_path")
                
                if not file_path:
                    logger.warning(f"У записи {point_id} нет file_path. Пропускаем.")
                    continue

                # Обогащение payload: точки, отсканированные до появления
                # 'artist', получают исполнителя из имени файла.
                if not payload.get("artist"):
                    parsed_artist = parse_artist_from_path(file_path)
                    if parsed_artist:
                        payload["artist"] = parsed_artist
                        
                remote_path = f"{REMOTE_MUSIC_DIR}/{file_path}"
                local_filename = Path(file_path).name
                local_path = TEMP_DIR / local_filename
                
                # 1. Скачиваем файл через SFTP
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
                    # 2. Выполнение ML-анализа
                    logger.info(f"Файл скачан: {file_path}, начинаю ML-анализ...")
                    
                    # Загружаем аудио целиком через Essentia MonoLoader (ресемплинг до 16000)
                    audio = es.MonoLoader(filename=str(local_path), sampleRate=16000)()
                    
                    # Получение эмбеддинга
                    frame_embeddings = extractor(audio)
                    
                    # Усредняем эмбеддинги по всем патчам (axis=0), чтобы получить один вектор
                    new_vector = np.mean(frame_embeddings, axis=0).tolist()
                    
                    # 3. Обновление Qdrant
                    payload["needs_embedding"] = False
                    
                    # Удаляем старые поля эвристик, если они были
                    keys_to_remove = ["energy", "danceability", "acousticness", "vocal", "aggressive", "happy", "relaxed"]
                    for k in keys_to_remove:
                        if k in payload:
                            del payload[k]
                        
                    try:
                        qdrant_client.upsert(
                            collection_name=COLLECTION_NAME,
                            points=[
                                PointStruct(
                                    id=point_id,
                                    vector=new_vector,
                                    payload=payload
                                )
                            ]
                        )
                        logger.info(f"Вектор для {file_path} успешно обновлен в БД.")
                        processed_any = True
                    except Exception as e:
                        logger.error(f"Ошибка при обновлении Qdrant для {file_path}: {e}")
                        
                except Exception as e:
                    logger.error(f"Ошибка ML-инференса для {file_path}: {e}")
                finally:
                    # 4. Удаление временного файла в блоке finally
                    try:
                        if local_path.exists():
                            os.remove(local_path)
                            logger.debug(f"Временный файл удален: {local_path}")
                    except Exception as e:
                        logger.warning(f"Не удалось удалить временный файл {local_path}: {e}")

        finally:
            sftp.close()
            ssh.close()
            logger.info("SFTP соединение закрыто.")
        
        logger.info("Пакет треков обработан. Проверка новых...")
        if not processed_any:
            # Защита от бесконечного быстрого цикла при ошибках скачивания
            time.sleep(10)

if __name__ == "__main__":
    main()
