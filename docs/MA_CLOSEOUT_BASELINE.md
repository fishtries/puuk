# C0 — актуальный closeout baseline

Снимок C0 от 2026-10-29, UTC; cwd `/home/fish/projects/puuk`. HEAD `671be2ff8bf2d89a1bc11766d18f62b4faebe5a5` — **не идентификатор dirty-кандидата**. Полный проверяемый состав ниже и в manifests; исходники, audio, build/signing config и production этим Task не изменялись.

**Результат: исходники feature не дрейфовали после принятого финального review; сервер работает на совпадающих файлах/schema12. Подписанный iOS кандидат и device acceptance пока не подтверждены.** Этот отчёт закрывает только C0, не G3/G5.

## Источники и граница baseline

Прочитаны AGENTS.md, инструкции brain/iOS, docs/ORCHESTRATION.md, docs/AGENT_ORCHESTRATION.md, frozen MULTI_ARTIST_CONTRACT.md и MA_* release/review/run reports. Использован `orca` (`/home/fish/.config/orca/linux-orca-cli-shim/orca`), гайды установленной версии orchestration/orca-cli и read-only discovery orca-emulator. Код iOS не писался, Expo docs/code-change gate не активировался.

Принятая версия: `/tmp/puuk-ma-baseline/feature-changes-final.json`, SHA256 `636c3923a44a4cfabfff0aa16fe171b917c59e7cf16c79b0f0b3d22eec78fb10`. Содержит 106 путей: 31 iOS, 45 brain, 4 bot, 26 docs. Это accepted hash inventory, а не git commit; pre-feature dirty tree хранится отдельно в `/tmp/puuk-ma-baseline/tree`.

На 2026-10-29T06:56:09.404922+00:00: **80/80 iOS/backend/bot путей совпали**, 3 изменения только в документах. Это конкретный нулевой source diff относительно accepted inventory, включая hook/controller/tests, прошедшие финальный review. Следующие пары фиксируют весь обнаруженный hash diff:

| Файл | Принятый SHA256 | Текущий SHA256 |
|---|---|---|
| `docs/MA_ROLLOUT_PREPARATION.md` | `f35567bd43de30da6767d64d28316a5950fee96a1f2efcb8855f7e516322e094` | `cdcf588cadda5cad194bcd4eb14dbcfc086929c4cda70d39a8fa3805e8078671` |
| `docs/MA_RUN_REPORT.md` | `dd6b6a1dc55771dd8d333057397f4859816dc20b9e5b7ab5dbd60bf04a930329` | `f61a14c0aeae250c6d6759e1023566016d10909212fe9c9eaab92752a2bcd612` |
| `docs/MULTI_ARTIST_ORCHESTRATION_PLAN.md` | `3d52ea4fca743bcbb5da96194b045300d14474182229c93e6e036f90b9a8c462` | `80943a788484ba006b784c4445a43201762cabcf109538aca9cd8fc890435975` |

Текущие тексты этих документов содержат операторский серверный выпуск, обновлённый статус и продолжение closeout Run. Accepted inventory сохраняет старые hashes, но не старые байты документов: точный построчный diff этих трёх текстов не восстановлен и не выдуман. Новые вне inventory документы `MA_SERVER_RELEASE_REPORT.md` и `MULTI_AGENT_ORCHESTRATION.md` учтены отдельно. Сам данный C0 report также новый.

## Dirty baseline и состав кандидата

Первый git census: 130 dirty paths = 106 inventory + 22 предшествующих dirty paths с теми же SHA256, что в pre-feature tree + 2 новых coordination/release docs. Полная классификация с обеими hashes — `dirty-classification.json`. Нет неизвестного source drift вне inventory. Предшествующие изменения сохранены; их присутствие в рабочем дереве не превращает их в новые multi-artist изменения.

Следующие 22 пути уже были dirty и побайтово не изменились относительно pre-feature tree:

- `.gitignore`
- `app/ios/puuk-ios/components/fullplayer/__tests__/FullPlayerControlsAndMenu.test.js`
- `app/ios/puuk-ios/components/fullplayer/playerStyles.js`
- `app/ios/puuk-ios/features/albums/__tests__/AlbumScreen.test.js`
- `app/ios/puuk-ios/features/search/SearchScreen.js`
- `app/ios/puuk-ios/features/search/__tests__/SearchScreen.test.js`
- `app/ios/puuk-ios/shared/media/CoverImage.js`
- `app/ios/puuk-ios/shared/media/__tests__/coverImageUtils.test.js`
- `brain/api.py`
- `brain/config.py`
- `brain/requirements.txt`
- `brain/test_phase1.py`
- `brain/test_track_recovery.py`
- `docs/AGENT_ORCHESTRATION.md`
- `docs/ARTISTS_SECTION_ORCHESTRATION_PLAN.md`
- `docs/ORCHESTRATION.md`
- `docs/design/DESIGN.md`
- `.opencode/agents/junior-deepseek.md`
- `.opencode/agents/junior-gemini.md`
- `app/ios/puuk-ios/features/artists/ArtistArtworkEditScreen.js`
- `app/ios/puuk-ios/features/artists/__tests__/ArtistArtworkEditScreen.test.js`
- `brain/migrations/011_artists.sql`

iOS candidate manifest охватывает **136 Git-visible inputs** и отдельно **17 ignored/generated native files**. Включает assets, package/lock, scripts и source/tests; node_modules/build/Pods и credential material не входят. `deployment-source-manifest.json` содержит 127 Git-visible backend/bot `.py/.sql/.sh/requirements.txt`: **127/127 совпали с сервером**, включая все 49 feature backend/bot paths. Проверка source files не является криптографическим доказательством содержимого уже импортированных модулей в памяти процесса.

