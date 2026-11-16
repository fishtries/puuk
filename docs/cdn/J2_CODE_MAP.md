# J2 — Карта кода воспроизведения, авторизации, ссылок и владения файлами

**Дата:** 2026-11-16  
**Задача:** J2 (Auditing playback, streaming, tickets, auth, file lifecycle, IDs, web/iOS playback, share UI, navigation and disjoint write sets)  
**Исполнитель:** Native Antigravity agent (`gemini-3.8-flash-high`) [замена неудачного запуска OpenCode]  
**Базовая ревизия:** `89ebc1c30b36837e584fbe72d51cdb0aed6303be` + незакоммиченные локальные изменения из `docs/cdn/BASELINE_MANIFEST.json`  
**Целевой статус:** Готовность к Gate G1 (контракт S1)  

---

## 1. Введение и область аудита

Настоящий документ фиксирует результаты аудита кодовой базы Puuk (FastAPI backend, React Web SPA, Expo SDK 58 React Native iOS) перед заморозкой архитектурного контракта CDN и постоянных ссылок (G1 / S1).

Все выводы основаны на непосредственном анализе исходных файлов, тестов и схемы базы данных. Отсутствующие возможности зафиксированы явно (как доказанное отсутствие кода), без домыслов и архитектурных допущений.

---

## 2. Backend (FastAPI, SQLite, Qdrant)

### 2.1. Стриминг аудио (`brain/routers/streaming.py`)

- **Маршрут:** `GET /api/stream/{track_id}`
- **Контроллер:** `stream_track(track_id: str, current_user: dict = Depends(get_stream_user))`
- **Политика доступа:** Строго авторизованный через `get_stream_user` (Bearer JWT либо media-тикет `?mt=`). Без валидных реквизитов возвращается HTTP 401.
- **Резолв файла:**
  1. Чтение записи трека из SQLite через `db.get_track(track_id)`.
  2. Если записи в SQLite нет — вызывается `_recover_missing_track(track_id, "stream")` -> `services.media_locations.ensure_track_in_db(track_id)` (однократный fallback-запрос в Qdrant).
  3. Проверка безопасности файлового пути: `_resolve_db_file_path(db_track)` -> `services.media_locations.resolve_safe_music_file(path)`. Путь обязан быть строго внутри `MUSIC_DIR` (проверка `os.path.commonpath((root, target)) == root` исключает Path Traversal).
  4. Если файл отсутствует на диске или выходит за пределы `MUSIC_DIR` -> HTTP 404.
- **Выдача аудио и Range:**
  - Возвращается Starlette `FileResponse(path=file_path, media_type=get_media_type(file_path), filename=os.path.basename(file_path))`.
  - HTTP Range поддерживается движком Starlette автоматически: корректно обрабатываются заголовки `Range: bytes=START-END`, `Range: bytes=START-`, `Range: bytes=-SUFFIX`.
  - Ответы:
    - HTTP 206 Partial Content с заголовками `Accept-Ranges: bytes`, `Content-Range: bytes START-END/TOTAL`, `Content-Length: CHUNK_SIZE`.
    - HTTP 416 Range Not Satisfiable (`Content-Range: bytes */TOTAL`) при запросе за пределами файла.
    - HTTP 400 Bad Request при синтаксически невалидном Range.
- **Доказательства:** `brain/test_media_ticket.py:TestStreamContract` (тесты `test_01`–`test_13`).

### 2.2. Media Tickets (`brain/routers/streaming.py`, `brain/auth.py`)

- **Маршрут:** `POST /api/media-ticket`
- **Контроллер:** `issue_media_ticket(payload: MediaTicketRequest, current_user: dict = Depends(get_current_user))`
- **Входной DTO:** `MediaTicketRequest { track_id: str }`
- **Выходной DTO:** `MediaTicketResponse { url: str, expires_in: int, expires_at: int }`
- **Проверки перед выпуском:**
  - Валидация формата UUID (`uuid.UUID(payload.track_id)` -> 400 при некорректном ID).
  - Проверка наличия записи в SQLite (`db.get_track`) либо Qdrant (`_recover_missing_track`).
  - Проверка физического присутствия файла на диске внутри `MUSIC_DIR` (`_resolve_db_file_path`). Если файл отсутствует -> HTTP 404 (тикет на несуществующий файл не выпускается).
- **Криптографическая подпись и структура токена:**
  - Функция: `brain/auth.py:create_media_ticket_with_expiry(user, track_id)`.
  - Алгоритм: HS256 с использованием `JWT_SECRET`.
  - Полезная нагрузка (Payload):
    ```json
    {
      "sub": "<user_id>",
      "tid": "<track_id>",
      "scope": "media",
      "jti": "<uuid4_hex>",
      "iat": <now_timestamp>,
      "exp": <expires_at_timestamp>
    }
    ```
  - Время жизни: `MEDIA_TICKET_TTL_SECONDS = int(os.getenv("MEDIA_TICKET_TTL_SECONDS", "600"))` (по умолчанию 600 секунд = 10 минут).
  - Сгенерированный URL: `/api/stream/{track_id}?mt={ticket}`.
- **Проверка тикета:**
  - Функция: `brain/auth.py:verify_media_ticket(token, track_id)`.
  - Валидирует HS256-подпись секретом `JWT_SECRET`.
  - Проверяет `scope == "media"`, совпадение `tid == track_id`, актуальность `exp`.
  - Проверяет существование пользователя `sub` в базе данных (`db.get_user_by_id`).
  - Обычный access JWT (без `scope: "media"`) отвергается.
