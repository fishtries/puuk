# iOS: план устранения нестабильной загрузки треков

Дата: 2026-10-30. Статус: **выполняется; S0/J01–J03 и локальный Gate A приняты; J04/J05 выполняются; native build и device acceptance ещё не выполнены**.

Цель: выбранный трек предсказуемо начинает играть, а при сбое пользователь получает понятное состояние и рабочее восстановление. Проверить весь путь iPhone → публичный endpoint → backend → файл. Область: iOS и обслуживающий его streaming backend; Telegram-загрузка и веб-клиент в эту работу не входят.

Текущий HEAD — `671be2f`, но рабочее дерево содержит большой незакоммиченный набор изменений, включая `usePlayerController.js`, `App.js` и backend. HEAD не описывает фактическую исходную точку. Перед исполнением координатор фиксирует актуальные файлы и их хеши.

## 1. Что известно, а что ещё нужно доказать

| Наблюдение в текущем коде | Практическое следствие | Статус |
|---|---|---|
| `PlaybackCoordinator.play()` считает успехом завершение команд `replace()`/`play()`; hook не обрабатывает `status.error` | Поздняя ошибка нативной загрузки может остаться без восстановления | Подтверждён пробел; связь с конкретным сбоем владельца не установлена |
| `handleBufferingStatus()` после 3,5 с только меняет сетевой статус | Нет ограниченного восстановления зависшего текущего трека | Подтверждено |
| `retryPreload` в hook вызывает только `updateQueue()` | «Повторить» не перезапускает текущий неисправный источник | Подтверждено |
| Текущий remote-трек кешируется отдельным `getOrFetch()` через 5 с; scheduler параллельно готовит следующие | Фоновая работа не подчиняется единому бюджету и состоянию буферизации | Подтверждено; влияние на скорость требует замеров |
| AudioCache проверяет наличие и ненулевой размер; local fallback не инвалидирует неисправную копию | Повторный выбор может снова использовать тот же проблемный файл | Подтверждён пробел; повреждение реальных файлов не доказано |
| Cache timeout — 45 с на попытку; повторяются все ошибки, кроме отмены | Постоянные ошибки повторяются; медленная полезная загрузка может начинаться заново | Подтверждено |
| Coordinator и scheduler сохраняют `SERVER_URL` в конструкторах до чтения настроек | При пользовательском адресе API каталог и плеер могут обращаться к разным хостам | Подтверждён риск конфигурации; проверить регрессией |
| `_performReplace()` при устаревшем завершении повторно вызывает replace/play | Восстановление может нарушить актуальную паузу или позицию | Подтверждён опасный путь; проверить асинхронным тестом |
| Нативный patch завершает background task сразу после `playImmediately()` | Защита перехода заканчивается до подтверждённого начала звука | Поведение подтверждено, причинная связь с зависанием в фоне — гипотеза |
| Backend использует SQLite-first и `FileResponse`; есть тесты точных Range-байтов | Переписывание streaming endpoint без новых доказательств не обосновано | Подтверждено локальным чтением |

В просмотренном фрагменте серверных логов сервис был active, запросы аудио получили `200/206`. Это не доказывает полную передачу, низкую задержку или отсутствие ошибок в другое время. Прокси, смена Wi-Fi/LTE, диск сервера, авторизация и особенности отдельных аудиофайлов остаются диагностическими ветками.

## 2. Правила для каждого исполнителя

Каждому агенту передаются разделы 2–4, полный текст его задачи и принятые решения предыдущего этапа. Перед исполнением читать корневой и компонентный `AGENTS.md`.

