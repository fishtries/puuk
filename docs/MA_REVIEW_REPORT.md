# Independent multi-artist review

Scope: review against `/tmp/puuk-ma-baseline/tree` and its `feature-changes.json` (pre-run dirty baseline), frozen contract and integration evidence. No implementation files were changed. This is a risk-based independent review; the confirmed T19 failures block G4 acceptance.

## Confirmed finding

- **P1, new feature, T19 async event loss:** `app/ios/puuk-ios/hooks/usePlayerController.js:594` increments one generation for every credits event; line 606 discards an in-flight bulk response after an unrelated track event. Reproduced with a Jest test in `/tmp/puuk-ma-review-ios/hooks/__tests__/usePlayerController.test.js`: play track A with artist `Old`, delay the `credits_only` response for bulk affecting A, emit a track event for unrelated B, then return A with `New`. The assertion expects `New` but receives `Old` (exit 1). This event flow did not exist in the pre-run dirty baseline. `app/ios/puuk-ios/App.js:181` has the same defect for the inactive saved last track: an extracted-effect Jest harness with delayed bulk A then unrelated single B observed zero saved-track writes after A resolved; expected the updated A. The harness mocks storage and network and executes the source effect, not the full mounted app.

- **P1, new feature, T19 cross-session response:** `app/ios/puuk-ios/hooks/usePlayerController.js:603` starts an authenticated request and line 606 applies it without checking `authEpochRef` (the epoch changes at line 241). Reproduced in the temporary Jest copy: play A, delay its bulk response, emit an auth listener change from user 1 to user 2, and resolve user 1's response containing artist `Old User`; current metadata changes to `Old User` when it should remain `Old`. This is a new async path relative to the pre-run baseline; the mock demonstrates missing session invalidation, not a production privacy incident.


## Commands and evidence