Package/lock, app/eas config, unsigned workflow и оба deploy scripts побайтово совпадают с HEAD. Предшествующие `brain/api.py`, `config.py`, `requirements.txt` остаются dirty относительно HEAD и также совпали с сервером; это важно для release allowlist. Проверка deployment manifest не охватывает secrets/config env, venv, untracked remote-only files, live DB или Qdrant payloads.

| Вход | SHA256 |
|---|---|
| `app/ios/puuk-ios/app.json` | `2d9647b0f3449a2d219cc0a3c381390a61f77fcee66252f13bc248730950dc5c` |
| `app/ios/puuk-ios/eas.json` | `9b6965165da103bedab4a0037760dcb264b85d18cb6380fe05528383ed9c8c49` |
| `app/ios/puuk-ios/package-lock.json` | `ce053ceebfa85250e4a0008e9f8508faa71624fe2375674fd00b587b96d75bcd` |
| `app/ios/puuk-ios/package.json` | `08c89f2445cc1f1f94c642634dcead08333b7f46c06c676ed6b6c9e4f858d3a5` |

## Live Run / Tasks / resources

Runtime Orca 1.4.229 ready/reachable; Run `run_ea37b46b2dc1`, coordinator `term_b4e61a99-aaea-4e84-9476-c4f637e6ac6c`, generation 2, legacy=0. Worker не создавал/не переназначал Run и не выполнял takeover. Census `2026-10-29T06:58:56.476172+00:00`: **29 Tasks: 19 completed, 3 dispatched, 6 pending, 1 blocked**. Это снимок перед собственным worker_done; последующее состояние меняется только авторитетным settlement.

C0 live dispatch `ctx_c54383d25eae`, Task `task_71204012505f`, live injected terminal `term_61f74923-e26c-44bb-84ce-35dfd5bfe106`. Initial `C0-start.json` coordinator receipt: `launch.requested == launch.effective == {agent:codex, model:gpt-6.1-sol, effort:high}`, тот же terminal; первая попытка failed/readiness timeout. Вторая `ctx_a26898f445c7` тоже failed/readiness. Текущий Dispatch context_only/unsupervised, failureCount=2, projection provider gpt-6.1-sol, live agent_status; terminal preview подтверждает high. Текущий context-only receipt сам не содержит launch.requested/effective, поэтому новый supervised launch не заявляется.

31 Dispatch row: 19 completed, 8 failed, 1 historical circuit_broken, 3 dispatched; page.hasMore=false. Reclaimable rows нет. Верхнеуровневый terminalState=retained сам по себе не доказывает живой terminal или выполненный human retain: ниже приведён именно projection.resource. `absent/unsupervised` требует отдельного решения координатора по операторскому терминалу; external rows не дают Orca ownership процесса. C0 не выполнял release/close/retain.

| Task | ID | Текущее состояние/outcome | Последний Dispatch; projection.resource |
|---|---|---|---|
| ma-contract | `task_f8bf892de845` | completed/succeeded | `ctx_d1f188053cb8`; absent/unsupervised |
| ma-storage | `task_097dfdb05e65` | completed/succeeded | `ctx_b2b3a53a8f6e`; absent/unsupervised |
| ma-ios-data | `task_9c3234d7a6d1` | completed/succeeded | `ctx_cb61eda964f4`; absent/unsupervised |
| ma-api | `task_a62aa07ea4ab` | completed/succeeded | `ctx_a956f3e78620`; external |
| ma-import | `task_f6c057c76aa7` | completed/succeeded | `ctx_786f4fcf0139`; external |
| ma-recommendations | `task_f1e10b8fb813` | completed/succeeded | `ctx_043acd08baad`; external |
| ma-bulk | `task_bf78e9c81861` | completed/succeeded | `ctx_1530b47cd7a3`; absent/unsupervised |
| ma-ios-navigation | `task_92f24ac9faed` | completed/succeeded | `ctx_1a38de9f8d5d`; absent/unsupervised |
| ma-ios-editors | `task_83d3d508866c` | completed/succeeded | `ctx_86c884053194`; external |
| ma-ios-bulk | `task_b9b11f7e9109` | completed/succeeded | `ctx_2eb4e45d4f1d`; external |
| ma-integration | `task_24c83f55be83` | completed/succeeded | `ctx_77f5c2a88b47`; external |
| ma-review | `task_85bf67db8ba9` | completed/succeeded | `ctx_b37d9a9ae27d`; external |
| ma-bulk-fixes | `task_d2e730d94e54` | completed/succeeded | `ctx_d08260fba2a3`; external |
| ma-import-test-path | `task_7b564a16d08d` | completed/succeeded | `ctx_995d9e1a5ed1`; external |
| ma-api-merge-fixes | `task_ad39375c9600` | completed/succeeded | `ctx_c61ed22aafbf`; external |
| ma-fixes | `task_fbe5f56678f6` | completed/succeeded | `ctx_97ea508371d7`; absent/unsupervised |
| ma-recheck | `task_9cb9f733e6e3` | completed/succeeded | `ctx_815b84d96d95`; absent/unsupervised |
| ma-ios-request-bound | `task_af916cdf3800` | completed/succeeded | `ctx_5cb00e5be20e`; absent/unsupervised |
| ma-final-request-review | `task_03932114f05b` | completed/succeeded | `ctx_7dcf84730e14`; absent/unsupervised |
| closeout-C0 | `task_71204012505f` | dispatched | `ctx_c54383d25eae`; absent/unsupervised |
| closeout-JG | `task_38ce073fbcfd` | dispatched | `ctx_bc72bfc424cb`; external |
| closeout-JD | `task_c2270b3a8a20` | dispatched | `ctx_e71f78d5f7a9`; external |
| closeout-D1 | `task_2982c40d055e` | pending | не назначен |
| closeout-I1 | `task_a292bf0da3dd` | pending | не назначен |
| closeout-W1 | `task_e8fc3870afc0` | pending | не назначен |
| closeout-R1 | `task_caca75cf61e5` | pending | не назначен |
| closeout-D2 | `task_1d86c7145d60` | blocked | не назначен |
| closeout-I2 | `task_96247c1b274a` | pending | не назначен |
| closeout-R2 | `task_0870895dfb3f` | pending | не назначен |

