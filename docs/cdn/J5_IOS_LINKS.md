# J5 iOS Outgoing Permanent HTTPS Links and Dormant Adapter Report

**Task:** J5 (iOS outgoing permanent links, dormant linking adapter, share API)  
**Author:** Junior Native Antigravity Gemini 3.8 Flash High  
**Contract Baseline:** `CONTRACT.md` revision 2 (SHA-256 `325d9b9a965fb1420dc4dc85218392cce8752fd68d3a1e61e9475ab00b020158`), `DECISIONS.md` (SHA-256 `86680b54319327f95fdd3d48c98ca1fa867a43dd1cec9f407cfde42eeb61a276`)  
**Shared Checkout Baseline:** HEAD `89ebc1c30b36837e584fbe72d51cdb0aed6303be` + `BASELINE_MANIFEST.json` (all 20/20 baseline file hashes verified intact).

---

## 1. Summary of Implemented Modules

Task J5 implemented isolated, production-grade helper modules and comprehensive behavioral test suites for senior S4 UI integration in `app/ios/puuk-ios`. In accordance with coordinator instructions, no shared composition roots (`App.js`, player hooks, modal UI) were touched.

### Production Modules:
1. `app/ios/puuk-ios/utils/shareLinks.js`
   - Formatter for canonical permanent HTTPS URLs:
     - `https://web.puuk.fun/track/<canonical lowercase UUID>`
     - `https://web.puuk.fun/album/<positive signed 64-bit integer canonical text>`
     - `https://web.puuk.fun/artist/<art_32lowerhex>`
   - Formats strictly from lossless `share_id` / server IDs; rejects client name hashing and unsafe rounded JS Numbers.
   - Strict raw-path hostile input parser: rejects other origins, ports, userinfo, custom schemes, backslashes, percent-encoded separators (`%2f`, `%5c`, `%2e`), dot segments, duplicate separators, queries, fragments, and extra segments. Normalizes one trailing slash only after ID validation.
   - Native React Native Share helper (`shareEntity`): generates only canonical HTTPS URLs, cancellation neutral (`dismissedAction` returns `{ status: 'dismissed', completed: false }`), no misleading success, throws meaningful error if entity lacks an explicit ID without guessing sub-entities.
2. `app/ios/puuk-ios/navigation/linking.js`
   - Dormant React Navigation linking adapter (`DORMANT_LINKING_CONFIG`):
     - `prefixes: []` (empty array, does not intercept incoming URLs)
     - `enabled: false` (explicitly dormant)
     - `getInitialURL(): Promise<null>` (no cold-start auto-launch)
     - `subscribe(): () => {}` (no native Linking listeners registered)
     - `getStateFromPath(path)`: parses canonical share paths into route state with strict **NO AUTOPLAY** guarantee.
   - Pending destination store (`pendingDestinationStore`): tab/session-scoped queue for `{ type, id, savedAt }`, 24-hour wall-clock expiry, clock skew rejection, deduplication of identical targets, and replacement of older pending targets.
   - Safe dispatcher (`dispatchShareDestination`): queues destination when unauthenticated; navigates to target screen when authenticated with **ZERO playback side effects, zero autoplay, and zero queue modification**.
3. `app/ios/puuk-ios/shared/api/share.js`
   - `fetchShareEntity(type, id, { signal, timeout = 5000 })`: invokes authenticated backend resolver `GET /api/share/{type}/{id}` using existing transport (`authFetch`).
   - Finite 5-second client timeout and cancellation support (`AbortSignal`).
   - `retries: 0`, `Cache-Control: no-store, private`, `Pragma: no-cache`.
   - No auth bypass, no second auth store (uses primary auth tokens from `shared/api/api.js`).
   - Structured error handling: 401 (`auth`), 404 (`notFound`), 410 (`gone`), 422 (`client`), 5xx/timeout (`server`/`timeout`).
   - `resolveShareUrl(url, options)`: parses URL with hostile input checks before network dispatch.

---

## 2. Precise Exports & Integration Guide for S4

### Module: `utils/shareLinks.js`

