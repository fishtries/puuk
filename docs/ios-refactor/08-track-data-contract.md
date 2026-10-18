# Stage 8: Track Data Contract

**Owner:** Senior model designs; junior implements a narrow boundary after approval.  
**Dependencies:** Stages 4 and 6 accepted.

## Target

Track DTO adapters and consumers in the approved feature/shared tree.

## Change

Reduce repeated handling of `id` and `track_id` by defining one internal track identity contract and normalizing at data boundaries. Do not change backend responses or the appearance of track rows/player.

## Constraints

- Inventory every current track source before choosing a normalized shape: catalog pages, search, wave/queue, album, playlist, edits/events, persisted last track, and player history.
- Preserve valid ID values including numeric zero; do not use truthiness where absence/null checks are required.
- Preserve unknown/additional track fields needed by screens and editing.
- Do not silently discard persisted legacy tracks; provide compatibility handling for stored `track_id` records.
- Avoid repeated re-normalization at every component; normalize at explicit input boundaries.
- Do not change API request/response schemas or server code.
- Keep this separate from large player decomposition and UI redesign.

## Ownership

Senior approves the contract and migration order. Junior may implement one named boundary and its tests at a time. Do not modify server or web clients.

## Observable acceptance

- Contract specifies canonical identity field, accepted legacy inputs, null/zero semantics, and preserved fields.
- Tests cover `id`, `track_id`, missing identifier, zero identifier, and stored legacy data.
- Relevant API cache, pagination, player, search, album, playlist, and edit tests pass for each migrated source.
- No duplicate rows or queue entries appear when IDs arrive in different legacy forms.
- Full iOS Jest suite and bundle/build validation pass.

## Report

State the adopted contract, boundaries migrated, compatibility behavior, tests/results, and remaining legacy consumers. Do not claim repository-wide normalization until all sources are verified.