- **Хранилище тикетов: Сверка плана (`repositories/media_tickets.py`) и фактического кода:**
  - *Несоответствие с планом:* В `brain/AGENTS.md:46` и проектных планах `media_tickets` упоминается в списке доменных модулей каталога `brain/repositories/`.
  - *Фактическое состояние исходного кода:*
    1. Файл `brain/repositories/media_tickets.py` **НЕ СУЩЕСТВУЕТ** на диске (в каталоге `brain/repositories/` присутствуют только `albums.py`, `artists.py`, `favorites.py`, `history.py`, `playlists.py`, `stats.py`, `tracks.py`, `users.py`, `wave_feedback.py`).
    2. В схеме базы данных SQLite (`brain/schema.py`, `brain/db.py`) **НЕТ ТАБЛИЦЫ** для медиа-тикетов (нет таблиц `media_tickets`, `tickets` или аналогичных).
    3. Контроллер `brain/routers/streaming.py:11` импортирует функции тикетов напрямую из модуля авторизации:
       ```python
       from brain.auth import (
           get_current_user,
           get_stream_user,
           create_media_ticket_with_expiry,
           verify_media_ticket,
       )
       ```
    4. Реализация в `brain/auth.py:94-139`: тикеты медиа представляют собой **полностью stateless в памяти** HS256 JWT токены. При выпуске тикета в базу данных ничего не пишется; при валидации тикета через `verify_media_ticket` проверяется только криптографическая подпись секретом `JWT_SECRET` и факт существования пользователя в таблице `users` (`db.get_user_by_id`).
    5. *Вывод для G1 / S1 / S2*: Никакого существующего DB-слоя для медиа-тикетов нет. Если для CDN потребуется сохранение состояния, отзыв тикетов (revocation) или аудит сессий, соответствующий репозиторий `repositories/media_tickets.py` и миграция БД должны создаваться с нуля в рамках S2.

### 2.3. Аутентификация (`brain/auth.py`, `brain/routers/auth.py`)

- **Токены пользователей:** JWT HS256 со сроком жизни 30 дней (`JWT_EXPIRATION_DAYS`).
- **Секрет:** `JWT_SECRET` из переменных окружения. При отсутствии генерируется одноразовый случайный `secrets.token_hex(32)`.
- **Зависимости FastAPI:**
  - `get_current_user`: строго заголовок `Authorization: Bearer <token>`. 401 при отсутствии, просрочке или удалении пользователя.
  - `get_stream_user`: проверяет Bearer JWT, при отсутствии проверяет `?mt=` через `verify_media_ticket`.
  - `get_cover_user`: проверяет Bearer JWT -> `?token=` (для фоновых загрузчиков обложек iOS Lock Screen) -> `?mt=`.
  - `get_optional_current_user`: возвращает `None` при отсутствии заголовка.
  - `get_current_admin_user`: требует `role == 'admin'`.
- **Вход:** `POST /api/auth/login` (логин/пароль) и `POST /api/auth/verify-code` (одноразовый код Telegram OTP из таблицы `auth_codes`).

### 2.4. Жизненный цикл файлов: импорт, замена, удаление, запись тегов

- **Импорт файлов:**
  - Telegram-бот: `tg_music_bot/downloader.py` скачивает трек через `source_worker.py`, проверяет provenance/теги, затем `_publish_tracks` связывает файл через hardlink (`os.link`) в `MUSIC_DIR` (при коллизии имени файла добавляет хеш sha256 `basename-<sha256[:16]>.ext`).
  - Сканер: `brain/scan.py` (CLI или через `POST /api/library/scan` в `brain/routers/library.py`).
    - Сканирует `MUSIC_DIR`.
    - Вычисляет детерминированный `point_id = str(uuid.uuid5(uuid.NAMESPACE_URL, rel_path))`.
    - Извлекает аудиопараметры и теги (`read_audio_metadata`).
    - Добавляет/обновляет трек в SQLite: `db.add_or_update_track` в `brain/repositories/tracks.py`.
    - Создает/обновляет точку в Qdrant.
- **Запись тегов и мутация файла:**
  - Маршрут: `PATCH /api/tracks/{track_id}` в `brain/routers/tracks.py`.
  - Сервис: `brain/services/track_metadata_service.py:mutate_track_metadata`.
  - Протокол безопасной записи:
    1. Проверка прав (администратор либо создатель трека `added_by_user_id`).
    2. Двухуровневая блокировка: межпоточный `threading.Lock` + файловый lock (`.lock` в каталоге файла через `metadata.py:track_mutation_lock`).
    3. Журналирование мутации в `track_mutation_journal` со статусом `prepared` и фиксацией старого `size`/`mtime_ns`.
    4. Атомарная запись через mutagen во временный файл и подмена: `metadata.py:safe_replace_audio_file`.
    5. Обновление журнала: `replaced`.
    6. Повторное чтение проверенных тегов из файла на диске.
    7. Обновление SQLite через `db.update_track_metadata_from_audio`: записываются новые `file_size`, `file_mtime_ns`, при смене обложки инкрементируется `cover_version`, пересчитывается доминирующий цвет через `ColorThief`.
    8. Вызов `bump_catalog_version(conn)` инкрементирует `catalog_meta.catalog_version`.
    9. Фиксация журнала: `committed`.
