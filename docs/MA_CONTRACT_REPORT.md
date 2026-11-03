# MA Gate 0 — отчёт ma-contract

Дата: 2026-10-28 (Europe/Moscow). Task `task_f8bf892de845`, Dispatch `ctx_d1f188053cb8`.

Подготовлен [MULTI_ARTIST_CONTRACT.md](MULTI_ARTIST_CONTRACT.md): SQL012 с атомарным Python backfill/checkpoint, minimal domain APIs, source ranks и tombstones, independent track/album attribution, DTO/errors, фактическая legacy PATCH матрица, durable bulk preview/apply/undo и CLI, recommendation sets, iOS data/event/editor договор, ownership/T01…T23. В прежний контракт добавлена явная карта заменённых single-artist предположений с сохранением D-решений/исторических результатов; план ссылается на новый freeze и исправляет ownership schema/db/composition roots. Реализация, деплой и изменения данных не выполнялись.

## Фактически изученные источники

Документы: AGENTS.md; MULTI_ARTIST_ORCHESTRATION_PLAN.md полностью; ARTISTS_SECTION_CONTRACT.md полностью; docs/design/DESIGN.md (принятые multi-artist решения и состояния); skills orchestration/orca-cli и version-matched `orca skills get orchestration`; software-design SKILL+mini, release-it SKILL+mini, puux-ux SKILL. UI styling/animation не проектировались; puuk-ui/ios implementation guide требуется назначенным UI workers до кода.

| Область | Просмотренные реальные пути/точки |
|---|---|
| SQLite/bootstrap | `brain/repositories/schema.py::apply_migrations/init_db`, `base.py::TRACK_SUMMARY_COLUMNS/get_connection/bump_catalog_version`, `brain/migrations/008_album_entity.sql`, список migration002…011, `brain/db.py` imports/init |
| Track storage/search | `brain/repositories/tracks.py::add_or_update_track/update_track_metadata/update_track_metadata_from_audio/search_all/get_track_artist_map` |
| Album identity/merge | `brain/repositories/albums.py::normalize_text/resolve_album/rebind_tracks_to_album/merge_album_into/delete_empty_albums/backfill_album_identities` |
| Artist membership | `brain/repositories/artists.py::normalize_artist_name/artist_id_for_name/album_attribution_clause/get_artist_catalog/get_artist_detail/record_play_start` (интерфейсы и относящиеся SQL sections) |
| HTTP/DTO/editor | `brain/routers/{tracks,albums,search}.py`, `brain/serializers.py`, `brain/services/album_service.py`, `brain/services/track_metadata_service.py::check_track_edit_permissions/get_track_metadata_details/mutate_track_metadata/resync_track_from_disk/reconcile_uncommitted_mutations` |
| Ingest/recovery | `brain/metadata.py::AudioMetadata`, `brain/services/library_service.py`, `brain/services/media_locations.py::ensure_track_from_file/ensure_track_in_db`, `brain/scan.py`, `brain/heavy_worker.py::ensure_track_in_sqlite` и queue payload sections, `brain/services/embedding_queue_service.py::_build_payload` |
| Bot | `tg_music_bot/audio_tags.py` AudioTags/readers, `downloader.py::_match_song/_finalize_track/_build_tracks`, `bot.py::index_downloaded_tracks` |
| Recommendations | `brain/services/recommendation_service.py::_ArtistResolver/select_diverse_recommendations/apply_diversity_penalty/build_wave_track_payload`, `brain/services/personalized_recommendation_service.py` artist breadth/caps/penalties/tie-break, `brain/repositories/wave.py::get_recent_artists`, `brain/wave_tuning.py` artist metrics |
| iOS shapes/state | `app/ios/puuk-ios/features/library/TrackEditScreen.js`, `features/albums/AlbumEditScreen.js`, `shared/domain/trackAdapter.js`, `shared/api/apiCache.js`, `shared/storage/settings.js`, App.js/player-controller event locations; actual paths enumerated by rg |
| Web shapes | `app/web/src/components/tags/useTagEditorForm.ts` (полностью), `components/albums/AlbumEditorModal.tsx` payload/state, `src/types/track.ts` path/type consumers |

Реальные router filenames для integration: `brain/routers/{wave,wave_recommendations,personalized_recommendations,playlists,user_content}.py`. Composition roots `brain/api.py`, `brain/db.py`, iOS `App.js`, `navigation/RootNavigator.js`, `hooks/usePlayerController.js` принадлежат ma-integration. Shared event module принадлежит ma-ios-data; editor paths — features/library и features/albums, не предполагаемый features/tracks.

