# J02 — backend и путь передачи (диагностика)

Дата: 2026-10-30. Task: `task_dfcce3256a36`, dispatch `ctx_c5bdd7739e00`, Run `run_5c86d4feea71`.
Исполнитель: Junior (вторая попытка на Inferhold после отмены провайдера Gemini). Владение: этот отчёт + `/tmp/puuk-playback/J02/`. Продуктовый код не изменён.

Решение координатора (в inbox): завершить ту же J02 по сохранённым артефактам, **не повторять production-запросы**; измеритель запускался на **серверном хосте**, а не на iPhone.

Статус: **backend-тесты passed (воспроизведено локально); транспортные замеры loopback/public — выполнены на сервере, не на устройстве; iPhone not tested.** Продуктовых изменений, deploy, restart не было.

---

## 1. Ограничения и происхождение свидетельств (важно)

| Пункт | Факт |
|---|---|
| Кто измерял | Модель-исполнитель первой попытки (Gemini, отменена координатором) **на сервере** `192.168.1.117`. Я (вторая попытка) не перезапускал production-запросы по указанию координатора — только перепроверил и проанализировал сохранённые `transport_measurements.json` (58 строк) + `measure_transport.py`. |
| Где loopback | `http://127.0.0.1:8000` на сервере, uvicorn `0.52.4`, CPython 3.13.5, systemd unit `puuk-brain.service`, active (running). |
| Где public | `https://web.puuk.fun` через nginx `1.26.3`, http/1.1, `proxy_buffering off`, `proxy_read_timeout 600s` → `127.0.0.1:8000`. |
| Что НЕ доказано | Измерения сделанные на Linux-сервере → **не** измерение с iPhone. Wi-Fi/LTE, iOS URLSession/AVPlayer, мобильный прокси, DNS/TLS с телефона — не проверялись. Все device-строки → `not tested`. |
| Проблемный трек | Владелец не сообщал конкретный сбойный track_id; прямой «проблемный» трек в наборе нет. Взяты 3 файла разных размеров (малый/средний/большой) + негативные кейсы. |

### Про метаданные pytest (замечание координатора)

Координатор указал на расхождение: первоначальный прогон на уже существующей временной БД дал `2 failed / 51 passed`, а итоговый `pytest_backend.json` содержал захардкоженные зелёные счётчики. Я это проверил и **устранил неоднозначность**:

- `pytest_backend.json` в этой папке — **последний** прогон (`53 passed`, exit 0), записанный координатором/автором; у первой («2 failed») попытки отдельного JSON нет, есть только упоминание в сообщении координатора.
- Я **не перезаписывал** существующие `pytest_backend.log`/`pytest_backend.json`. Вместо этого выполнил независимый прогон на **свежей** БД и сохранил его отдельно как `rerun.log`/`rerun.sqlite`. Результат совпал: `53 passed, 2 warnings in 3.67s`, exit 0.
- Исход из `2 failed` не воспроизвёлся на чистой БД → эти 2 падения, вероятнее всего, были загрязнением переиспользованной БД, а не дефектом кода. **Точная причина 2 падений не установлена** (их лога нет) — помечено как unknown, не как «исправлено».

---

## 2. Команды, cwd, exit, время, версии

| # | Команда | cwd | exit | UTC / длительность | Результат |
|---|---|---|---|---|---|
| 1 | `venv/bin/pytest -v -p no:cacheprovider test_media_ticket.py test_track_recovery.py test_closed_access.py test_cover_cache.py` (env: `PUUK_DB_PATH=/tmp/puuk-playback/J02/rerun.sqlite`, `PUUK_TESTS_TMP=…/rerun_tmp`, `EMBEDDING_QUEUE_ENABLED=false`, `EMBEDDING_RECONCILE_ENABLED=false`, `LOUDNESS_SYNC_ENABLED=false`, `PUUK_ADMIN_PASSWORD=admin`) | `/home/fish/projects/puuk/brain` | **0** | 17:37:08.857 → 17:37:13.173, 4315 мс | **`passed` 53, failed 0, warnings 2** (лог `rerun.log`) |
| 2 | `pytest -v …` предыдущий прогон (координатор) | `/home/fish/projects/puuk/brain` | 0 | 3.773 с | `53 passed`, 2 warnings (`pytest_backend.log`) |
| 3 | `venv/bin/python -c "import config; print(config.DB_PATH)"` с `PUUK_DB_PATH=/tmp/puuk-playback/J02/probe2.sqlite` | `/home/fish/projects/puuk/brain` | 0 | — | `DB= /tmp/puuk-playback/J02/probe2.sqlite` → env **реально** переопределяет рабочую БД. Проверочные `probe*.sqlite` удалены. |
| 4 | `measure_transport.py` (58 запросов) | сервер `192.168.1.117` | (недоступно из моей сессии) | — | артефакт `transport_measurements.json` (перепроверен мной, раздел 4) |

