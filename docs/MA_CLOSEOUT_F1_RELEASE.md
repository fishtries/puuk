# F1DEP — файл установлен, активация отложена владельцем

**Полный release не завершён: outcome failed/incomplete.** Принятый service-файл атомарно установлен на production disk после fresh preflight и проверенного private SQLite backup. Владелец решил выполнить `sudo systemctl restart puuk-brain` позже; старый API PID2473651 остаётся активным. Активация исправления, новая readiness и live authenticated DTO smoke — **not tested, pending owner restart**. Disk hash сам по себе не объявляется успешным deployment.

2026-10-29 UTC; Run `run_ea37b46b2dc1`, Task `task_a17ce2ece4f0`, текущий Dispatch `ctx_62dcd2731663`. Предыдущий `ctx_495f66e6e651` выполнил только11:52 UTC preflight, затем потерял authority/был abandoned после quota interruption; его receipts сохранены, production backup/install тогда не выполнялись. Текущая каноническая retry того же Task обновила все preflight facts. Нового Run, делегирования или completion старой попытки не было.

Scope основан на [независимом F1R](MA_CLOSEOUT_F1_REVIEW.md) и явной owner authorization, переданной в live task/coordinator message `msg_f0eeaeb8bb9f`. Restart согласован только как действие владельца: агент не имел sudo authority и не отправлял сигналов. Прочитаны root/brain AGENTS, DEPLOYMENT.md, accepted F1R proposal и `release-it`/mini rules; ранее загруженные version-matched Orca guides сохраняют силу. DEPLOYMENT.md с отсутствующими system units устарел: свежий manager census ниже важнее; broad deploy.sh и fallback pkill/SIGKILL не использовались.

Использован существующий Codex gpt-6.1-sol/high процесс; projection/footer ранее проверены. Новый model launch не выполнялся, requested/effective fields исходный launch receipt не вернул; отсутствующие значения не выдуманы. Текущий authoritative Dispatch/projection receipt сохранён отдельно.

## Единственный изменённый runtime path

| Поле | Фактическое значение |
|---|---|
| Local accepted input | `brain/services/personalized_recommendation_service.py` |
| Production target | `/home/fish/apps/puuk/puuk/brain/services/personalized_recommendation_service.py` |
| Expected predecessor SHA256 | `9d6e22da5828abaf51a2aadf703d873478222baa27c3c7963944a83d23365ac7` |
| Installed accepted SHA256 | `bcbd8d490f381aef3fbe25c762d92abf43c2605f229e2261f88835fe5c932912` |
| Before → after inode |1573080 →1573088, atomic same-directory replacement |
| Owner/group/mode | UID1000/GID1000/0644 сохранены |
| Installed size/time |24534 bytes;18:11:40.402597–18:11:40.417295 UTC |
| Application process after install |PID2473651, start Wed2026-10-28 09:58:31 MSK; active; без reload |

Runtime changes ограничены ровно указанным файлом. Дополнительно созданы только разрешённые private backup/staging/receipt artifacts. Source/tests/index/config/dependencies/schema/router/bot/heavy_worker/audio и credits/history/favorites/journal не изменялись этим операторским действием. Бот и local worker не перезапускались. Test suites повторно не выполнялись: source hash совпадает с75-pass independent F1R candidate.

## Fresh preflight:18:09 UTC

SSH BatchMode/ConnectTimeout10, серверный Python3.13.5. Все127 C0 manifest paths побайтово совпали с expected deployed baseline, включая прежний service hash; source drift0. Local accepted bytes также сверены перед transfer. Production DB canonical path `/home/fish/apps/puuk/puuk/brain/puuk.db`, WAL, schema12, integrity=ok/FK0.

| Census | Фактическое состояние |
|---|---|
| API manager | system unit `/etc/systemd/system/puuk-brain.service`, Userfish, Restart=on-failure, active/running, MainPID2473651, cwd production brain, PrivateTmp=no |
| Bot manager | system unit `/etc/systemd/system/puuk-telegram-bot.service`, Userfish, Restart=always, active/running, MainPID2473673, production bot cwd, PrivateTmp=no |
| Remote SQLite writers observed |API2473651 и bot2473673; remote scanner/heavy_worker под Puuk root не обнаружены |
| Canonical path/namespace |Оба remote процесса указывают на тот же production DB; mount namespace `mnt:[4026531841]` |
| Shared coordination |`/var/tmp/puuk-artist-credit-locks-v2`, mode01777; existing lock inode6029358/device66306, mode0644; inode через root обоих процессов совпадает; read-only open успешен |
| Local heavy worker |PID2593306, cwd `/home/fish/projects/puuk/brain`, hash `705b7dd5766e9b76606e20a7b5a09c307ddce3d6db4a3c9c5076358e7d4fdaac`; local DB `/home/fish/projects/puuk/brain/puuk.db` на btrfs `/home`, не общий production SQLite mount |