- **Удаление файлов:**
  - Маршрут: `DELETE /api/tracks/{track_id}` в `brain/routers/tracks.py`.
  - Сервис: `brain/services/track_deletion_service.py:delete_track_everywhere`.
  - Порядок удаления:
    1. Удаление вектора из Qdrant (`qdrant_client.delete(collection_name, points_selector=[track_id])`).
    2. Физическое удаление файла с диска (`os.remove`), строго проверенное на принадлежность к корням удаления (`MUSIC_DIR` и `temp_audio`).
    3. Каскадное удаление записи из SQLite через `db.delete_track(track_id)`: транзакция удаляет строку из `tracks`, зависимые строки удаляются по foreign key (`playlist_tracks`, `user_favorites`, `user_history`, `user_dislikes`, `user_wave_feedback`, `track_stats`, `track_word_lyrics`), очищаются авторские связи (`forget_artist_credits`), удаляется запись из `track_mutation_journal`, вызывается `bump_catalog_version(conn)`.
    4. Очистка опустевших альбомов через `db.delete_empty_albums()`.

### 2.5. Версионирование сущностей каталога

- **Существующие счетчики и версии:**
  - `tracks.cover_version`: INTEGER DEFAULT 0 — инкрементируется при замене или удалении обложки. Используется в ETag обложки (`_cover_etag`: `"{track_id}-{cover_version}-{file_mtime_ns}"`) и в `?v=` URL обложки.
  - `tracks.file_size`: INTEGER — размер аудиофайла в байтах.
  - `tracks.file_mtime_ns`: INTEGER — время модификации аудиофайла в наносекундах.
  - `catalog_meta.catalog_version`: INTEGER — глобальный счетчик изменений каталога (инкрементируется через `bump_catalog_version`). Используется для HTTP ETag выдачи списка треков `/api/tracks`.
  - `artist_credit_state.revision`: INTEGER — ревизия состава артистов трека или альбома (optimistic concurrency control).
  - `track_word_lyrics`: поля `file_size`, `file_mtime_ns`, `audio_sha256` для сверки соответствия пословного текста.
- **ОТСУТСТВУЮЩАЯ ВОЗМОЖНОСТЬ (MISSING CAPABILITY):**
  - В таблице `tracks` **НЕТ** колонки `content_version` или `audio_sha256`.
  - Версионирование аудиоконтента для CDN cache key в текущей базе может строиться либо на основе составного ключа `"{file_size}_{file_mtime_ns}"`, либо требует введения отдельной колонки/миграции в S2.

### 2.6. Идентификаторы сущностей и семантика объединения (Merge)

- **Треки (`tracks`):**
  - Идентификатор: UUIDv4 / UUIDv5 строка (`TEXT PRIMARY KEY`). Генерируется сканером из относительного пути `rel_path` через `uuid.uuid5(uuid.NAMESPACE_URL, rel_path)`.
  - Семантика объединения: **Merge треков отсутствует**. При переименовании/перемещении файла на диске сканер создает новый `track_id`. Старая запись удаляется при ресинхронизации библиотеки.
- **Альбомы (`albums`):**
  - Идентификатор: Целое число (`INTEGER PRIMARY KEY AUTOINCREMENT`).
  - Уникальность/идентичность: `(title_normalized, album_artist_normalized)`.
  - Семантика объединения: `brain/repositories/albums.py:merge_album_into(source_album_id, target_album_id)`.
    - Все треки из `source_album_id` переводятся в `target_album_id` (`UPDATE tracks SET album_id = target WHERE album_id = source`).
    - Поле `recovery_album_id` в `artist_credit_state` обновляется на целевой альбом.
    - В целевом альбоме заполняются недостающие `year` и `cover_path` из исходного альбома.
    - Исходный альбом **УДАЛЯЕТСЯ** (`DELETE FROM albums WHERE id = source_album_id`).
    - Инкрементируется версия каталога (`bump_catalog_version`).
    - **ВАЖНО ДЛЯ ПОСТОЯННЫХ ССЫЛОК**: Таблицы алиасов/редиректов для старых `album_id` нет. После merge ссылка на `source_album_id` вернет 404, если в S1/S2 не спроектирована таблица перенаправлений.
- **Артисты (`artists`):**
  - Идентификатор: Детерминированная строка с префиксом `art_` и 32 hex-символами sha256 от нормализованного имени: `'art_' + hashlib.sha256(normalize_artist_name(name).encode('utf-8')).hexdigest()[:32]`.
  - Нормализация: `unicodedata.normalize('NFKC', name)` со сжатием пробелов.
  - Зарезервированное имя: `"various artists"` (в любом регистре) признается служебным и **не получает** `artist_id` (`artist_id_for_name` возвращает `None`).
  - Связи: Таблицы `track_artists(track_id, artist_id, position)` и `album_artists(album_id, artist_id, position)`.
  - Семантика объединения: Специфического `merge_artists` нет, так как идентификатор жестко детерминирован именем артиста. Правка артистов выполняется через редактор составов `services/artist_credit_service.py` и ревизии в `artist_credit_state`.

---

## 3. Web-клиент (React, TypeScript, Web Audio)

### 3.1. Аудиоплеер и воспроизведение (`app/web/src/engine/AudioEngine.ts`, `app/web/src/store/usePlayerStore.ts`)