Версии: python `3.14.8` (локальные тесты) / `3.13.5` (сервер), pytest `9.1.1`, starlette `1.6.0`, fastapi `0.141.1`, uvicorn `0.52.4`, nginx `1.26.3`. Build ID iOS приложения: **unknown** (к сборке/устройству не относится).

### Изоляция тестовой БД (проверено)

- `test_db_path.py` импортируется первым в каждом тестовом модуле и использует `os.environ.setdefault("PUUK_DB_PATH", …)`. Поскольку я **задал** `PUUK_DB_PATH` до запуска, `setdefault` его не переопределяет → тесты шли в `/tmp/puuk-playback/J02/rerun.sqlite` (файл создан, 270336 байт). Рабочая `brain/puuk.db` не затрагивалась.
- `EMBEDDING_QUEUE_ENABLED=false`, `EMBEDDING_RECONCILE_ENABLED=false`, `LOUDNESS_SYNC_ENABLED=false` — фоновые интеграции выключены и переменными, и `setdefault` в `test_db_path.py`.
- Qdrant в тестах **не требуется вживую**: `test_media_ticket.py`/`test_cover_cache.py`/`test_track_recovery.py` патчят `routers.streaming.client.retrieve`/аналоги через `unittest.mock` и проверяют «Qdrant не тронут» (`retrieve.assert_not_called()`).

### Что прошли 53 теста (по `rerun.log`)

- `test_media_ticket.py`: Bearer-выдача тикета, 401 без Bearer, 404 (deleted/unknown/missing-file) без Qdrant, Range `206`, `accept-ranges: bytes`, полный `content-length == os.path.getsize`, привязка тикета к треку, tampered/expired тикеты, access token ≠ ticket, Qdrant-recovery ровно один `retrieve`.
- `test_track_recovery.py`: SQLite-first, recovery из Qdrant/диска, path traversal блокирован, placeholder не уходит в Qdrant.
- `test_closed_access.py`: все GET кроме auth требуют JWT; cover/color допускают query-token; invalid/expired JWT отклоняются; scan admin-only.
- `test_cover_cache.py`: ETag, `If-None-Match` → 304, инвалидация при изменении файла/версии, безопасные пути.

`passed`: 53/53. `failed`: 0. Предупреждения: `StarletteDeprecationWarning` (httpx) и `Pillow getdata` — не связаны с воспроизведением.

---

## 3. SHA-256 исходников (совпадают с `source_manifest.json`)

| Файл | SHA-256 |
|---|---|
| `brain/routers/streaming.py` | `6382aae1a9ebaee0ed00bc597832a3809e6787b89773e38cde534a9b2d688a87` |
| `brain/routers/auth.py` | `7eef3fbefd5cd2c3056b3bacb48631774bb7461d3e79c7d7b4e6745d5cf79b0b` |
| `brain/auth.py` | `23782d62060fd3aa98638c477d6752ab1789a7586c0a3accd007b5f33a8038e8` |
| `brain/services/media_locations.py` | `030a89c5bc035a672c17b6eb6b9748d1b73e672cd475aaecbe1ec248bd4ba4ea` |
| `brain/test_media_ticket.py` | `2ca2554569e1d1f6efd6ac6ffe1ff5176693d77f31e93f91ed540bf2e65c0680` |
| `brain/test_track_recovery.py` | `6e51bb5639dfa9b19f3a5546e40f679917fe34b39a78e0b249f5cc4db2037160` |
| `brain/test_closed_access.py` | `51a799943a6c55322369cbfcf42caf3fdd58782e797d769cdc97c0642a2b9cea` |
| `brain/test_cover_cache.py` | `1836c89a4cc69e7e66c67f18922ea59931f9f389149b611a0cd1344e67271b1a` |
| `brain/config.py` | `4029eaf4d6f5822fc80429f9395ddc2f929eaccd37dc8644e3fbcb9523f65d41` |

