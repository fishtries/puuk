# LOCKR — independent SQLite lock review

**Accepted locally; no blocking finding in the three-file repair. Release and live write recovery remain untested.** Review: 2026-10-29 UTC, Run `run_ea37b46b2dc1`, Task `task_8c387ce5f81f`, Dispatch `ctx_982eda6fae6d`. No implementation, deployment, audio, DB maintenance or source-control mutation performed. Ownership: this report and `/tmp/puuk-ma-close/LOCKR/` only.

Read root/brain AGENTS, installed Orca guides, orchestration documents, current Run journal, multi-artist contract and release-it mini. Reused-terminal launch requested/effective fields are both null; provider reports `gpt-6.1-sol`, terminal footer reports high, and coordinator independently confirmed explicit Sol/high launch and footer before assignment. No delegation, Run takeover or historical lifecycle authority used.

## Findings and bounds

- **P1 original defect, addressed:** production-parent telemetry INSERT failure retains an implicit SQLite write transaction when its traceback retains the connection. Readers continue; competing writers time out. Closing in `finally` in history, feedback and stats releases/rolls back the connection even with the exception alive. Independently reproduced with all three exact parent files, not reconstructed approximations.
- **No blocking regression found:** runtime delta consists of exception-safe cleanup and a narrow feedback FK/missing-track 404 mapping. SQL, statistics arithmetic, commit points, existing timeout and return values remain unchanged. No retry or suppression of unexpected failures was introduced. A real external lock remains an error, with recovery after release.
- **Existing partial commit semantics remain:** feedback can commit before stats/favorite/profile work fails. Independent injected later stats failure propagates with one persisted feedback and zero stats; a new caller request creates another event. This repair promises neither endpoint atomicity nor safe automatic replay. Stats' existing separate read/update and arithmetic are not redesigned.
- **Historical trigger remains uncertain:** owner observed the incident after restart and artist-list editing. First sanitized FK failure at 18:48:58 precedes the write-lock cascade; this supports the leak mechanism, but does not identify the missing track/user or prove artist editing generated a stale ID. The isolated artist-edit regression passes: same track ID/path survives and feedback/history writes succeed. This is an invariant check, not reconstruction of the incident payload.

The saved 18:53 diagnostic explicitly reports WAL; absent sidecars do not mean DELETE mode. Its inode is a point-in-time observation without an earlier baseline. No current lock/DB fd was observed then; that does not exclude incident-time contention. Same-process later 200s are historical recovery observations. This review does **not** claim all backend 500s are solved.

## Evidence

Current source is HEAD `671be2ff8bf2d89a1bc11766d18f62b4faebe5a5` plus preserved dirty work. Compared preserved parent bytes against sanitized deployed hashes, generated an independent three-file diff, and verified all 107 files in the executor's tested-source manifest remain unchanged. Accepted F1 service remains `bcbd8d490f381aef3fbe25c762d92abf43c2605f229e2261f88835fe5c932912`; it is outside release scope.

| Status | Evidence |
|---|---|
| **passed, current** | 27 focused checks: 15 independently authored cases plus all 12 implementation regressions; 19:03:11.622497–19:03:14.176003 UTC, exit 0. |
| **passed, current** | Before/after retained FK for history/feedback/stats: parent connection remains in transaction and competing writer fails while reads work; candidate connection is closed and competing writer commits exactly once while traceback remains alive. Parent recovery after explicit probe cleanup also succeeds. |
| **passed, current** | External lock held beyond test busy timeout: all three writers raise, persist zero rows and recover once released. Commit-failure injection propagates original exception, attempts commit once, closes once, rolls back, then recovers. |
| **passed, current** | Full-schema HTTP deletion between known-existing-track lookup and INSERT returns 404; subsequent valid request succeeds once. Missing-user FK with existing track and unrelated runtime error propagate. Supplied regression also preserves unrelated UNIQUE failure. |
| **passed, inspected executor evidence** | Actual `LOCK/full-backend.log` and JSON: 559 passed + 56 subtests, 4 warnings, child exit 0, 18:57:26.668671–18:58:29.020210 UTC. No manifest drift; full backend suite intentionally not repeated. |
| **historical expected failure** | Executor's pre-fix 5 failed / 3 passed log; independent current tests separately demonstrate expected parent lock failure as successful assertions. |
| **not tested / pending** | Optional LOCKJ junior report/artifacts absent at checkpoint; coordinator explicitly permitted primary independent acceptance without waiting. No junior result is inferred. |
| **not tested** | Production candidate runtime/Python 3.13 execution, activation, live authenticated write acceptance, rollback execution and device acceptance. Local runtime is Python 3.14.8 / SQLite 3.54.0; saved production diagnostic reports SQLite 3.46.1. No new production inspection was necessary. |

Exact current command, cwd `/home/fish/projects/puuk/brain`:

