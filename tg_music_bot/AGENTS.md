# Telegram Bot — Agent Instructions

aiogram-бот для загрузки треков и генерации кодов авторизации. Работает на **192.168.1.117:59348**.

## Деплой

Из корня проекта:

```bash
./deploy.sh  # синхронизация brain + tg_music_bot, перезапуск обоих
```

## Проверки

```bash
# Статус процесса
ssh -p 59348 192.168.1.117 'ps aux | grep "bot.py" | grep -v grep'

# Тесты (если есть)
cd tg_music_bot/
pytest -xvs
```

## Структура

- **`bot.py`** — основной файл, handlers, aiogram dispatcher
- **`downloader.py`** — загрузка треков из Spotify/YouTube
- **`requirements.txt`** — зависимости бота

## Ключевые правила

- Специфика aiogram (filters, handlers, FSM) важнее универсальных паттернов — следуй официальной документации aiogram.
- Генерация одноразовых кодов авторизации для клиентов (iOS/web).
- Загруженные треки сохраняются в `/mnt/data/projects/puuk/music/` на сервере.
