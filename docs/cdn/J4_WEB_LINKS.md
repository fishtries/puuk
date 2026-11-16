# J4: Web Permanent-Link Modules and Authenticated Resolver

- **Task**: Task J4 — implement isolated web permanent-link modules per accepted G1-R2.
- **Role**: Junior Native Antigravity Gemini 3.8 Flash High.
- **Contract & Ledger Reference**:
  - `CONTRACT.md` (SHA-256: `325d9b9a965fb1420dc4dc85218392cce8752fd68d3a1e61e9475ab00b020158`)
  - `DECISIONS.md` (SHA-256: `86680b54319327f95fdd3d48c98ca1fa867a43dd1cec9f407cfde42eeb61a276`)
  - Gate G1-R2 accepted by coordinator in `docs/cdn/GATE_LEDGER.md`.
- **Handoff Target**: Task S3 (Senior Web Playback & UI Integration).

---

## 1. Executive Summary

All J4 deliverables have been implemented in strict adherence to Contract v1 (§7, §8) within the exact assigned file allowance:
1. `app/web/src/utils/shareLinks.ts`: Formatter, strict raw-URL parser, canonical URL generators, ID validators, and native/clipboard share utility.
2. `app/web/src/api/share.ts`: Authenticated share resolver client targeting `GET /api/share/{type}/{id}` with `no-store`, client-side 5-second finite timeout, cancellation controller, and bounded errors.
3. `app/web/src/store/useShareNavigationStore.ts`: Tab-scoped `sessionStorage` pending destination state with 24-hour wall-clock TTL, corrupt/future-age guards, safe history adapter (`pushState`/`replaceState`/`popstate`), generation fencing across awaits, and guaranteed no-autoplay invariant.
4. Comprehensive test suites:
   - `app/web/src/utils/__tests__/shareLinks.test.ts`
   - `app/web/src/store/__tests__/shareNavigation.test.ts`

Zero files outside the allowance were modified or created.

---

## 2. Concrete Exports & API Handoff for Task S3

### 2.1 `app/web/src/utils/shareLinks.ts`

```ts
export const CANONICAL_ORIGIN = 'https://web.puuk.fun';
export const INT64_MAX = 9223372036854775807n;

export type ShareEntityType = 'track' | 'album' | 'artist';

export interface ParsedShareTarget {
  type: ShareEntityType;
  id: string;
  canonicalPath: string; // Formatter-compatible own-origin path: e.g. /track/<id>
  canonicalUrl: string;  // https://web.puuk.fun/track/<id>
  hasTrailingSlash: boolean;
}

export interface ShareEntityOptions {
  type: ShareEntityType;
  id: string | number | bigint;
  title?: string;
  text?: string;
}

export type ShareActionOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

// Validators
export function isValidTrackId(id: unknown): id is string;
export function isValidAlbumId(id: unknown): boolean;
export function isValidArtistId(id: unknown): id is string;
export function isCanonicalShareTarget(target: unknown): target is { type: ShareEntityType; id: string };

// Formatters (never emit trailing slashes)
export function formatSharePath(type: ShareEntityType, id: string | number | bigint): string;
export function formatShareUrl(type: ShareEntityType, id: string | number | bigint): string;

// Strict Parser (validates raw string BEFORE URL normalization)
export function parseShareTarget(rawInput: unknown): ParsedShareTarget | null;

// Browser Share Helper
export async function shareEntityUrl(options: ShareEntityOptions): Promise<ShareActionOutcome>;
```

