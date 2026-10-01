"""Puuk Brain API — application composition root.

Assembles routers, wires services, and keeps backwards-compatible exports
used by the test suite (apply_diversity_penalty, get_smart_recommendations, ...).
"""
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import db
from services import recommendation_service
from services.media_locations import extract_full_metadata  # noqa: F401 (compat export)
from services.library_service import scan_library

# Backwards-compatible exports consumed by tests/scripts (see test_personalization.py)
apply_diversity_penalty = recommendation_service.apply_diversity_penalty
get_smart_recommendations = recommendation_service.get_smart_recommendations
client = recommendation_service.client


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    try:
        from services.track_metadata_service import reconcile_uncommitted_mutations
        reconcile_uncommitted_mutations()
    except Exception as e:
        print(f"[Startup] Предупреждение при согласовании незавершенных мутаций: {e}")
    try:
        tracks = db.get_all_tracks()
        if len(tracks) == 0:
            print("[Startup] База puuk.db пуста, выполняем сканирование библиотеки...")
            scan_library()
            print("[Startup] Сканирование завершено.")
    except Exception as e:
        print(f"[Startup] Предупреждение при стартовой проверке библиотеки: {e}")
    yield


ENABLE_DOCS = os.getenv("ENABLE_DOCS", "false").lower() in ("true", "1", "yes")

app = FastAPI(
    title="Puuk Brain API",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs" if ENABLE_DOCS else None,
    redoc_url=None,
    openapi_url="/openapi.json" if ENABLE_DOCS else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://web.puuk.fun"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Range", "If-None-Match"],
)

# --- Routers ---

from routers.auth import router as auth_router
app.include_router(auth_router, prefix="/api/auth", tags=["auth"])

from routers.user_content import router as user_content_router
app.include_router(user_content_router, prefix="/api", tags=["user_content"])

from routers.wave import router as wave_router, user_router as wave_user_router
app.include_router(wave_router)
app.include_router(wave_user_router)

from routers.wave_recommendations import router as wave_rec_router
app.include_router(wave_rec_router)

from routers.streaming import router as streaming_router
app.include_router(streaming_router)

from routers.albums import router as albums_router
app.include_router(albums_router)

from routers.playlists import router as playlists_router
app.include_router(playlists_router)

from routers.search import router as search_router
app.include_router(search_router)

from routers.library import router as library_router
app.include_router(library_router)

from routers.tracks import router as tracks_router
app.include_router(tracks_router)

from routers.personalized_recommendations import router as personalized_rec_router
app.include_router(personalized_rec_router)


if __name__ == "__main__":
    if len(db.get_all_tracks()) == 0:
        print("Database is empty. Auto-scanning library...")
        scan_library()

    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
