# Puuk — Project Guide & Agent Instructions

ПЛАН РЕФАКТОРИНГА:

План рефакторинга Puuk — текущее состояние
✅ Фаза 1: Backend — ЗАВЕРШЕНА (с фиксам по аудиту)
Задача
config.py — централизованная конфигурация
db.py (1 257) → фасад 88 строк + repositories/ (8 доменных модулей)
api.py (1 584) → composition root 99 строк + 11 роутеров + 7 сервисов
Верификация: 61/61 тестов, 40 маршрутов, бот-совместимость
Аудит-фиксы: cover-endpoint fallback поведение, cleanup мусора в api.py/db.py/base.py
🗑️ Удалён word-level (побуквенный/Enhanced LRC, karaoke) пайплайн: whisper_anchor_backend,
word_lrc_generator, alignment/, lyrics_worker, GPU-эндпоинты, web WordTimedLine/lyricsMapper,
DB-колонка lyrics_word_data и таблица lyrics_jobs (миграция 004). Обычный строчный LRC сохранён.
✅ Фаза 2: Веб-клиент — ЗАВЕРШЕНА (с фиксам по аудиту)
Задача
TagEditorModal.tsx 888 → 158 + 7 модулей (hook + 4 таба + карточка + утилиты)
AppleLyricsStream.tsx 832 → 326 + 4 модуля (WordTimedLine, LyricLineRow, lyricsDepth, useKaraokeGeneration)
HomeScreen.tsx 702 → 495 + islands/ + demoMix
usePlayerStore.ts — helpers вынесены (accent, lyrics parsing, demo-guard), API не изменён
Верификация: tsc strict ✓, build ✓, 20/20 тестов ✓
Аудит-фикс: polling cleanup в useKaraokeGeneration (оба модуля удалены вместе с word-level пайплайном)
🔄 Фаза 3: iOS — В ПРОЦЕССЕ (декомпозиция завершена, верификация ручным прогоном)
Задача
✅ FullPlayerModal.js (2 412 → 816) + fullplayer/: BlurOverlays, MiniPlayerBar, PlayerControls, QueuePanel, ProgressBar, ChasingArrowsIcon, playerStyles + lyrics/ (AppleLyricsView, AnimatedLyricLine, lyricDepth)
✅ App.js (671 → 157) — composition root + navigation/ (RootNavigator, MainTabs)
✅ TrackEditScreen.js (724 → 467) + trackEditScreenStyles.js; LoginModal.js (739 → 443) + loginModalStyles.js
✅ Тесты (0% → базовые): jest-expo@~57.0.5, utils/lrcParser + lyrics/lyricDepth, 7/7; jest moduleNameMapper для вложенного expo-modules-core
⏳ TypeScript-миграция (v2-скоуп, опционально) — не начата
🔍 Очистка и CI (фикс сборки unsigned IPA): удалён мёртвый components/MiniPlayer.js и мёртвые экспорты usePlayerController; удалён устаревший/несовместимый `expo-av` (ломал компиляцию EXAV в SDK 57); expo обновлен до ~57.0.26 и expo-modules-jsi до 57.1.1; удалены устаревший patch-expo-jsi.js и postinstall-хуки; workflow build-ios-unsigned.yml переписан на чистый runner macos-26 с дефолтным Xcode 26.6 в Release-конфигурации; сборка успешно проверена в CI (Puuk-unsigned.ipa 11 MB ✓)
✅ Фоновый звук и Lock Screen (iOS): активирован системный аудиорежим (`setAudioModeAsync({ shouldPlayInBackground: true, playsInSilentMode: true, interruptionMode: 'doNotMix' })`), зарегистрированы метаданные и команды MPRemoteCommandCenter/NowPlayingInfo (`player.setActiveForLockScreen(true, metadata, { isLiveStream: false, showSeekForward: false, showSeekBackward: false })`) для экрана блокировки, Пункта управления, Dynamic Island и гарнитур (кнопки Next/Previous трека `|<<` и `>>|` вместо 10-секундной перемотки через патч `MediaController.swift`, автоматический переход по окончании трека).
✅ Сохранение сессии и автологин (iOS): последовательный старт в App.js (`loadSettings()` применяется до вызова `checkAuth()`, устранён race condition с дефолтным URL); `checkAuth()` больше не сбрасывает токен при сетевых ошибках или временных сбоях сервера (только при явном 401); для `SecureStore` задан надёжный уровень доступа Keychain `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`; мгновенное восстановление профиля из локального кэша (`savedUser`) без моргания экрана входа.
✅ iOS аудит-фиксы: mergeUniqueQueue сохраняет голову буфера (slice(0,max) — первый будущий трек не теряется), queueEpochRef — устаревшие ответы fetchQueue инвалидируются при смене режима (race playTrack→playTrackList), fetchNextTrack передаёт exclude из истории/queued из буфера (семантика этапа 2), package-lock registry нормализован к npmjs (233 URL было npmmirror)
Верификация: expo export bundle 3.8MB ✓, eslint ✓, jest 7/7 ✓, CI unsigned IPA Release build 11MB ✓ (Run #15 SHA256 `422837c042...`); ручной прогон на устройстве — за пользователем
✅ iOS wave parity (Orca-разведка + фикс): fetchQueue передаёт exclude_track_ids/queued_track_ids (паритет с backend-контрактом), merge-with-dedup вместо замены очереди (cap 20), мёртвый /api/wave/listen → /api/wave/feedback (finish/skip по прогрессу), isWaveSessionRef-gate: prefetch не загрязняет ручные плейлисты, in-flight guard fetchNextTrack (двойной Next), история сессии cap 50
✅ Закрытый доступ и аутентификация обложек (Backend + iOS):
- Backend: эндпоинты `/api/cover/{track_id}` и `/api/color/{track_id}` поддерживают аутентификацию через `?token=` (параллельно с `Bearer` и `?mt=`) для системных загрузчиков (iOS Lock Screen artwork); закрыт анонимный доступ к трекам/библиотеке/альбомам/поиску (`current_user: dict = Depends(get_current_user)`); Swagger/OpenAPI закрыты по умолчанию (`ENABLE_DOCS=false`).
- iOS: `CoverImage` синхронно читает кэшированный токен (`getCachedAuthToken`, `getCachedAuthHeaders`) без вспышек 401 и пустых неавторизованных запросов; `resolveCoverUri` нормализует относительные/абсолютные пути под актуальный `SERVER_URL` и передаёт `?token=` для нативного кеша; `usePlayerController` передаёт нормализованный URL обложки в `setActiveForLockScreen`; юнит-тесты `coverImageUtils.test.js` (8/8 тестов).
- Верификация: brain 236/236 тестов ✓, web 70/70 тестов ✓, iOS jest 15/15 тестов ✓.
📋 Отложенные задачи (backlog)
1. ✅ Nested buttons в кликабельных карточках — ЗАКРЫТО (HomeIslands.tsx ×4, HomeScreen.tsx, RecommendationShelf.tsx: inner buttons получили свой onClick + e.stopPropagation(); контракт: интерактивные элементы не вкладываются)
2. ✅ Изоляция тестовой БД — ЗАКРЫТО (PUUK_DB_PATH env + brain/test_db_path.py, резолв пути на вызов в repositories/base.py; прогоны тестов больше не пишут в puuk.db). Остаток: ~99 тестовых записей в puuk.db требуют ручной чистки (решение по данным — за пользователем)
3. Компонентные тесты веба — TagEditor, lyrics hook (rendering-тесты отсутствуют)
4. Общий LRC-парсер — дублирование в 3 местах (brain, web, iOS)
5. ✅ git репозиторий и origin синхронизированы
6. Декомпозиция HomeScreen глубже (useHomeCatalogData, HomeSearchResults) — 495 строк всё ещё много

💿 Альбомы как доменная сущность (ЗАВЕРШЕНО):
- Идентичность = (title, album_artist); миграция 008 + backfill в Python: нормализация NFKC/whitespace/case, вывод album_artist/year из треков, слияние дублей с одинаковой идентичностью, уникальный индекс idx_albums_identity; реальная legacy puuk.db мигрирует без потери треков
- Backend: repositories/albums.py переписан (resolve_album как единая точка, каталог одним SQL без N+1, детерминированный порядок disc→track→title→id, детерминированная обложка, merge/rebind/cleanup); единый resolve_album в library_service/scan/heavy_worker/track_metadata_service
- API: GET /api/albums → полный DTO (artist, album_artist, year, track_count, total_duration, cover_id/coverArt); GET /api/albums/{id} → конверт {album, tracks} + 404; PATCH /api/albums/{id} → правка релиза (title/album_artist/year в ID3 всех треков, обложка на весь релиз, авто-merge при конфликте идентичности, partial-ответ при сбое отдельного файла)
- Web: AlbumDetail по конверту + метаданные, AlbumEditorModal (store), кликабельные альбомы в LibraryDrawer через useAlbumNavigationStore, инвалидации кэша
- iOS: Artist на карточках, AlbumScreen по конверту (artist/year/count, retry/empty), fix ellipsis callback, новый AlbumEditScreen
- Верификация: brain 164/164, web build+lint+test 34/34, iOS expo export + eslint + jest 7/7
- ⏳ Остаток: ручной прогон iOS на устройстве (за пользователем)

🌊 «Моя Волна» — рефакторинг (3 этапа, ЗАВЕРШЁН):
- Этап 1 (web): последовательное потребление пачки в nextTrack(), wavePlayedIds, prefetch, единый in-flight promise, compactWaveQueue, dedup, лимиты буфера
- Этап 2 (backend): exclude_track_ids + queued_track_ids (уровни: dislike → queued → recent), select_diverse_recommendations (лимит 2 трека/артист), _ArtistResolver (1 SQL-запрос/пачка), artist из file_path как fallback
- Этап 3 (backend): cold start из пула 50 (random.choice), exploration-пул от вектора вкуса (WAVE_EXPLORE_RATIO=0.25), band-jitter (eps=0.02), payload Qdrant обогащён artist/title (scan.py/heavy_worker.py), WAVE_RECO_DEBUG-счётчики, WAVE_PERSONALIZATION_WEIGHT 0.3→0.35
- Верификация: brain 60/60, web 12/12, e2e: 40+/40+ уникальных треков, 8 исполнителей/пачка, 0 повторов

🔊 Нормализация громкости (EBU R128 / LUFS) — ЗАВЕРШЕНО (Backend + Web):
- Алгоритм: EBU R128 / LUFS-I (-14 LUFS, gain [-12 dB, +12 dB], ceiling -1 dBTP). Оригинальные файлы не изменяются.
- Backend:
  - Миграция 009: `loudness_lufs`, `true_peak_db`, `normalization_gain_db`, `loudness_status`, `loudness_analyzed_at`, `loudness_analysis_version`, `loudness_file_size`, `loudness_file_mtime_ns`, `loudness_error`, `loudness_retry_count` + индекс `idx_tracks_loudness_status`.
  - Модуль `brain/services/loudness.py`: расчет безопасного gain, вызов `ffmpeg loudnorm print_format=json` (надёжный JSON-парсер с балансировкой скобок), обработка ошибок, timeout, -inf/NaN, safe clamp [-12, +12].
  - Схема и миграции: `apply_migrations()` строго идемпотентен (проверка `PRAGMA table_info` перед ADD/DROP COLUMN), откат транзакции при сбое, `verify_and_repair_schema` гарантирует полноту колонок даже на частично мигрированных legacy-базах.
  - Сканер `scan.py`: отказ от 1-секундного допуска mtime (точное наносекундное локальное сравнение), сохранение `file_size` и `file_mtime_ns` напрямую в SQLite (`add_or_update_track`), сброс в `loudness_status='pending'` с очисткой retry-счетчика.
  - Воркер `heavy_worker.py`: автоматический retry треков с `status='failed'` (до 3 попыток с cooldown 300с), сохранение ошибки в БД, сохранение наносекундной точности сканера при совпадении SFTP-секунд, поддержка CLI `--loudness-backfill` и `--retry-failed-loudness`.
  - API & DTO: `normalization_gain_db`, `loudness_status`, `loudness_lufs`, `true_peak_db` в `serialize_track`.
- Web:
  - `AudioEngine.ts`: разделение `userVolume` и `normalizationGainDb`, устранение двойного умножения (`audio.volume = 1` при Web Audio, `GainNode.gain = userVolume * normalizationGain`), плавный переход ~200 мс (`setTargetAtTime`), fallback для сред без Web Audio.
  - `usePlayerStore.ts`: реактивное переключение и пересчет громкости на лету, строгое валидирование localStorage (`puuk:loudness-normalization:v1`) с fallback на `true` для любых поврежденных или неизвестных значений.
  - UI: `ProfileCapsuleMenu` в `HomeScreen` с доступным переключателем (switch) нормализации, профилем пользователя и логаутом.
- Верификация: brain 195/195 тестов ✓, web 54/54 тестов + lint + build ✓, iOS jest 7/7 + eslint ✓.
- ⏳ iOS: добавление нормализации на клиенте Expo Audio отложено отдельным этапом.
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