Historical failed attempts и release/user_takeover retained accounting полностью сохранены в `workers-final.json`; circuit-broken `ctx_f9b281f642f5` имеет resource=released. Не использовать их capabilities для completion. Historical journal «all19 completed» относится к предыдущей фазе, не текущим 29 Tasks.

## Текущая read-only проверка сервера

SSH BatchMode на `fish@192.168.1.117:59348` доступен. `remote-readonly.py` исполнен по stdin/code только в памяти без записи remote script; receipt `2026-10-29T06:55:42.470255+00:00` → `2026-10-29T06:55:43.516589+00:00`, exit0, Python 3.13.5. SQLite connection `mode=ro`, `query_only=on`, короткий согласованный read transaction; business write, deploy, scan и migration не запускались.

| Наблюдение | Текущий результат |
|---|---|
| SQLite | schema 12, WAL, tracks 1198, albums 893, artists 923; integrity=ok; FK violations=0 |
| system puuk-brain | loaded/active/running; MainPID 2473651; start Wed 2026-10-28 09:58:31 MSK |
| system puuk-telegram-bot | loaded/active/running; MainPID 2473673; start Wed 2026-10-28 09:58:32 MSK |
| local heavy_worker | PID2593306, cwd `/home/fish/projects/puuk/brain`, executable Python3.14; read-only /proc census 2026-10-29T06:54:17.665451+00:00 |
| API GET, localhost и публичный HTTPS | `/api/tracks/<id>?credits_only=true`, `/api/albums/<id>`: 200, artists array и revision присутствуют; `/api/artists?limit=1`: 200 JSON |
| Discovery routes | localhost `/api/health` и `/openapi.json`: 404; public health404, public openapi200 text/html (SPA fallback), **не OpenAPI schema/health proof** |
| Qdrant read-only GET /collections/tracks | HTTP200/status ok/collection green; points_count 1213; system qdrant unit not-found, отдельный qdrant PID этим census не установлен |
| Writer census | server API и bot в одинаковом mount namespace; доступных Puuk scan/heavy_worker процессов на сервере не обнаружено; отдельный heavy_worker локален |
| Исторический backup | preflight.db и before-release.db по 3,788,800 bytes, code-before.tar.gz 298,302 bytes по прежнему release path существуют; это проверка наличия, не новый backup/restore test |

Авторизованные GET использовали прежний диагностический способ: короткоживущий JWT существующего admin только в памяти процесса, без записи/вывода credentials. Проверка не отправляла PUT/PATCH/POST/DELETE и не проверяла новую успешную business write. PID/counts выше получены заново, даже если PID совпал с историческим; historical post-release1198/892 не подставлялся — сейчас1198/893. /proc census видит только доступные процессы и не доказывает отсутствие любого внешнего SFTP writer. Writers не приостанавливались.

## Доступные пути build/install/control

| Средство | Доказательство / доступность / ограничение |
|---|---|
| Local host | Linux7.2.11; Node26.12.0/npm12.2.1. xcodebuild/xcrun/security/sw_vers/pod отсутствуют; local native iOS build и Simulator недоступны |
| iOS identity | app/package version1.0.0, buildNumber1, bundle com.fishtries.puuk; ignored native pbxproj marketing1.0/current1/target16.4. Generated native tree учтён отдельно, не считать его автоматически пересобранным/актуализированным |
| Dependencies | installed Expo58.0.19, RN0.88.0, React19.3.0, jest-expo58.0.12; package-lock hashed. Нативные patch scripts входят в candidate manifest |
| GitHub Actions macOS | Существующий workflow macos-26/Node22/npm ci/prebuild/pod/xcodebuild unsigned archive. Public REST GET подтвердил latest successful run40489109206 от 2026-10-27, head671be2f… = HEAD до multi-artist dirty изменений; **не текущий кандидат** |
| Existing unsigned IPA | artifact12729091715, 13,082,850 bytes, expired=false на момент GET, expires2026-11-03T10:45:16Z; artifact archive digest sha256:ddf5f92e3b497b9344f17252c0b676bcd628c793480676a23bf1187f301d663b. Это digest архива GitHub, не проверенный внутренний IPA SHA; download/install не выполнялись |
| CI authority | gh workflow/run list exit4: CLI не авторизован; public REST metadata read доступен. Новая workflow dispatch/publication не выполнялась. Workflow имеет write/push status branch, поэтому запуск не является read-only проверкой |
| EAS | eas CLI/local cached eas-cli не найдены; credentials.json не обнаружен; существующий eas.json development/preview оба simulator=true, production autoIncrement. Фактическая EAS account/build/signing доступность не подтверждена; build не запускался |
| Signing | В inspected native project нет configured DEVELOPMENT_TEAM; usable signing identity/provisioning не подтверждены. Signing material не читался/не экспортировался; отсутствие локального credentials.json не доказывает отсутствие credentials у владельца или в build service |
| Physical device | idevice_id -l exit255 Unable to retrieve device list; lsusb не показал iPhone/iPad. Рабочий pairing/install/control path не подтверждён; это не доказательство отсутствия телефона у владельца |
| Orca device/control | emulator devices exit0 []; emulator list exit1 spawn serve-sim ENOENT. host list: Linux local и disconnected github.com SSH; saved environments []. Подключённый Mac/Simulator не найден. Гайд Orca требует owning macOS/Xcode simulator host; attach/input не выполнялись |
| Install routes | После candidate-native build: simulator .app → simctl install/launch на Mac и local Orca emulator attach/ax/tap; для physical device нужен подписанный compatible artifact и paired installation path. Ни один этот путь пока не выполнен; unsigned iphoneos IPA не simulator .app и не доказательство возможности установки на stock iPhone |

