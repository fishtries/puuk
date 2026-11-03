# Artist Section Contract

Status: **final contract, approved 2026-10-27** for the iOS-first artist section (supersedes the earlier draft in this path). Web implementation is out of scope for this Run.

Принимающая сторона: владелец продукта (решения) + координатор (проверка). Этот документ — единственный источник истины для backend/API/DB/ranking/artwork и iOS navigation. Любое расхождение с текущим кодом считается **несоответствием реализации**, а не частью контракта: существование файлов ничего не доказывает.

### Дополнение 2026-10-28: несколько артистов

Исторический контракт первого Run сохранён ниже вместе с D-1…D-13, результатами и гейтами. Для нового multi-artist Run источником истины служит [MULTI_ARTIST_CONTRACT.md](MULTI_ARTIST_CONTRACT.md); [план](MULTI_ARTIST_ORCHESTRATION_PLAN.md) хранит решения MA-01…MA-12. Это спецификация следующей реализации, а не заявление о выполненной migration.

Явно заменены предположения §1.2 (ID теперь также в registry), §1.3 (membership через track/album links, включая album-only профили), §3.2 (play-start eligibility по effective credits), §4.2/4.6 (membership/аддитивные arrays, single artist_id только для одного участника), §5 (дискография исключительно по album credits непустого альбома) и §6.2 (0/1/N → текст/прямой переход/меню). §8 ownership и §9–10 gates ниже относятся к прежнему Run; текущие owners/T01…T23 заданы новым контрактом. Нормализация, различение регистра, формула ID, all-time top10, дедуп событий, права и ручной artwork не отменяются. Исторические счётчики тестов ниже не являются текущим baseline.

Связанные документы: `docs/ARTISTS_SECTION_ORCHESTRATION_PLAN.md` (план и роли), `docs/design/DESIGN.md` и `docs/design/ios.md` (визуальные правила).

---

## 0. Зафиксированные решения владельца

| ID | Решение | Значение |
|---|---|---|
| D-1 | Популярность = «просмотры» | Подтверждённый **старт воспроизведения** (playback start). Не открытия страницы, не лайки, не прогресс-колбэки. |
| D-2 | Окно популярности | Всё время (all-time). Периодов нет. Backfill отсутствует; стартовые счётчики равны нулю. |
| D-3 | Разные написания имени | Остаются **разными артистами**. Технический whitespace нормализуется, **регистр сохраняется** (без casefold). `Artist A` и `artist a` — два профиля и два artwork. Case-insensitive только поиск каталога. |
| D-4 | Tie-break | Детерминированно: название трека, затем стабильный track ID. |
| D-5 | Популярные треки | Top-10 (`POPULAR_TRACK_LIMIT = 10`). |
| D-6 | Веб | В текущем Run не менять. |
| D-7 | Нижняя вкладка iOS | Не добавлять. Навигация внутренняя. |
| D-8 | Маршруты iOS | Всегда по стабильному `artist_id`, никогда по отображаемому имени. |
| D-9 | Каталог | Общий для всех пользователей; не фильтруется по `user_id`. |
| D-10 | Various Artists | Сущность не создаётся, в каталоге отсутствует. |
| D-11 | Пустые имена | Артист с пустым (после нормализации) именем не создаётся и не возвращается. |
| D-12 | Изображение | Загружается вручную, только admin. |
| D-13 | Описание/внешние ссылки | Не нужны. |

---

## 1. Модель идентичности артиста

### 1.1 Нормализация

`normalize_artist_name(value)`:

1. `None` → `""`.
2. Unicode **NFKC**.
3. Все последовательности whitespace (`\s+`, включая табы и переводы строк) сворачиваются в один пробел; ведущие и хвостовые пробелы удаляются.
4. **Casefold не применяется** (D-3).

Следствия, обязательные к тестированию:

- `"  DJ   Arbuz "` ≡ `"DJ Arbuz"` — один артист.
- `"Artist A"` ≠ `"artist a"` — **разные** артисты и **разные** `artist_id`.
- `"Разные"` и `"Разные "` — один артист.
- Два внутренних пробела и один — один артист; пробел и неразрывный пробел (U+00A0) после NFKC — один артист.

### 1.2 Идентификатор

```
artist_id = "art_" + sha256(normalize_artist_name(name).encode("utf-8")).hexdigest()[:32]
```

