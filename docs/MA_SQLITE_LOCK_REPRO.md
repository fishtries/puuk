# SQLite lock incident — isolated reproduction (LOCKJ)

Status: **investigation complete (isolated only)**. No production access, no network, no SSH,
no source/test/config edits, no production DB writes. Only this report and
`/tmp/puuk-ma-close/LOCKJ/` were written.

- Local time of runs: 2026-10-29T19:22Z–19:32Z (UTC timestamps per command in receipts).
- Workdir for all runs: `/home/fish/projects/puuk/brain`; interpreter
  `/home/fish/projects/puuk/brain/venv/bin/python` (3.14.8).
- Isolation: `PUUK_DB_PATH=/tmp/puuk-ma-close/LOCKJ/db/*.db`,
  `MUSIC_DIR=/tmp/puuk-ma-close/LOCKJ/music`,
  `EMBEDDING_QUEUE_ENABLED=false`, `EMBEDDING_RECONCILE_ENABLED=false`,
  `LOUDNESS_SYNC_ENABLED=false`, `QDRANT_URL=http://127.0.0.1:1`.
- Pinned pre-fix bytes used (copied, not edited):
  `wave.before.py` `78a20d72d3376a57c94780acbb03d00b4f944c8bf98450105fa5b895c5a0c6f0`,
  `interactions.before.py` `458ad9a66c3b198359ee347a5e20f31c372335a0a5760f9de8278eeb7a0e3bca`
  (`/tmp/puuk-ma-close/LOCK/`, copies in `/tmp/puuk-ma-close/LOCKJ/orig/`).
- Current working tree (already patched with `try/finally`) at capture time:
  `wave.py` `bef893d5e9b94f65f43bd5da47efa1a59fca02be2106756c6f8d19b37deab06e`,
  `interactions.py` `86cf7b4d6238a886d49a0f76d3ea8cc55d73d2bce2038bc360428fa75fa1629a`
  (full list: `/tmp/puuk-ma-close/LOCKJ/receipts/source-sha256.txt`).

## Result

The reported symptom set is reproducible from a single in-process mechanism, with no
external lock holder:

1. A telemetry INSERT fails `FOREIGN KEY constraint failed` inside the **pinned**
   `repositories.wave.add_wave_feedback` / `interactions.add_history` /
   `repositories.wave.update_track_stats`. These versions only close the connection on
   success, so the failed statement's connection stays open with its implicit write
   transaction and writer lock.
2. While the exception/traceback is retained (in-flight request), every other writer
   waits the full `busy_timeout=5000 ms` and fails
   `sqlite3.OperationalError: database is locked` (`SQLITE_BUSY`, code 5).
3. Reads (`get_user_history`, `get_track`) keep working during the lock.
4. Credits PUT under the same lock returns exactly `503 {"code":"credits_busy"}`.
5. Dropping the retained exception/traceback and running GC releases the lock
   immediately; writers recover without a process restart.

| Scenario (isolated DB) | First FK failure | Open conns after failure | Next writer | Reads during lock | After `del` traceback + `gc.collect()` |
|---|---|---|---|---|---|
| `before-wal` (pinned `add_wave_feedback`) | `IntegrityError` FK 0.2 ms | 1 | real `add_history`: `SQLITE_BUSY` after **5004 ms** | ok (`get_user_history`, `get_track`) | 0 open, writer ok in 0.4 ms |
| `before-delete` (same, journal=delete) | FK 0.2 ms | 1 | `SQLITE_BUSY` after **5005 ms** | ok | 0 open, writer ok in 0.4 ms |
| `before-history` (pinned `add_history`) | FK 0.3 ms | 1 | `SQLITE_BUSY` after **5004 ms** | ok | 0 open, writer ok in 0.4 ms |
| `before-stats` (pinned `update_track_stats`) | FK 0.3 ms | 1 | `SQLITE_BUSY` after **5006 ms** | ok | 0 open, writer ok in 0.3 ms |
| `fixed-wal` (current tree) | FK 0.3 ms | **0** | writer ok in 0.3 ms | ok | 0 open, writer ok |
| `credits-under-lock` | FK | 1 | credits PUT **503 `credits_busy` after 5005 ms** | not exercised | 0 open, credits PUT ok (track id preserved) |

