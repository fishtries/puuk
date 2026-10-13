# Puuk — Agent Instructions

Персональная музыкальная экосистема: FastAPI backend, Telegram-бот загрузчик, iOS клиент на Expo.

## Структура репозитория

- **`brain/`** — FastAPI + SQLite (WAL) + Qdrant. Сканирование музыки (`mutagen`), стриминг, рекомендации («Моя Волна»), JWT auth.
- **`tg_music_bot/`** — aiogram. Загрузка треков Spotify/YouTube, генерация одноразовых кодов авторизации.
- **`app/ios/puuk-ios/`** — React Native (Expo SDK 57). Клиент для iOS.
- **`docs/`** — Спецификации архитектуры.

## Архитектура окружения

**Все сервисы работают на 192.168.1.117:59348.** Только `brain/heavy_worker.py` (векторизация, жанры, LUFS) запускается локально через SFTP.

Деплой изменений: `./deploy.sh` (rsync + перезапуск). Детали: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

## Общие правила

- Тесты изолируются через `PUUK_DB_PATH` env (см. `brain/test_db_path.py`).
- Оригинальные аудиофайлы не изменяются (нормализация громкости применяется на лету).
- Строчный LRC сохранён; word-level (побуквенный karaoke) пайплайн удалён.

## Skills

Загружать по необходимости. Полный индекс: [.agents/skills/INDEX.md](.agents/skills/INDEX.md)

- **`release-it`** — надежность production-систем: таймауты, retry, изоляция отказов (для SFTP, стриминга, фоновых задач, Qdrant-интеграции).
- **`refactoring`** — безопасное изменение структуры кода с сохранением поведения.
- **`a-philosophy-of-software-design`** — проектирование API и границ модулей (загружать при decomposition, не для локальных правок).

Остальные skills (clean-code, clean-architecture, code-complete и т.д.) загружать явно при необходимости.

Архив: `.agents/skills-archive/` — enterprise-паттерны, дизайн-агентство, UI-аудиты (см. README там).
