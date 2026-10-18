# Stage 5: Shared Services, Events, Settings, and API Ownership

**Owner:** Senior model designs boundaries; junior may implement one explicitly scoped extraction at a time.  
**Dependencies:** Stages 2 and 4 accepted.

## Target

Current API/auth/settings/event code and its direct consumers, as listed in a senior-approved subtask.

## Change

Clarify ownership of HTTP transport, auth session/storage, app settings, last-track persistence, and cross-screen events. Replace hidden `DeviceEventEmitter` contracts only where the replacement makes ownership and payloads clearer.

## Constraints

- Do not replace all event usage in one pass. Inventory event names, producers, consumers, payloads, and lifetime first.
- Keep authentication, retry, timeout, cancellation, 401/logout, and offline semantics unchanged unless separately authorized.
- Keep settings persistence and listener timing unchanged.
- Do not add Zustand or a new event-bus library as a default solution.
- Do not create thin pass-through API modules that only rename imports.
- Preserve server endpoint/DTO contracts.
- Treat `id`/`track_id` normalization as Stage 8; do not mix it into service extraction.

## Ownership

Senior approves each boundary and migration slice. Junior receives an exact allowlist and one event/service at a time. Never run overlapping edits to shared API/settings files.

## Observable acceptance

- Before edits, each slice documents current producers/consumers and expected equivalent behavior.
- Existing relevant API/settings/auth tests pass; focused tests cover any changed event subscription lifecycle or service behavior.
- No event listener leak or duplicate subscription is introduced.
- Retry/timeout/abort and auth-change behavior remain covered by existing or focused tests.
- Full Jest suite passes after each accepted slice.
- No native dependency or IPA workflow change is introduced.

## Report

For each slice, report the old/new ownership contract, migrated producers/consumers, tests and outcomes, remaining emitter uses, and any behavior ambiguity. Stop on ambiguity rather than guessing.
