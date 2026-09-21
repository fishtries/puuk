"""Tuning-бенчмарк WAVE_PERSONALIZATION_WEIGHT «Мой Волны» на живых данных.

Standalone-скрипт (запуск из корня репозитория: ``python3 brain/wave_tuning.py``).
Сравнивает несколько значений веса персонализации на живом Qdrant
(config.QDRANT_URL, коллекция tracks) и реальной puuk.db, повторяя боевую
последовательность шагов сервиса: blended-запрос, exploration-пул
(WAVE_EXPLORE_RATIO), BPM re-rank, diversity-штраф, уровни exclude/queued.

Только чтение: лайки, история и wave-feedback не пишутся. Единственная
подстановка — предвычисленный вектор пользователя вместо
``user_profile.get_or_compute_user_embedding``: та функция на промахе кэша
пишет профиль в БД через ``db.set_user_embedding``, что нарушало бы
read-only контракт бенчмарка. Всё остальное — боевой путь
``services/recommendation_service.get_smart_recommendations`` (1 вызов = пачка,
как в /wave/queue).

Профиль пользователя строится арифметически, без модельного инференса:
центроид векторов залайканных треков (retrieve по id из Qdrant, L2-нормализация);
если разрешённых лайков < 5 — fallback-центроид 20 случайных точек коллекции
(«synthetic profile»). Рекомендация по итогам НЕ применяется автоматически:
скрипт печатает таблицу и краткий итог, решение за человеком.
"""

import argparse
import random
import statistics
import sys

import numpy as np
from qdrant_client import QdrantClient
from qdrant_client.models import FieldCondition, Filter, MatchValue

import db
import services.recommendation_service as reco_service
from config import COLLECTION_NAME, QDRANT_URL, WAVE_EXPLORE_RATIO
from services.recommendation_service import _ArtistResolver, get_smart_recommendations

# Минимум разрешённых (существующих в Qdrant) лайков для «настоящего» профиля.
MIN_RESOLVED_LIKES = 5
# Размер fallback-профиля: центроид случайных точек коллекции.
SYNTHETIC_PROFILE_SIZE = 20
# Клиентский cap истории exclude из боевого контракта (см. routers/wave_recommendations.py).
CLIENT_EXCLUDE_CAP = 100


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Tuning-сравнение WAVE_PERSONALIZATION_WEIGHT на живом Qdrant и puuk.db (только чтение).",
    )
    parser.add_argument(
        "--weights",
        nargs="+",
        type=float,
        default=[0.25, 0.3, 0.35, 0.4, 0.5],
        help="Значения веса персонализации для сравнения",
    )
    parser.add_argument("--sessions", type=int, default=5, help="Сессий на вес")
    parser.add_argument("--batches", type=int, default=10, help="Пачек на сессию")
    parser.add_argument("--batch-size", type=int, default=8, help="Треков в пачке")
    parser.add_argument("--user-id", type=int, default=None, help="Явный user_id для лайков/истории (по умолчанию — пользователь с максимумом лайков)")
    parser.add_argument("--seed", type=int, default=42, help="База зерна RNG (сид-треки общие для всех весов)")
    return parser.parse_args(argv)


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def fetch_vectors(client: QdrantClient, ids, cache: dict) -> dict:
    """Векторы по id с кэшем: подсядет под стоимость retrieve (points отдаются без векторов)."""
    missing = [tid for tid in ids if tid not in cache]
    if missing:
        points = client.retrieve(collection_name=COLLECTION_NAME, ids=missing, with_vectors=True)
        for p in points:
            if p.vector is not None:
                cache[str(p.id)] = np.array(p.vector, dtype=np.float32)
    return {tid: cache[tid] for tid in ids if tid in cache}


def pick_main_user() -> int | None:
    """Лексическое чтение: пользователь с максимумом лайков. None — если лайков нет вообще.
    list_users отсортирован по id ASC, поэтому при равенстве побеждает меньший id."""
    best_uid, best_count = None, 0
    for user in db.list_users():
        count = len(db.get_favorite_track_ids(user["id"]))
        if count > best_count:
            best_uid, best_count = user["id"], count
    return best_uid


