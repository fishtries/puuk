from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
from fastapi.testclient import TestClient
import test_db_path  # noqa: F401
from fastapi import FastAPI

from routers import wave_recommendations as router
from services import offline_wave as service


def test_device_plan_uses_profile_neighbors_and_playback_feedback(monkeypatch):
    app = FastAPI()
    app.include_router(router.router)
    app.dependency_overrides[router.get_current_user] = lambda: {"id": 9}
    api = TestClient(app)
    monkeypatch.setattr(service, "get_or_compute_user_embedding", lambda uid, client: np.array([0, 1]))
    monkeypatch.setattr(service.db, "get_favorite_track_ids", lambda uid, for_taste: {"1"})
    monkeypatch.setattr(service.db, "get_user_dislike_ids", lambda uid: {"6"})
    monkeypatch.setattr(service, "blocked_track_ids", lambda: {"7"})
    monkeypatch.setattr(service, "recent_wave_exposure", lambda uid: {"5": (3, True)})
    vectors = [[0, 1], [1, 0], [.99, .01], [0, 0], [0, 1]]
    retrieve = Mock(return_value=[SimpleNamespace(id=i, vector=v, payload={})
                                  for i, v in enumerate(vectors, 1)])
    monkeypatch.setattr(router.client, "retrieve", retrieve)
    url = "/api/wave/offline-plan"
    response = api.post(url, json={"track_ids": ["1", "2", "3", "4", "5", "6", "7", "unindexed"]})
    assert response.status_code == 200
    plan = response.json()
    assert [tid for tid, score in plan["starts"]][:2] == ["1", "5"]
    assert plan["next"]["2"][0] == "3"
    assert set(plan["next"]) == {"1", "2", "3", "5"}
    assert all(seed not in neighbors for seed, neighbors in plan["next"].items())
    assert plan["blocked"] == ["7"]
    assert retrieve.call_args.kwargs["ids"] == [1, 2, 3, 4, 5]
    assert api.post(url, json={"track_ids": ["1"] * 513}).status_code == 422
