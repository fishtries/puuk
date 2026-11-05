# S2 cache cancellation cleanup correction

Task `task_36c466c0995f`, dispatch `ctx_2c954539adb4`, 2026-11-04 UTC.

Status: local correction and focused verification **passed**; independent S2 acceptance remains with the reviewer. Native compilation and identified installed-build/device/sound acceptance are **not tested**, build ID **unknown**. No device storage exhaustion was observed or asserted.

## Root cause and correction

The unchanged independent probe reproduced the accepted J04 source defect: `_abortAttempt` marked `attempt.settled` before invoking its settle function, so the function returned without rejecting the internal await. The caller rejected immediately, but the captured existing temporary file survived even after native completion.

The attempt now exposes a bound rejection function that alone owns the settled flag. A separate `nativePending` flag distinguishes the bounded JS wait from native completion. Cancellation and timeouts still reject the caller immediately, clear timers, cancel/release the underlying task, and prevent stale publication. If native is pending, cleanup waits for its success or rejection callback; the callback deletes only that attempt's temporary file. A stale check also prevents starting a task in the microtask after cancellation. Cleanup deletion failures emit only `[AudioCache] Attempt file cleanup failed`, without paths, track IDs, URLs, tokens, or native error text.

This is supported by the [exact Expo 58 FileSystem documentation](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/): cancellation requests native cancellation and pending download rejection follows that cancellation; release frees the native handle. Installed `expo-file-system` is 58.0.11. Its `ios/FileSystemDownloadTask.swift` moves the destination in `didFinishDownloadingTo`, then settles the promise in `didCompleteWithError`; cancel/release do not delete the destination. That installed file was read only, SHA-256 `08506050f7e9037fc1b3fc42f34ca024729184f0f8c8611287e3354e9f122b3c`. Root/iOS AGENTS, plan 2/4.3/S2, release-it rules and J04 report were read; the exact Expo 58 Audio documentation was also consulted.

Unique generation filenames, deduplication, scheduler APIs/slot accounting, 180-second overall and 20-second inactivity defaults, three transient attempts, and 800/2000 ms backoff remain unchanged. If a synthetic native implementation never settles despite cancel/release, the caller and timers still finish, but safe final deletion must remain deferred because further writes cannot be ruled out; existing initialization cleanup remains the later recovery path. A genuine deletion failure is diagnosed and can leave that file for existing initialization cleanup.

## Verification

All filesystem writes in verification use synthetic VM/Jest fixtures. No real user cache, original audio, production/service/provider state or peer-owned files were modified. No full suite or Expo export was run against moving peer files; the independent reviewer owns final combined checks.

The original independent probe and its original failing log were copied unchanged into `/tmp/puuk-playback/S2-CACHE-FIX/baseline/`. Before editing, exact cache/test/probe/log hashes were captured in `hashes-before.json`. A fresh baseline probe failed with `tempStillExists:true`; the exact unchanged probe now passes with `tempStillExists:false`, immediate AbortError and no publication.

Focused suite: **46/46 passed** (34 inherited + 12 new). The new matrix covers cancel/overall timeout/inactivity timeout, late native success/rejection, and deletion success/failure. Every case captures an existing temporary file, proves outer settlement before native settlement, retains the file while native can still write, writes again immediately before native settlement, and verifies eventual cleanup or the sanitized diagnostic. It also repeats cancel, cancels unknown IDs, publishes a newer same-track generation before old completion, checks that generation's contents/manifest survive, and verifies finite timer cleanup. Existing tests retain bounded retry, progress, dedup and other cache contracts.

Final focused tests, lint for **both product and tests**, Babel syntax parsing and Prettier checks passed. The first formatting check failed only on the added test formatting, then the owned test file was formatted and final checks rerun. The initial failed probe and format check are retained, not replaced. One intermediate inbox check returned `runtime_unavailable` with runtime null; a subsequent checkpoint succeeded without opening/restarting Orca.

Evidence directory: `/tmp/puuk-playback/S2-CACHE-FIX/`. `commands.jsonl` records exact argv, cwd, start/end UTC, exit, before/after source and unchanged harness hashes, and log hashes for every verification invocation, including failures. `run.py`, syntax harness, explicit test-inclusive lint config, baseline copies and owned-file diffs are retained.

| Evidence log            | Exit | SHA-256                                                          |
| ----------------------- | ---- | ---------------------------------------------------------------- |
| baseline-probe          | 1    | 2e8ec1f8a9eeb6b6e186f0123b7d95993d905974141f7fc34aa29af3dd05269b |
| fixed-probe             | 0    | a90ca205b14e99ff89a331c12fa45fa42ff34f50cf4e25cac3fd2ff1ea7b1c9d |
| cache-tests-first       | 0    | 0d2cb37c90a9bd367d5f3745656f95956c493c007132cff4d210735d6a2d2be5 |
| format-first            | 1    | 0f9bf4f1d5942c5a7eabe70d59656dd36406d7ee26cce5b17727f632a84d6672 |
| format-write            | 0    | 33b5c2818f21250c23f6e3a4a3eba7512ba49f6a1dba69a38ba478bfa29cb4bd |
| syntax-final            | 0    | 273ccc79f3b7e35b75c39832cf275f37133af05da454de63738d9c8be0dcf6d5 |
| independent-probe-final | 0    | a90ca205b14e99ff89a331c12fa45fa42ff34f50cf4e25cac3fd2ff1ea7b1c9d |
| format-final            | 0    | 17aa973d3f004560237d9a95171210b0671deff23d61628eecf7322ff5938f20 |
| lint-final              | 0    | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| cache-tests-final       | 0    | e3a09b2b81610cace9897efbf38fc66bca24449211306e70fb107be0399d49b7 |

## Final source hashes

- `app/ios/puuk-ios/utils/audioCache.js`: `42b91fded6a56aad8a430d8ad0c49960f768fbfbdb53a34b342ea8802edc78e3`
- `app/ios/puuk-ios/utils/__tests__/audioCache.test.js`: `2be1272242c5be705163764016ee6e32b3251eed47d61e48b9d9c27c6f4352a4`
- Unchanged independent harness: `b797b294c7ab865f6a00bbd3c63d8cb37ad48b3edc94bd5f50e7c903e688cd1c`.

Remaining work: independent S2 review and final combined host checks, followed by native compilation and acceptance on an identified physical iPhone candidate.
