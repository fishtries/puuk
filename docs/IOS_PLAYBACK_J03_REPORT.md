# J03 — native audit и привязка событий к источнику

Дата: 2026-10-30. Задача: `task_26e55b10d94d`. Тип: read-only диагностика.
Артефакты: `/tmp/puuk-playback/J03/` (`commands.jsonl`, `native-hashes.txt`, `js-sdk-hashes.txt`,
`product-hashes.txt`, `patch-idempotency.txt`, `native-hashes-after-patch-run.txt`,
`static-analysis.json`, `static_analysis.py`, `versions.txt`, `npm-ls.txt`, `git-status.txt`, `head.txt`).

Статус строк: **passed** — проверено в этом окружении; **failed** — проверено и противоречит
ожидаемому; **not tested** — нет нужного окружения/устройства.

## 0. Исходная точка и окружение

| Факт | Значение |
|---|---|
| cwd всех команд | `/home/fish/projects/puuk/app/ios/puuk-ios` (кроме git-команд с `-C /home/fish/projects/puuk`) |
| Git HEAD | `671be2ff8bf2d89a1bc11766d18f62b4faebe5a5` (как в S0) |
| Рабочее дерево | 164 строки `git status --porcelain` (`git-status.txt`), совпадает по составу с S0; ничего не изменено/сброшено |
| expo / expo-audio / expo-file-system | 58.0.19 / 58.0.10 / 58.0.11 (`versions.txt`, `npm-ls.txt`) |
| node / npm | v26.12.0 / 12.2.1 |
| xcodebuild / xcrun / swiftc | отсутствуют (`which` → exit 3; S0 `environment.json` тоже null) |
| iPhone / debug-приложение | недоступны; `.expo/devices.json` = `{"devices":[]}` |
| Build ID установленного на телефоне binary | **unknown** (устройства нет) |
| Установленный `node_modules/expo-audio` | 58.0.10, версия совпадает с registry-пакетом и lockfile (`npm ls` exit 0) |

Версионированные Expo 58 Audio/FileSystem-доки проверены координатором через web-инструмент и
сохранены в `/tmp/puuk-playback/S0/sdk58-docs.md`; оттуда цитируем:
`https://docs.expo.dev/versions/v58.0.0/sdk/audio/` (строки 1159–1177: `replace(source)` возвращает
`void`, т.е. возврат команды не доказывает готовность; строки 582–602: `useAudioPlayerStatus`
отдаёт position/loading/playing) и
`https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/` (строки 1274–1305, 776–795, 2662–2680:
`File.createDownloadTask` не запускает загрузку, `downloadAsync` запускает; `onProgress` получает
`bytesWritten,totalBytes`; подписку снимает `EventSubscription`; callbacks живут только пока живёт
исходный JS runtime). Доки подтверждают `replace() → void`; **формы emitted-полей, ошибок и
item-observers доки не гарантируют** — они сняты из установленного Swift (§3). Прямой fetch с
этого хоста — **failed** (`webfetch` transport error ×2, `curl` exit 28 за 45.001 с и exit 35 TLS
EOF за 15.105 с, `urllib` SSL EOF, http→403); это ограничение доступа, а не отсутствие контракта.
Код iOS не писался, runtime не проверялся.

## 1. Source hashes (SHA-256)

Установленные native-исходники (`native-hashes.txt`):

```
a36e2f1a316813a08e7d3654c3aa7a0528ecb0a071c9529f6afa37a0ae57dba2  node_modules/expo-audio/ios/AudioPlayer.swift
ae5c533a428b9f825f2fc9e7de6d60fe6ff21951fc116431cdb85edd43a04ca5  node_modules/expo-audio/ios/AudioModule.swift
a01ec1da20d578ef5055d6ecb0d6f847239449a5773da82e859edef2b79469fb  node_modules/expo-audio/ios/MediaController.swift
8240462a8aa0b1d5db765e6346557de2cf0e984fc3298567cc159ab7f229a5a0  node_modules/expo-audio/ios/AudioComponentRegistry.swift
7488c7cc261b9eed2e797f193fd5ed63f4676b74f397503322462a8f45c66d01  node_modules/expo-audio/ios/AudioUtils.swift
56524ad4a486a37d3e494d0f06d8c637a98f4d15fb3a0cfb2c94a1d9c54cceb5  node_modules/expo-audio/ios/AudioPlaylist.swift
1603cc8a30d954f0a1ade5b07d38eb0d6b0f37b796f6cf24a7a9de448daaf05f  scripts/patch-expo-audio.js
32ee00d660a7185ae238aa7ff4ffbc7bb175574cbd20c0704ce14a059415cba9  node_modules/expo-audio/package.json
08c89f2445cc1f1f94c642634dcead08333b7f46c06c676ed6b6c9e4f858d3a5  package.json
ce053ceebfa85250e4a0008e9f8508faa71624fe2375674fd00b587b96d75bcd  package-lock.json
2d9647b0f3449a2d219cc0a3c381390a61f77fcee66252f13bc248730950dc5c  app.json
9b6965165da103bedab4a0037760dcb264b85d18cb6380fe05528383ed9c8c49  eas.json
cc71ab383168ae6a8c2958bd4aa4687cdb26f9f7ed2ffc97a34222f6d53f5612  ios/Podfile
2a0b0e04f58d5533fd77340f043f715d618f8d2fa2e769f8176090668d4d912c  ios/Puuk/Info.plist
8b88c4f2d65206464d825a8e702ae7294a87e95fcd54d98e6d1995bc1892396f  node_modules/expo-audio/ios/ExpoAudio.podspec
```