**Key behavior for S3**:
- `formatShareUrl('track', track.share_id || track.id)`: formats canonical lowercase UUID URL.
- `formatShareUrl('album', album.share_id || album.id)`: formats positive decimal signed 64-bit string/BigInt; throws if an unsafe JS number (> MAX_SAFE_INTEGER or <= 0) is passed rather than rounding.
- `formatShareUrl('artist', artist.share_id || artist.id)`: formats `art_<32hex>`.
- `parseShareTarget(raw)`: returns null for any invalid protocol, userinfo, port, percent-encoding, backslash, dot segment, duplicate slash, query, fragment, trailing segment, or out-of-bounds ID. If a single trailing slash was present, returns `hasTrailingSlash: true` with the stripped canonical path for `replaceState` cleanup.
- `shareEntityUrl(options)`: uses `navigator.share` if available; on user abort (`AbortError`), returns `'cancelled'` (neutral UX); otherwise falls back to `navigator.clipboard.writeText`.

---

### 2.2 `app/web/src/api/share.ts`

```ts
export type ShareEntityType = 'track' | 'album' | 'artist';

export interface ArtistSummaryDTO {
  id: string;
  name: string;
  track_count?: number;
  album_count?: number;
  artwork?: string | null;
  coverArt?: string | null;
  share_id?: string;
}

export type TrackDTO = Track;
export type AlbumDTO = Album;
export type ShareEntityPayload = TrackDTO | AlbumDTO | ArtistSummaryDTO;

export interface ShareEntityResponse<T extends ShareEntityPayload = ShareEntityPayload> {
  type: ShareEntityType;
  requested_id: string;
  canonical_id: string;
  canonical_path: string;
  entity: T;
  tracks: TrackDTO[];
  albums: AlbumDTO[];
}

export type ShareApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'gone'
  | 'entity_too_large'
  | 'timeout'
  | 'network_error'
  | 'server_error'
  | 'invalid_request'
  | 'invalid_response';

export class ShareApiError extends Error {
  readonly status: number;
  readonly code: ShareApiErrorCode;
  readonly isTerminal: boolean;
  readonly isRetryable: boolean;
  readonly isAuth: boolean;
}

export interface FetchShareEntityOptions {
  signal?: AbortSignal;
  timeoutMs?: number; // Defaults to 5000ms per contract §7.3
}

export async function fetchShareEntity<T extends ShareEntityPayload = ShareEntityPayload>(
  type: ShareEntityType,
  id: string,
  options?: FetchShareEntityOptions
): Promise<ShareEntityResponse<T>>;
```

**Key behavior for S3**:
- Sends `GET /api/share/{type}/{id}` with Bearer auth and `Cache-Control: no-store` (`cache: 'no-store'`).
- Enforces 5s client-side timeout by default.
- Verifies server payload integrity and validates that `canonical_path` is a formatter-compatible own-origin path.
- Errors:
  - `401`: `isAuth: true`, `isRetryable: false`. Signals S3 to show login gate while preserving pending destination.
  - `403`, `404`, `410`, `422`: `isTerminal: true`, `isRetryable: false`. Displays terminal state ("Недоступно" on 404/410).
  - `5xx`, timeout, network failures: `isRetryable: true`. UI displays Retry button without causing retry storms.

---

### 2.3 `app/web/src/store/useShareNavigationStore.ts`

```ts
export const PENDING_SHARE_STORAGE_KEY = 'puuk_pending_share_destination';
export const PENDING_SHARE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface ShareTarget {
  type: ShareEntityType;
  id: string;
}

export interface PendingShareDestination extends ShareTarget {
  savedAt: number;
}

export interface ShareNavigationError {
  kind: 'auth' | 'terminal' | 'retryable' | 'invalid';
  status?: number;
  message: string;
  code?: string;
}

export interface ShareNavigationState {
  currentTarget: ShareTarget | null;
  pendingDestination: PendingShareDestination | null;
  isResolving: boolean;
  resolvedEntity: ShareEntityResponse | null;
  error: ShareNavigationError | null;
  generation: number;

  // Actions
  initFromLocation: () => ShareTarget | null;
  setPendingDestination: (target: ShareTarget | null) => void;
  clearPendingDestination: () => void;
  navigateToTarget: (target: ShareTarget, options?: { replace?: boolean; updateHistory?: boolean }) => void;
  cancelNavigation: () => void;
  handlePopState: (pathname?: string) => void;
  canonicalizeUrl: (canonicalPath: string) => void;
  resolveCurrentTarget: () => Promise<ShareEntityResponse | null>;
  reset: () => void;
}

export const useShareNavigationStore: UseBoundStore<StoreApi<ShareNavigationState>>;

// Standalone storage helpers for direct integration:
export function readPendingDestination(storage?: Storage | null, now?: number): PendingShareDestination | null;
export function writePendingDestination(target: ShareTarget, storage?: Storage | null, now?: number): boolean;
export function deletePendingDestination(storage?: Storage | null): void;
```