## Существенные находки, отражённые в freeze

1. Legacy `backfill_album_identities` запускается после миграций на каждом init, выводит непустой artist из track tags, меняет normalized identity и удаляет empty albums. Новый контракт делает его version008-only на supplied connection до checkpoint; после012 startup не должен переатрибутировать release/удалять ручные пустые сущности.
2. GET редактора берёт artist из audio и при stat mismatch ресинхронизирует SQLite. PUT artists не должен вызывать этот file-backed GET для ответа; обычный editor GET после чтения берёт эффективные credits из SQLite.
3. Legacy track/album PATCH отправляет неизменённые tag поля вместе с artist. Поэтому проверять «credits-only» по фактическим изменениям после canonical filtering, а не по наличию title/cover keys. Reject изменённого multi artist или mixed changes до file/cover fetch/journal.
4. Track artist используется как fallback album artist в нескольких ingest/recovery путях. Existing release identity сохраняется; новые album credits только из album-level source; manual display не участвует в resolve_album.
5. Recommendation resolver Qdrant-first, personalized путь также одиночный. Freeze задаёт SQLite-first sets, authoritative[], recent five track events, max-frequency penalty, all-participant cap и ID dedup в refill.
6. Связи с FK сами по себе не сохранят manual decision при accidental row loss. Durable non-FK artist_credit_state хранит manual/source recovery snapshots; explicit delete чистит state, accidental recovery materializes links. Потеря самой БД требует backup, не восстановления override из Qdrant.

## Проверки и пределы

| Проверка | Фактический результат |
|---|---|
| Извлечённый frozen SQL §3 исполнен дважды на `sqlite3.connect(':memory:')` с минимальными tracks/albums и FK ON | exit0; все5 новых таблиц созданы, повтор SQL успешен, foreign_key_check пуст |
| Matrix ID coverage | exit0; ровно T01…T23 присутствуют |
| Markdown fence balance | exit0 для контракта/плана/прежнего контракта |
| `git diff --check -- docs/MULTI_ARTIST_CONTRACT.md docs/MULTI_ARTIST_ORCHESTRATION_PLAN.md docs/ARTISTS_SECTION_CONTRACT.md docs/MA_CONTRACT_REPORT.md` | exit0; новые контракт/отчёт проверены на trailing whitespace/conflict markers, исторический trailing space в ARTISTS_SECTION_CONTRACT сохранён как baseline |
| Implementation tests | Не запускались этим docs-only Task; implementation отсутствует, SQL smoke не является доказательством migration/data correctness |
| Production/snapshot | Не открывались и не изменялись; сведения о snapshot/числах переданы координатором |

Координатор сообщил baseline: backend438 +56 subtests, iOS567/43 suites, web75, bot29 targeted; это не результаты данного worker. Сохранённая координатором свежая read-only backup `/tmp/puuk-ma-baseline/library-snapshot.db`:1148 tracks/887 albums/integrity ok. Downstream storage обязан dry-run на **отдельной копии**, исходный snapshot не изменять.

Существующая dirty рабочая копия — baseline; не reset/clean/commit, файлы реализации не изменялись. Изменены только четыре назначенных docs. В ходе диагностики однажды был выведен слишком широкий набор ORCA environment fields; после указания координатора вывод окружения прекращён, в документы значения секретов не включались.

## Оставшиеся риски / следующий owner

Блокирующих продуктовых вопросов нет: MA-01…MA-12 сохранены, технические defaults названы. Координатор принял Gate0 freeze сообщением `msg_8c118da1e007` (2026-10-27 21:07:38 UTC); storage начинает schema/source/no-file-write, iOS-data — fixtures/arrays/events. Full migration rollback/failure/recovery tests, реальный snapshot dry-run и независимый review ещё впереди. Неоднозначные старые compound names не исправляются автоматически; report сначала классифицирует их, apply только explicit confirmed selection. Старые writers должны быть обновлены до rollout; простой code rollback без согласованного SQLite backup не защищает override. Большие источники/длинные имена, ограниченный legacy singleton stale edit и unbounded audit retention описаны в контракте. iOS device/VoiceOver smoke и субъективная оценка рекомендаций остаются непроверенными; deployment/production corrections этим Task не разрешены.