- Детерминирован, не хранится в отдельной таблице как реестр имён, вычисляется из нормализованного имени.
- Для пустого имени и для `Various Artists` (после нормализации и casefold-сравнения с зарезервированной строкой) возвращается `None`.
- **Reserved name:** нормализованное имя, у которого `casefold() == "various artists"`, не порождает артиста, даже если тег присутствует в `tracks.artist`. Причина: D-10. Это единственное место, где casefold используется, и только для исключения, не для identity.
- Один и тот же нормализованный набор символов обязан давать один `artist_id` во всех точках: search, tracks, albums, catalog, detail, artwork, play-start.

### 1.3 Членство в каталоге

Источник: `tracks.artist`.

- Треки с `NULL`/пустым `trim(artist)` исключаются (D-11).
- `albums.album_artist` **сам по себе каталог не создаёт** (иначе compilation-исполнитель стал бы артистом без собственных треков). Альбомный исполнитель учитывается только как **атрибуция альбома** (раздел 5).

### 1.4 Отображаемое имя

Если у одного нормализованного имени несколько исходных написаний, различающихся только пробелами, отображается детерминированно выбранное написание (наименьшее по кодовым точкам). Ранжирование `MIN(...)` по строкам с mixed-case **не заменяет** identity: это только display rule.

---

## 2. Данные: таблицы и миграция

Миграция: `brain/migrations/011_artists.sql`. Исполняется через существующий `apply_migrations` в `brain/repositories/schema.py` (файлы `migrations/*.sql` сортируются по числовому префиксу, запись в `schema_migrations`). Требования:

- Идемпотентность: повторный `init_db` не меняет данные и не падает (`IF NOT EXISTS` / `ON CONFLICT`).
- Совместимость с legacy-базой: применение поверх схемы версии 10 проходит без ошибок.
- Тесты используют изолированную БД через `PUUK_DB_PATH` (`brain/test_db_path.py` импортируется первой строкой теста).

### 2.1 `artist_play_starts`

```sql
CREATE TABLE IF NOT EXISTS artist_play_starts (
    user_id INTEGER NOT NULL,
    track_id TEXT NOT NULL,
    played_on TEXT NOT NULL,          -- UTC date, ISO-8601 "YYYY-MM-DD"
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, track_id, played_on),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artist_play_starts_track_day
    ON artist_play_starts(track_id, played_on);
```

Инварианты:

- `tracks.id` — `TEXT`, `users.id` — `INTEGER`; типы FK обязаны совпадать с ними.
- Первичный ключ обеспечивает дедупликацию (раздел 3). Дополнительных счётчиков в `tracks` не вводить.
- `played_on` — календарная дата UTC, вычисляется **на сервере**; клиент дату не передаёт.
- Удаление трека или пользователя каскадно удаляет события (`PRAGMA foreign_keys = ON` уже включён в `repositories/base.py`).

### 2.2 `artist_artwork`

