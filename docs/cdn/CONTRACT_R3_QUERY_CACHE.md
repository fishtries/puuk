# Contract R3 — complete query keys and provider compatibility

Coordinator revision, 2026-11-16. This amends the relevant R2 delivery details;
CONTRACT.md and its accepted SHA-256325d9b9a965fb1420dc4dc85218392cce8752fd68d3a1e61e9475ab00b020158
remain frozen as historical evidence. G3/G4 and independent final review are not
declared complete. The user selected admin/ID1 for a controlled pilot and later
directed continued work without more workers; the coordinator performs this
continuation and records that review constraint.

## Cache key and expiry

Retain **all query parameters**, including md5 and expires, in the CDN cache key.
The R2 blacklist of those two parameters is superseded. Live R2-style warm
requests with a valid duplicated md5 returned cached audio without visiting the
origin's strict query validator. Complete query keys restore duplicate/unknown
query rejection on misses while preserving their denial on subsequent requests.
The origin and first-party returned-URL validators still reject noncanonical
query syntax. Token enforcement remains mandatory before every cached response.

To share a canonical capability across authorized users without dropping auth
parameters from the cache key, bucket expiry in windows of at most300 seconds:

```text
window = min(300, configured_ttl - 59)
expires = now + configured_ttl - now % window
```

The configured TTL remains validated60–1800. Actual expires_in is always60 through
configured_ttl and never extends that budget. At the production1800 setting it is
1501–1800 seconds. server_time is actual integer issuance time; expires_at minus
server_time equals expires_in. Same object/window yields the same signed URL
independently of user identity, after each session/pilot/version/health check.
The next window rotates the URL. Exposure records the actual expiry under the
existing track lock; max-expires and drain bounds are unchanged. Direct tickets
and the30-second permission reuse lease are unchanged. This creates no userless
permission endpoint or synchronous provider call in Play.

## Provider-normalized object identity

First-party issued URLs remain exact canonical lowercase UUID/hash paths with
two canonical query parameters. The backend origin still validates raw paths
and queries before file lookup. However, the edge may normalize an equivalent
path spelling before validating a capability and looking up the cached object.
Observed example: /%61udio/ and /audio/ refer to the **same authorized UUID/hash**.
Unreserved percent-encoding equivalence is described in
[RFC3986§6.2.2.2](https://www.rfc-editor.org/rfc/rfc3986#section-6.2.2.2).

This compatibility profile permits the observed equivalent spelling only with
the correct unexpired signature and exact same bytes/strong hash ETag. It is not
permission to substitute another track/hash, ignore expiry, accept missing/wrong
tokens, weaken origin-secret checks or relax first-party URL validation. Live
encoded-path cases with missing/wrong/expired signatures denied403/410; encoded
paths targeting a different UUID/hash denied403. The original R2 assertion that
every raw spelling must deny is not claimed to have passed. Broader raw-path fuzz
coverage remains part of the final review rather than an invented guarantee.

## HEAD compatibility

Plain authenticated HEAD remains200, no body, full length/ETag. On a cached object,
this provider can return206 metadata to HEAD with Range: exact Content-Range,
selected Content-Length, unchanged ETag and **zero response bytes**. R2's stronger
edge promise that HEAD always ignores Range was not met. For the provider profile,
full metadata callers use HEAD without Range; range transfers use GET. First-party
permission/download code does not request Range on HEAD. Platform-player HTTP
behavior still needs physical-device acceptance. Unauthorized HEAD, including
HEAD with Range, must deny before disclosing object metadata. Origin HEAD itself
continues to ignore Range.

## Evidence and remaining gates

Local frozen source checks:211 selected backend tests passed, one existing warning,
43.85 seconds; disposable databases/audio only, Qdrant mocked. This includes
independent expiry-window examples, security bounds across all tested boundary
positions, real two-session ticket equality inside a window, rotation at the next
window and the durable maximum exposure expiry. Web candidate previously passed
220 tests/build/lint. CI iOS candidate75c2302 completed successfully with its public
CDN capability enabled; that flag does not enable server issuance.

Closed raw-query probe on yccdn-m9-14: four full fixture GETs required one origin
read and produced three observed Cache-Status HITs, with exact81127 generated
silent bytes. Warm Range/HEAD matched; missing/wrong/expired/path/version tokens,
extra/duplicate/encoded query keys and expiry-duplication attempts denied. After
waiting past a65-second test capability on the **same maintained connection**,
the identical cached URL and its equivalent path spelling both denied410.
Browser-facing private/no-store, no cookies, fixed web CORS and exposed metadata
were checked. No original recording or real user's CDN permission was used.

These results support the controlled provider profile. Actual exposed-fixture
retirement/purge, server rollback, installed candidate behavior, broader independent
review, RF/EU measurements and24-hour observation remain separate gates. No full
release acceptance follows from this amendment alone.
