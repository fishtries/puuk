# Multi-artist recommendations report

Changed `brain/services/recommendation_service.py`, `brain/services/personalized_recommendation_service.py`, `brain/repositories/wave.py`, `brain/wave_tuning.py`, `brain/test_wave_stage2.py`, `brain/test_personalization.py`, and new `brain/test_multi_artist_recommendations.py`. Existing test expectations were updated for case-sensitive stable artist IDs and the frozen recent-count interface.

Recommendations prefetch SQLite credit states in bounded chunks; an existing empty list is authoritative, missing rows fall back to structured payload or whole legacy names, and database failure is logged once and degrades to payload. Strict selection counts each distinct participant, recent penalties use the maximum participant frequency across five ordered events, and soft refill deduplicates by track ID. Personalized genre breadth and diversity, and wave tuning metrics, use the union of participant IDs. No embedding or Qdrant write was added.

Checks, using temporary `PUUK_DB_PATH` and no real Qdrant or audio writes:

- `brain/venv/bin/python -m py_compile brain/services/recommendation_service.py brain/services/personalized_recommendation_service.py brain/repositories/wave.py brain/wave_tuning.py`: exit 0.
- Initial existing-suite run: exit 1, 62 passed and 4 failed because old tests expected case-insensitive identities and the retired string-list penalty interface; updated those assertions to the frozen contract.
- `brain/venv/bin/python -m pytest -q brain/test_multi_artist_recommendations.py`: exit 0, 6 passed.
- `brain/venv/bin/python -m pytest -q brain/test_multi_artist_recommendations.py brain/test_wave_stage2.py brain/test_wave.py brain/test_personalized_recommendations.py brain/test_personalization.py brain/test_effective_genres_recommendations.py`: exit 0, 72 passed; one pre-existing Starlette/httpx deprecation warning.

Coverage includes A, B, A+B, A+C, D, narrow pools, stale payload, explicit empty and missing SQLite credits, SQLite failure diagnostics, max rather than summed penalty, deterministic five-event counts, 1,001-ID batch query bounds, Qdrant-unavailable genre fallback, and credit edits/bulk edits with Qdrant unavailable. Wave DTO composition is integration-owned; subjective recommendation quality and production-scale behavior require independent integration and listening evaluation. No production deployment or data mutation was performed.
