# R1 — независимая приёмка подготовки

**Подготовка данных и точный iOS source scope приняты; release/device acceptance не закрыты.** D1 actionable selection пуста: четыре прежние строки уже удовлетворены, Monday остаётся отдельным ручным решением. W1 технически воспроизводим, но обнаруженный P1/F1 остаётся открытым до отдельной независимой приёмки исправления. Установочного артефакта этого кандидата и device receipts пока нет; исходный I1 outcome `failed` сохраняется.

Дата финальной сверки: 2026-10-29, 11:18:46 UTC. Run `run_ea37b46b2dc1`, Task `task_caca75cf61e5`, текущий Dispatch `ctx_c66c07567100`. Reviewer не реализовывал проверяемые product changes, D1/I1/W1 или исправленный JGF inventory. Ownership этого review: только данный отчёт и собственные probes в `/tmp/puuk-ma-close/task_caca75cf61e5/`.

Предыдущий Dispatch `ctx_d5f077056b50` выполнил независимые probes в07:22–07:25 UTC, но не отправил worker_done; поздний check вернул `consumer_fenced`. Reviewer прекратил lifecycle-команды старой попытки. Координатор сообщил, что она остановлена после quota interruption; текущая каноническая retry того же Task повторно сверила inputs и использует сохранённые evidence, не выдавая их за новые executions. Старые outcomes не переписаны.

Прочитаны root/brain/iOS AGENTS, ORCHESTRATION/AGENT_ORCHESTRATION, текущий журнал, frozen MULTI_ARTIST_CONTRACT (§6/8/9/10/12), closeout plan и C0/D1/I1/I1H/W1/JD/JGF артефакты. Использованы установленный version-matched `orca` orchestration/orca-cli guide и worker-contract reference, skill `puux-ux` и DESIGN.md для проверки полноты сценариев. iOS/product code не писался; Expo generation не запускалась. Подзадачи не создавались.

Launch provenance: текущий Dispatch context-only/unsupervised; projection подтверждает Codex gpt-6.1-sol, terminal footer — high. Координатор сообщил точную исходную команду `orca-ide agent launch --agent codex --worktree current --model gpt-6.1-sol --effort high --json`, operationId `1793258388106-10a96a2c505d4def83a46894a2a08a79`. Этот launch receipt не вернул requested/effective fields: их равенство проверить нельзя, выдуманных полей или заявления о новом supervised launch нет. Сообщение координатора `msg_9f75e15b104a` фиксирует ограничение; новая попытка использует тот же проверенный процесс.

## Проверяемая версия и границы доказательств

HEAD `671be2ff8bf2d89a1bc11766d18f62b4faebe5a5` — только база dirty tree. В первой фазе R1 совпали80/80 accepted feature source inputs,116/116 W1 frozen inputs и136/136 iOS inputs. В11:18 UTC совпадают все136 iOS и все D1 mutation inputs; из80 feature/116 W1 inputs изменился только `brain/services/personalized_recommendation_service.py`: frozen `9d6e22da5828abaf51a2aadf703d873478222baa27c3c7963944a83d23365ac7` → current `bcbd8d490f381aef3fbe25c762d92abf43c2605f229e2261f88835fe5c932912`. Это отдельная активная F1 implementation, не принятая данным R1.

Повтор full suites не требуется для неизменившегося iOS/D1. W1 воспроизведён на точных frozen bytes и не доказывает поведение нового F1 файла; targeted regression и независимый F1R обязательны отдельно. R1 не деплоил backend и не проверял заново его live source после C0. C0 schema12/GET и127/127 deployment-source match принимаются как timestamped06:55–06:56 UTC evidence, не как новая live census.

## D1: каждый критерий