```sql
CREATE TABLE IF NOT EXISTS artist_artwork (
    artist_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1,
    has_artwork INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

- `artist_id` = значение из раздела 1.2 (не имя).
- Запись существует только после успешной загрузки; удаление не удаляет строку, а ставит `has_artwork = 0` и инкрементирует `version` (cache busting).
- Файлы: `ARTIST_ARTWORK_DIR` (по умолчанию `brain/artist_artwork`), имя `<artist_id>.jpg`. Каталог обязан быть в `.gitignore`.

---

## 3. События воспроизведения (`play-start`)

### 3.1 Определение события

Событием считается **подтверждённый старт** трека: клиент отправляет один запрос после того, как аудио-движок сообщил `playing = true` для текущего трека. Прогресс-колбэки, паузы, resume, seek, открытие экрана артиста и переходы очереди событием не являются.

### 3.2 Endpoint

```
POST /api/tracks/{track_id}/play-start
Authorization: Bearer <jwt>
```

- Ответ `200`: `{"status": "recorded" | "duplicate", "track_id": "<id>"}`.
- Трек не существует → `404`. У трека пустой/`Various Artists` artist → событие не пишется, ответ `200 {"status": "ignored", "track_id": ...}` (событие не влияет на ранжирование, но и не является клиентской ошибкой). Реализация обязана вернуть именно `ignored`, а не `recorded`.
- `401` при отсутствии/невалидном токене; `422` при некорректном формате пути.

### 3.3 Дедупликация

Сервер выполняет `INSERT OR IGNORE` в `artist_play_starts` с PK `(user_id, track_id, played_on)`.

- Максимум **одно событие на пользователя, трек и календарный день UTC**. Повторы, ретраи и повторные старты в тот же день возвращают `duplicate`.
- Счётчик популярности = `COUNT(*)` строк по `track_id` (разные пользователи и разные дни складываются). Он **не** отражает число прослушиваний одним человеком за день.
- Клиент дополнительно дедуплицирует в рамках сессии, но сервер — источник истины; клиентская дедупликация не является условием корректности.
- Ретраи: сетевой сбой/таймаут/5xx можно повторять (идемпотентно по PK). `4xx` не повторять.

### 3.4 Клиентское испускание (iOS)

- Точка испускания в `hooks/usePlayerController.js`: переход `isPlaying` в `true` для трека с валидным ID.
- Ключ клиентской дедупликации обязан включать пользователя и **сессию воспроизведения**, чтобы новый старт того же трека в новом сеансе был отправлен.
- Ошибка отправки не показывается пользователю и не блокирует воспроизведение. Один ограниченный ретрай допустим.
- `usePlayerController` остаётся единственным местом испускания; экраны и компоненты плеера событий не шлют.

---

## 4. API

Все endpoint ниже требуют `Authorization: Bearer` (`get_current_user`), кроме отмеченных. Публичные DTO **никогда** не содержат локальных путей, абсолютных путей, токенов и приватных полей пользователя.

### 4.1 `GET /api/artists?q=<str>`

Каталог, общий для всех пользователей (D-9). Возвращает массив `ArtistDTO`, сортировка — по display name без учёта регистра, затем по display name, затем по `id`.

- `q` опционален, максимум 100 символов; фильтрация case-insensitive подстрокой по нормализованному имени.
- Пагинации и бесконечной прокрутки нет (D-6 плана). Ответ — компактные DTO без треков и без обложек треков.
- Пустой результат — `[]` (не `404`).
- Производительность: запрос обязан использовать индексы/агрегацию, без N+1 и без выгрузки тяжёлых колонок; на 10k+ треков ответ измеряется в задаче реализации.

`ArtistDTO`:

```json
{
  "id": "art_<32 hex>",
  "name": "<display name>",
  "track_count": 12,
  "album_count": 3,
  "artwork_version": 0,
  "artwork_url": "https://<base>/api/artists/art_.../artwork?v=2" 
}
```

- `artwork_url` — `null`, если artwork нет; иначе абсолютный URL. Fallback на обложку трека в каталог **не подставляется** (клиент показывает плейсхолдер) — см. 4.5.
- `artwork_version` — 0, если artwork нет.

### 4.2 `GET /api/artists/{artist_id}`

Detail-envelope:

```json
{
  "artist": ArtistDTO,
  "popular_tracks": [TrackDTO + "play_count"],
  "albums": [AlbumSummaryDTO]
}
```

- `404` для неизвестного ID.
- `popular_tracks`: фильтр по нормализованному `tracks.artist`; сортировка `play_count DESC, title COLLATE NOCASE ASC, id ASC`; лимит 10 (D-4, D-5). При отсутствии событий — детерминированный алфавитный порядок по тем же tie-break (cold start, не случайный SQL-порядок).
- `TrackDTO` — существующий serializer с `include_lyrics=False`; добавляется только `play_count` (целое ≥ 0).
- `albums`: все альбомы артиста (правила атрибуции в разделе 5), сортировка: год по убыванию → название без учёта регистра → `id`. Альбомы без года — после всех альбомов с годом.
- `artist.track_count`/`album_count` соответствуют спискам этого же ответа (согласованность обязательна).

### 4.3 `GET /api/artists/{artist_id}/artwork?v=<version>`

- Аутентификация: `Depends(get_cover_user)`, а не `get_current_user` — iOS `Image` передаёт заголовки, но требование контракта — поддержать также `?token=` и media-тикет, как у `/api/cover/*`. Ответ для `/api/artists/*/artwork` обязан быть распознан клиентом как серверный ресурс.
- `200 image/jpeg`, `ETag: "<artist_id>-<version>"`, `Cache-Control: private, max-age=86400, must-revalidate`.
- `If-None-Match` с совпадающим ETag → `304` без тела.
- Нет artwork или файл отсутствует при `has_artwork = 1` → `404` (не 500).
- Неизвестный `artist_id` → `404`.
- Query-параметр `v` не является авторизацией и не влияет на выбор файла; он только для инвалидации кэша.

### 4.4 `PUT /api/artists/{artist_id}/artwork` / `DELETE .../artwork`

- Auth: **только** `get_current_admin_user`; non-admin → `403`, без токена → `401`. Unknown artist → `404`.
- `PUT` принимает multipart, поле **`file`**, без JSON Content-Type.
- MIME/формат: JPEG, PNG, WebP. Проверка по декодированию (Pillow), а не только по расширению/заявленному MIME.
- Размер: ≤ **5 MiB**; больше → `413`. Пусто → `400`. Не изображение/неподдерживаемый формат → `415`.
- Обработка: декодировать, конвертировать в RGB, ограничить до 1600×1600, перекодировать **в JPEG** (quality 88) — хранимый файл всегда `.jpg`.
- Атомарность: staging во временный файл в том же каталоге → `fsync` → `BEGIN IMMEDIATE` → подмена файла и инкремент `version` одной транзакцией; при сбое предыдущий файл восстанавливается, временный удаляется. Предыдущий файл не удаляется до успешной замены.
- Успех: `200 {"status":"updated","artist_id":"...","artwork_version":<int>}`; `version` строго возрастает.
- `DELETE`: `200 {"status":"removed","artist_id":"..."}`; ставит `has_artwork = 0`, инкрементирует `version`, удаляет файл атомарно. Идемпотентен: повторный `DELETE` — `200`, а не ошибка.
- Оба endpoint кэш-бастят через новый `version` в `artwork_url` (см. 4.6).

### 4.5 Fallback изображения

- Каталог и detail: только ручной artwork. Плейсхолдер рисует клиент.
- Карточка артиста в плеере/поиске без artwork — нейтральный плейсхолдер.
- Обложка трека **не** выдаётся как «artwork артиста» ни в одном контрактном поле: `artwork_url` = `null`, если ручного изображения нет. Информационная строка о наличии артиста не должна зависеть от обложки.

### 4.6 Обновлённые существующие DTO

Аддитивно, обратная совместимость обязательна:

- **Search** (`GET /api/search`): artists — каждый элемент получает `id` и `artist_id` (одно и то же значение); существующие поля (`name`, `track_count`, `album_count`, `coverArt`) сохраняются. Дубли по `artist_id` схлопываются сервером. Артисты без валидного ID исключаются.
- **TrackDTO** (`serialize_track`): добавляется `artist_id` (string | null). `null` для пустого и `Various Artists` artist.
- **AlbumSummaryDTO/AlbumDTO** (`serialize_album` и `/api/albums`, `/api/albums/{id}`): добавляется `artist_id` (string | null) для album artist.
- Поле `artist` в треках и альбомах остаётся отображаемым текстом и **не** используется клиентом для навигации.
- `limit` в `/api/search` остаётся `1..100` с дефолтом 30 (текущее поведение), иначе возможен регресс существующих вызовов.

---

## 5. Дискография: членство и сортировка

- `AlbumSummaryDTO`: `id`, `title`, `album_artist`, `year`, `track_count`, `cover_id` (string | null), `coverArt` (string | null), `artist_id`.
- Альбом принадлежит артисту ⇔ у альбома есть трек с `normalize(track.artist) == normalize(artist.name)` **и** `album_artist` либо совпадает нормализованно с этим именем, либо пуст/`NULL`.
- Если `album_artist` задан и нормализованно **не** совпадает с артистом, альбом не попадает в дискографию этого артиста (compile guest не приписывает себе чужой релиз). Такой альбом появится у своего исполнителя.
- Compilation (`album_artist = Various Artists` или другой общий ярлык) не создаёт артиста (D-10), но конкретные исполнители треков сборника имеют свои профили по `tracks.artist`.
- Один альбом не дублируется в списке (дедупликация по `album.id`).
- Сортировка: год числом по убыванию (`NULL`/нечисло — в конце) → `title` без учёта регистра → `id`.
- `cover_id` — представительский трек по `album_track_position` (пустые в конце), затем `rowid`.

---

## 6. iOS: навигация, состояния, входные точки

### 6.1 Маршруты

- `ArtistDetail` с параметром `{ artistId: string }` (D-8).
- `ArtistEdit` (artwork) с `{ artistId, artist }`, доступен только admin по UI-условию; серверная авторизация — источник истины.
- Нижняя вкладка не добавляется (D-7). `ArtistDetail`/`ArtistEdit` — экраны root stack, не табы.

### 6.2 Входные точки

| Точка | Поведение |
|---|---|
| Поиск: результат-артист | `navigate("ArtistDetail", { artistId })`. Повторный поиск запрещён. Назад сохраняет запрос, результаты, позицию скролла (в пределах текущего navigator). |
| Плеер: имя исполнителя | Tappable control с touch target ≥ 44pt и VoiceOver label; `navigate` без изменения текущего трека, очереди и воспроизведения. В компактном режиме control может быть скрыт/иным, но не должен ломать раскладку. |
| Экран альбома: album artist | Кликабелен только при наличии `album.artist_id`; иначе control не рендерится, показывается обычный meta-текст. Строки треков не кликабельны. |
| Library/иное | Вход не добавляется без отдельного решения владельца. |

### 6.3 Страница артиста

Секции: изображение + имя + счётчики; популярные треки (top-10) с запуском через существующий player controller; дискография с годом и обложкой, переход в существующий `Album` screen. Bio и внешние ссылки отсутствуют (D-13).

Состояния: `loading`; `initial error + retry`; `not found` (404); `no artwork` (плейсхолдер); `no tracks`; `no albums`; `cold start popularity` (порядок детерминирован, без надписи «0 просмотров»); `artwork upload in progress/success/failure`; `invalid type`; `too large`; `offline` (сеть недоступна — понятное сообщение и retry).

Правила: длинные имена обрезаются с ellipsis; отмена запроса при размонтировании/повторном открытии не даёт устаревшему ответу перезаписать новый экран; обложки грузятся через существующий `shared/media/CoverImage`, без массовой загрузки тяжёлых изображений для списка.

### 6.4 Artwork для изображений

`ArtistDTO.artwork_url` ведёт на `/api/artists/{id}/artwork`. iOS обязан распознавать этот путь как серверный ресурс (авторизованные заголовки или `?token=`), а не как внешний URL. Изменение `artwork_version` обязано менять URL, чтобы кэш изображений инвалидировался.

---

## 7. Состояние рабочей копии и отклонения

**Все незакоммиченные изменения в checkout являются user-owned входами и НЕ приняты.** Ни одно не считается реализацией контракта до независимого review и прогона проверок раздела 9.

Исторический baseline до завершающих исправлений, 2026-10-27: `git status --short` = **34 записи (21 `M` + 13 `??`)**. Список ниже сохранён как входное состояние, а не текущий status:

```
 M .gitignore
 M app/ios/puuk-ios/App.js
 M app/ios/puuk-ios/components/FullPlayerModal.js
 M app/ios/puuk-ios/components/fullplayer/__tests__/FullPlayerControlsAndMenu.test.js
 M app/ios/puuk-ios/features/albums/AlbumScreen.js
 M app/ios/puuk-ios/features/albums/__tests__/AlbumScreen.test.js
 M app/ios/puuk-ios/features/search/SearchScreen.js
 M app/ios/puuk-ios/features/search/__tests__/SearchScreen.test.js
 M app/ios/puuk-ios/hooks/__tests__/usePlayerController.test.js
 M app/ios/puuk-ios/hooks/usePlayerController.js
 M app/ios/puuk-ios/navigation/RootNavigator.js
 M app/ios/puuk-ios/shared/media/CoverImage.js
 M app/ios/puuk-ios/shared/media/__tests__/coverImageUtils.test.js
 M brain/api.py
 M brain/config.py
 M brain/repositories/tracks.py
 M brain/routers/search.py
 M brain/serializers.py
 M brain/services/album_service.py
 M docs/AGENT_ORCHESTRATION.md
 M docs/ORCHESTRATION.md
