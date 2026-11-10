# Проверенные пословные тексты

Сервер хранит только явно импортированные снимки Contract v1. Расчёт моделей и
редактор остаются локальными. Полные тексты, аудио и снимки в `data/` не входят в git.

## Формат и сохранность

Источник контракта: `brain/services/word_lyrics_validator.py`; синтетическая
фикстура: `brain/fixtures/word_lyrics_synthetic.json`. `revision` — SHA-256 JSON без
поля revision (`sort_keys=True`, `separators=(",", ":")`, `ensure_ascii=False`).
Индексы `from/to` считаются по Unicode code points; время — целые миллисекунды,
интервал `[startMs, endMs)`. Порядок текста сохраняется даже при инверсии времени.
Границы строки со словами равны min(start)/max(end) её слов.

Экспорт округляет секунды один раз, не сдвигает и не растягивает интервалы.
Инверсии выводятся в предупреждениях. При некорректном слове вся строка получает
`words: []` и исходные LRC-границы; без допустимого LRC экспорт останавливается.
Ручные исходники не изменяются. `draft_with_protected_manual_edits` не означает,
что весь трек прослушан и проверен.

Пример экспорта выбранного результата редактора (пути задаются явно):

```bash
brain/venv/bin/python scripts/lyrics/export_word_lyrics.py \
  --track-id b3ee960e-9d20-5e2e-83a0-24f5ba725152 \
  --audio /home/fish/puuk-experiments/psychoboost/audio.mp3 \
  --reference /home/fish/puuk-experiments/psychoboost/reference.json \
  --aligned-json /home/fish/psychoboost-aligned.json \
  --output data/word_lyrics/psychoboost.json \
  --provenance-output data/word_lyrics/psychoboost_provenance.json
```

Для Stateside/Without Me выбран MMS. При экспорте модели доступны `--model-json`,
`--manual-json`, `--track-slug`, `--base-engine mms`: manual JSON — словарь
`slug:word_id` → `{start, end}`. Перед публикацией получить актуальный экспорт
редактора; исторический файл или извлечение LevelDB не гарантируют актуальность.

## Доставка на сервер

Выпуск выполняется по отдельному поручению. Ниже подготовленные команды;
в ходе исправления production не менялся. Сначала совместимый backend, затем
снимки, затем клиент. `./deploy.sh` доставляет brain и бота; scripts/data нужно
передать отдельно. Из корня репозитория:

```bash
./deploy.sh --dry-run
./deploy.sh
ssh -p 59348 fish@192.168.1.117 \
  'mkdir -p /home/fish/apps/puuk/puuk/scripts/lyrics /home/fish/apps/puuk/puuk/data/word_lyrics'
rsync -av -e 'ssh -p 59348' scripts/lyrics/ \
  fish@192.168.1.117:/home/fish/apps/puuk/puuk/scripts/lyrics/
rsync -av -e 'ssh -p 59348' data/word_lyrics/ \
  fish@192.168.1.117:/home/fish/apps/puuk/puuk/data/word_lyrics/
```

На сервере из `/home/fish/apps/puuk/puuk` используется его `brain/venv/bin/python`:

```bash
export PUUK_DB_PATH=/home/fish/apps/puuk/puuk/brain/puuk.db
brain/venv/bin/python -c 'import sys; sys.path.insert(0, "brain"); import db; db.init_db()'
mkdir -p data/word_lyrics_backups
for song in psychoboost stateside without_me; do
  brain/venv/bin/python scripts/lyrics/import_word_lyrics.py \
    --input "data/word_lyrics/$song.json" \
    --provenance "data/word_lyrics/${song}_provenance.json"
done
```

Это dry-run. После проверки track ID, SHA-256, количества строк/слов и статуса
источника применить те же снимки:

```bash
for song in psychoboost stateside without_me; do
  brain/venv/bin/python scripts/lyrics/import_word_lyrics.py \
    --input "data/word_lyrics/$song.json" \
    --provenance "data/word_lyrics/${song}_provenance.json" \
    --backup-dir data/word_lyrics_backups --apply
done
```

Импорт разрешён только для текущего аудиофайла трека. `--audio` не позволяет
подменить эту привязку. Не редактировать audioSha256 ради успешного импорта.
При несовпадении аудио подготовить снимок для нужного файла. После смены только
mtime повторный импорт подтверждает SHA-256 и обновляет stat-подпись.

Проверить авторизованный GET `/api/tracks/{track_id}/lyrics`: wordLyrics.revision,
число строк/слов и отсутствие изменений LRC. Без снимка либо при неверной
stat-подписи/документе сервер возвращает `wordLyrics: null`, клиент использует
обычный LRC/plain. Каталог и его ETag от импорта не меняются.

## Отключение и восстановление