| Критерий | Решение | Независимое evidence / предел |
|---|---|---|
| Fresh consistent snapshot | **accepted** | Проверены backup-collector/read-only URI и receipt; SHA256 source `ab6ecde1c2868b6f232ee78feff08fad1787d665c704237e4a0a733e0bdd99a3`, schema12,1198 tracks/893 albums. Собственные copies получены backup API. Новый production snapshot R1 не снимал. |
| Пять точных IDs/title/release/revisions | **accepted** | Своя SQL-сверка всех5: album944, manual `[TV Girl, George Clanton]`, revision2. Полные IDs/title — data-review.json и D1 table; held Monday ID `8ef2ef3e-df31-5724-8288-7143843f802f`. Album credits независимо `[TV Girl]`, r1, manual=NULL. |
| Evidence, было→станет, отсутствие force override | **accepted** | Четыре before=goal исключены. Monday two-name manual r2 → proposed three-name list только held. Повторно открыты официальный Spotify album/track; evidence поддерживает рассмотрение, не отменяет manual authority. Held fingerprint проверен самостоятельно. |
| Актуальная selection и unresolved | **accepted** | Actionable JSON `proposals: []`; свой CLI report точно равен fresh D1 report:241 ambiguous =216 track/25 album, отдельно1 held. Это242 review items,0 actionable; historical243/248/пять не current apply scope. |
| Exact preview/apply/repeat | **accepted** | Свои13 CLI/domain commands на4 новых copies: preview только +1 journal row; apply только1 target state r2→3, +1 link, +1 registry row, catalog2707→2708; affected track только Monday, album944. Repeat возвращает точный result без изменения любой таблицы. |
| Undo/repeat и поздняя правка | **accepted** | Undo возвращает two-name manual/effective list, r3→4, catalog2708→2709; registry row остаётся неактивной, revisions/catalog не откатываются. Repeat точен. Обычная более новая manual edit → undo409 `bulk_undo_conflict`, все таблицы неизменны; stale apply/старый revision1 report →409 `bulk_revision_conflict`, без частичного изменения. |
| Raw identity/album/невыбранные/audio | **accepted** | Полные row comparisons, не только counts:1198 raw tracks,893 raw albums, album links, history/feedback и7 старых journal rows сохранены на4 собственных copies; nonselected credits/links сохранены. По всем copies integrity=ok/FK0. Пять D1 audio before/after SHA/stat receipts равны; это reused evidence, R1 оригинальные audio не открывал. |
| Production authority/scope | **accepted** |0 entities/credit writes/new journal/catalog bumps; empty selection не повод создавать no-op preview. Копийные operation IDs остаются локальными. Production apply/undo/rescan/restore не выполнялись. |