```text
/home/fish/projects/puuk/brain/venv/bin/python -m pytest -q -p no:cacheprovider /tmp/puuk-ma-close/LOCKR/test_independent.py /home/fish/projects/puuk/brain/test_sqlite_writer_cleanup.py
```

Runner `/tmp/puuk-ma-close/LOCKR/run.py` records UTC, argv, versions, source hashes and child exit. `PUUK_DB_PATH`, `PUUK_TESTS_TMP`, `MUSIC_DIR` point inside reviewer-owned temporary storage; queue/reconciliation/loudness disabled, outbound sockets forbidden, Qdrant factory denied, no API lifespan/background services started. All probe tables/files are synthetic. No JWT, production access log or environment dump captured.

## Concrete proposed release, awaiting separate authorization

Remote root `/home/fish/apps/puuk/puuk`; install **only** these runtime files. Tests/report are not deployed. Full hashes are acceptance guards, not assertions of future live state.

| Path | Captured deployed parent SHA256 | Reviewed candidate SHA256 |
|---|---|---|
| `brain/repositories/interactions.py` | `458ad9a66c3b198359ee347a5e20f31c372335a0a5760f9de8278eeb7a0e3bca` | `86cf7b4d6238a886d49a0f76d3ea8cc55d73d2bce2038bc360428fa75fa1629a` |
| `brain/repositories/wave.py` | `78a20d72d3376a57c94780acbb03d00b4f944c8bf98450105fa5b895c5a0c6f0` | `bef893d5e9b94f65f43bd5da47efa1a59fca02be2106756c6f8d19b37deab06e` |
| `brain/routers/wave.py` | `1fc694b6605ef0eb8589d28371430247bd7dc5be98a564f43ba596e6a6970e20` | `089e0f3ad9a93c8047e0715ad81c571703b90ca62b07989fb6adde32d2312425` |

1. Coordinator obtains authorization for this exact three-file release plus private backup/staging; prior one-file F1 approval does not cover it. Recheck fresh local candidates, remote parents/F1, unit/PID/start time, DB path, file metadata and current writers (API, bot, scanner/heavy worker and other accessible DB holders). Unknown source drift stops installation. Arrange owner-controlled quiet window if writers or deployment cannot be safely bounded; agent must not signal/stop services. No schema/data/audio change is proposed.
2. Create a fresh timestamped private release directory (0700) outside runtime. Back up all three parent files with hashes/modes/ownership and a consistent SQLite online backup using a read-only source connection, including WAL content. Bound backup time and abort on failure; verify backup integrity/FK/schema and isolated restore, save private receipt (0600). Do not copy only the live main DB or reuse stale F1 backup as current recovery evidence.
3. Stage all three verified candidate files; compile with actual production Python without importing app/startup or generating pyc. Recheck predecessor hash/inode/uid/gid/mode immediately before each atomic replacement, preserve metadata, fsync files/directories, verify all candidate hashes and unchanged F1. Multi-file installation is not atomic as a group: retain a per-file install ledger and stop on any failed guard, restore only installed files from verified backups before activation. No broad `deploy.sh`, migration or DB PRAGMA mutation.
4. Report exact installed hashes/backup receipt to coordinator. **Owner** performs `sudo systemctl restart puuk-brain`; agent sudo is unavailable and must not substitute signals. Confirm new PID/start time and active/running. Allow at most 60 seconds for bounded read-only functional readiness: `/api/auth/me`, existing track/album/artist GETs and personalized recommendations with canonical participant DTO/F1 checks. Historical `/api/health` is 404, so it is not a readiness pass. Keep credentials out of URLs and recorded output; sanitize journal summaries.
5. Production failure injection/live telemetry writes are outside this proposal. Read-only readiness cannot establish repaired live write behavior; require separately scoped owner acceptance before claiming it. On failure, stop activation/retries and inspect evidence. If rollback is authorized, restore only the three verified pre-install source copies, verify parent hashes/F1, then owner restarts and repeats bounded read checks. Keep the current database and later user data; backup restore is a separate recovery decision. Source rollback restores the old leak.

Review acceptance covers the prepared code and bounded reproduction. It does not authorize installation/restart or close live/device gates; no additional code-fix task is requested.

## Artifacts

Reviewer directory `/tmp/puuk-ma-close/LOCKR/`: `test_independent.py`, `run.py`, `targeted.json`/`.log`, three `*.before.py` copies, `reviewed.patch`, `source-review.json`, `evidence-review.json`, `baseline-status.txt`, `launch.json`. Executor evidence remains under `/tmp/puuk-ma-close/LOCK/`, indexed in [MA_SQLITE_LOCK_FIX.md](MA_SQLITE_LOCK_FIX.md). Temporary artifacts are local diagnostic evidence; this report is the durable result.