`source_manifest.json` отмечает `remote_match: true` для всех — серверные файлы совпадают с локальными. Я перепроверил локальные хеши (команда `sha256sum`, выше) — совпадают. HEAD `671be2f`, рабочее дерево dirty (не менялось).

---

## 4. Транспорт: loopback vs public

Источник: `transport_measurements.json` (58 строк). Мой разбор:

- Всего запросов: 58 (29 loopback + 29 public), строго последовательно, без параллельных GET.
- 3 валидных трека: 674 903 B (малый), 7 310 829 B (средний), 47 097 607 B (большой) + 2 негативных.
- 36 сравнений тела с диском → **36 exact byte matches, 0 mismatches**.

### 4.1 Full GET: байты и заголовки

| Трек | case | endpoint | status | bytes | Content-Length | match | TTFB(1st byte) | total |
|---|---|---|---|---|---|---|---|---|
| small 0.64MB | bearer | loopback | 200 | 674903 | 674903 | ✅ | 8.96 ms | 11.67 ms |
| small | bearer | public | 200 | 674903 | 674903 | ✅ | 40.36 ms | 131.30 ms |
| small | ticket | loopback | 200 | 674903 | 674903 | ✅ | 6.90 ms | 9.55 ms |
| small | ticket | public | 200 | 674903 | 674903 | ✅ | 42.20 ms | 152.62 ms |
| medium 7.0MB | bearer | loopback | 200 | 7310829 | 7310829 | ✅ | 7.25 ms | 39.40 ms |
| medium | bearer | public | 200 | 7310829 | 7310829 | ✅ | 37.19 ms | 854.65 ms |
| medium | ticket | loopback | 200 | 7310829 | 7310829 | ✅ | 6.98 ms | 37.83 ms |
| medium | ticket | public | 200 | 7310829 | 7310829 | ✅ | 32.82 ms | 739.92 ms |
| large 44.9MB | bearer | loopback | 200 | 47097607 | 47097607 | ✅ | 50.04 ms | 240.59 ms |
| large | bearer | public | 200 | 47097607 | 47097607 | ✅ | 39.01 ms | 4955.38 ms |
| large | ticket | loopback | 200 | 47097607 | 47097607 | ✅ | 6.90 ms | 197.81 ms |
| large | ticket | public | 200 | 47097607 | 47097607 | ✅ | 43.01 ms | 4841.06 ms |

Заголовки на успешных ответах: `content-type: audio/mpeg`, корректный `content-length`, `accept-ranges: bytes` (ставит Starlette `FileResponse`, `responses.py:319`), `etag`, `server: uvicorn` (loopback) — прокси public-ответы без `server: uvicorn` в фильтре.

### 4.2 Range: точные байты (loopback == public во всех 12 парах)

| Трек | Case | Range | status | Content-Range | bytes | match |
|---|---|---|---|---|---|---|
| small | initial | `bytes=0-1023` | 206 | `bytes 0-1023/674903` | 1024 | ✅ |
| small | middle | `bytes=100000-101023` | 206 | `bytes 100000-101023/674903` | 1024 | ✅ |
| small | tail explicit | `bytes=673879-674902` | 206 | `bytes 673879-674902/674903` | 1024 | ✅ |
| small | suffix | `bytes=-1024` | 206 | `bytes 673879-674902/674903` | 1024 | ✅ |
| medium | initial | `bytes=0-1023` | 206 | `bytes 0-1023/7310829` | 1024 | ✅ |
| medium | middle | `bytes=100000-101023` | 206 | `bytes 100000-101023/7310829` | 1024 | ✅ |
| medium | tail | `bytes=7309805-7310828` | 206 | `bytes 7309805-7310828/7310829` | 1024 | ✅ |
| medium | suffix | `bytes=-1024` | 206 | `bytes 7309805-7310828/7310829` | 1024 | ✅ |
| large | initial | `bytes=0-1023` | 206 | `bytes 0-1023/47097607` | 1024 | ✅ |
| large | middle | `bytes=100000-101023` | 206 | `bytes 100000-101023/47097607` | 1024 | ✅ |
| large | tail | `bytes=47096583-47097606` | 206 | `bytes 47096583-47097606/47097607` | 1024 | ✅ |
| large | suffix | `bytes=-1024` | 206 | `bytes 47096583-47097606/47097607` | 1024 | ✅ |

