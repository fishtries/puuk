# J04 — адресная инвалидация и надёжность AudioCache

Дата: 2026-10-31.
Исходная задача: `task_3b381b364621`, dispatch `ctx_082354cf4658`.
Follow-up задача: `task_e4d82ab0576f`, dispatch `ctx_942d0f8141bb`, Run `run_5c86d4feea71`.
Владение: `utils/audioCache.js`, `utils/__tests__/audioCache.test.js`, отчёт `docs/IOS_PLAYBACK_J04_REPORT.md`. Другие модули (J05 scheduler/networkPolicy, J06 URL, J07 coordinator) не изменялись.

Статус: **реализация и локальные тесты `passed` (34/34 тестов audioCache); физический iPhone / device acceptance — `not tested` (Linux окружение без Xcode/Swift compiler/iPhone, build ID unknown).** Ранние диагностические итерации с дефектом настенных часов успешно исправлены и суперседированы настоящей ревизией.

---

## 1. Исходная точка и окружение

| Параметр | Значение |
|---|---|
| Рабочий каталог (cwd) | `/home/fish/projects/puuk/app/ios/puuk-ios` |
| Git HEAD | `671be2ff8bf2d89a1bc11766d18f62b4faebe5a5` (рабочее дерево содержит baseline dirty-изменения) |
| Runtime | Node.js v26.12.0, npm 12.2.1, Linux 6.17.13 |
| Версии SDK | `expo` ~58.0.19, `expo-audio` ~58.0.10, `expo-file-system` ~58.0.11 |
| Xcode / Swift / iPhone | Отсутствуют (`which xcodebuild` exit 3; `.expo/devices.json` пуст) |
| Build ID iOS-бинарника | **unknown** (физическое устройство отсутствует) |
| Сохранение dirty/untracked | Все исходные изменения других модулей сохранены; без `git reset`, `git clean`, commit, push |

Артефакты задачи:
- Основной диспатч: `/tmp/puuk-playback/J04/` (`commands.jsonl`, `hashes-before.txt`, `hashes-after.txt`, `final-source/`).
- Follow-up диспатч: `/tmp/puuk-playback/J04/followup/` (`commands.jsonl`, `hashes-before.txt`, `hashes-after.txt`, `final-source/`, логи тестов и проверок).

---

## 2. Реализованный контракт (Gate A, раздел 4.3 плана)

В `app/ios/puuk-ios/utils/audioCache.js` реализованы все обязательные требования S1:

### 2.1. Адресная инвалидация конкретной копии (`invalidate`)
- `cache.invalidate(trackId, expectedUri): Promise<boolean>`
- Синхронное compare-and-remove: проверяет `this.manifest[trackIdStr].uri === expectedUri` и удаляет запись из manifest **до первого `await`**.
- Удаляет только файл, чей URI совпал с `expectedUri`. Если запись отсутствует или URI не совпадает (например, трек был перезаписан более новой версией) — возвращает `false` и не удаляет чужой файл.
- Удаление отсутствующего файла идемпотентно; ошибка удаления файла сохраняет целостность manifest.
- Инвалидация не вызывает отмену параллельных загрузок и не очищает кэш целиком.

### 2.2. Уникальность URI публикаций между инстансами
- Имя опубликованного файла формируется как `${safeId}_${publicationNonce}_${publicationCounter}.mp3`.
- `publicationNonce` генерируется при создании инстанса `AudioCache` (случайный токен на основе crypto/timestamp), что исключает коллизии имен при перезапуске приложения или создании нового инстанса.
- При обнаружении существующего файла с тем же именем используется следующее уникальное имя.
- Существующие аудиофайлы пользователя не изменяются.