- **Движок `AudioEngine`:**
  - Обертка над синглтоном `HTMLAudioElement` с подключением к Web Audio API.
  - Граф Web Audio: `audio` -> `MediaElementAudioSourceNode` -> `GainNode` (нормализация громкости) -> `AnalyserNode` -> `AudioContext.destination`.
  - CORS: Строка 41: `this.audio.crossOrigin = 'anonymous'`.
    - **КРИТИЧЕСКОЕ ТРЕБОВАНИЕ К CDN/ORIGIN**: Поскольку элемент `<audio>` подключен к `createMediaElementSource`, отсутствие валидных CORS-заголовков (`Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`) на аудиоответах (включая 200, 206, 403, 404, 416) приведет к security-taint аудиоэлемента и полному заглушению звука в браузере.
- **Запуск трека (`usePlayerStore.playTrack`):**
  - Инкрементирует токен поколения: `const generation = ++audioLoadGeneration`.
  - Синхронно глушит старый источник: `audioEngine.stop()`.
  - Устанавливает статус `'loading'`.
  - Запрашивает URL потока: `const streamUrl = await resolveAuthorizedAudioUrl(track.id)`.
  - Проверяет актуальность поколения `generation === audioLoadGeneration`.
  - Рассчитывает gain нормализации и вызывает `audioEngine.load(streamUrl, { autoplay: true, normalizationGainDb })`.
- **Режимы очереди и волны:**
  - Обычная очередь: массив `queue: Track[]`, индекс `currentTrackIndex`.
  - Переход к следующему: `goToNextTrack(reportSkip: boolean)` вызывается вручную либо по событию `audioEngine.on('ended')`.
  - Повтор: `repeatMode: 'off' | 'all' | 'one'`. При `'one'` вызывается `audioEngine.seek(0); audioEngine.play();`.
  - Моя Волна: активируется флагом `isWaveActive: true`. Очередь динамически пополняется через `fetchWaveQueue` (с дедупликацией параллельных запросов через `waveFetchPromise` в `app/web/src/store/waveQueue.ts`).
  - Перемотка (Seek): `audioEngine.seek(seconds)` -> `this.audio.currentTime = seconds`.
- **Предзагрузка (Preload):**
  - **ОТСУТСТВУЕТ ДЛЯ АУДИО**. В коде задано только `this.audio.preload = 'metadata'`. Предзагрузка следующих треков в фоне в вебе не реализована.
- **Локальная загрузка / Offline (Download/Offline):**
  - **ОТСУТСТВУЕТ**. Веб-клиент работает исключительно в онлайн-режиме потокового воспроизведения.

### 3.2. Авторизация, кеш тикетов и очистка при Logout (`app/web/src/api/media.ts`, `app/web/src/store/useAuthStore.ts`)

- **Получение тикета (`resolveAuthorizedAudioUrl`):**
  - Проверяет кеш `ticketByTrackId` (Map, лимит `TICKET_CACHE_LIMIT = 200`).
  - Проверяет срок действия: запас до истечения `TICKET_EXPIRY_MARGIN_MS = 5000` (5 секунд).
  - Проверяет совпадение токена: `cached.authToken === authToken`.
  - При промахе вызывает `POST /api/media-ticket` через `apiClient` с `Authorization: Bearer <puuk_token>`.
  - Возвращаемый относительный путь `/api/stream/...` дополняется до абсолютного через `API_BASE_URL`. Если сервер вернул абсолютный URL (например, `https://media.puuk.fun/...`), он используется без изменений.
- **Очистка сессии (Logout) — ДОКАЗАННЫЕ ДЕФЕКТЫ С ПРЯМЫМИ ССЫЛКАМИ НА КОД:**
  - Процедура логаута реализована в `app/web/src/store/useAuthStore.ts:20-33`:
    ```typescript
    clearUserSession: () => {
      localStorage.removeItem('puuk_token');
      queryClient.clear();
      queryClient.removeQueries();
      usePlayerStore.getState().resetUserData();
      set({ user: null, isAuthenticated: false, error: null });
    },
    ```
  - **ДЕФЕКТ 1 (Утечка кэша тикетов):**
    - В `app/web/src/api/media.ts:115-117` объявлена функция сброса кэша:
      ```typescript
      export function resetAudioTicketCache(): void {
        ticketByTrackId.clear();
      }
      ```
    - Поиск по кодовой базе показывает, что `resetAudioTicketCache()` импортируется и вызывается **исключительно в тестах** (`app/web/src/store/__tests__/usePlayerStore.stream.test.ts:139`, `app/web/src/store/__tests__/usePlayerStore.wave.test.ts:153`).
    - `clearUserSession()` в `useAuthStore.ts` **НЕ вызывает** `resetAudioTicketCache()`. В результате тикеты предыдущего пользователя сохраняются в Map в оперативной памяти до перезагрузки страницы (хотя проверка `cached.authToken === authToken` блокирует их повторное использование новым пользователем, отсутствие очистки оставляет чувствительные токены в памяти).
  - **ДЕФЕКТ 2 (Неконтролируемое фоновое воспроизведение после выхода):**
    - Метод `resetUserData()` в `app/web/src/store/usePlayerStore.ts:804-806` сбрасывает только историю:
      ```typescript
      resetUserData: () => {
        set({ history: [], recentlyPlayed: [], isHistoryLoading: false });
      },
      ```
    - При выходе из учетной записи:
      - **НЕ вызывается** `audioEngine.stop()`.
      - **НЕ сбрасываются** `currentTrack`, `currentTrackIndex`, `queue` и `playbackStatus`.
      - **НЕ отменяются** in-flight загрузки аудио (переменная `audioLoadGeneration` в замыкании `usePlayerStore.ts` не сбрасывается).
    - В `app/web/src/App.tsx:74-79`:
      ```tsx
      {!user && (
        <LoginModal
          isOpen={true}
          onSuccess={() => {}}
          mandatory={true}
        />
      )}
      ```
      Поверх интерфейса монтируется модальное окно авторизации (`mandatory={true}`), однако фоновый синглтон `AudioEngine` (`audioElement`) продолжает играть трек разлогиненного пользователя прямо под модалкой.
