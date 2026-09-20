# Puuk — Project Guide & Agent Instructions

ПЛАН РЕФАКТОРИНГА:

План рефакторинга Puuk — текущее состояние
✅ Фаза 1: Backend — ЗАВЕРШЕНА (с фиксам по аудиту)
Задача
config.py — централизованная конфигурация
db.py (1 257) → фасад 88 строк + repositories/ (8 доменных модулей)
api.py (1 584) → composition root 99 строк + 11 роутеров + 7 сервисов
whisper_anchor_backend.py → alignment/model_cache.py выделен
Верификация: 61/61 тестов, 40 маршрутов, бот-совместимость
Аудит-фиксы: cover-endpoint fallback поведение, cleanup мусора в api.py/db.py/base.py
✅ Фаза 2: Веб-клиент — ЗАВЕРШЕНА (с фиксам по аудиту)
Задача
TagEditorModal.tsx 888 → 158 + 7 модулей (hook + 4 таба + карточка + утилиты)
AppleLyricsStream.tsx 832 → 326 + 4 модуля (WordTimedLine, LyricLineRow, lyricsDepth, useKaraokeGeneration)
HomeScreen.tsx 702 → 495 + islands/ + demoMix
usePlayerStore.ts — helpers вынесены (accent, lyrics parsing, demo-guard), API не изменён
Верификация: tsc strict ✓, build ✓, 20/20 тестов ✓
Аудит-фикс: polling cleanup в useKaraokeGeneration
🔄 Фаза 3: iOS — НЕ НАЧАТА (следующий шаг)
Задача
FullPlayerModal.js (2 412 строк) → декомпозиция на 10+ компонентов
App.js (671) → экраны + навигационный конфиг
TrackEditScreen.js (724), LoginModal.js (739) — при необходимости
TypeScript-миграция (v2-скоуп, опционально)
Тесты (0% → базовые)
Перед стартом: разведка app/ios/puuk-ios/ (структура, зависимости,Metro/bundler), бэкап, baseline. iOS без тестов и без git — придётся опираться на компиляцию bundle + ручные проверки.
📋 Отложенные задачи (backlog)
1. Nested buttons в кликабельных карточках (HomeIslands.tsx) — pre-existing UX-дефект, нужно stopPropagation или перенос onClick
2. Изоляция тестовой БД (brain) — tmp-path fixture, тесты наследят 52 leftover-записи в puuk.db
3. Компонентные тесты веба — TagEditor, lyrics hook (rendering-тесты отсутствуют)
4. Общий LRC-парсер — дублирование в 3 местах (brain, web, iOS)
5. git init + первичный коммит — до сих пор не сделан, риск для Фазы 3
6. Декомпозиция HomeScreen глубже (useHomeCatalogData, HomeSearchResults) — 495 строк всё ещё много
⚠️ Открытый вопрос перед Фазой 3
iOS — это JS без тестов и типов; верификация возможна только через Metro bundle + ручной прогон. Начинать с FullPlayerModal.js (самый большой выигрыш), или сначала сделать git init + коммит текущего состояния, чтобы иметь точку отката?
Также рекомендую перед Фазой 3 закрыть backlog-пункты 1–2 (быстрые, снижают шум при будущих проверках).

Добро пожаловать в репозиторий **puuk** — персональной музыкальной экосистемы.

---

## 1. Структура репозитория

- **`brain/`** — Бэкенд на **Python (FastAPI)**.
  - Векторный поиск рекомендаций («Моя Волна») через **Qdrant**.
  - База метаданных SQLite (`puuk.db` в WAL-режиме, управление через `db.py`).
  - Сканирование локальной музыки (`mutagen`, извлечение тегов, текстов LRC).
  - Стриминг аудио (`/api/stream/{id}`), обложки (`/api/cover/{id}`), авторизация (JWT).
- **`tg_music_bot/`** — Telegram-бот на **aiogram**.
  - Загрузка треков по ссылкам из Spotify/YouTube.
  - Генерация одноразовых кодов авторизации для клиентов.