Product JS (read-only, dirty-состояние зафиксировано, `product-hashes.txt`):

```
13bf73b56db900bd733d5bc03f29f50f5f71bad644790ba694cb21851b5c29d5  utils/playbackCoordinator.js
9b78d09b50b4a0ad80b6cdec5ca1d82ee6439b8d30233aabadd0fa7e3b8a9b7e  hooks/usePlayerController.js
ba5b9065822602d1d4ed215ac1349dcea9d1634408d76f593a9cc499cd77c90e  utils/audioCache.js
2ea48fecb804fb18c790e83bf0e745324c46df9cdee372f31e61e9cad3f1f6b0  utils/preloadScheduler.js
38e7bdd9312cd98679fca42d20498033aa421eecae6f7c3d2c006dfde352ad44  utils/streamUrl.js
985cdf70b1a9a8f7942c9a52097ca994ae6b5b8f23eac80c5a9364e40f0665e6  utils/networkPolicy.js
c0dd89903c957b157ff0579fd4ed833a4394d2dcb6137405505d075d6cb6b7b5  App.js
```

JS SDK (`js-sdk-hashes.txt`) и прочие файлы — в артефактах. `dist/` — только web-export
(`metadata.json`, `_expo/static/js/ios/index-…hbc` без web/ios runtime-доказательства сборки),
не является iOS binary; build ID из него не выводится.

## 2. Происхождение установленного binary — proof vs unknown

| Утверждение | Доказательство | Статус |
|---|---|---|
| Установленный `node_modules/expo-audio` — официальный 58.0.10 | `package.json` + `npm ls` без overrides/integrity-ошибок | passed (source-level) |
| `scripts/patch-expo-audio.js` применён к текущему `node_modules` | все 5 целей печатают «already patched», exit 0, повторный прогон не меняет SHA-256 (`patch-idempotency.txt`, `diff native-hashes.txt native-hashes-after-patch-run.txt` = только ожидаемое отсутствие лишних строк) | passed |
| В установленных Swift есть patched-маркеры | `AudioPlayer.swift:61-74` (`backgroundTaskIdentifier/begin/end`), `MediaController.swift` (remote commands + `returnCacheDataElseLoad` + artwork guard), `AudioModule.swift` (`queuePlayer.removeAllItems()`, `guard !self.shouldPlayInBackground else`), `AudioComponentRegistry.swift`, `AudioUtils.swift` (`AVPlayerItem(asset: asset)`) | passed |
| **Установленное на iPhone приложение содержит ту же версию patch** | Нет устройства, нет `.ipa`/`.xcarchive`, нет `Podfile.lock`/`Pods/`/`ios/build`, e2e-хеша нет | **unknown / not tested** |

Примечание: `node_modules` присутствует, но `ios/Pods` отсутствует; локальная сборка невозможна
(нет Xcode). Изменения в `node_modules` не являются поставляемым исправлением (раздел 4 плана) —
это верно и здесь: binary provenance не доказан.

## 3. Фактический event contract SDK 58.0.10 (из установленных исходников)

Единственный канал событий плеера — один event `playbackStatusUpdate`
(`AudioPlayer.swift:4,208`; TS-имя `PLAYBACK_STATUS_UPDATE`, `src/AudioEventKeys.ts:1`,
`build/ExpoAudio.js`). Отдельных событий `loaded`/`error`/`progress` **нет**. Все состояния
диффузируются одним snapshot-ом `AudioStatus` (`build/Audio.types.d.ts:204-258`,
`AudioPlayer.swift:167-189`).

