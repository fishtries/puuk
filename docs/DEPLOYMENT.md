# Deployment — Puuk

Все сервисы работают на **192.168.1.117:59348**, только `heavy_worker.py` (векторизация, жанры, LUFS) запускается локально на машине разработки.

## Архитектура

| Компонент | Расположение | Описание |
|---|---|---|
| **FastAPI backend** | 192.168.1.117 `/home/fish/apps/puuk/puuk/brain/` | API на `127.0.0.1:8000` |
| **Telegram bot** | 192.168.1.117 `/home/fish/apps/puuk/puuk/tg_music_bot/` | aiogram, загрузка треков |
| **Qdrant** | 192.168.1.117 | Векторная БД, HTTP на `127.0.0.1:6333`, с API-ключом |
| **SQLite** | 192.168.1.117 `/home/fish/apps/puuk/puuk/brain/puuk.db` | Метаданные (WAL mode) |
| **Музыкальная библиотека** | 192.168.1.117 `/mnt/data/projects/puuk/music/` | Плоская структура, ~3.5GB MP3 |
| **Heavy worker** | Локально (эта машина) | `brain/heavy_worker.py` через SFTP |

## Деплой изменений

Из корня проекта:

```bash
./deploy.sh                # синхронизация brain + tg_music_bot, перезапуск сервисов
./deploy.sh --install      # + обновление зависимостей на сервере
./deploy.sh --dry-run      # проверка без реальной передачи
```

Скрипт использует `rsync` через SSH (порт 59348), исключает `venv/`, `__pycache__/`, `*.db*`.

После деплоя автоматически перезапускаются:
- Backend: `systemctl restart puuk-brain` (fallback: `pkill -9 -f uvicorn`)
- Bot: `systemctl restart puuk-telegram-bot` (fallback: `pkill -9 -f bot.py`)

**Известная проблема:** systemd-юниты не созданы, перезапуск идёт через `pkill`. Требуется создать юниты и перейти на управление через systemd.

### Приёмка нового бота

Для тестового запуска нужны отдельный токен бота и аккаунты Puuk с привязанными Telegram ID в тестовой базе. На хосте загрузчика нужны Chromium и соответствующий `chromedriver` для VK, FFmpeg для декодирования и Node.js для YouTube. Для вложений больше 20 МБ запустите Telegram Bot API в локальном режиме и задайте его адрес. Если Bot API работает в контейнере, файловые пути из `getFile` должны быть видны процессу бота по тем же абсолютным путям. [Локальный Telegram Bot API](https://core.telegram.org/bots/api#using-a-local-bot-api-server)

Задайте токен тестового бота в `BOT_TOKEN` через окружение процесса. Запустите команду из каталога `tg_music_bot`.

```bash
PUUK_TELEGRAM_IMPORTS=1 \
PUUK_DB_PATH=/путь/к/тестовой/puuk.db \
MUSIC_DIR=/путь/к/тестовой/music \
PUUK_DOWNLOAD_QUEUE_PATH=/путь/к/тестовой/downloads.sqlite3 \
PUUK_TELEGRAM_API_URL=http://127.0.0.1:8081 \
EMBEDDING_QUEUE_ENABLED=false \
./venv/bin/python bot.py
```

Для проверки приоритета одиночной загрузки задайте `PUUK_TELEGRAM_IMPORT_WORKERS=1`. В тесте анализа используйте отдельную коллекцию Qdrant или подставьте тестовый клиент. Для переключения рабочего бота дождитесь завершения старых активных заданий и пройдите контрольные импорты. Включение выполняется переменной `PUUK_TELEGRAM_IMPORTS=1`. Удаление переменной и перезапуск возвращают прежний обработчик. [Контрольные прогоны](plans/telegram-bot.md#порядок-реализации-и-приёмки)

## Запуск на сервере (если сервисы упали)

SSH-доступ:

```bash
ssh -p 59348 192.168.1.117
```

### Backend

```bash
cd /home/fish/apps/puuk/puuk/brain/
source venv/bin/activate
python api.py  # uvicorn на 127.0.0.1:8000
```

### Telegram bot

```bash
cd /home/fish/apps/puuk/puuk/tg_music_bot/
source venv/bin/activate
python bot.py
```

### Сканер музыки (однократно)

```bash
cd /home/fish/apps/puuk/puuk/brain/
source venv/bin/activate
python scan.py
```

### Heavy worker (локально)

```bash
cd /home/fish/projects/puuk/brain/
source ../venv/bin/activate  # или локальное окружение
python heavy_worker.py --mode essentia  # векторизация всех pending треков
python heavy_worker.py --mode loudness  # LUFS нормализация
python heavy_worker.py --mode genre     # жанры через Essentia
```

Heavy worker работает через SFTP (порт 59348), скачивает аудио во временный каталог, обрабатывает, пишет результаты в удалённую SQLite.

### Доступ к Qdrant

Backend и бот используют `http://127.0.0.1:6333` на сервере. Compose в
`~/apps/puuk/qdrant/` публикует HTTP только на loopback и передаёт Qdrant
`QDRANT__SERVICE__API_KEY` из закрытого файла `qdrant-auth.env`.
gRPC остаётся внутри Docker.

На машине worker тот же локальный адрес ведёт через SSH. Проверить туннель
можно через `systemctl --user status puuk-qdrant-tunnel`. Если нужен ручной запуск:

```bash
ssh -NT -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:6333:127.0.0.1:6333 -p 59348 fish@192.168.1.117
```

Python-клиенты читают ключ из `~/.config/puuk/qdrant.key` с правами `0600`.
Для другого окружения можно задать `QDRANT_URL` и `QDRANT_API_KEY`. Ключ
передаётся по HTTPS или по HTTP только на локальный адрес из примера.

## Проверки на сервере

Агент может выполнять без подтверждения:

```bash
# Статус процессов
ssh -p 59348 192.168.1.117 'ps aux | grep -E "uvicorn|bot.py|qdrant" | grep -v grep'

# Тесты (изолированная БД через PUUK_DB_PATH)
ssh -p 59348 192.168.1.117 'cd /home/fish/apps/puuk/puuk/brain && source venv/bin/activate && pytest -xvs'

# Логи backend (если настроены systemd-юниты)
ssh -p 59348 192.168.1.117 'journalctl --user -u puuk-brain -n 50'

# API health-check
curl http://192.168.1.117:8000/api/health
```

## Логи

- **Backend:** пока в stdout процесса (требуется настроить systemd + journald)
- **Bot:** пока в stdout процесса
- **Heavy worker:** stdout локального терминала

## TODO (технический долг)

- [ ] Создать systemd user units для `puuk-brain` и `puuk-telegram-bot`
- [ ] Настроить journald для централизованных логов
- [ ] Перейти на управление через `systemctl --user start/stop/restart`
- [ ] Убрать fallback `pkill -9` из `deploy.sh` после настройки systemd

## Пословные тексты

Отдельная доставка `scripts/lyrics/` и локальных снимков, проверка аудио, импорт
с dry-run, отключение и восстановление: [WORD_LYRICS.md](WORD_LYRICS.md).
Обычный `./deploy.sh` эти каталоги не доставляет.