Стабильный lock не удалялся/не пересоздавался, contention не инжектировалась и credits lock не удерживался вокруг transfer/restart. Helper/config/writer hashes совместимы с уже выпущенной schema12. Local heavy worker продолжает локальную SQLite/Qdrant/SFTP работу, не является прямым writer production SQLite через общий mount. Поэтому migration freeze всех writers не выполнялся; изменяется read-service API, bot/worker source и protocol не затронуты. Census/байты на disk не являются отдельной аттестацией каждого импортированного Python object в памяти.

Captured counts:1198 tracks /893 albums /923 artists /6123 user_history /7 artist_credit_operations; catalog2707. Это конкретный consistent observation, а не гарантия отсутствия последующего штатного роста библиотеки.

## Private backup и проверка восстановления копии

Remote private directory:

`/home/fish/.local/state/puuk-releases/f1-20261029T181023Z-ctx_62dcd2731663`

Directory mode0700; DB artifacts0600. Backup18:10:24.355444–18:10:24.681843 UTC: source connection `mode=ro`, `PRAGMA query_only=ON`; online `sqlite3.Connection.backup` при продолжающих работу compatible writers. Production main.db/WAL напрямую не копировались, DB restore в production не выполнялся.

| Artifact | Проверка |
|---|---|
| `before-release.db` |4,890,624 bytes; SHA256 `61fece2f52e051370b19a09f29beca76bce979df094335528ee2cd4a70b4ca46`; schema12, integrity=ok/FK0, counts/catalog как выше |
| `restore-verification.db` |Восстановление backup API в новую private copy; SHA256 точно тот же `61fece2f…b4ca46`; schema/counts/catalog/integrity/FK и canonical rows/hash **всех таблиц** совпали |
| `personalized_recommendation_service.before.py` |Exact predecessor bytes/SHA `9d6e22da…365ac7`; UID1000/GID1000/mode0644 и metadata сохранены |
| `backup-receipt.json`, `install-receipt.json` |Remote private receipts с exact paths/UTC/hashes/modes/guards и outcome |

Backup содержит private application data и не публикуется; в repo report только необходимые metadata/hashes. Это verified snapshot/copy restore, не доказательство возможности восстановить работающую DB без учёта поздних записей.

## Guarded installation и owner checkpoint

Remote install проверил наличие/валидность fresh backup и predecessor. Accepted input hash сверён, `compile(..., 'exec')` проверил синтаксис на Python3.13 без import/pyc/startup. Stage создан в том же services directory, fsync и uid/gid/mode/hash проверены. Непосредственно перед `os.replace` повторно сверены expected-before SHA, inode, owner/group/mode; unknown drift не обходился. После replace выполнен fsync parent directory и проверен accepted-after SHA/metadata.

До и после disk install systemctl read-only show вернул тот же active API PID2473651/start time. No --reload установлен свежим census; agent restart/signals/pkill/SIGKILL не выполнялись. Поэтому активация не предполагалась.

Blocking Orca ask `msg_371d1d5db799` передал координатору install/backup checkpoint и готовность к **владельческому** `sudo systemctl restart puuk-brain`. Ответ `msg_77cb0d609c7c` подтвердил, что владелец уведомлён, restart ещё не reported, и разрешил только подготовку postrestart verifier до actual owner result. Ни повторный install, ни новый user question не отправлялись.

В18:15:27 UTC coordinator follow-up `msg_5c120988fd97` передал решение владельца: **restart позже**. Координатор read-only подтвердил прежний PID2473651 и потребовал закончить partial/incomplete release без polling/restart/rollback. Это relayed owner decision и relayed process observation, не собственный postrestart receipt агента.

## Acceptance и оставшееся

| Критерий | Статус |
|---|---|
| Fresh127-source/writer/manager/schema/path/lock compatibility census |**passed** |
| Read-only source SQLite backup + integrity/FK + isolated restore/all-table equality |**passed** |
| Exact predecessor bytes/mode/owner сохранены |**passed** |
| Exact one-runtime-file guarded atomic install/accepted-after hash |**passed** |
| Owner restart command actually executed/result recorded |**not tested / deferred by owner** |
| New API PID/start time/unit active after restart |**not tested**, старый PID остаётся active |
| Bounded60s readiness и actual functional health |**not tested**, verifier подготовлен, не запускался |
| Live authenticated personalized DTO ↔ canonical SQLite + track/album/artist/legacy reads |**not tested** до restart; auth-probe/token generation не выполнялись, secret material не выводился/не сохранялся |
| Full release activated and verified |**failed/incomplete**, не succeeded по disk bytes |