```javascript
import {
  CANONICAL_ORIGIN,          // 'https://web.puuk.fun'
  MAX_SIGNED_64_INT,         // 9223372036854775807n
  validateTrackId,           // (id: string) => string
  validateAlbumId,           // (id: number|string|bigint) => string
  validateArtistId,          // (id: string) => string
  extractEntityShareId,      // (entity: object, type?: string) => string
  formatShareUrl,            // (typeOrEntity: string|object, idOrType?: string) => string
  formatTrackShareUrl,       // (idOrEntity: string|object) => string
  formatAlbumShareUrl,       // (idOrEntity: number|string|bigint|object) => string
  formatArtistShareUrl,      // (idOrEntity: string|object) => string
  parseShareUrl,             // (rawUrl: string) => { type, id, normalizedPath, canonicalUrl } | null
  isValidShareUrl,           // (rawUrl: string) => boolean
  shareEntity,               // (entityOrUrl: object|string, options?: object) => Promise<ShareResult>
} from '../utils/shareLinks';
```

#### S4 Usage Example 1: FullPlayerModal / TrackContextMenu Share Action
```javascript
import { shareEntity } from '../utils/shareLinks';

const handleShareTrack = async (track) => {
  const result = await shareEntity(track, { type: 'track' });
  if (result.status === 'shared') {
    // User shared to an app or copied link
  } else if (result.status === 'dismissed') {
    // User cancelled share sheet — neutral, do not flash success or error alert
  } else if (result.status === 'error') {
    // Meaningful error handling
    console.warn('Share error:', result.error);
  }
};
```

#### S4 Usage Example 2: AlbumScreen Share Action
```javascript
import { shareEntity } from '../../utils/shareLinks';

const handleShareAlbum = async (album) => {
  // Uses lossless album.share_id, or validates safe album.id
  await shareEntity(album, { type: 'album' });
};
```

---

### Module: `navigation/linking.js`

```javascript
import {
  DORMANT_LINKING_CONFIG,    // React Navigation linking object (dormant)
  validateDestination,       // (destination: { type, id }) => { type, id }
  parseShareDestination,     // (urlOrPath: string) => { type, id } | null
  pendingDestinationStore,   // In-memory store: setPendingDestination, getPendingDestination, clearPendingDestination
  dispatchShareDestination,  // (destination, navigation, { isAuthenticated, now }) => DispatchResult
  MAX_DESTINATION_AGE_MS,    // 86400000 (24h)
} from '../navigation/linking';
```

#### S4 Usage Example 3: Navigation Container & Auth Gate
```javascript
import { DORMANT_LINKING_CONFIG, dispatchShareDestination, pendingDestinationStore } from './navigation/linking';

// In App.js (when S4 integrates):
// Pass dormant linking config to NavigationContainer:
<NavigationContainer ref={navigationRef} linking={DORMANT_LINKING_CONFIG}>
  ...
</NavigationContainer>

// When user logs in successfully:
const handleLoginSuccess = () => {
  const pending = pendingDestinationStore.getPendingDestination();
  if (pending) {
    // Dispatches without autoplay
    dispatchShareDestination(pending, navigationRef, { isAuthenticated: true });
  }
};
```

---

### Module: `shared/api/share.js`

```javascript
import {
  SHARE_API_TIMEOUT_MS,      // 5000 (5 seconds)
  ShareApiError,             // Error class with status, isGone (410), isNotFound (404), isAuth (401)
  fetchShareEntity,          // (type: 'track'|'album'|'artist', id: string, options?: { signal, timeout }) => Promise<ShareEntityResponse>
  resolveShareUrl,           // (url: string, options?: { signal, timeout }) => Promise<ShareEntityResponse>
} from '../shared/api/share';
```

---

## 3. Contract Invariants & Behavioral Verification