### 3.1 Когда возвращаются `replace()` и `play()`

| Вызов | Реализация | Что означает возврат |
|---|---|---|
| `player.replace(source)` (Promise) | JS-шим `ExpoAudio.js:12` → нативный `Function("replace")` (`AudioModule.swift:252`) → `replaceCurrentSource()` (`AudioPlayer.swift:307`) | Промис резолвится после **синхронной** замены `AVPlayerItem` (`replacePlayerItem`, `AudioPlayer.swift:451-459`). Он **не** ждёт `.readyToPlay`, **не** ждёт `.failed`, **не** возвращает ошибку загрузки. Нет `source` → `createAVPlayerItem` = nil, тихий no-op. |
| `player.play()` | `Function("play")` (`AudioModule.swift:227`) → `AudioPlayer.play(at:)` (`AudioPlayer.swift:135`) | Означает только `ref.playImmediately(atRate:)`. Если item ещё грузится, вернётся успешно, а звук появится позже; если item упадёт — вернётся успешно, ошибка придёт отдельным событием. |
| preloaded путь `player.replace()` | `AudioModule.swift:253-261` → `replaceWithPreloadedItem` (`AudioPlayer.swift:289-305`) | Дополнительно: **не** обновляет `self.source` (см. §5). |

Итог: JS-успех `replace()`/`play()` — это «команда принята», а не «источник загружен» и не
«звук пошёл». Это ровно инвариант 1 Gate A; подтверждено кодом.

### 3.2 События ready / error / progress (точный порядок)

Нативный `setupPublisher()` (`AudioPlayer.swift:238-273`) подписан на **`ref.currentItem?.status`**:

1. `.readyToPlay` → `updateStatus(["isLoaded": true])` (`:249-251`). Здесь же возможен
   `enqueueNextLoopItem`, `installTap`.
2. `.failed` → `updateStatus(["error": ref.currentItem?.error?.localizedDescription ?? "Unknown error"])`
   (`:261-265`). Это **единственный** носитель ошибки загрузки/декодирования на iOS:
   строка без HTTP-статуса, без URL, без kebab-кода.
3. `.unknown` → ничего не эмитится в этом publisher (значение видно только через периодический
   observer/`currentStatus`).
4. `registerTimeObserver` (`:520-537`) каждые `interval/1000` с (в hook `updateInterval`
   по умолчанию 500 мс) эмитит `["currentTime": time.seconds]` с `updateNowPlaying: false`.
   **Это единственный сигнал «прогресса».** Он идёт независимо от `currentItem.status`.
5. `seekTo` (`:216-233`) эмитит `currentTime` после завершения seek.
6. Play-to-end (`:489-515`): `playing:false, currentTime, didJustFinish:true`, затем
   `onPlaybackComplete`. `didJustFinish:true` исчезает из следующих snapshot-ов (база всегда
   ставит `false`, `:181`).
7. `pause()` (`:544-547`): `ref.pause()`, затем `endBackgroundTaskIfNeeded()`, но **сам `pause()`
   не эмитит ничего**. Первое последующее событие — очередной periodic tick с
   `playing:false/isPlaying=false`.

Порядок при чистом `replace` + `play` без кеша/preload:

```
[replace]  (нет события; sync return)
[play]     (нет события; sync return)
...        periodic tick: currentTime≈0, playbackState=unknown, timeControlStatus=waitingToPlayAtSpecifiedRate,
                          isLoaded=false, isBuffering=true, playing=false
...        currentItem?.status=.readyToPlay → {isLoaded:true} (+полный snapshot с duration>0, playing? нет)
...        periodic tick: playing=true (после фактического старта) или время начнёт расти
...        periodic ticks с растущим currentTime (это и есть доказательство прогресса)
```

Отказ:

```
[replace]  (sync return — успешно)
[play]     (sync return — успешно)
...        periodic: isLoaded=false, isBuffering=true, playing=false
...        currentItem?.status=.failed → {error:"<localizedDescription>", isLoaded:false}
...        periodic каждые 500 мс продолжает идти с error==null (база всегда error=nil, :187)
```

**Критично для J07/J08:** `updateStatus(with: ["error": …])` перекрывает только тот snapshot;
следующий periodic tick возвращает `"error": nil`. Ошибка видна ровно в одном событии из
последовательности ~2 Гц, и только `status` из `useEvent` её хранит до перезаписи. Потерять
её легко, если подписчик смотрит на `status.isBuffering` или реагирует с задержкой.

