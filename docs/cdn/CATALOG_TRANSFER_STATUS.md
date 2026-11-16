# Catalog transfer and VPN investigation — 2026-11-16

User confirmed the CDN-capable IPA and admin account. Switching VPN exits
(Netherlands/Germany) made the app slow again; force quitting did not restore
speed. This weakens a stale-app-connection-only explanation, but does not identify
the slow network segment or establish either country's CDN performance.

Read-only production probes from the backend host: auth7–25ms, paginated tracks
77–134ms, genre mixes270–388ms, history347–545ms, cover6–61ms. These are NOT EU
measurements. Three ordinary admin tickets explicitly requesting CDN returned200
and delivery=cdn in30–51ms. Durable exposures subsequently increased beyond the
operator probe tracks, so the earlier two-exposure snapshot must not be used to
claim the phone never requests CDN. No token/full capability/metadata was logged.

## Prepared transfer changes (not yet installed)

CatalogCompressionMiddleware negotiates gzip for an explicit allowlist of GET
catalog JSON routes only. Audio/origin/cover/auth/mutation routes retain their
existing responses. It preserves response cache policy and user authentication.
At compression level5, observed catalog JSON77043 ->13570 bytes; history155567
->26772 bytes. This measures byte reduction, not phone latency improvement.

Authenticated /api/cover/{id}?size=128..1024 supplies bounded JPEG previews.
Original URL still supplies the original embedded image. Preview ETags include
size/encoding revision; conditional requests remain authenticated. A bounded
32-entry cache keys file identity, size, nanosecond timestamps and artwork
revision; at most512KiB per output. Images above16million source pixels are not
decoded as previews. Embedded source/audio is never changed. Default artwork is
also resized for a preview request.

The iOS shared cover component chooses128/256/512/1024 using actual native pixel
density and rendered dimensions, preserving authorization and artwork revision.
Artist artwork behavior is unchanged. A real1000px source cover282030 bytes became
16099 bytes at256px; the1024px rendition retained dimensions and was232018 bytes.
A new IPA is required for adaptive requests; gzip benefits existing API clients
that negotiate it after the backend candidate is installed.

Local validation:53 selected backend tests passed, one existing warning;107 iOS
cover/media tests passed in two suites. Old cover cache fixture used an absolute
path outside the isolated music root and failed identity claiming before requests;
it now uses an isolated relative path, preserving its missing-file intent.

## Installation and rollback

Exact four-file package staged at
/home/fish/puuk-cdn-setup/catalog-release/install.py; hashes/predecessors mandatory.
Installer backs up source, restarts only brain, verifies auth readiness and all
live delivery flags unchanged, and restores only those sources on failed readiness.
No broad deploy, database restore or bot restart. probe-catalog.py checks actual
gzip wire bytes, preview bounds, ETag304 and missing-auth401 through public TLS.
Existing sudo grant belonged to a closed terminal; installation needs a new sudo
invocation by the operator. Until successful output, deployment is NOT claimed.

## Full CDN scope still pending

The current media resource requires signed capabilities and serves audio only.
Sending raw API or JWT-bearing cover URLs to it is not a valid migration. Cover
caching needs its own versioned, authorized delivery and invalidation policy; a
front door for account/catalog API must forward auth, support mutations, and keep
personal responses out of a shared cache. DNS/TLS and first-party origin validation
must be configured for that front door before switching clients. See official
[Yandex caching documentation](https://yandex.cloud/en/docs/cdn/concepts/caching)
and [resource creation](https://yandex.cloud/en/docs/cdn/operations/resources/create-resource).

No CDN front door for covers/menu has been configured by these transfer changes.
No RF/EU comparison, lower mobile start latency or complete rollout is claimed.

Expanded regression:221 backend tests passed, one existing warning,44.26s.
Initial expanded command referenced nonexistent test_share.py and ran no tests;
the corrected explicit test set includes test_share_identity.py and all CDN modules.

## Independent Germany/Netherlands network observations

Globalping measurements2UevAlwAGrabGFu1P00021W18 (web /api/auth/me) and
20N0iy6OIZRgQL6s800021W19 (media /), same four probes, unauthenticated GETs only.
See EU_NETWORK_PROBES.json for sanitized timings. Three DE/NL probes completed
web401 in295–307ms; one Amsterdam probe timed out at15000ms during TLS. The SAME
Amsterdam probe also timed out during TLS to media. Thus CDN alone did not solve
that probe's route. Three other media probes returned403 in171–511ms total, mostly
DNS156–503ms; TCP+TLS was6–15ms. Do not omit DNS to claim total startup speedup.
These are small denial responses, not authenticated audio or user-VPN throughput.
They reveal reachability variance but do not establish why the user's exit is slow.

Commit eb5cbc8 pushed; adaptive-cover iOS candidate CI run43902437289 started:
https://github.com/fishtries/puuk/actions/runs/43902437289 . Compilation and installed
acceptance remain pending. Backend transfer package is staged, not installed yet.
