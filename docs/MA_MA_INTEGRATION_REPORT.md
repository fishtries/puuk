# Multi-artist integration report

Integrated artist bulk route, editor named drafts, server event consumers, current/queued/history track credit updates, inactive saved-track updates and artist/album refresh. Patches affect credit metadata only; the player test verifies no play, seek or replace call during album and bulk events. Bulk refresh uses authenticated `GET /api/tracks/{id}?credits_only=true`, a SQLite-only mode that preserves the existing default editor GET and works with missing audio. Favorites, history, playlist and wave DTOs now carry hydrated credits and revisions; raw repository single-track reads remain unchanged for import identity.

Integration-modified files:
- `app/ios/puuk-ios/App.js`, `hooks/usePlayerController.js`, `hooks/__tests__/usePlayerController.test.js`, `navigation/RootNavigator.js`
- `features/albums/AlbumScreen.js`, `features/artists/ArtistScreen.js`, `shared/components/ArtistCreditsEditor.js`, `shared/components/__tests__/ArtistCreditsEditor.test.js`
- `brain/repositories/interactions.py`, `brain/repositories/playlists.py`, `brain/routers/tracks.py`, `brain/services/recommendation_service.py`, `brain/test_multi_artist_bulk.py`, `brain/test_multi_artist_integration.py`
- `docs/MA_MA_INTEGRATION_REPORT.md`, `docs/MA_RUN_REPORT.md`

## Validation and baseline

Baseline (before run): backend 438 passed + 56 subtests, iOS 567, web 75, bot 29; see MA_RUN_REPORT. All Python tests below set PUUK_DB_PATH to temporary local paths; embedding delivery/reconcile and loudness synchronization disabled. Test fixtures use temporary audio and fake Qdrant, not the live library.

- Backend full from `brain`: `PUUK_DB_PATH=/tmp/puuk-ma-integration-final.db EMBEDDING_QUEUE_ENABLED=false EMBEDDING_RECONCILE_ENABLED=false LOUDNESS_SYNC_ENABLED=false venv/bin/python -m pytest -q`: exit 0, 543 passed, 56 subtests, 4 warnings. The final SQLite-only read mode was added during the run; separate `test_multi_artist_integration.py` afterwards exit 0, 2 passed.
- Earlier full backend exit 1: 541 passed and 56 subtests, one new bulk CLI test assumed repository root as cwd; corrected the test to use its file directory. An interrupted rerun exit 2 followed a mistyped local edit path.
- Bot: `brain/venv/bin/python -m pytest -q tg_music_bot --ignore=tg_music_bot/test_ydl.py --ignore=tg_music_bot/test_spotify.py` with isolated PUUK_DB_PATH: exit 0, 33 passed, 1 dependency warning. Excluded scripts are network/side-effect programs, not isolated unit suites.
- iOS `npm test -- --runInBand`: exit 0, 49 suites, 591 tests. `npm run lint`: exit 0; `npx expo export --platform ios --output-dir /tmp/puuk-ma-expo-export-last`: exit 0.
- Web `npm test`: exit 0, 75 passed; `npm run build`: exit 0, existing >500kB chunk warning.
- Targeted backend cross-domain/bulk: 15 passed exit 0; final SQLite-only missing-audio and collection/wave fixture: 2 passed exit 0. Focused controller: 39 passed exit 0. `git diff --check`: exit 0.
- Intermediate failed commands: one test edit targeted an incorrect relative path, and an initial cross-domain test creation similarly failed (exit 4); both corrected. Initial cross-domain assertion caught missing wave hydration and was corrected before passing.

Snapshot dry-run: copied coordinator-provided `/tmp/puuk-ma-baseline/library-snapshot-final.db` to `/tmp/puuk-ma-integration-dryrun.db`; `init_db()` twice exit 0, integrity ok, foreign_key_check empty. Exact selected track IDs, paths, raw artists, album IDs, cover/file stats and album identity fields preserved: 1,149 tracks, 891 albums. `reconcile_artist_credits.py report --json /tmp/puuk-ma-integration-report.json` exit 0: 248 proposals, all ambiguous, 0 confirmed. No correction, preview/apply/undo or production write was executed. Source snapshot was opened read-only for comparisons.

## T01–T23 evidence status

These are test evidence statuses, not independent gate approvals. Complete refers to the named automated fixture evidence, with remaining qualifications stated below.

| ID | Status and evidence |
| --- | --- |
| T01 | Covered: storage suite plus disposable snapshot double init and integrity checks; snapshot comparison is selective, see storage report for broader previous-snapshot checks. |
| T02 | Covered by storage/API normalization fixtures; exact source rules in storage report. |
| T03 | Covered across track, favorites, history, playlist and wave by cross-domain fixture; other DTO surfaces exercised by existing API suites, full end-to-end surface parity still needs independent audit. |
| T04 | Covered by storage/API artist/search suites; independent audit pending. |
| T05 | Covered by API fixture for guest and album membership. |
| T06 | Covered by API artist/album suites; independent review pending. |
| T07 | Covered by DB-only credit and temporary WAV hash/stat fixtures; new SQLite-only read tested with missing file. |
| T08 | Covered by import/recovery fixture suites; independent audit of all recovery paths pending. |
| T09 | Covered by import and storage precedence fixtures. |
| T10 | Covered by legacy web payload tests, web suite/build. |
| T11 | Covered by API conflict tests; no-file effects checked by fixtures. |
| T12 | Covered by storage/API concurrency, retry and busy tests. |
| T13 | Covered by bulk service tests; independent full-scale audit pending. |
| T14 | Covered by bulk/API permissions fixtures; review of full role matrix pending. |
| T15 | Covered by artist API/event tests; independent audit pending. |
| T16 | Covered by recommendation/import mock outage tests; live Qdrant outage not exercised. |
| T17 | Covered by recommendation fixture suites; subjective listening quality not measured. |
| T18 | Partially covered: 10,001-track chunk/query count in storage report; end-to-end payload size and full performance audit pending. |
| T19 | Partially covered: cache tests and player metadata update fixture; physical device and complete last-track/auth-race validation pending. |
| T20 | Partially covered: selector cancel, selection, stale target and player callback tests; actual VoiceOver, long names, queue/position on device untested. |
| T21 | Partially covered: editor saves/conflict/local draft tests; unsaved parent fields and album editor need fuller integration evidence, device smoke pending. |
| T22 | Covered by storage/API merge and separate merge-race tests, pending independent audit. |
| T23 | Covered by audio-tag/import fixtures across listed formats; no production file changes. |

## Remaining gates

Independent review and physical iOS smoke (VoiceOver, large text, long lists, playback/queue/position, stale selection, conflict and offline flows) remain required. The 5,000-entry bulk preview uses a scroll view and has not been performance-tested on device. Before any separately authorized release: take and verify a fresh consistent backup, stop every old SQLite writer including bot and heavy worker, run migration and preservation checks, review ambiguous corrections, verify rollback/conditional undo, and validate service health; no deployment or production correction is authorized by this report.