### 2.3. Структурированная классификация ошибок (`classifyDownloadError`)
- Функция `classifyDownloadError(error)`:
  - `cancelled` (нет повтора): явная отмена `options.signal` или `error.name === 'AbortError'`.
  - Числовой HTTP-статус (`error.status`, `error.statusCode`, `error.response.status`):
    - `401`, `403` -> `kind: 'auth'`, `retryable: false`.
    - `404` -> `kind: 'not_found'`, `retryable: false`.
    - `408`, `429`, `>= 500` -> `kind: 'transient'`, `retryable: true`.
    - Прочие `>= 400` -> `kind: 'permanent'`, `retryable: false`.
  - Таймаут кэша (`cacheOwnedTimeout`) или известный структурированный код транспорта (`ERR_NETWORK`, `ECONNRESET`, `ETIMEDOUT` и др.) -> `kind: 'transient'`, `retryable: true`.
  - Все прочие (включая неструктурированные нативные ошибки SDK FileSystem) -> `kind: 'unknown'`, `retryable: false`.
- **Строгий запрет парсинга текста:** локализованный текст нативных ошибок («server returned HTTP 401») не парсится и не превращается в `auth`/числовой статус.

### 2.4. Бюджеты времени и повторные попытки
- **Inactivity таймаут:** 20 000 мс (`inactivityTimeoutMs`, переопределяемый `downloadTimeoutMs` для совместимости).
  - Сбрасывается **только** при строго возрастающем положительном конечном числе байт (`bytesWritten > lastBytesWritten > 0`).
  - Первые 0 байт и повторные значения не считаются прогрессом и не продлевают таймаут.
  - Сам по себе неизвестный размер (`totalBytes === -1`, например при отсутствии заголовка `Content-Length`) не мешает признанию прогресса: строго возрастающий `bytesWritten` корректно продлевает inactivity-таймер даже когда общий объем неизвестен.
  - Прогресс и таймер изолированы в структуре конкретной попытки (`attempt`); запоздалые события старой попытки не влияют на новую.
- **Общий бюджет:** 180 000 мс (`totalTimeoutMs`).
  - Стартует в момент вызова `getOrFetch` (admission) и доминирует над `init()`, backoff и всеми попытками.
  - Полезный прогресс продлевает только inactivity, но общий бюджет не сдвигается. По истечении 180 с выбрасывается `Download total budget exceeded` (`transient`).
- **Количество попыток и задержки:**
  - Максимум 3 попытки (до 2 повторов с задержками 800 мс и 2000 мс по Gate A).
  - Массив задержек жестко ограничен максимум 3 попытками даже при передаче вызывающим кодом более длинного массива.
  - Задержка (`_abortableDelay`) прерывается немедленно при отмене трека и ограничивается остатком общего бюджета.
- **Истинные монотонные часы:**
  - Внутренние дедлайны используют `getMonotonicNow()`, возвращающий `globalThis.performance.now()` (стандартная монотонная шкала в React Native/Hermes/Node), с поддержкой инъекции через `options.now`.
  - Настенные часы `Date.now()` **не являются монотонными** и при обратном скачке системного времени (например, при NTP-коррекции или смене часового пояса) могли бы приводить к ложному повторному взведению таймера общего бюджета. Использование `performance.now()` гарантирует соблюдение конечного 180с бюджета независимо от прыжков системного времени.
  - `Date.now()` используется исключительно для настенных отметок в manifest (`mtime`, `lastAccessed`) и генерации текстового nonce.

### 2.5. Корректное завершение при зависшем init или cancel-ignoring native
- Внешний промис `episodePromise` разрешается/отклоняется независимо от того, завис ли `this.init()` или нативный `downloadAsync()`.
- При отмене (`cancel` / `signal.abort`) или истечении общего бюджета:
  - Промис немедленно отклоняется (`AbortError` или `total budget exceeded`).
  - Очищаются таймеры (`totalTimeoutId`, `timeoutId`), подписки и запись из `ongoingDownloads`.
  - Запоздалое завершение `init()` или нативного скачивания проверяет актуальность поколения (`_isStale`) и не начинает сетевую активность и не публикует файл.

### 2.6. Единственный in-flight `init()` с повтором после сбоя
- Конкурентные вызовы `init()` разделяют один промис `_initPromise`.
- При падении `_initPromise` сбрасывается в `null`, что позволяет последующим вызовам повторить инициализацию.

---

## 3. SHA-256 файлов

