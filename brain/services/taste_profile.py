"""Pure, replayable taste arithmetic over a bounded snapshot; no network or DB.

Active-day half-life and saturation are hypotheses to compare against the old
centroid. One early skip is weak evidence, never a permanent dislike.
"""
from collections import Counter, defaultdict
from datetime import datetime, timezone
import math
import numpy as np


def instant(value):
    dt = value if isinstance(value, datetime) else datetime.fromisoformat(value.replace('Z', '+00:00'))
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def track_weights(snapshot, *, now=None, like_weight=2.):
    now = now or datetime.now(timezone.utc)
    events = []
    for e in snapshot['events']:
        try:
            at, received = instant(e['ts']), instant(e['received_at'])
        except (ValueError, TypeError, KeyError):
            continue
        if at > now or received > now or e.get('provenance') in {'import', 'qa'}:
            continue
        events.append((e, at))
    activity = Counter(at.date() for _, at in events)
    active_age = {}
    accumulated = 0.
    for day in sorted(activity, reverse=True):
        active_age[day] = accumulated
        accumulated += min(1., activity[day] / 5)
    positives, negatives = defaultdict(float), defaultdict(float)
    daily = Counter()
    for e, at in sorted(events, key=lambda pair: pair[1]):
        key = str(e['track_id'])
        age = active_age[at.date()]
        decay = .5 ** (age / 30)
        kind = e['event_type']
        duration = max(0, e.get('track_duration_ms') or 0)
        listened = max(0, e.get('listen_duration_ms') or 0)
        if kind == 'like':
            continue  # current likes are handled once below
        if kind == 'start':
            value = .25
        elif kind == 'finish':
            value = 1.
        elif kind == 'skip':
            ratio = min(1., listened / duration) if duration else 0
            value = .5 if ratio >= .5 else -.5 if listened < 30000 else 0
            if value < 0 and e.get('context') != 'wave':
                value *= .5  # browsing a library is weaker negative evidence
        else:
            continue
        if value > 0:
            # Repeat and duplicate legacy feeds cannot dominate a single day.
            cap = (key, at.date())
            accepted = min(value, max(0., 2. - daily[cap]))
            daily[cap] += accepted
            positives[key] += accepted * decay
        else:
            negatives[key] += -value * decay
    weights = {}
    for key in positives.keys() | negatives.keys() | snapshot['likes']:
        positive = positives[key]
        saturated = 2 * math.log1p(positive / 2)
        weight = max(0., saturated - min(1., negatives[key]))
        if key in snapshot['likes']:
            weight += like_weight
        if key not in snapshot['dislikes'] and weight > 0:
            weights[key] = weight
    return weights


def centroid(vectors, weights):
    total = np.zeros(400, dtype=np.float64)
    for key, weight in weights.items():
        if key not in vectors:
            continue
        vec = np.asarray(vectors[key], dtype=np.float64)
        if vec.shape != (400,) or not np.isfinite(vec).all():
            continue
        norm = np.linalg.norm(vec)
        if norm > 0:
            total += weight * vec / norm
    norm = np.linalg.norm(total)
    return (total / norm).astype(np.float32) if norm > 0 else None


def taste_centers(vectors, weights, max_centers=3):
    """Deterministic experiment: separate distant interests; not used in serving.

    At least five tracks per center and cosine < .8 justify another center.
    No mutation of the Qdrant space; output stays in the existing 400 dimensions.
    """
    keys = sorted(k for k in weights if k in vectors)
    valid = {}
    for key in keys:
        v = np.asarray(vectors[key], dtype=float)
        if v.shape == (400,) and np.isfinite(v).all() and np.linalg.norm(v) > 0:
            valid[key] = v / np.linalg.norm(v)
    if not valid:
        return []
    keys = list(valid)
    matrix = np.stack([valid[k] for k in keys])
    w = np.array([weights[k] for k in keys])
    centers = [matrix[int(np.argmax(w))]]
    for _ in range(min(max_centers, len(keys) // 5) - 1):
        sims = matrix @ np.stack(centers).T
        index = int(np.argmin(sims.max(axis=1)))
        if sims[index].max() >= .8:
            break
        centers.append(matrix[index])
    for _ in range(20):
        labels = np.argmax(matrix @ np.stack(centers).T, axis=1)
        next_centers = []
        for i, old in enumerate(centers):
            vector = (matrix[labels == i] * w[labels == i, None]).sum(axis=0)
            next_centers.append(vector / np.linalg.norm(vector) if np.linalg.norm(vector) else old)
        if np.allclose(centers, next_centers):
            break
        centers = next_centers
    labels = np.argmax(matrix @ np.stack(centers).T, axis=1)
    return [{'vector':c.tolist(), 'weight':float(w[labels == i].sum()),
             'tracks':[k for j,k in enumerate(keys) if labels[j] == i]}
            for i,c in enumerate(centers) if (labels == i).sum() >= min(5,len(keys))]