Ссылки read-only metadata: [исторический CI run](https://github.com/fishtries/puuk/actions/runs/40489109206), [workflow REST census](https://api.github.com/repos/fishtries/puuk/actions/workflows/build-ios-unsigned.yml/runs?per_page=5). Последний успешный CI build показывает работавший тогда macOS build service, не текущую write authority или сборку dirty-кандидата.

## Passed / failed / not tested / historical

**Passed в C0:** current hashes/classification, Run/Tasks/resource census, 49/49 feature и 127/127 полного проверенного server source subset, schema/integrity/FK, authenticated GET на двух origins, Qdrant GET, backup presence, public CI/artifact metadata. Команды/cwd/start/end UTC/exit codes сохранены в receipts; source version = HEAD плюс manifests ниже.

**Failed/ограниченные диагностические проверки C0:** gh list exit4 (нет login), idevice_id exit255, emulator list exit1 ENOENT. Первые remote diagnostic passes имели TypeError от integer ID и AttributeError от ошибочного разбора track.album; исправления только в собственном probe, сохранены `remote-attempt-type-error.json` и `remote-attempt-parser-error.json`; финальный GET probe прошёл. Это ошибки диагностического кода, не доказательство backend regression. Отсутствующий README дал rg exit2 при раннем discovery; итоговые build сведения взяты из фактических config/workflow.

**Historical evidence, заново не исполнялось:** финальный MA_FINAL_REQUEST_REVIEW: 608/50 Jest, lint, 1685-module Hermes export; независимые30+4+8 race probes и old8→fixed4; backend543+56subtests/bot33/web75 в прежних отчётах. Соответствующие final-request logs существуют и hashed в historical-evidence-manifest.json; сохранённый final review `.hbc` SHA256 `8068bcceea5b80a5a92dfef2f0e78d88a8c9d2b8a92f31ef17d963730ffcace9`, size4,626,791. Это JS artifact. Repo `dist` содержит другой `.hbc` SHA0032efed… и не заменяет reviewed export; происхождение этого dist не подтверждено.

**Дополнительная текущая проверка другого worker, не rerun C0:** JD log `/tmp/puuk-ma-close/JD/jest-full.log`: `./node_modules/.bin/jest --ci --runInBand`, cwd iOS, 2026-10-29 09:57:38–09:57:44 MSK, exit0, 608 tests/50 suites. C0 прочитал log и сверил все24 hashes из JD source-hashes.txt — совпали. Receipted в supplemental-jd.json; settlement JD остаётся ответственностью координатора. Полные iOS suites не повторять без нового source drift.

**Not tested в C0:** новые suites/lint/export (не нужны для read-only snapshot без source drift), native candidate build, signing/install, device/simulator launch, playback/no audible restart/seek/queue, background/lock screen, VoiceOver/large text/long lists, 5000-preview performance, listening quality, production corrections и undo, fresh backup/restore/rollback, writer-quiescence и mount/lock coordination end-to-end. C0 не закрывает обязательные T19/T20/T21 device cases.

## Что повторять дальше

1. **Из source drift — ничего:** все80 feature source/test paths совпали с accepted inventory; три docs hash changes не требуют повторять полные backend/iOS suites. Перед I1/R1 пересверить manifests: shared tree продолжает жить; новая source/dependency/native patch правка требует целевых регрессий и пересборки кандидата, затем затронутых device cases.
2. **По current artifact gap — обязательно:** I1 формирует candidate-native spec из 136 inputs/17 generated inputs, разрешает происхождение generated native tree и отличающийся dist, фиксирует Node22 CI versus Node26 local, использует текущие JD validation receipts без повторения suites при отсутствии нового source drift и выполняет candidate build/export по своему scope. Новая native сборка с точным manifest нужна: исторический CI собран из HEAD без feature dirty diff. До build определить доступную write authority, Mac/build service и signing путь; usable provisioning пока неизвестен.
3. **По live data drift — обязательно:** сейчас albums893 против historical892 после выпуска, а не прежний schema11 snapshot1149/891. D1 должен получить свежий согласованный snapshot/report/selection revisions; прежние5 selections и operation IDs не переносить вслепую. Перед любой разрешённой data write/новым deployment заново census writers/counts, backup и conditional undo/restore preparation; C0 GET не заменяет эти gates.
4. **По device gap — обязательно:** I2 выполняет actual installation/playback/position/queue/background/accessibility/editor conflict/large-preview matrix. Mock Jest, export и старое пользовательское подтверждение Expo Go на iPhone11Pro/iOS18.6.2 из другого refactor этапа не являются текущими доказательствами.

## Артефакты и воспроизведение

Все собственные receipts/scripts: `/tmp/puuk-ma-close/task_71204012505f/`. JSON manifests сохраняют exact paths и SHA256; исключены env/signing secrets. Для reproduction коллектора: `python /tmp/puuk-ma-close/task_71204012505f/collect.py`; remote GET/schema probe: `python /tmp/puuk-ma-close/task_71204012505f/run-remote.py`; полный source match: `python /tmp/puuk-ma-close/task_71204012505f/deploy-source-check.py`; resource/device census: `python /tmp/puuk-ma-close/task_71204012505f/final-census.py`. Эти команды read-only к репозиторию/production; пишут только собственные receipts. Изолированные tests не запускались, поэтому тестовых записей SQLite/Qdrant/бот/scan не создавалось.

| Artifact | SHA256 | Назначение |
|---|---|---|
| `feature-manifest.json` | `65fb2dcb4f1cd6116b1d8e0005ddb2267e06259187558acb3a4ba278a57c4298` | 106 accepted/current/base hashes + explicit drift |
| `ios-candidate-manifest.json` | `8ec89dd7a992f996f4f52c9c6698c93d46bbcf3c21be05f737ab3f57910ff129` | 136 Git-visible +17 generated native hashes |
| `deployment-source-manifest.json` | `76060b843a4f88511ce7565d835de80b23d441d66de0653757fc30c1be7ec749` | 127 local/remote hashes + SSH receipt |
| `dirty-classification.json` | `8b4118fd238ef92fcad845981e55636644da6aab43eb32bed67609fd9adf73fa` | dirty paths and pre-feature equality |
| `historical-evidence-manifest.json` | `b056a642e51b334a33696a7a23ec51d3b5ea77bebd91e4aabc20f734bcdcba89` | MA reports and historical final logs hashes |
| `build-baseline-comparison.json` | `ea411020c42336a96d1fab51c80953be6c48558c2d76248b394576737cf981e6` | config/deploy vs HEAD/pre-feature |
| `remote-receipt.json` | `2e28a408cdd7422b4564a488a4935cd57d89442e641ef0d45c49e576d935ab92` | current schema/counts/units/API/Qdrant/backup |
| `tasks-final.json` | `02c18c97fb065a8bd53196d20408d38286c53afa842b44fc89f76aa003a30019` | 29 Tasks status/outcome receipt |
| `workers-final.json` | `0135920454aff6dec2ddbb6093c7fafb669e09f185a86ad7385bc678ee12499a` | 31 Dispatch/resource rows, all pages |
| `run.json` | `abeaa8b08c5943819aca2c0268c56d997627b23043228b2a1594eeade667b247` | Run coordinator/generation/legacy receipt |
| `dispatch.json` | `8ef5872abe3f79e50a04afb3c513bb33f6470e0492a12b11ab843bd6fa75cd99` | live context/provider/resource receipt |
| `build-details.json` | `48cea4795c4049741089f2edf2306d90817d1a39aedf2729e7e178afc4774caa` | native identity/dependency/artifact/service metadata |
| `github-artifacts.json` | `956fd071ffcd1959dd182fc9ab3a4fa773c5a2258edf43f87d4344761a9d02ca` | public artifact metadata, historical build |
| `supplemental-jd.json` | `8963fe187544a5d5e7d526daf7df6b8c66df200793fa75f87f5812358559537c` | current JD 608/50 receipt and24 matching source hashes |
| `tools.json` | `aa43e5c0ba637c5db017ff45f2b85722d176955467752b9424ad1397c78eed4b` | local tools/availability only |
| `local-writers.json` | `78209fa0341fceb018d1e5d6eb8451f84d2d6e7079ee829665186618aff4f7ac` | current local writer census |
| `orca-hosts.json` | `cb370fc4d1b42239a6824ecc1d7c5272822d50aa99072c74fe9d29234b0351be` | available host routes |
| `orca-environments.json` | `ddcb6f2bb9a0305bdf68d69a98117568875d11f8d9e1c965aeb8abd8ff898c80` | saved environment census |
| `orca-devices.json` | `dac797d7c9228223424fa56fb0146cd5e42008fddc80d3093dca09c45dd27f81` | devices empty |
| `orca-sessions.json` | `34ed0703ca12dc9518ea9a37b2d2e40d358eda621cc3bee975f6482a4396b66c` | serve-sim ENOENT |
| `github-runs.json` | `c9fba4bed1da66db667990a441c8174a12ae55e9428345c92560364d2695a6c6` | gh authentication failure |
| `ios-devices.json` | `c937f7fb5f284a1c56dd6558405202a161c4beff149005fbb471d027c92cb8ce` | device listing failure |

Финальная собственная проверка `final-verification.json`: 360 hash assertions по feature/iOS/native/deployment inputs, source drift=0; `git diff --check` exit0. Artifact фиксирует source version, время и финальный report SHA256.

Остальные собственные артефакты: collect.py, remote-readonly.py, run-remote.py, deploy-source-check.py, final-census.py, write-report.py; git-head/status/diff-stat, orca-status, initial tasks/workers, node/npm/usb/ssh-config-aliases/github-workflows receipts и два failed diagnostic receipts. Initial launch receipt остаётся в `/tmp/puuk-ma-close/coordinator/C0-start.json` (прочитан, не менялся). Собственные /tmp receipts не backup; долговечное резюме и hashes feature ниже находятся в этом repo report.

## Полный current feature manifest

SHA256 каждого из106 accepted inventory paths на момент C0; baseline/accepted hashes и drift flags — в feature-manifest.json. Дальнейшие изменения docs другими owners возможны; время снимка выше.

| Путь | Current SHA256 |
|---|---|
| `app/ios/puuk-ios/App.js` | `c0dd89903c957b157ff0579fd4ed833a4394d2dcb6137405505d075d6cb6b7b5` |
| `app/ios/puuk-ios/components/FullPlayerModal.js` | `c32d4539b49d065feb3fb2245d93eaf161c686a1ec1659e11dd091f2dc76f589` |
| `app/ios/puuk-ios/features/albums/AlbumEditScreen.js` | `3e4279673a9efb7a45155fd923ca745603856b1c77fcfcd6be1e32e5008dded4` |
| `app/ios/puuk-ios/features/albums/AlbumScreen.js` | `ba019641c194f66ed2ffb9c442fbdcd22e98bdb0505750fa57e698f7907cee44` |
| `app/ios/puuk-ios/features/artists/ArtistCreditBulkScreen.js` | `1e889458b828f92aecf8530e881923db6b8477d6bd444cbe544b8aa5c4279e52` |
| `app/ios/puuk-ios/features/artists/ArtistScreen.js` | `8976db88ed10eb85a0fea74dd2967f25724ce346c2b077ad5ea4173950992593` |
| `app/ios/puuk-ios/features/artists/__tests__/ArtistCreditBulkScreen.test.js` | `b1a526afa36283cf1a53db30270d37825f85b33ac3582a6f2c1d7d4d1d20bf3b` |
| `app/ios/puuk-ios/features/artists/__tests__/ArtistScreen.test.js` | `e5d6a4c19e65e24b69d10e10a3ec2f7fc9006268a2276c01278a01f7a0e430a3` |
| `app/ios/puuk-ios/features/library/TrackEditScreen.js` | `5d18583bb9d9aca4557d4b3c586a91c4c6cbf0b565d8dcc9dcb79ad1178943ad` |
| `app/ios/puuk-ios/features/library/__tests__/CreditsDraft.test.js` | `2515c667edd7d5ec73896237926394b8d0b8c6745d86577ed6bc3a15883f872c` |
| `app/ios/puuk-ios/features/library/__tests__/TrackEditScreen.test.js` | `c18d09fbea636643aa55f17eafc97863da9da493d6f5501cb20d9040383d1130` |
| `app/ios/puuk-ios/hooks/__tests__/usePlayerController.test.js` | `2730db225c5057db429f06814faea8188a59c3dd093449a25b92da98d8a6b97f` |
| `app/ios/puuk-ios/hooks/__tests__/useSavedCreditsSync.test.js` | `b7226c539412e2b27ef954a5b4d83444551382ac0a47f934a20bd84e7388962b` |
| `app/ios/puuk-ios/hooks/usePlayerController.js` | `7e6d24e5afc6d9d8c96941bc5fe062d608df31d6fe4ead83ff48b71e35d910d5` |
| `app/ios/puuk-ios/hooks/useSavedCreditsSync.js` | `946dbcb26b76cc3a5b0ed26cd8ec184636061a7193ff048eff5116c2f2488379` |
| `app/ios/puuk-ios/navigation/RootNavigator.js` | `81e6858ad7e237778ac4fdbaf7df68546baff8bf67e4d573383df1c824b494d0` |
| `app/ios/puuk-ios/shared/api/__tests__/apiCache.test.js` | `20fdc263944858648bf7e2bb68d725582542b50790c97c4984fbe2f1c341120c` |
| `app/ios/puuk-ios/shared/api/__tests__/artistCredits.test.js` | `80ad07671ebc20d3ee4008f7f64b60e028af4f8f5fbd42e3823674913086bb20` |
| `app/ios/puuk-ios/shared/api/__tests__/artists.test.js` | `5cc506e6042dff2dc550b473d8a8c5d06c61816ee38157267dd43c48d5b2a60f` |
| `app/ios/puuk-ios/shared/api/apiCache.js` | `f889f133f4089d2c9c0d4776c8e256df9552dae79c1a8a24f1d81b6cd7a4cf89` |
| `app/ios/puuk-ios/shared/api/artistCredits.js` | `5c6781dd2c4176d8998ed53c296111d1e5b52598296a0ee5eb2906c1f7294e4f` |
| `app/ios/puuk-ios/shared/api/artists.js` | `224abd7b4ea804a357b6378002cf801863f3d0e0d9d6b8eaf8b51424543c9c99` |
| `app/ios/puuk-ios/shared/components/ArtistCreditsEditor.js` | `9b23afd0622849ad50a9232760ae0754fc09c082422c9f8bd80d825aec0251fd` |
| `app/ios/puuk-ios/shared/components/ArtistSelector.js` | `d3bc347691c764c97cbd0d3d5efcc5c81de12263b2b94d591283fae90b19c212` |
| `app/ios/puuk-ios/shared/components/__tests__/ArtistCreditsEditor.test.js` | `22dfe2d6518f324cdb0a239316fc3cd97afaf0cb0febe30180399db9c7f65aa9` |
| `app/ios/puuk-ios/shared/components/__tests__/ArtistSelector.test.js` | `5f5b11ea745025050030d87e3e85565f87ae807eb622997ba6db6a0ca3b33076` |
| `app/ios/puuk-ios/shared/domain/__tests__/artistCredits.test.js` | `925c4212af9f845acf1cb55eb0fa4eadf9ea9d5e9acbc496a3fe6f20b10933a2` |
| `app/ios/puuk-ios/shared/domain/__tests__/trackAdapter.test.js` | `225ce8152cea7a30a3b5132ab452096d791a3b1c1174daad1def129726baea11` |
| `app/ios/puuk-ios/shared/domain/artistCreditEvents.js` | `f0e0355128ac4627d9241dd171e19c8f30354b0e6e14e92d8b7cc508deca1c85` |
| `app/ios/puuk-ios/shared/domain/artistCredits.js` | `1e7a744056c71b7872e53f536a4452bcf291962368dcd811bb24bbd372267cee` |
| `app/ios/puuk-ios/shared/domain/trackAdapter.js` | `21ad0f872e7a12bea37057e53a50a6b54f0f9e7db5fbaa4b9d08151fd2aafdad` |
| `brain/heavy_worker.py` | `705b7dd5766e9b76606e20a7b5a09c307ddce3d6db4a3c9c5076358e7d4fdaac` |
| `brain/metadata.py` | `85db970577c86bdae813575a3f27ad5246043a26e03354185bacfd2cf11ff19a` |
| `brain/migrations/012_artist_credits.sql` | `cf82ba88baffdc6ffdde2b573be81c347608953e10f43828f82b07363eb5bcc4` |
| `brain/reconcile_artist_credits.py` | `09fd0e129a0aeb4ba887b41a7ea5c9e5258467cb639dd78cf458742f900e755c` |
| `brain/repositories/albums.py` | `fc374c2195f02e08d4f30bea2ef9e08c24bf18f2e1a369fee8e6255598c50adc` |
| `brain/repositories/artist_credits.py` | `b72a98488e0c485b4c4d6b0e12d24142338add50abe270854e27aa55b61aeda9` |
| `brain/repositories/artists.py` | `3a65ba57eaf193faff2386c3d7fe8bb3ca730b8faa09f99378ee6df6931b52ca` |
| `brain/repositories/interactions.py` | `458ad9a66c3b198359ee347a5e20f31c372335a0a5760f9de8278eeb7a0e3bca` |
| `brain/repositories/playlists.py` | `39f79125a807332c9f3f176d7af6c471d8023033e88a6cade04871d1d5168d5f` |
| `brain/repositories/schema.py` | `c98df3bbaee67326a85d33c07dc2b7efd96b09884f1c40432fc86d00766ac123` |
| `brain/repositories/tracks.py` | `43b911d958e0b88fdfda677fdbc56cdb9ba248db81ce7d6ff8dd7db8a2b518af` |
| `brain/repositories/wave.py` | `78a20d72d3376a57c94780acbb03d00b4f944c8bf98450105fa5b895c5a0c6f0` |
| `brain/routers/albums.py` | `61a627c4315adc5b6022808edaf1716ebb24e3f5ae2971af7d82365642e3be3e` |
| `brain/routers/artists.py` | `2215a04b1ee41427daf2a9bbb258ec96d95cb8c0f22ae793be0b3e00b6c1687b` |
| `brain/routers/search.py` | `0a689553c27db02de49efde4429a28b93fa56568157babb63b638b2d633b1ad6` |
| `brain/routers/tracks.py` | `cde8c912f1c694f1990e47d4d0fdfbeaff4e48a26d948bd075cb97d4e37d886a` |
| `brain/scan.py` | `87c0dfbaf3ff9f39e481bca001e1265507742384bbacbb5147cab49ce453107f` |
| `brain/serializers.py` | `60117f4e1a37e8f7f49790a9b6196dc43f1b00529b88bed72250ebb3836e5c32` |
| `brain/services/album_service.py` | `2175de35c0c65fd83b3d55f85954d85345de1adb5a81b60311fd1f18841c2b5f` |
| `brain/services/artist_credit_bulk_service.py` | `b1158599d556e3e11cf104ca748f6d4c0f97d240a3f3651a16f01b83be804fe2` |
| `brain/services/artist_credit_lock.py` | `27dd0ca51c121af3888498eb95ea6600d79ff71f4ad7a0e45274538021b98102` |
| `brain/services/artist_credit_service.py` | `916ae05501ed5887a6d48164048e94e5f263fb727dd6337d70b18884a0265d54` |
| `brain/services/embedding_queue_service.py` | `dfd9daae9dabf9cb1b47ae4e21dad571bb0eb1d9fa90fe7096820a27e0b53e53` |
| `brain/services/library_service.py` | `0c41e68a8236cf8eb59f09fe68f7ed143b6b0f54ef1b96d0015f9341043cc804` |
| `brain/services/media_locations.py` | `030a89c5bc035a672c17b6eb6b9748d1b73e672cd475aaecbe1ec248bd4ba4ea` |
| `brain/services/personalized_recommendation_service.py` | `9d6e22da5828abaf51a2aadf703d873478222baa27c3c7963944a83d23365ac7` |
| `brain/services/recommendation_service.py` | `fc0e3d978860e744ef0b72ec2759a8bf702610f53aa0b9bcdaeeadd9a4c6e118` |
| `brain/services/track_metadata_service.py` | `f21788e282e41640e6181fe7acdd4a1fc070ab8d2e42392c69170c0813f9406b` |
| `brain/test_albums.py` | `eb3af638e432e7f6ab189929c8f879c8a78cb461c09f247d02273b88689a46e1` |
| `brain/test_artist_backend_hardening.py` | `072145b30ee360feb30a2cbee559280d1bbe08024138eb9ed1577fd5e392c411` |
| `brain/test_artist_review_regressions.py` | `8f8c2ef91133cf183224320bc87c4df9a39a018e0149676efadec61165acb1cb` |
| `brain/test_artist_search_albums.py` | `ea936395266fbda3085d7b474836a6b65f6018a1d88b9abd432cb4a80a02bf20` |
| `brain/test_artists_invariants.py` | `6a653a3ee36a164a5e90eaa30274cd9eb8e12ed1206be6b9794e71b6580d064c` |
| `brain/test_gate2_findings.py` | `76fad3cc8450b4997d3022c355f7d2627437ccd8a5dbbe9057c3dfedadc941bf` |
| `brain/test_gate2_fixes.py` | `7b176c880f5ffcb2b07724394fa0cd91a2880a2b13ca2c1b99e2dc554d5d701a` |
| `brain/test_multi_artist_api.py` | `4e6c9805c45f248ec755a8d1138a1e75c7088319df82d4f45854e6dd5b73e880` |
| `brain/test_multi_artist_bulk.py` | `9834b1bb1ef82d5d4fe7e3542d49785dcf766909ca5711be656f44d3df3e98a4` |
| `brain/test_multi_artist_import.py` | `dbabc65a469f0a1526acadaa2aaadec20c98e9190282916427973a76dfd175d5` |
| `brain/test_multi_artist_integration.py` | `9fac8bdd313f05680fc674f3af4cee54dc7aeb9f670d7cfa3ebb20c498f2d71a` |
| `brain/test_multi_artist_merge_race.py` | `fb064bbf4dadd71c3028915bd8592361e743e6b81cc939a29618660bc8510e22` |
| `brain/test_multi_artist_recommendations.py` | `06eed0e88967f5a45f850b1cf265beee18f9f69deb5c6ed138bd3585a9df68ef` |
| `brain/test_multi_artist_storage.py` | `e1f161aa03e7c102587e53a246d352ff27590389f8a81f12cf15ac83dc05631a` |
| `brain/test_personalization.py` | `0a85331f58487143438065dcaeb8f51f7a6f05f8456336a652a5b48eece636ce` |
| `brain/test_wave_stage2.py` | `fbb29cbdb9a3d73ca0f8c0b8fedc9d08834e09d429a71b8cda4530a9f5eeb6df` |
| `brain/wave_tuning.py` | `07407e78950a5eba51758e1527107630d19d9df99a606426d80babb67ccdd400` |
| `docs/ARTISTS_SECTION_CONTRACT.md` | `01d84ce6847f205cd2ff8ca629f14fa42ea733059728438492c34b10b7d9e34e` |
| `docs/MA_API_MERGE_FIX_REPORT.md` | `325a48dcc2aed8dd201c4463c34634c42e0e7c89d5960cb006f09fed0d210561` |
| `docs/MA_BULK_FIXES_REPORT.md` | `790300f4cad435e2b9418c22da28b1d2783ff8e64bc8ae5395cea7a31ad892c7` |
| `docs/MA_CONTRACT_REPORT.md` | `3748be1177cdc9b1316183b3a8907ddddbc747daacd6bf5a2c8095f2bddc4fb1` |
| `docs/MA_DATA_CORRECTIONS_PREVIEW.md` | `8d2865c2d36c82c590a846dd3c3baf6c1b0c155e59ada759d51ce569626dd217` |
| `docs/MA_FINAL_REQUEST_REVIEW.md` | `604435f905caed7abf0652fe61629944bc91f1acfeee11fc5b6b710fb2d30e6a` |
| `docs/MA_FIXES_REPORT.md` | `4a60c6c7b67eb8f76888dcf841b20cfe26e623baf5b16ee5adba1fd3a578e771` |
| `docs/MA_IMPORT_TEST_PATH_REPORT.md` | `7ee20046624692daed99b16eff136251f1a70122eefea360da39fdf20bbe285a` |
| `docs/MA_MA_API_REPORT.md` | `071285eeb141f2a5e2f46d0bde7fa00a2a54026db60dcfd663ba0e3beb03b784` |
| `docs/MA_MA_BULK_REPORT.md` | `909379e1be3053e6e832696e5c77ca3739d6a604e95365963aebe7537963e88a` |
| `docs/MA_MA_IMPORT_REPORT.md` | `619ba7e6bc79c49b3bf9473d553ad91ac54dd4cd86cc5e2b226e42fbb633886a` |
| `docs/MA_MA_INTEGRATION_REPORT.md` | `f2851188738e58bb942fc958c0f1bdd6b1ef35cf517180e2603f363682ec2a9e` |
| `docs/MA_MA_IOS_BULK_REPORT.md` | `b8406af61ef4d96a904b9028c27e19135cc87304076486201e9bc542ec6673e3` |
| `docs/MA_MA_IOS_DATA_REPORT.md` | `daf0fb9f2ab3ab8b2fa1de7986a8587843e25e7aae3802adfe30aa7a47ac4c34` |
| `docs/MA_MA_IOS_EDITORS_REPORT.md` | `9c208f30f9c7cd4e3f73923516c4afe7e5201f878fa0f28404d717e6f43d0de9` |
| `docs/MA_MA_IOS_NAVIGATION_REPORT.md` | `8cfc2ccf510378bceedfd5e1d1b476d6bb764b7560f9fa715cc8d5e1366e754e` |
| `docs/MA_MA_RECOMMENDATIONS_REPORT.md` | `bc2a0c8ab73591e0bc7a061c87be2501816c5fa573437111881ecbd3bdc8cc13` |
| `docs/MA_MA_STORAGE_REPORT.md` | `e1681adbd45e1c5b53bffafdf326812370d2860b3d41d0840c3b6600a1365486` |
| `docs/MA_RECHECK_REPORT.md` | `2b8c72f9a3c026f13686e923288eee7a508b19ed80bcd156b8ea7f0619742fc4` |
| `docs/MA_REQUEST_BOUND_FIX_REPORT.md` | `2e8adf275121b214178327928fc49252aeecb181d73956a391e06fc532e2cc89` |
| `docs/MA_REVIEW_REPORT.md` | `cbe6704bcd7e8ce17e79aef1c924259ebc15f44efea3c3e89a376c0265ba6336` |
| `docs/MA_ROLLOUT_PREPARATION.md` | `cdcf588cadda5cad194bcd4eb14dbcfc086929c4cda70d39a8fa3805e8078671` |
| `docs/MA_RUN_REPORT.md` | `f61a14c0aeae250c6d6759e1023566016d10909212fe9c9eaab92752a2bcd612` |
| `docs/MA_SELECTED_ARTIST_CORRECTIONS.json` | `e19d49970ca4df4d77b67de321dc34ac16dd991f9672555a0135ad5b29ec3e0a` |
| `docs/MULTI_ARTIST_CONTRACT.md` | `99b618543e5d8793f21bdc64421e82535a604ef7f6719b0d3fc96b7c3213a573` |
| `docs/MULTI_ARTIST_ORCHESTRATION_PLAN.md` | `80943a788484ba006b784c4445a43201762cabcf109538aca9cd8fc890435975` |
| `tg_music_bot/audio_tags.py` | `627e346c8626da3de6045acda7950019ebae3a764426264554fe6bf524bad9f1` |
| `tg_music_bot/bot.py` | `e34a3288f70901e87ef24bd73b9c15f42782c248ad32e9fb1a6f105772bbb681` |
| `tg_music_bot/downloader.py` | `77cf9ef6accdc5816d082773cfc3ef6ce45f6c4f86c00753c478037e1437545c` |
| `tg_music_bot/test_multi_artist_import.py` | `0954a2daeaf3117edf160e32454d5be7332cdd9e933e6e06d855a56f6ce667ee` |
