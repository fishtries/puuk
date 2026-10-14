# Brain (Backend) — Agent Instructions

FastAPI backend на Python. Работает на **192.168.1.117:59348**, локальная разработка ограничена (нет музыкальной библиотеки и рабочей базы).

## Проверки перед деплоем

На локальной машине (без сервера):

```bash
cd brain/
source ../venv/bin/activate  # или локальное окружение
pytest -xvs                  # все тесты используют изолированную БД
```

**Все тесты безопасны:** импортируют `test_db_path.py`, который задаёт `PUUK_DB_PATH` на временную БД. Рабочая `puuk.db` не трогается.

## Деплой и проверки на сервере

Из корня проекта:

```bash
./deploy.sh           # синхронизация + перезапуск backend
```

Проверки на сервере (агент может выполнять без подтверждения):

```bash
# Тесты на сервере (изолированная БД)
ssh -p 59348 192.168.1.117 'cd /home/fish/apps/puuk/puuk/brain && source venv/bin/activate && pytest -xvs'

# Статус процессов
ssh -p 59348 192.168.1.117 'ps aux | grep uvicorn | grep -v grep'

# Health-check API
curl http://192.168.1.117:8000/api/health

# Количество треков в базе
ssh -p 59348 192.168.1.117 'sqlite3 /home/fish/apps/puuk/puuk/brain/puuk.db "SELECT COUNT(*) FROM tracks;"'
```

## Структура

- **`api.py`** — FastAPI entrypoint, composition root
- **`config.py`** — централизованная конфигурация (env → константы)
- **`db.py`** — фасад репозиториев + инициализация схемы
- **`repositories/`** — доменные модули (tracks, albums, playlists, wave, auth, media_tickets, auto_genres, search)
- **`routers/`** — FastAPI роутеры (tracks, albums, playlists, wave, auth, stream, cover, search, admin, library)
- **`services/`** — бизнес-логика (library_service, scan, track_metadata_service, loudness, loudness_sync_service, audio_genre_classifier, embedding_queue_service)
- **`scan.py`** — CLI-сканер музыкальной библиотеки (извлечение ID3, LRC, обложек)
- **`heavy_worker.py`** — векторизация / жанры / LUFS. **Запускается локально через SFTP**, не на сервере.

## Heavy Worker (локально)

Worker работает **на машине разработки**, обращается к серверу через SFTP (порт 59348):

```bash
cd brain/
source ../venv/bin/activate
python heavy_worker.py --mode essentia  # векторизация pending треков → Qdrant
python heavy_worker.py --mode loudness  # LUFS нормализация
python heavy_worker.py --mode genre     # автоматическая классификация жанров
```

Worker скачивает аудио в `./temp_audio/`, обрабатывает локально, результаты записывает в удалённую SQLite и Qdrant.

Готовые loudness-результаты доставляются в серверную SQLite автоматически: периодическая задача API (`LOUDNESS_SYNC_ENABLED`, `LOUDNESS_SYNC_INTERVAL_SEC`, см. `services/loudness_sync_service.py`) забирает `analyzed`-записи из общего Qdrant, проверяя конечность метрик и идентичность реального файла на диске (size/mtime с учётом секундного разрешения SFTP; отсутствующие файлы и выход за пределы `MUSIC_DIR` отвергаются). Ручной вариант — `python scan.py --resync-loudness` (та же реализация).

## Ключевые правила

- **Изоляция тестов:** все `test_*.py` импортируют `test_db_path` первой строкой — тесты используют временную БД.
- **Изменения схемы:** добавлять миграцию в `db.py` (функция `apply_migrations`), проверять идемпотентность через `PRAGMA table_info`.
- **Qdrant:** коллекция `tracks`, размер вектора 400. Не изменять структуру без обратной совместимости.
- **Конфигурация:** все env-переменные задаются в `config.py`, использовать оттуда, не читать `os.getenv` напрямую в коде.
- **Потоковое аудио:** `/api/stream/{id}` поддерживает HTTP Range, стримит напрямую (не через blob). Media-tickets для авторизации без JWT в URL.