- **Смена адреса сервера:**
  - В веб-клиенте адрес задается константой `BASE_URL` на этапе сборки через `VITE_API_URL` в `api/client.ts`. Возможности динамической смены backend URL в интерфейсе веба нет.

### 3.3. Навигация, Share UI и восстановление после входа (`app/web/src/App.tsx`)

- **Архитектура навигации:**
  - **Роутер отсутствует**. Библиотека `react-router` не используется.
  - Вся навигация управляется состоянием React: `viewMode` (`'home' | 'lyrics'`) в `App.tsx`, `activeTab` (`'home' | 'library' | 'search'`) в `HomeScreen.tsx`, а также состоянием модальных окон.
  - Просмотр альбомов: локальный стейт `selectedAlbum` в `HomeScreen` -> рендер `<AlbumDetail />`.
  - Просмотр плейлистов: локальный стейт `selectedPlaylist` в `HomeScreen` -> рендер `<PlaylistDetail />`.
- **ОТСУТСТВУЮЩИЕ ЭКРАНЫ И ВОЗМОЖНОСТИ (MISSING CAPABILITIES & INVARIANTS):**
  - **СТРОГИЙ ЗАПРЕТ АВТОВОСПРОИЗВЕДЕНИЯ ПРИ ПЕРЕХОДЕ ПО ССЫЛКЕ (NO AUTOPLAY INVARIANT):**
    - В соответствии с разделами 5.7 и 8 `docs/CDN_AND_SHARE_LINKS_ORCHESTRATION_PLAN.md`, входящие постоянные ссылки (`/track/:id`, `/album/:id`, `/artist/:id`) **КАТЕГОРИЧЕСКИ НЕ ДОЛЖНЫ АВТОВОСПРОИЗВОДИТЬСЯ (MUST NOT AUTOPLAY)**.
    - Переход по ссылке обязан лишь загрузить метаданные сущности и отобразить явную карточку превью / контекстный модал (Preview Card / Modal Sheet).
    - Воспроизведение трека или альбома должно стартовать **исключительно по прямому осознанному клику пользователя на кнопку «Play» / «Слушать»**.
    - Входящая ссылка не должна автоматически сбрасывать или замещать текущую очередь воспроизведения (`queue`), если у пользователя уже играет музыка.
  - **Отсутствует экран трека:** отдельного представления для одного трека нет. Трек открывается только воспроизведением в плеере либо в модалке редактирования тегов.
  - **Отсутствует экран артиста:** в вебе нет `ArtistDetail`.
  - **Отсутствует Share UI:** в интерфейсе нет кнопок «Поделиться», генерации ссылок или копирования в буфер обмена.
  - **Отсутствует обработка входящих ссылок:** нет парсера `window.location.pathname` для `/track/:id`, `/album/:id`, `/artist/:id`.
  - **Отсутствует сохранение цели при входе:** если пользователь не авторизован, `App.tsx:74-79` показывает `LoginModal mandatory`. После успешного входа пользователь попадает на стандартный `HomeScreen`, целевой трек/альбом не сохраняется и не открывается.

---

## 4. iOS-клиент (React Native, Expo SDK 58)

### 4.1. Архитектура воспроизведения (`utils/playbackCoordinator.js`, `utils/streamUrl.js`)

- **Координатор воспроизведения:** `PlaybackCoordinator` (синглтон `defaultPlaybackCoordinator`), управляющий жизненным циклом через события нативного плеера `expo-audio`.
- **Контроллер хука:** `app/ios/puuk-ios/hooks/usePlayerController.js`.
- **Синхронность резолва streamUrl:**
  - Функция `normalizeStreamUrl(track, serverUrl)` в `utils/streamUrl.js` является **строго синхронной чистой функцией**.
  - Формирует строку: `${cleanServerUrl}/api/stream/${encodeURIComponent(trackIdStr)}`.
  - Вызывается синхронно в `playbackCoordinator.js`:
    - Строка 620 (`_performRemoteRecovery`)
    - Строка 1359 (`_preloadNextItem`)
    - Строка 2034 (`play`)
    - Строка 2360 (`play` перед установкой источника)
  - Вызывается синхронно в `preloadScheduler.js`:
    - Строка 88 (`this.getStreamUrl = options.getStreamUrl || ((t) => normalizeStreamUrl(t, this.serverUrl))`)
    - Строка 591 (`startTask`)
- **ПРОВЕРКА ГРАНИЦЫ КООРДИНАТОРА (SYNC-TO-ASYNC PROHIBITION):**
  - **Нельзя скрытно превратить `normalizeStreamUrl` в асинхронную функцию (Promise)**.
  - Любой возврат `Promise` из `normalizeStreamUrl` немедленно приведет к runtime-ошибкам:
    - В `playbackCoordinator.js:2044`: вызов `normalizedStreamUrl.startsWith('http')` упадет с `TypeError: normalizedStreamUrl.startsWith is not a function`.
    - В `preloadScheduler.js`: вызов `cache.download(trackId, remoteUri)` получит `remoteUri = "[object Promise]"`.
    - Упадут все тесты в `playbackCoordinator.test.js` и `streamUrl.test.js`.
  - Асинхронное получение CDN-разрешений/тикетов обязано выполняться как явная асинхронная фаза на уровне `PlaybackCoordinator` (по аналогии с существующим получением заголовков `_getHeadersAsyncFn`), а не внутри синхронных хелперов URL.