**Key behavior for S3**:
- **Pending destination storage**: Stored in tab-scoped `sessionStorage`. Validated on every read. Future timestamps (`savedAt > now + 60s`) or entries older than 24h are discarded and wiped from storage.
- **Login gate coordination**:
  - Unauthenticated user enters `/track/<uuid>`: `initFromLocation()` sets `currentTarget` and writes `pendingDestination` to `sessionStorage`.
  - When `resolveCurrentTarget()` encounters 401, `pendingDestination` is kept in `sessionStorage` and state.
  - When login succeeds (e.g. via Telegram OTP or password), S3 checks `useShareNavigationStore.getState().pendingDestination` to resume the pending destination.
  - If user cancels login, `cancelNavigation()` replaces history with `/` and wipes `pendingDestination`.
- **Successful display**: When `resolveCurrentTarget()` succeeds, `pendingDestination` is automatically cleared.
- **Alias resolution**: If the entity was merged (e.g. album merge), the server returns `canonical_path: '/album/target'`. The store replaces the browser URL via `replaceState` and updates `currentTarget` without creating a duplicate history entry.
- **History back/forward**: S3 wires `window.addEventListener('popstate', () => handlePopState())`. `handlePopState` re-parses the path and increments `generation` to cancel any stale in-flight requests. It NEVER calls `pushState`.
- **No autoplay**: The store contains zero audio imports or player mutations. Incoming navigation, alias resolution, login completion, and refresh never start audio playback, change track, or modify queue.

---

## 3. Test Evidence

### 3.1 Test Execution Suite

Executed with Node built-in test runner via `npm --prefix app/web test`:
- Command: `node --test --experimental-strip-types 'src/**/__tests__/*.test.ts'`
- Total suites: 30
- Total tests: 126
- Passed: 126
- Failed: 0
- Duration: ~270ms

### 3.2 Exact Test Coverage Breakdown

