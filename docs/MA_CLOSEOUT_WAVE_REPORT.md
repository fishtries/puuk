# W1 — рекомендации на реальных распределениях

Проверка текущей попытки от 2026-10-29T07:13:47.235496+00:00, UTC; cwd `/home/fish/projects/puuk`. Task `task_e8fc3870afc0`, Dispatch `ctx_727a39bf3310`, Run `run_ea37b46b2dc1`. Изменён только этот отчёт; весь диагностический код, снимки и receipts находятся в `/tmp/puuk-ma-close/task_e8fc3870afc0/`.

**Результат:** all-participant cap, recent max penalty, dedup и SQLite-first сохранение ручных credits подтвердились на свежих данных. Найден отдельный **F1 / P1: жанровый SQLite fallback и смешанный refill теряют credits в публичном DTO**. Координатор подтвердил отдельный fix scope; W1 исходники не исправлял. Техническая проверка не является оценкой музыкального качества.

## Версия и изоляция

HEAD `671be2ff8bf2d89a1bc11766d18f62b4faebe5a5` обозначает основу dirty-кандидата. Все 116 Python/SQL inputs Brain имеют SHA256 в `source-before.json`; их неизменяемая копия `source-tree/brain/` используется harness напрямую. Контракт: `docs/MULTI_ARTIST_CONTRACT.md`, прежде всего §9, T16/T17; прочитаны актуальные AGENTS/brain AGENTS, ORCHESTRATION/AGENT_ORCHESTRATION и журнал MA_RUN_REPORT. Существующий dirty baseline сохранён, reset/clean/commit не выполнялись.

Orca: `orca skills get orchestration` прочитан из установленного shim. `dispatch.json` сверяет текущие `launch.requested/effective`: оба `{agent:null, model:null, effort:null}`, поскольку назначен существующий терминал. Projection provider=Codex `gpt-6.1-sol`, live terminal preview=`GPT-6.1-Sol high`; нового явного launch receipt это не доказывает. Журнал координатора отдельно фиксирует выбор модели/effort до назначения. Run не создавался/не переносился, подзадачи worker не создавал.

Окружение: Python `3.14.8`, pytest 9.1.1, qdrant-client 1.18.0, NumPy 2.4.6, FastAPI 0.141.1.

| Вход | Время получения UTC | Размер | SHA256 |
|---|---|---:|---|
| `library.db` | 2026-10-29T07:07:12.808578+00:00–2026-10-29T07:07:13.995113+00:00 | 4890624 | `ab6ecde1c2868b6f232ee78feff08fad1787d665c704237e4a0a733e0bdd99a3` |
| `qdrant.json` | 2026-10-29T07:07:13.999034+00:00–2026-10-29T07:07:15.272606+00:00 | 7681480 | `f8a7e183a8d6f27ff6e74fb93a787baebbc1bf388f62ca4ba38fd1d4817cdcee` |

SQLite снята через SSH read-only URI + query_only и online backup в память, затем сериализована непосредственно в локальный файл. На сервере не создавались backup/temp DB и не выполнялись SQL mutations. Qdrant снят только read-only scroll-запросами с payload/vectors; GET collection config подтвердил Cosine/400. Пагинированный Qdrant capture и SQLite backup не являются общей межсистемной транзакцией; writers не останавливались. Это воспроизводимый зафиксированный вход, не доказательство отсутствия последующего live drift.

Снимок: schema12, integrity=ok, foreign_key_check=0; 1198 tracks, 1198 track links, 6123 history rows, 4946 feedback rows. По количеству участников: 10 треков с 0, 1180 с 1, 6 с 2, 2 с 3. Все 8 multi-artist треков имеют manual override. Qdrant: 1213 points, 1196 ready, 17 needs_embedding.

Все тестовые/fixture SQLite пути явно переданы через PUUK_DB_PATH в собственном /tmp. Queue/reconcile/loudness delivery выключены; тесты не подключались к production Qdrant, бот/scan/heavy_worker не запускались. Harness запрещает socket.connect, использует Qdrant Local in-memory с реальными vectors/payload и копию SQLite; оригинальный library.db сохранил SHA256. На evaluation.db counts/history/feedback/integrity до и после совпали; отдельная fixture.db меняет credits семи существующих track rows и добавляет пять будущих history events только копированному user1.

## Текущие проверки и воспроизведение

