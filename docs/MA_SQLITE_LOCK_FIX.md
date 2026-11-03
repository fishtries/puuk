# SQLite writer lock incident — LOCK

Local repair prepared, not deployed. Current attempt: `run_ea37b46b2dc1` / `task_d83b12afb058` / `ctx_e23b9479848c`, 2026-10-29. Orca `worker-show` verified launch requested/effective both Codex `gpt-6.1-sol` / `high`; no delegation or Run rebinding. Existing dirty work preserved; no reset, clean, commit, audio changes, production write probes, deploy, restart, signals or DB maintenance.

## Finding and confidence

The proven code defect is a failed telemetry INSERT leaving its SQLite connection/implicit write transaction open until exception frames are collected. `add_wave_feedback`, `add_history` and the feedback path's `update_track_stats` closed only after successful execute/commit. SQLite aborts a failed foreign-key statement without ending its transaction. A retained traceback can therefore retain the sole WAL writer while unrelated GETs continue and other writes hit the existing 5000 ms busy timeout.

This mechanism was reproduced using the exact production history/wave source hashes and isolated synthetic WAL tables: retain the original FK exception, successfully read, attempt a valid history write on another thread, observe `database is locked`. Five cases failed before cleanup (missing track/user for history/feedback, missing track for stats); all recover with cleanup while retaining the exception. Three existing-lock/release scenarios passed before and after, showing ordinary contention itself is not the defect. No timeout increase, event retry or swallowed error was added.

Production chronology strongly supports this failure chain, but the incident-time lock holder and exact FK parent cannot be established retrospectively. In particular, absent locks in a later snapshot do not prove absence of contention during the incident.

| UTC 2026-10-29 | Sanitized observation |
| --- | --- |
| 18:34:17, 18:35:33 | API startup complete; current system unit started 18:35:32, PID 3916574 |
| through 18:48:09 | Successful artist-list PUTs after restart |
| 18:48:58.333309 | First logged `sqlite3.IntegrityError: FOREIGN KEY constraint failed`, `wave.add_wave_feedback` INSERT |
| 18:49:02.428140, 18:49:08.712577, 18:49:18.083475 | Three more FK errors at the same INSERT |
| 18:49:03–18:50:34 | Lock cascade: history/feedback/play-start INSERTs fail; credits PUT returns 503 |
| 18:50:34.722024, .774980, .805783 | Feedback 200, credits PUT 200, feedback 200 under the same API PID |
| 18:52:15–18:52:23 | Further successful feedback responses, before this worker's inspection |

Request bodies are unavailable in access logs, so the missing feedback track/user ID was not reconstructed. Authentication checks that the user still exists, making a stale/deleted feedback track a plausible trigger, not an established historical fact. Owner reported noticing the incident after restart and an artist-list edit. Fresh read-only DB checks found no FK violations, zero orphan track-credit links, and the latest bulk operation at 06:13 UTC. Latest audio mutation journal entries through 18:46:19 were committed. Single credit edits have no dedicated timestamped operation log, so absence of a new bulk operation says nothing against the reported single edit.

The artist-credit mutation code updates credits without deleting/recreating the track. A new isolated integration test edits artists, confirms the same track ID and file path, and successfully records feedback/history without reading real audio. It does not establish which client payload triggered the historical incident.

## Fresh production read-only evidence

`remote-initial.txt`, 18:53:04.995900 UTC:

- Explicit SQLite URI `mode=ro`: journal mode **WAL**, schema cookie 89 (not migration version); initial absent `-wal`/`-shm`/`-journal` sidecars do not imply DELETE mode.
- DB `/home/fish/apps/puuk/puuk/brain/puuk.db`, device 66306 (`103:02`), inode 542170, size 4911104. No prior DB inode was established, so no claim of file replacement.
- API PID 3916574 started 18:35:32 UTC; bot PID 3915367 started 18:34:16 UTC. At a subsequent 18:53:32 inspection `/proc/fd` was readable (17 API / 7 bot descriptors), with no DB or deleted descriptors. No matching current-inode lock in `/proc/locks` at the initial snapshot.
- Both processes have no `PUUK_DB_PATH` override; expected component cwd, root `/`, shared mount namespace, and matching deployed config/base select the expected DB path. This is configuration/path evidence, not introspection of a past connection.
- Current Python source hashes captured fresh, including all changed parents and F1. Production has extra historical modules absent locally; the patch's parent files match exactly. Accepted F1 remains `bcbd8d490f381aef3fbe25c762d92abf43c2605f229e2261f88835fe5c932912` locally and on production disk. Disk hashes are not a claim of live module introspection.
- No scanner/heavy worker was observed in accessible production Python processes. API startup/background functions use repository connections; current track ingest/credit edits already share explicit transactions with cleanup. Schema init's remaining exception-cleanup weaknesses were examined but no startup exception or nested-connection incident was found. SFTP code transfers audio locally and does not replace the production SQLite file; no such transfer or worker was started here. These facts do not exclude a writer that finished before the snapshot or another UID's process.