Каждая пара loopback/public дала одинаковые `Content-Range` и побайтово совпадающий SHA-256 тела с нужным срезом диска (`get_disk_slice`). Tail explicit и suffix сходятся (`bytes 673879-674902` для small и т.д.).

### 4.3 Негативные кейсы

| Case | loopback | public | Детали |
|---|---|---|---|
| invalid Range `bytes=999999999-` | **416** | **416** | `Content-Range: bytes */<size>`, 0 байт тела |
| malformed Range `bytes=abc` | **400** | **400** | 37-байтный JSON, без `Content-Range` |
| no token (unauth) | **401** | **401** | 54-байтное тело |
| missing file (в БД, нет на диске) | **404** | **404** | 50 байт |
| unknown track (нет в БД и Qdrant) | **404** | **404** | 50 байт |

Примечание: `404` для missing-file и unknown-track **неотличимы по статусу/заголовкам** — оба 404 без `Content-Range` (совпадает с кодом `stream_track`: и «нет файла», и «нет трека» → `HTTPException(404)`). Для инварианта §4.9 (404 = невоспроизводимость) это допустимо; J07/J08 должны трактовать 404 одинаково. Notice: `test_db_path`/тесты проверяют 401/404/416 локально, а живые замеры подтверждают те же коды на обоих endpoint.

### 4.4 Латентность (сервер → endpoint, НЕ с iPhone)

| Трек | endpoint | TTFB headers | TTFB first byte | total |
|---|---|---|---|---|
| small | loopback | 8.49 ms | 8.96 ms | 11.67 ms |
| small | public | 20.82 ms | 40.36 ms | 131.30 ms |
| medium | loopback | 6.71 ms | 7.25 ms | 39.40 ms |
| medium | public | 25.60 ms | 37.19 ms | 854.65 ms |
| large | loopback | 49.56 ms | 50.04 ms | 240.59 ms |
| large | public | 20.75 ms | 39.01 ms | 4955.38 ms |

Наблюдение (не SLO): на public крупный файл идёт ~4.9 с на 44.9 МБ (~9.5 МБ/с), TTFB ~20–43 мс — ограничение канала/прокси, а не backend (`proxy_buffering off`, файл отдаётся потоком). Range-запросы public TTFB ~22–41 мс, т.е. заголовки приходят быстро. Минимальная единичная выборка: **по одному замеру на пару**; median/p95 здесь считать некорректно (n=1/пару) — это диагностика, не статистика. **Измерения с компьютера/сервера не равны измерениям с iPhone.**

---

## 5. Read-only сверка service/proxy (без секретов)

- `puuk-brain.service`: active (running), `uvicorn api:app --host 127.0.0.1 --port 8000`, `WorkingDirectory=/home/fish/apps/puuk/puuk/brain`, env `MUSIC_DIR=/mnt/data/projects/puuk/music`, `QDRANT_URL=http://127.0.0.1:6333`, `BASE_URL=https://web.puuk.fun`. `JWT_SECRET` в артефакте — `[REDACTED_SECURE_TOKEN]` (секрет не выводился).
- nginx: `:80` → 301 `https`, `:443` TLS (ALPN http/1.1, h2 disabled), `location /api/` → `proxy_pass http://127.0.0.1:8000`, `proxy_buffering off`, timeouts 600s/60s, `client_max_body_size 25m`.
- Никаких restart/деплой/изменений не выполнялось. Проверка только чтением unit/nginx и артефактов.