- `cd brain && PUUK_DB_PATH=/tmp/puuk-ma-review-test.db venv/bin/python -m pytest -q test_multi_artist_storage.py test_multi_artist_api.py test_multi_artist_bulk.py test_multi_artist_import.py test_multi_artist_recommendations.py test_multi_artist_integration.py test_multi_artist_merge_race.py test_gate2_findings.py test_gate2_fixes.py`: **exit 0**, 124 passed, 3 warnings, 31.40s. Fixtures isolate SQLite and stub external services; no live Qdrant/audio writes intended.
- `cd app/ios/puuk-ios && npm test -- --runInBand shared/components/__tests__/ArtistSelector.test.js shared/components/__tests__/ArtistCreditsEditor.test.js features/library/__tests__/CreditsDraft.test.js`: **exit 0**, 3 suites/11 tests passed.
- `orca orchestration check --terminal term_ad3469ac-6278-426f-b388-65e02201dc09 --json`: **exit 0**, coordinator checkpoint read.
- `cd /tmp/puuk-ma-review-ios && npm test -- --runInBand hooks/__tests__/usePlayerController.test.js -t 'review: unrelated credit event'`: **exit 1**, reproduced failure above; copy created with `tar` excluding node_modules and linked existing dependencies, no repository implementation edits.
- `cd /tmp/puuk-ma-review-ios && npm test -- --runInBand hooks/__tests__/usePlayerController.test.js -t 'review: bulk response from previous user'`: **exit 1**, reproduced cross-session response above.
- `cd /tmp/puuk-ma-review-ios && npm test -- --runInBand hooks/__tests__/reviewAppRace.test.js`: **exit 1** after fixing the temporary test import path (first run exit 1, module not found); actual extracted App effect failed expected saved A update with zero writes.
- Synthetic isolated SQLite scale script: schema init, insert 10,001 tracks / 1,000 artists, backfill, `get_tracks_page(limit=10001)`, serialize with empty favorites and JSON encode: **exit 0**, 9,563,209 bytes (956.2 bytes/track), read 0.112s; `limit=0` returned zero. This is a synthetic local uncompressed payload, not a production latency or upper bound. Existing test verifies 52 state SELECTs for 10,001 IDs (chunks of 400).
- Isolated CLI subprocess harness (`PUUK_DB_PATH=/tmp/puuk-ma-review-cli.db`, `PUUK_ADMIN_PASSWORD=test`): report **exit 0**; preview/apply/undo as ordinary user each **exit 2 / forbidden**, apply unknown actor **exit 2 / unauthorized**; harness **exit 0**. Earlier shell batch returned exit 2 from final denied undo, as expected. Existing bulk fixtures cover admin success and confirmation, API fixtures cover no-auth, ownership, foreign/system and all-track album permission.
- `cd /tmp/puuk-ma-review-ios && npm test -- --runInBand hooks/__tests__/usePlayerController.test.js -t 'review: newer event'`: **exit 0**, one test verifies newer same-track single update wins over a delayed older bulk response.
- Fresh read-only SQLite snapshot backed up to `/tmp/puuk-ma-review-snapshot.db`, then `PUUK_DB_PATH=/tmp/puuk-ma-review-snapshot.db venv/bin/python` with `init_db()` twice: **exit 0**. Source was schema 11; 1,149 track id/path/raw artist/album mappings and 891 album id/title/raw artist rows unchanged, integrity `ok`, zero foreign-key violations. This selective comparison does not verify every artwork/event/stat field.
- `cd app/ios/puuk-ios && npm test -- --runInBand hooks/__tests__/usePlayerController.test.js shared/api/__tests__/apiCache.test.js shared/api/__tests__/artistCredits.test.js shared/domain/__tests__/artistCredits.test.js components/fullplayer/__tests__/FullPlayerControlsAndMenu.test.js features/albums/__tests__/AlbumScreen.test.js features/artists/__tests__/ArtistCreditBulkScreen.test.js`: **exit 0**, 7 suites/103 tests.
- `PUUK_DB_PATH=/tmp/puuk-ma-review-bot.db brain/venv/bin/python -m pytest -q tg_music_bot --ignore=tg_music_bot/test_ydl.py --ignore=tg_music_bot/test_spotify.py`: **exit 0**, 33 passed; excluded scripts perform network operations.
- `cd app/web && npm test`: **exit 0**, 75 passed; node test emitted expected no-window Web Audio fallback messages.
- Reviewed component instructions, contract, plan, integration report, feature inventory, selector, resolver fixture and player refresh code. Risk-based review used the baseline change manifest and current sources rather than an exhaustive 96-file line-by-line diff.
- Prior full suites are reported in `MA_MA_INTEGRATION_REPORT.md`; they were not independently rerun here. Baseline recorded 438 backend, 567 iOS, 75 web and 29 bot tests passing; no independently reproduced baseline failure.


## Read surface and critical fixture audit

`serialize_track` call sites inventoried with `rg`: track catalog/detail, library page, search, album tracks, artist popular tracks, playlist, favorites/history, metadata editor and credit mutation. Collection repository reads hydrate before serialization; track `credits_only` and credit service hydrate singleton rows, and editor hydrates separately. Wave next/queue and personalized paths use `build_wave_track_payload`, which hydrates existing raw rows through batch lookup; selected integration fixture checks history/favorites/playlist/wave against the same A+B DTO and revisions. This inventory is a source audit plus a targeted fixture, not a distinct HTTP integration test for each route.

T07/T08 critical fixture inspection: `test_db_only_credits_and_catalog` traps the file resolver during track/album credits and checks temporary WAV SHA256, size and nanosecond mtime; missing-file legacy and DB-only GET fixtures pass. `test_real_old_web_payloads_keep_artists_out_of_audio_patches` checks a copied MP3 before/after DB-only PUT, editor reconciliation, forced resync and journal recovery, then spies the real file writer to verify old web title/cover edits omit both artist fields. `test_scan_and_recovery_keep_independent_manual_credits` exercises independent track/album manual lists and empties across rescan and lost-row recovery, preserving album ID and fingerprint; provider/re-download cases use generated temporary format fixtures. No real audio or Qdrant was written. Explicit instrumentation of every possible filesystem syscall is not claimed.

## T01–T23 evidence matrix

PASS below means the named automated fixture passed in the targeted run, not all contract permutations or a release gate. PARTIAL identifies unverified contract requirements; prior reports are supplementary, not independent proof.