Команды выполняются с тем же `PUUK_DB_PATH`. Сначала dry-run:

```bash
brain/venv/bin/python scripts/lyrics/import_word_lyrics.py \
  --track-id b3ee960e-9d20-5e2e-83a0-24f5ba725152 --deactivate
brain/venv/bin/python scripts/lyrics/import_word_lyrics.py \
  --track-id b3ee960e-9d20-5e2e-83a0-24f5ba725152 --deactivate --apply
```

Отключение сохраняет снимок и LRC. Чтобы включить снова, повторить импорт JSON с
`--apply`. При каждой замене существующей записи CLI сохраняет уникальный backup
и пишет путь в stderr; stdout остаётся JSON. Сохраните этот файл. Восстановление
также сначала проверяется без записи:

```bash
brain/venv/bin/python scripts/lyrics/import_word_lyrics.py \
  --restore /absolute/path/to/backup.json
brain/venv/bin/python scripts/lyrics/import_word_lyrics.py \
  --restore /absolute/path/to/backup.json \
  --backup-dir data/word_lyrics_backups --apply
```

Восстановление заново проверяет контракт и хеш текущего аудио, обновляет stat и
возвращает сохранённый признак активности. Восстановление неактивной записи не
включает подсветку. Перед заменой текущей записи также создаётся backup.

## Проверки и ограничения

```bash
brain/venv/bin/python -m pytest brain/test_word_lyrics.py \
  brain/test_word_lyrics_regressions.py brain/test_tracks_etag.py brain/test_closed_access.py -q
cd app/ios/puuk-ios
npm test -- --runInBand components/fullplayer/lyrics/__tests__/ hooks/__tests__/usePlayerController.test.js
npx eslint components/fullplayer/lyrics/wordLyricsParser.js \
  components/fullplayer/lyrics/AnimatedLyricLine.js \
  components/fullplayer/lyrics/AppleLyricsView.js hooks/usePlayerController.js
```

На 2026-11-10 backend: 37 тестов, iOS: 144 теста. Покрыты сохранность обратного порядка времени,
повреждённые документы, смена текущего файла, refresh stat, ошибка замены,
отключение/восстановление и сохранность резервных копий. Jest проверяет состояния
слов, пересечения строк, fallback, гонки запросов и контроллер плеера.

iOS получает время от движка с `updateInterval: 50`; самостоятельного таймера
песни нет. Мемоизация строки пропускает рендер при неизменных состояниях слов.
Настройка 50 ms временная: интервалы короче периода могут пропускаться, задержка
событий и нагрузка всего приложения ещё не измерены на iPhone. Нельзя считать
цель задержки до 100 ms достигнутой по этим тестам.

До выпуска остаются измерения на устройстве и сценарии из раздела D плана:
пауза, buffering, seek, 0.75/1/1.5×, фон/блокировка, весь трек, ручной скролл,
VoiceOver и reduced motion. Устройство и production в этой сессии не проверялись.

Дополнительно: Metro/Hermes export для `--platform ios` успешно собран
(`/tmp/puuk-word-lyrics-ios-export`). Авторизованный TestClient в отдельной
временной БД вернул HTTP 200 и точное равенство каждого из трёх снимков:
Psychoboost 73/634, Stateside 36/346, Without Me 103/727 строк/слов.
Это проверка пакета и API, не запуск на физическом iPhone.

### Визуальная проверка пословной подсветки, 2026-11-10

В Orca Chromium на localhost:8083 проверена запись Psychoboost
`b3ee960e-9d20-5e2e-83a0-24f5ba725152`. При воспроизведении DOM-цвета
активных слов последовательно менялись (`me,` → пауза → `part` → `me,`).
После нажатия «Пауза» цвета всех слов совпали в двух выборках с интервалом 650 ms.
Тап по первой строке на паузе вернул белую подсветку `It`, остальные семь слов
стали future. Скриншот проверки: `/tmp/puuk-word-visual.png` (локальный артефакт).

Воспроизведение Expo Web использует POST /api/media-ticket с Bearer и затем
поток с track-scoped `mt`; наблюдались ответы 200 и 206 соответственно.
Добавлен плавный цвет каждого слова (до 60 ms на включение, 160 ms на затухание),
без изменения метрик текста. Reduced motion переключает цвет непосредственно.
Наложение строк при большой перемотке исправлено: при тапе и скачке времени
более секунды поле занимает новую позицию без каскада. В браузере проверен
переход между первой строкой и «Make another hater disappear»: позиция фокуса
совпала (449.885 px). Reduced motion также отключает движение строк.
Проверка Chromium не подтверждает качество на iPhone.

Итоговые автоматические проверки визуального прохода: 215 Jest-тестов текстов
и координатора (включая web media-ticket), iOS Metro/Hermes export успешен.
