"""Build a Wave from short runs around distinct, personally supported tracks."""
import logging
import random
from datetime import datetime, timedelta, timezone

import numpy as np

from config import COLLECTION_NAME
from repositories.wave import taste_snapshot
from services.media_locations import qdrant_point_id
from services.taste_profile import track_weights, instant
from services import recommendation_service as reco


def _run_length(events):
    now = datetime.now(timezone.utc)
    outcomes = []
    for event in events:
        if (event.get('context') != 'wave' or event['event_type'] not in ('finish', 'skip')
                or event.get('provenance') in ('qa', 'import')):
            continue
        try:
            at = instant(event['ts'])
        except (TypeError, ValueError, KeyError):
            continue
        if now - timedelta(minutes=45) <= at <= now:
            outcomes.append((at, event))
    recent = [e for _, e in sorted(outcomes, key=lambda pair: pair[0], reverse=True)[:2]]
    if len(recent) == 2:
        if all(e['event_type'] == 'finish' for e in recent):
            return 6
        if all(e['event_type'] == 'skip' and (e.get('listen_duration_ms') or 0) < 30000
               and 2 * (e.get('listen_duration_ms') or 0) < (e.get('track_duration_ms') or 0) for e in recent):
            return 2
    return 4


def _anchor(candidates, previous, weights):
    available = [p for p in candidates if previous is None or str(p.id) != str(previous.id)]
    if not available:
        return None
    if previous is not None and previous.vector is not None:
        # Keep the more contrasting half, then sample by listening evidence.
        vector = np.asarray(previous.vector)
        available.sort(key=lambda p: np.dot(p.vector, vector) / np.linalg.norm(p.vector))
        available = available[:(len(available) + 1) // 2]
    return random.choices(available, weights=[weights[str(p.id)] for p in available], k=1)[0]


def mixed_queue(user_id, previous, restart, limit, hard, recent, queued, *, trace=None):
    snapshot = taste_snapshot(user_id)
    weights = track_weights(snapshot)
    # One finish (even a manual play) weighs less than 1 after saturation.
    # A fresh run needs a like or accumulated evidence across listening events.
    supported = [tid for tid, w in weights.items() if tid not in hard
                 and (tid in snapshot['likes'] or w > 1.)]
    ids = [qid for tid in sorted(supported, key=weights.get, reverse=True)[:64]
           if (qid := qdrant_point_id(tid)) is not None]
    candidates = []
    if ids:
        try:
            records = reco.client.retrieve(collection_name=COLLECTION_NAME, ids=ids,
                                           with_vectors=True, with_payload=True)
            candidates = [p for p in records if str(p.id) in weights and p.vector is not None
                          and np.linalg.norm(p.vector) > 0 and not (p.payload or {}).get('needs_embedding')]
        except Exception:
            logging.getLogger(__name__).warning('Wave taste anchors unavailable', exc_info=True)

    first = _anchor(candidates, previous, weights) if restart else previous
    first_source = 'taste' if restart else 'current'
    if first is None:
        records = reco.scroll_random_ready_track()
        if not records:
            return []
        first = records[0]
        first_source = 'random'
    excluded = set(hard)
    if previous is not None:
        excluded.add(str(previous.id))

    def nearby(anchor, size):
        return reco.get_smart_recommendations(
            str(anchor.id), size, anchor, dislike_ids=excluded, exclude_ids=recent,
            queued_ids=queued, user_id=user_id, personal_mix=True,
        )

    run = 4 if restart else _run_length(snapshot['events'])
    primary = nearby(first, limit)
    groups = [(primary, first, first_source)]
    if limit > run and primary:
        second = _anchor(candidates, first, weights)
        if second is not None:
            # Keep the unused primary tail as fallback for a small or overlapping catalog.
            excluded.update(str(p.id) for p in primary[:run])
            groups.append((nearby(second, limit - min(run, len(primary))), second, 'alternate'))
    ordered = []
    seen = set()
    for offset in range(0, limit, run):
        for group, anchor, source in groups:
            for point in group[offset:offset + run]:
                if str(point.id) not in seen:
                    ordered.append(point)
                    seen.add(str(point.id))
                    if trace is not None:
                        trace[str(point.id)] = dict(anchor_id=str(anchor.id), source=source,
                                                    mix_position=len(ordered))
                    if len(ordered) == limit:
                        return ordered
    return ordered