Официальная перепроверка R1: [album tracklist](https://open.spotify.com/embed/album/5MQx9UktIiM86OYBZh1c4M) и [Monday track](https://open.spotify.com/embed/track/14joz9oqnhYORgpKOmE0Aj) показывают соответствующий release и performers. У Monday сохраняется локальный title с feat.-суффиксом; ни title, ни filename не служит разрешением заменить manual list.

## I1/I1H: каждый критерий

| Критерий | Решение | Evidence / предел |
|---|---|---|
| Candidate manifest/полнота source | **accepted** | `I1-780589e84ec7`, manifest SHA256 `780589e84ec7ccbe11aefd7411369ebfd99bb0d075bc171a86675f39a98c5e7a`;136 current Git-visible inputs совпали. Archive SHA256 `c462991e3ead0b771bc946914ba75c97961039c99008ac2bfc32fba7b6c702f4`:137 exact regular-file members,136 inputs + unchanged workflow, без extras/path traversal/credentials/audio/native/build output. |
| Точный соответствующий diff | **accepted** | Независимый git cat-file comparison archive↔base:40 paths,20A/20M, без удалений;31 feature +9 preserved baseline. Все96 остальных iOS inputs и workflow неизменны. Paths точно равны I1H staging allowlist SHA256 `82b755cc9852f5da3262d1f60a6449a743a73e4849954e7d0814caa218a46e8e`. |
| Dependencies/patches/native provenance | **accepted preparation** | Все1385 package-lock entries совпали dependency manifest; existing patches включены. Старый ignored native tree не transport input. I1 isolated prebuild23 files и38-file JS export имеют receipts/hashes; это не Pod install/compile. Native closure/Podfile.lock/build-host hashes остаются в I1 native gap. |
| Identity/profile/backend compatibility | **accepted preparation** | Config `com.fishtries.puuk`, version1.0.0/build1; реальную IPA identity проверить после build. Existing workflow Release/Puuk/iphoneos/macOS26/Node22, unsigned. C0 read DTO/schema и JD mocks поддерживают read compatibility, но native auth/stream/writes не проверены. |
| Drift-related checks/results | **accepted** |24/24 JD source hashes совпали; JD selected227/15 и full608/50 — reused current-closeout evidence, не R1 runs. I1 export/prebuild pass, Expo patch advisory exit1 явно сохранён. Не заявляется clean npm ci/Pods/native success. |
| Artifact/build ID/hash/install receipt | **finding R1-IOS-01 / P1 readiness gap** | Нет correct-candidate unsigned IPA, подписанного IPA или install/build receipt. JS/HBC/source archive не заменяют native artifact. Исходный I1 failed не повышается до success этим review. |
| Concrete build/install scope | **accepted preparation** | I1H точно задаёт ref/40 paths/workflow effects. Координатор в `msg_a28e4c9ed833` передал явное owner approval на этот commit/push/unsigned Actions; это разрешение на следующий отдельный I1 retry, не результат build. Owner лично подписывает/устанавливает. G3/G5 и8 device rows открыты. |

## W1: каждый критерий

| Критерий | Решение | Независимое evidence / предел |
|---|---|---|
| Реальные широкие/узкие inputs и seed | **accepted** | Captured SQLite/Qdrant inputs hash-проверены;15-case harness повторён в собственном каталоге на frozen116 inputs, seed20261029. Canonical SHA256 `c5089694b69b71e9fd05bd8d7fa583766a6faeaa052a3032f0ecef2490584ede` точно равен W1. Qdrant Local exact cosine, не live ANN/latency test. |
| Request/result/unique/repetitions/cap | **accepted** | Отдельно пересчитаны210 output rows, dedup IDs и repetitions каждого участника. Wide20→20; narrow37→20 (strict2+soft18); insufficient3/request10→3. Joint cap расходует слот каждого unique участника. Полный soft-refill не обещает strict cap. |
| Recent overlap/max penalty | **accepted** | Независимо пересчитаны1637 penalty rows по0.05×recent_max. Controlled A4/B3/C1 для A+B:1.0→0.8; не сумма. Participant counters/history сохранены в output. |
| Stale Qdrant/manual override | **accepted для Wave path** | Все8 настоящих manual lists/revisions сохранились в resolver/Wave DTO, несмотря на stale payload; ordered participants сверены отдельным SQL. No history writes на captured evaluation; fixture edits только в своей копии. |
| Все публичные personalized DTO сохраняют credits | **finding F1 / P1** | Frozen SQLite genre sections теряют arrays/revisions у60/60 DTO; mixed cases теряют их у5/6 refill rows каждый. Воспроизведено независимо. Новый F1 source hash не считается исправлением без отдельного F1R. |
| Accepted suites и subjective quality | **accepted technical evidence; listening not tested** | W1 aggregate72 across6 suites — inspected/reused receipt, не новый R1 suite run. Субъективное прослушивание, actual iOS playback, live ANN/outage timing и production history tests не заявляются. |

## Исправленный JGF inventory и device matrix

Текст `MA_CLOSEOUT_JUNIOR_EVIDENCE.md` SHA256 `06b09e196f65f4e9daca7f0aff931de5f6a60a8a6ae5bc607d51aed23a312f3e` **accepted как документ проверенной полноты**, не как completed JGF Task. Reviewer прочитал все12 MA mappings, T19/T20/T21 и8 device rows и сравнил с actual JD JSON/D1/W1/I1. Подтверждены counts: selector4, FullPlayer10, AlbumScreen6, CreditsDraft4, editor3, bulk4, controller46, saved-sync10; navigation aggregate20/3, selected227/15. Исправлены stale-five/243, PUT-as-read-only, hardware-absence inference, ложные per-file counts и обещание Neggy membership. Historical evidence отделено от current-closeout executions.

Координатор сообщил, что JGF Dispatch `ctx_519a6977d0fc` abandoned после quota, без accepted completion; `docs/MA_CLOSEOUT_JG_FIX.md` на финальной сверке отсутствует. Этот lifecycle/report gap остаётся R1-DOC-01/P2; принятое фактическое содержание inventory не подделывает completion и не устраняет недостающий report.

Каждая I2 execution row обязана содержать device model/iOS; actual installed native build ID/version/build и IPA/native binary hash; source manifest; backend origin/version/schema; test account role, fixture IDs/revisions; UTC steps/expected/observed/status/reason и evidence paths/hashes. HBC hash недостаточен. Failed device enumeration означает непроверенный доступ, а не отсутствие телефона у владельца.

| Row | Обязательное наблюдение | Безопасный scope/особые evidence | Текущий статус |
|---|---|---|---|
|1|0 plain text/1 direct/N selector; Cancel; смена current/revision не открывает stale target.|Isolated0/1/N fixtures; actual routes, dismissal/focus/video.|**not tested** — нет execution receipt.|
|2|Player→effective participant→back без слышимого restart; elapsed-adjusted position и полная очередь сохранены.|Playable fixture; initial/return time, elapsed interval, current/queue IDs, audible/video evidence.|**not tested**.|
|3|Credits save сохраняет parent title/lyrics/cover drafts; server DTO применён;409/offline не дают false success, draft/retry сохранены.|Disposable track/album и контролируемая stale revision/offline; не сохранять metadata исходного library audio.|**not tested**.|
|4|Guest track не приписывает ему весь album; независимый joint album виден своим участникам.|Fixture Album A→A, track A+B, Album J→A+C; проверять отсутствие конкретного A у B, не global album_count0.|**not tested**.|
|5|Background/lock metadata/controls и saved-track restore соответствуют установленному baseline.|Playable fixture; actual lock controls/position/queue/background interval; не изобретать гарантию restore position.|**not tested**.|
|6|Long names/large text/VoiceOver: labels/focus/selection/Cancel достижимы.|Accessibility settings, полные labels, hit targets/video; фиксировать actual wrapping/truncation, не требовать выдуманную строку.|**not tested**.|
|7|Bulk preview5000: measured first render/scroll/navigation/Cancel/memory/errors.|Isolated admin fixture ровно5000; preview-only; actual response bytes/latency/profiler/video. Production artist такого размера не предполагается.|**not tested**.|
|8|После fixture change/rescan credits/manual override и независимый album сохраняются.|Default copied fixture; свои operation/rescan IDs и audio hashes. Production correction/rescan отдельно разрешается; Monday guest сейчас не ожидается.|**not tested**.|

Матрица **accepted как план покрытия**,0/8 executed. Симулятор может дополнить проверки; physical audible continuity/accessibility им не закрываются. I2 mutations/409/offline/5000-fixture setup должны использовать изолированный backend либо заранее явно разрешённые сущности/действия и cleanup plan. Установка сама по себе не разрешает редактирование production библиотеки.

## Findings, воспроизведение и владельцы

| Finding | Severity/status | Воспроизведение / требуемое закрытие | Владелец |
|---|---|---|---|
| F1: genre fallback/refill DTO missing credits | **P1, open** | Собственный frozen replay `wave/harness.py`; results `personalized_sqlite_fallback_dto`60/60, `mixed_qdrant_refill_dto`5/6+5/6. Fix должен сохранить canonical ordered manual/[]/revisions и независимые album credits без rank changes; targeted regressions и независимый F1R на новых bytes. | Отдельная fix Task `task_1e4ce183f927`; independent F1R — координатор. R1 code не менял. |
| R1-IOS-01: отсутствует native artifact/install/device proof | **P1 readiness gap, open** | Нет build ID/IPA/hash/install receipts для manifest780589e84ec7; существующий historical HEAD IPA не кандидат. Сборка точного source, unsigned hash→owner signing hash→install receipt, затем8 I2 rows. | Каноническая I1 retry `task_a292bf0da3dd`; owner signing/install; I2 `task_96247c1b274a`. |
| R1-DOC-01: JGF report/lifecycle незавершены | **P2 documentary, open** | Corrected inventory существует и independently checked, но MA_CLOSEOUT_JG_FIX.md отсутствует, abandoned Dispatch не succeeded. Завершить документальное evidence/provenance отдельной канонической retry; outcomes оригинальных JG/JGF не переписывать. | JGF Task `task_81e9996c2293`, координатор назначает retry/дальнейшую приёмку. |

Новых нарушений D1 selection/undo или iOS source allowlist не найдено. Held Monday — явное нерешённое owner data decision, не основание обходить guard. Ни один finding не исправлялся в этом review; любые изменения реализации требуют отдельной Task/independent recheck.

## Точный дальнейший scope

**D2 сейчас:0 production writes.** Не переносить ни старые пять proposals, ни held JSON/копийные operation IDs; не создавать empty preview/journal и не запускать production rescan. Четыре satisfied tracks остаются без действий.241 punctuation candidates вне scope.

Если владелец отдельно разрешит именно замену Monday manual list, единственный возможный proposal — track `8ef2ef3e-df31-5724-8288-7143843f802f`, album944, before `[TV Girl, George Clanton]`, r2, after `[TV Girl, George Clanton, Neggy Gemmy]`. Перед writes нужны новый consistent backup/report, valid admin и повторная сверка exact membership/source/manual/revision; любой drift возвращается на review, без force refresh. Новый production preview operation ID; expected delta1 state/+1 link/(+1 registry если отсутствует)/1 journal/catalog+1. Raw track/album/album attribution/IDs/audio и прочие rows вне scope. После apply — exact DTO/affected/cache/ETag, conditional undo readiness; rescan выбранных файлов требует явного inclusion в scope и no-audio-write evidence. Отказ от held изменения допускает корректный D2 skip с явным отложенным discrepancy.

**I1 build:** source scope уже проверен; coordinator message `msg_a28e4c9ed833` передаёт owner approval на выделенный checkout/ref `build/ios-ma-closeout-780589e84ec7` от immutable671be2ff…, commit только40 paths из I1H allowlist и push этого ref. Existing unsigned workflow SHA256 `5a3d46dbd9425e2d956db769db49a09632139a6f1c6a168b038fafa6206d28d6` запускается push; включает upload artifacts и force-push `ci/puuk-ios-status`, concurrency `build-ios-unsigned`. Не создавать duplicate workflow_dispatch при существующем push run. No merge/main/tag/release/config/dependency/backend/data changes входят в этот scope. R1 этих внешних действий не выполнял.

**Установка:** после реального build зафиксировать actual immutable commit/run/ref/workflow, build-host toolchain/Pods evidence, artifact ID/digest и inner unsigned IPA SHA256, plist identity/native binary hash. Owner подписывает и устанавливает через выбранный им процесс на тестовый iPhone; подписанный hash/actual build/device/install/launch фиксируются отдельно от unsigned artifact. Затем I2 заполняет всю матрицу. User-channel/TestFlight/App Store/OTA publication этим scope не требуется. Наличие owner signing responsibility не равно выполненной установке.

## Passed / failed / not tested / historical

**Passed в R1 до остановки старой попытки:**13-command/four-copy risky replay;136-input/137-member archive и40-path delta; совпадение1385 dependency entries/24 JD hashes/38 JS output hashes;70 cited artifact hashes; fresh report241;15-case exact W1 replay и независимый подсчёт210 rows/1637 penalties. Эти executions сохранены и повторно использованы текущей retry.

**Passed в текущей retry:** fresh source/archive/D1 snapshot hash validation; независимая дополнительная SQL-сверка raw/album/history/7 existing journal rows на4 retained copies; реальная JD227/15 assertion-results сверка; corrected inventory factual/device matrix audit. Команда/UTC/cwd/exit/source hashes — final-audit.json. Полные suites не повторялись.

**Failed/open:** воспроизведён исходный F1; I1 native criterion не выполнен; JGF lifecycle/report gap. Expected CLI exit3 в D1 — прошедшие guards, не ошибки продукта. Старый consumer_fenced означал утрату authority, не разрешение завершить попытку чужим worker_done.

**Not tested R1:** live production apply/undo/rescan/restore/writer freeze; новая production census после C0/D1; native compile/sign/install; все device rows/5000 performance; subjective listening/live ANN/outage timing; correctness текущего F1 patch. Production Qdrant/бот/сканер/heavy worker не запускались и test records не получали. Оригинальные audio не изменялись. Dirty baseline/index сохранены, reset/clean/commit не выполнялись.

**Reused closeout evidence:** JD608/50 и227/15, W1 six-suite72, I1 Hermes1685 modules/prebuild23, C0 live GET/schema/source match и D1 audio census; это не R1 reruns. **Historical pre-closeout:** backend543+56subtests/bot33/web75, прежние lint/export/independent race checks/server release; не объявлены текущими executions. G3/G5/R2 остаются открытыми.

## Собственные артефакты

Все relative paths ниже — `/tmp/puuk-ma-close/task_caca75cf61e5/`; raw DB не публиковать: копии могут содержать приватные application tables. Старые input snapshots/scripts других Tasks не изменены. Version: Python3.14.8; repo base и hash manifests выше; команды выполнялись из `/home/fish/projects/puuk`, внутренние CLI — cwd `brain/`.

| Artifact | Что доказывает |
|---|---|
| review_data.py, sitecustomize.py, data-review.json | Собственные13 commands/4copies; command/cwd/UTC/exit, source hashes, precise deltas/guards; socket connections запрещены. Rehearsal07:22:51–07:22:56UTC, exit0. |
| roundtrip.db, conflict-undo.db, conflict-apply.db, stale-report.db | Reviewer-only copies; новые локальные operation IDs не переносить в production. |
| review_candidate.py, candidate-review.json | Source/archive/HEAD diff/deps/JD/export checks,07:23:19UTC, exit0. |
| wave/harness.py, wave/source-tree link, wave/results.json, wave/run.log, wave-replay.json | Unmodified frozen W1 harness в своём output dir; copied captures;07:23:56–07:23:57UTC, exit0, exact semantic hash. |
| audit_evidence.py, evidence-audit.json, fresh-report.json |70 artifact hashes,241 report,210 rows/1637 penalties;07:24:58UTC, exit0. |
| final_audit.py, final-audit.json | Текущая retry:11:18:46UTC, exit0; сохранность copies/source, текущий F1 drift и corrected inventory/device matrix. |
| dispatch.json, retry-dispatch.json | Старый и текущий authoritative Dispatch/projection observations, без подмены launch provenance. |

Полные SHA256 собственных артефактов и финального report сохраняются в final-receipt.json после записи; долговечное содержательное резюме и все решения находятся в этом документе.
