# CDN operations — current deployment, 2026-11-16

This records executed infrastructure work and the remaining acceptance gates.
It does not declare G3/G4 or a client rollout complete. The earlier
CDN_RUNBOOK_DRAFT.md is retained as historical preparation.

## Targets and custody

- Backend: fish@192.168.1.117:59348, /home/fish/apps/puuk/puuk/brain,
  service puuk-brain, loopback 127.0.0.1:8000. Telegram bot is separate.
- Public web/API: https://web.puuk.fun; protected origin:
  https://origin-media.puuk.fun; CDN: https://media.puuk.fun.
- Yandex folder b1gsa0m47foeebngkgjq, resource bc8rblqq55f6agqt4y6s,
  group3963237803924896693 (puuk-media-origi), sole source origin-media.puuk.fun.
  There are no resource rules or secondary hostnames; only this resource consumes
  the group. Its failover option is enabled but there is no second source.
- DNS and media validation CNAME/certificate remain in place. Origin has its own
  Let's Encrypt certificate, ACME webroot and nginx renewal hook.
- /etc/puuk/cdn.env is root0600; no secret values belong in Git or terminal output.
  /etc/puuk/cdn-purge-account.json is fish0600 under root:fish0750 /etc/puuk.
  Service account puuk-cdn-purge, ID aje82fsqnvfiqfp8s97e, authorized key ID
  ajermrc66edqlnf7rg8b, has cdn.editor only in the selected folder.

## Effective rollout state

CDN_DELIVERY_ENABLED=false, CDN_ORIGIN_ENABLED=true, CDN_PURGE_ENABLED=true.
The user selected admin; immutable user ID1 is the prepared pilot membership.
An empty pilot set means nobody. Neither admin role nor a client claim bypasses
membership. Global issuance stays off until the closed cache security matrix and
the required client/rollback gates pass. Web and iOS public capability flags
still default false. Share-link rollout is independent and remains gated.

Backend27-file release d26503a was installed with all flags off, followed by the
four-file IAM update9662779. The latter source hashes match its reviewed package.
Only puuk-brain restarted. No broad deploy.sh, bot restart or database restore was
used. Web candidate9643683 passed220 tests/build/lint with both flags false and
has a source/asset manifest; production web publication is still pending. Native
integration is in bb050d9; installed signed-device/build acceptance remains open.

## Provider policy

HTTPS origin, Host/SNI origin-media.puuk.fun, secure token without IP binding,
one overwritten X-Puuk-Origin-Secret upstream header, GET/HEAD/OPTIONS, no
redirect following, fixed CORS whitelist https://web.puuk.fun, no credentials.
Cookies are ignored; only md5/expires are excluded from the cache key. Client
Cache-Control is private,no-store. Browser caching is off. Edge success caching is being enabled only for the
closed fixture experiment; no warm acceptance or user rollout is implied.
Slicing is off for initial acceptance. disableProxyForceRanges is enabled to
preserve HEAD ignoring Range. Static response headers supply byte-range support,
exposed metadata and the required preflight methods/headers/Max-Age300.

Accept-Ranges is a list under RFC9110§14.3: repeated bytes values are semantically
the same advertised range unit. The probe accepts only nonempty bytes units,
including identical repetitions; missing/none/other units still fail. An early
probe incorrectly required a single literal field value. Exploratory header
filtering was reverted; no byte/status/access/CORS guarantee was relaxed.

Every API mutation used an explicit camelCase updateMask and retained protected
before-state. Operation completion and API readback do not prove edge propagation.
Choose a consistent updated connection/node for a matrix and record its cache-host.

## Commands and closed probes

Scripts are staged at /home/fish/puuk-cdn-setup. Use the backend venv interpreter
for scripts importing jwt/backend modules. Each tool prints sanitized results,
never signed URLs, keys, account passwords or recording metadata.

```sh
sudo python3 /home/fish/puuk-cdn-setup/probe-origin.py
sudo python3 /home/fish/puuk-cdn-setup/probe-audio.py --origin
sudo python3 /home/fish/puuk-cdn-setup/probe-audio.py
sudo /home/fish/apps/puuk/puuk/brain/venv/bin/python /home/fish/puuk-cdn-setup/probe-direct.py
sudo /home/fish/apps/puuk/puuk/brain/venv/bin/python /home/fish/puuk-cdn-setup/probe-purge.py
```