### 4.2. Нативные Bearer-заголовки и редиректы в iOS

- **Передача заголовков в нативный плеер:**
  - В `playbackCoordinator.js:2320-2328`, `2366-2368`: если заголовки не переданы синхронно в опциях, вызывается асинхронный геттер `headersGetter()` (читает токен авторизации из `expo-secure-store` через `_getHeadersAsyncFn`).
  - Заголовки упаковываются в нативный `AudioSource`: `{ uri: finalStreamUrl, headers: { Authorization: "Bearer <token>" } }`.
  - Модуль `expo-audio` передает словарь заголовков в Swift: `AVURLAsset(url: finalUrl, options: ["AVURLAssetHTTPHeaderFieldsKey": headers])`.
- **РАЗГРАНИЧЕНИЕ: ПОДТВЕРЖДЕННЫЙ ИСХОДНЫЙ КОД И НЕВЕРИФИЦИРОВАННЫЙ RUNTIME:**
  1. **Подтверждено анализом исходного кода (Source-Confirmed Fact):**
     - Если `finalStreamUrl` указывает на CDN-хост (`https://media.puuk.fun/...`), а в `headers` смонтирован Bearer-токен, нативный `AVPlayer` **напрямую отправит пользовательский JWT на серверы CDN Yandex**. Это подтвержденная кодом утечка авторизационных реквизитов во внешнюю инфраструктуру, прямо запрещенная требованиями безопасности (раздел 5.5 Orchestration Plan).
  2. **Неверифицированное в runtime поведение AVFoundation при редиректах (Unverified Runtime Hypothesis):**
     - Согласно спецификациям RFC 7235 и документации `NSURLSession` / `AVURLAsset`, сетевой стек Apple при междоменных HTTP 302/307 редиректах (например, с `web.puuk.fun` на `media.puuk.fun`) удаляет конфиденциальный заголовок `Authorization` (stripping).
     - **КРИТИЧЕСКОЕ ПРЕДУПРЕЖДЕНИЕ**: Данное поведение является архитектурным свойством платформы Apple, однако **НЕ БЫЛО экспериментально подтверждено runtime-проверкой на реальном iOS-устройстве или симуляторе для данного приложения**. Делать однозначные гарантии поведения на уровне выполнения (runtime guarantees) исключительно на основе статического анализа исходного кода **недопустимо**.
  3. **Архитектурный вывод для S1 / S4:**
     - Дизайн доставки аудио не должен зависеть от гипотез о поведении редиректов в `AVPlayer`.
     - При воспроизведении через CDN `media.puuk.fun` нативный плеер должен получать самодостаточный подписанный URL с параметрами доступа в query и **СТРОГО ПУСТЫМИ** заголовками `headers: {}`.
     - Заголовок `Authorization: Bearer <token>` должен монтироваться **только** при прямом fallback-обращении к origin-серверу Puuk (`https://web.puuk.fun/api/stream/{id}`).

### 4.3. Предзагрузка, кэширование и Offline в iOS (`utils/preloadScheduler.js`, `utils/audioCache.js`)

- **Планировщик `PreloadScheduler`:**
  - Очередь с приоритетами: `PRIORITY_URGENT = 0`, `PRIORITY_CURRENT = 0.5`, `PRIORITY_NEXT = 1`.
  - Ограничение параллелизма: `maxConcurrent = 2`.
  - Чувствительность к нагрузке плеера (`playbackPressure`): фоновые загрузки немедленно приостанавливаются при фазах `startup`, `stalled`, `recovering`.
  - Учет сетевой политики: следит за состоянием сети (Wi-Fi, сотовая сеть, offline через `expo-network`).
- **Кэш аудио `AudioCache`:**
  - Построен на `expo-file-system` (новые классы SDK 58: `File`, `Directory`, `Paths.document`).
  - Лимит размера: `DEFAULT_MAX_SIZE_BYTES = 500 * 1024 * 1024` (500 МБ).
  - Манифест: `manifest.json` хранит метаданные `[trackId]: { uri, size, mtime, lastAccessed, sourceUri }`.
  - Атомарная загрузка: `File.createDownloadTask` во временный файл `.part.mp3` с последующим перемещением в целевой файл `{trackId}.mp3`.
  - **Ключ кэша:** Строго `trackId` (не URL). Это обеспечивает стабильность локального кэша даже при изменении подписанного CDN URL.
  - Поведение при Logout: Кэшированные файлы на диске не удаляются при выходе из учетной записи, однако доступ к UI блокируется экраном `AppAuthGate`.

### 4.4. Смена адреса сервера в iOS (`shared/storage/settings.js`, `shared/api/api.js`)

- Адрес сервера настраивается в приложении (`Settings -> Server URL`) и сохраняется в SecureStore.
- `App.js` загружает настройку и вызывает `setServerUrl(s.serverUrl)`.
- `PlaybackCoordinator` отслеживает смену адреса:
  ```javascript
  if (this._lastServerUrl && this._lastServerUrl !== currentServerUrl) {
    this._lastServerUrl = currentServerUrl;
    this.serverEpoch += 1;
    if (this.scheduler?.cancelAll) this.scheduler.cancelAll();
  }
  ```
