# iOS Gapless Audio — техническая разведка expo-audio (SDK 57)

Дата: 2026-10-05 (Фаза 3, Агент 1)
Метод: статический анализ установленного `expo-audio@57.0.5` (`node_modules/expo-audio/` — JS build + iOS Swift) и версионных доков https://docs.expo.dev/versions/v57.0.0/sdk/audio/. Всё, что помечено «проверить на iPhone», требует ручного спайка.

---

## 1. Состав API (подтверждено по .d.ts и Swift-исходникам)

### AudioPlayer (используется сейчас)
- `useAudioPlayer(source, options)` / `createAudioPlayer(source, options)` — создание.
- `replace(source)` — смена источника у живого плеера.
- `play/pause/seekTo/remove`, `currentTime/duration/isBuffering/isLoaded/playing`.
- `setActiveForLockScreen(active, metadata, options)` / `updateLockScreenMetadata(metadata)` / `clearLockScreenControls()` — lock screen (только для `AudioPlayer`, см. §4).
- Событие `playbackStatusUpdate` → `status.didJustFinish === true` в момент окончания трека (AudioPlayer.swift:467). Это событие уже используется в `usePlayerController`.

### AudioPlaylist (есть в нативном коде, в приложении пока не используется)
Класс на базе `AVQueuePlayer` (`AudioPlaylist.swift:10`).

Создание: `createAudioPlaylist({ sources, updateInterval, loop })` или хук `useAudioPlaylist(options)` (авто-release при unmount). Для живущего в App-root контроллера допустимы оба; `createAudioPlaylist` + явный `destroy()` даёт ручной контроль.

Методы: `play()`, `pause()`, `next()`, `previous()`, `skipTo(index)`, `seekTo(seconds)`, `add(source)`, `insert(source, index)`, `remove(index)`, `clear()`, `destroy()`.

Свойства: `currentIndex`, `trackCount`, `sources`, `playing`, `isLoaded`, `isBuffering`, `currentTime`, `duration`, `volume`, `playbackRate`, `loop` (`'none' | 'single' | 'all'`).