- Junior DeepSeek — задачи с логикой и тестами; Junior Gemini — воспроизводимые замеры, матрицы и изолированные проверки. Имена и локальные настройки описаны в [ORCHESTRATION.md](ORCHESTRATION.md); доступность модели проверяется при запуске.
- Senior — архитектурный контракт, решения по native/source identity и независимая приёмка. Репозиторный стандарт роли: Codex `gpt-6.1-sol`, effort `high`.
- Сохранять исходные dirty/untracked изменения. Без `reset`, `clean`, массового форматирования, commit/push, deploy, рестартов сервисов и изменения оригинального аудио в рамках junior-задач этого плана.
- Ownership — только перечисленные файлы и отчёт своей задачи. Пересечение владения решает координатор до редактирования. Новый checkout сам по себе не содержит текущих незакоммиченных изменений.
- iOS: перед кодом читать точные [Expo SDK 58 Audio docs](https://docs.expo.dev/versions/v58.0.0/sdk/audio/) и [FileSystem docs](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/), сверять установленный source. `release-it` — для таймаутов/повторов; `puux-ux` — для поведения; `puuk-ui` — если меняется оформление.
- Backend-тесты: `test_db_path` первым импортом, временный `PUUK_DB_PATH`, отключённые фоновые integrations/fake Qdrant. Не наследовать путь к рабочей SQLite из shell. `setdefault` в test helper не переопределяет уже выставленный env.
- Токены, `Authorization`, query `token`/`mt`, env и signing secrets не попадают в логи/отчёты. URL записывать без query; ошибки очищать до сохранения.
- Артефакты: `/tmp/puuk-playback/<task-id>/`; постоянный отчёт — `docs/IOS_PLAYBACK_<task-id>_REPORT.md`. Команда, cwd, exit code, время, hash исходников и build ID обязательны для свидетельств.
- Не объявлять проблему исправленной по зелёному mock-тесту или сборке. Отдельно указывать `passed`, `failed`, `not tested`. Отсутствие iPhone — `not tested` для device-строк.

Не переносить выводы старых multi-artist отчётов на новый playback candidate. Документы deployment описывают разные исторические состояния: текущий service/process/proxy сначала проверяется read-only.

## 3. Порядок и владение

| Этап | Работа | Параллельность |
|---|---|---|
| 0 | S0: baseline; J01: iOS диагностика; J02: backend/transport; J03: native/source identity audit | J01/J02/J03 параллельно после S0, без правок продукта |
| Gate A | S1: senior принимает диагностику и фиксирует контракт; S1N при необходимости готовит native source identity | До implementation dispatch |
| 1 | J04: cache; J05: scheduler; J06: адрес сервера | J04 и J05 параллельно по зафиксированному API; J06 после J05 из-за общего scheduler-файла |
| 2 | J07: coordinator; затем J08: hook и feedback | Последовательно: общий сценарий восстановления |
| Gate B | S2: интеграция, native-решение, независимое ревью | До device candidate |
| 3 | J09: acceptance на физическом iPhone и повтор транспортных замеров | Только на идентифицированном candidate |

Координатор ведёт состояния задач и ссылки на отчёты в конце этого документа. Подготовка плана не запускает implementation workers. При последующем исполнении через Orca использовать актуальный `skills get orchestration`, реальные Run/Task/Dispatch и проверенные receipts; команды с выдуманными ID не копировать.

## 4. Gate A: контракт, который утверждает senior

S1 владеет этим разделом и планом. На входе — S0/J01/J02/J03. На выходе — конкретные сигнатуры существующих модулей, форма событий и числовые бюджеты, достаточные для независимой работы J04/J05/J07/J08. Junior не выбирает архитектуру самостоятельно.

Обязательные инварианты:

1. Команда запуска, загруженный источник и подтверждённое воспроизведение — разные факты. Успех подтверждает native progress/playing согласно проверенному SDK-контракту.
2. Каждая попытка связана с текущим источником и запросом пользователя. Старые события A после выбора B не меняют B. При A → B → A одного track ID недостаточно.
3. В SDK идентификатор player не считать идентификатором source. Если native event не несёт надёжной привязки, J03 предлагает минимальный механизм; senior выбирает его до включения автоматического recovery. Проставить текущую generation в любой пришедший event недостаточно.
4. Один владелец recovery текущего воспроизведения — coordinator. Hook передаёт намерение пользователя и native-события; cache отвечает за конкретную загрузку, scheduler — за фоновую работу. Повторы между слоями не перемножаются.
5. Намерение play/pause, текущая seek-позиция, auth epoch, source attempt и смена трека учитываются при любом delayed callback. После pause/dismiss/logout/unmount автоматический `play()` запрещён.
6. Локальная неисправная копия инвалидируется адресно: запоздалая ошибка старого URI не удаляет более новую исправную копию того же трека.
7. Текущий поток имеет приоритет. Начало воспроизведения не ждёт полного MP3; предзагрузка и кеширование уступают полосу во время startup/stall. Все фоновые загрузки проходят через scheduler и учитываются в лимите.
8. Ошибки текущего трека и подготовки следующего имеют раздельное состояние. Успех следующего не очищает ошибку текущего. «Повторить» адресует показанный сбой.
9. `401/403` не получают циклических retry и не вызывают logout по одному текстовому совпадению в native error. `404` — отдельная невоспроизводимость трека; cancellation — штатный исход.
10. История и play-start не дублируются из-за технического retry. Автопереход, очередь, нормализация громкости и lock-screen controls сохраняют существующую семантику.

Начальные бюджеты для проверки senior по J01/J02: playback startup deadline 15 с, stall/no-progress deadline 10 с, максимум один automatic recovery через 800 мс, общий startup/recovery budget 30 с от исходного запроса. Общий срок имеет приоритет над сроком отдельной попытки; подтверждённый устойчивый старт завершает startup budget, последующий stall получает свой конечный episode budget. Pause не считается stall. Для cache: inactivity 20 с, общий срок 180 с, максимум три попытки с задержками 800/2000 мс; повторы только transient failures. Это исходные технические настройки плана, не измеренный SLO. Senior фиксирует принятые значения перед dispatch; junior не увеличивает их ради зелёного теста. Для cache отличать отсутствие прогресса от медленной полезной передачи и в любом случае сохранять конечный общий срок.

Контракт адреса: endpoint разрешается из актуальной конфигурации при создании нового источника/загрузки; уже играющий исправный источник не заменяется из-за обычного rerender. Ручная смена сервера инвалидирует несовместимую сетевую работу согласно решению S1.

**S1N — условная senior-подзадача до J07.** Если J03 не подтверждает надёжную source identity существующих событий, senior готовит минимальную правку native patch и контракт JS до передачи coordinator junior-агенту. Ownership: `scripts/patch-expo-audio.js`, выделенные patch-тесты и согласованная event boundary. Проверить source switch, ошибку старого item, A/B/A, освобождение observers и отсутствие изменения паузы. JS-код J07 может разрабатываться с подтверждённым контрактом, но интеграционная приёмка ждёт новой native-сборки. Изменения в `node_modules` сами по себе не являются поставляемым исправлением. S2 проверяет эту работу независимо и не становится обратной зависимостью J07.

### Accepted S1 contract (2026-10-30)

**Gate A is locally implementable; native/device acceptance remains blocked.** Evidence and exact native API: [S1 report](IOS_PLAYBACK_S1_REPORT.md). S0/J01/J03 establish code-level gaps, not incident causality. J02 establishes 58 server-originated measurements, 36 exact body comparisons for three files and a fresh 53-test backend rerun; it does not exclude the backend, mobile path, other times or unidentified incident track. The overwritten initial `2 failed / 51 passed` run is historical failed evidence with unknown cause, not a fixed product defect. No budgets change based on this sample.

J04–J08 implement these signatures in the **existing modules**; no new recovery service, native preload or AudioPlaylist. Existing constructor/test injection remains supported. All deadlines use an injectable monotonic clock and clear timers/subscriptions on cancellation. API names below are binding; additive compatibility fields may remain until J08 migration.

#### 4.1 Identity and the supplied native boundary (S1N)

`player.puukSourceIdentityVersion === 1`, `typeof player.replaceWithAttempt === 'function'` and `typeof player.playForAttempt === 'function'` plus `typeof player.seekForAttempt === 'function'` are all required for automatic recovery. JS creates a globally unique, opaque `sourceAttemptId` **before every installation**, including same-URI retry and A/B/A. A request ID belongs to one logical user selection; technical/manual retries keep its history identity but get a fresh attempt ID. IDs carry no user/token/URL information.

```js
// Additive iOS native API, supplied by scripts/patch-expo-audio.js:
player.replaceWithAttempt(
  { uri, headers }, newSourceAttemptId,
  expectedIntentRevision /* integer|null */,
  expectedSourceAttemptId /* string|null */,
); // boolean; synchronous command acceptance, never readiness
player.playForAttempt(sourceAttemptId, expectedIntentRevision /* integer|null */);
// boolean. null authorizes a fresh explicit user play; recovery MUST pass a revision.
player.seekForAttempt(sourceAttemptId, positionSeconds, expectedIntentRevision /* integer|null */);
// boolean; null = explicit user seek, integer = guarded technical restoration
```

For a new explicit selection pass `null, null` to replacement. Recovery passes the previously installed attempt/revision; native atomically rejects a source switch or pause/interruption that raced the async work. `playForAttempt` checks installed attempt and, for recovery, matching revision plus native play intent. Refresh the captured revision after a successful play command. `replaceWithAttempt` does not implicitly resume and bypasses native preload. Its source must be a resolved `{uri,headers}` object; asset-number/string shims do not apply. Do not fall back to unguarded `play()` when a guarded call returns false.

The direct `playbackStatusUpdate` payload preserves SDK fields and adds:

```js
{
  id: playerId, sourceIdentityVersion: 1,
  sourceAttemptId: string|null,
  nativeEvent: 'snapshot'|'intent'|'loaded'|'progress'|'seekIntent'|'seek'|'error'|'finish'|'reset',
  nativeIntent: 'play'|'pause'|'interrupted', intentRevision: number,
  seekTargetSeconds?: number, seekCompleted?: boolean, seekOrigin?: 'user'|'recovery',
  // SDK fields: currentTime,duration,playing,isLoaded,isBuffering,
  // timeControlStatus,reasonForWaitingToPlay,didJustFinish,error,mediaServicesDidReset?
}
```

`id` identifies the player only. Callback contexts capture the originating AVPlayer, AVPlayerItem and its installed attempt; outdated player/item observers are checked **before** mutating subscriptions. Periodic/error/finish/seek/reset callbacks do not read the active attempt to label an old callback. Events already queued into JS retain their original attempt. Loop/reset descendants retain the logical installed-source ID, with concrete item/player guards; reset does not create a JS-authorized recovery attempt. Legacy `replace()` clears identity, so its events cannot qualify for recovery. Pause changes `intentRevision`, never source identity, cancels pending native autoplay, and emits intent immediately. Public/lock-screen seek, skip-forward and skip-back advance intentRevision and emit source-scoped `seekIntent` with target and `seekOrigin:user` before seeking, then `seek` with `seekCompleted`; they retain play/pause intent. Technical `seekForAttempt(..., revision)` first checks the native revision, emits `seekOrigin:recovery`, and does not change intentRevision; it must not be interpreted as a new user seek by J07. All guarded commands and intent mutations share a native recursive critical section (KVO can synchronously re-enter); no lock is held across an await. Native compilation/stress must still validate thread/lock behavior. Native lock-screen pause/play uses the same intent methods; system/route pauses also cover loading sources and emit `interrupted`. Explicit pause prevents a later system resume.

J08 subscribes **directly** to `player.addListener('playbackStatusUpdate', event => coordinator.handleNativeStatus(player,event))` before selecting/playing; it removes the subscription on cleanup. React `useAudioPlayerStatus` remains presentation data and is not the lossless error/finish transport. Compare exact `event.sourceAttemptId` to the attempt issued by coordinator; never adopt the first incoming ID or attach the current JS generation to an unidentified event. Old/missing IDs return `accepted:false`; do not auto-advance the queue from an unaccepted finish. Discard an intentRevision older than the latest accepted revision for that player; a queued old play/progress event cannot undo a newer pause/seek. Handle accepted finish exactly once across hook status and direct subscription. Native next/previous payloads also carry the status identity and are filtered when capability exists.

**Existing binary capability unknown/absent:** continue legacy playback/presentation and explicit user retry, expose `identityAvailable:false`, and disable automatic native-event recovery and attributed watchdog recovery permanently for that player. Do not wait a few ticks and guess identity. No build ID is inferred from patched node_modules, exports or passing JS tests. The supplied patch is not native compile/device acceptance.

#### 4.2 Budgets, confirmation and interruption

| Budget | Binding value |
|---|---|
| Startup deadline per installed attempt | 15,000 ms |
| Stall deadline after last advancing progress while play is intended | 10,000 ms |
| Automatic replacements per episode | at most 1, after 800 ms |
| Startup/recovery episode total | 30,000 ms from original selection; global deadline wins |
| Later stall episode total | 30,000 ms from last accepted advancing progress before stall |
| Header acquisition | at most 5,000 ms and remaining episode budget; late result discarded |
| Cache inactivity / overall / attempts | 20,000 ms / 180,000 ms / at most 3 |
| Cache transient retry delays | 800 ms, then 2,000 ms, within overall budget |
| Scheduler stable proof | at least 2 advancing progress events spanning 1,000 ms, net advance >= 0.25 s |
| Cache current eligibility | 5,000 ms after entering stable phase |
| Scheduler resume ramp | one start immediately on stable; another slot only after 1,000 ms still stable |

Only `nativeEvent:'progress'`, `isLoaded:true`, `playing:true`, native play intent and an advancing finite `currentTime` confirm playback. First advancing progress marks started, cancels the per-attempt startup watchdog and arms the no-progress stall watchdog; sustainable proof above ends the overall startup episode and releases background pressure. While progress continues, do not fire the cancelled startup deadline. A `loaded`, successful replace/play, zero position, `seek`, duplicate timestamp or finish is not confirmation. A new seek establishes a position baseline and invalidates earlier seek completions; it never counts as playback progress. At the 15/10 s deadline, either schedule the one allowed replacement or terminate; all waits, header acquisition and backoff fit the 30 s total. Continuous buffering is not necessary: intended play with no progress also expires. Do not replace a stream that is making valid progress solely because `isBuffering` is true.

Pause/interruption immediately suspends watchdogs and cancels scheduled recovery; no elapsed pause is counted as a stall. Dismiss means the existing `dismissPlayer` stop/clear intent, not minimizing the modal or normal navigation while music should continue. Logout/auth change/player-owner unmount likewise cancels the current episode, pending commands and background ownership, and pauses the player before release where available. Explicit resume starts a fresh bounded episode for that user action; native system resume is recognized only by a matching identity plus a newer native play-intent revision. Before each recovery replacement/play validate request, auth epoch, JS intent/seek revisions **and** native revision/attempt via guarded calls. Preserve latest requested seek target (otherwise last accepted position); after replacement wait for loaded, issue guarded `seekForAttempt(attempt,target,capturedNativeRevision)`, wait at most 5 s (and remaining episode budget) for matching `seekCompleted:true`, then refresh the native revision and guarded resume. Ignore progress while seek is pending and reset its baseline afterward; a seek-only time jump is not confirmation. Failed/cancelled seek cannot autoplay. Abandon late seeks/headers. Native `seekIntent` with `seekOrigin:user` invalidates pending recovery preconditions; the matching technical recovery seek is only an acknowledgement of the pending restore, not a new intent. User-origin seeking cancels any pending restore and always wins; recompute from the newest target/revision within the existing episode and replacement cap. Paused reset can restore position but cannot autoplay. No stale replace repair may call unconditional play or reset the latest seek to zero.

#### 4.3 J04: existing AudioCache

```js
new AudioCache({
  inactivityTimeoutMs: 20000, totalTimeoutMs: 180000,
  retryDelaysMs: [800, 2000], // constructor injection for meaningful timer tests
  // Existing downloadTimeoutMs is a deprecated inactivity override for callers/tests.
});
cache.invalidate(trackId, expectedUri); // Promise<boolean>
cache.getOrFetch(trackId, remoteUri, { headers, signal, onProgress? }); // Promise<localUri>
// Preserve getCachedUri/isCached/getOngoingPromise/cancel and synchronous dedup semantics.
export function classifyDownloadError(error); // {kind,statusCode:null|number,retryable:boolean}
```

`invalidate` returns true only if it removed the manifest entry whose URI equals `expectedUri`. Compare-and-remove that entry synchronously before the first await; delete only the captured file. A stale URI/no entry returns false. Do not call track-wide `remove/cancel` for invalidation or delete a concurrently published newer file. Missing file deletion is idempotent; genuine deletion failure is visible without corrupting newer state. No full-cache clearing.

One in-flight init promise; reset it on init failure. Cover init, disk check and download in cleanup so `ongoingDownloads` cannot retain a rejected promise. Each generation publishes an atomic, unique final filename; byte presence/size validates a completed file, not its decodability. Local native error is evidence to invalidate the exact used URI, not proof of general disk corruption.

Classification precedence: explicit cancellation/AbortError => `cancelled` (no retry); a **numeric structured** `status/statusCode/response.status` 401/403 => `auth`, 404 => `not_found`, other 4xx except 408/429 => `permanent` (no retry); 408/429/5xx => `transient`; cache-owned inactivity timeout or known structured transport code => `transient`; otherwise `unknown` (no retry). Use small documented structured-code allowlists, never parse localized error text for HTTP/auth. SDK 58.0.11 FileSystem download rejects with coded exception + text and does **not** expose HTTP status structurally; do not invent one. This means unknown native download failures may intentionally stop after one attempt; injected/available numeric HTTP statuses and owned timeouts exercise bounded retries. No extra preflight HTTP request or new auth-refresh abstraction is required.

Inactivity starts when an attempt begins and resets only for strictly increasing finite `bytesWritten`; repeated/zero progress and unknown `totalBytes=-1` do not extend it. Total 180 s starts at `getOrFetch` admission, includes init/backoff/all attempts, and never resets. Cancel timers/task/listeners before rejecting and during abortable backoff; a cancelled generation cannot launch another task. Cache owns retries of its download only; scheduler never retries a failed cache job and coordinator never invokes cache downloads for current-stream recovery.

#### 4.4 J05: existing PreloadScheduler/networkPolicy

```js
scheduler.setPlaybackPressure({ requestId, phase });
// phase: 'startup'|'stalled'|'recovering'|'suspended'|'stable'|'idle'
scheduler.cacheCurrent(track, options = {}); // Promise<uri|null>, cancellation rejects AbortError
scheduler.syncQueue(currentTrack, upNextQueue, options = {}); // existing
scheduler.preloadImmediate(track, options = {}); // existing; pressure never bypassed
scheduler.cancelAll(); // existing: clears queued+active jobs, resume timers/current-cache job
```

`setPlaybackPressure` is edge-triggered/idempotent per request+phase. A startup/stalled/recovering/suspended edge immediately cancels each active **FileSystem background job**, including cache-current, once and retains only desired queue metadata for later rescheduling. Repeated ticks do not cancel/restart. Native current playback is never a scheduler task and never cancelled by it. A stable edge resumes with the ramp above; a new pressure edge invalidates that ramp. Idle after cancellation has no retained jobs. Pressure wins over urgent priority and Wi-Fi changes. Network unknown/cellular remains maxConcurrent 1/lookahead 1; Wi-Fi/ethernet at most 2/2; configured limits can only narrow these. Offline/reachability false starts zero jobs and reconnect pumps once subject to pressure/ramp (add `isConnected:false` policy metadata while retaining unknown type if needed).

`cacheCurrent` enters the same bounded queue/active accounting as preload, with priority 0.5 (urgent 0, next 1, next-next 2), dedup by track, and eligibility 5 s after stable. Repeated current requests join the same promise. Cache hit may resolve immediately, without network. Scheduler owns the delay; J07 deletes the direct `cache.getOrFetch` timer path. Latest desired current + lookahead is at most 3 jobs; retain at most 2 bounded grace-cancelling old active jobs within the same active cap, no unbounded stale queue. Preserve 3 s grace/2-sync stale cancellation for routine queue churn; playback pressure, auth/server changes and cancelAll cancel immediately. Do not free an active slot until the cancelled cache promise settles. Queue changes retain promotion/dedup and prevent overlapping cancellation/restart of the same generation.

Scheduler events remain `{trackId,status,error?,uri?}`; add `purpose:'current'|'next'|'urgent'` and request correlation as needed, without changing existing statuses. A current-cache failure is a background outcome, never an error for the healthy native current stream.

#### 4.5 J06: dynamic URL in existing modules

```js
normalizeStreamUrl(track, serverUrl = SERVER_URL); // existing live binding at invocation
new PlaybackCoordinator({ serverUrl?, getServerUrl? });
new PreloadScheduler({ serverUrl?, getServerUrl?, getStreamUrl? });
```

Explicit `serverUrl` stays fixed for dependency injection. Otherwise call `getServerUrl` (default `() => SERVER_URL`) at **new source installation and background-task start**, not singleton construction/import/queue admission. Explicit `getStreamUrl` remains authoritative in scheduler tests. Endpoint normalization/default/relative stream behavior stays compatible.

On detecting an effective server change at play/sync/start boundary, cancel incompatible queued/in-flight FileSystem work, invalidate its epoch and resolve fresh URL/headers for new work. Late old-origin results cannot publish or alter current-source state. A healthy already-playing native source stays installed until a genuine user selection/retry or eligible recovery; rerender does not replace it. Persistent cache keys retain existing content-ID semantics; do not clear all cached tracks on a URL change. J06 test models settings applied after singleton import. No App/auth rewrite is authorized.

#### 4.6 J07/J08: existing coordinator and hook

```js
coordinator.play(player, track, {
  ...existingOptions, requestId?, authEpoch?, getHeaders?,
}); // Promise<{isLocal,uri,requestId,sourceAttemptId,confirmation:'pending'|'unavailable'}>
coordinator.handleNativeStatus(player, event);
// synchronous {accepted:boolean,didStart:boolean,didFinish:boolean}; one-shot flags
coordinator.setIntent(player, { type:'play'|'pause'|'seek', positionSeconds?, requestId? });
// Promise<void>; intent cancellation takes effect synchronously before any await
coordinator.retryCurrent(player, { requestId?, getHeaders?, authEpoch? } = {});
// Promise<same command result>; concurrent/double taps share one recovery promise
coordinator.cancelCurrent(reason, player = null); // synchronous invalidation + optional pause
// reason: 'superseded'|'dismiss'|'logout'|'auth-change'|'unmount'
coordinator.updateQueue(currentTrack, upNextQueue, options); // existing
coordinator.subscribe(listener); coordinator.getState(); // existing
```

Keep optional call compatibility and existing auth-header provider default. `play` resolves after accepted source/play commands, **not** as proof of started audio; state/direct native events carry confirmation. Coordinator generates missing request/attempt IDs and binds player/auth epoch. Native subscription must already be installed. Header resolution always uses current provider on remote retry and is bounded/cancellable; no token stored in diagnostics. Local native failure calls `invalidate(trackId, usedUri)` and the one automatic remote fallback; a failed remote fallback is terminal in that episode. Remote errors without structured HTTP status remain generic playback failures, never auth/logout. An explicit Retry starts a fresh finite episode for the same logical selection, refreshes headers, bypasses the invalidated source, and respects pause/seek. It cannot create concurrent recovery. There is one automatic replacement total, including local fallback (not one per layer).

`setIntent` owns pause/play/seek commands. J08 routes existing toggle/seek through it and keeps UI seek state; no separate hook recovery timer. `cancelCurrent` increments request/intent validity, clears watchdog/backoff/header/seek continuations, resets pressure and cancels scheduler work; optional player pause happens before release. On superseding play, cancel obsolete work but do not destroy the singleton/listeners. Guard every completion with captured request/attempt/auth/intent/seek context. `destroy` additionally removes listeners. Native pause/interruption events update intent synchronously and suspend recovery; `nativeIntent:'pause'` must never be interpreted as a stall. Recheck native guarded API after asynchronous waits even if a matching pause event is still queued in JS.

State is independent:

```js
{
  identityAvailable: boolean,
  current: {
    requestId, trackId, sourceAttemptId, source:'local'|'remote'|null,
    status:'idle'|'starting'|'playing'|'paused'|'interrupted'|'stalled'|'recovering'|'error',
    intent:'play'|'pause', positionSeconds, error:null|{
      kind:'auth'|'not_found'|'transient'|'playback'|'timeout', retryable:boolean
    }, recoveryCount, // 0 or 1 for this episode
  },
  next: {trackId, status:TRACK_STATUS, error:null|{kind,retryable}},
  // compatibility networkStatus/nextTrackStatus/networkError/lastErrorType/isBufferingSlow
}
```

Compatibility fields are derived with current error/loading priority, then next; next-ready never clears current error. J08 banner uses explicit current/next state: current Retry calls `retryCurrent`, next-only Retry calls `updateQueue(...,{force:true})`/existing preload retry. Current playback remains healthy when next/cache-current fails. Sanitized categories map to short user text; no raw localized errors, URLs or auth text. Preserve existing auth flow without substring-triggered logout. Play-start/history ledger keys the logical selection and uses accepted first progress once; technical source changes do not duplicate history or auto-next. Tests retain artist-credit/queue/wave behavior.

Diagnostics live in coordinator: dev-only 200-entry ring, phase edges plus at most 1 progress sample/s; monotonic elapsed time, request/attempt/track IDs, local/remote, intent, app/network class, position, bg task count and safe error kind. No URL/headers/query, token, raw native description, user/name/SSID/IP. Remove existing raw-source logging from touched recovery paths. No new logging service.

**Local gate acceptance:** native patch fixture/idempotency/drift checks plus targeted JS baseline can authorize J04/J05/J06 and J07 implementation against this boundary after coordinator review. **Not authorized by these tests:** native build/runtime correctness, installed-binary identity, device event ordering, audible output or Gate B/J09 closure. Linux has no Xcode/Swift compiler/iPhone; these remain explicit acceptance blockers.

## 5. Карточки задач

### S0 — зафиксировать исходную точку

**Исполнитель:** senior/координатор. **Ownership:** план и каталог `/tmp/puuk-playback/S0/`.

Сохранить `git status`, diff затрагиваемых файлов, hashes, lockfile, версии runtime/SDK и доступность текущей сборки на iPhone. Отметить чужие правки, с которыми пересекается работа. Выполнить целевые существующие playback-тесты и записать baseline failures отдельно от будущих регрессий. На сервере использовать только read-only проверку актуального процесса/endpoint, без вывода секретов.

**Приёмка:** воспроизводимый manifest фактических файлов, результаты baseline, список доступных сред и явно отсутствующих device-свидетельств.

### J01 — воспроизведение и спецификация диагностики iOS

**Исполнитель:** Junior DeepSeek. **Ownership:** только `IOS_PLAYBACK_J01_REPORT.md` и собственные временные артефакты. **Зависимость:** S0.

Изучить coordinator/hook/cache/scheduler и установленный SDK; подготовить сценарий одного удачного и одного проблемного запуска. При доступном debug-приложении собрать наблюдения; если нужной телеметрии нет, описать минимальные точки добавления для J07/J08. Не подменять отсутствие измерения рассуждением по коду.

Поля: request/attempt ID, track ID, source local/remote, фазы select → replace requested → loaded → first progress, buffering/stall, native error, текущий play/pause intent, позиции, foreground/background, тип сети, активные фоновые задачи. Использовать монотонные длительности и ограниченное число записей; секреты исключить.

**Приёмка:** таблица «наблюдение → доказательство → гипотеза → проверка», сценарии с кэшем/без кэша, cold start, быстрые A/B/A, медленная сеть, смена Wi-Fi/LTE, lock screen. Время `play()` не выдавать за time-to-audio.

### J02 — backend и путь передачи

**Исполнитель:** Junior Gemini для замеров; при найденном дефекте отдельная задача Junior DeepSeek. **Ownership:** только `IOS_PLAYBACK_J02_REPORT.md` и временные артефакты. **Зависимость:** S0.

Изучить `brain/routers/streaming.py`, `auth.py`, `services/media_locations.py`, `test_media_ticket.py`. На изолированном окружении выполнить существующий контракт. На доступной серверной среде read-only сверить актуальные service/proxy и файлы для выбранных треков. Запросы с авторизацией выполнять без вывода токена, включённого shell tracing и сохранения query-секретов.

Для одного и того же трека сравнить backend loopback и публичный endpoint: статус, final host/redirect, Content-Type, Content-Length, Accept-Ranges, Content-Range, время до заголовков/первого тела, полную длительность, фактические байты. Проверить full GET, начальный/средний/хвостовой Range и недопустимый Range. Не держать массовую нагрузку на production: последовательные ограниченные выборки, не более 2 параллельных GET. Измерение с компьютера не считать измерением с iPhone.

**Приёмка:** сравнение минимум для 3 треков разного размера, включая проблемный, если известен; точные байты Range и завершённость full body; `401`, missing-file `404`, `416`; таблица результатов и ограничений. При найденном серверном дефекте подготовить локальный repro и минимальный patch proposal для senior, без самовольного streaming rewrite/deploy.

### J03 — native audit и привязка событий к источнику

**Исполнитель:** Junior DeepSeek, решение принимает senior. **Ownership:** только `IOS_PLAYBACK_J03_REPORT.md` и временные repro. **Зависимость:** S0.

Проверить `scripts/patch-expo-audio.js`, фактические `AudioPlayer.swift`/`AudioModule.swift`, JS hooks SDK и происхождение установленного на телефоне binary. Установить, когда возвращаются replace/play, какие события означают ready/error/progress, как различить старый source и новый. Исследовать background task: начало, expiry, успешный старт, пауза, finish, source change и освобождение ресурсов.

**Приёмка:** фактический event contract с A/B/A и pause-during-load; предложение минимальной source identity, если её нет; proof/unknown по версии native patch в установленном binary; список необходимых native-правок с тестируемыми условиями. Не включать native preload и не мигрировать на AudioPlaylist. Проверки текста Swift не считать iOS runtime smoke.

### J04 — адресная инвалидация и ограниченные повторы AudioCache

**Исполнитель:** Junior DeepSeek. **Ownership:** `utils/audioCache.js`, `utils/__tests__/audioCache.test.js`, отчёт. **Зависимость:** Gate A.

Реализовать принятый контракт инвалидации конкретной локальной копии. Разделить cancellation/permanent/transient failures по доступным структурированным данным; native SDK error shape сначала подтвердить, отсутствующий HTTP status не выдумывать. Добавить принятые inactivity/total budget, корректное освобождение timeout/listener/task и retry backoff. Сохранить атомарную публикацию и дедупликацию загрузок. Проверить единственную in-flight init и очистку записей после init failure, если repro подтверждает проблему.

**Приёмка:** permanent `401/403/404` при доступном статусе не повторяются; transient failure повторяется в общем бюджете; полезный прогресс отличается от зависания; отмена во время backoff не создаёт новый запрос; invalidation старого URI не удаляет новую копию; init failure допускает последующий успешный вызов; дедупликация и защита поколений проходят прежние тесты. Повреждённое аудио не объявляется обнаруженным только по ненулевому размеру.

### J05 — scheduler уступает полосу воспроизведению

**Исполнитель:** Junior DeepSeek. **Ownership:** `utils/preloadScheduler.js`, `utils/networkPolicy.js`, их тесты, отчёт. **Зависимость:** Gate A.

Реализовать согласованное управление фоновой работой при startup/stall/recovery; остановка или отсрочка должна иметь явную семантику и не приводить к циклу cancel/restart на каждом status tick. Учесть кеширование текущего трека в общем лимите и освобождение работ, потерявших актуальность. Возобновлять ограниченно после устойчивого progress согласно контракту. Не отменять нативный текущий поток.

**Приёмка:** на медленной сети новые speculative downloads не стартуют во время startup/stall; активная фоновая работа обрабатывается по принятому правилу; сеть unknown/LTE не расширяет лимиты; возврат сети возобновляет очередь однократно; быстрые skip не оставляют бесконечно растущие загрузки; дедупликация/grace cancellation/urgent priority сохраняются. Проверить общий лимит, включая прежний прямой cache-current путь, после интеграции J07.

### J06 — актуальный адрес сервера

**Исполнитель:** Junior DeepSeek. **Ownership:** URL resolution в `utils/streamUrl.js`, `utils/playbackCoordinator.js`, `utils/preloadScheduler.js`, тесты streamUrl/coordinator/scheduler, отчёт. **Зависимость:** J05; завершить до J07.

Устранить сохранение устаревшего default URL в singleton. Сохранить явную dependency injection URL в тестах. Использовать текущую настройку для новых источников и background tasks. Не переписывать `App.js`/общий auth API без согласованного расширения ownership.

**Приёмка:** сохранённый custom server после cold start используется и для stream, и для preload; последующая смена адреса применяется согласно Gate A; default URL и относительные stream URLs сохраняют формат; обычный rerender не перезапускает аудио; старый request не меняет новый source. Интеграционный тест моделирует загрузку настроек после импорта singleton.

### J07 — coordinator: подтверждённый старт и recovery текущего трека

**Исполнитель:** Junior DeepSeek по контракту S1, обязательное senior review. **Ownership:** `utils/playbackCoordinator.js`, `utils/__tests__/playbackCoordinator.test.js`, отчёт. **Зависимости:** J04/J05/J06 и готовая принятая source identity из J03/S1.

Внедрить source-scoped обработку loaded/progress/error, конечное ожидание startup/stall и ограниченный recovery. Локальная ошибка инвалидирует именно использованный URI и допускает remote fallback. Retry учитывает актуальные auth headers и intent. Кеширование текущего идёт через scheduler. Исправить stale replace repair, чтобы он сохранял pause/seek и не запускал устаревший источник. Разделить состояние current playback и next preload; добавить согласованную безопасную диагностику.

**Приёмка:** поздняя ошибка после успешного вызова play обрабатывается; зависание заканчивается recovery либо явной terminal error в бюджете; валидный progress прекращает watchdog; A/B/A и ошибка старого A не затрагивают новый A; pause/seek/dismiss/logout отменяют или ограничивают recovery по контракту; нет одновременных retry; ошибка следующего не меняет состояние исправного текущего. Проверить асинхронные native failure events: mock `replace()`/`play()` сам по себе успешен.

### J08 — hook, действие «Повторить» и feedback

**Исполнитель:** Junior DeepSeek. **Ownership:** `hooks/usePlayerController.js`, его тесты; `components/fullplayer/PlayerNetworkBanner.js`, его тесты; минимальное подключение в `App.js`/`components/FullPlayerModal.js`, отчёт. **Зависимость:** J07.

Подключить native events по принятому контракту и передавать намерение пользователя coordinator. «Повторить» восстанавливает показанную ошибку текущего трека; сбой только следующего адресует preload. Отразить загрузку, восстановление, недоступный трек и auth failure понятным сообщением без raw URL/native secrets. Сохранить existing auth flow и исключить logout по неструктурированному тексту ошибки. Новую абстракцию auth refresh/JWT migration не вводить.

**Приёмка:** current retry действительно заменяет неисправный current source; двойной тап не создаёт дубликаты; pause во время recovery не превращается в autoplay; уход экрана/другой трек/смена пользователя обезвреживают callbacks; история и play-start не дублируются; next-ready не очищает current-error. Проверить, что сигнал ошибки не теряется между редкими status updates SDK. Existing artist-credit/queue/wave hook tests остаются зелёными.

### S2 — интеграция, native-решение и независимое ревью

**Исполнитель:** senior, независимо от автора проверяемого изменения. **Ownership:** интеграционные исправления, только нужный native patch/его тесты, план и отчёт S2. **Зависимости:** J04–J08, отчёты J02/J03.

Проверить реальные event ordering, source identity, общий бюджет и отсутствие retry amplification; пройти критические тесты с частично завершёнными Promise и fake timers. Решить по evidence, нужна ли правка background task. При необходимости senior делает минимальный patch с гарантированным завершением background task на success/failure/cancel/expiry; не оставляет его бесконечно активным. Source identity должна быть готова на Gate A/S1N; её отсутствие возвращает работу на этот gate и блокирует приёмку J07.

Проверить read-only актуальный backend при расхождении J02. Серверные исправления выделять отдельной карточкой с repro, конкретными файлами и локальными тестами. Подготовить идентифицированный iOS candidate с hashes/lockfile/native patch, инструкцией установки и проверки; сборку/доставку выполнять только в реально доступном и уже разрешённом scope.

**Приёмка:** независимый review без открытых критических нарушений инвариантов; полный iOS suite, lint затронутых файлов и Expo export на итоговом candidate; backend targeted tests при backend-правках. Native compile/device acceptance отдельно от JS-проверок. Отсутствующая сборочная среда или телефон остаются явным блокером соответствующей приёмки.

### J09 — физический iPhone и сравнение до/после

**Исполнитель:** Junior DeepSeek через Inferhold (замена Gemini явно согласована пользователем); доступ к устройству — только фактически доступными средствами. **Ownership:** отчёт J09 и артефакты. **Зависимость:** Gate B и установленный candidate.

Для каждой строки записать device/iOS/build, сеть, cache state, время до первого подтверждённого progress, поведение recovery и итог. Звук дополнительно подтвердить наблюдением на устройстве: progress сам по себе не доказывает слышимость. Не очищать весь пользовательский cache без необходимости; использовать выделенные fixture-треки/адресную инвалидацию.

| Сценарий | Проверяемое поведение |
|---|---|
| Cold start, сохранённый custom endpoint | Каталог, stream и preload используют ожидаемый сервер |
| Cached и uncached трек, Wi-Fi и LTE | Кэш начинает локально; remote стартует без ожидания полной загрузки |
| Медленная сеть и ограниченный bandwidth | Текущему потоку не мешают speculative downloads; фиксируются реальные задержки |
| Полный обрыв, затем возврат сети | Конечный error/recovery без вечного spinner и retry storm |
| Смена Wi-Fi ↔ LTE во время startup и в середине трека | Корректный outcome и сохранение актуального намерения/позиции |
| Pause/seek во время загрузки и recovery | Самопроизвольного resume и скачка на ноль нет |
| Серия A → B → A и 10 быстрых skip | Звук/метаданные соответствуют последнему выбору; фоновые задачи ограничены |
| Ошибка cached source в тестовом окружении | Адресная invalidation, remote fallback, повторный выбор исправен |
| `401`, `404`, временный `5xx` через тестовую среду | Различимая ошибка и только допустимые повторы; production token не ломается |
| Lock screen: 5 переходов, следующий без кэша | Переход подтверждён в фоне, действуют pause/next; измерена пауза между треками |
| Bluetooth отключён/подключён, системное interruption | Остановка/возврат не маскируются под загрузку; intent сохраняется |

**Приёмка:** каждая строка `passed/failed/not tested`, ссылки на очищенные логи, сравнимые baseline/candidate measurements. Для стабильной сети собрать минимум 10 стартов local и 10 remote, указать median/p95 с размером выборки; это диагностическая выборка, не доказательство отсутствия редких сбоев. Итоговый SLO по скорости принимает senior по замерам, а не придумывает junior после теста.

## 6. Команды проверок и завершение

Пример целевого iOS прогона из `app/ios/puuk-ios`:

```bash
npm test -- --runInBand utils/__tests__/audioCache.test.js utils/__tests__/preloadScheduler.test.js utils/__tests__/networkPolicy.test.js utils/__tests__/streamUrl.test.js utils/__tests__/playbackCoordinator.test.js hooks/__tests__/usePlayerController.test.js components/fullplayer/__tests__/PlayerNetworkBanner.test.js
```

Каждый worker запускает относящийся к нему поднабор, S2 — полный `npm test -- --runInBand`, lint затронутых файлов и `npx expo export --platform ios --output-dir /tmp/puuk-playback/S2/export`. Пути новых тестов добавлять по факту. Нативные изменения требуют отдельной сборки iOS.

Backend из `brain` в доступном окружении с установленными зависимостями:

```bash
python -m pytest -q test_media_ticket.py test_track_recovery.py test_closed_access.py
```

Перед этим координатор задаёт гарантированно временный `PUUK_DB_PATH`, отключает внешние integrations и проверяет тестовые заглушки. Наличие указанных команд в плане не означает, что они уже выполнены.

Общий формат отчёта: исходный hash → что изменено → сценарий до/после → команды/результаты → device evidence → ограничения → открытые вопросы. Senior принимает качество по артефактам и поведению; самоотчёт junior не закрывает Gate.

Завершение продуктовой задачи: приняты Gate A/B, обработаны поздние ошибки и зависания, восстановление сохраняет intent/source identity, фоновая работа ограничена, текущий retry работает, транспортные гипотезы проверены или явно локализованы, обязательная device-матрица выполнена на итоговом candidate. Если устройство недоступно, локальную реализацию можно принять отдельно, а продуктовую задачу оставить открытой.

## 7. Журнал выполнения

| Задача | Статус | Отчёт / фактические Task и Dispatch |
|---|---|---|
| S0 | passed (local); device not tested | [S0 report](IOS_PLAYBACK_S0_REPORT.md), Run `run_5c86d4feea71` |
| J01 / J02 / J03 | accepted diagnostic evidence; device not tested | J01 `task_ce2cbd63ebe5` / `ctx_f1c1294303aa`; J02 `task_dfcce3256a36` / `ctx_c5bdd7739e00`; J03 `task_26e55b10d94d` / `ctx_5665628017b8` |
| S1 / Gate A + S1N | accepted locally by coordinator; native/device not tested | [S1 report](IOS_PLAYBACK_S1_REPORT.md), `task_d362cc8f824d` / `ctx_2ef17f633ee2` |
| J04 / J05 | accepted locally after mandatory follow-ups; pressure regressions assigned J06 | [J04 report](IOS_PLAYBACK_J04_REPORT.md), [J05 report](IOS_PLAYBACK_J05_REPORT.md); follow-up tasks `task_e4d82ab0576f`, `task_8088a983f297` |
| J06 | accepted locally:123 targeted /227 playback tests,7 hashes and root repro | [J06 report](IOS_PLAYBACK_J06_REPORT.md), `task_7e3c5e365d56` / `ctx_3e913bf83daa` |
| J07 / J08 | J07 accepted locally after senior correction; J08 running | [J07 senior fix](IOS_PLAYBACK_J07_SENIOR_FIX_REPORT.md), `task_cdf0a64145f7` / `ctx_da03373dd25f`; J08 `task_a2e85a8d9688` |
| S2 / Gate B | registered; waiting dependencies | `task_d0d31a741ac0` |
| J09 | registered; no identified device candidate yet | `task_ed096f21f5d4` |

При подготовке плана выполнено чтение текущего кода и документации. Два вспомогательных read-only обзора дали предварительные замечания и завершились по лимиту сервиса; они не считаются независимой завершённой приёмкой. Implementation dispatch, изменение runtime-кода, deployment и device acceptance в рамках подготовки плана не выполнялись.

2026-10-30: Tundra attempts J01/J03 ended with provider unavailable and no report; fenced via worker-abandon after stop_unknown (external terminals). Same Tasks retried on user-selected `inferhold/deepseek-v4.1-flash`. Unassigned Nyxos terminals closed without dispatch.

2026-10-30: user selected Inferhold for J02/J09 too. Gemini J02 request cancelled explicitly; old Dispatch ctx_b57390b01d4c abandoned, same Task retried as ctx_c5bdd7739e00 on existing Inferhold terminal. Saved 58 transport rows and backend logs retained; repeat production measurements not requested.

2026-10-30 S1/S1N: section 4.1–4.6 fixes existing-module APIs, unchanged budgets, native source/intent/seek boundary and old-binary fail-closed behavior. Supplied patch plus pristine/legacy fixtures: 8 suites / 183 tests passed, output hashes/idempotency/format/lint checked. Final 26-file before/after verification matches; protected playback JS/App/lockfile unchanged. An unknown external rollback of owned S1 files was restored after explicit user approval; evidence in S1 report. Native compile/device acceptance remain not tested on Linux and block Gate B/J09.

2026-10-31: coordinator accepted local Gate A using final S1 report/hash verification and 8/183 passing tests. Previous Inferhold terminals were no longer available; preflight starts refused without dispatch. New OpenCode terminals launched without a task, model selected and verified in each TUI as `deepseek-v4.1-flash Inferhold`, then J04/J05 dispatched with strict disjoint ownership. No native/device acceptance inferred.

2026-10-31: Orca runtime connection closed during J04/J05. Read-only status confirmed app not running; `orca-ide open` restored it. Request `6f157b35-fbcb-44d3-bdb6-c77e5e079d53` replay confirmed cancelled wait/no delivery; fresh worker-list confirmed both existing dispatches live, so neither was restarted. Runtime now `ade86b41-d863-48a1-b61b-31ef3b2f4068`.

2026-10-31: user requested trying Tundra after Inferhold token balance exhausted. Both failed provider turns verified in TUI and fenced; unchanged Task IDs retried in the same sessions with verified `tundra/deepseek-v4.1-flash-1017`. Exact unfinished sources preserved under each task before-tundra/; review notes in coordinator-review.md. No J04/J05 acceptance yet.

2026-10-31: J04 reported33 cache tests/188 combined passed; root final review requires monotonic default clock (Date.now default was still wall time). Same proven Gemini terminal reused for task_e4d82ab0576f / ctx_942d0f8141bb; J07 held by coordinator acceptance gate until follow-up evidence. Independent read-only S2 native preflight task_34662d8f7f57 / ctx_465323b87323 started on Codex gpt-6.1-sol high after clearing a stray xterm response in the first failed-readiness terminal; no duplicate senior process and no implementation ownership transferred. Native preflight is not Gate B acceptance.

2026-10-31: J05 reported62 targeted/192 combined tests, but root executable read-only repro found10 queued urgent jobs under startup against limit3. Mandatory follow-up task_8088a983f297 / ctx_33c3bb81c8c9 assigned to same Gemini terminal; gate_ac5dee486c84 blocks J06 until accepted. J04 follow-up gate_f872f2d74cd4 blocks J07. Repro artifacts /tmp/puuk-playback/J05/review-urgent-bound.*; no native or product completion inferred.

2026-10-31: J04 follow-up accepted locally:34 cache tests, syntax/lint/format passed; source33e3fb90ad0c09ee542c21584ecd2f080a7acc63ebe959dc3cf3da3c048741ec and test73c516741803c7fd0a8a60b904eb1ae189801b158a95a364c17efdc50306166a match final backups/hash ledger. Gate gate_f872f2d74cd4 resolved accepted. Documentation erratum: J04 report table UTC starts are inaccurate (22:42:01/02); authoritative followup/commands.jsonl records22:40:17/18Z and syntax-cache23.74ms, all exit0. Final S2 evidence must use raw command ledger. Cache device/runtime acceptance remains not tested.

2026-10-31: independent native preflight completed with confirmed F1/F2(P1), F3/F4(P2); see /tmp/puuk-playback/S2/native-preflight.md. Corrections dispatched to original S1 author, preserving independent reviewer. All26 original native pins preserved under S1/native-correction-baseline before authorized changes. Public v1 APIs remain binding; native fixes and runtime hypotheses must be checked by full S2/device acceptance, not hidden by passing static patch tests.

2026-11-02: coordinator rebound existing Run after runtime restart (consumer generation2). Old /tmp artifacts disappeared; reconstructed native review is explicitly not exact restoration. J05 five source/test hashes match durable report and fresh3-suite64-test run passed; gate_ac5dee486c84 accepted. J06 dispatched ctx_3e913bf83daa on restored Gemini. Native author prior process exited/operator_close with no fix report; user confirms limit reset, same ready native Task resumed on restored author terminal. Current playback source snapshot saved /tmp/puuk-playback/RESUME-2026-11-02; native F1–F4 remain open until corrected/reviewed.

2026-11-02 S1N corrections: original author completed task_5ec6e96a6592 / ctx_a45a2f392a47; coordinator verified27/27 final pins and fresh logs for25 patch +53 mocked-hook tests, focused lint and installed idempotency. [Correction report](IOS_PLAYBACK_S1N_FIX_REPORT.md). Independent read-only re-review dispatched task_8f3457c01a94 / ctx_b9177dcfc184; this does not close Gate B/native/device acceptance. J06 additionally owns two reproduced scheduler pressure fixes (retained-next resumption on stable and5s current-cache eligibility); fresh exact-source repro/log in /tmp/puuk-playback/S2/scheduler-review/.

2026-11-02 independent S1N re-review: [review report](IOS_PLAYBACK_S1N_REVIEW_REPORT.md), task_8f3457c01a94 / ctx_b9177dcfc184 confirms F1–F4 addressed at source level,27 pins/public APIs and25 isolated tests plus six mixed-generation rejection checks. New P2 R1: foreground can consume system-interruption resume permission and bypass no-resume. Assigned original author narrow correction task_6a4ea7b36b0c / ctx_9e7080276a17; independent correction acceptance remains open. Native build/device/Gate B not accepted.

2026-11-02 R1 owner follow-up delivered: [R1 fix report](IOS_PLAYBACK_S1N_R1_FIX_REPORT.md), task_6a4ea7b36b0c / ctx_9e7080276a17. Coordinator verified28/28 pins,36 focused fixture/static tests and repeat-application log. Independent R1 re-review assigned to original independent reviewer; native runtime/build/device/Gate B remain unaccepted. J06 initial9-suite combined command had3 native-mid-edit patch failures and246 passes; later8-suite JS pass overwrote the same log filename, so the old full failure output is unavailable (exit1 ledger and coordinator-observed failure tail remain). Final report must distinguish revisions and preserve subsequent logs under unique names.

2026-11-02 J06 accepted locally: [J06 report](IOS_PLAYBACK_J06_REPORT.md), ctx_3e913bf83daa;7/7 final hashes verified,123 focused and227 JS playback tests passed; independent root repro confirms next starts after pressure→stable and current does not start before5s. Failed-run log provenance erratum above remains authoritative. Same Gemini terminal immediately reused for registered J07 task_34ed57ff1bed; native R1 independent review remains separate. No device acceptance inferred.

2026-11-02 independent R1 re-review accepted as review evidence: [R1 review](IOS_PLAYBACK_S1N_R1_REVIEW_REPORT.md), task_9f017ec01ea2 / ctx_7cc9c6c3959b confirms R1 source trace closed,28 pins/public APIs and36 isolated tests. Retained P2 R2 concerns stale whole-module system-end cleanup and original ducking-volume retention; original author assigned narrow correction in parallel with J07. No native runtime/Gate B acceptance inferred. Optional read-only J08 preparation dispatch task_181b598347bc / ctx_81b1157a09c8 refused before input with stable_pane_required; worker-show proves identity_changed/no materialized resource, no worker source edits. Coordinator gathered fresh6-file backup and integration notes under /tmp/puuk-playback/J08-PREP instead; actual J08 dependency unchanged.

2026-11-02 active continuation checkpoint: J07 task_34ed57ff1bed / ctx_4f80371731d2 (Gemini, term_8ee7c681-b022-4bff-a959-f366005c0d49); R2 task_ce7c5d44060e / ctx_82d3cc73e2f1 (original Codex author, term_d49debac-ae50-45aa-87b6-4db420c2f8ca). Independent Codex reviewer term_b53b1f2f-3b05-4dae-ab18-a6ba092803e2 is settled/released and read-only; preserve its independence for full S2 after J08. R2 independent disposition remains for S2. J08 integration notes and6-file baseline are coordinator-prepared, not a completed implementation. No native compile/device candidate exists.

2026-11-03 R2 author delivered: [R2 fix report](IOS_PLAYBACK_S1N_R2_FIX_REPORT.md), task_ce7c5d44060e / ctx_82d3cc73e2f1. Coordinator verified30/30 final pins and raw44-test pass/idempotence logs; preserved failures and unchanged whole AudioPlayer/public v1 declarations. Provider TLS retry recovered and worker_done received. Implementation artifact accepted for independent S2 disposition after J08; native/Gate B/device acceptance remains open, including added module lock/notification boundary review. Author terminal released (external-terminal receipt). J07 remains active.

2026-11-03 independent R2 boundary review dispatched task_0020a1ce7f4e / ctx_582133096a72 on original independent reviewer terminal, scoped to introduced R2 module lock/notification/generation/volume changes and preservation. J07 still owns coordinator implementation; it has only baseline hashes so far. Coordinator sent high-priority implementation/blocker checkpoint msg_6ccba4f5895b; no duplicate editor launched and live dispatch not cancelled from silence.

2026-11-03 independent R2 review accepted locally: [R2 review](IOS_PLAYBACK_S1N_R2_REVIEW_REPORT.md), task_0020a1ce7f4e / ctx_582133096a72 confirms30/30 pins,44/44 isolated tests and no new confirmed defect in introduced R2 delta; native lock/reentry/OS/device probes and full S2 remain open. Reviewer settled/released. User explicitly requested restarting Gemini for J07: snapshot /tmp/puuk-playback/J07/before-user-restart preserves both owned files. Old ctx_4f80371731d2 fenced after worker-stop reported external-terminal stop_unknown; exact user-authorized terminal close confirmed ptyKilled=true and worker-show exact exit/operator_close. No new APIs were on disk. Launch-time OpenCode model override refused capability_unsupported before Dispatch; a fresh unassigned OpenCode session was launched for TUI model verification before retrying the same Task. No duplicate writer remains.

2026-11-03 J07 fresh retry ctx_56803e027897 on term_ec644c18-cffa-4725-9cf9-d51008916bae, TUI verified gemini-3.8-flash Antigravity Manager before injection. Runtime changed automatically to810e4f18-20f9-4a69-a394-b5d313157bf6; coordinator rebound same Run/generation, live retry confirmed, no duplicate launch. Initial provider ECONNREFUSED ended, fresh worker now executes tools with17.8K context; no provider settings/service modifications. Latest self-contained guidance msg_712ed3001884 delivered to current Dispatch. Independent R2 reviewer idle/released for future S2.

2026-11-03 continuation of user-authorized Gemini restart: ordinary Flash repeated extended analysis, so selected configured gemini-3.8-flash-low in a fresh TUI (verified Antigravity Manager) and retried same J07 task as ctx_6dd70975a5c2 on term_47514400-ba95-4528-9226-ab2b785eed18. Old ctx_56803e027897 fenced and exact terminal close confirmed ptyKilled/exited. Snapshot before-flash-low caught a partial coordinator draft written immediately before interruption (SHA1c0b3889...), including new fields/timers and incomplete method wiring; it is preserved for completion, not accepted or discarded. Tests unchanged; no J07 acceptance. New owner explicitly instructed to complete current partial draft and preserve J06 baseline/foreign work.

2026-11-03 provider recovery within current J07 ctx_6dd70975a5c2: configured Flash Low returned Requested entity was not found before work; a transient TUI selection of medium also returned model-not-found. Returned verified TUI default to gemini-3.8-flash Antigravity Manager and interrupted failed API request, keeping same Task/Dispatch/current partial files. No credentials/settings/services were changed; startup/continuation guidance remains in current inbox. These are provider failures, not implementation test results.

2026-11-03 J07 draft now has new APIs but remains unaccepted. Root isolated VM repros under /tmp/puuk-playback/J07/root-review/ confirm: loaded/snapshot can mark didStart (fa4f767...); pre-header attempt publication rejects real installed-source native pause with zero replacement commands (a994a983...); guarded seek rejection or5s seek-completion timeout both issue play once (8ab1e86...). Exact source snapshots/failure logs preserved; high-priority findings sent current owner ctx_6dd70975a5c2 for corrections and public-flow regressions. Gate gate_813aa938757a blocks J08 acceptance/start until verified J07 corrections; no test/source-level/native acceptance inferred from draft presence.

2026-11-03 J07 root review now also confirms public-flow30s overrun: zero native progress, replacement at15800, statusstillplaying at30000, terminalerror30800. Exact snapshot SHAab81abf... and budget-repro.cjs/log in root-review. Owner notified along with initial three defects; J08 gate remains pending and requires all binding contract issues corrected, not only initial three.

2026-11-03 build-access refresh (read-only while J07 edits): Orca host list exposes local Linux and one disconnected SSH entry; saved remote environments empty, no connected Mac builder found. Nested tool discovery has no iPhone/native builder capability. Fresh executable/device availability saved /tmp/puuk-playback/BUILD-ACCESS-2026-11-03/access.json without device identifiers. This is available-environment evidence, not proof that a future cloud builder cannot be configured and not native/device acceptance.

2026-11-03 J07 ctx_6dd70975a5c2 delivered report claiming258 passed tests, but final coordinator SHAab81abf... retains all four reproduced root defects and other binding contract gaps. Implementation acceptance rejected; settlement processed and same Gemini terminal immediately reused for mandatory corrective task_67a787a4b483 / ctx_c79d0f1944c5. Detailed self-contained correction spec /tmp/puuk-playback/J07/correction-spec.txt requires public-flow regressions, hard30s budget, strict native progress, installed identity during headers, successful matching loaded/seek completion, intent guards and safe dev diagnostics. Gate813/J08 remain pending. Mechanical succeeded status is not acceptance.

2026-11-03 independent frozen J07 review task_db0cb5a5390c / ctx_de92a7fa03c6 found11 additional contract-failure groups via12 public-path VM cases on historical SHAab81abf. Report /tmp/puuk-playback/S2/J07-snapshot-review.md with real command ledger/results; exit0 means violation assertions reproduced, not product passed. Covers stale play after logout, pause during initial headers, paused retry position/ledger, request IDs, resume watchdog/legacy, later stall and pressure, source epochs, structured error classification and required getHeaders. Cases routed current corrective Gemini before final report; early-local-invalidation probe explicitly excluded as ambiguous. Reviewer remains read-only/independent for full S2. Moving corrective source not assessed by these historical reproductions; no native/device acceptance.

2026-11-03 frozen J07 review worker_done received/accepted as review evidence; original independent reviewer ctx_de92a7fa03c6 settled/released for future full S2. Exact report preserved durably as [J07 snapshot review](IOS_PLAYBACK_J07_SNAPSHOT_REVIEW_REPORT.md), not acceptance of current correction. Source/test ownership remains Gemini ctx_c79d0f1944c5; no duplicate writer.

2026-11-03 J07 corrective candidate ce95f968... delivered82 focused/273 combined passing tests. Root independent public harness final-public-check.cjs confirmed7 scenarios passed but3 FAILED (real Node exit1): arbitrary unauthorized native text still auth, obsolete A recovery-header rejection terminates B, obsolete A Retry seeks newly selected B. Exact candidate/report preserved round2-before and ce95-public-results/command; manual retry also resumes before guarded loaded/seek completion. Acceptance rejected; same Gemini immediately reused task_9db4f503d3d3 / ctx_3ccccfe05c2c with narrow correction spec correction-round2.txt. Report claim standalone private helper has five assertions is inaccurate (it prints values and can skip guarded recovery); public regressions/final-source review remain mandatory. Gate813/J08 stay pending.

2026-11-03 root ce95 frozen extended public check confirms two more pause/resume gaps: equal-revision stale native play/progress can move paused status to playing; healthy sustained resume still errors at30s due stale sustainable-proof flag. ce95-public-extended2-results/command preserve real Node exit1 (7passed/5failed). Earlier exploratory healthy-resume assertion after a new progress event masked transient error; corrected assertion checks before every subsequent event. Both concrete cases sent current round2 owner msg_97566dafae8c. No acceptance inferred from initial exploratory check.

2026-11-03 round2 focused87tests passed before final manual Retry fix, but coordinator source review still found play-before-restore/null user-origin seek. Owner explicitly notified msg_8a32fc6d9abb and took correction before settlement. Root acceptance harness now14public cases inclactive/paused Retry readiness/seek ack; it reproduced earlyplay on interim source. Do not accept interim44c2... hash or87tests as completeJ07. J09 draft protocol and fresh14:15UTC host/device availability saved under /tmp/puuk-playback/J09-PREP; no connectediPhone/localXcode toolchain, no device acceptance.

2026-11-03 junior round2 closed honestly FAILED atcoordinator request after13/14 public scenarios; [handoff report](IOS_PLAYBACK_J07_REPORT.md), source638fac291.../test3f79317c..., manual paused Retry unresolved. Report87/278pass logs are INTERIM before latest manual edits, not proof of final638 source. Gemini settled/released/acked; no duplicatewriter. Senior corrective author task_cdf0a64145f7 assigned freshCodex, preserving original independent reviewer forS2. First ctx_d2418a8ea6eb failed agent_readiness timeout beforeTaskinput; receipt-directedrelease closed exactcreatedterminal. Freshsession had stray xterm.js draft; clearedCtrlU/readverifiedempty, sameTask retry ctx_da03373dd25f onterm_8f14f45b-0b83-4dba-96d4-1e82a9c2bf08 ready+turn_started. No service/provider changes, J08gate813 stillpending.

2026-11-03 J07 accepted LOCALLY after [senior corrective integration](IOS_PLAYBACK_J07_SENIOR_FIX_REPORT.md): source65741867... and test39a58cbd... verified before/after fresh root14public cases exit0,9 exact-source successful command/log hashes verified,123focused and339combined/9suites, syntax/lint/format. Report preserves baseline86pass1timeout andallfailed intermediate logs; no native build/device claim. Authorctx_da03373dd25f settled/released andworker_done acknowledged; gate813accepted. Current J07 acceptance uses SENIOR report/finalhashes, juniorFAILED report stays historical truth. Original independent reviewer remains separate forS2. J08may nowproceed.

2026-11-03 J08 started original task_a2e85a8d9688 / ctx_5770e920dbb1 in proven user-selected Gemini terminal, following accepted gate813. Self-contained detailed integration supplement sent before edits, references accepted J07 SENIOR report/hash (juniorFAILED handoff is historical). Ownership hook/banner/tests/minimalApp+Modal; no coordinator/native/cache/scheduler edits. Full independent S2 remains after J08.

2026-11-03 J08 ctx_5770e920dbb1 closed FAILED atcoordinator request for cleancontextcontinuation (716K accumulatedhistory; partialbanner/tests/App/Modal andinitialhookrefs preserved). [Partial report](IOS_PLAYBACK_J08_REPORT.md) is handoffonly, notfeatureacceptance. Root verified10/10protected dependencyhashes, copied6ownedfiles/report to first-pass-preserved, acceptedfailedsettlement/released/acked. Idle sameOpenCode chat reset via/new (same verified Antigravity Gemini), originalTask retry ctx_67d409a133fd ready with short selfcontained continuationbrief andrealCoordinator integration requirement. No liveprocessstop/restart/providerchange or productrollback, no duplicateeditor.
