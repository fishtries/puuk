# J01 — диагностика воспроизведения iOS

Дата: 2026-10-30. Задача: `task_ce2cbd63ebe5`, dispatch `ctx_f1c1294303aa`, Run `run_5c86d4feea71`.
Владелец: Junior DeepSeek. Владение по факту: этот отчёт + `/tmp/puuk-playback/J01/` (read-only диагностика).

Статус: **диагностика по коду и SDK выполнена; device evidence отсутствует → все device-строки `not tested`.** Продуктовый код не изменён. Измерений с iPhone нет; ни одно значение в отчёте не выдаётся за замер на устройстве.

---

## 1. Исходная точка и владение

- HEAD репозитория: `671be2ff8bf2d89a1bc11766d18f62b4faebe5a5`. HEAD не описывает рабочее дерево (много dirty-изменений), поэтому источником правды принят снимок файлов, зафиксированный в S0.
- Сверка фактических файлов с `docs/IOS_PLAYBACK_S0_REPORT.md` / `/tmp/puuk-playback/S0/manifest.json`: **все 12 релевантных продуктовых файлов совпадают по SHA-256** (см. `manifest.json` и раздел 2). Значит выводы ниже относятся к тому же состоянию, что S0.
- Сохранены все dirty/untracked изменения. Не выполнялись: `reset`, `clean`, commit/push, deploy, рестарт сервисов, изменение оригинального аудио.
- Временная Jest-обвязка создавалась только для диагностики в `app/ios/puuk-ios/.j01tmp/`, копии сохранены в `/tmp/puuk-playback/J01/`, каталог в репозитории **удалён** (ничего заранее существовавшего не удалялось; `git status` после удаления не содержит `.j01tmp`). Новых тестов в продуктовом дереве не оставлено.
- Экспорт/сборка iOS не выполнялись (нет `xcodebuild`/`xcrun`), build ID приложения: **unknown**.

### Среда

| Инструмент | Значение |
|---|---|
| OS | Linux |
| node / npm | v26.12.0 / 12.2.1 |
| expo / expo-audio / expo-file-system | 58.0.19 / 58.0.10 / 58.0.11 |
| xcodebuild / xcrun | отсутствуют |
| `idevice_id -l` | `ERROR: Unable to retrieve device list!`, exit 255 (`/tmp/puuk-playback/J01/device-list.txt`) |
| backend `192.168.1.117:8000/api/health` | connect failed, exit 7 |
| backend `192.168.1.117:59348/api/health` | `HTTP/0.9` protocol error, exit 1 (порт 59348 — SSH, не HTTP health) |

Следствие: серверная проверка endpoint из этой машины недоступна; транспорт делегирован J02. Все наблюдения о сети/SDK в отчёте — **code/SDK-level**, не сетевые замеры.

---

## 2. SHA-256 фактических источников

Полный список — `/tmp/puuk-playback/J01/manifest.json`.

| Файл | SHA-256 (snapshot) | Совпадает с S0 |
|---|---|---|
| `app/ios/puuk-ios/utils/playbackCoordinator.js` | `13bf73b56db900bd733d5bc03f29f50f5f71bad644790ba694cb21851b5c29d5` | да |
| `app/ios/puuk-ios/utils/audioCache.js` | `ba5b9065822602d1d4ed215ac1349dcea9d1634408d76f593a9cc499cd77c90e` | да |
| `app/ios/puuk-ios/utils/preloadScheduler.js` | `2ea48fecb804fb18c790e83bf0e745324c46df9cdee372f31e61e9cad3f1f6b0` | да |
| `app/ios/puuk-ios/utils/networkPolicy.js` | `985cdf70b1a9a8f7942c9a52097ca994ae6b5b8f23eac80c5a9364e40f0665e6` | да |
| `app/ios/puuk-ios/utils/streamUrl.js` | `38e7bdd9312cd98679fca42d20498033aa421eecae6f7c3d2c006dfde352ad44` | да |
| `app/ios/puuk-ios/hooks/usePlayerController.js` | `9b78d09b50b4a0ad80b6cdec5ca1d82ee6439b8d30233aabadd0fa7e3b8a9b7e` | да |
| `app/ios/puuk-ios/App.js` | `c0dd89903c957b157ff0579fd4ed833a4394d2dcb6137405505d075d6cb6b7b5` | да |
| `app/ios/puuk-ios/components/FullPlayerModal.js` | `c32d4539b49d065feb3fb2245d93eaf161c686a1ec1659e11dd091f2dc76f589` | да |
| `app/ios/puuk-ios/scripts/patch-expo-audio.js` | `1603cc8a30d954f0a1ade5b07d38eb0d6b0f37b796f6cf24a7a9de448daaf05f` | да |
| `app/ios/puuk-ios/package.json` | `08c89f2445cc1f1f94c642634dcead08333b7f46c06c676ed6b6c9e4f858d3a5` | да |
| `app/ios/puuk-ios/package-lock.json` | `ce053ceebfa85250e4a0008e9f8508faa71624fe2375674fd00b587b96d75bcd` | да |
| `components/fullplayer/PlayerNetworkBanner.js` | `e333b15a7f59f7d83964d4a6e1b9eb0bb1272b37de5001281cb9c65e19273f47` | (не было в S0; зафиксирован здесь) |