Локальная F1R acceptance/75passed и real-copy/manual-empty proofs остаются reused историческими evidence; они не заменяют live activation. Production P1 не объявляется закрытым. Device, signing/install/listening/5000-preview и G3/G5 этим операторским scope не закрываются.

## Точное продолжение того же Task

1. Владелец выполняет согласованную `sudo systemctl restart puuk-brain` и сообщает actual outcome/time координатору. Agent не запускает sudo/сигналы или fallback и не повторяет вопрос о разрешении.
2. Координатор назначает новую canonical retry **того же F1DEP Task** с новым live Dispatch. Начать inspect-before-write: disk hash уже accepted `bcbd8d49…32912`, service manager/PID/start time и сохранённые backup receipts. При accepted bytes **не переустанавливать файл**. Неожиданный hash/permission/version drift — stop/review.
3. После actual owner restart подтвердить новый PID и start time больше baseline, active/running; выполнить bounded60s functional readiness и authenticated GET проверки prepared verifier по already-scoped access. У сервиса исторически нет отдельного `/api/health` (C0 получал404); не выдавать этот404 за pass. Functional readiness — actual `/api/auth/me`200 плюс nonempty personalized DTO canonical comparisons и track/album/artist GET. Это надо реально исполнить и указать dedicated-health limitation.
4. Existing authorized account access/JWT остаётся только в памяти remote verifier; без вывода env/token/secret, новых users/password resets/history/favorite/manual edits. Сравнить five credits keys, ordered lists/revisions/display с SQLite для returned IDs; не менять данные ради появления manual/[] cases. Зафиксировать source/lock hashes, bot/worker continuation, startup/error observations и actual readiness time.
5. Только после нового PID/readiness/DTO evidence завершать full release succeeded. При отказе — inspect actual state, сообщить координатору; rollback лишь exact compatible predecessor после accepted-after guard и согласованного owner-mediated restart. No DB restore/schema downgrade/старые pre-multi-artist binaries. Backup не откатывает поздние writes автоматически.

Prepared verifier/read-only payload сохраняются, но этой попыткой не исполнялись. При будущем preflight drift/новом runtime write нужны соответствующие fresh checks/backup; повторять75 tests/build без source drift не требуется.

## Receipts, commands и фактические ограничения

Все новые receipts/scripts: `/tmp/puuk-ma-close/F1DEP/ctx_62dcd2731663/`; parent F1DEP receipts предыдущей11:52 UTC попытки не перезаписаны. Remote scripts передавались `ssh -p59348 -oBatchMode=yes -oConnectTimeout=10 fish@192.168.1.117 'python3 -c ...'`, JSON stdin. Exact full argv, script hash, cwd `/home/fish/projects/puuk`, UTC start/end/exit и safe stdout сохранены в phase receipts.

| Command wrapper / artifact | UTC / exit / назначение |
|---|---|
| `python .../ctx_62dcd2731663/run-remote.py preflight` |18:09:41.745690–18:09:42.846509, exit0;127 hashes и remote census |
| local-census.json |18:10:23 UTC; read-only `/proc` path/mount/worker hash, без dump env/full cmdline |
| `python .../run-remote.py backup` |18:10:23.493386–18:10:24.818760, exit0; private backup + restore validation |
| `python .../run-remote.py install` |18:11:39.706716–18:11:40.437716, exit0; one-file guarded install |
| owner-restart-ask.json / owner-deferred.json |Один blocking ask/ответ и relayed owner deferral, без actual restart claim |
| remote-post.py / post-input.json |Подготовлены только; не запускались, secret material не содержат |
| final-receipt.json |Final report/script/input/receipt hashes, partial status, source preservation и deferral provenance |

**Passed сейчас:** fresh preflight/backup/restore/guarded installation. **Failed/incomplete:** full activation criteria, поскольку owner restart отложен. **Not tested:** restart/new PID/readiness/live authenticated DTO smoke/rollback и production restore. **Historical:** старый preflight и F1R tests, явно не текущие postrestart проверки. Runtime disk change и private backups сохранены; никаких неоговорённых production writes/сигналов, широкого deploy, исходного audio edit или изменений local source/index не выполнялось.