| Проверка | Интервал UTC | Exit | Результат |
|---|---|---:|---|
| `brain/venv/bin/python /tmp/puuk-ma-close/task_e8fc3870afc0/run-tests.py` | 2026-10-29T07:07:42.732901+00:00–2026-10-29T07:07:51.789014+00:00 | 1 | 68 passed, 4 connection failures: намеренно offline Qdrant URL `127.0.0.1:9` |
| `brain/venv/bin/python /tmp/puuk-ma-close/task_e8fc3870afc0/run-tests-offline.py` | 2026-10-29T07:08:42.486526+00:00–2026-10-29T07:08:51.025152+00:00 | 0 | 72 passed, 1 Starlette deprecation warning; реальные snapshot points загружены в Qdrant Local через pytest plugin |
| `brain/venv/bin/python /tmp/puuk-ma-close/task_e8fc3870afc0/reproduce.py` | 2026-10-29T07:13:45.966986+00:00–2026-10-29T07:13:47.456135+00:00 | 0 | Повтор всех 15 cases, penalty/DTO probes; exact semantic match |

Suites: `brain/test_multi_artist_recommendations.py brain/test_wave_stage2.py brain/test_wave.py brain/test_personalized_recommendations.py brain/test_personalization.py brain/test_effective_genres_recommendations.py`. Runner сохраняет полный argv/cwd/exit/time и локальный DB path. Успешный прогон добавляет `-p offline_qdrant` при помощи PYTHONPATH собственного /tmp: это явный adapter окружения, исходные tests не менялись. Он использует тот же client API/400-D Cosine и captured library, без production history writes. Полные backend/iOS suites без исходного drift не повторялись.

Повторить зафиксированную диагностику: `brain/venv/bin/python /tmp/puuk-ma-close/task_e8fc3870afc0/harness.py`, затем `brain/venv/bin/python /tmp/puuk-ma-close/task_e8fc3870afc0/reproduce.py` из корня репозитория. Финальные ID, scores, участники, повторы и penalties совпали в двух прогонах побайтно после исключения двух timestamps: canonical SHA256 `c5089694b69b71e9fd05bd8d7fa583766a6faeaa052a3032f0ecef2490584ede`. RNG seed=20261029. Тестируемые 116 source inputs совпали с repo при проверке; последующее отдельное исправление F1 не меняет frozen reproduction.

## Широкий/узкий пул и fallback

Для real-smart используется настоящий get_smart_recommendations и Qdrant Local exact cosine по захваченным production vectors; это локальное воспроизведение, не live ANN-server call/latency test. Cases 0/1/2 используют первые два отсортированных multi IDs и ready ID с индексом100 (точные current IDs в results.json), реальную recent-five историю user1 и отключённый vector blend для изоляции content ranking. Profile-case использует сохранённый 400-D user1 embedding, blend и exploration. Узкие smart cases используют отдельную in-memory коллекцию только из настоящих TV Girl points. Другие real cases проверяют selector/personal diversity на реальных SQLite distributions; их scores — явно диагностический детерминированный порядок, не музыкальная релевантность.

| Case | Вход после исключения current | Qdrant query limits | Запрошено / выдано | Unique участников | Strict / unknown / soft refill |
|---|---:|---|---|---:|---|
| real-smart-0 | 399 | 400 | 20 / 20 | 18 | 20 / 0 / 0 |
| real-smart-1 | 399 | 400 | 20 / 20 | 19 | 20 / 0 / 0 |
| real-smart-2 | 399 | 400 | 20 / 20 | 19 | 20 / 0 / 0 |
| real-wide | 1198 | — | 20 / 20 | 20 | 20 / 0 / 0 |
| real-multi-only | 8 | — | 20 / 8 | 6 | 3 / 0 / 5 |
| real-narrow | 37 | — | 20 / 20 | 4 | 2 / 0 / 18 |
| real-insufficient | 3 | — | 10 / 3 | 1 | 2 / 0 / 1 |
| real-smart-profile | 400 | 400,100 | 20 / 20 | 18 | 20 / 0 / 0 |
| real-smart-narrow | 36 | 400 | 20 / 20 | 4 | 2 / 0 / 18 |
| real-smart-insufficient | 3 | 200 | 10 / 3 | 3 | 2 / 0 / 1 |
| real-personal-wide | 1198 | — | 20 / 20 | 20 | 20 / 0 / 0 |
| real-personal-narrow | 37 | — | 20 / 20 | 4 | 2 / 0 / 18 |
| controlled-joint | 5 | — | 4 / 4 | 3 | 4 / 0 / 0 |
| controlled-empty-refill | 7 | — | 7 / 7 | 4 | 4 / 1 / 2 |
| controlled-duplicate-id | 6 | — | 8 / 5 | 4 | 4 / 0 / 1 |