def resolve_profile(client: QdrantClient, user_id_arg: int | None):
    """
    Возвращает (user_vec | None, sim_user_id | None, описание профиля, dislike_ids).
    Только чтение: лайки — db.get_favorite_track_ids, дизлайки — db.get_user_dislike_ids.
    """
    user_id = user_id_arg if user_id_arg is not None else pick_main_user()
    if user_id is None:
        return None, None, "нет пользователей с лайками", set()

    liked_ids = sorted(db.get_favorite_track_ids(user_id))
    resolved: list[tuple[str, np.ndarray]] = []
    if liked_ids:
        vectors = fetch_vectors(client, liked_ids, {})
        resolved = [(tid, vec) for tid, vec in vectors.items()]

    dislike_ids = db.get_user_dislike_ids(user_id)
    if len(resolved) >= MIN_RESOLVED_LIKES:
        user_vec = np.mean([vec for _, vec in resolved], axis=0).astype(np.float32)
        norm = np.linalg.norm(user_vec)
        if norm > 0:
            user_vec = user_vec / norm
        return user_vec, user_id, f"user #{user_id}: центр. {len(resolved)} разрешённых лайков", dislike_ids

    # Fallback: «synthetic profile» — центроид случайных точек коллекции.
    pool, _ = client.scroll(
        collection_name=COLLECTION_NAME,
        limit=SYNTHETIC_PROFILE_SIZE,
        scroll_filter=Filter(must=[FieldCondition(key="needs_embedding", match=MatchValue(value=False))]),
        with_payload=False,
        with_vectors=True,
    )
    if not pool:
        pool, _ = client.scroll(collection_name=COLLECTION_NAME, limit=SYNTHETIC_PROFILE_SIZE, with_vectors=True)
    vecs = [np.array(p.vector, dtype=np.float32) for p in pool if p.vector is not None]
    note = f"synthetic profile — центроид {len(vecs)} случайных точек (resolved лайков: {len(resolved)})"
    if not vecs:
        return None, user_id, note, dislike_ids
    user_vec = np.mean(vecs, axis=0).astype(np.float32)
    norm = np.linalg.norm(user_vec)
    if norm > 0:
        user_vec = user_vec / norm
    return user_vec, user_id, note, dislike_ids


def collect_cold_start_seeds(client: QdrantClient, n_sessions: int, rng: random.Random) -> list[str]:
    """Общие сид-треки для всех весов: пул 50 готовых точек (как cold start сервиса), без повторов в сессиях."""
    pool, _ = client.scroll(
        collection_name=COLLECTION_NAME,
        limit=50,
        scroll_filter=Filter(must=[FieldCondition(key="needs_embedding", match=MatchValue(value=False))]),
        with_payload=False,
        with_vectors=False,
    )
    if not pool:
        pool, _ = client.scroll(collection_name=COLLECTION_NAME, limit=50)
    ids = [str(p.id) for p in pool]
    if not ids:
        raise RuntimeError("Коллекция Qdrant пуста — бенчмарку не на чем работать.")
    return rng.sample(ids, min(n_sessions, len(ids)))