#### `src/utils/__tests__/shareLinks.test.ts` (34 test assertions):
- ID validation: lowercase UUIDs, positive signed 64-bit album IDs (string, safe integer, BigInt), INT64_MAX, `art_<32hex>`.
- Rejections: uppercase UUIDs, zero/negative album IDs, leading zeros (`"01"`), exponents (`"1e5"`), decimals, unsafe JS integers (> MAX_SAFE_INTEGER), signed 64-bit overflow, artist names, "various artists".
- Formatting: canonical track, album, and artist URLs. Never emits trailing slash. Throws on unsafe numeric album IDs.
- Strict parser raw-URL validation BEFORE URL normalization:
  - Valid canonical HTTPS URLs and root-relative paths.
  - Single trailing slash normalization (`hasTrailingSlash: true`).
  - Rejection of external origins, insecure `http://`, protocol-relative `//`, custom schemes `puuk://`.
  - Rejection of credentials (`user@`, `user:pass@`).
  - Rejection of alternate ports (`:443`, `:80`, `:8080`).
  - Rejection of backslashes (`\`).
  - Rejection of percent-encoded separators (`%2f`, `%2F`, `%5c`, `%2e`) and double decodes (`%252f`).
  - Rejection of dot-segments (`/../`, `/./`, `..`).
  - Rejection of duplicate slashes (`//`).
  - Rejection of queries (`?returnTo=/`, `?foo=bar`) and fragments (`#player`).
  - Rejection of trailing segments (`/track/<id>/extra`).
  - Rejection of whitespace.
- Share entity utility: native `navigator.share` dispatch, neutral `'cancelled'` outcome on `AbortError`, fallback to `clipboard.writeText`, and failure handling.

#### `src/store/__tests__/shareNavigation.test.ts` (12 test assertions):
- Storage TTL & Corruption:
  - 24-hour wall-clock TTL enforcement.
  - Rejection and purging of future corrupt timestamps (`savedAt > now + 60s`).
  - Rejection and purging of negative timestamps (`savedAt < 0`).
  - Rejection and purging of corrupt JSON or malformed entity IDs.
  - Safe error-free fallback when `sessionStorage` throws `SecurityError`.
- Navigation & History State:
  - `initFromLocation` with trailing slash triggers `replaceState` cleanup.
  - `initFromLocation` on `/` restores pending destination from tab `sessionStorage`.
  - `navigateToTarget` loop prevention (does not push duplicate history for identical target).
  - `cancelNavigation` clears pending destination and replaces history with `/`.
  - `handlePopState` cancels stale requests and NEVER calls `pushState`.
- Authenticated Resolver & Error Bounds:
  - Successful resolution clears pending destination and validates no-autoplay invariant.
  - Canonical alias resolution triggers `replaceState` with the server's canonical target path.
  - `401 Unauthorized` sets auth error and preserves pending destination in storage for subsequent login.
  - `403 Forbidden` sets terminal error and clears pending destination.
  - `404 / 410` sets terminal error with message `"Недоступно"` and clears pending destination.
  - `5xx / Network` sets retryable error and preserves pending destination for retry.
  - 5-second client-side timeout enforcement aborts and returns retryable timeout error.
  - Generation fencing: late response from a superseded request is discarded and does not overwrite current state.

### 3.3 TypeScript Compilation & Linting
- `npm --prefix app/web run build` (`tsc -b && vite build`): Exited with code 0 in 332ms.
- `npm --prefix app/web run lint` (`oxlint`): Exited with code 0. Zero warnings and zero errors in all new files.

---

## 4. Contract Conformance Summary

| Contract Section | Requirement | J4 Implementation Status |
|---|---|---|
| §7.1 | Frozen URLs: `/track/<uuid>`, `/album/<int64>`, `/artist/<art_32hex>` | Fully validated and enforced in `shareLinks.ts`. |
| §7.1 | Never round unsafe numeric album IDs | Throws `Error` when formatting numbers > MAX_SAFE_INTEGER; requires string/BigInt. |
| §7.1 | Reject noncanonical/malformed input (userinfo, port, scheme, `\`, `%`, `..`, `//`, `?`, `#`) | Strict raw-string pre-check in `parseShareTarget` before URL normalization. |
| §7.1 | Optional trailing slash canonicalization | Parser flags `hasTrailingSlash: true`; store cleans up via `replaceState`. |
| §7.2 | 404/410 shows "Недоступно" with safe navigation | Handled as terminal error with exact message `"Недоступно"`. |
| §7.2 | Album merge alias canonicalization | Store detects `res.canonical_path !== expected` and updates URL via `replaceState`. |
| §7.3 | GET `/api/share/{type}/{id}` no-store, 5s timeout, bounded errors | Handled in `api/share.ts` with `authorizedFetch`, 5s timer, and `Cache-Control: no-store`. |
| §8 | Tab-scoped `sessionStorage` `{type, id, savedAt}` 24h age | Validated in `useShareNavigationStore.ts` with future/expiry guards. |
| §8 | Preserve pending target on 401 & network; clear on success/cancel | Implemented in store resolution logic. |
| §8 | History pushState/replaceState/popstate; never push from popstate | History adapter implemented; popstate only updates state and cancels stale requests. |
| §8 | Autoplay strictly prohibited | Zero audio dependencies; player state remains untouched. |

Handoff to Task S3 is complete and ready for UI composition.
