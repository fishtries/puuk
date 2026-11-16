# J3 Independent Backend Contract and Security Test Report

**Task:** J3 — Independent backend contract/security tests for integrated S2  
**Role:** Junior native Antigravity Gemini 3.8 Flash High (no source fixes, no production writes)  
**Baseline:** HEAD `89ebc1c30b36837e584fbe72d51cdb0aed6303be` plus `docs/cdn/BASELINE_MANIFEST.json`  
**Contract Authority:** `docs/cdn/CONTRACT.md` (SHA-256 `325d9b9a965fb1420dc4dc85218392cce8752fd68d3a1e61e9475ab00b020158`), `docs/cdn/DECISIONS.md` (SHA-256 `86680b54319327f95fdd3d48c98ca1fa867a43dd1cec9f407cfde42eeb61a276`)

---

## 1. Executive Summary

Task J3 authored 10 independent test modules and synthetic test fixtures to rigorously verify the backend delivery, origin, ASGI boundary, concurrency, ingest identity, compatibility, purge lifecycle, version pinning, share resolver, and log redaction contracts implemented by S2.

All tests operate strictly on isolated SQLite databases (`test_db_path` imported first, verifying `PUUK_DB_PATH` in system temp directory) and purely synthetic audio fixtures in `brain/fixtures/cdn/`. No working database, live music library, real Qdrant cluster, or network service was contacted. Zero production writes or S2 source/test modifications were made.

**Test Execution Results:**
- **J3 Independent Suite:** `cd brain && venv/bin/python -m pytest test_cdn_*.py -q`: **86 passed, 0 failed** (24.31 s, exit code 0).
- **S2 Delivery & Identity Suite:** `cd brain && venv/bin/python -m pytest test_delivery_service.py test_share_identity.py -q`: **55 passed, 0 failed** (16.97 s, exit code 0).
- **Affected Identity Regressions:** `cd brain && venv/bin/python -m pytest test_albums.py test_album_position_patch.py test_multi_artist_storage.py test_multi_artist_import.py test_multi_artist_api.py test_multi_artist_bulk.py test_multi_artist_integration.py test_artists_invariants.py test_artist_backend_hardening.py test_artist_review_regressions.py test_artist_search_albums.py -q`: **202 passed, 56 subtests passed** (33.26 s, exit code 0).
- **Legacy Un-Migrated Suites:** `cd brain && venv/bin/python -m pytest test_media_ticket.py test_closed_access.py -q`: **10 passed, 1 failed, 22 errors** (exit code 1). See Section 4 for detailed defect analysis.

---

## 2. Independent Test Modules and Coverage

The 10 new test modules under `brain/` provide non-mirroring verification of public contracts against independent oracles and synthetic inputs:

| Test Module | Tests | Primary Contract Sections | Coverage and Invariants Verified |
|---|---|---|---|
| `test_cdn_signing.py` | 6 | §4.2 | Independent OpenSSL subprocess CLI oracle (`openssl dgst -md5 -binary`) and pure-hashlib oracle cross-validated against fixed J1 synthetic vector (`NcMUu1kyDzVaG8fx-u-7WQ`); 1-bit mutations in path, secret, expiry, spaces, casing, and trailing slashes produce invalid signatures; 22-char base64url format without padding enforced. |
| `test_cdn_origin.py` | 22 | §4.1, §4.2, §4.3 | Protected origin `X-Puuk-Origin-Secret` validation (constant-time, rejects missing, wrong, empty, oversized >64, and duplicate headers; 404 when origin disabled); strict raw path validation (rejects non-canonical UUIDs, non-64-hex hashes, trailing slashes, traversal dot segments, duplicate slashes); strict query validation (requires exactly one `md5` and `expires` in any order; rejects unknown query params, duplicate keys, empty values, semicolons, >128-byte raw query); HTTP methods (GET, HEAD 200 with headers and 0-byte body, OPTIONS 204, 405 on POST/PUT/DELETE/PATCH); exact single Range (start, middle, suffix, open-ended 206), unsatisfiable Range (416 `bytes */<total>`), If-Range matching/mismatch; equal-length atomic file replacement before pin (rejects 404) vs after pin (delivers original pinned bytes from open fd). |
| `test_cdn_app_boundary.py` | 14 | §4.3, §4.4 | Assembled FastAPI `api.app` with `DeliveryBoundaryMiddleware`: `Cache-Control: private, no-store` on all media responses; media CORS enforces fixed allowed origin `https://web.puuk.fun`, exposes headers, excludes `Access-Control-Allow-Credentials`; untrusted origins receive no ACAO; `/cdn/` preflight OPTIONS requires origin secret header; error status codes (400, 401 with `WWW-Authenticate: Bearer`, 403, 404, 405, 412, 416, 422, injected 500) all receive boundary CORS and no-store; default account routes (e.g. `/api/auth/login`) retain baseline CORS with credentials; ticket body limit >4 KiB (413) and auth header limit >8 KiB (400). |
| `test_cdn_execution.py` | 8 | §4.5 | Zero-queue 4-item work pool (`DeliveryExecutor`): 4 concurrent operations admitted, 5th rejected immediately with 503 `Retry-After: 1` (`delivery_busy`); SQLite exclusive lock contention times out within deadline budget closing connection in `finally`; track mutation lock contention aborts within deadline; single flock ownership on `DELIVERY_LOCK_DIR/hash-owner.lock`; hash child process spawned via subprocess with `pass_fds` retaining flock FD; child timeout reaped via SIGTERM/SIGKILL; late hash results discarded on version invalidation. |
| `test_cdn_ingest.py` | 4 | §3.1, §7.2 | Canonical `ingest_music_file`: fresh import assigns deterministic UUIDv5; repeated import reuses canonical ID; track deletion creates durable tombstone in `share_entities` and clears path claim; same-path reimport after deletion allocates fresh UUIDv4 without reusing tombstoned UUIDv5; recovery of tombstoned ID rejected; guarded legacy upsert raises `IdentityNotClaimed` on tombstone; album merge alias chains compress in 1 hop. |
| `test_cdn_compatibility.py` | 4 | §2.1, §2.2, §2.3 | MediaTicketResponseV1 fixed G1 DTO schema conformance (10 exact fields); omitted delivery returns direct (600s TTL, `if-match` binding); unknown delivery returns 422; flag/pilot/purge selection matrix (CDN selected only when flags on, user in pilot allowlist, version ready, purge healthy; otherwise direct); auth scope separation (`scope: 'media'` ticket can stream bound track, but rejected 401 on ticket issuance, share resolver, and account APIs); migration 016 idempotence across repeated runs. |
| `test_cdn_purge.py` | 6 | §9 | Prepared versions vs exposure ledger: direct-only tracks (never CDN-issued) create 0 outbox jobs on mutation/deletion; exposed tracks within `drain_until` window create durable purge outbox jobs; expired exposures create 0 purge jobs; saturated capacity (0 slots) allows direct mutations while failing exposed mutations with rollback; 65s rate limit and ambiguous submission backoff; expired unowned jobs transition to `drained` (never falsely `succeeded`). |
| `test_cdn_versions.py` | 9 | §3, §4.3 | Full-file SHA-256 version lifecycle (fingerprint invalidation on change); version-bound direct cache admission (`GET /api/stream/{tid}` with `If-Match: "sha256-<hash>"`): matching returns 200 full file with strong ETag; mismatched, unversioned, weak `W/`, wildcard `*`, or Range combined with If-Match returns 412; equal-length atomic file replacement before pin returns 412, after pin delivers original pinned bytes. |
| `test_cdn_share.py` | 10 | §7 | Share resolver `GET /api/share/{type}/{id}`: requires Access JWT (unauthenticated or Media JWT returns 401); lossless `share_id` and `album_share_id` text strings in Track and Album DTOs; album merge aliases resolve to canonical target; tombstoned entities return 410; registered artists with 0 tracks return empty profile (200 with empty `tracks` and `albums`, not 404); strict validation of entity kind and format. |
| `test_cdn_redaction.py` | 3 | §10 | Canary-string test: injects distinct canary tokens for signing secret, origin secret, and file paths; verifies 4xx/5xx responses never leak canary tokens; emitted log records do not contain origin secrets, signing secrets, or raw JWT tokens; unhandled 500 runtime exceptions do not leak canary exception details. |

---

## 3. Synthetic Fixtures

