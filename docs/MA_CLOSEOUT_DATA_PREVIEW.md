# D1 — свежий data preview

**Production scope сейчас пустой.** Из прежних пяти строк четыре уже соответствуют цели, а Monday, Monday имеет актуальное ручное решение revision2, отличное от предлагаемого списка из трёх артистов. D1 не изменял production и не приписывает себе прежние ручные изменения. [Новая actionable selection](MA_CLOSEOUT_SELECTED_CORRECTIONS.json) содержит `proposals: []`; отложенный вариант ниже **не разрешён к применению**.

Дата: 2026-10-29; cwd `/home/fish/projects/puuk`; Run `run_ea37b46b2dc1`, Task `task_2982c40d055e`, Dispatch `ctx_bb96ccf4655b`. Исполнитель — reused Codex terminal `term_61f74923-e26c-44bb-84ce-35dfd5bfe106`, provider gpt-6.1-sol, live preview high. В startOptions reuse receipt launch.requested/effective оба null (новый процесс не запускался); initial launch того же процесса в C0 имел requested=effective=gpt-6.1-sol/high. Новый launch не выдуман, subworkers не создавались.

Прочитаны AGENTS.md, brain/AGENTS.md, frozen MULTI_ARTIST_CONTRACT.md (§8 CLI/guards), текущий MA_RUN_REPORT/C0 и исторические MA_DATA_CORRECTIONS_PREVIEW/MA_SELECTED_ARTIST_CORRECTIONS. Гайды Orca orchestration/orca-cli загружены в предыдущем Task той же сессии; lifecycle использует только новый live preamble. Исходники, исторический JSON и прежние snapshots не изменялись.

## Snapshot и фактический дрейф

Read-only SSH backup API: 2026-10-29T07:05:43.941344+00:00 → 2026-10-29T07:05:43.953346+00:00. Источник `/home/fish/apps/puuk/puuk/brain/puuk.db` открыт `mode=ro`, `query_only=on`; `sqlite3.Connection.backup` в memory connection и serialize по SSH stdout. Серверного backup-файла этот Task не создавал, writers не останавливал. Получен WAL-consistent snapshot, а не копия одного main.db при активном WAL.

Источник сохранён только локально: `/tmp/puuk-ma-close/task_2982c40d055e/production-snapshot.db`, mode0400, каталог0700, 4,890,624 bytes, SHA256 `ab6ecde1c2868b6f232ee78feff08fad1787d665c704237e4a0a733e0bdd99a3`. **1198 tracks /893 albums /923 registry artists; schema12; integrity=ok; FK violations=0; catalog_version2707**. Source snapshot SHA256 сохранился после report и всех disposable-проверок. Снимок может содержать приватные application данные: не публиковался, в отчёт включены только нужные metadata и hashes.

Во всех пяти строках source_kind остаётся legacy и source_names/raw artist совпадают с прежним JSON; manual snapshot теперь `[TV Girl, George Clanton]`, revision2. Старый revision1 report на fresh copy отвергнут CLI с `bulk_revision_conflict`, exit3, без каких-либо изменений таблиц. Причину и автора прежней ручной правки данный Task не устанавливает.

Все пять ID/title/release проверены точно. Release у всех — `Fauxllennium (Japanese Deluxe Edition)`, album_id944. Album credits **только TV Girl**, revision1, source legacy, manual=NULL; guests из track credits в album не добавляются. Raw release identity и membership не меняются.

| Track ID / title | Было в старом JSON | Сейчас effective / manual, revision | Предлагалось / станет только при разрешении | Решение D1 |
|---|---|---|---|---|
| `27e48714-ad06-5914-8770-0020e6df2b88` / Summer 2000 Baby | TV Girl/George Clanton; r1 | TV Girl, George Clanton; manual; **r2** | TV Girl, George Clanton | Исключён: уже соответствует цели; no-op не нужен |
| `66a3a682-e693-58d3-afbb-b10d6a6fe3f9` / Everything Blue | TV Girl & George Clanton; r1 | TV Girl, George Clanton; manual; **r2** | TV Girl, George Clanton | Исключён: уже соответствует цели; no-op не нужен |
| `8ef2ef3e-df31-5724-8288-7143843f802f` / Monday, Monday (feat. Neggy Gemmy) | TV Girl & George Clanton; r1 | TV Girl, George Clanton; manual; **r2** | TV Girl, George Clanton, Neggy Gemmy | Исключён из actionable; held, требуется отдельное разрешение заменить текущую manual list |
| `8f441ada-eddc-51c8-84ab-c1cea4833c83` / Take a Trip | TV Girl/George Clanton; r1 | TV Girl, George Clanton; manual; **r2** | TV Girl, George Clanton | Исключён: уже соответствует цели; no-op не нужен |
| `fb47153a-16dc-54c4-b4d5-207da7c47821` / Fauxllennium | TV Girl, George Clanton; r1 | TV Girl, George Clanton; manual; **r2** | TV Girl, George Clanton | Исключён: уже соответствует цели; no-op не нужен |