Sanitization happened remotely before saving/output: only whitelisted exception classes/stack locations, process/path facts, hashes, timestamps, HTTP route categories/status and hashed track-ID membership. No supplied JWT, raw access log, complete environment or signing secret was saved or emitted.

## Changes and preserved semantics

- `brain/repositories/interactions.py`: `add_history` closes in `finally`, including FK/operational/commit errors.
- `brain/repositories/wave.py`: same cleanup for `add_wave_feedback` and `update_track_stats`. Closing an uncommitted SQLite connection rolls back, even while exception frames survive. SQL, commit points, return values, feedback durations and statistics arithmetic are unchanged.
- `brain/routers/wave.py`: catch only the actual SQLite FOREIGN KEY extended error code from the initial feedback write; after cleanup, return 404 only if a fresh track lookup confirms absence. A post-failure lookup covers deletion racing any earlier lookup. Missing-user and unrelated integrity errors are re-raised, not acknowledged. No retry is introduced.
- `brain/test_sqlite_writer_cleanup.py`: 12 isolated regression/integration cases; no network, real audio, scanner, reconciliation or loudness work.

History/feedback remain append events, and play-start retains its existing daily dedup contract; no changes to artists/play-start implementation. Credits busy rollback/503/Retry-After behavior remains covered by the full backend tests. Feedback's existing multi-step commits are not made into a new atomic API: failure later in the handler can still follow a committed event; this patch adds no automatic replay that could duplicate it. Other repository writers with historical success-only cleanup are outside the evidenced incident path and were not broadly rewritten.

## Checks in this attempt

All test commands used cwd `/home/fish/projects/puuk/brain`, executable `/home/fish/projects/puuk/brain/venv/bin/python`, isolated `PUUK_DB_PATH`, test password setup and disabled outbound embedding queue/reconciliation/loudness settings through the runner. Each new regression fixture uses another temporary SQLite file. Runtime: local Python 3.14.8 / SQLite 3.54.0 / pytest 9.1.1; production executable `/usr/bin/python3.13`, diagnostic SQLite 3.46.1. Exact argv, start/end UTC, exit code, HEAD and changed-source hashes are in the paired JSON receipts. Local HEAD is `671be2ff8bf2d89a1bc11766d18f62b4faebe5a5` plus the preserved dirty baseline.

| Status | UTC start → end | Command after `python` | Result / receipt |
| --- | --- | --- | --- |
| failed, expected before repair | 18:54:59.273215 → 18:55:01.180441 | `-m pytest -q test_sqlite_writer_cleanup.py` (initial 8-case file) | 5 failed / 3 passed, pytest exit 1; `before.json`, `before.log` |
| passed | 18:55:17.568707 → 18:55:31.944592 | `-m pytest -q test_sqlite_writer_cleanup.py test_wave.py test_wave_stage2.py test_personalization.py test_multi_artist_api.py test_artist_review_regressions.py` | 69 passed, exit 0; `after-targeted.json`, `.log` (before router enhancement) |
| passed | 18:56:59.709604 → 18:57:13.004291 | `-m pytest -q test_sqlite_writer_cleanup.py test_multi_artist_api.py test_artist_review_regressions.py` | 45 passed, exit 0; `after-router.json`, `.log` (final 12-case file and router) |
| passed | 18:57:26.668671 → 18:58:29.020210 | `-m pytest -xvs` | **559 passed + 56 subtests**, 4 deprecation warnings, exit 0; `full-backend.json`, `.log` |
| passed, read-only | 18:53:04.995900 | `ssh -p 59348 -o BatchMode=yes fish@192.168.1.117 python3 -`, stdin `remote_diagnostic.py` | exit 0; remote cwd `/home/fish`; `remote-initial.txt`, `remote-receipts.json` |
| passed, read-only | 18:56:30.786533 | same SSH argv, stdin `incident_detail.py` | exit 0; remote cwd `/home/fish`; `incident-detail.txt`, `remote-receipts.json` |

