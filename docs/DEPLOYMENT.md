# Deployment — Puuk

Все сервисы работают на **192.168.1.117:59348**, только `heavy_worker.py` (векторизация, жанры, LUFS) запускается локально на машине разработки.

## Архитектура

| Компонент | Расположение | Описание |
|---|---|---|
| **FastAPI backend** | 192.168.1.117 `/home/fish/apps/puuk/puuk/brain/` | API на `127.0.0.1:8000` |
| **Telegram bot** | 192.168.1.117 `/home/fish/apps/puuk/puuk/tg_music_bot/` | aiogram, загрузка треков |
| **Qdrant** | 192.168.1.117 | Векторная БД, порт 6333 |
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