Во всех строках unique track count равен выданному: дублей ID нет. В строгом проходе Wave cap=2 проверяется для **каждого** unique участника, совместный трек расходует один слот у каждого. Затем выбираются unknown credits, затем soft refill из известных в порядке score до limit или исчерпания distinct IDs. Cap на полном fallback результате не гарантируется. Personalized использует cap artist=2 и album=3, затем второй проход ослабляет оба.

Конкретный узкий pool: TV Girl — 37 tracks; request20 → strict2 + soft18. В итоговых20 TV Girl встречается20 раз, совместные участники также посчитаны ниже. Из пула3 request10 → только3, strict2+soft1. Из восьми реальных совместных треков request20 → только8, strict3+soft5. Это фактическое поведение, не нарушение §9; универсального порога «достаточного разнообразия» контракт не задаёт.

Контролируемая fixture: ordered A, B, A+B, A+C, D; request4 выбирает A, B, A+B, D (A+C не проходит cap A). В семиэлементной fixture добавлены [] и ещё A: request7 → strict4, unknown1, soft2. Повторный объект того же track ID не добавляется. Fixture inputs/actual track IDs отдельно сохранены в results.json, это не выдаётся за исходные библиотечные credits.

Повторы **каждого** участника в каждой выдаче (0-credits track не создаёт участника; ID/name/score per track полностью в results.json):

- **real-smart-0**: The12Apostle ×2; John Beltran ×1; Masafumi Takada ×1; Jordana/TV Girl ×1; ADÉLA ×1; berlioz ×1; George Clanton ×1; A Forest Mighty Black ×1; MF DOOM ×1; frutiger pm ×1; 3582 ×1; your best friend jippy ×1; PYNKIE ×1; PinkPantheress ×1; The Marías ×2; TV Girl ×2; Cabro Artico & M A R Iマリくん ×1; Digable Planets ×2.
- **real-smart-1**: The12Apostle ×1; Tree Palm ×1; themme ×1; ZERTAL ×1; Frutiger Fantasia ×1; yaego/KUČKA ×1; Night Tapes ×1; Magdalena Bay ×1; Kokonoku ×1; Psychic 恋人 ×1; General Translator ×1; Webinar™ ×1; faketo ×2; Adi T ×1; kyotobaby/DXNKXR ×1; マドロスMERCURY ×1; glue70 ×1; Sam Gellaitry ×1; lexycat/Sayako ×1.
- **real-smart-2**: Black Coast ×1; Edward Maya/Vika Jigulina ×1; Edward Maya & Vika Jigulina ×1; Maroon 5/Christina Aguilera ×1; k3m1s+Ry ×1; ONL ×1; Dua Lipa ×1; LE SSERAFIM ×1; Higgo/piri ×1; BellyJay ×1; CA7RIEL & Paco Amoroso/PinkPantheress/Fred again../Etienne de Crécy /Grand Theft Auto VI ×1; gabriawll ×1; Troye Sivan/PinkPantheress/Hyunjin ×1; Silentance ×1; Chris Taylor ×1; Tame Impala/JENNIE ×2; Kvi Baba/KREVA ×1; prodBigMike & Glitch Cat ×1; Tiffany Day ×1.
- **real-wide**: Big Daddy Kane ×1; Kurokotei / 黒皇帝 ×1; Lilithzplug ×1; Key Glock ×1; duskydemise ×1; Yuumu/Bodycam ×1; proloxx ×1; confetti ×1; конец солнечных дней ×1; Gipsy Kings ×1; Goldie/Rufige Kru ×1; マドロスMERCURY ×1; Kro Von Krismelia ×1; Lunatic Calm ×1; The Walters ×1; lexycat ×1; Trashiii ×1; Aero-Ji ×1; GONE.Fludd ×1; главный герой ×1.
- **real-multi-only**: confetti ×1; George Clanton ×7; Frankie Cosmos ×1; PYNKIE ×1; TV Girl ×7; khel ×1.
- **real-narrow**: George Clanton ×6; Frankie Cosmos ×1; PYNKIE ×1; TV Girl ×20.
- **real-insufficient**: TV Girl ×3.
- **real-smart-profile**: The12Apostle ×2; Modest by Default ×1; Masafumi Takada ×1; Jordana/TV Girl ×1; ADÉLA ×1; George Clanton ×1; A Forest Mighty Black ×1; MF DOOM ×1; frutiger pm ×1; your best friend jippy ×1; PYNKIE ×1; PinkPantheress ×1; The Marías ×2; TV Girl ×2; Пошлая Молли ×1; Instupendo ×1; Cabro Artico & M A R Iマリくん ×1; Digable Planets ×2.
- **real-smart-narrow**: George Clanton ×6; Frankie Cosmos ×1; PYNKIE ×1; TV Girl ×20.
- **real-smart-insufficient**: George Clanton ×1; Frankie Cosmos ×1; TV Girl ×3.
- **real-personal-wide**: Big Daddy Kane ×1; Kurokotei / 黒皇帝 ×1; Lilithzplug ×1; Key Glock ×1; duskydemise ×1; Yuumu/Bodycam ×1; proloxx ×1; confetti ×1; конец солнечных дней ×1; Gipsy Kings ×1; Goldie/Rufige Kru ×1; マドロスMERCURY ×1; Kro Von Krismelia ×1; Lunatic Calm ×1; The Walters ×1; lexycat ×1; Trashiii ×1; Aero-Ji ×1; GONE.Fludd ×1; главный герой ×1.
- **real-personal-narrow**: George Clanton ×6; Frankie Cosmos ×1; PYNKIE ×1; TV Girl ×20.
- **controlled-joint**: D ×1; A ×2; B ×2.
- **controlled-empty-refill**: D ×1; A ×4; C ×1; B ×2.
- **controlled-duplicate-id**: D ×1; A ×3; C ×1; B ×2.

