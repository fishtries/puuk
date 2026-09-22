"""Персональные жанровые подборки «You'll like this».

Аффинность к жанрам строится из позитивной истории и избранного пользователя.
Подборки — треки SQLite-каталога с опциональным Qdrant-ранжированием по вектору
вкуса; при недоступности Qdrant — детерминированный SQLite-порядок.
Исключения и diversity повторяют механики «Моей Волны», но без random.
"""
from collections import Counter
from typing import Optional, TypedDict

from qdrant_client.models import Filter, FieldCondition, MatchValue

import db
from config import COLLECTION_NAME
from services.genre_normalization import extract_genres, normalize_genre
from services.recommendation_service import build_wave_track_payload, client
from user_profile import get_or_compute_user_embedding

# --- Аффинность к жанрам ---
# Лайк суммарно весит 3.0 за трек (прослушивание 1.0 + бонус 2.0).
FAVORITE_TOTAL_WEIGHT = 3.0
# Не более трёх зачётов прослушиваний одного трека.
MAX_HISTORY_EVENTS_PER_TRACK = 3
# Доля жанрового score и бонуса широты артистов в финальном весе жанра.
GENRE_SCORE_WEIGHT = 0.85
ARTIST_BREADTH_WEIGHT = 0.15
ARTIST_BREADTH_TARGET_ARTISTS = 5

# --- Ранжирование Qdrant-пути ---
FAVORITE_BONUS = 0.15
RECENT_POSITIVE_BONUS = 0.05
ARTIST_REPEAT_PENALTY = 0.05
RECENT_REPEAT_PENALTY = 0.10
# Сколько свежих записей позитивной истории считаются «недавно проигранными».
RECENT_HISTORY_WINDOW = 10
# Размер пула кандидатов из Qdrant.
QDRANT_QUERY_LIMIT = 100

# --- Diversity ---
MAX_TRACKS_PER_ARTIST = 2
MAX_TRACKS_PER_ALBUM = 3

# Минимальный размер секции: меньше — секция не публикуется.
MIN_SECTION_TRACKS = 5


class GenreAffinity(TypedDict):
    genre: str
    score: float
    track_count: int
    artist_count: int


def _artist_key(value) -> Optional[str]:
    """Нормализованный ключ артиста/альбома для сравнения без регистра."""
    if not value:
        return None
    key = " ".join(str(value).casefold().split())
    return key or None


def _positive_track_weights(user_id: int) -> dict[str, float]:
    """Вес каждого позитивного трека: история (до 3 событий) + лайк (итого 3.0).

    Дизлайки исключаются и позитивный профиль не формируют.
    """
    dislike_ids = db.get_user_dislike_ids(user_id)
    history_counts: Counter = Counter()
    for track_id in db.get_user_listening_history(user_id):
        track_id = str(track_id)
        if track_id in dislike_ids:
            continue
        history_counts[track_id] += 1

    weights: dict[str, float] = {}
    for track_id, count in history_counts.items():
        weights[track_id] = float(min(count, MAX_HISTORY_EVENTS_PER_TRACK))

    favorite_ids = db.get_favorite_track_ids(user_id) - dislike_ids
    for track_id in favorite_ids:
        weights[track_id] = FAVORITE_TOTAL_WEIGHT
    return weights


def get_user_genre_affinity(user_id: int) -> list[GenreAffinity]:
    """Аффинность пользователя к жанрам, отсортированная по финальному score desc."""
    weights = _positive_track_weights(user_id)
    if not weights:
        return []

    total_weight = sum(weights.values())
    if total_weight <= 0:
        return []

    genre_weight: dict[str, float] = {}
    genre_track_count: dict[str, int] = {}
    genre_artists: dict[str, set[str]] = {}

    for track_id, weight in weights.items():
        track = db.get_track(track_id)
        if not track:
            continue
        genres = extract_genres(track.get("genre"))
        if not genres:
            continue
        artist_key = _artist_key(track.get("artist"))
        # Мультижанровый трек делит вклад поровну между своими жанрами:
        # суммарный вклад трека в профиль равен весу трека.
        weight_per_genre = weight / len(genres)
        for genre in genres:
            genre_weight[genre] = genre_weight.get(genre, 0.0) + weight_per_genre
            genre_track_count[genre] = genre_track_count.get(genre, 0) + 1
            if artist_key:
                genre_artists.setdefault(genre, set()).add(artist_key)

    affinity: list[GenreAffinity] = []
    for genre, weight in genre_weight.items():
        genre_score = weight / total_weight
        unique_artists = len(genre_artists.get(genre, set()))
        breadth_bonus = min(unique_artists / ARTIST_BREADTH_TARGET_ARTISTS, 1.0) * ARTIST_BREADTH_WEIGHT
        affinity.append(
            GenreAffinity(
                genre=genre,
                score=genre_score * GENRE_SCORE_WEIGHT + breadth_bonus * ARTIST_BREADTH_WEIGHT,
                track_count=genre_track_count[genre],
                artist_count=unique_artists,
            )
        )

    affinity.sort(key=lambda item: (-item["score"], item["genre"]))
    return affinity


