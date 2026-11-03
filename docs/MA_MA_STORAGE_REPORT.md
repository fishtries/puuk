# MA storage — implementation report

Task `task_097dfdb05e65`, Dispatch `ctx_b2b3a53a8f6e`. Implemented the accepted frozen storage contract; no deployment, production mutation, reset, clean, commit, or subworkers. Final ownership follows contract §11 and coordinator correction: actual schema is `brain/repositories/schema.py`; `brain/db.py` remains untouched for integration.

## Modified files

- `brain/migrations/012_artist_credits.sql`: frozen registry, ordered track/album links and reverse indexes, durable manual/source/recovery state, bulk operation journal.
- `brain/repositories/artist_credits.py`: all frozen storage APIs, exceptions and types, stable normalization/hash identity, selectors, source ranks, protected manual empty lists, revision/no-op/conflict semantics, backfill, merge/delete and bounded hydration.
- `brain/repositories/schema.py`: migration SQL and Python backfill/checkpoint in one transaction; legacy album identity backfill runs only inside first migration008, not every startup.
- `brain/repositories/tracks.py`: keyword-only source inputs, transactional ingest in existing writers, no-op catalog guard, explicit-delete state cleanup, recovery membership, bounded get_tracks_by_ids and hydrated collection/search reads; search uses effective membership with EXISTS.
- `brain/repositories/albums.py`: source-aware resolve, collection hydration, transactional credit-aware merge, explicit rebind recovery snapshots, cleanup, connection-aware migration008 data backfill. Target raw album identity is retained during credit merge.
- `brain/test_multi_artist_storage.py`: 21 isolated storage tests, including migration failure rollback, stale revisions, source precedence, manual clears, real WAV hash/stat stability, recovery, merges/deletes, search attribution and 10k batch reads.
- This report.

Existing dirty baseline changes were retained. `brain/repositories/base.py` required no edit: its existing connection and catalog-version interfaces were sufficient. No changes were made to API/services, bot, metadata readers, iOS or web.

## Public interfaces and downstream integration

`repositories.artist_credits` exports the frozen signatures: normalize_artist_name, artist_id_for_name, backfill_artist_credits, get_credit_states, replace_artist_credits, ingest_artist_credits, merge_album_credits, forget_artist_credits, hydrate_track_credits, hydrate_album_credits; CreditSource, CreditState, EntityType/SourceKind/CreditSelector and CreditNotFound/CreditValidationError/CreditConflict/AlbumCreditsConflict are available. Additional ingestion helpers `legacy_artist_source(value)` and `audio_artist_source(meta, *, album=False)` hide absent-vs-empty adaptation. Domain writers do not commit or bump catalog version: their transaction owner must do that, as specified by the contract.

Existing track writer positional arguments remain compatible and gain the frozen keyword-only artist_source / album_artist_source parameters. resolve_album gains artist_source. backfill_album_identities accepts optional keyword conn and leaves commit/close to its owner when supplied. No db facade exports were added because db.py belongs to integration.

Single internal readers `get_track`, `get_album`, and `find_album_by_identity` deliberately retain raw source rows so existing import/editor identity callers do not consume display strings as source identities. API DTO boundaries must call the frozen hydrate helpers once; this boundary was reported to the coordinator before settlement. Collection/page/search/batch reads already hydrate and include private `_source_artist` / `_source_album_artist` snapshots for compatibility checks; public serializers must continue selecting public fields rather than publishing these internal snapshots. Artist catalog/popularity/serialization conversion, editor preflight, and file-level source propagation remain with their assigned API/import owners.

Merge helpers are mutating transaction operations; API must preflight conflicting manual lists before file writes, then invoke merge again under the final write transaction. Partial file-edit album splits and their manual decision transfer are API-service integration work, not implemented by storage-only changes. No migration performs punctuation splitting or repairs legacy compound names automatically.

## Verification: actual commands and exits

All pytest commands use project `brain/venv/bin/python`; test isolation imports test_db_path before repository/config imports and each new test additionally uses a disposable PUUK_DB_PATH. No real Qdrant/audio library writes were performed.

| Command/check | Exit / result |
|---|---|
| `brain/venv/bin/python -m py_compile brain/repositories/{artist_credits,tracks,albums,schema}.py` | 0 |
| `brain/venv/bin/python -m pytest -q brain/test_multi_artist_storage.py` | 0; 21 passed, initial run4.00s |
| `brain/venv/bin/python -m pytest -q brain/test_albums.py brain/test_track_recovery.py brain/test_track_deletion.py brain/test_tracks_etag.py brain/test_artist_search_albums.py` | 0; 71 passed +17 subtests, one pre-existing Starlette/httpx deprecation warning |
| `brain/venv/bin/python -m pytest -q brain/test_multi_artist_storage.py brain/test_albums.py brain/test_track_recovery.py brain/test_track_deletion.py brain/test_tracks_etag.py brain/test_artist_search_albums.py` | 0; 92 passed +17 subtests, 6.22s, same warning |
| Final bounded-query run: `brain/venv/bin/python -m pytest -q brain/test_multi_artist_storage.py` after increasing fixture to10,001 tracks/1,000 distinct artists | 0; 21 passed, 4.57s |
| `git diff --check -- brain/repositories/schema.py brain/repositories/albums.py brain/repositories/tracks.py` | 0 |

The large fixture asserts exactly52 SELECTs for get_credit_states across10,001 IDs (26 chunks×2 queries, chunk size400), with no query per track; get_tracks_by_ids accepts the same10,001 IDs without exceeding bind limits. Hydration leaves caller input rows unchanged. The real WAV fixture test checks SHA256, size and mtime_ns before/after participant edits and repeated startup, and unchanged stored cover/loudness/file metadata. Participant edits also succeed when the track file does not exist.

A disposable snapshot upgrade was run by copying `/tmp/puuk-ma-baseline/library-snapshot.db` with shutil.copy2 to `/tmp/puuk-ma-storage-dryrun-m8u1yaka/library.db`, setting PUUK_DB_PATH to the copy, then calling init_db twice. The source backup and production were never opened for writing. Assertions compared exact ordered snapshots of track IDs/raw artists/album membership/file paths/file stats/cover versions, album IDs/titles/raw album artists/normalized identities, artwork rows and play events before/after both initializations; all were identical. integrity_check returned ok and foreign_key_check was empty. Result counts:1,148 tracks,887 albums,891 registered artists,1,138 track links,874 album links,2,035 credit state rows. Repeated init left every credit state row identical. This was a schema/source preservation check, not a data correction or deploy.

## Acceptance scope and limits

Storage portions of T01/T02/T07–09/T12/T18/T19/T22 have direct evidence above. Transaction owner catalog bumps and no-op guards are covered; API RBAC/HTTP envelopes, cross-surface DTO equivalence, file-backed editor/recovery flows, bulk apply/undo and iOS invalidation require downstream integration. Oversized source observations are rejected without truncation and logged with entity/type/count; the reconciliation report owner must surface unresolved source cases. Registry/artwork persist after explicit entity deletion; manual/source state survives accidental row loss and is removed on explicit storage deletion. A lost SQLite/state backup cannot reconstruct a manual decision from stale Qdrant.

The full backend suite, bot/iOS/web suites, independent review, device smoke, and release gates were not claimed by this storage task. No further broad combined test run was requested after coordinator checkpoint; the unresolved large-batch check was completed successfully before settlement. Production rollout remains out of scope.