The audio probe is for cache-OFF checks only. It compares exact full/single and
multipart range bytes, HEAD, If-Range,304/400/416 and preflight. Its selection
requires corrected HEAD/Range and final static preflight headers on the same
connection. An origin-only PASS does not accept the CDN.

Direct smoke uses one sixty-second operator-issued admin session in memory,
checks unauthenticated denial, default/direct/CDN-request selecting direct while
off, range bytes and version-bound transfer. It changes no account or catalog.
Purge smoke reserves the production65-second submission limiter and durably
records one nonexistent-prefix operation; subsequent calls poll that same ID.
It never submits an empty/full-resource purge or labels ambiguous completion PASS.

The coordinator authorizes a closed disposable fixture under the user's original
plan execution and autonomous handling request: one locally generated five-second
silent MP3 (81127 bytes, SHA256c7ae4cf635c5742e03e2647322cc268432198c011cfd8ab8ffccfc57bacddb86),
one uniquely recorded temporary track and one random-password non-pilot account.
No original recording, existing second account, metadata edit or deletion is
used. acceptance-fixture.py maintains the exact owned identities and file in a
protected server-side manifest. Only this generated track may be retired for the
purge proof. Exposure is registered under its track lock before closed signed
URLs are created, with normal1800-second maximum expiry and the retained drain
ledger. The test account never joins the pilot or enables global issuance.
Cleanup removes only the exact generated file/test account after retirement;
tombstones, exposures and purge audit remain. A drained job is not successful
purge evidence. Cold origin and CDN protocol matrices passed; the fixture has not yet been
accepted as warm-cache proof here.

Warm tests must observe provider HIT/Age plus fewer matching origin log reads,
and then repeat unsigned/wrong/expired/path/version/query and header tests.
The safe origin access log records status/method/URI/bytes/time, never query
strings or headers. Its inode/rotation must be checked across a count interval.
Do not infer a HIT from cache-host alone. Success-only edgeTTL3600, error/redirect/
OPTIONS TTL0 and stale-off must be verified before warming. Browser no-store
must survive actual HITs. No library-wide warmup is authorized.

## Backups and rollback

Protected /var/backups/puuk-cdn directories:

- 20261116T103616948641Z: backend predecessor/source and consistent SQLite backup.
- origin-20261116T104006038278Z: closed-origin/nginx/environment predecessor.
- iam-20261116T113244963322Z: exact four-file IAM predecessors and environment.
- mode-20261116T114128361213Z: environment before enabling purge.
- provider-20261116T114443675862Z: five complete protected provider snapshots.

Ordinary delivery rollback stops new permissions, clears pilot IDs and advances
the epoch while retaining protected origin and purge for the drain period:

```sh
sudo python3 /home/fish/puuk-cdn-setup/set-delivery-mode.py direct
```

The mode helper backs up the environment, atomically publishes only known flags,
restarts only puuk-brain, verifies effective flags/origin and a fresh purge
heartbeat, and restores the environment on failed readiness. It does not enable
delivery or restore a database. Its purge-on mode has been executed successfully;
a real CDN-to-direct rollback rehearsal is still required before rollout.

Security rollback additionally disables the CDN resource or invalidates its
signing key and observes denied warm requests after propagation. Purging or
rotating only the origin secret cannot revoke cached bearer URLs. Preserve DNS,
certificates, new user data and all durable identity/exposure/outbox rows.

Do not replay a whole historical provider snapshot blindly: some contain the
earlier incomplete header/range settings. Apply a reviewed explicit field mask,
preserving token protection, dedicated origin and current credential custody.

## Remaining gates

Closed complete CDN audio/preflight proof after propagation; warm-cache negative
matrix and real exposed-fixture purge/rollback; reviewed web publication; signed
physical iOS installation and behavior; RF/EU measurements and24-hour pilot.
Neither198 isolated backend tests nor220 web tests substitute for those live gates.