События (`playlist.addListener`):
- `playlistStatusUpdate(status)` — периодические апдейты (`updateInterval`, дефолт 500мс).
- `trackChanged({ previousIndex, currentIndex })` — срабатывает и при **нативном авто-переходе** (publisher по `\ .currentItem``, AudioPlaylist.swift:288–301), и при ручном skip.

### preload (iOS)
- `preload(source, { preferredForwardBufferDuration })` — создаёт `AVPlayer` в реестре, ключ = `uri.absoluteString` (AudioModule.swift:63–74). Дефолт буфера вперёд 10с (`PreloadOptions.preferredForwardBufferDuration`, доки).
- **Ключевая механика**: при `createAudioPlayer({uri})` (AudioModule.swift:124) или `player.replace({uri})` (AudioModule.swift:235) с **точно тем же URI** предзагруженный `AVPlayer` изымается из реестра, а его готовый `AVPlayerItem` подменяется в живой плеер через `replaceWithPreloadedItem` (AudioPlayer.swift:243) — **без сети и ре-буферизации**.
- На iOS источник исчезает из `getPreloadedSources()` после потребления (доки).
- `preload` поддерживает `headers` (идёт через тот же `createAVPlayerItem`).

---

## 2. Ответы на вопросы плана

| Вопрос | Ответ |
|---|---|
| preload в SDK 57 | Есть, iOS-реестр предзагруженных AVPlayer'ов. Потребляется `replace()` при точном совпадении URI. |
| AudioPlaylist | Есть, нативный `AVQueuePlayer`, полный CRUD очереди + события. |
| createAudioPlaylist | Есть, вне React-жизненного цикла, с `destroy()`. |
| local file URI | `AudioSource.uri` — `URL?`; `file://` проходит в `AVURLAsset` напрямую (AudioUtils.swift:77–95). Заголовки для локальных файлов не нужны. |
| динамические add/insert/remove/skipTo | Есть, но с семантикой rebuild — см. §3 (важные ловушки). |
| lock screen metadata | Только для `AudioPlayer`. Для плейлиста **требуется нативный патч** — см. §4. |
| поведение после didJustFinish | У плеера: событие в момент конца. У плейлиста: авто-advance нативный; `didJustFinish` в статусе всегда `false`, кроме однократного события «закончился последний трек» при `loop='none'` (AudioPlaylist.swift:329–336). |
| release/destroy | `player.remove()` / `playlist.destroy()` / `sharedObjectWillRelease()` — останавливает, чистит observer'ы и реестр. При destroy плейлиста/плеера нативные ресурсы освобождаются. |
| auth headers в playlist | Поддерживаются (`AVURLAssetHTTPHeaderFieldsKey`, AudioUtils.swift:88–89), в т.ч. в `preload`. Но заголовки «запекаются» в `AVPlayerItem` на момент создания item'а — ротация токена не обновит уже созданные элементы очереди. |

---

## 3. Ловушки динамической очереди AudioPlaylist (из Swift-кода)

- `add(source)` — добавить в конец: **безопасно**, не трогает текущий item (AudioPlaylist.swift:132–140).
- `remove(index)` при `index > current` — **безопасно**: просто `ref.remove(item)`, без rebuild (AudioPlaylist.swift:187–192).
- `remove(index)` при `index <= current` — **rebuild очереди** → текущий трек перезапускается с нуля (или переключается, если удалили текущий).
- `insert(source, index)` — **всегда rebuild** (`rebuildPlaylist(startingAt:)` создаёт новые `AVPlayerItem` с текущего индекса): вставка даже после текущего трека **перезапускает текущий трек слышимо** (AudioPlaylist.swift:142–162).
- `skipTo`/`previous` — rebuild + resume (ожидаемо).

Вывод для очереди «текущий + хвост»: мутировать хвост можно только через `remove(индексы > current)` + `add()` (append). Произвольная вставка/перестановка в середине хвоста даёт слышимый рестарт текущего трека → перестановку нужно делать как «удалить хвост, добавить заново» либо батчить на границе треков.

---

## 4. Lock screen: главная проблема плейлиста

`MediaController` (MPRemoteCommandCenter / MPNowPlayingInfoCenter) работает **исключительно** с типом `AudioPlayer`:
- `setActiveForLockScreen`, `updateLockScreenMetadata`, `clearLockScreenControls` зарегистрированы в AudioModule.swift только для `AudioPlayer` (строки 261–286).
- У `AudioPlaylist` этих методов нет ни в Swift, ни в .d.ts.
- Патч `scripts/patch-expo-audio.js` (next/previous команды) тоже эмитит события с `AudioPlayer`.

Следствия:
1. Вариант «всё на AudioPlaylist» требует нового нативного патча: регистрация плейлиста в `MediaController` (метаданные per-track из JS по событию `trackChanged`, elapsed/duration из `playlist.ref`, next/previous → `playlist.next()/previous()` либо JS-события). Объём патча сопоставим с уже существующим, но это форк-поверхность, которую придётся таскать через обновления expo-audio.
2. «Активный» плеер для lock screen обязан быть тем же объектом, что играет (elapsed time, play/pause идут из `activePlayer.ref`). Держать рядом «фиктивный» AudioPlayer для lock screen нельзя.

---

## 5. Два кандидата в механизм перехода

### A. Один AudioPlayer + `preload(next)` + `replace()` (рекомендую как основной)
- Планировщик заранее `preload({uri: next})` (локальный URI из кеша или remote+headers).
- По `didJustFinish` → `player.replace({uri: next})` → нативно подменяется уже забуферённый item (`replaceWithPreloadedItem`), затем `play()`.
- Разрыв = латентность готового item'а (единицы–десятки мс — **проверить замером на iPhone**, чек-лист §7).
- Lock screen уже работает (существующий патч), metadata обновляем на каждый трек (`setActiveForLockScreen`/`updateLockScreenMetadata`).
- Очередь живёт в JS (как сейчас) — никакой семантики rebuild, редактирование очереди тривиально.
- Fallback: если next не успел закешироваться/предзагрузиться — `replace({uri: remote, headers})` даст паузу на буферизацию (это и есть сегодняшнее поведение).

### B. AudioPlaylist (нативный gapless advance)
- Истинный gapless: `actionAtItemEnd = .advance`, ноль JS на переходе.
- Цена: нативный патч lock screen (§4), семантика rebuild при редактировании очереди (§3), зеркалирование очереди JS↔native, `trackChanged` → обновление metadata/истории/feedback.
- Оправдан только если замер A на устройстве покажет слышимый разрыв.

### Рекомендация
Реализовать **A** (минимальный риск, весь нативный костыль уже есть и обкатан), замерить разрыв на iPhone. Порог: если слышимый разрыв > ~100 мс или нестабилен — переключаться на B по готовому в §7 чек-листу. Архитектура `usePlayerController` должна изолировать «механизм перехода» за интерфейсом (coordinator), чтобы A→B был заменой одного модуля.

---

## 6. Auth и кеш

- Remote URI + `headers: { Authorization: Bearer ... }` работает и для плеера, и для `preload`, и для плейлиста.
- Ограничение: заголовки фиксируются при создании item'а. Истёкший токен = битые элементы очереди до пересоздания. Плюс AVPlayer не даёт контроля над HTTP-ошибками в JS.
- **Решение**: скачивать в persistent cache (expo-file-system) через `fetch`/`FileSystem.downloadAsync` с актуальными заголовками — там полный контроль (timeout, retry, отмена, проверка целостности). Плееру/плейлисту отдавать `file://` URI без заголовков. Remote URI — только fallback.

---

## 7. Чек-лист ручного спайка на iPhone (обязательный, до Агента 4)

Подготовка: ветка со спайк-кодом, треки ≥ 3 мин, сервер с JWT.

1. **preload+replace (вариант A)**
   - [ ] `preload` перед `replace` — переход между треками без слышимой паузы? Замер: записать экран, оценить тишину между треками (целевое — десятки мс).
   - [ ] `replace` с тем же URI после `preload` не создаёт сетевой запрос (проверить по логам сервера: нет GET /api/stream).
   - [ ] Повторный `preload` того же URI до потребления не дублируется (реестр по ключу).
   - [ ] Замена на remote URI без preload — пауза на буферизацию (ожидаемо), `isBuffering` в статусе.
2. **AudioPlaylist (вариант B, разведочный)**
   - [ ] `createAudioPlaylist` с 2–3 треками (remote+headers): авто-переход, `trackChanged` приходит.
   - [ ] `add()` во время игры — не прерывает; `insert()` в середину — рестарт текущего (подтвердить §3).
   - [ ] Фон/блокировка: авто-переход происходит при заблокированном экране.
3. **Lock screen**
   - [ ] Вариант A: metadata/artwork меняются на каждый трек; Next/Previous/Play/Pause работают из патча.
   - [ ] После `didJustFinish` → replace → metadata успевает обновиться до того, как юзер успеет нажать Next (иначе гонка — проверить двойное нажатие).
4. **Заголовки/токен**
   - [ ] Remote с `headers` играет; после истечения токена (ускорить на сервере) новый трек из очереди с закешенным заголовком падает — зафиксировать поведение.
5. **Файл**
   - [ ] `file://` URI из `documentDirectory` играет в AudioPlayer и в AudioPlaylist.
6. **Ресурсы**
   - [ ] 10 подряд `replace()` не растят память (инструменты → Memory); `remove()` у старого плеера освобождает.

Результат спайка фиксируется здесь же (таблица ниже заполняется по факту прогона).

| Пункт | Результат | Замечания |
|---|---|---|
| A: разрыв перехода | _не прогонялось_ | |
| A: нет GET /api/stream после preload | _не прогонялось_ | |
| B: trackChanged при авто-переходе | _не прогонялось_ | |
| B: insert рестарт | _не прогонялось_ | |
| Lock screen: metadata по трекам | _не прогонялось_ | |
| file:// играет | _не прогонялось_ | |

---

## 8. Влияние на последующих агентов

- **Агент 2 (cache)**: persistent dir = `documentDirectory/audio-cache/` (переживает перезапуск; `cacheDirectory` система может чистить — не подходит под критерий «после перезапуска найден»). Заголовки — только на этапе скачивания.
- **Агент 3 (scheduler)**: приоритет `current > next > next-next`; передавать в плеер готовые `file://` URI; отмена загрузок при смене очереди.
- **Агент 4 (coordinator)**: механизм A по умолчанию, интерфейс с изоляцией для B. Обновление metadata — синхронно со сменой `currentTrack` в JS (не ждать `trackChanged`, его в A нет).
- **Агент 6 (usePlayerController)**: публичный API хука не менять; `loadAndPlay` становится тонкой обёрткой над coordinator'ом.