Что это значит: singleton-проблема из J01 (iOS `SERVER_URL` при импорте) — сторона клиента, не сервера. Backend стабильно отдаёт корректные байты/Range на обоих путях.

---

## 6. Сводка passed / failed / not tested

| Позиция | Статус |
|---|---|
| Backend contract-тесты (media_ticket, track_recovery, closed_access, cover_cache) на изолированной БД | **passed** 53/53, exit 0 (независимый `rerun.log`) |
| Full GET byte-complete, 3 трека, loopback+public, bearer+ticket | **passed** (12/12, exact SHA) |
| Range initial/middle/tail/suffix, 3 трека, оба endpoint | **passed** (24/24, exact SHA) |
| `401` no-token | **passed** |
| `416` invalid Range (+`Content-Range: bytes */size`) | **passed** |
| `400` malformed Range | **passed** |
| `404` missing-file / unknown-track | **passed** (оба 404, неотличимы) |
| Read-only service/proxy сверка | **passed** (секреты скрыты) |
| Первоначальный прогон `2 failed / 51 passed` на переиспользованной БД | **unknown причина** (лога нет); не воспроизвелось на чистой БД. Не считается дефектом кода |
| iPhone / Wi-Fi / LTE / мобильный TLS/DNS / AVPlayer | **not tested** (нет устройства) |
| Проблемный конкретный трек из инцидента | **not tested** (не идентифицирован) |
| Статистика median/p95 SLO | **not tested** (n=1 на пару; только диагностика) |

---

## 7. Гипотезы и что осталось

Локализованные выводы:
1. **Транспорт backend ≠ причина «нестабильной загрузки» на уровне байтов.** Все 36 сравнений точны, Range работает (206, корректный `Content-Range`, tail/suffix сходятся), 401/404/416/400 семантически корректны и одинаковы на loopback/public. Переписывание streaming endpoint без новых доказательств не обосновано.
2. **Крупный файл на public медленный (~9.5 МБ/с, 4.9 с на 44.9 МБ), TTFB малый.** Гипотеза: ограничение исходящего канала сервера/сети, а не блокировка прокси (buffering off). Влияет на startup крупных треков на медленной сети — согласуется с J01 (startup deadline) и J05 (фоновые задачи). Требует измерения **с iPhone** для подтверждения.
3. **`404` missing-file и unknown-track неотличимы.** Для UX это один и тот же класс «трек недоступен»; auto-recovery не должен циклично ретраить (инвариант §4.9).
4. **Прокси не искажает Range/байты.** `proxy_buffering off` + `proxy_pass` прямо в uvicorn → Range проходит насквозь (подтверждено 12/12 парами).

Осталось (не входит в J02):
- **J09**: повторить тот же протокол **с физического iPhone** (Wi-Fi/LTE, iOS URLSession/AVPlayer), собрать median/p95 по ≥10 стартов; только это закроет device-строки.
- Если владелец назовёт конкретный сбойный трек — повторить один loopback/public full GET + Range на нём (последовательно, ≤2 параллельных).
- Первопричина прежних `2 failed` (если важна) — воспроизвести на переиспользованной БД; сейчас трактуется как загрязнение БД, а не дефект.

Не предлагается никаких правок streaming/auth: дефекта не найдено.

---

## 8. Артефакты и безопасность

`/tmp/puuk-playback/J02/`:
- `transport_measurements.json` (58 строк, sanitized URL), `measure_transport.py` (провенанс).
- `pytest_backend.log`/`pytest_backend.json` (координатор, не перезаписаны), `rerun.log`/`rerun.sqlite` (мой независимый прогон).
- `service_proxy_info.json` (env `JWT_SECRET` = `[REDACTED_SECURE_TOKEN]`), `source_manifest.json` (SHA-256 + `remote_match`).

Проверено: в `transport_measurements.json` нет JWT (`eyJ…`), `Authorization`, `Set-Cookie`; URL с тикетом — `?mt=[REDACTED]`. Отчёт не содержит токенов/JWT/signing secrets/query-`token`/`mt`/env. Одноразовый admin-пароль, напечатанный моей env-probe, не попал в артефакты и не сохранялся (probe-БД удалены).
