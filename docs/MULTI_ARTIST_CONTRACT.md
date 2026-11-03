# Несколько артистов: контракт реализации v1

Gate 0, 2026-10-28. Frozen implementation contract для текущего Run; принятие координатором открывает реализацию, но не означает выполнение миграции или разрешение деплоя. Продуктовые решения MA-01…MA-12 из [плана](MULTI_ARTIST_ORCHESTRATION_PLAN.md#2-решения-владельца) обязательны и повторного опроса не требуют. Этот документ окончательно выбирает технические defaults из предложений плана. При противоречии технических предложений плана действует этот контракт; исторические D-1…D-13 из [первого контракта](ARTISTS_SECTION_CONTRACT.md) сохраняются, кроме явно заменённых ниже single-artist предположений.

## 1. Граница и обязательные результаты

Backend + бот/scan/recovery + iOS; веб UI вне Run (MA-01). У трека и альбома независимые ordered credits без ролей, display через `, ` (MA-02). Сохранять явно перечисленных участников, включая группу и её членов; состав группы не выводить (MA-04). Старую библиотеку исправлять отдельным preview/apply с точными правилами и списком неоднозначностей (MA-03/05), а не split при startup. Участников хранить только в Puuk; любые их правки сохраняются после rescan (MA-06). Title/feat. не извлекать и не изменять (MA-07). iOS 0/1/N → текст/профиль/меню (MA-08). Track membership и популярность у каждого участника (MA-09), album membership только по собственным credits (MA-10/11). Все recommendation пути учитывают множества IDs (MA-12).

Identity: NFKC → collapse Unicode whitespace → trim, без casefold. `id = 'art_' + sha256(normalized_name UTF-8).hexdigest()[:32]`. Пустое имя и normalized casefold `various artists` профиля не создают. `A` и `a` различны. Никаких aliases, ролей, parsing пунктуации, автоматического переноса artwork или новых release IDs.

Технические defaults v1: максимум 100 входных credit items, имя после нормализации 1…300 Unicode code points; удаление дублей по ID с сохранением первого места; пустой список допустим. Ввод HTTP с пустым/reserved именем — 422 (для очищения посылать `[]`); импорт/backfill такие значения отбрасывает. При импорте существующего имени длиннее 300 не обрезать: сохранить identity целиком и отметить предупреждение в data report; лимит 300 относится к созданию имени HTTP, а не чтению существующего ID. Импорт более 100 участников не обрезать молча: отметить invalid observation и сохранить прежнее состояние; для нового объекта — пустые credits и запись unresolved.

## 2. Фактическая база и границы замены

Проверены `brain/repositories/{schema,base,tracks,albums,artists}.py`, `brain/db.py`, `brain/serializers.py`, routers tracks/albums/search, services track_metadata/album/media_locations/library/recommendation/personalized_recommendation, metadata engine, scan, heavy worker, embedding queue, bot download/index/tag readers и iOS/web editors (полный перечень в [отчёте](MA_CONTRACT_REPORT.md)). Следующие факты влияют на реализацию:

- Последняя migration — 011. `schema.py::apply_migrations` выполняет SQL statements по одному и записывает version с commit. `init_db` затем вызывает legacy `backfill_album_identities()` отдельным соединением: этот повторный backfill убирается из unconditional startup и выполняется только при первом применении 008, до её checkpoint.
- Album identity уже case-insensitive `(title_normalized, album_artist_normalized)`; artist identity case-sensitive. Не смешивать эти нормализации.
- `add_or_update_track`, `update_track_metadata`, `update_track_metadata_from_audio` сейчас пишут raw artist. GET редактора читает файл и автоматически resync по stat; mutation journal recovery вызывает тот же resync. Ни один путь не может обходить domain ingest.
- `resolve_album`, scanner, recovery и бот иногда используют track artist как fallback album artist. Для существующих альбомов legacy album_artist сохраняется как source identity; для новых не выводить album credits из track artist.
- `serialize_track` сейчас вычисляет artist_id от raw строки; artist catalog/search/popularity также группируют raw строку. Эти места переходят на связи.
- `_ArtistResolver.key` сейчас предпочитает Qdrant, затем SQLite и filename; жанровая diversity использует отдельный одиночный ключ. Оба пути меняются.
- Веб Track editor всегда присылает artist, album_artist и остальные поля, даже при cover-only сохранении. Альбомный веб editor всегда присылает title/album_artist/year. Совместимость определена в §7 по этим реальным payload.

## 3. Замороженный SQL и migration 012

Владелец всей схемы — `ma-storage`. Файл `brain/migrations/012_artist_credits.sql`, плюс Python backfill `backfill_artist_credits(conn)` в новом `brain/repositories/artist_credits.py`. Не создавать отдельную migrations для bulk у другого владельца.

```sql
CREATE TABLE IF NOT EXISTS artists (
    id TEXT PRIMARY KEY,
    normalized_name TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS track_artists (
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    artist_id TEXT NOT NULL REFERENCES artists(id),
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (track_id, artist_id),
    UNIQUE (track_id, position)
);
CREATE INDEX IF NOT EXISTS idx_track_artists_artist
    ON track_artists(artist_id, track_id);
CREATE TABLE IF NOT EXISTS album_artists (
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    artist_id TEXT NOT NULL REFERENCES artists(id),
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (album_id, artist_id),
    UNIQUE (album_id, position)
);
CREATE INDEX IF NOT EXISTS idx_album_artists_artist
    ON album_artists(artist_id, album_id);
CREATE TABLE IF NOT EXISTS artist_credit_state (
    entity_type TEXT NOT NULL CHECK (entity_type IN ('track','album')),
    entity_id TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    manual_names_json TEXT,
    source_kind TEXT NOT NULL DEFAULT 'unknown',
    source_names_json TEXT NOT NULL DEFAULT '[]',
    observed_kind TEXT NOT NULL DEFAULT 'unknown',
    observed_names_json TEXT NOT NULL DEFAULT '[]',
    recovery_album_id INTEGER,
    PRIMARY KEY (entity_type, entity_id)
);
CREATE TABLE IF NOT EXISTS artist_credit_operations (
    id TEXT PRIMARY KEY,
    actor_user_id INTEGER NOT NULL,
    request_hash TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('preview','applied','undone')),
    result_json TEXT,
    undo_result_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    applied_at TEXT,
    undone_at TEXT
);
```

`artist_credit_state.entity_id` — всегда `str(track.id)` / decimal `str(album.id)` без leading zeros. Это durable source/override snapshot с намеренно отсутствующим entity FK: при аварийной потере строки и восстановлении того же ID ручной tombstone/list не теряется. Эффективный индексируемый состав — только таблицы связей; `manual_names_json` — recovery snapshot ручного решения, `NULL` = нет override, JSON `[]` = защищённое ручное очищение. JSON содержит массив нормализованных имён, не DTO и не IDs; invariant с links поддерживает один доменный writer. `source_names_json` — принятый импортный snapshot; `observed_*` — последнее валидное наблюдение, в том числе отклонённое более слабое. Ранг выводится из `source_kind`, отдельной дублирующей rank-колонки нет. `recovery_album_id` используется только для track; для album — NULL. Journal не имеет user/entity FK: аудит не исчезает при удалении пользователя/сущности. actor ID — исторический числовой ID, не доступ к удалённому аккаунту.

Порядок migration:

1. Завершить bootstrap схемы до 011; не обращаться к сети/файлам музыки. До upgrade сделать WAL-consistent backup, вне этого Task. Для fresh DB перенести legacy album data backfill внутрь первого применения 008 до её checkpoint: `backfill_album_identities(*, conn=None)` принимает supplied conn и тогда не commit/close; прежний вызов без conn сохраняет поведение. Для уже version11 не запускать backfill008 повторно. После version12 startup не выводит album attribution из треков и не удаляет empty albums автоматически.
2. В `apply_migrations` специально для version 12 открыть одну транзакцию (если bootstrap уже начал транзакцию, использовать её, не вложенный BEGIN). Выполнить SQL по statements через существующий cursor; `executescript` с неявным commit запрещён.
3. До `INSERT schema_migrations(version=12)` вызвать `backfill_artist_credits(conn)` на том же conn. Он не импортирует `db`/services и не открывает connection. На исключении rollback всей 012 и re-raise; не логировать успех и не продолжать startup. Версия 12 является единственным checkpoint schema+data.
4. Backfill каждой legacy tracks.artist и albums.album_artist — один буквальный участник после нормализации; пустые/Various → `[]`. Без объединения credits треков, без splitting. State revision=1, source_kind=`legacy`, manual=NULL. Реальные ненулевые составы и пустые legacy объекты одинаково получают state. Повторный прямой backfill заполняет только отсутствующий state; существующие links/state/override не пересоздаёт.
5. Для одной identity registry display name — минимальная по кодовым точкам исходная непустая строка с внешним trim; так сохраняется прежнее правило display. На backfill выбрать min по всей выборке. Позднее observed variant может уменьшить этот min; изменение display обновляет catalog version. IDs/normalized_name неизменны. HTTP новое имя сохраняется нормализованным. Существующие artist_artwork/play starts оставить без изменений/FK retrofit.
6. Bump catalog version один раз после успешного backfill, не на каждую строку. Проверить повторный init, rollback в середине, FK check. Старые album/track IDs, memberships, events, likes и artwork не изменяются.

Registry может содержать неактивных артистов; каталог — живые track links OR album links у альбомов с хотя бы одним треком. Артист только с album credit имеет track_count=0. Пустые альбомы не создают каталог. Artwork registry не удаляется при исчезновении живых credits.

## 4. Минимальный публичный доменный API

Все перечисленные имена — конкретный договор между workers. Дополнительные private helpers допустимы; новые facade/service layers без необходимости не нужны. `brain/repositories/artist_credits.py` владеет identity, разрешением selectors, SQL, source precedence и recovery. Старые `repositories.artists.normalize_artist_name/artist_id_for_name` остаются совместимыми импортами этих функций; circular import credits → artists запрещён.

```python
EntityType = Literal['track', 'album']
# CreditSelector = ArtistById | ArtistByName:
class ArtistById(TypedDict):
    id: str
class ArtistByName(TypedDict):
    name: str
class CreditState(TypedDict):
    artists: list[dict[str, str]]  # только id,name
    revision: int
    manual: bool
    source_kind: str
    source_names: list[str]

normalize_artist_name(value: Any) -> str
artist_id_for_name(value: Any) -> str | None
backfill_artist_credits(conn: sqlite3.Connection) -> None
get_credit_states(entity_type: EntityType, entity_ids: Sequence[str | int],
                  *, conn: sqlite3.Connection | None = None) -> dict[str, CreditState]
replace_artist_credits(conn: sqlite3.Connection, entity_type: EntityType,
                       entity_id: str | int, artists: Sequence[CreditSelector],
                       *, expected_revision: int) -> CreditState
# CreditSource(kind: SourceKind, names: Sequence[str]); immutable dataclass.
ingest_artist_credits(conn: sqlite3.Connection, entity_type: EntityType,
                      entity_id: str | int, source: CreditSource | None) -> CreditState
merge_album_credits(conn: sqlite3.Connection, source_album_id: int,
                    target_album_id: int) -> None
forget_artist_credits(conn: sqlite3.Connection, entity_type: EntityType,
                      entity_id: str | int) -> None
```

Writes требуют существующей сущности и внешней транзакции; не выполняют BEGIN/commit/bump самостоятельно. Каждый caller выполняет BEGIN IMMEDIATE → проверки → entity mutation + credits → один bump при публичном изменении → commit. Read conn=None открывает/закрывает своё read connection; supplied conn не закрывает. `get_credit_states` chunk=400 IDs (<=SQLite bind limits), empty input без SQL, missing keys отличны от существующего `artists=[]`; не фильтровать по наличию links. Все rows сериализуемой пачки обогащаются этим batch read; сериализатор не делает SQL.

Новая сущность при первом ingest, включая source=None, получает state revision=1 (unknown/[] без данных); если surviving state уже есть, сохраняет его revision и materializes links из manual/source snapshot. Storage exceptions экспортируются из artist_credits: `CreditNotFound(entity_type,entity_id)`, `CreditValidationError(code,message)`, `CreditConflict(current_state)`, `AlbumCreditsConflict(source_album_id,target_album_id)`; поля аргументов доступны одноимёнными attributes.

`replace_artist_credits` проверяет expected_revision **до** создания registry имён и смены links. Если expected stale, но canonical list совпадает с текущим manual override, вернуть текущее состояние как идемпотентный повтор; иначе `CreditConflict`. Тот же список при отсутствии override устанавливает override и повышает revision; повтор уже ручного списка — no-op. Revision увеличивается на 1 при изменении effective order/list, manual snapshot или принятого source kind/list; observed-only изменение revision не меняет. Bump catalog нужен при revision/display/link изменении, не при observed-only/no-op.

`get_credit_states` использует surviving state для восстановления links **только** внутри ingest после восстановления entity, никогда в read. Если track state содержит существующий recovery_album_id и source album identity не изменена, восстановить прежнее membership; manual display не участвует в resolve_album. Потеря самой SQLite/state не восстанавливается из старого Qdrant: нужен backup, не догадки.

Сохранять существующие signatures track repository, добавляя только keyword-only:

```python
add_or_update_track(..., *, artist_source: CreditSource | None = None)
update_track_metadata(..., *, artist_source: CreditSource | None = None)
update_track_metadata_from_audio(..., *, artist_source: CreditSource | None = None,
                                album_artist_source: CreditSource | None = None)
resolve_album(title, album_artist=None, year=None, cover_path=None,
              *, artist_source: CreditSource | None = None) -> int
```

Существующие позиционные аргументы остаются как в коде (выше `...` означает их полное сохранение). Каждый writer вызывает domain ingest на **своём** conn до commit, default source из своего raw artist = legacy; вызов с явным source не заменяется default. `update_track_metadata_from_audio` по умолчанию берёт новые metadata arrays из §5; иначе legacy. `album_artist_source` применяется к фактически связанному album_id, не ко всем альбомам с похожим названием. `resolve_album` получает source identity строкой `album_artist`; `artist_source` отдельно определяет credits. Existing track with unchanged source identity сохраняет album_id. Recovery membership snapshot обновлять при реальном явном rebind, не при artist edit.

`merge_album_credits`: preflight до любых файлов и rebind, затем повторная проверка под write lock. Разные manual lists → 409 `album_credits_conflict`, никаких файловых изменений. Один manual → сохранить его; два одинаковых → сохранить; без manual → более высокий source rank, при равном разном списке target wins. Target ID остаётся; source state удаляется; target revision повышается при semantic change. Partial legacy album tag update при создании нового альбома копирует album manual decision исходного в новую запись в одной DB-транзакции; не теряет override. Source albums остаются со своими credits до удаления. Empty cleanup и explicit delete вызывают forget; accidental row loss state сохраняет. forget удаляет state/links сущности, но не registry/artwork/journal.

Application API в `brain/services/artist_credit_service.py` (`ma-api`):

```python
set_track_artists(track_id: str, artists: Sequence[CreditSelector],
                  expected_revision: int, current_user: dict, base_url: str) -> dict
set_album_artists(album_id: int, artists: Sequence[CreditSelector],
                  expected_revision: int, current_user: dict, base_url: str) -> dict
```

Обе функции проверяют RBAC, вызывают storage транзакционно, возвращают полный публичный TrackDTO / Album detail envelope (§6), не вызывают recovery/file resolver/metadata reader/Qdrant. Track admin или added_by=user; added_by NULL → только admin. Album admin либо право на **каждый** входящий трек, проверенные в транзакции; пустой существующий album — admin (не vacuous uploader permission). Missing audio не препятствует. Не использовать file-backed get_track_metadata_details для ответа artist PUT.

## 5. Источники и empty semantics

Приоритет effective: manual snapshot > принятый source. SourceKind ранги фиксированы:

| kind | Ранг | Доказательство |
|---|---:|---|
| unknown | 0 | Нет данных |
| legacy | 10 | Одна цельная строка SQLite/filename/payload |
| qdrant | 20 | Structured names в payload, сопоставленном с track ID |
| tags | 30 | Все отдельные значения artist/album artist из файла |
| provider | 40 | Structured список конкретного сопоставленного результата Spotify/другого провайдера |

`None` = поле отсутствует/нет наблюдения: не очищать и не понижать. `CreditSource(kind, [])` = явно прочитанный пустой список, valid observation. Принять при rank >= текущего (равный rank latest wins); более низкий rank только обновляет observed snapshot. Nonempty legacy строка никогда не split; отсутствие/пустая scalar строка не является authoritative clear уже известного списка: передавать None, кроме initial backfill. Явный structured empty от tags/provider/qdrant может очистить source при достаточном rank. Manual `[]` защищён и от такого clear, и от непустого импорта. Импорт при manual обновляет accepted source/observed по тем же ranks, effective list не меняет. Эти defaults не реализуют UI reset-to-tags; такой endpoint в v1 отсутствует.

AudioMetadata и бот AudioTags добавляют `artists: list[str] | None`, `album_artists: list[str] | None`. Scalars сохраняются для прежних consumers/source identity. MP3: все `TPE1.text`/`TPE2.text`; FLAC/Vorbis/Opus: все повторные `artist`/`albumartist` значения; M4A: все `©ART`/`aART`. Отсутствующий ключ → None; существующий frame/key с пустыми values → []. Не делить один ID3v2.3 текст по `/`. Новое чтение/передача не вызывает save. Добавить .opus в scanner/recovery extension sets, где сейчас его нет.

Bot `_finalize_track/_build_tracks` передаёт names arrays + kind через `verified_metadata` и index_downloaded_tracks → repository. Provider track artists не являются album artists: использовать только отдельный album-level массив, legacy album_artist или None. `_match_song` title-only совпадение принимается для provider credits только при единственном подходящем результате; неоднозначный match не получает provider rank. Не брать первый результат/соседний файл. Existing tag scalar может остаться source identity, но не подавляет проверенный provider array.

New album без album-level attribution: source identity `album_artist=''`, credits `[]`; не fallback к track. Existing album legacy fallback, уже сохранённый в albums.album_artist, сохраняется как буквальный album credit до отдельного data correction; не менять/merge его автоматически. Изменение raw источника identity при реально новых тегах — существующий identity сценарий, не credits edit. При том же track ID сначала найти существующее membership и сравнить source identity; не вычислять album identity из нового display.

Qdrant additive payload: `artists:[{id,name}]`, `album_artists:[{id,name}]`; source adapters берут names, валидируют hash ID либо пересчитывают его. Missing arrays совместимы с literal legacy artist; явное [] не fallback. payload не является хранилищем override. Не делать обязательный Qdrant sync/re-embedding при credits edit; новые queue payload и heavy recovery используют единые правила, vectors не меняются. DB outage не считать missing entity: write fails, recommendation degraded read логируется отдельно.

## 6. DTO, маршруты и ошибки

`ArtistCreditDTO={id:string,name:string}`; order — индекс, role отсутствует. TrackDTO в **каждой** выдаче (catalog/search/album/playlists/favorites/history/wave/popular/editor) дополнительно содержит:

```json
{"artists":[{"id":"art_<hash A>","name":"A"},{"id":"art_<hash B>","name":"B"}],"artists_revision":3,"artist":"A, B","artist_id":null,"album_artists":[],"album_artists_revision":1,"album_artist":""}
```

Track album_artists относится к связанному album, не к raw tracks.album_artist; без связанного album — [], revision=0, album_artist="". AlbumDTO содержит `artists`, `artists_revision`, `artist_id`, `album_artist`, `artist`; оба текстовых поля показывают его собственный display. При [] album_artist="", album artist="Various Artists" (нынешний placeholder); track artist="". Single artist_id только при len=1, иначе null; никакого ID объединённого display. DB source строки в публичный DTO вместо display не подставлять. Revision целое >=1 для мигрированной существующей сущности; revision=0 только для отсутствующей связанной сущности/legacy missing DTO на клиенте, не для PUT к новой сущности.

`PUT /api/tracks/{track_id}/artists`: body `{"artists":[{"id":"art_…"},{"name":"New Artist"}],"expected_revision":3}`, ответ 200 **TrackDTO**.

`PUT /api/albums/{album_id}/artists`: такое же тело, ответ 200 **`{"album":AlbumDTO,"tracks":[TrackDTO,…]}`**. Album membership/identity не меняются. iOS wrapper возвращает envelope как есть. Эти операции не принимают title/cover/lyrics и не вызывают file stat, disk tags или normalizer gain reset.

Все новые тела `extra='forbid'`, expected_revision обязательный неотрицательный int (bool не int), artists обязательный array, null не разрешён; item имеет ровно id либо name. Existing ID может быть inactive registry artist; unknown ID →422 `unknown_artist`. GET /api/artists каталог — только live membership, поэтому исчезнувший профиль →404 как прежде. Для existing ID selector registry lookup не ограничивать live catalog.

Новые domain ошибки маппятся в стандартный FastAPI envelope:

```json
{"detail":{"code":"artists_revision_conflict","message":"Состав изменился. Обновите данные и повторите правку.","current_revision":4,"artists":[{"id":"art_…","name":"A"}]}}
```

`CreditNotFound` →404 `entity_not_found`; `CreditConflict` →409 `artists_revision_conflict`; `CreditValidationError` →422 `invalid_artists`/`unknown_artist`; album merge conflict →409 `album_credits_conflict`. 401/403 сохраняют auth envelope. Pydantic shape errors остаются обычным 422 detail array; клиентский error parser обрабатывает array/string/object.message. SQLite busy после текущего busy_timeout=5000ms →503 `credits_busy` + Retry-After:1; rollback, разрешён bounded retry максимум один тем же телом. Не повторять автоматически 409/422. Новые raw DB exceptions не раскрывают пути/SQL. Legacy tag errors/envelope вне новых ветвей сохраняются.

Catalog/search/counts/top-10 используют SQL links/EXISTS и DISTINCT. Альбомы B ищутся по album credits B, а не участию B в одном треке. Track_count = DISTINCT tracks with track credit; album_count = DISTINCT nonempty albums with album credit. Популярность current track credits × существующий COUNT(events per track), а не новые artist events. Sort остаётся play_count DESC,title NOCASE,id; all-time top10; play-start игнорируется при effective [] и сохраняет один event `(user,track,UTC day)`. Artwork правила/версии/auth прежние.

Batch enrichment: `hydrate_track_credits(rows, *, conn=None) -> list[dict]` в credits repository, новое возвращаемое значение, вход не мутировать; `hydrate_album_credits(rows, *, conn=None) -> list[dict]` там же. Track hydration загружает credits треков и их albums за bounded chunks и добавляет готовые DTO поля; сериализаторы лишь копируют их. Применять в repo collection functions (tracks/albums/interactions/playlists/wave consumers); single rows также hydrate once. Сериализаторы никогда не обращаются к SQLite и не создают singleton из raw строки после migration 012. Repositories `artists` получают сразу hydrated popular rows. Предотвратить map-miss ошибку в wave builder, если caller уже batch fetched missing rows: missing и not supplied различаются sentinel.

## 7. Legacy PATCH: реальная матрица

Текущий веб track payload: `{title,artist,album,album_artist,year,genre,track_number,disc_number,comment,lyrics,cover_action,cover_base64,cover_mime}`. Пустые album/album_artist/year/genre/number/comment →null; artist/title trim; lyrics строка; cover_action=keep и cover_base64/cover_mime=null обычны. Album payload: `{title,album_artist,year,cover_action,cover_base64}`. Старый iOS track отправляет `{title,artist,album,lyrics,cover_action,cover_url,cover_base64}`; album совпадает с веб. Это не partial artist-only payload по наличию ключей.

Preflight `ma-api` в track_metadata_service/album_service выполняется после auth/entity read, **до** recovery, file resolve/stat, cover URL fetch, journal и любых registry inserts. Canonical read для сравнения из DB; unchanged metadata fields сравнивать с прежним DTO базовой сущности: null/"" считаются эквивалентными для nullable полей, year int/string canonicalized, album сравнивается с связанным title; lyrics exact (null/"" empty), title trim, cover_action keep + null cover bytes/url/mime — no-op. Непредоставленные поля не являются изменениями. Для старого artist scalar сравнивать normalized полную строку, без split и без casefold, с текущим effective display **или текущей raw source scalar**. Это echo, даже если source scalar отличается от manual display.

| Вход / реальное изменение после фильтрации | До файловых действий | Результат |
|---|---|---|
| artist/album_artist отсутствуют | Ничего не менять в credits | Другие поля прежним путём |
| Artist echo display/source, даже у multi | Удалить из fields_set файлового patch | Title/cover/lyrics меняются, credits сохранены |
| Все присланные поля unchanged | Никакого файлового вызова | 200 актуальный прежний DTO/envelope, changed=false для album |
| У multi (len>1) artist изменён, включая stale display | 409 `structured_artists_required` | Ни одного side effect |
| У singleton/empty только artist реально изменён, прочие sent fields unchanged | DB replace literal singleton (null/""/reserved →[]) с server-read revision | 200, file/hash/stat неизменны |
| Singleton/empty artist изменён и title/cover/lyrics/прочие file fields действительно изменены | 409 `artists_edit_separately` | Всё отклонено до side effects |
| Track PATCH пытается изменить album_artist attribution | 409 `album_artists_edit_separately` | Использовать album artist PUT, не менять релиз через track |
| Album PATCH меняет singleton/empty album_artist, остальные echoed | DB album credit replace | Не менять raw album_artist, normalized identity или files |
| Album PATCH меняет multi album_artist либо смешивает его с изменением title/year/cover | 409 по двум правилам выше | Никакого merge/частичного успеха |
| PUT artists + другие ключи | 422 shape | Использовать отдельный metadata save |

Изменение `album` в Track PATCH остаётся явным membership edit старого редактора; unrelated album_artist echo удалить, resolve нового album source identity берёт актуальный raw источник, не display. Оно не меняет credits самого track. Поля album_track_position, меняемые старым metadata путём, также считаются изменениями для запрета mixed edits (даже если чисто DB); fallback v1 допускает только credits-only semantic operation. Оба legacy artist поля track классифицировать до любых эффектов: если один запрещён — отклонить весь запрос. Empty album legacy tag PATCH сохраняет прежний 400 для реальных file edits; credits PUT и credits-only legacy adapter admin работают без треков.

У legacy PATCH нет expected_revision: адаптер читает состояние и проверяет его снова под write lock; если изменилось за время preflight →409, не перезаписывает. Для stale singleton echo, не совпавшего ни с display, ни с source, невозможно отличить намерение от старого клиента; legacy credits-only считается явным literal edit. Это известный ограниченный компромисс; новые iOS участники всегда через PUT с revision. Mixed/no-op проверки выполняются до file API; новый iOS metadata PATCH вообще не посылает artist/album_artist.

## 8. Bulk: точные preview/apply/undo

Owner `ma-bulk`: новый `brain/services/artist_credit_bulk_service.py`, CLI `brain/reconcile_artist_credits.py`, tests. Router glue в existing `brain/routers/artists.py` — owner ma-api; schema/таблицу создаёт ma-storage. Все операции admin-only; non-admin403, anonymous401. До apply/undo права проверяются снова, idempotent result не обход auth.

```python
preview_artist_replacement(source_artist_id: str, scope: Literal['tracks','albums'],
                           artists: Sequence[CreditSelector], current_user: dict) -> dict
preview_artist_report(report: dict, proposal_ids: Sequence[str],
                      current_user: dict) -> dict
apply_artist_replacement(source_artist_id: str | None, operation_id: str,
                         current_user: dict) -> dict
undo_artist_replacement(source_artist_id: str | None, operation_id: str,
                        current_user: dict) -> dict
```

URI точно:

- `POST /api/artists/{artist_id}/credits/preview`, body `{"scope":"tracks","artists":[{"name":"A"},{"name":"B"}]}`.
- `POST /api/artists/{artist_id}/credits/apply`, body `{"operation_id":"<uuid>"}`.
- `POST /api/artists/{artist_id}/credits/undo`, body `{"operation_id":"<uuid>"}`.

Preview создаёт UUIDv4 operation_id на сервере и durable plan state=preview, ничего не меняет в registry/links/revisions/catalog/файлах. ID source должен существовать в registry, даже если уже исчез из каталога; не применять artist detail dependency к apply/undo. Scope ровно один; default отсутствует, оба scope в одном запросе запрещены. Все текущие live entities с точным source ID в выбранной таблице — selection; album scope включает также существующие пустые albums (catalog видимость отдельно). Max 5000 entities; больше →422 `bulk_scope_too_large`, preview ничего не применяет, автоматического дробления нет. Request selectors max100, результат после splice также <=100; overflow любой строки →422 с её entity ID, никакого truncate. Empty replacement [] означает удалить только source occurrence, не очистить остальных.

Preview envelope 200:

```json
{
  "operation_id":"<uuid>","state":"preview","source_artist_id":"art_…",
  "scope":"tracks","matched_count":1,"changed_count":1,
  "entries":[
    {"entity_type":"track","entity_id":"<uuid>","expected_revision":3,
     "before":[{"id":"art_X","name":"X"},{"id":"art_AB","name":"A&B"}],
     "after":[{"id":"art_X","name":"X"},{"id":"art_A","name":"A"},{"id":"art_B","name":"B"}]}
  ],
  "unresolved":[],"catalog_version":17
}
```

matched_count всегда равен len(entries). Entries сортируются по entity_id (albums численно), содержат **все** selected entities, в том числе unchanged, чтобы membership проверялась полностью. Stored plan дополнительно содержит canonical replacement selectors/names, before manual/source snapshot, source IDs и revisions, request_hash=SHA256 canonical JSON (sorted object keys, compact UTF-8, arrays ordered). New names в after имеют вычисленный stable ID; registry создаётся только apply. before/after names публичные, source private snapshots не публикуются. В preview нет file paths, tokens, user-private fields. Предпросмотр не истекает по таймеру: valid пока совпадают selection и revisions; revision guard лучше произвольного TTL. Audit rows не удаляются автоматически в v1.

Splice `[X,AB,C] → [X,A,B,C]`; убрать дубли **после** splice, сохранив первое место всей последовательности. Source в replacement разрешён; тождественный результат entries unchanged и не устанавливает override. No-match preview валиден: matched_count=0, apply возвращает no-op result. Никакой substring/пунктуационной замены. Artwork не переносится.

Apply под BEGIN IMMEDIATE читает stored plan, проверяет path source/scope/hash и **точное текущее membership множество**, затем revision каждого entry (включая unchanged). Добавленная/удалённая/переехавшая сущность с source ID →409 `bulk_selection_changed`; любое revision расхождение →409 `bulk_revision_conflict` с conflicts:[{entity_type,entity_id,current_revision}]. Проверка завершена до первых изменений. Apply для каждой changed entry вызывает domain replacement, устанавливает manual snapshot, сохраняет after_revision и before manual snapshot в журнал; один bump catalog на transaction. Сохраняет state=applied и result_json атомарно. Повтор applied/undone operation ID возвращает **сохранённый apply result**, не применяет снова; undo status можно получить повторным undo. Unknown operation404 `operation_not_found`, другой path source409 `operation_source_mismatch`. Journal идентифицирует именно весь план; клиент не может подменить selection в apply. Запрос с тем же ID и лишними selectors отвергается 422.

Apply envelope 200: `{"operation_id":"…","state":"applied","scope":"tracks","matched_count":N,"changed_count":M,"catalog_version":18,"affected":{"track_ids":[…],"album_ids":[…],"artist_ids":[…]}}`. affected tracks/albums содержат changed entities и связанные albums/tracks, чьи display DTO затронуты (для album edit — все tracks этого album); artist IDs — union before/after. Arrays dedup/sorted; лимит bulk entities5000 не обрезает affected. Result не содержит тысячи full TrackDTO. Клиент инвалидирует scope и batch reload активной/queued сущности.

Undo — atomic conditional operation: проверить, что каждая changed entity существует, current revision=stored after_revision и manual/effective list соответствует applied result; иначе409 `bulk_undo_conflict`, весь undo без изменений. Membership source ID после apply **не** проверять: source обычно исчез. Восстановить before manual snapshot (включая NULL/[]), before effective list; source snapshot не откатывать, поскольку accepted source change уже изменил бы revision и вызвал conflict. Сохранять latest observed_*; это не effective decision. Повысить revision снова (никогда не уменьшать до before), один catalog bump, state=undone, undo_result_json. Envelope той же формы, state=undone; repeat возвращает сохранённый undo result. Undo preview-only409 `operation_not_applied`. Повтор failed apply/undo допускается тем же ID после reload/re-preview где нужно; 409 автоматически не retry.

CLI defaults: `python reconcile_artist_credits.py report --json PATH` читает БД read-only (`mode=ro`), пишет только report файл; без subcommand также report в stdout. Выделить candidates по пунктуации, не менять credits. JSON version=1, proposals с evidence/reason, before/after/source, entity/revision и ambiguity (`confirmed`/`ambiguous`), unresolved отдельно. Без проверенного правила все пунктуационные предложения ambiguous; встроенного auto-allowlist для TV Girl нет. `preview --report PATH --select <comma-separated proposal IDs> --actor-user-id ID` создаёт durable plan только для confirmed proposals с проверенным scope/revisions; `apply --operation-id UUID --actor-user-id ID`, `undo ...` используют тот же journal/atomic guards. Report v1: `{version:1,proposals:[{id,entity_type,entity_id,expected_revision,before,after,source_kind,source_names,reason,evidence,ambiguity}],unresolved:[]}`; before/after — ordered CreditDTO arrays, evidence — строка с проверяемым происхождением решения. `preview_artist_report` валидирует IDs/hashes/revisions и создаёт один journal plan всех выбранных proposals, без substring rules и без динамического расширения selection. Изменение состава вне выбранных report entities не делает report stale, изменение revision/удаление выбранной — conflict. Report apply/undo атомарны на всю selection с теми же snapshot/override правилами. CLI direct-plan entries могут охватывать несколько sources; `scope` для report envelope=`report`, `source_artist_id=null`; selection ожидается из явных entries. Generic apply/undo вызывается с source_artist_id=None только CLI; URI требует соответствующий source ID и plan kind=replacement, иначе409 `operation_source_mismatch`. Для CLI source ID sentinel не вводить: typed plan kind=`replacement` или `report`; URI apply/undo принимает только replacement plans. CLI actor должен существовать и иметь admin role; local shell не обходит RBAC. Report selection с ambiguous →422/exit2; stale plan →exit3; success0; infrastructure1. Не запускать writes на production в этом Run до review/dry-run и отдельного release scope.

## 9. Рекомендации: конкретные подписи и defaults

`ma-recommendations` использует batch get_credit_states, не raw artist map. `_ArtistResolver` private interface заморожен для wave_tuning:

```python
_ArtistResolver.prefetch(track_ids: Sequence[str]) -> None
_ArtistResolver.keys(payload: dict, track_id: str) -> frozenset[str]
# repositories/wave.py, новый public API:
get_recent_artist_counts(user_id: int, limit: int = 5) -> dict[str, int]
# apply_diversity_penalty сохраняет остальные args, recent_artists становится counts:
apply_diversity_penalty(scored_points: list, recent_artists: dict[str, int],
                        penalty: float = 0.05, resolver=None) -> list
```

prefetch один раз на bounded chunks candidate IDs, затем keys только cache; existing SQLite key=[] — authoritative empty, не payload fallback. Missing SQLite → payload artists array (including explicit[]) → whole legacy artist → прежний filename fallback. IDs из payload принимаются только вместе с name, совпадающим с hash; иначе нормализовать name; unknown/reserved → empty. DB error отличен от missing: одна диагностика на request, ограниченная payload-only деградация, никогда write/recovery в resolver. Не делать SQL N+1 через keys.

Recent window = последние **5 событий треков**, UNION ALL user_history + user_wave_feedback как сейчас, сортировка ts DESC с tie-break track_id ASC, затем source discriminator (history before feedback), затем rowid DESC. Повтор track ID в двух событиях считается двумя прослушиваниями; это не play-start дедуп и схему истории не менять. Собрать **всех** unique участников каждого события, увеличить частоту каждого на1, не обрезать список имён. Unknown track → no IDs. Legacy get_recent_artists остаётся для совместимости внешних callers, новый путь его не использует.

Строгий проход: skip при cap любого участника; selected track расходует по1 на каждый уникальный ID. Existing MAX_TRACKS_PER_ARTIST=2 и прочие genre album caps/score weights сохраняются. Recent penalty = `0.05 * max(count[id] for id in candidate_ids, default=0)` один раз, не сумма. Unknown candidates и мягкий refill как сейчас, но dedup по track ID во всех проходах, не Python object identity. Album caps используют существующую identity, не новых гостей. Personalized artist breadth считает union IDs; tie-break display использует server effective display. wave_tuning и метрики — cardinality union IDs, включая fallback выдачу. При Qdrant outage credits PUT/bulk продолжают работать, без re-embedding. Субъективное качество музыки не объявлять доказанным unit tests.

## 10. iOS: data/events и interaction contract

`ma-ios-data` добавляет `shared/api/artistCredits.js`: `setTrackArtists(id,artists,expectedRevision)`, `setAlbumArtists(...)`, `previewArtistReplacement(id,scope,artists)`, `applyArtistReplacement(id,operationId)`, `undoArtistReplacement(...)`; return exact JSON §6/8, reject с code/message/current revision; AbortSignal поддерживается последним optional options. New retries только один при network/503 с тем же operation ID/body. Failed PUT не испускает success/event.

`normalizeTrack` сохраняет arrays/revisions. Present [] authoritative; absent artists fallback singleton только если валидны оба legacy artist_id и name. Не вычислять ID, не split строки на клиенте. То же для album DTO отдельным normalizer в новом `shared/domain/artistCredits.js`, включая helper для selection. Каталог search для editor использует existing GET /api/artists?q, новые имена не регистрируются до save.

Новый `shared/domain/artistCreditEvents.js` — owner **ma-ios-data**, экспортирует `ARTIST_CREDITS_UPDATED='PUUK_ARTIST_CREDITS_UPDATED'`, `emitArtistCreditsUpdated(payload)`, `subscribeArtistCreditsUpdated(listener)`. Payload single track: `{scope:'track',track:<server TrackDTO>,catalogVersion:null}`; single album: `{scope:'album',album:<server AlbumDTO>,tracks:<server TrackDTO[]>,catalogVersion:null}`; bulk: `{scope:'bulk',operationId,affected:<server affected>,catalogVersion:<server int>}`. Никакого inferred local artist payload. Existing PUUK_TRACK_UPDATED сохраняется с полным server DTO для track saves, PUUK_ALBUM_UPDATED сохраняет `{previousAlbumId,album}`; новый event дополняет их для связанной invalidation. Не испускать тысячи events для bulk. Consumers обязаны выдержать повторное событие без сброса playback.

Data worker реализует invalidation в apiCache (tracks/albums/artist/search/favorites/history/playlists/wave), сохраняя per-user/server isolation и request epochs; invalidate artist reads также в shared/api/artists.js. App/player wiring, patch queue/current metadata без unload/play/seek, reload affected queued DTO и сохранение last track — integration owner; data worker может предоставить helper, но не редактировать App/controller. Bulk event приводит к batch refetch relevant current/queue IDs и к lazy invalidation остальных; backend existing GET страницы/деталей достаточно, новый bulk read endpoint не обязателен. `settings.js` сохраняет нормализованные credits/revisions с тем же storage key.

Navigation: existing FullPlayerModal и album header при 0 profiles обычный текст, при1 прямой Artist(ID), приN общий selector + Cancel. Selector хранит target identity/revision; при смене current track/album или credits revision закрывается и не открывает stale artist. При выборе playback/queue/position не меняются. Обычные track row artists не получают новой ссылки. Existing menu mechanism, без новой библиотеки; implementation workers читают puuk-ui/ios guide прежде visual code.

Editors: actual `features/library/TrackEditScreen.js`, `features/albums/AlbumEditScreen.js`; общий новый `shared/components/ArtistCreditsEditor.js`. Отдельное DB-only save в editor sheet; add existing/new, remove, reorder кнопками, save/cancel. При 409 сохранять draft и показать актуальный состав; после reload пользователь сознательно повторяет изменение с новой revision. Parent title/lyrics/cover draft не гидрировать заново при credits save. Metadata PATCH не включает artist/album_artist. Нельзя показывать «все изменения записаны в теги» для credits. Album/artist/search экраны refresh через data event, back с исчезнувшего artist после bulk ведёт к предыдущему экрану с понятным результатом, не бесконечный retry404. Доступность/large text/long lists/Cancel focus/manual smoke обязательны перед G3/G4; mock Jest не заменяет device check.

## 11. Владение файлами и интеграция

Один активный writer на файл. Ни один downstream worker не получает общий composition root по умолчанию. При необходимости изменения чужого файла отправить patch/request его owner либо дождаться settlement и явного transfer. Следующая карта заменяет предложенные пересекающиеся ownership строки §10.2 плана.

| Task | Единоличный allowlist / ответственность |
|---|---|
| ma-contract | Этот контракт, MULTI_ARTIST_ORCHESTRATION_PLAN.md, ARTISTS_SECTION_CONTRACT.md, MA_CONTRACT_REPORT.md |
| ma-storage | `brain/migrations/012_artist_credits.sql`, `brain/repositories/{schema,artist_credits,tracks,albums,base}.py`; tests `brain/test_multi_artist_storage.py`. Включает search_all SQL, bounded hydration контракт и схемы bulk. `db.py` не его файл. |
| ma-api | `brain/services/{artist_credit_service,track_metadata_service,album_service}.py`, `brain/repositories/artists.py`, `brain/routers/{tracks,albums,artists,search}.py`, `brain/serializers.py`; `brain/test_multi_artist_api.py`, `brain/test_multi_artist_legacy.py`. Search SQL запросы в tracks.py передать storage. |
| ma-import | `brain/metadata.py`, `brain/scan.py`, `brain/services/{library_service,media_locations,embedding_queue_service}.py`, `brain/heavy_worker.py`, `tg_music_bot/{audio_tags,downloader,bot}.py`; `brain/test_multi_artist_import.py`, `tg_music_bot/test_multi_artist_import.py`. Не редактирует metadata service: hooks через ma-api. |
| ma-recommendations | `brain/services/{recommendation_service,personalized_recommendation_service}.py`, `brain/repositories/wave.py`, `brain/wave_tuning.py`; `brain/test_multi_artist_recommendations.py`. API wave routers через integration. |
| ma-bulk | `brain/services/artist_credit_bulk_service.py`, `brain/reconcile_artist_credits.py`, `brain/test_multi_artist_bulk.py`. Router glue от ma-api; schema от storage. |
| ma-ios-data | `shared/api/{artistCredits,artists,apiCache,api}.js`, `shared/domain/{artistCredits,artistCreditEvents,trackAdapter}.js`, `shared/storage/settings.js` и colocated tests. Все пути относительно `app/ios/puuk-ios/`. Events module shared ownership не выдавать editors/navigation. |
| ma-ios-navigation | `components/FullPlayerModal.js`, `features/albums/AlbumScreen.js`, новый `shared/components/ArtistSelector.js` и их tests. App/RootNavigator props/route wiring передать integration. |
| ma-ios-editors | `features/library/TrackEditScreen.js`, `features/albums/AlbumEditScreen.js`, новый `shared/components/ArtistCreditsEditor.js` и их tests. Events/API только импортировать. |
| ma-ios-bulk | `features/artists/ArtistScreen.js`, новый `features/artists/ArtistCreditBulkScreen.js` и tests. Навигационный registration передать integration. |
| ma-integration (координатор назначает worker) | **Composition roots:** `brain/api.py`, `brain/db.py`, `app/ios/puuk-ios/App.js`, `navigation/RootNavigator.js`, `hooks/usePlayerController.js` и их tests. Cross-cut read collection consumers `brain/repositories/{interactions,playlists}.py`, `brain/routers/{wave,wave_recommendations,personalized_recommendations,playlists,user_content}.py` (это фактически существующие routers). `features/search/SearchScreen.js` event integration/tests. Docs run report/acceptance после ma-contract settlement. |
| ma-review | Read-only, T01…T23 evidence audit, без исправлений в чужом файле |

Storage до API/import/recommendations/bulk; iOS-data может работать по frozen DTO fixtures параллельно storage. После storage settlement все четыре backend domains непересекаются; API и bulk договариваются только через подписи выше. iOS-navigation/editors/bulk после data settlement, затем integration в roots. Изменения существующих baseline tests вне allowlist — только integration после передачи, не параллельно. Файлы web только read/test, не модифицировать. Реальные routers перед integration перечислены в отчёте.

## 12. Матрица T01…T23 и gates

| ID | Owner / проверяемое наблюдение |
|---|---|
| T01 | storage: v11→12 и empty DB, повтор init/backfill, mid-backfill failure rollback включая checkpoint; track/album IDs/raw identity/artwork/events сохранены, no split |
| T02 | storage/API: NFKC/NBSP/case/dedup/order; []/None/reserved; create-name limits vs existing IDs; literal AC/DC/Earth, Wind & Fire |
| T03 | API/integration: A+B во всех DTO surfaces включая wave, playlists/history/editor; same arrays/revisions/display, artist_id=null |
| T04 | storage/API: search B, catalog/detail/counts DISTINCT, нет фантома A,B и Cartesian duplicates |
| T05 | API: album A + track A+B не даёт album B; album A+B появляется у обоих с полным track_count |
| T06 | API: album-only artist track_count0, working detail; empty album не создаёт каталог |
| T07 | API: PUT/legacy credits-only с отсутствующим файлом; disk readers/writers/stat/resolver не вызваны, hash/stat fixtures прежние |
| T08 | import/API: manual list/[] выдерживает scan, editor GET, resync, journal recovery, re-download и missing-row recovery surviving state; same album ID |
| T09 | import/storage: provider→tags→legacy не схлопывает; None не clear; explicit structured[] clear по rank; observed/accepted различимы |
| T10 | API/web compatibility: реальные полные web track+album payload, artist echo + changed title/cover; artist поля исключены file patch, credits прежние |
| T11 | API: stale/mutated multi string, changed singleton+changed tags и changed track album_artist дают точные409 до cover fetch/file/journal/DB side effect |
| T12 | storage/API: concurrent expected revision, retry/no-op/manual pin same list; 503 busy rollback, нет lost updates |
| T13 | bulk: splice/dedup/[]/source retained/no-match, >100 result, >5000 scope, stale membership/revision, restart/repeat apply/undo, поздняя правка →atomic409 |
| T14 | API/bulk: admin/uploader/foreign/system/no-auth; album all-track permission и empty admin; preview/apply/undo/CLI admin |
| T15 | API: popularity/events A+B, смена credits и repeated play-start; один existing event, rank current participants, no double count |
| T16 | recommendations/import: stale Qdrant + current SQLite [], Qdrant down, DB error diagnostic отличен от missing; edits без embedding |
| T17 | recommendations: fixed A,B,A+B,A+C,D pool caps всех IDs, penalty max не sum, 5-event history window; all-A fallback полный без duplicate IDs |
| T18 | storage/integration: 10k tracks/1000 artists, chunks400, limit0, bounded SQL count и payload размер измерены; никаких SQL в serializer/per candidate |
| T19 | API/iOS: catalog version/ETag при effective/revision changes, no-op не bump; invalidate caches/queue/last track; unchanged cover/loudness fingerprint |
| T20 | iOS navigation: 0/1/N, Cancel, select, target change, long names/VoiceOver; queue/current/position unchanged |
| T21 | iOS editors/data: separate credits save, server DTO event, no metadata artist field, parent draft сохранён, 409/error без ложного success |
| T22 | storage/API: preflight conflicting manual album merge до file write, identical/manual-vs-source merge, partial split copies override, explicit delete/empty cleanup/state/FK |
| T23 | import: MP3v2.3/v2.4/FLAC/M4A/OGG/Opus multiple literal values, missing vs empty, bot matching и provider arrays; исходные bytes/hash/stat прежние |

No-file-write evidence включает временные реальные audio fixtures с SHA256, size, mtime_ns до/после participant PUT, backfill, bulk apply/undo, GET после participant edit. GET может читать файл, но возвращает DB display, не перезаписывает credit decision. T08 проверяет также независимость album manual и track manual.

Целевые новые suites → full backend pytest с `PUUK_DB_PATH` (импорт `test_db_path` первым), bot tests, iOS Jest+lint+Expo export, web tests+build как unchanged-client compatibility. Не запускать непроверенные скрипты над live DB. Все фактические outputs/exit codes в run report, baseline failures отдельно. Gate0=this contract+ownership, G1=storage/import/no-file-write, G2=API/bulk/recommendations+legacy matrix, G3=iOS+cache/manual smoke, G4=independent review+fresh-snapshot migration dry-run+backup/rollback, G5=только отдельно разрешённый release. Этот Task закрывает только подготовку G0.

## 13. Остаточные риски и эксплуатация

Числа исторического исследования плана не считать текущим production census. Координатор сообщил новый read-only backup `/tmp/puuk-ma-baseline/library-snapshot.db` (1148 tracks/887 albums, integrity ok); storage dry-run делает **отдельную копию**, исходник не менять. Этот Task не читал production/данные и не запускал migration на snapshot. Startup 012 не исправляет смысловые compound names; unresolved остаются видимыми до exact correction.

Миграция и deployment требуют остановки старых writers backend/бот/local heavy_worker: старые binaries игнорируют override. Qdrant stale допустим, старый SQLite writer — нет. File paths/track UUIDs не менять, participants в audio не записывать. Rollback data correction = conditional undo; code rollback на старые binaries без согласованной DB backup небезопасен. Retention audit не ограничен автоматически в v1, размер измерять и будущую archival policy вводить отдельно. Long source names/неоднозначные теги/устаревший singleton PATCH — известные явно описанные ограничения; device smoke и субъективная оценка diversity требуют фактической проверки следующими owners, не нового обсуждения MA решений.