### 3.3 Текущий hook/coordinator: что реально слушает

- `hooks/usePlayerController.js:162-165` — `useAudioPlayer(null)` + `useAudioPlayerStatus(player)`:
  одно подписание на `playbackStatusUpdate`, доступны `status.playing/isBuffering/isLoaded/error/currentTime`.
- `hooks/usePlayerController.js:543-547` — на изменение `isBuffering` дергает
  `coordinator.handleBufferingStatus(isBuffering)` (3.5 с → `networkStatus='slow'`; никакого recovery).
- `hooks/usePlayerController.js:937-940` — автопереход по `status.didJustFinish`.
- `status.error` в product-коде **не читается нигде** (`grep` по `hooks/`, `utils/` — 0 совпадений
  вне описаний). Поздняя ошибка нативного источника в product-поведении теряется. Совпадает с
  наблюдением S0/плана.
- `utils/playbackCoordinator.js:256-600` — `play()` считает успехом возврат `replace()`+`play()`;
  поздняя `.failed` не обрабатывается; `_performReplace` защищает только от out-of-order Promise,
  не от out-of-order native-событий.

## 4. A/B/A и pause-during-load — что доказуемо без iPhone

Все выводы о ненадёжности порядка — из статического анализа установленного исходника
(`static-analysis.json`), **не** из наблюдений на устройстве; iOS runtime smoke — not tested.

| Закрываемый инвариант | Фактическое поведение |
|---|---|
| Событие несёт `source` | Нет. Snapshot содержит только `id` (идентификатор **player**, не source) и числовые/строковые поля состояния. Нет `uri`, `sourceId`, `attempt`, `generation`, `itemId` (`static-analysis.json → identity_fields_in_currentStatus = {id:true, source_uri:false, generation_or_attempt:false, item_identity:false}`). |
| Событие несёт `item` | Нет. `ObjectIdentifier(currentItem)` не эмитится. |
| A → B → A | Тот же `player.id` на все три вызова, `replace()` синхронный `AVQueuePlayer.removeAllItems()` + `insert`, события A/B/A идут в общий поток без привязки. JS может отличить их только по **времени** и **порядку**, которые не гарантированы относительно `play()`/`replace()`. |
| Позднее событие A после выбора B | Нативный publisher подписан на `ref.currentItem?.status`, поэтому `.failed` для A обычно не придёт после замены item (текущий item — B). Но: (а) periodic tick и `updateStatus` из `onReady` (`AudioPlayer.swift:382-388`) используют `ref`, а не захваченный item; (б) `.failed` может прийти для item, который уже заменён в пределах прогона Combine sink; (в) `replaceWithPreloadedItem` `did_not_reset_source = true`. Ни один из этих путей не несёт identity, так что даже «правильное» событие неотличимо от события для другого источника. |
| Pause-during-load | `pause()` не эмитит событие и **не защищает от отложенного `play()`**. В `replaceCurrentSource` при `wasPlaying == true` запланирован `onReady { play(at: effectiveRate) }` (`AudioPlayer.swift:325-328`). Если пользователь поставил pause после `replace()` но до `.readyToPlay`, никакой флаг не сбросит этот `onReady`: `onReady` подписан на текущий item, первый `.readyToPlay` вызывает `play()`. Нативный `play()` → `beginBackgroundTask` не начинается (так и было), но звук начнётся. Это ровно инвариант 5 Gate A («после pause автоматический play() запрещён»): **`onReady` в source-swap — непредусмотренный autoplay**. |
| Старый `onReady` после нового replace | `onReady` использует `\.currentItem?.status` на общем `ref`; в `cancellables` предыдущий `onReady` не отменяется при `replaceCurrentSource`. Быстрый A→B может оставить два `onReady`, оба сработают на первый `.readyToPlay` любого item. Второй `play()` — избыточен, но меняет намерение. |

## 5. Минимальный viable source identity API для S1N (concrete)

Требование координатора: attempt ID назначается **нативно в момент установки item** и эмитится
**из originating callbacks**, включая queued error/progress/seek completion/finish; простановка
текущей generation на произвольно пришедшее событие недопустима.

### 5.1 Точки назначения (native, `AudioPlayer.swift`)

Attempt ID создаётся **до** установки item, в месте, где item рождается, и хранится вместе с item,
а не читается из `player` в момент эмита.