Repeated failed-FK attempts after the first leak each blocked ~5004 ms and returned
`SQLITE_BUSY` (they could no longer reach the FK check). `PRAGMA integrity_check`
returned `ok` before and after every scenario.

## Retention boundary (why cleanup matters)

`lockj_retention_debug.py` isolates the retaining reference:

| Step | Live connections | Second writer |
|---|---|---|
| A. FK failure, exception + `__traceback__` retained | 1 | `SQLITE_BUSY: database is locked` |
| B. `del` retained exception/traceback + `gc.collect()` | 0 | write ok |
| D. FK failure handled without retention (normal `except: pass`) | 0 | write ok |

So the persistent lock is the **unclosed connection held alive by the retained traceback
frames** (`conn` is a local in the failing function's frame). It is not an external
process, not a reader-upgrade `BUSY_SNAPSHOT` (all errors were `SQLITE_BUSY` code 5, never
`SQLITE_BUSY_SNAPSHOT`, and readers never failed), and it needs no restart once the
traceback is released.

## Reproduced vs. limits

Reproduced (actual behavior of pinned production bytes on a real isolated schema):

- failed-FK INSERT leaves an open writer transaction (`add_wave_feedback`, `add_history`,
  `update_track_stats`);
- other writers fail with the exact production error while readers continue;
- credits PUT maps the same SQLite busy to `503 credits_busy` (the flock path was not
  contended in this test, so the 503 came from the `OperationalError` mapping in
  `services/artist_credit_service.py`, not from `artist_credit_lock`);
- release on cleanup and no leak with the current `try/finally` versions;
- behavior is journal-mode independent (WAL and DELETE both reproduce);
- manual artist edit on an isolated track preserves `track_id` and normal feedback/
  history writes still succeed afterwards (`artistedit` scenario).

Not proven / limits:

- The production journal's FK cause (which `user_id`/`track_id` was missing) is not in my
  evidence; only that the failing statement was `add_wave_feedback`.
- Why the production traceback stayed alive ~90 s is not proven. The mechanism and its
  release boundary are proven; the exact retention by uvicorn/Starlette/logging was not
  observed live.
- Production journal mode was not inspected (read-only policy). The leak reproduces in
  both WAL and DELETE, so the mechanism does not depend on it.
- No production evidence rules out an *additional* long-lived writer (for example a slow
  credit/album transaction). This repro only proves the FK-leak path is sufficient.
- `add_favorite`/`add_dislike` catch only `IntegrityError` and `remove_*`/
  `set_user_embedding` still lack `try/finally`; an `OperationalError` there would also
  skip `close()`. Not exercised here — see suggestions.

## Regression suggestions (for the source owner)

1. Keep `try/finally: conn.close()` on every repository write path (closing rolls back the
   open implicit transaction). Current tree already does this for the three reproduced
   functions.
2. Add a regression test that retains the failed-FK exception/traceback, then performs a
   second write on a short-timeout connection and asserts no `SQLITE_BUSY`, in both WAL and
   DELETE journals; also assert the lock is released after dropping the traceback.
3. Prefer a shared `with get_connection() as conn:` helper so the leak class cannot recur;
   cover `add_favorite`, `add_dislike`, `remove_favorite`, `remove_dislike`,
   `set_user_embedding`.
4. Validate `user_id`/`track_id` before telemetry INSERT (or catch `IntegrityError` in the
   routers) so a deleted/renamed track cannot enter the exception path.
5. Avoid keeping exception objects/tracebacks in application state; secondary to (1).

## Artifacts

- Report: this file.
- Scripts: `/tmp/puuk-ma-close/LOCKJ/scripts/lockj_repro.py`,
  `lockj_retention_debug.py`, `lockj_credits_503.py`.
- Raw per-run JSON/logs: `/tmp/puuk-ma-close/LOCKJ/logs/*.json`, `*.stderr`.
- Per-command UTC/cwd/exit: `/tmp/puuk-ma-close/LOCKJ/receipts/scenarios.cmd.jsonl`.
- Source and pinned-copy hashes: `/tmp/puuk-ma-close/LOCKJ/receipts/source-sha256.txt`,
  `orig-copies-sha256.txt`.

All scenario processes exited 0 (the expected SQLite errors are recorded inside the JSON
receipts, not as process failures). No tokens, credentials, audio, or production data were
used or copied.