## Recent overlap и stale payload

Каждый penalty вызов проверен по формуле 0.05 × max recent_count среди всех участников; before/after/recent_max для каждого кандидата записаны в penalty_audits. Реальные counts user1 за последние5 событий:

- `art_a569e399d1ad3593354f4be20e093887` (имя доступно в captured SQLite) — 1.
- `art_c6c54c3ea0c74315ead8393df5644a7a` (TV Girl) — 2.
- `art_e43aab43f2c089422f10f8025fe25fec` (имя доступно в captured SQLite) — 1.
- `art_f4f9ef2144a039201ec1b40b339f788b` (имя доступно в captured SQLite) — 1.

Controlled five-event history: A, B, A+B, A+C, A+B → A=4, B=3, C=1. Candidate A+B со score1.0 получает max(4,3) ×0.05=0.20 →0.80, не сумму0.35. Сортировка event window/tie-break и более старые события дополнительно проверены принятым test_recent_counts_event_window_and_tiebreak.

Все восемь actual manual lists отличаются от захваченных Qdrant credits. _ArtistResolver.prefetch/keys во всех восьми случаях вернул точное SQLite множество; build_wave_track_payload вернул полный ordered manual list/revision. SQLite/links/manual snapshot не изменились; это подтверждает отсутствие потери override из-за stale Qdrant.

| Track | Effective SQLite participants | Revision | stale Qdrant differs / Wave DTO preserved |
|---|---|---:|---|
| `66a3a682-e693-58d3-afbb-b10d6a6fe3f9` | TV Girl, George Clanton | 2 | True / True |
| `fb47153a-16dc-54c4-b4d5-207da7c47821` | TV Girl, George Clanton | 2 | True / True |
| `1084aae6-7358-5cbb-bf54-c29706c1b287` | TV Girl, George Clanton, Frankie Cosmos | 2 | True / True |
| `27e48714-ad06-5914-8770-0020e6df2b88` | TV Girl, George Clanton | 2 | True / True |
| `7d8fa744-5b8d-50b9-9c3d-e16d49fc8753` | TV Girl, George Clanton, PYNKIE | 2 | True / True |
| `8ef2ef3e-df31-5724-8288-7143843f802f` | TV Girl, George Clanton | 2 | True / True |
| `8f441ada-eddc-51c8-84ab-c1cea4833c83` | TV Girl, George Clanton | 2 | True / True |
| `6be9fab0-5d34-5cf6-a952-3efb4b844d26` | confetti, khel | 2 | True / True |

Existing SQLite [] authoritative, missing SQLite→payload/filename fallback, invalid payload ID/name, single DB-outage diagnostic, 1001-ID bounded prefetch, Qdrant-unavailable credit edits/bulk, personalized breadth union проверены в текущем 72-test прогоне. Эти synthetic tests перечислены отдельно от реальных распределений.

## F1 — P1, credits пропадают в жанровом fallback DTO

