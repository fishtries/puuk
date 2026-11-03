# Junior iOS checks: selected Jest evidence (supplemental)

Task JD (junior-deepseek), 2026-10-29. Read-only inspection of the iOS package/test config and existing multi-artist suites; existing Jest tests were executed without any source, config, snapshot or dependency change. This is supplemental evidence only: it is not senior acceptance, not G3 device acceptance, and it does not assert migration/release readiness.

## 1. Baseline and environment

| Item | Value |
|---|---|
| Repo | `/home/fish/projects/puuk` |
| Test cwd | `/home/fish/projects/puuk/app/ios/puuk-ios` |
| Git HEAD | `671be2ff8bf2d89a1bc11766d18f62b4faebe5a5` (`feat(ios): your mix card touch reactivity and player controls polish`) |
| Dirty baseline (tracked+untracked) | 124 entries repo-wide before the task; 125 after, the single addition being this report file. No tracked file was modified and no test/source/config file was touched. |
| Node | v26.12.0 |
| Jest | 30.5.2 (`node_modules/.bin/jest`) |
| jest-expo preset | ~58.0.12 |
| Expo SDK | ~58.0.19, react-native 0.88.0 |
| `PUUK_DB_PATH` | not applicable — these are JS unit tests; no Python/SQLite/Qdrant/bot path touched |
| Network/production | none; no installs, no `npm ci`, no snapshot writes (`--ci` used), no Expo export, no native build, no app startup |

Local instruction read first: `app/ios/puuk-ios/AGENTS.md` ("Read the exact versioned docs at https://docs.expo.dev/versions/v58.0.0/ before writing any code"). No code was written, so no SDK-58 API surface was used; the version pin above was verified from `package.json` instead. Root `AGENTS.md` also read.

Jest config (from `package.json`, unmodified): `preset: jest-expo`, `setupFiles: <rootDir>/jest.setup.js`, `testMatch: **/__tests__/**/*.test.js`, custom `transformIgnorePatterns` for RN/Expo packages. Discovery yields 50 suites / 608 tests, all runnable locally without a device.

### Minimal useful command

```bash
cd /home/fish/projects/puuk/app/ios/puuk-ios
./node_modules/.bin/jest --ci --runInBand <paths...>
```

`--ci` prevents snapshot creation, `--runInBand` keeps the run deterministic and avoids worker pressure. Paths must include the `__tests__/` directory segment: `testMatch` plus explicit path args means a path like `shared/domain/artistCredits.test.js` matches nothing and Jest exits **0 with "No tests found"** (observed in the first attempt below). Exit code alone is therefore not evidence; `--json` counts or `--listTests` must be checked.

## 2. Selected suites (current attempt)

Single consolidated run, `jest-selected.log` + machine-readable `jest-selected.json`:

```
CMD:   ./node_modules/.bin/jest --ci --runInBand --json --outputFile=/tmp/puuk-ma-close/JD/jest-selected.json <15 paths>
CWD:   /home/fish/projects/puuk/app/ios/puuk-ios
START: 2026-10-29T09:58:24+03:00 (json startTime 2026-10-29T06:58:24.079Z)
END:   2026-10-29T09:58:26+03:00
EXIT:  0
RESULT: Test Suites 15 passed / 15 total; Tests 227 passed / 227 total; Snapshots 0; pending 0; todo 0; success true
```

Per-suite counts from `jest-selected.json`:

| Suite | Tests | Status |
|---|---:|---|
| `shared/domain/__tests__/artistCredits.test.js` | 2 | passed |
| `shared/domain/__tests__/trackAdapter.test.js` | 28 | passed |
| `shared/api/__tests__/artistCredits.test.js` | 3 | passed |
| `shared/api/__tests__/artists.test.js` | 43 | passed |
| `shared/api/__tests__/apiCache.test.js` | 39 | passed |
| `shared/components/__tests__/ArtistSelector.test.js` | 4 | passed |
| `shared/components/__tests__/ArtistCreditsEditor.test.js` | 3 | passed |
| `components/fullplayer/__tests__/FullPlayerControlsAndMenu.test.js` | 10 | passed |
| `features/albums/__tests__/AlbumScreen.test.js` | 6 | passed |
| `features/library/__tests__/TrackEditScreen.test.js` | 6 | passed |
| `features/library/__tests__/CreditsDraft.test.js` | 4 | passed |
| `features/artists/__tests__/ArtistScreen.test.js` | 19 | passed |
| `features/artists/__tests__/ArtistCreditBulkScreen.test.js` | 4 | passed |
| `hooks/__tests__/usePlayerController.test.js` | 46 | passed |
| `hooks/__tests__/useSavedCreditsSync.test.js` | 10 | passed |