### Исходные хеши baseline (до начала работ S1/J04):
```
ba5b9065822602d1d4ed215ac1349dcea9d1634408d76f593a9cc499cd77c90e  utils/audioCache.js
e99b328e0f9e08d715cf91ff5f6e136c2ae45c1f2bf1fd69173646aedd7e578b  utils/__tests__/audioCache.test.js
ce053ceebfa85250e4a0008e9f8508faa71624fe2375674fd00b587b96d75bcd  package-lock.json
```

### Хеши перед follow-up диспатчем (`/tmp/puuk-playback/J04/followup/hashes-before.txt`):
```
899b35919645cb82a665304408d2aa1bce91423dac82ef22af7d6911d98c21d5  utils/audioCache.js
b6e885cfdee4273933f27e26bc1b6da26313fff2e5932428cd9ca336d64f4e84  utils/__tests__/audioCache.test.js
ce053ceebfa85250e4a0008e9f8508faa71624fe2375674fd00b587b96d75bcd  package-lock.json
```

### Финальные хеши после follow-up исправлений (`/tmp/puuk-playback/J04/followup/hashes-after.txt`):
```
33e3fb90ad0c09ee542c21584ecd2f080a7acc63ebe959dc3cf3da3c048741ec  utils/audioCache.js
73c516741803c7fd0a8a60b904eb1ae189801b158a95a364c17efdc50306166a  utils/__tests__/audioCache.test.js
ce053ceebfa85250e4a0008e9f8508faa71624fe2375674fd00b587b96d75bcd  package-lock.json
```

Резервные копии финальных файлов сохранены в `/tmp/puuk-playback/J04/followup/final-source/`.

---

## 4. Результаты проверок и свидетельства

Все команды выполнены в рабочем каталоге `app/ios/puuk-ios`. Подробные неотфильтрованные логи сохранены в `/tmp/puuk-playback/J04/followup/`.

| Команда | cwd | Exit | UTC старт | Длительность | Результат | Лог |
|---|---|---:|---|---:|---|---|
| `node --check utils/audioCache.js` | `app/ios/puuk-ios` | 0 | 2026-10-30T22:42:01Z | 23.74 ms | passed | `syntax-cache.log` |
| `node --check utils/__tests__/audioCache.test.js` | `app/ios/puuk-ios` | 0 | 2026-10-30T22:42:01Z | 21.33 ms | passed | `syntax-tests.log` |
| `npx prettier --check utils/audioCache.js utils/__tests__/audioCache.test.js` | `app/ios/puuk-ios` | 0 | 2026-10-30T22:42:01Z | 418.46 ms | passed | `prettier-check.log` |
| `npx eslint utils/audioCache.js` | `app/ios/puuk-ios` | 0 | 2026-10-30T22:42:01Z | 413.00 ms | passed | `eslint-check.log` |
| `npm test -- --runInBand utils/__tests__/audioCache.test.js` | `app/ios/puuk-ios` | 0 | 2026-10-30T22:42:02Z | 1152.96 ms | passed (34/34 tests) | `jest-audio-cache.log` |

*Примечание по комбинированному набору тестов:* Ранее выполненный прогон комбинированного набора из 188 тестов относился к ревизии до параллельных правок J05 в `preloadScheduler`. В финальной ревизии J04 валидировались строго принадлежащие задаче файлы кэша (34 теста audioCache, exit 0), чтобы не маскировать и не смешивать результаты параллельной работы соседнего агента.

### Состав тестов `utils/__tests__/audioCache.test.js` (34 теста):
- **16 исходных baseline тестов:**
  - `init() creates cache and temp directories and loads empty manifest`
  - `init() repairs corrupted manifest entries when files are missing on disk`
  - `getOrFetch() downloads and caches audio atomically as .mp3`
  - `getOrFetch() deduplicates concurrent requests for the same track`
  - `getOrFetch() returns cached URI immediately on second call without re-downloading`
  - `cancel() cancels in-flight download and cleans up temp file`
  - `LRU eviction deletes oldest accessed files when size limit is exceeded`
  - `remove() removes a specific track from disk and manifest`
  - `clear() wipes all cached files and resets manifest`
  - `cleans up legacy .audio entries in manifest and getCachedUri`
  - `getDownloadState() correctly reflects idle, downloading, and cached states`
  - `getOrFetch() with signal rejects for aborted caller without cancelling shared in-flight download`
  - `cancel() followed by new getOrFetch() preserves new download record when old download finishes late`
  - `cancelled task completing late cannot overwrite newly cached file or corrupt manifest`
  - `late move of cancelled download cannot overwrite or delete a newer generation file`
  - `setProtectedTrackIds protects active tracks from LRU eviction`