| ID | Status | Evidence / limitation |
|---|---|---|
| T01 | PARTIAL | Storage rollback fixtures passed; independently migrated schema 11 snapshot copy twice with selective identity and integrity checks. |
| T02 | PASS (fixture) | Storage normalization, empty and literal names. |
| T03 | PARTIAL | Integration collection/wave fixture passed; all DTO parity not exhaustively checked. |
| T04 | PASS (fixture) | Storage search and API catalog fixtures. |
| T05 | PASS (fixture) | API guest versus album attribution and album membership fixture. |
| T06 | PASS (fixture) | API album-only artist and empty album fixture. |
| T07 | PARTIAL | API missing-file and hash/stat fixture passed; not independently instrumented every reader/resolver and backfill/GET combination. |
| T08 | PARTIAL | Real-format rescan/recovery independent manual credits fixtures passed; full journal/editor/re-download matrix not independently proven. |
| T09 | PASS (fixture) | Storage source ranks and import provider/tag tests. |
| T10 | PASS (fixture) | Real legacy web payload test and unchanged credit checks passed; web suite not rerun. |
| T11 | PASS (fixture) | API conflict before cover/file fixtures passed. |
| T12 | PASS (fixture) | Revision concurrency and real SQLite busy fixtures passed. |
| T13 | PASS (fixture) | Bulk stale membership/revision, undo, retry, overflow and scope fixtures passed; production-scale workflow not exercised. |
| T14 | PASS (fixture) | API ownership/system/no-auth tests plus isolated CLI user/unknown actor denials; admin success covered by bulk fixture. |
| T15 | PASS (fixture) | API popularity and dedup fixture. |
| T16 | PASS (fixture) | SQLite empty versus stale payload and simulated outage/error fixtures; no live Qdrant. |
| T17 | PASS (fixture) | All-participant caps, max penalty and refill fixtures; listening quality untested. |
| T18 | PASS (synthetic) | 10,001 rows, 1,000 artists, 52 state SELECTs, zero limit and 9,563,209 serialized bytes; live large-preview/device performance remains unmeasured. |
| T19 | FAIL | Existing player fixture passes, but delayed bulk + unrelated track event reproducibly leaves active metadata stale; see P1 above. Cross-session response also reproducibly applies after auth change; Inactive saved-track variant reproduced; server-change race remains unverified. |
| T20 | PARTIAL | Selector 0/1/N, cancel and stale tests passed; physical device/VoiceOver/queue-position smoke outstanding. |
| T21 | PARTIAL | Editor conflict and parent draft tests passed; physical device and comprehensive asynchronous scenarios outstanding. |
| T22 | PASS (fixture) | Merge conflict and cross-process lock tests passed; no production writers exercised. |
| T23 | PASS (fixture) | Temporary real audio formats/read-only hash/stat fixture passed; no production audio used. |

Remaining gates: fix and regression-test the confirmed event-loss and auth-change scenarios and test the analogous inactive saved-track path; fix the reproduced inactive last-track case and verify server-change race; measure large preview performance; physical iOS accessibility/playback smoke. Before a separately authorized release, fresh consistent backup, stop all old SQLite writers, migration preservation/rollback and health checks, and review ambiguous corrections. No production mutation or deployment was performed. Confirmed T19 failures prevent feature acceptance; automated fixtures and the selective migration dry-run do not substitute for physical device and rollout gates.

## Fix recheck closure reference — 2026-10-28

See [MA_RECHECK_REPORT.md](MA_RECHECK_REPORT.md) for the independent executed recheck. The original P1 event-loss and previous-user-response findings, including the inactive saved-track variant, now fail on the pre-fix snapshot and pass the fixed implementation; the original findings and evidence above are retained as historical review results. A newly reproduced **P2** remains: inactive saved-track requests can reach eight outstanding across user-driven effect replacement despite a per-effect cap of four. Full iOS 603-test suite, lint and export passed independently; the extended diagnostic suite passes 29 probes and fails only this additional concurrency probe. Physical iOS playback, queue-position, accessibility and device performance gates remain untested; this closure reference does not grant release acceptance.
