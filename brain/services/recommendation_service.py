"""«Моя Волна» recommendations: hybrid vector search, BPM re-ranking, diversity penalty."""
import os
import random
from collections import Counter
from typing import Optional

import numpy as np
from qdrant_client import QdrantClient
from qdrant_client.models import RecommendQuery, RecommendInput, Filter, FieldCondition, MatchValue

import db
from config import QDRANT_URL, COLLECTION_NAME, WAVE_PERSONALIZATION_WEIGHT, WAVE_EXPLORE_RATIO
from user_profile import get_or_compute_user_embedding

qdrant_client = QdrantClient(url=QDRANT_URL)

client = qdrant_client  # historical alias used by tests and internal callers

# Ограничение размера пула кандидатов из Qdrant (защита от чрезмерной нагрузки).
# Пул должен покрывать каталог заметно шире, чем финальная пачка, иначе
# diversity-фильтр видит только самый близкий музыкальный кластер.
CANDIDATE_POOL_FLOOR = 150
CANDIDATE_POOL_CEILING = 500
CANDIDATE_POOL_MULTIPLIER = 20

# Мягкий лимит треков одного исполнителя в одной пачке рекомендаций.
MAX_TRACKS_PER_ARTIST = 2

# Перемешивание кандидатов внутри групп почти равного score (controlled variety).
SELECT_BAND_SCORE_EPS = 0.02

# Размер пула для случайного выбора при cold start (вместо всегда первой точки).
SCROLL_POOL_SIZE = 50


def _artist_from_file_path(file_path: Optional[str]) -> Optional[str]:
    """
    Извлечение исполнителя из имени файла вида "Artist - Title.ext".
    Без обращения к диску. Если разделителя нет, имя файла не считается
    исполнителем: иначе каждый трек получил бы искусственного «артиста».
    """
    if not file_path:
        return None
    name = os.path.splitext(os.path.basename(file_path))[0]
    if " - " not in name:
        return None
    return name.split(" - ", 1)[0].strip() or None


class _ArtistResolver:
    """
    Резолвер исполнителя на время одного recommendation-запроса.
    Кэширует нормализованные ключи, чтобы не делать отдельный SQLite-запрос
    на каждого кандидата из пула.
    """

    def __init__(self):
        self._cache: dict[str, Optional[str]] = {}
        self._db_tracks: Optional[dict[str, dict]] = None

    def _load_db_tracks(self) -> dict[str, dict]:
        if self._db_tracks is None:
            try:
                self._db_tracks = {str(t["id"]): dict(t) for t in db.get_all_tracks()}
            except Exception:
                self._db_tracks = {}
        return self._db_tracks

    def key(self, payload: dict, track_id: str) -> Optional[str]:
        cached = self._cache.get(track_id, _UNSET)
        if cached is not _UNSET:
            return cached

        payload = payload or {}
        artist = payload.get("artist")

        if not artist:
            db_track = self._load_db_tracks().get(str(track_id))
            artist = db_track.get("artist") if db_track else None

        if not artist:
            artist = _artist_from_file_path(payload.get("file_path"))

        key = " ".join(str(artist).casefold().split()) if artist else None
        self._cache[track_id] = key
        return key


_UNSET = object()


def select_diverse_recommendations(
    scored_points: list,
    limit: int,
    max_tracks_per_artist: int = MAX_TRACKS_PER_ARTIST,
    resolver: Optional["_ArtistResolver"] = None,
    band_score_eps: float = 0.0,
) -> list:
    """
    Выбирает финальную пачку, ограничивая долю одного исполнителя.
    Если альтернатив нет — мягко ослабляет лимит, чтобы не вернуть пустой список.
    Кандидаты с известным исполнителем предпочитаются кандидатам без него.

    band_score_eps > 0 перемешивает кандидатов внутри группы близких по score,
    чтобы выдача не была каждый раз одинаковым топ-N (controlled variety).
    """
    if limit <= 0:
        return []

    resolver = resolver or _ArtistResolver()
    ordered = sorted(scored_points, key=lambda x: x.score, reverse=True)

    if band_score_eps > 0:
        ordered = _shuffle_score_bands(ordered, band_score_eps)

    keyed: list = []
    unknown: list = []
    for point in ordered:
        key = resolver.key(point.payload or {}, str(point.id))
        if key:
            keyed.append((key, point))
        else:
            unknown.append(point)

    selected: list = []
    artist_counts: Counter = Counter()

    for key, point in keyed:
        if len(selected) >= limit:
            break
        if artist_counts[key] >= max_tracks_per_artist:
            continue
        selected.append(point)
        artist_counts[key] += 1

    # Fallback 1: кандидаты с неизвестным исполнителем (не ломают diversity-группы).
    if len(selected) < limit:
        for point in unknown:
            if len(selected) >= limit:
                break
            selected.append(point)

    # Fallback 2: мягкое ослабление лимита исполнителя, если пачка всё ещё не набрана.
    if len(selected) < limit:
        chosen = {id(point) for point in selected}
        for _, point in keyed:
            if len(selected) >= limit:
                break
            if id(point) in chosen:
                continue
            selected.append(point)
            chosen.add(id(point))

    return selected