Note: counts here are assertion results (`it`/`test`), so files with a `describe` wrapper report their leaf tests; the earlier `grep` estimate (e.g. 60 vs 46 for `usePlayerController.test.js`, 15 vs 10 for `useSavedCreditsSync.test.js`) counted nested declarations differently. The JSON counts are authoritative.

### Grouped runs (same attempt, scripted, before the consolidated run)

`/tmp/puuk-ma-close/JD/run-selected.sh` (cwd `app/ios/puuk-ios`, logs include CMD/CWD/START/END/EXIT):

| Group | Command (paths abbreviated) | Start | Exit | Suites | Tests |
|---|---|---|---:|---:|---:|
| `jest-domain-api` | domain `artistCredits`, `trackAdapter`; api `artistCredits`, `artists`, `apiCache` | 09:57:33 | 0 | 5 | 115 |
| `jest-navigation-ui` | `ArtistSelector`; `FullPlayerControlsAndMenu`; `AlbumScreen` | 09:57:34 | 0 | 3 | 20 |
| `jest-editors-artists` | `ArtistCreditsEditor`; `TrackEditScreen`; `CreditsDraft`; `ArtistScreen`; `ArtistCreditBulkScreen` | 09:57:36 | 0 | 5 | 36 |
| `jest-player-sync` | `usePlayerController`; `useSavedCreditsSync` | 09:57:37 | 0 | 2 | 56 |
| `jest-full` (all discovered) | `./node_modules/.bin/jest --ci --runInBand` | 09:57:38 | 0 | 50 | 608 |

`jest-full` is a supplementary whole-package signal only; the multi-artist selection above is the evidence requested for this task.

### Commands that did not produce evidence

- `npx jest --ci --runInBand shared/domain/artistCredits.test.js ...` — wrong paths (missing `__tests__/`): `No tests found`, **exit 0**. Recorded as a tooling trap, not a pass; superseded by the runs above.
- `npm test -- --ci --runInBand shared/domain/__tests__/artistCredits.test.js` — sanity check that the `npm test` script maps to the same Jest: exit 0, 1 suite / 2 tests.

## 3. Artifact receipts

All under `/tmp/puuk-ma-close/JD/` (SHA256, `sha256sum <file>`):

```
d6c226e24b4819a4b1ee67c8fee617c2de640dbc29d26ec4a5454fb185a3cf9b  jest-domain-api.log
3db804fcb4b69e445bd3c1372027959d8d3dc993cd71a5defa6612f2333bf0b0  jest-editors-artists.log
7b8c7504a58e6b2babd7b24173c7715db3e92aad01d70d1c9ef035b983569085  jest-full.log
98484a8efde170969a99325ce71c7c81c35b43d91071c9c2632311a2c1ca205c  jest-navigation-ui.log
40a2d5136d67d30e5deffbc8d47468453b9b17ba461e7a816a57a4a46596aab4  jest-player-sync.log
0350fb3483942ba90908a708addb5bd6d71f70750a68ac7a0a79ad2562e1b687  jest-selected.log
b7a31bd3310e20f7c858f86fcef5c9d5b46a9d631986af3b2f0290292e0c30f4  jest-selected.json
f1d48103bdb8555d73f238e409756260580504d0e60bc7f3d6ddf5dd2875b73b  run-selected.sh
53ec313fc9a652cdb1b9b45f1834fa859570049943697005ef3aadeab35a6914  source-hashes.txt
```

These are the current-attempt logs only; no historical evidence is claimed. Logs are small because Jest printed only the summary on success (per-suite detail lives in `jest-selected.json`).

## 4. Source hashes (drift detection)

Hashes captured before the test runs, at HEAD `671be2f` with the same dirty baseline; re-verify with `sha256sum` from `app/ios/puuk-ios`. Any difference means this evidence no longer covers the current tree.

Production code:

```
c0dd89903c957b157ff0579fd4ed833a4394d2dcb6137405505d075d6cb6b7b5  App.js
81e6858ad7e237778ac4fdbaf7df68546baff8bf67e4d573383df1c824b494d0  navigation/RootNavigator.js
7e6d24e5afc6d9d8c96941bc5fe062d608df31d6fe4ead83ff48b71e35d910d5  hooks/usePlayerController.js
946dbcb26b76cc3a5b0ed26cd8ec184636061a7193ff048eff5116c2f2488379  hooks/useSavedCreditsSync.js
5c6781dd2c4176d8998ed53c296111d1e5b52598296a0ee5eb2906c1f7294e4f  shared/api/artistCredits.js
224abd7b4ea804a357b6378002cf801863f3d0e0d9d6b8eaf8b51424543c9c99  shared/api/artists.js
f889f133f4089d2c9c0d4776c8e256df9552dae79c1a8a24f1d81b6cd7a4cf89  shared/api/apiCache.js
1e7a744056c71b7872e53f536a4452bcf291962368dcd811bb24bbd372267cee  shared/domain/artistCredits.js
f0e0355128ac4627d9241dd171e19c8f30354b0e6e14e92d8b7cc508deca1c85  shared/domain/artistCreditEvents.js
21ad0f872e7a12bea37057e53a50a6b54f0f9e7db5fbaa4b9d08151fd2aafdad  shared/domain/trackAdapter.js
d3bc347691c764c97cbd0d3d5efcc5c81de12263b2b94d591283fae90b19c212  shared/components/ArtistSelector.js
9b23afd0622849ad50a9232760ae0754fc09c082422c9f8bd80d825aec0251fd  shared/components/ArtistCreditsEditor.js
5d18583bb9d9aca4557d4b3c586a91c4c6cbf0b565d8dcc9dcb79ad1178943ad  features/library/TrackEditScreen.js
3e4279673a9efb7a45155fd923ca745603856b1c77fcfcd6be1e32e5008dded4  features/albums/AlbumEditScreen.js
ba019641c194f66ed2ffb9c442fbdcd22e98bdb0505750fa57e698f7907cee44  features/albums/AlbumScreen.js
8976db88ed10eb85a0fea74dd2967f25724ce346c2b077ad5ea4173950992593  features/artists/ArtistScreen.js
1e889458b828f92aecf8530e881923db6b8477d6bd444cbe544b8aa5c4279e52  features/artists/ArtistCreditBulkScreen.js
c32d4539b49d065feb3fb2245d93eaf161c686a1ec1659e11dd091f2dc76f589  components/FullPlayerModal.js
```

Test/config files:

```
2515c667edd7d5ec73896237926394b8d0b8c6745d86577ed6bc3a15883f872c  features/library/__tests__/CreditsDraft.test.js
b7226c539412e2b27ef954a5b4d83444551382ac0a47f934a20bd84e7388962b  hooks/__tests__/useSavedCreditsSync.test.js
08c89f2445cc1f1f94c642634dcead08333b7f46c06c676ed6b6c9e4f858d3a5  package.json
b7ae4365078f4f286b37199452e834be8bca6458131bc9fe171cf53bb3cb709c  jest.setup.js
1c5afde4c5d5824481e6bf32902ba80ee25881a121622d01a85d3cea610bead7  babel.config.js
2d9647b0f3449a2d219cc0a3c381390a61f77fcee66252f13bc248730950dc5c  app.json
```

## 5. What these tests do cover

- Domain normalization: ordered server credits preserved, present `[]` authoritative, legacy singleton only when both legacy ID and name are valid (`artistCredits`, `trackAdapter`).
- API layer: PUT/bulk wrappers reject malformed selectors before sending, propagate 409 without success events, retry 503 once with the same operation ID and emit the server result; `apiCache` invalidation/epoch behavior.
- Navigation: 0 profiles plain, 1 direct, N cancellable selector with accessible full names; full player artist control ≥44pt, stable `artistId` navigation without touching playback/queue, missing-ID and long-name fallbacks; album header clickability and non-interactive track rows.
- Editors: credits conflict preserves draft and requires explicit revision reload; failure/cancel never report success; local draft returns ordered selectors without a PUT; parent title/cover draft survives a credits save; bulk screen preview/apply/conflict/403 flows; track editor canonical URL/event behavior.
- Player/sync: saved-track credit updates for unrelated vs same-track events, auth-event cancellation, unmount draining.

## 6. Coverage limitations (not tested here)

- **Real device / simulator behavior is untested**: no Expo app startup, no native build, no VoiceOver focus order, no Dynamic Type/large-text layout, no long-list scrolling on device, no actual audio playback/queue/position preservation. Jest asserts callbacks and component state only; contract §10 explicitly says mock Jest does not replace device check (G3/G4).
- No integration against a live backend: revision-conflict semantics, catalog version/ETag, event payloads and DTO shapes are exercised against mocks/fixtures, not `brain` API.
- No `expo export`, no native iOS build, no E2E/Detox, no performance measurement.
- `eslint`/`prettier` were not run: no file in this task changed, and lint of foreign-owned files is the owners'/integration's evidence.
- `jest-full` (608 tests) is recorded only as a no-regression signal for this tree; it is not multi-artist-specific evidence and was not audited for unrelated flakiness.
- Tests passed on a dirty worktree with 124 pre-existing modified/untracked entries; hashes in §4 pin the exact bytes observed, but a later edit by any owner invalidates this run.

## 7. Status summary

- passed (current attempt): 15 selected suites / 227 tests, exit 0; supplementary full suite 50 / 608, exit 0.
- failed: none.
- not tested: real-device behavior, live API integration, native build, lint/format, performance.
- historical evidence: none used; all receipts above were produced in this task.

Recommendation for senior I1: treat these as sufficient mock-level evidence for the multi-artist iOS domain/API/draft/navigation/player seams and decide separately whether device smoke, lint, and API-integration runs are still required before G3/G4.