```swift
// AudioPlayer.swift
private var attemptCounter: UInt64 = 0
private func newAttemptId() -> String {
  attemptCounter &+= 1
  return "a\(attemptCounter)"
}
// item ↔ attempt binding, переживает смену currentItem
private var attemptByItem = NSMapTable<AVPlayerItem, NSString>.strongToStrongObjects()
private var activeAttemptId = "a0"          // текущий смонтированный attempt
```

Назначение:

| Точка | Действие |
|---|---|
| `replaceCurrentSource(source:)` (создаёт item через `AudioUtils.createAVPlayerItem`) | `let attempt = newAttemptId(); if let item { attemptByItem.setObject(attempt as NSString, forKey: item) }; activeAttemptId = attempt` → `replacePlayerItem(with: item)` |
| `replaceWithPreloadedItem(_ item:)` (item пришёл из registry) | назначается **новый** attempt для этого item (это новый mapping, не identity прежнего плеера): `let attempt = newAttemptId(); attemptByItem.setObject(attempt as NSString, forKey: item); activeAttemptId = attempt` |
| `replacePlayer(with:restoreSampling:)` (media-services reset) | `replaceCurrentSource` → `handleMediaServicesReset` создаёт новый item → новый attempt (событий «старого» attempt после этого быть не должно) |
| loop enqueue (`enqueueNextLoopItem`) | новый loop-item получает собственный attempt; `didJustFinish` эмитится с attempt завершившегося item |
| `sharedObjectWillRelease()` | `attemptByItem.removeAllObjects()`; `activeAttemptId = ""` |

### 5.2 Обязательное поле в payload (originating callback, не «текущая generation»)

`updateStatus` получает последним аргументом `attemptForItem: AVPlayerItem? = nil` (или явный
`attempt: String?`). Правило: если callback имеет конкретный item — он передаёт **его** attempt;
только periodic observer и `pause`/`seek` (нет item-контекста) передают `activeAttemptId`.

```swift
func updateStatus(with dict: [String: Any],
                  updateNowPlaying: Bool = true,
                  attemptForItem item: AVPlayerItem? = nil) {
  var arguments = currentStatus(knownCurrentTime: dict["currentTime"] as? Double)
  arguments.merge(dict) { _, new in new }
  let attempt = item.flatMap { attemptByItem.object(forKey: $0) as String? } ?? activeAttemptId
  arguments["sourceAttemptId"] = attempt
  emit(...)
}
```

Обязательные originating-источники `sourceAttemptId`:

| Событие | Источник attempt |
|---|---|
| `.readyToPlay` / `.failed` (`setupPublisher` sink) | **item, для которого status пришёл** — `attemptForItem: ref.currentItem` (Combine отдаёт статус текущего item; если `status != ref.currentItem?.status` — событие отбрасывается, см. 5.3) |
| periodic tick (`registerTimeObserver`) | `activeAttemptId` |
| `seekTo` completion | `activeAttemptId` на момент старта seek, захваченный в замыкании (чтобы seek, завершившийся после смены источника, не приписался новому) |
| `didJustFinish` (`AVPlayerItemDidPlayToEndTime`) | attempt **finishedItem** (`attemptForItem: finishedItem`) |
| `mediaServicesDidReset` | `activeAttemptId` нового item |
| `pause()` — сегодня не эмитит | добавить `updateStatus(with: ["playing": false], attemptForItem: ref.currentItem)` чтобы attempted pause был видим с identity |
| lock-screen `nextTrack`/`previousTrack` (`MediaController`) | `player.emit(event:, payload:)` уже начал жить в patch; payload — `["sourceAttemptId": player.activeAttemptId]`, эмитится из handler'а active playable |

`currentStatus()` тоже получает `"sourceAttemptId": activeAttemptId` — чтобы начальное значение
`useAudioPlayerStatus` (до первого события) было согласовано.

### 5.3 Fail-closed для старых item-observers

`cancellables` нельзя сбрасывать целиком (там publisher `\.currentItem`), поэтому вводится
отдельный набор per-attempt подписок:

```swift
private var readySubscriptions = [String: AnyCancellable]()  // attempt -> ready/error подписка
```

- `onReady(for attempt: String, item: AVPlayerItem, completion: @escaping () -> Void)` регистрирует
  подписку на **захваченный item** `item.publisher(for: \.status)`, а не на `ref.currentItem?.status`;
  при срабатывании проверяет `attemptByItem.object(forKey: item) == attempt` и, если нет, удаляет
  подписку и ничего не делает (fail-closed).
- Старый attempt снимается в `replaceCurrentSource`/`replaceWithPreloadedItem`:
  `readySubscriptions.removeValue(forKey: oldAttemptId)` до установки нового item.