def _merge_candidate_points(primary: list, secondary: list) -> list:
    """Объединяет пулы кандидатов без дублей по id: сначала основной, потом exploration."""
    seen = {str(p.id) for p in primary}
    merged = list(primary)
    for point in secondary:
        if str(point.id) in seen:
            continue
        seen.add(str(point.id))
        merged.append(point)
    return merged


def _shuffle_score_bands(ordered: list, band_score_eps: float) -> list:
    """
    Перемешивает кандидатов внутри групп с почти равным score (разница <= eps),
    сохраняя общий порядок сверху вниз. Качество ранжирования не искажает:
    обмен происходит только между практически равнозначными треками.
    """
    banded: list = []
    i = 0
    while i < len(ordered):
        anchor_score = ordered[i].score
        j = i + 1
        while j < len(ordered) and anchor_score - ordered[j].score <= band_score_eps:
            j += 1
        group = ordered[i:j]
        if len(group) > 1:
            random.shuffle(group)
        banded.extend(group)
        i = j
    return banded


def apply_diversity_penalty(
    scored_points: list,
    recent_artists: list[str],
    penalty: float = 0.05,
    resolver: Optional["_ArtistResolver"] = None,
) -> list:
    """
    Снижает скор треков исполнителей, которые уже звучали в последних прослушиваниях пользователя.
    Предотвращает зацикливание Моей Волны на одном исполнителе (diversity boost).
    """
    if not recent_artists:
        scored_points.sort(key=lambda x: x.score, reverse=True)
        return scored_points

    resolver = resolver or _ArtistResolver()
    artist_counts = Counter(" ".join(str(a).casefold().split()) for a in recent_artists if a)

    adjusted = []
    for p in scored_points:
        key = resolver.key(p.payload or {}, str(p.id))
        if key:
            reps = artist_counts.get(key, 0)
            if reps > 0:
                p.score -= (penalty * reps)
        adjusted.append(p)

    adjusted.sort(key=lambda x: x.score, reverse=True)
    return adjusted


