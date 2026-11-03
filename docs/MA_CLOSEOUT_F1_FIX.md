# MA Closeout F1 — кредиты в персональных подборках

## Дефект

`generate_genre_playlist` (`brain/services/personalized_recommendation_service.py`)
формировал SQLite-fallback DTO вручную и не переносил поля кредов:
`artist_id`, `artists`, `artists_revision`, `album_artists`,
`album_artists_revision`. Роутер `routers/personalized_recommendations.py`
отдаёт результат сервиса без изменений, поэтому клиенты получали треки без
авторских кредитов.

Смешанный путь (Qdrant ranked + SQLite refill) усугублял проблему: ranked-строка
шла через `build_wave_track_payload` (с кредами), а refill-строки — через тот же
усечённый fallback-DTO. W1 воспроизвёл 60/60 таких ответов на реальной
библиотеке; реальные mixed-кейсы имели 1 загидратированный ranked и 5
незагидратированных refill.

## Исправление

Минимально, только в `generate_genre_playlist`, после `_apply_diversity`:

1. Один batch-вызов `db.get_tracks_by_ids(...)` только для выбранных строк без
   ключа `"artists"` (bounded, порядок сохраняется через merge `{**t, **hydrated}`).
   Строки каталога уже загидратированы и запроса не вызывают.
2. Fallback-DTO копирует пять полей кредов с дефолтами `[]`/`0`.
3. Ranked-путь по-прежнему передаёт загидратированный `db_track` в
   `build_wave_track_payload`, поэтому N+1 (`db.get_tracks_by_ids([id])` на трек)
   не возникает.

Не менялись: ранжирование, бонусы/штрафы, diversity-лимиты, публичные API.

Кредиты берутся из канонического `hydrate_track_credits`: порядок по
`track_artists.position`, ручной оверрайд (включая намеренный `[]` через
`manual_names_json`) и независимые альбомные кредиты сохраняются.

## Регрессии

`brain/test_closeout_personalized_credits.py` (изолирует `PUUK_DB_PATH` через
`test_db_path`, отключает Qdrant-эмбеддинги):

- `test_sqlite_fallback_preserves_all_credit_fields` — SQLite-fallback: все пять
  полей, порядок имён, `artist_id`, ручной оверрайд, пустой `[]`, независимые
  альбомные кредиты.
- `test_mixed_qdrant_ranked_and_unhydrated_refill` — смешанный путь: ranked +
  refill, все креды на каждом треке.
- `test_unhydrated_rows_are_hydrated_in_single_batch` — незагидратированные строки
  гидратируются ровно одним batch-вызовом.

## Доказательства fail → pass

Все прогоны — локально, в `/home/fish/projects/puuk/brain`, интерпретатор
`brain/venv/bin/python` (Python 3.14), `git HEAD` `671be2ff`. Точные
start/end-тайминги запусков не записывались; mtime файлов не является временем
исполнения и не использовался. Тестовая SQLite изолирована: `import test_db_path`
первой строкой задаёт `PUUK_DB_PATH` во временный каталог (`setdefault`), Qdrant
не задействован (эмбеддинг патчится → `None`/dummy, `_query_genre_points`
подменён). Настоящая `puuk.db`, Qdrant, бот и сканер не затрагивались.

| Evidence | argv (cwd=brain) | Log / hash | Count | Status |
|---|---|---|---|---|
| original-3-fail | `pytest /tmp/puuk-ma-close/F1/prefix-tree/brain/test_closeout_personalized_credits.py -q -p no:cacheprovider` (pre-fix байты, sha256 `9d6e22da…365ac7`) | `F1/prefix.log` `76d43862…80726` | 3 failed | passed (verifies defect) |
| fixed-3-pass | тот же файл против fixed байтов (sha256 `bcbd8d49…32912`) | durable-лога нет | 3 passed (утверждалось ранее) | **not verified** — standalone-лог отсутствует; F1R отдельно покрывает эти 3 регрессии (75 passed), не путать со standalone-логом |
| relevant-42-pass | `pytest test_personalized_recommendations.py test_multi_artist_recommendations.py test_closeout_personalized_credits.py -q` | `F1/after-suites.log` `41c09092…bc0ff` | 42 passed, 1 warning in 6.57s | **verified** — валидный pytest-вывод на диске; F1E ошибочно считал артефакт повреждённым (shell-обёртка искажала отображение вывода, а не файл) |
| full-backend | `pytest -q --no-header -p no:cacheprovider` (весь `brain/`) | `F1/full-suite.log` `d1a4b7ce…0c7f3` | `547 passed, 4 warnings, 56 subtests passed in 62.67s` | passed |

Версии исходников и теста (воспроизводимы):

- pre-fix service: `9d6e22da5828abaf51a2aadf703d873478222baa27c3c7963944a83d23365ac7`
- fixed service: `bcbd8d490f381aef3fbe25c762d92abf43c2605f229e2261f88835fe5c932912`
- regression test: `6be219a212936708e86591f7c99ae497f9aa7ebf457ba9cb5bc8c33b196b5e8f`

Статус развёртывания: изменения — только в рабочем дереве (service — `M`,
test/report — untracked), `./deploy.sh` не запускался; runtime на
`192.168.1.117:59348` **не обновлён** (remote-check — `not tested`, production
доступ не использовался). Итог: original-3-fail, relevant-42-pass и
full-backend — `passed`/`verified`; standalone fixed-3-pass — `not verified`
(durable-лога нет; те же 3 регрессии отдельно покрыты F1R, 75 passed). Точные
start/end-тайминги запусков не записаны; повторные прогоны не выполнялись.