Место в проверенном source: `brain/services/personalized_recommendation_service.py:488`–fallback payload append; `brain/routers/personalized_recommendations.py` возвращает result без дополнительной hydration. Ветка Qdrant использует build_wave_track_payload, а SQLite/refill вручную строит объект без artist_id, artists, artists_revision, album_artists и album_artists_revision. Затронут §6 (TrackDTO в каждой выдаче), T03 (одинаковые arrays/revisions во всех DTO surfaces), §10 (клиент сохраняет только server credits) и MA-02/MA-06 continuity; это не изменение rank cap и не потеря данных в самой SQLite.

На реальной copied user1 истории get_personalized_genre_sections с Qdrant-vector unavailable даёт Music/House/Drum n Bass, по20 треков: все60 DTO не имеют artists/artists_revision. Минимальное реальное воспроизведение — track `6be9fab0-5d34-5cf6-a952-3efb4b844d26`, genre Breakcore, manual participants confetti + khel: generate_genre_playlist на каталоге из одного этого track возвращает его с legacy display, но без массива/revision.

Два mixed cases на одном зафиксированном real six-track Breakcore micro-catalog, user2, query adapter возвращает ровно один ranked point:

| Ranked point | Returned | Hydrated ranked row | Refill rows missing credits | Manual track outcome |
|---|---:|---|---:|---|
| `6be9fab0-5d34-5cf6-a952-3efb4b844d26` | 6 | yes | 5 | preserved as ranked |
| `03047d34-5f3f-582f-bf3c-f7cfd6ed6dc6` | 6 | yes | 5 | missing in refill |

Exact micro-catalog IDs, expected participants и returned field presence находятся в results.json: mixed_qdrant_refill_dto/manual_genre_fallback_dto. Передано координатору escalation msg_6d87c8d4b9ac; ответ msg_49cfe4e73f73 подтвердил отдельную fix-задачу и независимую senior-перепроверку. Предложенная область — единая hydration DTO для SQLite fallback/refill, regression actual manual list/[]/revisions и смешанная выдача. W1 не менял исходники и не авторизует deployment.

## Passed / failed / not tested / historical

**Passed текущей попытки:** 72 tests на изолированной SQLite/Qdrant Local; 15 distribution cases; strict caps/dedup; все рассчитанные recent penalties; eight stale-payload overrides и Wave DTO; две идентичные deterministic evaluations; integrity/FK и неизменность captured DB/history.

**Failed текущей попытки:** F1 в текущем genre DTO; offline-URL run 4 connection errors (test dependency unavailability, не новый recommendation regression). Первый harness pass ошибочно использовал отсутствующего diagnostic user и упал на FK только в fixture.db; заменён существующим copied user1 с future-event window, trace сохранён в harness-attempt1.log. Один Orca status probe неверно использовал type=checkpoint и был отвергнут до записи; повторён поддерживаемым type=status.

**Not tested:** субъективное прослушивание/музыкальное качество, actual iOS playback/UI/device acceptance, live Qdrant ANN performance и production timing, real write-failure/recovery при отключении сервера, production corrections. Audio не открывались/не менялись. Проверенный SQLite fallback на None vector не равнозначен оценке всех вариантов реального outage.

**Historical, отдельно:** предыдущий MA_MA_RECOMMENDATIONS_REPORT содержит72 passed и описания реализации; он использован как inventory принятых suites, но не как результат текущей попытки. Full backend/iOS/bot/web результаты из C0/старых reports не переобъявляются текущими W1.

## Артефакты

Все пути ниже относительно `/tmp/puuk-ma-close/task_e8fc3870afc0/`. library.db/qdrant.json — локальные диагностические captures, не production restore backups; содержимое auth tables/секретов в отчёт не включается. Не публиковать raw DB. Frozen source-tree содержит только py/sql, без env/signing/audio. Долговечное резюме, показатели и finding находятся в этом документе.