def get_smart_recommendations(
    current_track_id: str,
    limit: int,
    existing_track,
    dislike_ids: set = None,
    exclude_ids: set = None,
    queued_ids: set = None,
    user_id: Optional[int] = None,
    personalization_weight: float = WAVE_PERSONALIZATION_WEIGHT
) -> list:
    """
    Гибридные векторные рекомендации:
    blend(current_track, user_embedding) с учетом BPM и штрафа за повторы исполнителей (diversity boost).

    Уровни исключений:
      dislike_ids — жёсткие (никогда не возвращаются);
      queued_ids — треки, уже стоящие в очереди клиента (не возвращаются,
                   пока есть хоть какие-то альтернативы);
      exclude_ids — недавно проигранное (ослабляется первым, только если
                    без него не набирается limit).
    """
    # Определяем базовые значения
    if isinstance(existing_track, list) and existing_track:
        payload = existing_track[0].payload
    else:
        payload = existing_track.payload if hasattr(existing_track, 'payload') else {}

    base_bpm = payload.get("bpm", 0)

    # 1. Извлекаем вектор текущего трека
    current_vector = None
    try:
        current_points = client.retrieve(
            collection_name=COLLECTION_NAME,
            ids=[current_track_id],
            with_vectors=True
        )
        if current_points and current_points[0].vector is not None:
            current_vector = np.array(current_points[0].vector, dtype=np.float32)
    except Exception as e:
        print(f"[SmartRec] Warning retrieving current track vector {current_track_id}: {e}")

    # 2. Вектор пользователя нужен и для blend, и для exploration-пула
    user_vec = None
    if user_id is not None:
        try:
            user_vec = get_or_compute_user_embedding(user_id, client)
        except Exception as e:
            print(f"[SmartRec] Warning computing user embedding: {e}")

    # Если есть вектор трека — строим запрос (смешанный либо чистый)
    query_target = None
    if current_vector is not None:
        query_vector = current_vector
        if user_vec is not None and personalization_weight > 0.0:
            # Blend: (1 - w) * current + w * user_vector
            blended = (1.0 - personalization_weight) * current_vector + personalization_weight * user_vec
            norm = np.linalg.norm(blended)
            if norm > 0:
                blended = blended / norm
            query_vector = blended
        query_target = query_vector.tolist()

    # 3. Выполняем векторный запрос в Qdrant (пул заметно шире запрошенного limit)
    candidate_limit = min(CANDIDATE_POOL_CEILING, max(CANDIDATE_POOL_FLOOR, limit * CANDIDATE_POOL_MULTIPLIER))
    ready_filter = Filter(
        must=[FieldCondition(key="needs_embedding", match=MatchValue(value=False))]
    )

    if query_target is not None:
        results = client.query_points(
            collection_name=COLLECTION_NAME,
            query=query_target,
            query_filter=ready_filter,
            limit=candidate_limit,
            with_payload=True,
        )
    else:
        # Fallback на RecommendQuery по ID трека
        results = client.query_points(
            collection_name=COLLECTION_NAME,
            query=RecommendQuery(
                recommend=RecommendInput(positive=[current_track_id], negative=[])
            ),
            query_filter=ready_filter,
            limit=candidate_limit,
            with_payload=True,
        )

    candidate_points = list(results.points)

    # 3b. Controlled exploration: дополнительный пул от чистого вектора вкуса,
    # чтобы выдача выходила за пределы кластера текущего трека.
    explore_added = 0
    if user_vec is not None and WAVE_EXPLORE_RATIO > 0:
        explore_limit = max(1, int(candidate_limit * WAVE_EXPLORE_RATIO))
        try:
            explore_results = client.query_points(
                collection_name=COLLECTION_NAME,
                query=user_vec.tolist(),
                query_filter=ready_filter,
                limit=explore_limit,
                with_payload=True,
            )
            candidate_points = _merge_candidate_points(candidate_points, explore_results.points)
            explore_added = max(0, len(candidate_points) - len(results.points))
        except Exception as e:
            print(f"[SmartRec] Warning explore pool: {e}")

    exclude_ids = exclude_ids or set()
    queued_ids = queued_ids or set()
    resolver = _ArtistResolver()
    recent_excluded = []
    queued_excluded = []
    seen_ids = set()

    # 4. BPM re-ranking, жёсткие исключения (текущий трек, дизлайки, дубли)
    scored_points = []
    for p in candidate_points:
        track_id = str(p.id)
        if track_id == str(current_track_id):
            continue
        if track_id in seen_ids:
            continue
        if dislike_ids and track_id in dislike_ids:
            continue
        seen_ids.add(track_id)

        cand_payload = p.payload or {}
        t_bpm = cand_payload.get("bpm", base_bpm)
        if t_bpm == 0 or base_bpm == 0:
            bpm_diff = 0
        else:
            diff1 = abs(t_bpm - base_bpm)
            diff2 = abs(t_bpm - base_bpm * 2)
            diff3 = abs(t_bpm - base_bpm / 2)
            bpm_diff = min(diff1, diff2, diff3)

        penalty = bpm_diff * 0.005
        p.score = p.score - penalty

        if track_id in queued_ids:
            queued_excluded.append(p)
        elif track_id in exclude_ids:
            recent_excluded.append(p)
        else:
            scored_points.append(p)

    recent_artists = db.get_recent_artists(user_id, limit=5) if user_id else []

    # 5. Diversity penalty (избегание повторения недавних артистов)
    if recent_artists:
        scored_points = apply_diversity_penalty(
            scored_points, recent_artists, penalty=0.05, resolver=resolver
        )
    else:
        scored_points.sort(key=lambda x: x.score, reverse=True)

    selected = select_diverse_recommendations(
        scored_points, limit, resolver=resolver, band_score_eps=SELECT_BAND_SCORE_EPS
    )

    # 6. Мягкое ослабление исключений, строго по уровням:
    #    6a. сначала недавно проигранное (exclude_ids);
    #    6b. только затем — треки из очереди (queued_ids), если всё ещё не хватает.
    for candidates in (recent_excluded, queued_excluded):
        if len(selected) >= limit or not candidates:
            continue
        if recent_artists:
            candidates = apply_diversity_penalty(
                candidates, recent_artists, penalty=0.05, resolver=resolver
            )
        else:
            candidates.sort(key=lambda x: x.score, reverse=True)

        chosen = {str(p.id) for p in selected}
        for point in candidates:
            if len(selected) >= limit:
                break
            if str(point.id) in chosen:
                continue
            selected.append(point)
            chosen.add(str(point.id))

    if os.getenv("WAVE_RECO_DEBUG"):
        known_keys = {resolver.key(p.payload or {}, str(p.id)) for p in selected}
        known_keys.discard(None)
        print(
            f"[SmartRec] user={user_id} track={current_track_id} "
            f"pool={len(candidate_points)} explore+{explore_added} "
            f"skipped_recent={len(recent_excluded)} skipped_queued={len(queued_excluded)} "
            f"returned={len(selected)} unique_artists={len(known_keys)}"
        )

    return selected