- `setupPublisher` `.failed`: добавить guard `item === ref.currentItem`, чтобы поздний `.failed`
  заменённого item не эмитился как событие нового attempt (доп. защита к 5.1).
- `pause()` инкрементит attempt (`activeAttemptId = newAttemptId()`), тем самым отменяя любую
  ожидающую `onReady`-continuation — autoplay после pause становится невозможным by construction,
  а не по флагу.

### 5.4 Совместимость существующего binary (если S1N не сможет пересобрать)

- **Продуктовый binary сейчас без этого поля** (provenance §2 unknown). JS обязан fail-closed:
  `const id = status.sourceAttemptId; if (typeof id !== 'string' || !id) return;` — пока ID нет,
  coordinator не включает автоматический recovery по native-событиям (только explicit retry
  пользователя по `status.error`, который уже доступен). Это сохраняет текущую семантику и не
  включает небезопасный recovery.
- Тот же контракт обратно совместим: старые JS игнорируют лишнее поле, новые JS требуют его.
- MediaController `nextTrack` payload расширяется аддитивно; старый JS `addListener('nextTrack')`
  получает payload и игнорирует его.

### 5.5 Что остаётся в JS (J07/J08)

- `usePlayerStatus` → добавить `sourceAttemptId` в перечне полей статуса.
- coordinator: `pendingAttempt` = последний attempt, который **он сам** выдал через `replace()`.
  Применить событие можно только если `event.sourceAttemptId === pendingAttempt`; иначе молча
  отбросить. `player.id` для этого не использовать.
- `usePlayerController` передаёт attempt в coordinator; `retryPreload` по-прежнему не трогает
  текущий источник (это J08).

### 5.6 Тестируемые условия S1N (без устройства)

Патч-тесты на тексте патча (как patch-expo-symbols.test.js) + native unit (только при сборке):

1. `replace` A→A (тот же uri) → два разных `sourceAttemptId`; preloaded-путь тоже.
2. A→B→A → три разных attempt; `.failed` старого item не эмитится.
3. `onReady` старого attempt после смены item не вызывает `play()`.
4. `pause()` во время загрузки → pending `onReady` отменён; следующий tick несёт новый attempt и
   `playing:false`.
5. `seekTo` завершившийся после смены источника несёт старый attempt (не новый).
6. `didJustFinish` несёт attempt завершившегося item.
7. loop-item: `didJustFinish` для loop-item несёт его собственный attempt.
8. `sharedObjectWillRelease` очищает `attemptByItem` и `readySubscriptions`.

Ни один из пунктов 5.1–5.6 не реализован и не собран: это proposal для senior S1N. Полная
приёмка — только на новой native-сборке (S1N + Gate B, S2).

## 6. Background task lifecycle

Установленные patched-AudioPlayer (`AudioPlayer.swift:61-74`, `:142-143`, `:508`, `:544-547`, `:553-560`)
и patched-AudioModule (`:deactivateSession`, pause/complete guards) дают:

| Триггер | begin | end |
|---|---|---|
| lock-screen next/previous (`MediaController` patch) | `beginBackgroundTaskIfNeeded()` до `player.emit(...)` | на следующем `play()`/`pause()`/release задачи; таймер не ставится |
| play-to-end (`AudioPlayer.swift:508`) | `beginBackgroundTaskIfNeeded()` | `play()` или `pause()` следующего перехода |
| `play(at:)` (`:142-143`) | — | **немедленно**, сразу после `playImmediately()`, не дожидаясь звука |
| `pause()`, `sharedObjectWillRelease()` | — | немедленно |
| истечение system deadline | expiration handler → `endBackgroundTaskIfNeeded()` | — |
| просроченный `source` (нет явного таймера) | — | **нет отдельного таймера**: задача живёт до одного из end-сайтов или истечения лимита iOS (~30 с) — фактическое значение unknown |

Выводы:
- **passed (source-level):** нет пути, где background task остаётся `.valid` навсегда; все
  терминальные события (`play`, `pause`, `release`, system expiry) её завершают.
- **passed (source-level):** `play()` завершает её *до* подтверждённого старта звука. Это
  подтверждает строку 21 плана («защита перехода заканчивается до подтверждённого начала звука»),
  но причинную связь со зависанием в фоне по-прежнему **not tested** (нужно устройство).
- **Гипотеза (not tested):** при `.failed` задача не завершается, пока не истечёт system
  expiration (до ~30 с). Не «утечка навсегда», но задержка освобождения. Если S2 захочет
  детерминизма — контракт: end в `setupPublisher` `.failed` и в `onPlaybackComplete`, а не только
  в `play()`/`pause()`.