Установленный SDK (владелец — J03, здесь только как источник контракта событий):

| Файл | SHA-256 |
|---|---|
| `node_modules/expo-audio/build/AudioModule.types.d.ts` | `8608cfda9af840c20c55aa2888f0571e961b28b7eb27789c683a6999f05130b9` |
| `node_modules/expo-audio/build/Audio.types.d.ts` | `6dbbc758888c4b696573c2c5673d2b7d30a7ebace1e303b120f9717c20241af7` |
| `node_modules/expo-audio/build/AudioEventKeys.d.ts` | `3c63ac7bf147525c503efc262d61088c17fd8cc375c266e3c57e2c5d3cb73dd8` |
| `node_modules/expo-audio/ios/AudioPlayer.swift` | `a36e2f1a316813a08e7d3654c3aa7a0528ecb0a071c9529f6afa37a0ae57dba2` |
| `node_modules/expo-audio/ios/AudioModule.swift` | `ae5c533a428b9f825f2fc9e7de6d60fe6ff21951fc116431cdb85edd43a04ca5` |

---

## 3. SDK-контракт, на который опираются выводы

Прочитаны versioned-доки Expo SDK 58 ([Audio](https://docs.expo.dev/versions/v58.0.0/sdk/audio/), [FileSystem](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/)) и сверены с установленным source (SHA выше).

1. `AudioPlayer` — только `SharedObject<AudioEvents>` с событиями `playbackStatusUpdate(AudioStatus)` и `audioSampleUpdate`. **Отдельного события `error` нет.**
2. `AudioStatus` содержит: `id` (id *player*, не source), `playing`, `isLoaded`, `isBuffering`, `currentTime`, `duration`, `didJustFinish`, `playbackState`, `timeControlStatus`, `reasonForWaitingToPlay`, `error: string | null`, `mediaServicesDidReset?`. **Поля URI/source нет.**
3. Native (`AudioPlayer.swift:262-266`): `error` заполняется `currentItem?.error?.localizedDescription` при переходе `AVPlayerItem.status == .failed`, иначе `currentStatus()` возвращает `"error": nil`. HTTP-статуса в тексте нет.
4. `replace(source)` / `play()` в JS — синхронные void-вызовы. `replaceCurrentSource` (`AudioPlayer.swift:305-330`) сначала `ref.pause()`, затем новый item и, если играло, `onReady { play }`. То есть успешный `replace()` не означает ни загрузку, ни звук; повторный `play()` **после** replace может «дожать» воспроизведение.
5. Native не эмитит completion для `play()`; `replace()` возвращает управление сразу после `AVPlayerItem`-создания (`AudioUtils.createAVPlayerItem`). Готовность приходит только позже как `playbackStatusUpdate` с `isLoaded:true`.
6. `nextTrack`/`previousTrack` — не типизированные `AudioEvents`, а native-emit, добавленный проектом в `MediaController.swift` (см. `patch-expo-audio.js`). J03 владеет native-audit; здесь они отмечены как существующий канал.

Следствие для J01: единственный законный сигнал «звук/готовность/ошибка» — `playbackStatusUpdate`. Его уникализирует `id` player-а, **не** source. Поэтому ключ `(player.id)` недостаточен для привязки статуса к источнику (инвариант 2/3 плана).

---

## 4. Как устроен сегодняшний путь (факты из кода)

**Hook** (`hooks/usePlayerController.js`):
- `player = useAudioPlayer(null, { keepAudioSessionActive: true })`, `status = useAudioPlayerStatus(player)` (строки 162–165).
- `status` используется для: `isPlaying`, `currentTime`, `duration`, `status.isBuffering` → `handleBufferingStatus` (543–547), `status.didJustFinish` → `fetchNextTrack` (937–941). **Ни `status.error`, ни `status.isLoaded`, ни `status.playbackState`/`timeControlStatus` не читаются.**
- `loadAndPlay` (693–746) вызывает `coordinator.play(player, track, {headers, getHeadersAsync, soundCheck})` и при `result?.uri && !result.error && !result.superseded` помечает `loadedPlayback` как «старт». Это факт вызова команды, не подтверждение звука.
- `recordPlayStart` (202–216) срабатывает по `isPlaying && loadedPlayback` — это уже ближе к подтверждённому прогрессу, но в аналитику, не в recovery.
- `retryPreload` (1204–1210) вызывает только `coordinator.updateQueue(currentTrack, upNextQueue, {headers})` — **не** перезапускает текущий источник.
- Очередь синхронизируется с координатором в `useEffect` по `[currentTrack, upNextQueue]` (550–569).

**Coordinator** (`utils/playbackCoordinator.js`):
- `play()` (256–620): normalize URL → `cache.getCachedUri` → local `replace` (с fallback на remote при throw) или remote `replace` (с одним повтором `replace`) → `player.play()` → lock screen. Успех = обе команды не бросили исключение. **Нет watchdog, нет ожидания loaded/progress, нет обработки `status.error`.**
- Публичное API событий: `handleBufferingStatus(bool)`, `updateQueue(...)`, `subscribe`. **Нет метода, принимающего `AudioStatus`.** `handleProgress`/`handleLoaded`/`handleError` отсутствуют.
- `handleBufferingStatus(true)` через 3500 мс ставит `networkStatus='slow'`; ничего не восстанавливает (678–701).
- `_performReplace` (200–239): при устаревшем завершении, если генерация выросла, повторно `replace(currentSource)` **и безусловно `player.play()`**. Не сохраняются pause/seek.
- Background cache текущего трека: `setTimeout(5000)` → `cache.getOrFetch(trackId, url, {headers})` (519–547). Фоновые загрузки scheduling-а и этот прямой путь **не** объединены в общий лимит.

**AudioCache** (`utils/audioCache.js`):
- `getCachedUri` проверяет: `file://`, не `.part`/`.temp`, `exists`, `size > 0`. Содержимое/декодируемость не проверяются (94–188).
- `_downloadWithRetry` (461–506) повторяет **любую** ошибку (кроме отмены), без классификации transient/permanent; `DOWNLOAD_TIMEOUT_MS = 45000` на попытку, `RETRY_DELAYS_MS = [800,2000]`. Максимум ≈ 3×45 с + 2.8 с, общего бюджета нет.
- Инвалидации «конкретной сломанной копии» по ошибке воспроизведения нет: `remove()` вызывается только вручную/через `clear`.

**PreloadScheduler** (`utils/preloadScheduler.js`):
- Приоритеты urgent(0)/next(1)/next-next(2), `maxConcurrent` (default 2), `lookahead` (default 2), сужение сетевой политикой (`networkPolicy.js`: Wi-Fi {2,2}, Cellular/Unknown {1,1}).
- Grace-cancel устаревших задач 3000 мс, `staleSyncLimit = 2`.
- **Нет** понятия startup/stall/recovery и уступки полосы воспроизведению: во время буферизации/восстановления текущего трека слоты не освобождаются.
- `serverUrl` фиксируется в конструкторе из импортированного `SERVER_URL` (44–50); singleton создаётся при импорте модуля.

**App.js bootstrap** (585–615): `loadSettings()` → `setServerUrl(s.serverUrl)` уже **после** импорта модулей, т.е. после создания singleton-координатора и scheduler-а; затем `defaultAudioCache.init()`.

---

## 5. Матрица «наблюдение → доказательство → гипотеза → проверка»

Столбец «Доказательство» различает **code/SDK fact**, **Jest-наблюдение** (in-Jest, не устройство) и **device evidence (нет)**. «Гипотеза» — что это может вызывать у пользователя. «Проверка» — как доказать/опровергнуть.

| № | Наблюдение | Доказательство | Гипотеза | Проверка |
|---|---|---|---|---|
| N1 | `play()` считает успехом завершение `replace()`+`play()`, не дожидаясь `isLoaded`/первого progress | code: `playbackCoordinator.js:563-620`; SDK: `replace` void, `AudioPlayer.swift:305-330`; Jest: `hypothesis.test.js` H1, `e2e.test.js` E2E-cached/uncached — `play()` разрешается без единого `AudioStatus` | Пользователь видит «играет/загружено», а звука нет (тихий завис) | J07: ввести startup deadline 15 с от запроса до `isLoaded&&playing` подтверждения; device-лог `playbackStatusUpdate` |
| N2 | Нет обработки поздней ошибки нативной загрузки | code: hook не читает `status.error` (нет в `usePlayerController.js`), у coordinator нет приёмника статуса; Jest: `e2e.test.js` E2E-late-error, `observe.test.js` Scenario B late-error | Поздний `.failed` (`localizedDescription`) не виден → нет recovery, пользователь видит вечный «загрузка» | J07/J08: подписаться на `playbackStatusUpdate`, ошибку с source attempt привязывать в coordinator |
| N3 | Буферизация >3.5 с только меняет статус на «slow» | code: `playbackCoordinator.js:678-701`; Jest: `hypothesis.test.js` H3, `observe.test.js` Scenario B — после 30 с таймера ошибки/recovery нет | Зависший текущий трек не восстанавливается, лишь бейдж «kinda slow» (`TrackLoadingBadge.js`) | J07: stall/no-progress deadline 10 с → ограниченный recovery; расширить телеком по no-progress |
| N4 | «Повторить» не перезапускает текущий источник | code: `usePlayerController.js:1204-1210`; Jest: `hyp2.test.js` — `retryPreload` содержит только `updateQueue`, не `play()`; `PlayerNetworkBanner` подключён `onRetry={onRetryPreload}` (`FullPlayerModal.js:1421`) | Кнопка в баннере чинит только следующий трек; текущий сломанный остаётся | J08: `retryPreload` → recovery текущего источника; разделить current/preload error state |
| N5 | Сломанная локальная копия не инвалидируется адресно | code: `play()` при throw на local `replace` делает fallback, но `cache.remove` не вызывает (`playbackCoordinator.js:404-431`); Jest: `e2e.test.js` E2E-network-flap, `observe.test.js` Scenario B — повторный `getCachedUri('20')` возвращает тот же URI | Повторный выбор того же трека снова берёт битый файл → повторный сбой | J04: адресная инвалидация `(trackId, uri, generation)`; remote fallback |
| N6 | Повторяются все ошибки cache, 45 с на попытку, общего бюджета нет | code: `audioCache.js:14-15,461-506` — фильтра статуса/типа нет; Jest: `audit.test.js` A2 | 401/403/404 циклично повторяются; медленная полезная загрузка перезапускается с нуля; суммарно ≈138 с > startup-бюджета | J04: transient-only retry, inactivity 20 с / total 180 с, 800/2000 мс |
| N7 | Scheduler не уступает полосу воспроизведению | code: `preloadScheduler.js` не содержит startup/stall/yield; Jest: `audit.test.js` A3; фоновый cache-current идёт мимо лимита (`playbackCoordinator.js:519-547`) | На медленной сети speculative downloads конкурируют с текущим потоком → старт дольше/буферизация | J05: единый лимит + пауза фоновых на startup/stall; измерить на устройстве |
| N8 | Singleton фиксирует `SERVER_URL` при импорте | code: `playbackCoordinator.js:139`, `preloadScheduler.js:45`; `App.js:590` применяет настройки позже; Jest: `audit.test.js` A1 | При custom server каталог/плеер и preload могут ходить на разные хосты до/после смены | J06: resolve URL при создании нового источника; integration test «настройки после импорта» |
| N9 | Stale replace repair безусловно `play()` | code: `playbackCoordinator.js:207-235`; Jest: `stale.test.js` R1 — после пользовательского `pause` repair вызывает `play()` | Автовоспроизведение после паузы/ухода, скачок позиции | J07: repair сохраняет pause/seek/intent; проверка A/B/A + pause-during-load |
| N10 | Native завершает background task сразу после `playImmediately()` | code: `AudioPlayer.swift:135-148` (`endBackgroundTaskIfNeeded()` сразу после `playImmediately`), `beginBackgroundTaskIfNeeded` — 508, 387/402; патч присутствует в установленном source | Переход завершается до подтверждённого старта звука в фоне (lock screen next) | J03/S2: решить, нужна ли правка до `isLoaded`; device lock-screen тест |
| N11 | Native status не несёт source identity (только `player.id`) | SDK: `AudioStatus.id` = player id; emit в `AudioPlayer.swift:208` не добавляет URI; Jest: `audit.test.js` A4 | Поздняя ошибка A после выбора B/A→B→A неотличима → recovery бьёт не тот источник | J03/S1N: минимальная source identity в event; A/B/A контракт |
| N12 | Native error без HTTP-статуса | code: `AudioPlayer.swift:262-266`; Jest: `audit.test.js` A5 | 401/404 не отличимы от декод-ошибки на уровне native; нельзя строить auth-retry по тексту | J04/J08: классификация только по структурированным данным; не выводить logout из текста |
| N13 | `mediaServicesDidReset` и interruption отрабатываются нативно | code: `AudioModule.swift` `handleMediaServicesReset`, `resumeInterruptedPlayers`; SDK: `AudioStatus.mediaServicesDidReset?` | JS не видит, что был reset/перезапуск → «скачок» позиции объясняется молча (low) | device: логировать `mediaServicesDidReset`, interruption |
| N14 | `recordPlayStart`/history завязаны на `isPlaying`, не на retry | code: `usePlayerController.js:202-216`, `470-511`, `863-885` | Технический retry может дублировать play-start/history | J08: сверить при вводе recovery |

---

## 6. Сценарии (A: удачный, B: проблемный) и приёмочная матрица J01

Ниже — сценарии из приёмки J01. Колонки «In-Jest наблюдение» взяты из временной обвязки (см. раздел 8) и **не являются** device-замерами. Строки устройства помечены `not tested` — iPhone недоступен.

| Сценарий | Ожидание | In-Jest / code-наблюдение | Device |
|---|---|---|---|
| A. Удачный запуск, трек не в кэше | remote `replace` → `play`, фон cache через 5 с | `observe.test.js` Scenario A: события `replace`→`play`; по fake-timers `getOrFetch` не вызван до 5000 мс, вызван на 5000 мс; `play()` разрешился **до** любого status — то есть time-to-play() ≠ time-to-audio. `passed` (in-Jest) | not tested |
| A2. Удачный запуск, трек в кэше | local file, без сетевого ожидания | `e2e.test.js` E2E-cached: `isLocal=true`, `replace({uri: file://…})`, время < 50 мс на mock (не устройство). `passed` (in-Jest) | not tested |
| B1. Сломанный cached source | адресная инвалидация + remote fallback | `observe.test.js` Scenario B, `e2e.test.js` E2E-network-flap: fallback на remote происходит (`isLocal=false`), но битый manifest не инвалидируется. Это соответствует N5 — **failed by design**, не регрессия J01. | not tested |
| B2. Поздняя ошибка после успешного `play()` | recovery или terminal error | `e2e.test.js` E2E-late-error, `observe.test.js` Scenario B: через 30 с ошибки/recovery нет, `networkError=null`. **failed** (ожидаемо до J07) | not tested |
| C. Cold start, сохранённый custom endpoint | каталог/stream/preload используют сохранённый сервер | code: `App.js:590` `setServerUrl` после импорта singleton (N8). Прямого runtime-теста на устройстве нет. **not tested** | not tested |
| D. Быстрый A→B→A | звук/метаданные последнего выбора | `e2e.test.js` E2E-A/B/A: p1 и p2 → `superseded`, p3 фиксирует `currentPlayUri` для A. `passed` (in-Jest) | not tested |
| E. Медленная сеть | старт не ждёт полной загрузки, фоновые уступают | `e2e.test.js` E2E-slow-network: при управляемой задержке `replace` 15 с play() не разрешается и стартового deadline не наступает (N1/N3). `failed` по отсутствию deadline; реальные задержки **не измерялись** | not tested |
| F. Смена Wi-Fi/LTE | корректный outcome, сохранение intent/позиции | code: `networkPolicy.js` сужает лимиты, `_onNetworkPolicyChanged` пересинхронизирует; **устройства нет** → `not tested` | not tested |
| G. Lock screen (next/prev, 5 переходов) | переход подтверждён в фоне | code: `patch-expo-audio.js` (nextTrack/previousTrack + background task), N10. **not tested** | not tested |
| H. Пауза/seek во время загрузки/recovery | нет autoplay и скачка на 0 | `stale.test.js` R1: repair после pause вызывает `play()` → autoplay. **failed** (ожидаемо до J07, N9) | not tested |
| I. 10 быстрых skip | ограниченные фоновые задачи | code: scheduler grace-cancel `staleSyncLimit=2` + `cancelAll`; in-Jest покрытие частично в существующем suite. Полный лимит с cache-current не объединён (N7). **not tested** на устройстве | not tested |
| J. 401/404/5xx через тестовую среду | различимая ошибка, допустимые повторы | code: native status без HTTP-кода (N12); cache ретраит всё (N6). **not tested** (нет тестовой среды и устройства) | not tested |

Итог приёмки J01: **A (happy-path структура), A2, D — `passed` (только in-Jest/структурный уровень); B1, B2, E, H — `failed` как зафиксированные пробелы, ожидающие J04/J05/J07; C, F, G, I, J — `not tested` (нет iPhone/тестовой сети).** Ни одна строка не претендует на device-результат.

---

## 7. Предлагаемая минимальная телеметрия (для J07/J08; безопасная и ограниченная)

Цель: получить доказательства без секретов, без лавины событий, с привязкой к source attempt.

### 7.1 Поля записи (одна запись = одна фаза/событие)

| Поле | Источник | Заметка |
|---|---|---|
| `requestId` | hook, монотонный `++playbackRequestRef` (уже есть) | ключ пользовательского намерения |
| `attemptId` | coordinator, `playbackGeneration` (уже есть) | ключ попытки/источника |
| `trackId` | `getTrackId(track)` | без названий |
| `source` | `'local'|'remote'` | из ветки `play()` |
| `uriKind` | `'file'|'http'` — **не URL** | URL не логировать целиком (query) |
| `phase` | `select|replace_requested|replace_returned|play_called|loaded|first_progress|buffering|stall|error|terminal` | монотонная фаза |
| `tMonoMs` | `performance.now()` (монотонный) | не wall-clock для длительностей |
| `posS` | `status.currentTime` из `playbackStatusUpdate` | только при events |
| `durS` | `status.duration` | |
| `intent` | `'play'|'pause'|'seek'|'dismiss'|'logout'` | пользовательское намерение на момент события |
| `appState` | foreground/background (AppState) | |
| `netType` | из `networkPolicy` (`wifi/cellular/unknown`) | без SSID/IP |
| `bgTasks` | scheduler.activeTasks.size + cache.ongoingDownloads.size | ограниченное число |
| `nativeErrorClass` | короткая категория из `status.error` (см. ниже) | без сырого текста |
| `httpStatus` | только если есть структурированное поле (сейчас нет) | сегодня `unknown` |

### 7.2 Правила

- Никаких URL, query (`token`/`mt`), `Authorization`, JWT, user id, email, названий треков. `trackId` — достаточно для корреляции в отчёте.
- `nativeErrorClass`: маппинг по префиксам `AVFoundation`/`NSURLError`/`-11800`/`-1009` без сохранения полного текста; неизвестное → `other`. Сырой `localizedDescription` не сохраняется, только класс и `length`.
- Ограничение объёма: ring-buffer на N=200 записей на сессию, запись только на смене `phase` или раз в T=1000 мс для `first_progress`/`stall` (не на каждый `currentTime` tick 500 мс).
- Только `__DEV__`/`debug`-флаг (как существующие `_log/_warn` в coordinator). В production-сборке телеметрия выключена или отправляется только агрегат (counts/medians) на локальный debug-endpoint.
- Запись выводится через существующий `_log(debug)` + опциональный in-memory массив, доступный для копирования из debug UI.

### 7.3 Точки вставки (файлы/символы), чтобы J07/J08 не придумывали заново

| Фаза | Где |
|---|---|
| `select`, `replace_requested`, `replace_returned`, `play_called` | `playbackCoordinator.play()` (256–620) и `_performReplace` (200–239) |
| `loaded`, `first_progress`, `buffering`, `stall`, `error` (native) | новый consumer `playbackStatusUpdate` в `usePlayerController` возле 543–547 / 937–941; передавать в coordinator (новый метод, напр. `handleNativeStatus(attemptId, status)`) |
| `intent` | `togglePlayPause` (943–953), `dismissPlayer` (1133–1170), `seekTo` в UI, `resetAuthScopedState` (232–257) |
| `terminal` | момент, когда coordinator решает прекратить recovery |
| `bgTasks` | `preloadScheduler.activeTasks`, `audioCache.ongoingDownloads` |

Эти точки совпадают с ownership J07 (`utils/playbackCoordinator.js`) и J08 (`hooks/usePlayerController.js`, `PlayerNetworkBanner.js`) — телеметрия добавляется ими, не J01.

---

## 8. Команды, cwd, exit, время (и что это доказывает)

Всё ниже — **in-Jest**; JSX/устройство не участвует. Исключения из подтверждения звука нет: Jest видит только JS.

| # | Команда | cwd | exit | UTC start→end / длительность | Результат |
|---|---|---|---|---|---|
| 1 | `npm test -- --runInBand utils/__tests__/audioCache.test.js utils/__tests__/preloadScheduler.test.js utils/__tests__/networkPolicy.test.js utils/__tests__/streamUrl.test.js utils/__tests__/playbackCoordinator.test.js hooks/__tests__/usePlayerController.test.js` | `/home/fish/projects/puuk/app/ios/puuk-ios` | 0 | 17:14:49.096 → 17:14:51.704, 2606 мс | `passed`, **6 suites / 164 tests** (S0 для 7 файлов дал 167; здесь набор без PlayerNetworkBanner — 6 файлов, 164 теста, расхождение объяснимо другим набором файлов) |
| 2 | `npx jest --runInBand --testMatch '**/.j01tmp/*.test.js'` (диагностическая обвязка J01) | `/home/fish/projects/puuk/app/ios/puuk-ios` | 0 | 17:17:55.269 → 17:17:56.656, 1385 мс | `passed`, 6 suites / 23 tests (наблюдения N1/N3/N5/N7/N9/N11/N12 и A/B/A, A, A2, late-error, slow-network) |
| 3 | `idevice_id -l` | `/tmp/puuk-playback/J01` | 255 | 17:13:08 | `ERROR: Unable to retrieve device list!` → **not tested** |
| 4 | `curl .../8000/api/health` / `.../59348/api/health` | `/tmp/puuk-playback/J01` | 7 / 1 | 17:14:56 | сервер недоступен из этой машины |

Артефакты: `jest-targeted.log`/`jest-targeted.json`, `jest-j01-harness.log`/`jest-j01-harness.json`, `network-probe.log`, `device-list.txt`, `manifest.json`, копии обвязки `*.test.js` + `README.md` с командой повторного запуска. Запуск #2 — временная обвязка; она **не** является gate и в продуктовом suite оставлена не была.

**Не выполнялось:** `npm test` полный suite, `npx expo export`, `eslint`, сборка iOS, device-прогон — вне рамок J01 и/или недоступны (нет xcodebuild/device). `retryPreload`-регрессия для J08 не создавалась (owner — J08).

---

## 9. Ограничения и открытые вопросы

Ограничения:
- Устройства нет: нет доказательств слышимости, реальных time-to-first-audio, lock screen, Wi-Fi↔LTE, background task, Bluetooth/interruption. Всё device = `not tested`.
- Нет серверного endpoint с этой машины → транспортные гипотезы не проверялись здесь (J02).
- in-Jest mock-и `player.replace/play` синхронны; реальные native-timings (AVFoundation stall, DNS/TLS, декод) не моделируются. Значения «2606 мс» и «1385 мс» — время выполнения Jest, **не** задержки аудио.
- Native patch присутствует в установленном source (`beginBackgroundTaskIfNeeded`, `queuePlayer.removeAllItems`), но «source patch applied» ≠ «в собранном binary» — подтверждение версии в binary остаётся J03/S2.

Открытые вопросы (для S1/Gate A):
1. Source identity: достаточно ли пары `(player.id, attemptId)`, или нужна правка native emit (`sourceId` в payload) до разрешения automatic recovery (N11)? J01 склоняется к тому, что текущей идентичности **недостаточно**.
2. Значения бюджетов: startup 15 с / stall 10 с / recovery 800 мс / total 30 с (план §4), cache inactivity 20 с / total 180 с / 3 попытки — подтвердить или изменить на Gate A. J01 не выбирает цифры.
3. Нужна ли адресная инвалидация локальной копии по `status.error` (N5), и в каком слое: cache (J04) или coordinator (J07)? J01 предлагает ключ `(trackId, uri, generation)`.
4. Считать ли «stall» по `isBuffering && currentTime не растёт» или по `timeControlStatus/reasonForWaitingToPlay` — оба поля есть в `AudioStatus`, но поведение на устройстве не проверено.
5. `mediaServicesDidReset` (N13) — должен ли он входить в recovery или полностью доверять нативному восстановлению.

---

## 10. Соответствие инвариантам §4 (что J01 уже локализует)

| Инвариант | Наблюдение J01 |
|---|---|
| 1 (команда ≠ загрузка ≠ звук) | подтверждён пробел: N1 |
| 2 (событие привязано к source/request) | подтверждён пробел: N11 |
| 3 (player id ≠ source id) | подтверждено SDK: N11 |
| 4 (единственный владелец recovery — coordinator) | сейчас recovery-владельца нет вовсе; hook и coordinator не дублируют, т.к. оба молчат |
| 5 (pause/dismiss/logout ⇒ запрет autoplay) | подтверждён опасный путь: N9 (`stale.test.js` R1) |
| 6 (адресная инвалидация копии) | подтверждён пробел: N5 |
| 7 (текущий поток приоритетнее фона) | подтверждён пробел: N7 |
| 8 (раздельные ошибки current/next) | подтверждён пробел: общий `networkError` в coordinator `updateQueue` (656) и в баннере |
| 9 (401/403 без циклического retry; 404 отдельно) | подтверждён пробел: N6/N12 |
| 10 (история/play-start без дублей от retry) | не проверено на устройстве (N14), риск отмечен |

---

## 11. Что остаётся сделать (передача дальше)

- **S1/Gate A**: принять эти наблюдения, зафиксировать source identity (N11), значения бюджетов и контракт событий.
- **J03**: подтвердить контракт native (версия патча в binary, background task lifecycle, возможно source id).
- **J04/J05/J07/J08**: реализовать по контракту; J01 не трогает продуктовый код.
- **J09**: прогнать сценарии раздела 6 на физическом iPhone с идентифицированным build и собрать телеметрию раздела 7.

Ничего в этом отчёте не помечено как device `passed`. Итог J01 — диагностика и спецификация, а не исправление.
