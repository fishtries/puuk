# Purge authentication addendum — 2026-11-16

The deployment accepts either the existing protected `CDN_PURGE_TOKEN` or
`CDN_PURGE_SERVICE_ACCOUNT_KEY_PATH`, exclusively. A manually issued IAM token
expires within twelve hours and cannot cover the planned day-long pilot without
renewal. The dedicated `puuk-cdn-purge` service account has `cdn.editor` in folder
`b1gsa0m47foeebngkgjq`; no existing account or role was changed.

The authorized RSA key is outside the repository at
`/etc/puuk/cdn-purge-account.json`, owned by the backend user with mode 0600.
Its directory is root-owned 0750, group fish; cdn.env remains root-only 0600.
Startup rejects symlinks, nonregular/oversized/public key files, malformed identity
fields and invalid private RSA material. Runtime reads are bounded and do not
block on FIFOs. Public-key and description fields are omitted from child input.

Each existing supervised purge/poll child exchanges a PS256 assertion for a fresh
IAM token. The assertion names only the fixed IAM audience, service account,
authorized-key ID and a five-minute validity window. IAM exchange and the CDN
request share the existing **ten-second** child deadline and two-second socket
limits. There is no token renewal daemon, persistent token cache or additional
retry layer. Fixed TLS endpoints, verified certificates, no redirects and bounded
responses remain mandatory. IAM 429/5xx uses the existing finite durable retry
budget, including Retry-After; permanent failures never submit a purge.

Credentials enter child stdin only; neither private key, assertion nor IAM token
appears in child output, command arguments, jobs or logs. The purge heartbeat,
outbox capacity, terminal-failure gate and 65-second submission reservation still
apply with either authentication method. This extends credential provisioning;
it changes no playback permission, cache TTL, exposure accounting, retirement,
timeout, pilot-membership or rollback guarantee in CONTRACT revision 2.

Validation: **198 selected tests passed**, one existing warning, 43.42 seconds.
This includes legacy media-ticket/closed-access, delivery/share and all eleven
test_cdn modules. Fixtures use disposable PUUK_DB_PATH/MUSIC_DIR; Qdrant is mocked.
The first attempted run used an obsolete external fixture plugin that switched
databases after class setup and caused 401s; it was discarded and rerun with the
repository's current fixtures. Final log: /tmp/puuk-cdn-iam-release-tests.log.

Live installation checked all four exact source predecessors, source hashes and
syntax, then validated the private key as fish. Backup:
`/var/backups/puuk-cdn/iam-20261116T113244963322Z`.
Only puuk-brain restarted; origin remained enabled and protected, while delivery
and purge remained disabled. Pilot membership was prepared for the user-selected
`admin`, immutable database ID 1. IAM exchange/resource read succeeded; a successful
purge and warm-cache security still need separate live evidence.

Provider references:
[service-account IAM exchange](https://yandex.cloud/ru/docs/iam/operations/iam-token/create-for-sa),
[CDN authentication](https://yandex.cloud/en/docs/cdn/api-ref/authentication),
[purge](https://yandex.cloud/en/docs/cdn/api-ref/Cache/purge),
[operation polling](https://yandex.cloud/en/docs/cdn/api-ref/Operation/get).