def _track_in_genre(track: dict, target_key: str) -> bool:
    """Guard жанра: трек обязан нормализоваться в жанр секции."""
    genres = [normalize_genre(g) for g in extract_genres(track.get("genre"))]
    return any(g and g.casefold() == target_key for g in genres)


def _genre_candidates(target_key: str, dislike_ids: set[str], exclude_ids: set[str]) -> list[dict]:
    """SQLite-треки, чьи нормализованные жанры содержат целевой, без исключённых."""
    candidates: list[dict] = []
    seen: set[str] = set()
    for track in db.get_all_tracks():
        track_id = str(track["id"])
        if track_id in seen or track_id in dislike_ids or track_id in exclude_ids:
            continue
        if not _track_in_genre(track, target_key):
            continue
        seen.add(track_id)
        candidates.append(track)
    return candidates


def _track_order_key(track: dict) -> tuple:
    """Детерминированный порядок трека: artist, album, title, id (без random)."""
    return (
        _artist_key(track.get("artist")) or "",
        _artist_key(track.get("album")) or "",
        " ".join(str(track.get("title") or "").casefold().split()),
        str(track["id"]),
    )


def _sqlite_rank_key(tier: int, track: dict) -> tuple:
    """Детерминированный ключ SQLite-порядка: уровень интереса, затем artist/album/title."""
    return (tier, *_track_order_key(track))


def _ordered_sqlite_candidates(
    candidates: list[dict], favorite_ids: set[str], positive_ids: set[str]
) -> list[dict]:
    """Избранные жанра -> качественно прослушанные -> остальные; стабильная сортировка."""

    def tier(track: dict) -> int:
        track_id = str(track["id"])
        if track_id in favorite_ids:
            return 0
        if track_id in positive_ids:
            return 1
        return 2

    return sorted(candidates, key=lambda t: _sqlite_rank_key(tier(t), t))


def _apply_diversity(ordered: list[dict], limit: int) -> list[dict]:
    """Первый проход — лимиты на артиста/альбом; второй добирает, если альтернатив нет."""
    if limit <= 0:
        return []

    selected: list[dict] = []
    chosen: set[str] = set()
    artist_counts: Counter = Counter()
    album_counts: Counter = Counter()

    for track in ordered:
        if len(selected) >= limit:
            break
        track_id = str(track["id"])
        if track_id in chosen:
            continue
        artist_key = _artist_key(track.get("artist"))
        if artist_key and artist_counts[artist_key] >= MAX_TRACKS_PER_ARTIST:
            continue
        album_key = _artist_key(track.get("album"))
        if album_key and album_counts[album_key] >= MAX_TRACKS_PER_ALBUM:
            continue
        selected.append(track)
        chosen.add(track_id)
        if artist_key:
            artist_counts[artist_key] += 1
        if album_key:
            album_counts[album_key] += 1

    if len(selected) < limit:
        for track in ordered:
            if len(selected) >= limit:
                break
            track_id = str(track["id"])
            if track_id not in chosen:
                selected.append(track)
                chosen.add(track_id)

    return selected


def _query_genre_points(user_vec) -> list:
    """Qdrant-пул кандидатов по вектору вкуса; при сбое — пустой список."""
    try:
        ready_filter = Filter(
            must=[FieldCondition(key="needs_embedding", match=MatchValue(value=False))]
        )
        results = client.query_points(
            collection_name=COLLECTION_NAME,
            query=user_vec.tolist(),
            query_filter=ready_filter,
            limit=QDRANT_QUERY_LIMIT,
            with_payload=True,
        )
        return list(results.points)
    except Exception as e:
        print(f"[GenreRec] Warning querying Qdrant: {e}")
        return []


def _local_score(track_id: str, favorite_ids: set[str], positive_ids: set[str]) -> float:
    """Честный детерминированный локальный рейтинг из favorite/history бонусов.

    Без Qdrant-score поле score отражает только уровень интереса:
    лайк > качественное прослушивание > остальное. Порядок внутри
    одного уровня задаёт сортировка (artist, album, title, id).
    """
    if track_id in favorite_ids:
        return FAVORITE_BONUS
    if track_id in positive_ids:
        return RECENT_POSITIVE_BONUS
    return 0.0


