"""Rank the device's playable tracks with the Wave taste profile and audio vectors."""
import numpy as np

import db
from repositories.recording_reviews import blocked_track_ids
from config import COLLECTION_NAME, WAVE_PERSONALIZATION_WEIGHT
from repositories.wave import recent_wave_exposure
from services.media_locations import qdrant_point_id
from user_profile import get_or_compute_user_embedding


def rank_downloads(user_id, track_ids, client):
    requested = set(track_ids)
    blocked = sorted(requested & blocked_track_ids())
    eligible = requested.difference(blocked, db.get_user_dislike_ids(user_id))
    ids = [point_id for tid in sorted(eligible) if (point_id := qdrant_point_id(tid)) is not None]
    plan = {"starts": [], "next": {}, "blocked": blocked}
    if not ids:
        return plan

    points = client.retrieve(collection_name=COLLECTION_NAME, ids=ids, with_vectors=True,
                             with_payload=["needs_embedding"])
    tracks, vectors = [], []
    for point in points:
        tid = str(point.id)
        if tid not in eligible or (point.payload or {}).get("needs_embedding") or point.vector is None:
            continue
        vector = np.asarray(point.vector, dtype=np.float32)
        norm = np.linalg.norm(vector)
        if vector.ndim == 1 and np.isfinite(norm) and norm > 0:
            tracks.append(tid)
            vectors.append(vector / norm)
    if not tracks:
        return plan

    audio = np.stack(vectors)
    profile = get_or_compute_user_embedding(user_id, client)
    affinity = np.zeros(len(tracks))
    if profile is not None and profile.shape == audio.shape[1:]:
        norm = np.linalg.norm(profile)
        if np.isfinite(norm) and norm > 0:
            affinity = audio @ (profile / norm)
    favorites = db.get_favorite_track_ids(user_id, for_taste=True)
    exposure = recent_wave_exposure(user_id)
    adjustment = []
    for tid in tracks:
        played, skipped = exposure.get(tid, (0, False))
        adjustment.append(0.10 * (tid in favorites) - 0.09 * min(played, 3) - 0.12 * skipped)

    starts = affinity + adjustment
    plan["starts"] = [[tracks[i], float(starts[i])] for i in np.argsort(-starts)]
    weight = WAVE_PERSONALIZATION_WEIGHT
    scores = (1 - weight) * (audio @ audio.T) + weight * affinity + adjustment
    np.fill_diagonal(scores, -np.inf)
    for i, tid in enumerate(tracks):
        indices = np.argsort(-scores[i])[:min(12, len(tracks) - 1)]
        plan["next"][tid] = [tracks[j] for j in indices]
    return plan
