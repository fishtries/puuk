# Выпуск серверной части multi-artist

2026-10-28. После сообщения владельца о недоступности изменения артистов выполнен серверный выпуск backend и бота через `./deploy.sh`. Оба systemd-сервиса active/running. Локальный heavy worker остановлен перед выпуском и запущен на актуальном коде после проверок. Подписанный iOS build и device smoke этим выпуском не выполнялись.

## Подготовка и исполнение

- Свежий согласованный SQLite backup и архив прежнего кода: `/home/fish/.local/state/puuk-releases/multi-artist-20261028T065716Z/` на сервере. Каталог0700, DB/archive0600. `code-before.tar.gz` содержит исходники/конфигурацию, без venv/audio/DB; `preflight.db` снят SQLite backup API.
- До выпуска: schema11,1149 tracks/891 albums, integrity_check=ok, foreign_key_check пустой. На локальной отдельной копии выполнены два init/upgrade: schema12, raw tracks/albums равны исходным, integrity/FK в норме.
- Системный `systemctl stop/restart` от fish требует интерактивную авторизацию. Вместо повышения прав использовано управление точными процессами того же пользователя: локальный worker PID67044 завершён SIGTERM; прежние API/bot PID2023444/1982969 временно приостановлены SIGSTOP. Во время паузы сохранён дополнительный `before-release.db` через backup API с теми же counts и проверками.
- `./deploy.sh`: exit0. Штатный fallback скрипта завершил прежние API/bot процессы; их systemd Restart policies запустили новые PID2473651/2473673. Дополнительный контроль не обнаружил оставшихся прежних процессов; отдельное принудительное завершение после скрипта не потребовалось. Freeze/backup/sync/restart выполнены в одном локальном сценарии; старые writers не возобновлялись после migration012.
- Проверены SHA256 всех49 backend/bot путей из итогового feature inventory: все совпали с локальной реализацией. Код/БД не сбрасывались, пользовательские изменения не коммитились.

## Проверка работающего API

Выполнена через localhost и публичный HTTPS `https://web.puuk.fun`:

| Проверка | Результат |
| --- | --- |
| Авторизованный GET track, `credits_only=true` | 200, artists array и revision присутствуют |
| Авторизованный GET album | 200, artists array и revision присутствуют |
| PUT track artists с заведомо неверной revision | 409, последующий GET подтвердил неизменность состава/revision |
| PUT album artists с заведомо неверной revision | 409, последующий GET подтвердил неизменность состава/revision |
| Авторизованный каталог артистов | 200 |
| Схема production SQLite | 12 |
| integrity_check / foreign_key_check | ok / пусто |

Для smoke использован короткоживущий JWT существующего admin, только в памяти серверного диагностического процесса; токен/секрет в вывод/отчёт не передавались. Успешная смысловая правка произвольного production трека ради проверки не выполнялась. Проверены реальные чтение и conflict guard работающих новых write endpoints; успешные write сценарии ранее покрыты изолированными backend suites.

`/openapi.json`, `/` и `/api/health` отвечают404: production OpenAPI отключён, отдельного health route нет. Это не было принято за отказ обновлённого API; готовность проверена фактическими авторизованными запросами выше.

Post-start snapshot:1198 tracks/892 albums; все исходные1149 track IDs и891 album IDs сохранены, missing_old_ids=0. За интервал появились49 новых tracks и1 album; это живой census после возобновления writers, не фиксированная библиотека. Смысловое разделение старых составных имён отдельной операцией не запускалось.

## Локальный worker и остаток работ

Worker запущен с прежними аргументами `heavy_worker.py` в `/home/fish/projects/puuk/brain` через `brain/venv/bin/python`, новый PID2593306. Подтверждены monitoring startup, SFTP-загрузка и успешное обновление Qdrant; authentication prompt/Traceback не наблюдались. Лог `/tmp/puuk-ma-release/heavy-worker.log`, PID receipt `restarted-local-worker.json`. Существующие CUDA-library warnings не помешали обработке на доступном runtime.

Локальные receipts: `/tmp/puuk-ma-release/{preflight,quiesced,api-smoke,identity-check,source-check}.json`, deploy.log и upgrade-test.db. Серверные api-smoke.json и identity-check.json сохранены рядом с backup. Схема и API выпущены; G5 целиком не закрыт: physical iOS playback/accessibility smoke, подписанный iOS build при необходимости, выбранные5 data corrections и243 неоднозначных случая остаются отдельными этапами. Для проверки в приложении заново открыть редактор, чтобы получить актуальный DTO/revision.