## 7. Resource cleanup

| Ресурс | Где освобождается | Статус |
|---|---|---|
| Periodic time observer | `teardownPlayer` (`:365-380`) и `registerTimeObserver` (`:520-523`, заменяет старый) | passed (source-level) |
| `endObserver` (`AVPlayerItemDidPlayToEndTime`) | `addPlaybackEndNotification` снимает старый; `teardownPlayer` (`:374-377`) | passed |
| `cancellables` (publisher `\.currentItem?.status`, `onReady`) | `teardownPlayer.cancellables.removeAll()` (`:378`) — **только** в `replacePlayer/media-services reset/release`; при `replaceCurrentSource` **не** сбрасывается | **failed** для быстрых A→B: старые `onReady`-подписки не снимаются и срабатывают на новый item (см. §4) |
| preloaded native players | `AudioComponentRegistry.removeAllPreloadedPlayers` + patched `AVQueuePlayer.removeAllItems()` | passed (source-level); в product `expoPreloadNative = null` (`playbackCoordinator.js:28`) — путь не используется |
| lock-screen target | `MediaController` patched `removeTarget(self)` + `removeRemoteCommandTargets` | passed (source-level) |
| audio session deactivation при `shouldPlayInBackground == true` | `deactivateSession` patch + pause/complete guards | passed (source-level) |
| background task | §6 | passed source-level / timer unknown |

## 8. Проверки

| Проверка | Команда (cwd) | exit | Время | Результат |
|---|---|---|---|---|
| Patch-скрипт идемпотентен на установленном SDK | `node scripts/patch-expo-audio.js` (`app/ios/puuk-ios`) | 0 | 0.024 с | passed: 5× «already patched», hashes не изменились |
| Целевые playback-суиты (read-only baseline для J03) | `npm test -- --runInBand utils/__tests__/playbackCoordinator.test.js hooks/__tests__/usePlayerController.test.js` (`app/ios/puuk-ios`) | 0 | 1.239 с (jest 0.656 с); лог `targeted-tests.log`, запись в `commands.jsonl` | passed: 2 suite / 102 теста (S0: те же в составе 7/167) |
| Static contract extraction | `python3 /tmp/puuk-playback/J03/static_analysis.py` (`app/ios/puuk-ios`) | 0 | <0.1 с | passed: `static-analysis.json` |
| Expo 58 Audio/FileSystem docs (direct host fetch) | `webfetch` + `curl -sS --max-time 45 -L https://docs.expo.dev/versions/v58.0.0/sdk/{audio,filesystem}/` | ERROR (timeout 45.001 с / TLS 15.105 с); `webfetch` transport error ×2; urllib SSL EOF; http→403 | — | **failed (access limitation)** — но контент подтверждён координатором через web-tool: `/tmp/puuk-playback/S0/sdk58-docs.md` (audio строки 1159–1177, 582–602; filesystem строки 1274–1305, 776–795, 2662–2680). Согласуется с установленным source. |
| Работа кода на iOS runtime (event ordering на устройстве) | — | — | — | **not tested** — нет Xcode/Xcode-симулятора/iPhone |
| Installed-binary version proof | — | — | — | **not tested / unknown** |

## 9. Наблюдение → доказательство → гипотеза → проверка

| Наблюдение | Доказательство | Гипотеза | Как проверить |
|---|---|---|---|
| `replace()`/`play()` не означают загрузку/звук | `AudioModule.swift:252`, `AudioPlayer.swift:307-328,135-148` | coordinator может считать «успех» до фактического старта | unit-тест promise-порядка на mock (уже аналог в `playbackCoordinator.test.js`), но с late `.failed`; см. §9 ниже |
| `playbackStatusUpdate` не несёт идентичности источника | `AudioPlayer.swift:167-189`; `static-analysis.json` | при A→B→A/позднем `.failed` JS не может приписать событие | §5 native patch + instrumented build (only on device) |
| `.failed` видна в одном событии, следующий tick возвращает `error:null` | `AudioPlayer.swift:261-265,187,520-537` | потеря сигнала между редкими status updates | J08: подписка на `error` + отдельный `lateError` latch; device-race only |
| `pause()` не отменяет отложенный `onReady.play()` | `AudioPlayer.swift:325-328` | pause во время загрузки превращается в autoplay | §5.3 (`pause()` инкрементит attempt) + device repro (pause под 3G throttle) |
| старые `onReady` не отменяются при `replaceCurrentSource` | `cancellables` не чистится в `:307-330` | быстрые skip дают лишний `play()` | §5.3 fail-closed per-attempt подписки; unit на mock-эмиттере |
| `nextTrack`/`previousTrack` эмитятся из `MediaController` напрямую в player | patch-expo-audio.js `MediaController` | hook получает lock-screen события без source identity | read-only совпадает с hook `:937-940`; runtime not tested |
| `expoPreloadNative = null` | `playbackCoordinator.js:28` | native preload не используется — native preload не мигрируем | passed |