Synthetic test audio files were created strictly under `brain/fixtures/cdn/`:
- `brain/fixtures/cdn/sample_synthetic.mp3`: 10,240 bytes of deterministic test pattern.
- `brain/fixtures/cdn/sample_replacement.mp3`: Exactly 10,240 bytes of inverted test pattern (equal-length substitution fixture for replacement race verification).
- `brain/fixtures/cdn/tiny_synthetic.mp3`: 256 bytes minimal fixture.

No real audio files or existing sample tracks (e.g. `temp_audio/Daft Punk - Around the World.mp3`) were touched or copied.

---

## 4. Contract Conformance and Defect Analysis

### 4.1 Verified Contract Conformance (S2 Implementation)
S2 implementation conforms to the frozen Contract v1 draft revision 2 in all evaluated areas:
1. **Independent Cryptographic Signing:** Verification of Yandex no-IP token formula against OpenSSL CLI oracle matched exactly.
2. **Origin Security & Strict Parsing:** Strict path regex (`OBJECT_PATH`) and query regex (`QUERY`) properly enforce canonical lowercase identifiers, reject parameter tampering, semicolon delimiters, duplicate tokens, and query strings exceeding 128 bytes.
3. **ASGI Boundary Isolation:** `DeliveryBoundaryMiddleware` successfully guarantees no-store cache headers and media CORS policies on all responses (including 400, 401, 403, 404, 405, 412, 416, 422, and injected 500) without breaking baseline account CORS.
4. **Permanent Catalog Identity:** Ingest claims, UUIDv5/UUIDv4 allocation, deletion tombstones, and same-path reimport identity guarantees function cleanly.
5. **Durable Purge Ledger:** Intent is recorded exclusively for CDN-exposed objects; unexposed direct mutations require zero purge capacity.

### 4.2 Failures in Existing Un-Migrated Test Suites
When executing the pre-existing test suites `test_media_ticket.py` and `test_closed_access.py`:
- **Command:** `cd brain && venv/bin/python -m pytest test_media_ticket.py test_closed_access.py -q`
- **Result:** 10 passed, 1 failed, 22 setup errors (exit code 1).

**Root Causes:**
1. **Legacy Response Shape Assertion (`test_media_ticket.py:144`):**
   - Test asserts: `self.assertEqual(set(body.keys()), {"url", "expires_in", "expires_at"})`.
   - Frozen Contract §2.1 defines `MediaTicketResponseV1` with additive fields: `delivery`, `server_time`, `content_version`, `content_length`, `download_binding`, `delivery_epoch`, and `cache_for`.
   - S2 correctly implemented the frozen contract; the pre-existing test had an exact 3-key equality assertion that was not authorized for S2 modification.
2. **Strict Safe Path Jail Rejection (`TestStreamContract` & `TestClosedAccess` setup):**
   - Both test classes execute `db.add_or_update_track(..., file_path=os.path.abspath(SAMPLE_MP3))` using `SAMPLE_MP3 = "temp_audio/Daft Punk - Around the World.mp3"`.
   - Under the new security contract, `repositories/share_entities.py:normalize_rel_path` enforces that audio paths must reside within `get_effective_music_dir()`.
   - In unisolated legacy test invocations where `MUSIC_DIR` is unset (defaulting to `/media/music`), the path fails the `commonpath` jail check and raises `IdentityNotClaimed: identity_not_claimed`.

Per the J3 role specification ("no source fixes. Own new test_cdn files only, no S2 tests edits"), these existing test files were left completely untouched.

---

## 5. Scope and External Release Gates

Isolated backend tests cannot certify the following external release gates, which remain **OPEN**:
1. **G2 Coordinator Acceptance:** Awaits coordinator review of this J3 independent verification report alongside S2 backend delivery evidence.
2. **G3 Warm-Cache Auth & Origin Overwrite:** Real provider CDN token rejection, warm-cache invalid/expired token re-validation, edge-level client header overwrite, and SNI/Host isolation require live operator probes on `origin-media.puuk.fun`.
3. **G3 Physical Device & Network Integration:** Signed physical iOS build verification, AVFoundation redirect/header capture, and Web Audio streaming behavior.
4. **G4 Performance Baseline & Pilot:** European audible start time improvement (≥30%) and RF seek/rebuffer regression boundaries (≤20%) require live network measurements and the 24-hour pilot.

Issuance of CDN URLs must remain globally disabled (`CDN_DELIVERY_ENABLED=False`, `CDN_ORIGIN_ENABLED=False`) until all release gates are formally closed by the coordinator.