The runner itself exits normally after recording the child pytest exit code; the table reports **pytest** status. Remote command end times were not captured; UTC start is printed by the remote script. Earlier 18:53:32 fd census was observed in tool output and corroborated in the saved second diagnostic; no invented separate receipt. Source changed between the first two targeted invocations only as described; the full suite covers the final candidate. Historical F1 tests/release receipts are not counted as tests run by this worker.

**Not tested:** repaired production runtime or live authenticated write acceptance (read-only authorization); exact production Python/SQLite version execution; native/iOS device acceptance. No production symptom was injected. No claim of permanent current recovery is made from a past 200 response. The exact original invalid payload is unavailable.

## Prepared release scope, risks and rollback

A separate reviewed/authorized release would install **only these three runtime files**, preserving the rest of the current deployment and the accepted F1 file. `deploy.sh` is too broad for this allowlist and was not run. No schema migration, DB replacement, checkpoint, VACUUM, journal deletion or audio mutation is part of the repair. Backup/guarded install and an API restart would be future production actions requiring the coordinator's authorization check; prior one-file F1 approval does not authorize them here.

| Runtime file | Fresh production parent SHA256 | Candidate SHA256 |
| --- | --- | --- |
| `brain/repositories/interactions.py` | `458ad9a66c3b198359ee347a5e20f31c372335a0a5760f9de8278eeb7a0e3bca` | `86cf7b4d6238a886d49a0f76d3ea8cc55d73d2bce2038bc360428fa75fa1629a` |
| `brain/repositories/wave.py` | `78a20d72d3376a57c94780acbb03d00b4f944c8bf98450105fa5b895c5a0c6f0` | `bef893d5e9b94f65f43bd5da47efa1a59fca02be2106756c6f8d19b37deab06e` |
| `brain/routers/wave.py` | `1fc694b6605ef0eb8589d28371430247bd7dc5be98a564f43ba596e6a6970e20` | `089e0f3ad9a93c8047e0715ad81c571703b90ca62b07989fb6adde32d2312425` |

Before any future install, compare fresh live hashes to these parents and verify file backups/ownership/modes. Prepare all three together, activate through an explicitly authorized API restart, then perform agreed bounded acceptance without automatic telemetry retries. If rollback is authorized, restore only those three verified pre-install file copies and restart the API; keep the current DB and F1 service untouched. Rollback restores the old leak, so prefer forward repair if this candidate's failure is unrelated.

Primary risk is untested live runtime/version acceptance. The intentional API change is missing-track feedback becoming 404 rather than an unhandled 500. Genuine prolonged external contention still respects the existing timeout and surfaces an error. Exact original invalid track source and other legacy cleanup deficiencies remain separate investigation boundaries; increasing busy_timeout is not a fix for a retained writer.

## Artifacts

All diagnostics/receipts belong to `/tmp/puuk-ma-close/LOCK/`:

- `remote_diagnostic.py`, `remote-initial.txt`, `incident_detail.py`, `incident-detail.txt`, `remote-receipts.json`: sanitized production evidence and replayable read-only diagnostic scripts.
- `run_check.py`; `before`, `after-targeted`, `after-router`, `full-backend` paired `.json`/`.log`: commands, isolation settings, exact source hashes and results.
- `wave.before.py`, `interactions.before.py`, `router.before.py`, `implementation.patch`: preserved pre-task dirty parent files and task-only runtime delta; the router's HEAD version was verified against the fresh remote parent SHA before saving.
- `release-hashes.json`, `tested-source-manifest.json`: final candidate/parent/F1 hashes and all 107 local backend Python source hashes captured after the final full suite, with no source edits during that suite.

Durable modified files for this Task: the three runtime files, the new regression module, and this report. Coordinator owns Run summary and independent release review; neither was modified here.