- **`app/ios/puuk-ios/`** — Мобильный клиент для iOS на **React Native (Expo)**.
- **`app/web/`** — Веб-клиент на **Vite + React + TypeScript**.
- **`docs/`** — Документация и спецификации архитектуры.

---

## 2. Веб-клиент (`app/web`) — Главная спецификация

При работе над веб-клиентом **строго следовать документу**:  
👉 [docs/WEB_CLIENT_ARCH.md](file:///home/fish/projects/puuk/docs/WEB_CLIENT_ARCH.md)

### Ключевые архитектурные правила для агентов:
1. **Стек:** `Vite + React 19 + TypeScript (Strict)`. Чистый SPA, никакого SSR.
2. **Изолированный аудио-движок (Decoupled Engine):**
   - Класс `src/engine/AudioEngine.ts` написан на **чистом TypeScript** и **НЕ зависит от React**.
   - UI никогда не управляет HTML5 Audio / AudioContext напрямую — только через методы движка или стейт-машину Zustand.
3. **Стейт-менеджмент:**
   - Состояние плеера, очередь, история, громкость → **Zustand** (`src/store/usePlayerStore.ts`).
   - Данные сервера (треки, альбомы, плейлисты, поиск) → **TanStack Query v5**.
4. **Стили:** CSS Modules + Vanilla CSS Variables (динамический цвет темы под обложку). Никаких ad-hoc inline стилей для базовых компонентов.
5. **Анимации:** `Framer Motion` (плавный разворот плеера, пружинные анимации модалок).
6. **Дебаг:** Встроенная диагностическая панель по нажатию `~` (клавиша тильда), строгие типы данных DTO.

---

## 3. Версионность и скоуп задач

- **v1 (MVP):** Авторизация (логин + tg-код), 3-колоночный десктопный плеер, библиотека, умный поиск, интерактивные караоке-тексты (LRC) с перемоткой по клику, полноэкранный плеер с адаптивным цветом, горячие клавиши.
- **v2 (Отложено):** Canvas визуализатор спектра частот, редактор ID3 тегов треков, drag-and-drop загрузка файлов, ремоут-контрол с телефона.

---

## 4. Навыки агентов (Skills)

При разработке используй специализированные навыки из `.agents/skills/`.
**Полный индекс:** [.agents/skills/INDEX.md](.agents/skills/INDEX.md)

### Оркестрация дочерних агентов (Orca)

Если запускаешь воркеров через Orca (`orca orchestration ...`) — **сначала
прочитай [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md)**. Ключевое:
- запускай `--agent opencode` (codex на этой машине не установлен — воркеры зависают);
- не полагайся на авто-инжект промпта: проверь ход и при простое дослай
  спеку через `orca terminal send`;
- официальный версионный гайд — `orca skills get orchestration`.

### Для веб-клиента (`app/web`)
- **`puuk-ui`** — стилизация (CSS Modules), анимации (Framer Motion), React 19 + Zustand паттерны, динамическая тема под обложку. Первый выбор для любой UI-задачи.
- **`puuk-ux-lite`** — локальный поиск UI/UX-паттернов:
  `python3 .agents/skills/puuk-ux-lite/scripts/search.py "запрос" [--domain style|color|ux|typography|gsap|react|web|product]`
- **`clean-code`** — читаемость React/TS-кода.

### Для бэкенда (`brain/`)
- **`clean-code`** + **`clean-architecture`** — роуты, сервисы, границы слоев.
- **`release-it`** — надежность стриминга/сканера: таймауты, ретраи, отказы.
- **`a-philosophy-of-software-design`** — рост сложности wave/search-логики.

### Для рефакторинга
- **`refactoring`** + **`refactoring-guru`** — безопасное улучшение кода.

### Важно
- Навыки **не применимы** к специфике фреймворков (FastAPI decorators, aiogram
  filters), инфраструктуре и Qdrant — там официальная документация.
- Остальные навыки (DDD, дизайн-агентство, полные UI-аудиты) законсервированы
  в `.agents/skills-archive/` — см. README там, если понадобятся.