Причина выбора **для рассмотрения**, не authority на замену: официальный Spotify связывает именно эти tracks с данным release и явно перечисляет performers. Для четырёх текущий manual list уже совпадает; для Monday трёхсторонний список подтверждён карточкой, но такая evidence не отменяет приоритет действующего ручного решения. Neggy Gemmy не выводился из текста title, TV Girl не разложен на участников группы, songwriting credits не использовались.

Evidence заново проверена 2026-10-29: [официальный album tracklist](https://open.spotify.com/embed/album/5MQx9UktIiM86OYBZh1c4M) и [точный Monday track](https://open.spotify.com/embed/track/14joz9oqnhYORgpKOmE0Aj). В album list Monday отображается без локального `(feat. …)` суффикса; сопоставление использует тот же release и exact Spotify track URI из album list. Санитизированные receipts `official-tracklist-evidence.json`/`official-evidence.json` сохраняют только public titles/subtitles/artist names/URIs; HTML token-bearing state не сохранялся.

## Пустая selection и отдельно удержанное предложение

Новый JSON SHA256 `004c8f195837d49466564272c235ea59737fc41e8f6ffb5604c5dea5368bdf80` — только actionable selection, **не полный census unresolved**. Исторический `MA_SELECTED_ARTIST_CORRECTIONS.json` SHA256 `e19d49970ca4df4d77b67de321dc34ac16dd991f9672555a0135ad5b29ec3e0a` остался неизменным. Все пять прежних строк исключены из новой selection: четыре как already satisfied, одна как manual decision requiring owner approval.

Координатор в ответ на live `orca orchestration ask` явно указал: “Exclude Monday from actionable selection: current manual revision2 is authoritative and must not be implicitly replaced.” Разрешена только отдельная disposable rehearsal; ответ сохранён в coordinator-decision.json. Timestamp получения ask stdout не выдаётся за известный: receipt отдельно содержит время записи ответа.

Ниже точный held report v1, пригодный **только для review и локальной репетиции**. В D2 он не входит; необходимость его будущего включения должен подтвердить владелец именно как замену существующего manual решения. SHA256 отдельного held JSON: `f0483ffeec5161f0dc1849381a7d38718813f62bd32ef30948b6390a21b0675e`.

```json
{
  "version": 1,
  "proposals": [
    {
      "entity_type": "track",
      "entity_id": "8ef2ef3e-df31-5724-8288-7143843f802f",
      "expected_revision": 2,
      "before": [
        {
          "id": "art_c6c54c3ea0c74315ead8393df5644a7a",
          "name": "TV Girl"
        },
        {
          "id": "art_65064b6c1e41e167a3e4778a2d60c206",
          "name": "George Clanton"
        }
      ],
      "after": [
        {
          "id": "art_c6c54c3ea0c74315ead8393df5644a7a",
          "name": "TV Girl"
        },
        {
          "id": "art_65064b6c1e41e167a3e4778a2d60c206",
          "name": "George Clanton"
        },
        {
          "id": "art_a46a22317b146691cca485a0f4e77420",
          "name": "Neggy Gemmy"
        }
      ],
      "source_kind": "legacy",
      "source_names": [
        "TV Girl & George Clanton"
      ],
      "reason": "Exact current track ID/title/release verified; current manual two-person credits would be changed to the official three-person performer list only after explicit owner approval; no raw metadata or album attribution change.",
      "evidence": "Rechecked 2026-10-29: Spotify album https://open.spotify.com/embed/album/5MQx9UktIiM86OYBZh1c4M and exact track https://open.spotify.com/embed/track/14joz9oqnhYORgpKOmE0Aj both list ordered performers TV Girl, George Clanton, Neggy Gemmy for Monday, Monday; membership of TV Girl is preserved, songwriter/group-member inference is not used.",
      "ambiguity": "confirmed",
      "id": "807913320e494a1b06764d070d80788d633de590e8ca786e87a30d89b80416c4"
    }
  ],
  "unresolved": []
}
```

Proposal ID заново вычислен из актуальных before/revision/source/evidence/reason; никакой operation ID в proposal не переносился. Повторное использование revision1 или force bypass не применялось. Поле source не подменялось на provider ради превосходства над manual; будущее изменение, если будет разрешено, — обычный explicit manual replacement через optimistic revision guard.

## Текущее число unresolved

**241 punctuation candidates: 216 track /25 album**, все ambiguous и не выбраны. Полный свежий read-only report: `fresh-report.json`, SHA256 `59adf5f3894e9f03e2d63c7d818ee59cf987673d3d7e1e2d49ccff5ba365011a`. Это число строк отчёта, не число ошибочных имён и не универсальный список проблем: пунктуация сама не доказывает необходимость split.

**Плюс 1 отдельное held manual discrepancy** — Monday, не попадающий в пунктуационный report, потому что текущие отдельные names не содержат разделителей. Для closeout review остаётся242 единицы (241 ambiguous +1 held); actionable corrections0. `unresolved: []` в selected-only JSON не означает отсутствие остальных unresolved.

От исторических248 report candidates удалилось8, добавился1: 248−8+1=241. Восьмёрка включает прежние пять и ещё три вне selection; их исчезновение из punctuation report не объявляется результатом D1 или доказанным исправлением. Дельта по точным entity keys сохранена в final-readonly-check.json. Внеплановые исчезнувшие:

- `1084aae6-7358-5cbb-bf54-c29706c1b287`: прежнее literal name `TV Girl/George Clanton/Frankie Cosmos`; вне scope, причину изменения не расследовали.
- `6be9fab0-5d34-5cf6-a952-3efb4b844d26`: прежнее literal name `confetti/khel`; вне scope, причину изменения не расследовали.
- `7d8fa744-5b8d-50b9-9c3d-e16d49fc8753`: прежнее literal name `TV Girl/George Clanton/PYNKIE`; вне scope, причину изменения не расследовали.
- Новый candidate `35f27046-934d-55db-97c8-5a88c313af02`: literal `Kurokotei / 黒皇帝`; ambiguous, никакого автоматического разделения.

## Disposable rehearsal: точные изменения

Использованы **четыре новые локальные копии** source snapshot через SQLite backup API. Все команды используют отдельный `PUUK_DB_PATH`; embedding queue/reconcile/loudness delivery выключены, `PYTHONDONTWRITEBYTECODE=1`; API/бот/сканер/heavy worker не запускались. Qdrant/client не вызывались. CLI preview/apply/undo выполнялись текущими неизменёнными модулями в brain, с существующим admin actor из копии, а не фиктивным обходом RBAC. Нормальный service lock использован для уникальных local DB paths; stable lock sidecars под `/var/tmp/puuk-artist-credit-locks-v2` не удалялись.

Это репетиция **одного held Monday proposal**, а не имитация production apply пяти устаревших предложений. Source snapshot всегда read-only; source audio не предоставлялись процессу мутации.

| Стадия | Результат и exact delta |
|---|---|
| Preview | exit0, matched1/changed1; ровно1 новая journal row, 7→8; остальные таблицы побайтово в значениях прежние |
| Apply | exit0; ровно Monday: manual2→3 names, revision2→3; одна новая track link Neggy Gemmy, total1198→1199; новая registry row923→924, потому что artist прежде отсутствовал; catalog2707→2708; та же journal row preview→applied |
| Повтор apply | exit0; ответ точно равен первому, **все таблицы** прежние, новый journal/registry/catalog bump отсутствует |
| Undo | exit0; Monday effective/manual возвращены к двум names, revision3→4; track links1199→1198; catalog2708→2709; та же journal row applied→undone; source/observed/recovery прежние |
| Повтор undo | exit0; тот же ответ, **все таблицы** прежние |
| Новая manual edit после apply | На другой копии ordinary replacement Monday→[TV Girl], revision3→4; undo exit3, code bulk_undo_conflict; **все таблицы до/после failed undo равны**, новая правка и остальные entities сохранены |
| Новая manual edit после preview | На третьей копии apply exit3, code bulk_revision_conflict; **все таблицы** неизменны при отказе, stale plan не применён |
| Старый JSON revision1 | На четвёртой fresh copy preview exit3, code bulk_revision_conflict; journal и все таблицы неизменны |

Undo намеренно не удаляет новую inactive registry запись Neggy Gemmy и не уменьшает revision/catalog version: reversibility относится к effective/manual составу, а не к byte-identical DB rollback. Старые семь journal rows остаются точно прежними; новая plan row содержит один entity, expected_revision2/after_revision3/before_manual из свежего snapshot; request_hash проверен, result/undo_result точно совпали с CLI receipts.

**Во всех ветках:** все1198 raw track rows, все893 raw album rows, все album_artists и все остальные таблицы вне ожидаемых credits/state/journal/catalog/registry областей сохранены. Неизбранные credit states/track links не менялись. Общие counts alone не использовались вместо comparison: сравнивались упорядоченные полные row values/hash, а для journal также все7 старых rows по ID. По четырём DB integrity=ok/FK violations0.

**Copy-only operation IDs (никогда не переносить в D2):** `dbcc6cb6-4b37-4854-8cd3-997608edfc75` (rehearsal/undone), `3f2fa9a3-3518-4d13-a083-6c1f9d8352b4` (applied, deliberately later-conflicted), `b116a918-553f-411e-9e1a-59fe965213c9` (stale preview). Полные envelopes/табличные hashes: copy-validation.json; все13 command receipts с cwd, start/end UTC, argv, exit/status: command-receipts.json. Ошибочные exit3 выше — ожидаемые pass критерии guards.

## Audio и финальная read-only сверка

Пять реальных серверных файлов прочитаны только для SHA256/stat: before 2026-10-29T07:06:44.214906+00:00 → 2026-10-29T07:06:45.098264+00:00; after 2026-10-29T07:10:21.509171+00:00 → 2026-10-29T07:10:22.200996+00:00. У всех совпали SHA256, size, mtime_ns, ctime_ns, inode; stable_during_read=true. Size/mtime также совпали с snapshot metadata. Atime не используется как invariant: само чтение может обновить access time.

| Track | SHA256 audio | Size | mtime_ns |
|---|---|---|---|
| Summer 2000 Baby | `6ac32ce1c53739af51fad0505f0cc64be838c3ec0f2d2a000ef0b5a4301cbd51` | 4018986 | 1792246750651107200 |
| Everything Blue | `3f5a11d94ed827db61feff1e3ae046bee0b9965a64f3c3608b7bd0c2b8e0628c` | 3765887 | 1792247113889663026 |
| Monday, Monday (feat. Neggy Gemmy) | `7896ae9336872bd75a0a3170e459c1f616ca15a1226e9cc66eb8e52852e056a1` | 3608803 | 1792999652736571387 |
| Take a Trip | `5ca2b9207254f94762f1ea5632167d72d0b496d132a68a54d9170c5e63f952ca` | 3945341 | 1792246750675106838 |
| Fauxllennium | `a98fa6c7b081e440727b9149003b987faf609e2a9423579d7042f2b9937eb740` | 3221189 | 1792247513983722249 |

Финальный production read-only transaction 2026-10-29T07:11:05.369852+00:00 → 2026-10-29T07:11:05.941107+00:00: все5 selected raw/state/effective rows совпали со snapshot, catalog2707. Это не утверждение о неизменности всей живой production DB: другие writers могли работать. Source snapshot/старый JSON сохранены по SHA256; production writes этим Task не выполнялись.

## Точный D2 scope

1. **Текущий разрешённый data scope: 0 entities, 0 artist-credit writes, 0 новых journal operations, 0 catalog bumps.** Не запускать CLI preview/apply для empty selection ради записи no-op plan и не переносить прежние пять в production. Уже удовлетворённые четыре строки остаются без действий; Monday остаётся held.
2. Если владелец отдельно разрешит именно замену Monday manual list: разрешённый proposal должен содержать только track `8ef2ef3e-df31-5724-8288-7143843f802f`, album944/current title/release, before `[TV Girl, George Clanton]`, expected_revision2, after `[TV Girl, George Clanton, Neggy Gemmy]`. Source_kind legacy/source_names `[TV Girl & George Clanton]`, manual before snapshot `[TV Girl, George Clanton]` пересверяются перед новым preview. Любой drift — stop/review, не refresh-and-force.
3. D2 перед writes требует нового согласованного backup/report и валидного admin, отдельного подтверждения inclusion held proposal и собственный **новый production preview operation ID**. Ни один copy-only ID выше не использовать. Применение ожидает ровно1 track state, +1 link и, если Neggy Gemmy всё ещё отсутствует, +1 registry row; один journal plan и один catalog bump. Album944 identity/album_artists, raw tracks/albums, IDs, audio и остальные241 ambiguous proposals вне scope.
4. После разрешённого apply проверить exact DTO/revision/affected sets, no-file-write/hash/stat и conditional undo readiness; повторный apply/undo должен использовать тот же production operation, conflicts не retry автоматически. Если владелец оставляет текущую manual list, D2 data step корректно пропускается и held discrepancy остаётся явно принятой/отложенной.

## Результаты и ограничения

**Passed сейчас:** свежий consistent backup, 5 exact IDs/title/release/before/manual/source/revision, official evidence, fresh241 ambiguity report, четырёхветочная rehearsal с13 CLI commands, idempotence, raw/album/nonselected preservation, atomic stale/undo guards, unchanged five audio hashes/stat, immutable snapshot/historical JSON, финальный selected-row read. Все receipts ниже относятся к этой попытке D1.

**Failed:** неожиданных failures нет; три ожидаемых CLI exit3 подтверждают защиту optimistic revision/conditional undo. Source-код не исправлялся ради результата.

**Not tested:** production apply/undo (не разрешены и scope0), writer freeze/свежий pre-write backup/production restore, массовое исправление241 ambiguous, UI/device/слушательская оценка, полный backend/iOS suite. При отсутствии source drift broad suites не повторялись; проверялся конкретный data workflow на fresh copy. Исторические preview5/apply5/undo5 и248/243 counts — отдельные прежние evidence, не текущая попытка.

## Receipts, provenance и воспроизведение

Все собственные DB/scripts/receipts: `/tmp/puuk-ma-close/task_2982c40d055e`. Source snapshot mode0400 и каталог0700; рабочие копии0600. `brain/venv/bin/python` — Python 3.14.8; production backup использовал remote Python3.13 (подтверждён C0), HEAD `671be2ff8bf2d89a1bc11766d18f62b4faebe5a5` плюс текущие source hashes ниже. Никаких credentials/env values/signing material в отчёте/receipts нет; snapshot не публиковался.

Запуск воспроизводимых probes из корня: `python /tmp/puuk-ma-close/task_2982c40d055e/acquire-snapshot.py` создаёт **новый** snapshot и отказывается перезаписывать существующий; `local-report.py` запускает CLI report с изолированным DB path; `validate-copies.py` создаёт новые disposable branches и также не перезаписывает их; `audio-census.py before|after` только читает5 audio paths; `final-readonly-check.py` только читает production и создаёт новый selected JSON при отсутствии файла. Для новой попытки требуется новый собственный каталог/имена, а не перезапись frozen source.

| Artifact | SHA256 | Содержимое |
|---|---|---|
| `snapshot-receipt.json` | `17902a1c865ee18180beec0f2cfea908f9c41a8c69fcda889c2acc420cca5cdc` | source ro backup transfer, timestamp/schema/counts/integrity/hash |
| `selected-current-rows.json` | `980a8d1ef4e843601a3bddc180ee7be4f1fe6e4489ea5e03f2828b9a37497457` | current5 raw/source/manual/effective rows |
| `dossier.json` | `a1d7c52b59de4048ae81d24e1b560ff03fe5889e350dcca6a7bd83687dbc69f8` | 5-row decisions and current evidence/revisions |
| `album-baseline.json` | `bc3b64b9b352a794f40283b6f46344dae9d2a92b873d698984c5e78af3916b57` | release944 independent attribution |
| `fresh-report.json` | `59adf5f3894e9f03e2d63c7d818ee59cf987673d3d7e1e2d49ccff5ba365011a` | all241 ambiguous candidates and unresolved IDs |
| `fresh-report-receipt.json` | `9ec81006f914a60848b96d64839b29f3044ad6885baadd913bdfa1b9b66adf6a` | CLI argv/cwd/time/exit and source immutability |
| `held-manual-proposal.json` | `f0483ffeec5161f0dc1849381a7d38718813f62bd32ef30948b6390a21b0675e` | one non-actionable exact Monday proposal |
| `coordinator-decision.json` | `27f2ef5547061880e9ccdd968f15e995a9b9337886720fb2b25b6e424ed33da1` | explicit exclusion/manual authority decision |
| `official-tracklist-evidence.json` | `df4eab77facfbe24a66dad26b25c63adc122203b0e90d7b4a3863d5d02927169` | five public tracklist performer subtitles |
| `official-evidence.json` | `8e96f6ee801ff9b93ef7a0477479f2d6d07b7f14c2aec99a37460ca169d85f03` | official exact-track public artist names/URIs |
| `copy-validation.json` | `9e807964a90e6f52a72f290a52302c0993b304dd13b95dbb54db1c3a89cdb2b5` | 13-command rehearsal and exact table deltas |
| `command-receipts.json` | `1edf95ed421df9d8e99857d2b3ba639142d307e361414220d663a5e447173e36` | every CLI command/cwd/start/end/exit/stdout/stderr |
| `journal-audit.json` | `ba696e273550f66e1d6c290d45dc9e01f0a21af7d06767ae22b8d4a784e88d66` | old7 preserved/new1 conditional plan/hash audit |
| `audio-before.json` | `b56abb5df70c7cd54c7cd181af9f39f277db804f18918b631c4a03533e1cf8a6` | before hashes/stat of5 originals |
| `audio-after.json` | `f9042415dc0f04c0f60e74e81f1d6364d35e3feedcb8418e8dd4280acf420a50` | after hashes/stat of5 originals |
| `final-readonly-check.json` | `3d32f98606f5ba6d460800e1fd68cc28fb91914e23b73b5c31194dbab9f0003f` | current5 equality/source immutability/candidate delta |
| `dispatch-receipt.json` | `b5f3160be30f5625d1d5c7d2a1227fac2fc8266c3df69e68b15d7d69a01b550b` | live D1/model/reuse/resource receipt |

Собственные DB: production-snapshot.db (не изменён), rehearsal.db (undone), undo-conflict.db (newer manual retained), apply-conflict.db (stale preview not applied), historical-rejection.db (old preview rejected). Per-command receipts: rehearsal-preview/apply/repeat-apply/undo/repeat-undo; conflict-preview/apply/newer-manual-edit/undo; stale-preview/newer-manual-edit/apply; historical-preview-rejected. Scripts: acquire-snapshot.py, local-report.py, build-dossier.py, audio-census.py, validate-copies.py, intervening-edit.py, final-readonly-check.py, audit-journal.py, write-data-report.py. SQLite sidecars находятся рядом с собственными copies; ни одна backup DB прежних Tasks не перезаписывалась.

| Source path | SHA256 на момент rehearsal |
|---|---|
| `brain/reconcile_artist_credits.py` | `09fd0e129a0aeb4ba887b41a7ea5c9e5258467cb639dd78cf458742f900e755c` |
| `brain/services/artist_credit_bulk_service.py` | `b1158599d556e3e11cf104ca748f6d4c0f97d240a3f3651a16f01b83be804fe2` |
| `brain/services/artist_credit_lock.py` | `27dd0ca51c121af3888498eb95ea6600d79ff71f4ad7a0e45274538021b98102` |
| `brain/repositories/artist_credits.py` | `b72a98488e0c485b4c4d6b0e12d24142338add50abe270854e27aa55b61aeda9` |
| `brain/repositories/base.py` | `348365599eb32d2300c441175e5f6c611a61eb84b385eb5fb1ff99ac24187044` |
| `brain/config.py` | `4029eaf4d6f5822fc80429f9395ddc2f929eaccd37dc8644e3fbcb9523f65d41` |

Финальный собственный receipt `final-verification.json`: hashes исходников/source snapshot/исторического JSON сохранены, actionable selection0 и held fingerprint валидны, raw tracks/albums во всех4 copies равны source snapshot; `git diff --check` exit0.