def retrieve_track_point(track_id: str, with_payload: bool = True):
    """Возвращает список точек Qdrant для трека или пустой список."""
    try:
        return client.retrieve(
            collection_name=COLLECTION_NAME,
            ids=[track_id],
            with_payload=with_payload,
        )
    except Exception as exc:
        raise RuntimeError(str(exc))


def _pick_random_from_scroll(scroll_filter: Filter | None):
    """Скроллит пул точек и выбирает случайную — cold start без permanently-одинакового старта."""
    scroll_kwargs = dict(
        collection_name=COLLECTION_NAME,
        limit=SCROLL_POOL_SIZE,
        with_payload=True,
        with_vectors=False,
    )
    if scroll_filter is not None:
        scroll_kwargs["scroll_filter"] = scroll_filter

    records, _ = client.scroll(**scroll_kwargs)
    if not records:
        return []
    return [random.choice(records)]


def scroll_random_ready_track():
    """
    Случайный готовый трек (needs_embedding=false) из Qdrant с fallback на всю коллекцию.
    Выбор из пула вместо scroll(limit=1): первая точка коллекции возвращалась бы всегда.
    """
    picked = _pick_random_from_scroll(
        Filter(must=[FieldCondition(key="needs_embedding", match=MatchValue(value=False))])
    )
    if not picked:
        picked = _pick_random_from_scroll(None)
    return picked


def scroll_any_track():
    """Случайная точка коллекции (cold start /wave/next): пул вместо всегда первой точки."""
    return _pick_random_from_scroll(None)


def build_wave_track_payload(pick, base_url: str, fav_ids: set[str], include_album: bool = False) -> dict:
    """Формирует JSON-ответ трека Волны из точки Qdrant с обогащением из SQLite."""
    track_id = str(pick.id)
    db_track = db.get_track(track_id)
    if not db_track:
        from services.media_locations import extract_full_metadata
        title, artist, _, _, duration = extract_full_metadata(pick.payload.get("file_path", ""))
        file_path = pick.payload.get("file_path", "")
        cover_color = None
    else:
        title = db_track['title']
        artist = db_track['artist']
        file_path = db_track['file_path']
        cover_color = db_track.get('cover_color')
        duration = db_track.get('duration')

    payload = {
        "id": track_id,
        "track_id": track_id,
        "title": title,
        "artist": artist,
        "duration": duration,
        "file_path": file_path,
        "bpm": pick.payload.get("bpm"),
        "stream_url": f"{base_url}/api/stream/{track_id}",
        "coverArt": f"{base_url}/api/cover/{track_id}",
        "cover_color": cover_color,
        "is_liked": track_id in fav_ids,
        "normalization_gain_db": db_track.get("normalization_gain_db") if db_track else pick.payload.get("normalization_gain_db"),
        "loudness_status": (db_track.get("loudness_status") if db_track else pick.payload.get("loudness_status")) or "pending",
        "loudness_lufs": db_track.get("loudness_lufs") if db_track else pick.payload.get("loudness_lufs"),
        "true_peak_db": db_track.get("true_peak_db") if db_track else pick.payload.get("true_peak_db"),
        "score": round(pick.score, 3),
    }
    if include_album:
        payload["album"] = None
    return payload