def simulate_weight(
    weight: float,
    seed_ids: list[str],
    *,
    args,
    client: QdrantClient,
    user_vec: np.ndarray,
    sim_user_id: int | None,
    dislike_ids: set,
    resolver: _ArtistResolver,
    vector_cache: dict,
) -> dict:
    """Одна серия сессий для одного веса. Excludes повторяют боевой контракт; якорь фиксирован (изоляция эффекта веса)."""
    unique_total = 0
    repeats = 0
    batches_done = 0
    artist_batch_sizes: list[float] = []
    alignments: list[float] = []
    seed_closes: list[float] = []
    query_aligns: list[float] = []

    for session_index, seed_id in enumerate(seed_ids):
        # Политика якоря: каждая пачка запрашивается от сида сессии. Бенчмарк изолирует
        # эффект веса при фиксированной стартовой точке — цепочка «выданный трек → новый
        # анкор» превращала сравнение весов в траекторный дрейф (аттрактор кластера),
        # маскирующий отклик персонализации. Структура сессии реальная: exclude
        # накапливается от пачки к пачке (клиент потребляет выданное), queued пуст
        # (буфер между пачками потреблён), шаги сервиса — боевые 1:1.
        issued_order: list[str] = []
        heard = {seed_id}
        anchor_id = seed_id
        anchor_vec = fetch_vectors(client, [seed_id], vector_cache)[seed_id]

        for batch_index in range(args.batches):
            # Paired design: зерно shuffle привязано к позиции пачки, а не к весу —
            # удача перестановок в band-shuffle одинакова для всех весов (variance reduction).
            random.seed(args.seed * 1_000_000 + session_index * 1_000 + batch_index)

            batch = get_smart_recommendations(
                current_track_id=anchor_id,
                limit=args.batch_size,
                existing_track=reco_service.retrieve_track_point(anchor_id),
                dislike_ids=dislike_ids,
                # exclude из «истории прослушивания» клиента: всё услышанное, включая текущий анкор;
                # queued пуст — буфер между пачками полностью потреблён (легитимное боевое состояние).
                exclude_ids=set(issued_order[-CLIENT_EXCLUDE_CAP:]),
                queued_ids=set(),
                user_id=sim_user_id,
                personalization_weight=weight,
            )
            if not batch:
                break

            # Диагностика: аналитический косинус blended-запроса к user_vec
            # (тот же blend, что services/recommendation_service.py:274-279).
            query_vec = (1.0 - weight) * anchor_vec + weight * user_vec
            query_norm = float(np.linalg.norm(query_vec))
            if query_norm > 0:
                query_aligns.append(cosine(query_vec, user_vec))

            batch_ids = [str(p.id) for p in batch]
            # Повторные выдачи: мягкая релаксация exclude могла пропустить услышанное обратно.
            repeats += sum(1 for tid in batch_ids if tid in heard)

            vectors = fetch_vectors(client, batch_ids, vector_cache)
            for tid in batch_ids:
                vec = vectors.get(tid)
                if vec is None:
                    continue
                alignments.append(cosine(vec, user_vec))
                seed_closes.append(cosine(vec, anchor_vec))

            artists = {resolver.key(p.payload or {}, tid) for p, tid in zip(batch, batch_ids)}
            artists.discard(None)  # паритет с [SmartRec]-метрикой: считаются только известные исполнители
            artist_batch_sizes.append(len(artists))

            # Выданное пополняет exclude (следующая пачка этого не возвращает —
            # как история прослушивания у клиента); порядок хвоста исключений
            # детерминирован (порядок выдачи, не недетерминизм set).
            issued_order.extend(batch_ids)
            heard.update(batch_ids)
            batches_done += 1

        unique_total += len(set(issued_order))

    return {
        "weight": weight,
        "unique": unique_total,
        "repeats": repeats,
        "artists": statistics.fmean(artist_batch_sizes) if artist_batch_sizes else 0.0,
        "align": statistics.fmean(alignments) if alignments else 0.0,
        "query_align": statistics.fmean(query_aligns) if query_aligns else 0.0,
        "seed_cos": statistics.fmean(seed_closes) if seed_closes else 0.0,
        "batches": batches_done,
    }


def render_header(args, info, profile_note: str) -> None:
    vectors_cfg = info.config.params.vectors
    print("=" * 72)
    print(" WAVE_PERSONALIZATION_WEIGHT — tuning на живых данных")
    print("=" * 72)
    print(f"Qdrant: {QDRANT_URL}  коллекция '{COLLECTION_NAME}': {info.points_count} точек "
          f"({vectors_cfg.size}-dim, {vectors_cfg.distance.value})")
    print(f"Профиль: {profile_note}")
    print(f"Прогон: {args.sessions} сессий × {args.batches} пачек × {args.batch_size} треков | "
          f"exploration ratio: {WAVE_EXPLORE_RATIO} | exclude = выданное сессии, "
          f"queued = [] | якорь каждой пачки = сид сессии | сид-треки общие для всех весов")
    print("Колонки: unique — уникальные треки за сессию (сумма), repeats — повторные выдачи (цель 0),")
    print("         art/batch — среднее уникальных исполнителей в пачке, align — косинусная близость")
    print("         выданных треков к user_vec, query_al — косинус blended-запроса к user_vec (диагностика),")
    print("         seed_cos — близость к сиду сессии (насколько волна уходит от стартового трека).")
    print("-" * 72)