- При смене URL отменяются текущие фоновые предзагрузки, инкрементируется `serverEpoch`, но уже играющий локальный трек не прерывается.

### 4.5. Навигация, Share UI и отсутствующие экраны в iOS

- **Стек экранов (`navigation/RootNavigator.js`):**
  - `MainTabs` (Home, Search, Library)
  - `Album` (`AlbumScreen.js`)
  - `AlbumEdit` (`AlbumEditScreen.js`)
  - `ArtistDetail` (`ArtistScreen.js`)
  - `ArtistCreditBulk` (`ArtistCreditBulkScreen.js`)
  - `ArtistEdit` (`ArtistArtworkEditScreen.js`)
  - `Playlist` (`PlaylistScreen.js`)
  - `TrackEdit` (`TrackEditScreen.js`)
- **ОТСУТСТВУЮЩИЕ ЭКРАНЫ И ВОЗМОЖНОСТИ В IOS:**
  - **Отсутствует экран трека:** Как и в вебе, нет экрана `TrackDetail`. Имеется только `TrackEdit` (редактор тегов) и карточка плеера `FullPlayerModal`.
  - **Отсутствует Share UI:** Ни в `FullPlayerModal` (меню действий `menuActions`), ни в контекстном меню `TrackContextMenuModal` нет кнопки «Поделиться».
  - **Отсутствуют Universal Links:** В `app.json` объявлена только пользовательская схема `puuk://`. Полноценные Universal Links (`https://web.puuk.fun/...`) не настроены (отсутствует `associatedDomains` entitlement `applinks:web.puuk.fun` и серверный `apple-app-site-association`).

---

## 5. Предлагаемые непересекающиеся области записи (Disjoint Write Sets)

Для предотвращения конфликтов параллельной работы агентов после G1 область изменений разделяется на изолированные рабочие наборы.

### 5.1. Матрица владения файлами

| Задача | Роль | Разрешенные файлы для записи (Write Allowlist) | Запрещенные файлы |
|---|---|---|---|
| **S2** | Senior Backend | `brain/routers/streaming.py`<br>`brain/config.py`<br>`brain/auth.py`<br>`brain/services/delivery_service.py` (новый)<br>`brain/services/track_deletion_service.py`<br>`brain/migrations/` (только при необходимости `content_version`) | `brain/routers/wave_recommendations.py`<br>`brain/services/recommendation_service.py`<br>`brain/test_multi_artist_integration.py` |
| **J3** | Junior Backend Tests | `brain/test_cdn_*.py` (новые файлы тестов)<br>`brain/fixtures/` | Файлы production backend из набора S2 |
| **S3** | Senior Web Playback | `app/web/src/api/media.ts`<br>`app/web/src/engine/AudioEngine.ts`<br>`app/web/src/store/usePlayerStore.ts`<br>`app/web/src/store/useAuthStore.ts`<br>`app/web/src/api/client.ts`<br>`app/web/src/store/__tests__/usePlayerStore.stream.test.ts` | Компоненты UI и разметки, не относящиеся к аудиоплееру |
| **S4** | Senior iOS Playback | `app/ios/puuk-ios/utils/streamUrl.js`<br>`app/ios/puuk-ios/utils/playbackCoordinator.js`<br>`app/ios/puuk-ios/utils/preloadScheduler.js`<br>`app/ios/puuk-ios/utils/audioCache.js`<br>`app/ios/puuk-ios/shared/api/media.js` (новый)<br>`app/ios/puuk-ios/utils/__tests__/*.test.js` | `app/ios/puuk-ios/App.js`<br>`app/ios/puuk-ios/hooks/usePlayerController.js`<br>`app/ios/puuk-ios/components/FullPlayerModal.js` |
| **J4** | Junior Web Links | `app/web/src/utils/shareLinks.ts` (новый модуль)<br>`app/web/src/store/useShareNavigationStore.ts` (новый модуль)<br>`app/web/src/utils/__tests__/shareLinks.test.ts` (новый) | `app/web/src/store/usePlayerStore.ts`<br>`app/web/src/App.tsx` (интеграцию выполняет S3) |
| **J5** | Junior iOS Links | `app/ios/puuk-ios/utils/shareLinks.js` (новый модуль)<br>`app/ios/puuk-ios/navigation/linking.js` (новый модуль)<br>`app/ios/puuk-ios/utils/__tests__/shareLinks.test.js` (новый) | `app/ios/puuk-ios/App.js`<br>`app/ios/puuk-ios/components/FullPlayerModal.js` (интеграцию выполняет S4) |

### 5.2. Предупреждения о коллизиях с «грязными» файлами базового состояния

В рабочем каталоге находятся незакоммиченные локальные изменения (`BASELINE_MANIFEST.json`). Любая их модификация или откат строго запрещены:

1. **`app/ios/puuk-ios/App.js` и `hooks/usePlayerController.js`:**
   - Содержат логику дизлайков треков (`handleToggleDislike`, `dislikeIds`, `dislikePending`, загрузка `/api/dislikes`).
   - *Инструкция для S4/J5*: Запрещено перезаписывать эти файлы из старых ревизий git. Интеграцию новых коллбеков производить только точечным добавлением поверх существующего diff.