def generate_genre_playlist(
    user_id: int,
    genre: str,
    limit: int = 20,
    exclude_ids: Optional[set[str]] = None,
    base_url: str = "",
) -> list[dict]:
    """Персональная пачка треков одного жанра.

    При наличии вектора вкуса кандидаты ранжируются через Qdrant с бонусами
    и штрафами; иначе (или при сбое) — детерминированный SQLite-порядок.
    Дозаполнение до limit всегда идёт из SQLite-порядка.
    Недавно прослушанные убираются, только если после исключения хватает
    альтернатив (>= MIN_SECTION_TRACKS), иначе возвращаются в пачку.
    """
    target = normalize_genre(genre)
    if limit <= 0 or not target:
        return []
    target_key = target.casefold()

    dislike_ids = db.get_user_dislike_ids(user_id)
    exclude = set(exclude_ids or set())
    favorite_ids = db.get_favorite_track_ids(user_id)
    positive_history = [str(t) for t in db.get_user_listening_history(user_id)]
    positive_ids = set(positive_history)
    fresh_ids = set(positive_history[:RECENT_HISTORY_WINDOW])
    recent_artist_keys = {
        _artist_key(a) for a in db.get_recent_artists(user_id, limit=5)
    } - {None}

    candidates = _genre_candidates(target_key, dislike_ids, exclude)
    # Guard жанра: последняя линия защиты от треков с чужим/пустым genre.
    candidates = [t for t in candidates if _track_in_genre(t, target_key)]
    if not candidates:
        return []
    candidate_by_id = {str(t["id"]): t for t in candidates}

    # Свежие прослушивания исключаются, если без них хватает альтернатив.
    non_fresh = [t for t in candidates if str(t["id"]) not in fresh_ids]
    if len(non_fresh) >= MIN_SECTION_TRACKS:
        candidates = non_fresh
        candidate_by_id = {str(t["id"]): t for t in candidates}

    user_vec = None
    try:
        user_vec = get_or_compute_user_embedding(user_id, client)
    except Exception as e:
        print(f"[GenreRec] Warning computing user embedding: {e}")

    ranked: list[tuple[dict, float]] = []
    points_by_id: dict[str, object] = {}
    if user_vec is not None:
        for point in _query_genre_points(user_vec):
            track = candidate_by_id.get(str(point.id))
            if track is None:
                continue
            track_id = str(point.id)
            score = float(point.score)
            if track_id in favorite_ids:
                score += FAVORITE_BONUS
            if track_id in positive_ids:
                score += RECENT_POSITIVE_BONUS
            artist_key = _artist_key(track.get("artist"))
            if artist_key and artist_key in recent_artist_keys:
                score -= ARTIST_REPEAT_PENALTY
            if track_id in fresh_ids:
                score -= RECENT_REPEAT_PENALTY
            ranked.append((track, score))
            points_by_id[track_id] = point
        # При равном score — детерминированный tie-break, никакого random.
        ranked.sort(key=lambda item: (-item[1], *_track_order_key(item[0])))

    ranked_scores = {str(t["id"]): score for t, score in ranked}
    ranked_ids = set(ranked_scores)
    fallback_order = [
        t for t in _ordered_sqlite_candidates(candidates, favorite_ids, positive_ids)
        if str(t["id"]) not in ranked_ids
    ]
    combined = [t for t, _ in ranked] + fallback_order
    selected = _apply_diversity(combined, limit)

    payloads: list[dict] = []
    for track in selected:
        track_id = str(track["id"])
        if track_id in ranked_scores:
            point = points_by_id[track_id]
            point.score = ranked_scores[track_id]
            payloads.append(build_wave_track_payload(point, base_url, favorite_ids))
            continue
        payloads.append(
            {
                "id": track_id,
                "track_id": track_id,
                "title": track.get("title"),
                "artist": track.get("artist"),
                "duration": track.get("duration"),
                "file_path": track.get("file_path"),
                "stream_url": f"{base_url}/api/stream/{track_id}",
                "coverArt": f"{base_url}/api/cover/{track_id}",
                "cover_color": track.get("cover_color"),
                "is_liked": track_id in favorite_ids,
                "score": _local_score(track_id, favorite_ids, positive_ids),
            }
        )
    return payloads


def get_personalized_genre_sections(
    user_id: int,
    section_limit: int = 3,
    track_limit: int = 20,
    base_url: str = "",
) -> list[dict]:
    """Секции «{Genre} for you» по топ-жанрам пользователя.

    Сначала жанры фильтруются по достаточности кандидатов (>= MIN_SECTION_TRACKS),
    только затем берётся топ section_limit: жанр без минимальной секции
    не занимает слот. Треки уже выбранных секций исключаются из следующих:
    один трек не попадает в две секции. Случайные жанры-заполнители
    не добавляются.
    """
    affinity = get_user_genre_affinity(user_id)
    dislike_ids = db.get_user_dislike_ids(user_id)
    used_track_ids: set[str] = set()
    sections: list[dict] = []

    for item in affinity:
        if len(sections) >= max(0, section_limit):
            break
        genre = item["genre"]
        available = _genre_candidates(genre.casefold(), dislike_ids, used_track_ids)
        if len(available) < MIN_SECTION_TRACKS:
            continue
        tracks = generate_genre_playlist(
            user_id,
            genre,
            limit=track_limit,
            exclude_ids=used_track_ids,
            base_url=base_url,
        )
        if len(tracks) < MIN_SECTION_TRACKS:
            continue
        used_track_ids.update(str(t["id"]) for t in tracks)
        slug = genre.lower().replace(" ", "-")
        sections.append(
            {
                "id": f"genre-{slug}",
                "type": "genre",
                "title": f"{genre} for you",
                "description": f"Персональная подборка из жанра {genre}",
                "genre": genre,
                "tracks": tracks,
            }
        )
    return sections