## 10. Необходимые native-правки (для S1N) — summary

1. `sourceAttemptId` назначается **в момент установки item** (`replaceCurrentSource`,
   `replaceWithPreloadedItem`, media-services reset, loop item) и хранится в `attemptByItem`
   (`NSMapTable<AVPlayerItem, NSString>`); эмитится из originating callback (§5.1-5.2).
2. Originating источники: `.readyToPlay`/`.failed` — item, для которого пришёл статус;
   `didJustFinish` — finished item; `seekTo` — attempt, захваченный на старте; periodic/pause/
   `mediaServicesDidReset` — `activeAttemptId`.
3. Fail-closed: отдельные per-attempt `readySubscriptions` на захваченный item,
   guard `item === ref.currentItem` для `.failed`, снятие старой подписки при смене источника;
   `pause()` инкрементит attempt (отменяет отложенный `play()`).
4. `replaceWithPreloadedItem` обновляет `self.source` (корректный media-services reset).
5. Lock-screen `nextTrack`/`previousTrack` в payload несут `sourceAttemptId` (аддитивно).
6. `currentStatus()` содержит `sourceAttemptId` — согласованный начальный статус.
7. JS-контракт: `status.sourceAttemptId`; coordinator сравнивает с выданным им же attempt;
   при отсутствии поля — fail-closed (без авто-recovery). `player.id` для source identity
   **не** используется.
8. Опционально для детерминизма фона: end background task при `.failed`/source change.

Ничего из этого не реализовано в продуктовом коде, не собрано и не проверено на устройстве;
audio/behavior в J03 не изменялись.

## 11. passed / failed / not tested

- **passed (source/host-level):** patch идемпотентен, все 5 patched-файлов на месте (SHA-256);
  `replace()`/`play()` семантика; event contract (один event, ready/error/progress пути);
  отсутствие identity в snapshot; background task без вечной утечки; observer cleanup в
  release/teardown; `expoPreloadNative=null` (native preload не используется); 102/102 теста.
- **failed (source-level gaps, чинить S1N/J07):** нет source identity в событиях; `.failed`
  видна в одном event и перезаписывается; `pause()` не отменяет отложенный `onReady.play()`;
  старые `onReady` не снимаются при смене источника; `replaceWithPreloadedItem` не обновляет
  `self.source`.
- **not tested:** какие-либо iOS runtime-наблюдения (порядок/таймингs событий, реальный A/B/A,
  pause-during-load на устройстве); версия patch в установленном на iPhone binary; точное
  поведение background task до истечения системного лимита; чтение версионированных
  Expo-доков (сеть закрыта).

## 12. Ограничения и открытые вопросы для senior

- Версионированные Expo-доки подтверждены координатором (`S0/sdk58-docs.md`) и согласуются с
  установленным source (`replace() → void`). Прямой fetch с этого хоста — failed (access
  limitation); эмитируемые поля/ошибки берутся из установленного Swift.
- Native error остаётся строкой `localizedDescription` без HTTP-статуса. `401/403/404` на уровне
  нативного события неразличимы; классификация возможна только на `fetch`-пути
  `AudioCache`/`getHeadersAsync` (вне J03).
- `AudioUtils.createAVPlayerItem` patch убрал `automaticallyLoadedAssetKeys: [.tracks, .duration]`;
  `duration` может быть 0 до `.readyToPlay`. Runtime-эффект **not tested**; влияет на UI progress и
  `computeTrackNormalizationGainDb`.
- Вопрос S1: принимается ли §5.1-5.3 как граница S1N (attempt на item, originating callbacks,
  fail-closed подписки) — или требуется `itemId = ObjectIdentifier`, который не переживает
  пересоздание `AVPlayerItem` и потому отвергнут в §5.
- Вопрос S1: как долго JS должен ждать `sourceAttemptId` в статусе до включения авто-recovery на
  binary без поля (предложение — никогда: только explicit retry).
- Вопрос S2: нужен ли детерминированный end background task по `.failed`/source change.