2. **`app/ios/puuk-ios/components/FullPlayerModal.js` и `PlayerHeader.js`:**
   - Содержат привязку кнопки дизлайка в `menuActions` и отображение состояния.
   - *Инструкция для J5*: Добавление пункта меню «Share» должно встраиваться в массив `menuActions` рядом с `dislike` и `add_to_playlist`, не повреждая дизлайки.
3. **`app/ios/puuk-ios/shared/components/ArtistSelector.js`:**
   - Содержит доработки выбора артистов. Не входит в область CDN/Share.
4. **`brain/routers/wave_recommendations.py` и `brain/services/recommendation_service.py`:**
   - Содержат модификации рекомендаций Моей Волны.
   - *Инструкция для S2*: Модули рекомендаций не должны модифицироваться в рамках CDN-доставки.

---

## 6. Поведение старых клиентов и план обратной совместимости

1. **Старый iOS-клиент + Новый Backend:**
   - Старый iOS-клиент запрашивает `/api/stream/{id}` с прямым заголовком `Authorization: Bearer <token>`.
   - Новый backend **обязан сохранить** прямой endpoint `/api/stream/{id}` в работоспособном состоянии. При отсутствии capability CDN в запросе backend отдает файл напрямую через существующий `FileResponse`.
2. **Новый клиент + Старый Backend / Выключенный флаг CDN:**
   - Клиент запрашивает `POST /api/media-ticket`.
   - Старый сервер возвращает относительный URL `/api/stream/{track_id}?mt={ticket}`.
   - Клиент проверяет префикс/схему: при получении прямого URL стримит напрямую, не падая при отсутствии CDN-домена.
3. **Отсутствующие экраны (Track / Artist в вебе) и инвариант отсутствия автовоспроизведения:**
   - **Инвариант NO-AUTOPLAY (Оркестрационный план, разделы 5.7 и 8):** Входящие ссылки на любые сущности **КАТЕГОРИЧЕСКИ НЕ ДОЛЖНЫ ЗАПУСКАТЬ АВТОВОСПРОИЗВЕДЕНИЕ**. Автоматический старт звука нарушает пользовательский контекст и требования политик браузеров. Воспроизведение инициируется исключительно прямым пользовательским действием («Play» / «Слушать»).
   - Переход по постоянной ссылке вида `https://web.puuk.fun/track/<track-id>`:
     - Поскольку отдельной страницы трека нет, веб-клиент обязан загрузить метаданные трека через `GET /api/tracks/{id}` и отобразить контекстную карточку превью трека (Preview Card / Modal).
     - **АВТОВОСПРОИЗВЕДЕНИЕ СТРОГО ЗАПРЕЩЕНО:** Никакого немедленного старта плеера. Пользователь видит обложку, название, состав артистов, альбом и кнопку воспроизведения. Только явный клик пользователя запускает трек.
     - Текущая очередь воспроизведения не должна сбрасываться до момента явного выбора пользователя.
   - Переход по постоянной ссылке вида `https://web.puuk.fun/album/<album-id>`:
     - Загружаются метаданные альбома через `GET /api/albums/{id}`, в интерфейсе открывается экран `<AlbumDetail />`. Автозапуск воспроизведения запрещен.
   - Переход по ссылке `https://web.puuk.fun/artist/<artist-id>`:
     - Поскольку отдельного экрана артиста в вебе нет, на этапе G1/S1/J4 закрепляется поведение: отображение карточки артиста (превью со списком треков из каталога) либо переход к поисковой выдаче по имени артиста (`/api/search?q=...`) без автовоспроизведения.

---

## 7. Чек-лист готовности к Gate G1

- [x] Все точки входа потокового аудио в backend (`/api/stream`, `/api/media-ticket`) задокументированы с доказательствами.
- [x] Механизм генерации и валидации media-тикетов исследован: подтверждена реализация в `brain/auth.py` как stateless HS256 JWT (без таблицы в БД и без модуля `repositories/media_tickets.py`, упомянутого в плане).
- [x] Исследован жизненный цикл файлов (импорт через spotdl/link, сканирование uuid5, мутация mutagen, удаление каскадом).
- [x] Выявлено отсутствие колонки `content_version` в таблице `tracks`.
- [x] Исследованы типы идентификаторов (Track = UUIDv5 строка, Album = Int, Artist = `art_` + sha256).
- [x] Зафиксирована деструктивная семантика `merge_album_into` (исходный альбом удаляется, алиасов нет).
- [x] Доказана синхронная природа `normalizeStreamUrl` в iOS и недопустимость его скрытой подмены на Promise.
- [x] Идентифицирована утечка Bearer-заголовка на CDN-хост (source-confirmed) и четко разграничен архитектурный риск редиректов в AVFoundation от отсутствия экспериментальной runtime-проверки на устройстве.
- [x] Доказаны с точными номерами строк дефекты очистки кэша тикетов (`media.ts:115`, `useAuthStore.ts:20`) и неконтролируемого воспроизведения плеера (`usePlayerStore.ts:804`, `App.tsx:74`) при Logout в веб-клиенте.
- [x] Зафиксирован обязательный инвариант NO-AUTOPLAY для входящих ссылок и спроектировано отображение карточки/превью вместо автоматического старта плеера.
- [x] Зафиксировано полное отсутствие Share UI и роутинга в веб-клиенте.
- [x] Определены изолированные write-set для S2, J3, S3, S4, J4, J5 с предупреждениями о базовых «грязных» файлах.