| Invariant | Implementation in J5 | Behavioral Proof |
|---|---|---|
| **Canonical HTTPS URLs** | Always `https://web.puuk.fun/${type}/${id}`. No trailing slash emitted. | Verified in `shareLinks.test.js` |
| **64-bit Integer Precision** | Album IDs validate up to `9223372036854775807n`. Rejects numbers `> Number.MAX_SAFE_INTEGER` without string `share_id`. | Verified with safe/unsafe numbers, BigInts, and overflow strings |
| **No Guessed Identity** | Entities lacking explicit IDs throw meaningful errors. Does not guess first sub-entity (artist/album). | Verified with sub-entity arrays lacking top-level ID |
| **Raw Hostile Input Rejection** | Rejects other origins, userinfo, ports, custom schemes, backslashes, percent-encoded separators, dot segments, duplicate slashes, queries, fragments, extra segments. | Verified with 20+ adversarial test vectors |
| **Trailing Slash Normalization** | Allowed only for one trailing slash, and ONLY after successful ID validation. | Verified: `/track/<valid-uuid>/` normalized; `/track/invalid/` rejected |
| **Cancellation Neutrality** | `dismissedAction` returns `{ status: 'dismissed', completed: false }`; no misleading success. | Verified via mocked `Share.share` |
| **Dormant Linking Adapter** | `prefixes: []`, `enabled: false`, `getInitialURL(): null`, `subscribe(): () => {}`. Does not enable incoming Universal Links or native custom schemes. | Verified in `linking.test.js` |
| **Strict NO AUTOPLAY** | State parsing and destination dispatch contain zero playback triggers, zero queue mutations, zero track switches. | Verified in `linking.test.js` |
| **Pending Destination Queue** | Tab/session-scoped, max 1 entry, 24h expiration, rejects clock skew, replaces older target, deduplicates. | Verified in `linking.test.js` |
| **Authenticated Resolver API** | Finite 5s timeout, `retries: 0`, `Cache-Control: no-store`, cancellation via `signal`, handles 401, 404, 410, 500. | Verified in `shareLinks.test.js` |

---

## 4. Test Execution & Evidence

### Test Commands and Results:
```sh
cd app/ios/puuk-ios
npm test -- --runInBand utils/__tests__/shareLinks.test.js navigation/__tests__/linking.test.js
```
- **Test Suites:** 2 passed, 2 total
- **Tests:** 70 passed, 70 total
- **Snapshots:** 0 total
- **Execution Time:** ~0.4s
- **Exit Code:** 0

### Full iOS Regression Suite:
```sh
cd app/ios/puuk-ios
npm test -- --runInBand utils/__tests__/streamUrl.test.js utils/__tests__/playbackCoordinator.test.js utils/__tests__/preloadScheduler.test.js utils/__tests__/preloadSchedulerPressure.test.js utils/__tests__/audioCache.test.js utils/__tests__/shareLinks.test.js navigation/__tests__/linking.test.js
```
- **Test Suites:** 7 passed, 7 total
- **Tests:** 327 passed, 327 total
- **Snapshots:** 0 total
- **Execution Time:** ~1.0s
- **Exit Code:** 0

### Baseline Preservation Verification:
```sh
python3 -c "
import json, hashlib
with open('docs/cdn/BASELINE_MANIFEST.json') as f:
    manifest = json.load(f)
for item in manifest['files']:
    with open(item['path'], 'rb') as f:
        assert hashlib.sha256(f.read()).hexdigest() == item['sha256'], f'Mismatch in {item[\"path\"]}'
print('ALL 20 BASELINE FILES MATCH EXACTLY!')
"
```
- **Result:** `ALL 20 BASELINE FILES MATCH EXACTLY!` (0 mismatches).

---

## 5. Scope Boundaries and Limits

1. **Jest Behavioral Tests vs. Physical Device Evidence:**
   - Jest unit and behavioral tests confirm mathematical precision, hostile URL rejection, state mapping, and error contracts.
   - Jest tests are not physical iOS device evidence: runtime AVFoundation redirect behavior, Universal Links AASA verification, and Apple Share Sheet presentation on hardware belong to subsequent device testing gates (G3/G4) under S4 and S6/S7.
2. **Composition Roots Unmodified:**
   - In accordance with J5 write allowances, `App.js`, `hooks/usePlayerController.js`, `components/FullPlayerModal.js`, and `navigation/RootNavigator.js` were preserved without edits for senior S4 composition.