- **18 тестов надёжности Gate A:**
  - `classifyDownloadError uses structured numeric status and ignores text` (проверка 401/403/404/400/408/429/503, игнорирование текста, AbortError)
  - `transient failure retries within a bounded total budget and then succeeds` (повтор 503 с задержками [800, 2000] мс)
  - `permanent 401/403/404 and unknown native errors are not retried` (однократная попытка, немедленное завершение)
  - `inactivity timeout aborts a stalled attempt and retries transiently` (зависшая нативная задача отменяется по 20 с inactivity и повторяется)
  - `useful progression extends inactivity but never the overall 180s budget` (полезные байты сдвигают inactivity, но 180 с общий лимит завершает эпизод)
  - `zero/repeated bytesWritten never extends inactivity` (0 байт или повтор не сбрасывают inactivity)
  - `retry resets progress baseline and ignores stale progress from an old attempt` (изоляция прогресса между попытками)
  - `cancel during abortable backoff settles immediately and starts no new request` (отмена во время backoff)
  - `never-settling init allows cancel and total budget to settle and clean up` (отмена и таймаут общего бюджета при бесконечном `init()`)
  - `cancel settles a cancel-ignoring native download by total deadline` (завершение эпизода при игнорирующей отмену нативной задаче)
  - `late cancelled result cannot publish or start a new network request` (старая отмененная задача не может перезаписать результат новой)
  - `invalidate removes only the exact expected URI and leaves newer copy` (адресная инвалидация, сохранение новой копии, идемпотентность)
  - `invalidate does not cancel unrelated in-flight downloads or clear cache` (изоляция инвалидации от других загрузок)
  - `publication names are unique across cache instances so stale URI cannot match a newer copy` (уникальность nonces между инстансами AudioCache)
  - `injected retry delays are clamped to at most three attempts total` (ограничение максимум 3 попытками)
  - `total budget includes init and all attempts, never resets` (конечный бюджет на весь эпизод)
  - `single in-flight init is retried after an init failure` (сброс `_initPromise` при ошибке и успешная повторная инициализация)
  - `wall clock backwards jump does not prevent total budget timeout` (обратный скачок настенного времени `Date.now` на 1 час не срывает общий 180с бюджет благодаря монотонным часам `performance.now`, внешний промис отклоняется по таймауту общего бюджета, новые задачи не запускаются)

---

## 5. Ограничения и статус строк (passed / failed / not tested)

- **passed:**
  - Адресная инвалидация конкретной копии по точному URI без затрагивания новых версий трека.
  - Уникальность URI файлов между инстансами кэша (nonce).
  - Структурированная классификация ошибок (числовые HTTP-статусы, отсутствие текстового парсинга).
  - Тайм-ауты (inactivity 20 с, общий бюджет 180 с) и привязка прогресса к конкретной попытке.
  - Истинные монотонные часы `performance.now()` для внутренних бюджетов, устойчивые к переводу системных часов.
  - Ограничение максимум 3 попытками с backoff 800/2000 мс.
  - Разрешение промисов при зависшем `init()` или игнорирующей `cancel()` нативной задаче.
  - Одиночный in-flight `init()` с возможностью повтора после сбоя.
  - 34 теста `audioCache.test.js`.
  - Синтаксис (`node --check`), форматирование (`prettier`), линтинг (`eslint`).
- **failed:** нет.
- **not tested:**
  - Реальное поведение на физическом iPhone (отсутствует сборочное окружение macOS/Xcode и физическое устройство; build ID unknown).
  - Реальная отмена нативного фонового URLSession в iOS runtime при заблокированном JS-потоке.
  - Настоящее декодирование аудиофайлов (в JS размер > 0 подтверждает сохранение файла на диске, но не валидность аудиокодека AVPlayer).