?? .opencode/agents/junior-deepseek.md
?? app/ios/puuk-ios/features/artists/
?? app/ios/puuk-ios/shared/api/__tests__/artists.test.js
?? app/ios/puuk-ios/shared/api/artists.js
?? brain/migrations/011_artists.sql
?? brain/repositories/artists.py
?? brain/routers/artists.py
?? brain/test_artist_backend_hardening.py
?? brain/test_artist_search_albums.py
?? brain/test_artists_invariants.py
?? brain/test_gate2_findings.py
?? brain/test_gate2_fixes.py
?? docs/ARTISTS_SECTION_CONTRACT.md
```

### 7.1 Ранее зафиксированные отклонения — исправлены

Проверено по текущему коду 2026-10-27. Пункты ниже **больше не являются отклонениями**; при review их надо перепроверять, а не чинить заново.

| ID | Было | Фактическое состояние |
|---|---|---|
| EV-1 | `serialize_track` падал `UnboundLocalError` | исправлено: `artist_id` вычисляется в `brain/serializers.py:37` до `return` |
| EV-2 | `Various Artists` не исключался (нет casefold) | исправлено: `brain/repositories/artists.py:39` (`is_various_artists` через `casefold`) |
| EV-3 | Каталог выгружал все `tracks` в Python | исправлено: агрегация идёт в SQL (`get_artist_catalog`), два запроса на вызов |
| EV-5 | `artwork_url` подменялся обложкой трека | исправлено: `public_artist` отдаёт `null` без ручного artwork |
| EV-6 | Artwork использовал `get_current_user` | исправлено: `get_cover_user` (Bearer, `?token=`, media-тикет) |
| EV-7 | `log_play_start` не возвращал `ignored` | исправлено: `record_play_start` возвращает `recorded`/`duplicate`/`ignored`/`None` |
| EV-8 | Роутер вызывал приватный `_find_artist_by_id` | исправлено: публичный `find_artist_by_id`/`get_artist_summary` |
| EV-9 | Импорт `artist_id_for_name` внутри функции | исправлено: top-level импорт; поиск группирует по `artist_norm` и схлопывает дубли по `artist_id` |
| EV-10 | `artist_id` выводился дважды | исправлено: единственное место — `services/album_service.py` |
| EV-11 | `FileResponse` импортировался внутри функции | исправлено: top-level импорт; staging/backup-файлы убираются |
| EV-12 | `brain/artist_artwork/` не игнорировался | исправлено: `.gitignore:26` |
| EV-14 | `AlbumScreen.test.js` был красным | исправлено: suite зелёный (6/6) |
| EV-15 | Год терялся при наличии `artist_id` | исправлено: год и число треков рендерятся рядом с ссылкой |
| EV-16 | Семантика сессии дедупликации не определена | исправлено: `sessionIdRef` пересоздаётся на `playTrack`/`playTrackList`, ключ включает user+session+track |
| EV-17 | Ретрай не был ограничен явно | исправлено: `shared/api/artists.js` клампит `retry` до `1` |

### 7.2 Завершающие исправления (2026-10-27)

| ID | Результат |
|---|---|
| EV-21 | Каталог, summary и detail используют общий `album_attribution_clause`; пустота определяется после NFKC/whitespace-нормализации, включая табы и NBSP. `album_count` согласован с дискографией. |
| EV-22 | В `AlbumSummaryDTO` добавлен `track_count` всего альбома; `cover_track_id` и `track_artist` не публикуются. |
| EV-23 | Недостижимый `_find_album_only_artist` удалён; `get_artwork_metadata` определён один раз. |
| EV-24 | Каталог имеет финальный ключ сортировки `artist_id_for_name(normalized_name)`. |
| Review: поиск | Нормализованный запрос сравнивается с `normalized_name`, а не исходным display name; технические пробелы и NFKC не мешают поиску. |
| Review: artwork | Сбой `BEGIN`, backup/install rename или commit сохраняет прежнее изображение и версию. Восстановление выполняется до освобождения write lock. Ошибка очистки backup после commit логируется и не откатывает опубликованные данные; backup-имена уникальны между запросами. |
| Review: play-start | Событие требует успешного завершения актуального `loadAndPlay` и `playing=true`. Pending/failed/superseded и устаревшие загрузки не подтверждают старт; учитываются эпоха авторизации и закрытие плеера. |
| Review: тестовая изоляция | `TestPhase1` использует отдельный `PUUK_DB_PATH`: первые 10 треков больше не зависят от фикстур остальных suites. |

Регрессионные сценарии: `brain/test_artist_review_regressions.py` и `hooks/__tests__/usePlayerController.test.js`.

### 7.3 Проверки и пределы приёмки

- Локальное окружение доступно: `brain/venv/bin/python -m pytest -q`.
- Проверены миграция 011 на пустой БД, переход с v10 с сохранением треков, повторный init, FK и сохранение событий.
- B18: 10 000 треков / 1 000 артистов, 2 SQL-запроса, JSON 149 890 байт, около 0.021 с локально (не production SLA).
- Полный backend pytest: **435 passed, 56 subtests passed**, 2 deprecation warnings, 30.72 с.
- Полный iOS Jest: **43 suites / 566 tests passed**. `npm run lint` — exit 0.
- `npx expo export --platform ios --output-dir /tmp/puuk-artists-ios-final` — exit 0, iOS bundle экспортирован.
- `git diff --check` — exit 0.
- Ручной smoke на iOS-устройстве/симуляторе и VoiceOver остаются непроверенными. Gate 4/5 не закрываются только автоматическими проверками.
- Production не изменялся; деплой не выполнялся. Веб не изменялся.

---

## 8. Карта владения файлами

Правило: один файл — один владелец в момент времени. Параллельно можно запускать только задачи с непересекающимися файлами.

| Задача | Владелец | Файлы (allowlist) |
|---|---|---|
| `artist-backend-fix` | senior backend | `brain/serializers.py`, `brain/repositories/artists.py`, `brain/routers/artists.py`, `brain/migrations/011_artists.sql`, `brain/api.py` (только подключение роутера), `brain/config.py`, `.gitignore`, `brain/test_artist_review_regressions.py`, `brain/test_phase1.py` (изоляция тестовой БД), новые `brain/test_artists_invariants.py`, `brain/test_artist_backend_hardening.py`, `brain/test_gate2_findings.py`, `brain/test_gate2_fixes.py` |
| `artist-backend-search-album` | senior backend | `brain/routers/search.py`, `brain/routers/albums.py`, `brain/services/album_service.py`, `brain/repositories/tracks.py` (только `search_all`), `brain/repositories/schema.py` (только при необходимости индексов), новые `brain/test_artist_search_albums.py` |
| `artist-docs` | координатор | `docs/ARTISTS_SECTION_CONTRACT.md`, `docs/ARTISTS_SECTION_ORCHESTRATION_PLAN.md`, `docs/ORCHESTRATION.md`, `docs/AGENT_ORCHESTRATION.md`, `.opencode/agents/junior-deepseek.md` |
| `artist-backend-review` | independent reviewer | read-only |
| `artist-ios-api` | junior после Gate 1 | `app/ios/puuk-ios/shared/api/artists.js`, `shared/api/__tests__/artists.test.js` |
| `artist-ios-media` | junior | `app/ios/puuk-ios/shared/media/CoverImage.js`, `shared/media/__tests__/coverImageUtils.test.js` |
| `artist-ios-search` | junior | `features/search/SearchScreen.js`, `features/search/__tests__/SearchScreen.test.js` |
| `artist-ios-player` | junior | `components/FullPlayerModal.js`, `App.js` (только props wiring), `hooks/usePlayerController.js` (только испускание события), соответствующе тесты |
| `artist-ios-album` | junior | `features/albums/AlbumScreen.js`, `features/albums/__tests__/AlbumScreen.test.js` |
| `artist-ios-detail` | junior | `features/artists/ArtistScreen.js`, `features/artists/__tests__/ArtistScreen.test.js`, `navigation/RootNavigator.js` |
| `artist-ios-artwork` | junior | `features/artists/ArtistArtworkEditScreen.js`, новый тест |
| `artist-ios-review` | independent reviewer | read-only |
| `artist-integration-fix` | назначенный owner | только файлы из review findings |

Любая параллельная задача обязана иметь отдельный worktree либо работать в allowlist; `App.js`, `RootNavigator.js`, `FullPlayerModal.js` и `SearchScreen.js` меняются последовательно.

---

## 9. Матрица проверок и приёмки

### Backend (обязательные команды)

```bash
cd brain && source venv/bin/activate && pytest -xvs
git diff --check
```

| # | Проверка | Ожидание |
|---|---|---|
| B1 | Миграция на пустой БД | 011 применена, таблицы и FK корректны |
| B2 | Миграция на legacy-фикстуре v10 + повторный init | идемпотентно, без дублей |
| B3 | `serialize_track` с artist и без | `artist_id` корректный/`null`, исключений нет |
| B4 | Reserved name `Various Artists` в любом регистре | не в каталоге, `get_artist_detail` → `404`, `artist_id=None` |
| B5 | `"DJ   Arbuz"` / `"DJ Arbuz"` | один `artist_id`, один профиль |
| B6 | `"Artist A"` / `"artist a"` | разные `artist_id`, два профиля, два artwork |
| B7 | Пустой/`NULL` artist | не в каталоге |
| B8 | Top-10 и tie-break | порядок `play_count DESC, title NOCASE, id`; при нулях детерминирован |
| B9 | Дедупликация play-start | 1 строка на (user, track, UTC day); повтор → `duplicate` |
| B10 | `ignored` для Various/пустого | событие не пишется, ответ `ignored` |
| B11 | `404` неизвестного трека/артиста | корректные коды |
| B12 | Artwork upload JPEG/PNG/WebP | 200, файл перекодирован в JPEG |
| B13 | Artwork > 5 MiB / мусор / пустой | 413 / 415 / 400 |
| B14 | Artwork non-admin / anonymous | 403 / 401 |
| B15 | Атомарность замены и `DELETE` | старый файл переживает сбой; version растёт; повторный DELETE 200 |
| B16 | Artwork `?token=` и Bearer | оба варианта 200; `If-None-Match` → 304 |
| B17 | Search/albums обратная совместимость | старые поля на месте, аддитивные ID корректны |
| B18 | Производительность каталога на 10k+ | размер ответа и число запросов измерены |

### iOS (обязательные команды)

```bash
cd app/ios/puuk-ios && npm test -- --runInBand
cd app/ios/puuk-ios && npm run lint
npx expo export --platform ios   # при доступных prerequisites
git diff --check
```

| # | Проверка | Ожидание |
|---|---|---|
| I1 | Search → Artist → back | навигация по ID, повторного запроса нет, query/scroll сохранены |
| I2 | Player artist press | воспроизведение/очередь не меняются, доступный touch target и label |
| I3 | Album artist | кликабелен только при `artist_id`; строки треков не кликабельны; год отображается |
| I4 | Artist page states | loading/error/not found/no artwork/no tracks/no albums/cold start/offline |
| I5 | Artwork upload/remove | admin видит, non-admin не видит; ошибки типа/размера показаны |
| I6 | Artwork cache bust | новый `version` → новый URL, старое изображение не остаётся |
| I7 | Cancellation | поздний ответ не перезаписывает новый экран |
| I8 | Play-start emission | один запрос на сессию/трек; ретрай ограничен; ошибка не видна пользователю |
| I9 | Full Jest + lint | зелёные, включая `AlbumScreen.test.js` |
| I10 | Симулятор/устройство | нет перекрытий, длинные имена, VoiceOver |

### Product acceptance

- Артист без имени не появляется; Various Artists не появляется.
- «Просмотры» = подтверждённые старты, всё время, дедуп (user, track, UTC day).
- Top-10 + детерминированный tie-break; cold start корректен.
- Дискография полная, сортирована, без дублей и без кражи альбомов чужого album artist.
- Artwork только вручную и только admin; изображение не теряется при сбое.
- Вход из поиска/плеера/альбома; трек-строки не кликабельны; веб не изменён.
- Ни один грязный файл не считается принятым до независимого review.

---

## 10. Гейты

- **Gate 1 (контракт):** этот документ, согласован владельцем и координатором. Блокирующие продуктовые вопросы плана закрыты (D-1…D-5). Реализация до Gate 1 не принимается.
- **Gate 2 (backend):** `artist-backend-fix` и `artist-backend-search-album` прошли B1–B18; `artist-backend-review` не нашёл blocker/high.
- **Gate 3 (iOS API + entry points):** `artist-ios-api` и входные точки приняты по I1–I8 и G2.
- **Gate 4 (iOS page + artwork):** I4–I10 зелёные, ручной smoke выполнен.
- **Gate 5 (финальный):** полный Jest, lint, backend pytest, diff против allowlist, независимое review. `worker_done` не заменяет проверку.

## 11. Открытые вопросы

Блокирующих продуктовых вопросов не осталось. Не блокируют реализацию, требуют решения координатора до Gate 4:

1. Визуальная композиция строки album meta при наличии ссылки на артиста (год сохраняется — EV-15).
2. Нужен ли отдельный вход в полный каталог артистов (сейчас не утверждён; поиск — единственный вход).
3. Поведение при отсутствии ручного artwork: нейтральный плейсхолдер (текущее решение контракта) либо инициалы — согласовать с `docs/design/ios.md`.