| Artifact | SHA256 | Назначение |
|---|---|---|
| `write-report.py` | `0c7c65372516f6e40de7157b423240f71512c390e25466a1fb2654dd70dae40a` | durable report renderer |
| `collect.py` | `5dbea6881f0b28821b767215a0e7113fcaf8f31d8d2bf1efd2c72b43296fe8d1` | read-only snapshot collector |
| `collection-receipts.json` | `3c9a6d452a349a5283bc0d439eae60b9142201cfe8895c5feb17e9604a131737` | SSH argv, UTC, exit, operations, hashes |
| `source-before.json` | `ba3783cfce01f1b695b12bef2990c6ef97faa180c9cffa842536c2b259746d81` | HEAD +116 tested input hashes |
| `dispatch.json` | `a188c171bdaf9c120d4bf72109dd2a6aa7ba404ec494661b136022caa0b1bada` | current model/effort/resource receipt |
| `qdrant-config.json` | `7d0e4444e73020863de4f6af5311711eb96d45868725dd8e15be6825ece1dd33` | actual collection400/Cosine |
| `harness.py` | `bb249d48620cde22af75fdcf44609e339d651192b1e580d67a9e2bb3b89f1318` | all15 cases, penalty/DTO probes |
| `reproduce.py` | `b04634869edcecb51fb9d36fc7c32cb319739f060e9a8c62950faa3ef7dbdd7c` | deterministic semantic comparison |
| `results.json` | `ade8a309b5fa5a8c4ad9a3ed295e2ae21966d6851da0503fb808f9aa83f029a1` | all inputs/IDs/scores/participants/counts/penalties/DTO fields |
| `results-first.json` | `0c8520e6ae320d31dfd8124e694a4ae138df389fa8d62aacbabdf4b7229b8815` | first deterministic repeat |
| `evaluation-receipt.json` | `99589bf4fa227935947d71b44fa8b6ac43cd5869e9189f20ab98deb54e7cfca2` | command/time/exit/versions/source drift/semantic hash |
| `run-tests.py` | `3662e0cc4e79e68a0a642732f1117a96f9cccb4b8b9a6f957a00ffd0f1b48f1b` | intentionally unavailable Qdrant runner |
| `run-tests-offline.py` | `63a0879b938f9a3c024807a03ee501501405d7a5ec20ded5c9577d21203785d6` | accepted suites runner with Qdrant Local |
| `offline_qdrant.py` | `43e109176c8f75210eb79ea1fa94562c3d1baf9909e2a87a35293865a8b10b76` | test-only environment adapter |
| `tests.log` | `ba49868a343132e5c8a6792393441df15cdf570d84e1c898f9b21ff7d550abd5` | 68 passed/4 dependency errors |
| `tests-receipt.json` | `5d7efc48b5c954cec086d18828a2f36d054a00f94386fa816670fb40295cacb6` | failed offline endpoint attempt receipt |
| `tests-offline.log` | `7629d597dcc9ea58b03094eef93e960825de7d7c4d0718fd8e0f065ab04601dc` | 72 passed current attempt |
| `tests-offline-receipt.json` | `dc7bedd2afe4a08d529d023e099af2aae0d8ef288744ffa59951997b9a8b2cb4` | successful isolated suite receipt |
| `harness-attempt1.log` | `6b321e838fbe1203b630e26c69f90a1521a5632a67ae381cc026d545eb184382` | diagnostic fixture FK failure |
| `harness.log` | `67bdd8f8b669f7f15d523bb176b8a5eeb3bdc81c8e3059bdffb5c42d96cb96d6` | first final harness output |
| `harness-repeat.log` | `9bdbda5489c5bd800ba3e745fcdaa859b09b88c42b3daf7873e5cf4682457f04` | repeat final harness output |
| `git-status-before.txt` | `5042ee8b32ae655099213a862616e1ff9cbf44006a43dfffa7707cbf76273b18` | preserved dirty baseline |

Frozen current source hashes ключевых модулей (полные116 — source-before.json):

| Module | SHA256 |
|---|---|
| `brain/services/recommendation_service.py` | `fc0e3d978860e744ef0b72ec2759a8bf702610f53aa0b9bcdaeeadd9a4c6e118` |
| `brain/services/personalized_recommendation_service.py` | `9d6e22da5828abaf51a2aadf703d873478222baa27c3c7963944a83d23365ac7` |
| `brain/repositories/artist_credits.py` | `b72a98488e0c485b4c4d6b0e12d24142338add50abe270854e27aa55b61aeda9` |
| `brain/repositories/wave.py` | `78a20d72d3376a57c94780acbb03d00b4f944c8bf98450105fa5b895c5a0c6f0` |
| `brain/repositories/tracks.py` | `43b911d958e0b88fdfda677fdbc56cdb9ba248db81ce7d6ff8dd7db8a2b518af` |
| `brain/wave_tuning.py` | `07407e78950a5eba51758e1527107630d19d9df99a606426d80babb67ccdd400` |
| `brain/test_multi_artist_recommendations.py` | `06eed0e88967f5a45f850b1cf265beee18f9f69deb5c6ed138bd3585a9df68ef` |
