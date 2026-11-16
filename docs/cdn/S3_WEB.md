# S3 web integration — implementation and verification

Baseline HEAD `89ebc1c30b36837e584fbe72d51cdb0aed6303be`; contract SHA-256 `325d9b9a965fb1420dc4dc85218392cce8752fd68d3a1e61e9475ab00b020158`; decisions SHA-256 `86680b54319327f95fdd3d48c98ca1fa867a43dd1cec9f407cfde42eeb61a276`. This is a shared dirty checkout with baseline and concurrent backend/iOS changes. Both web build flags default off; neither deployment nor production changes were made.

The preserved S3 implementation changes `api/client.ts`, `api/media.ts`, `engine/AudioEngine.ts`, `store/usePlayerStore.ts`, `store/useAuthStore.ts` and `types/track.ts` for session-fenced ticket resolution, bounded cache and recovery, and anonymous HTML audio; `App.tsx`, `views/AlbumDetail.tsx`, new `views/TrackDetail.tsx`, `views/ArtistDetail.tsx`, `views/ShareDetail.module.css`, `store/useAlbumNavigationStore.ts`, `components/auth/LoginModal.tsx`, home/player controls and the J4 `api/share.ts`, `store/useShareNavigationStore.ts`, `utils/shareLinks.ts` integrate authenticated navigation and sharing. Tests include `api/__tests__/mediaDelivery.test.ts`, `engine/__tests__/deliveryRecovery.test.ts`, share navigation/parser tests and existing player tests. Resumed worker corrected fake-media error events in the recovery tests and a response type error in the share test; the prior worker's implementation is preserved.

Boundary review: share response validation checks requested ID, canonical type/ID/path, entity and track identity; pending timestamps reject future ages; request and body decoding are fenced on auth changes and abort. Errors shown by these boundaries use fixed messages. Playback resolver validates direct and CDN paths and uses no-store, request/session fencing, monotonic time, bounded lease/cache, and the existing store as recovery owner. The unit tests exercise compatibility and terminal ticket errors, retries, logout and account races, pause/seek/repeat, and sanitized malformed URLs.

Checks on this checkout:

- `npm test`: exit 0, 216 tests passed, 0 failed (33 suites). An earlier invocation with `-- --run` reported 183/189 before correction of three synthetic error events and while the shared checkout was changing; the final standard command passed.
- Focused `node --test --experimental-strip-types src/engine/__tests__/deliveryRecovery.test.ts`: exit 0, 24 passed.
- Focused media/share/parser invocation: exit 0, 85 passed.
- `npm run build`: exit 0; Vite emitted a >500 kB chunk warning. `npm run lint`: exit 0 with existing and new warnings. `git diff --check -- app/web/src`: exit 0.
- Orca embedded browser with isolated local fixture backend and both flags enabled: an unauthenticated track URL displayed the login gate and cancel control; a synthetic session and resolver displayed the intended track with an empty player; explicit Play loaded a generated five-second silent WAV and the dock showed Pause and 0:05; reload returned to the track with empty player. Screenshot was inspected locally; fixture image endpoint deliberately did not supply an image. No real user/session, catalog, or audio was used.

Additional Orca browser verification (2026-11-16): Vite on `127.0.0.1:18765` with both flags enabled only for this disposable test, and a synthetic threaded API/audio server on `127.0.0.1:18764`. The fixture had no production credentials, catalog, database or audio; its 30-second WAV was generated in memory. The fixture used legacy direct tickets; it did not issue CDN capabilities. Observed results:

- A direct track URL opened the login gate; submitting a synthetic OTP restored the requested track and the dock remained empty. On a separate visit, cancelling the pending link replaced the URL with `/`, retained the login gate, and a subsequent synthetic login opened home rather than the cancelled destination.
- Track → artist → second track navigation left the player empty; browser Back showed the artist and Forward restored the second track. A synthetic alias resolved to the second track and replaced the URL with its canonical path. Reload restored the track with an empty player.
- A synthetic track 404 showed “Недоступно” with a safe home action; a 503 showed a retry action, which repeated the retryable state. A delayed resolver was interrupted by removing the synthetic token and dispatching a storage event: loading was observed before the event, and after the delayed response the login gate remained visible without the old entity. This is a simulated cross-tab event, not a two-tab browser synchronization test.
- With `navigator.share` unavailable and a fixture clipboard stub, the share button displayed “Ссылка скопирована” and wrote the canonical HTTPS track link. A stubbed native share rejection with `AbortError` left the UI unchanged; the operating system share sheet and real clipboard were not exercised.
- Explicit Play of the synthetic cross-origin WAV displayed Pause and a 30-second duration; the existing audio element had `crossOrigin=anonymous`, a running AudioContext and a media-element source. An analyser connected to that source observed nonzero waveform samples. A separate cross-origin browser fetch with `Range: bytes=0-99` returned 206, `Content-Range: bytes 0-99/480044`, and 100 bytes; this does not prove the media element issued or correctly resumed a Range request. Simulating an account change through a storage event while audio played paused and unloaded its source; the shared catalog target was subsequently resolved for the new synthetic account.

Limits: browser verification used one embedded Chromium environment and mocked clipboard/native-share interfaces; real OS sharing, independent two-tab synchronization, mobile, and actual CDN media requests were not verified. Unit tests are not browser evidence. Provider warm-cache authorization, header overwrite, CDN Range/CORS, deployment and live rollout remain external gates. S6 must independently review code, scope (including pre-existing modified tests), browser evidence and the backend contract before enabling either flag; neither flag was enabled in a production build and no release acceptance is claimed here.

The shared checkout emitted Vite HMR updates during this browser session, so these observations are not evidence for a single immutable build hash; S6 should repeat against the reviewed frozen build. The resumed browser task itself changed only this report, and did not write iOS or production files.


Coordinator frozen candidate check, 2026-11-16: all30 web source/test files were
staged explicitly and had no unstaged differences during verification. npm test
passed220 tests in33 suites; build and lint exited0, retaining the chunk-size and
existing React warnings. Both public build flags were absent from the build
environment and therefore defaulted false. WEB_RELEASE_MANIFEST.json records
source/lockfile and built-asset hashes. This candidate is committed for review;
production web deployment and real-CDN browser acceptance remain open.
