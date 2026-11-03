# iOS bulk artist correction

Implemented an admin-only entry on the artist profile and a separate replacement screen. It uses exact source ID, the shared artist editor, independent track/album scopes, server preview count and every before/after entry, and the same preview operation ID for apply retry. A 409 invalidates the preview while preserving the draft; 403 is visible; an unavailable source profile shows a clear back action. The shared API performs cache invalidation and emits one bulk event, not per-entity events.

Files modified:
- `app/ios/puuk-ios/features/artists/ArtistScreen.js`
- `app/ios/puuk-ios/features/artists/ArtistCreditBulkScreen.js`
- `app/ios/puuk-ios/features/artists/__tests__/ArtistScreen.test.js`
- `app/ios/puuk-ios/features/artists/__tests__/ArtistCreditBulkScreen.test.js`
- `docs/MA_MA_IOS_BULK_REPORT.md`

Integration required: register `ArtistCreditBulk` in RootNavigator, rendering `ArtistCreditBulkScreen` with `currentUser`; ArtistScreen navigates with `{artistId, artistName}`. Editor owner was asked to supply `onSaveDraft(input, draft)` with the optional second ordered, named draft argument; screen already consumes it and falls back to IDs where names are unavailable. Until that editor enhancement is integrated, existing selected IDs may display as IDs when reopening the editor. The server remains authoritative for all preview names.

Commands and outcomes:
- Expo v58 reference read, alongside project instructions, contract and design guides.
- An initial Jest command was launched from the repository root by mistake and interrupted (exit 130); it did not run the intended tests.
- `npx prettier --write features/artists/ArtistCreditBulkScreen.js features/artists/__tests__/ArtistCreditBulkScreen.test.js`: exit 0.
- `npx jest --runInBand features/artists/__tests__/ArtistCreditBulkScreen.test.js features/artists/__tests__/ArtistScreen.test.js`: initial runs exit 1 due to test queries, final exit 0, 2 suites and 23 tests passed.
- `npx eslint features/artists/ArtistScreen.js features/artists/ArtistCreditBulkScreen.js features/artists/__tests__/ArtistScreen.test.js features/artists/__tests__/ArtistCreditBulkScreen.test.js`: exit 0, two warnings because test files are ignored by configuration.

Device smoke, VoiceOver, large text and large preview performance remain untested. The preview currently renders all entries in a scroll view; a large 5000-entry preview needs device performance validation. No production database, Qdrant, audio, deploy or dependency mutation was performed.