def render_table(rows: list[dict]) -> None:
    header = f"{'weight':>6} {'unique':>7} {'repeats':>8} {'art/batch':>10} {'align':>8} {'query_al':>9} {'seed_cos':>9}"
    print(header)
    print("-" * len(header))
    for row in rows:
        print(
            f"{row['weight']:>6.2f} {row['unique']:>7} {row['repeats']:>8} "
            f"{row['artists']:>10.1f} {row['align']:>8.4f} {row['query_align']:>9.4f} {row['seed_cos']:>9.4f}"
        )


def build_verdict(rows: list[dict], profile_synthetic: bool = False) -> str:
    """Автоматический итог: максимум align при diversity-потере не более 0.2 артиста на пачку."""
    max_artists = max(r["artists"] for r in rows)
    candidates = [r for r in rows if r["artists"] >= max_artists - 0.2] or rows
    best = max(candidates, key=lambda r: r["align"])

    deltas = [rows[i]["align"] - rows[i - 1]["align"] for i in range(1, len(rows))]
    avg_delta = statistics.fmean(deltas) if deltas else 0.0
    monotone = all(d > 0 for d in deltas)

    loss_rows = [r for r in rows if r not in candidates]
    loss_note = ""
    if loss_rows:
        worst = max(loss_rows, key=lambda r: r["align"])
        loss_note = (
            f" Вариант w={worst['weight']:.2f} даёт align {worst['align']:.4f}, "
            f"но разнообразие ниже — {worst['artists']:.1f} артистов на пачку."
        )

    mono_note = (
        f"alignment растёт с весом монотонно (в среднем +{avg_delta:.4f} косинуса на шаг 0.05)"
        if monotone
        else f"alignment в целом растёт с весом (в среднем +{avg_delta:.4f} на шаг 0.05, без строгой монотонности)"
    )
    synthetic_note = (
        " Профиль synthetic (реальных лайков нет) — рекомендация предварительная: "
        "для подтверждения нужен прогон с настоящим профилем (--user-id)."
        if profile_synthetic
        else ""
    )
    return (
        f"По данным лучший компромисс — WAVE_PERSONALIZATION_WEIGHT={best['weight']:.2f}: "
        f"taste_alignment {best['align']:.4f} при repeats={best['repeats']} и "
        f"{best['artists']:.1f} артистах на пачку (максимум {max_artists:.1f}); {mono_note}.{loss_note}{synthetic_note} "
        f"Значение в прод не применяется — решение за вами."
    )


def main(argv=None) -> int:
    args = parse_args(argv)
    client = QdrantClient(url=QDRANT_URL)
    info = client.get_collection(COLLECTION_NAME)

    user_vec, sim_user_id, profile_note, dislike_ids = resolve_profile(client, args.user_id)
    if user_vec is None:
        print("Не удалось построить вектор пользователя (пустой каталог/профиль).", file=sys.stderr)
        return 1

    rng = random.Random(args.seed)
    seed_ids = collect_cold_start_seeds(client, args.sessions, rng)
    if len(seed_ids) < args.sessions:
        print(f"Внимание: сидов меньше числа сессий ({len(seed_ids)} < {args.sessions}), часть сессий стартует одинаково.")

    # Подстановка ради read-only: боевой доступ к профилю пишет кэш в БД (db.set_user_embedding),
    # поэтому сюда отдаётся предвычисленный лексический центроид лайков. Остальное — 1:1 боевой путь.
    original_user_embedding = reco_service.get_or_compute_user_embedding
    reco_service.get_or_compute_user_embedding = lambda user_id, qclient: user_vec

    try:
        resolver = _ArtistResolver()
        vector_cache: dict = fetch_vectors(client, seed_ids, {})  # векторы сидов нужны сразу (anchors)

        rows = []
        render_header(args, info, profile_note)
        print()
        for weight in args.weights:
            row = simulate_weight(
                weight,
                seed_ids,
                args=args,
                client=client,
                user_vec=user_vec,
                sim_user_id=sim_user_id,
                dislike_ids=dislike_ids,
                resolver=resolver,
                vector_cache=vector_cache,
            )
            rows.append(row)
            print(f"[w={weight:.2f}] пачек: {row['batches']}/{args.sessions * args.batches}, "
                  f"unique: {row['unique']}", flush=True)
        print()
        render_table(rows)
        print()
        print(build_verdict(rows, profile_synthetic="synthetic" in profile_note))
    finally:
        reco_service.get_or_compute_user_embedding = original_user_embedding

    return 0


if __name__ == "__main__":
    sys.exit(main())
