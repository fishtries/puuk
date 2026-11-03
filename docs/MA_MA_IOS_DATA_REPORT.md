# Multi-artist iOS data report

Implemented ordered credits and revision normalization for tracks and albums, legacy singleton fallback without splitting, cached track pages and last-track normalization via the existing adapter, server DTO events, credit PUT and bulk clients, and namespace-scoped cache invalidation with in-flight request protection. Artist detail normalizes its track and album DTOs; artist reads themselves are uncached. Success events carry server responses; conflicts retain server code, message, revision and artists.

Files modified (relative to `app/ios/puuk-ios/`): `shared/domain/trackAdapter.js`, `shared/domain/artistCredits.js`, `shared/domain/artistCreditEvents.js`, `shared/api/apiCache.js`, `shared/api/artists.js`, `shared/api/artistCredits.js`, `shared/domain/__tests__/trackAdapter.test.js`, `shared/domain/__tests__/artistCredits.test.js`, `shared/api/__tests__/apiCache.test.js`, `shared/api/__tests__/artists.test.js`, `shared/api/__tests__/artistCredits.test.js`. This report is also new. Existing dirty/untracked baseline was preserved.

Commands from `app/ios/puuk-ios`:

- `npm test -- --runInBand shared/domain/__tests__/trackAdapter.test.js shared/domain/__tests__/artistCredits.test.js shared/storage/__tests__/settingsLastTrack.test.js shared/api/__tests__/apiCache.test.js shared/api/__tests__/artists.test.js shared/api/__tests__/artistCredits.test.js` — exit 0, 6 suites, 134 tests. Earlier runs exited 1 during implementation due to old DTO assertions and then a corrected namespace variable placement.
- `npm run lint -- shared/api/artistCredits.js shared/api/apiCache.js shared/api/artists.js shared/domain/artistCredits.js shared/domain/artistCreditEvents.js shared/domain/trackAdapter.js` — exit 0.

Limitations: fixture-driven client tests do not verify the forthcoming backend implementation or device behavior. Integration owner must wire event consumers, active queue/current-track refresh and last-track updates; no UI, production, audio or Qdrant was changed. Cache invalidation clears the active server/user namespace broadly, including unrelated catalog data, to prevent stale credit-bearing records.
