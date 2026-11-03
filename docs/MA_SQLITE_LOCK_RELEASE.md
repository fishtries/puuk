# LOCKDEP — installed only, activation deferred

**Succeeded for authorized install-only scope.** Three reviewed runtime files installed on production disk on 2026-10-29 at **19:07:47 UTC**. Owner explicitly authorized «Установить; restart сделаю позже». No restart, signals, sudo, live write probes, schema changes, DB restore, deployment script or audio edits performed. Activation/readiness/live write acceptance remain **not tested, pending owner restart**.

Run `run_ea37b46b2dc1`; Task `task_cfa85bbcca4a`; Dispatch `ctx_f8b882a6d064`. Reused-terminal launch requested/effective fields both null; provider reports Codex `gpt-6.1-sol`, prior verified terminal effort high. No delegation or Run rebinding. Prior [independent review](MA_SQLITE_LOCK_REVIEW.md), 27 focused checks and executor 559 + 56 subtests remain historical accepted evidence; no tests repeated or implementation changed here.

## Actual execution and checks

Local cwd `/home/fish/projects/puuk`; runner `python /tmp/puuk-ma-close/LOCKDEP/run.py` invoked:

```text
ssh -p 59348 -o BatchMode=yes -o ConnectTimeout=10 fish@192.168.1.117 /usr/bin/python3.13 -
```

UTC **19:07:46.731226–19:07:47.496287**, exit **0**. Stdin contained the saved `remote.py` plus exact reviewed candidate bytes. Remote Python **3.13.5**, SQLite **3.46.1**; candidates compiled without importing application code or generating pyc. Local source version is HEAD `671be2ff8bf2d89a1bc11766d18f62b4faebe5a5` plus the preserved dirty baseline and reviewed candidate hashes below.

**Passed:** all three remote parents matched reviewed SHA256 and uid/gid/mode; accepted F1 matched before and after. DB `/home/fish/apps/puuk/puuk/brain/puuk.db`, device 66306/inode 542170, schema12, WAL. Census: 1,197 tracks, 892 albums, 931 artists, 6,165 history rows, 7 artist-credit operations. No matching DB/sidecar write lock observed during preflight; this is a snapshot, not a claim that contention cannot recur. Same-UID process census found API PID3916574 and bot PID3915367 in expected directories, no DB path override, no scanner/heavy worker. Compatible writers continued; none was stopped.

**Passed:** fresh private directory `/home/fish/.local/state/puuk-releases/lockdep-20261029T190747078112Z`, mode0700. Original source bytes backed up as `brain__repositories__interactions.py.before`, `brain__repositories__wave.py.before`, `brain__routers__wave.py.before`; private backup/receipt files0600. Original uid1000/gid1000/mode0644/inodes recorded in receipt.

SQLite online backup used source URI `mode=ro`, with 25-second progress deadline and 2-second connection timeout. `before-release.db` SHA256 **`a2ffe4aae7d05570d2ca653f8d493af1841d05414fcf669f5416145d1a8f35da`**. Backup integrity `ok`, FK violations0, schema12. Backup API restored into private `restore-verification.db`; same SHA256, integrity/schema and all table row counts/content hashes equal. Production database was never restored or replaced; no production PRAGMA mutation, checkpoint or journal deletion occurred.

**Passed:** all three candidates staged next to targets with verified bytes/metadata before any replacement. Immediate per-file parent hash/inode/metadata guards passed; atomic replacements and parent-directory fsyncs completed. Per-file ledger durably records replacing/installed states; final three hashes and metadata verified. The three-file operation was not atomic as a group; guarded source-only rollback code was prepared but not exercised because no replacement failed. Temporary stages removed.

## Exact installed scope

Remote root `/home/fish/apps/puuk/puuk`:

| Path | Verified predecessor SHA256 | Installed SHA256 |
|---|---|---|
| `brain/repositories/interactions.py` | `458ad9a66c3b198359ee347a5e20f31c372335a0a5760f9de8278eeb7a0e3bca` | `86cf7b4d6238a886d49a0f76d3ea8cc55d73d2bce2038bc360428fa75fa1629a` |
| `brain/repositories/wave.py` | `78a20d72d3376a57c94780acbb03d00b4f944c8bf98450105fa5b895c5a0c6f0` | `bef893d5e9b94f65f43bd5da47efa1a59fca02be2106756c6f8d19b37deab06e` |
| `brain/routers/wave.py` | `1fc694b6605ef0eb8589d28371430247bd7dc5be98a564f43ba596e6a6970e20` | `089e0f3ad9a93c8047e0715ad81c571703b90ca62b07989fb6adde32d2312425` |

Installed files retain uid1000/gid1000/mode0644. Accepted `brain/services/personalized_recommendation_service.py` remains **`bcbd8d490f381aef3fbe25c762d92abf43c2605f229e2261f88835fe5c932912`**. No other runtime file was installed.

API unit remained active/running with unchanged PID **3916574**, start **2026-10-29 21:35:32 MSK (18:35:32 UTC)** before/after install. Disk hash does not establish loaded-code activation. No functional readiness or authenticated API writes were performed. No claim that production lock symptoms or all 500s are resolved.

## Remaining owner action and rollback boundary

Owner restarts `puuk-brain` later as already agreed; this task did not ask again or wait for it. A subsequent authorized verification should confirm new PID/start time, installed hashes/F1 and bounded read-only functional readiness; live write acceptance remains a separate scoped check. Do not reinstall already accepted bytes solely because restart was deferred.

If rollback is authorized, inspect fresh target hashes, restore only the three verified source backups while preserving original metadata, verify parent hashes/F1, and have owner restart. Keep current DB and later user data. Source rollback restores the previous leak; DB restore requires a separate recovery decision. Rollback execution and physical device acceptance are **not tested**.

## Receipts

Local `/tmp/puuk-ma-close/LOCKDEP/`: `launch.json`, `remote.py`, `run.py`, `command-receipt.json`, `remote-result.json`, `remote-stderr.txt` (empty). Remote private directory above contains `receipt.json`, three source backups, `before-release.db`, `restore-verification.db`. Receipt records preflight facts, source guards, backup inspection/all-table hashes, exact replacement ledger UTC, final hashes/metadata and unchanged unit. No credentials, JWTs, environment dumps or raw access logs were captured.
