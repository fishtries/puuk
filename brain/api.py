"""Puuk Brain API — application composition root.

Assembles routers, wires services, and keeps backwards-compatible exports
used by the test suite (apply_diversity_penalty, get_smart_recommendations, ...).
"""
import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import config
import db
from services import recommendation_service
from services.media_locations import extract_full_metadata  # noqa: F401 (compat export)
from services.library_service import scan_library

# Backwards-compatible exports consumed by tests/scripts (see test_personalization.py)
apply_diversity_penalty = recommendation_service.apply_diversity_penalty
get_smart_recommendations = recommendation_service.get_smart_recommendations
client = recommendation_service.client

EMBEDDING_RECONCILE_ENABLED = os.getenv("EMBEDDING_RECONCILE_ENABLED", "true").lower() in ("true", "1", "yes")
EMBEDDING_RECONCILE_INTERVAL_SEC = float(os.getenv("EMBEDDING_RECONCILE_INTERVAL_SEC", "300"))
EMBEDDING_RECONCILE_LOCK_PATH = os.getenv("EMBEDDING_RECONCILE_LOCK", "/tmp/puuk_embedding_reconcile.lock")

LOUDNESS_SYNC_ENABLED = config.LOUDNESS_SYNC_ENABLED
LOUDNESS_SYNC_INTERVAL_SEC = config.LOUDNESS_SYNC_INTERVAL_SEC
LOUDNESS_SYNC_LOCK_PATH = config.LOUDNESS_SYNC_LOCK_PATH


def _acquire_process_lock(path):
    """Ensures a single API process owns a periodic background task.

    With multiple workers each process would otherwise repeat the same
    reconciliation. Returns a lock handle, ``True`` when file locking is
    unavailable, or ``None`` when another process owns it.
    """
    try:
        import fcntl
    except ImportError:
        return True
    try:
        handle = open(path, "w")
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except OSError:
        return None


def _acquire_reconcile_owner():
    return _acquire_process_lock(EMBEDDING_RECONCILE_LOCK_PATH)


def _acquire_loudness_sync_owner():
    return _acquire_process_lock(LOUDNESS_SYNC_LOCK_PATH)


async def _embedding_reconcile_loop():
    """Periodically recovers SQLite tracks missing a Qdrant queue point.

    Runs one pass at startup, then repeats at the configured interval. Passes
    never overlap (the loop is sequential) and every failure is logged and
    retried on the next iteration.
    """
    from services.embedding_queue_service import get_qdrant_client, reconcile_embedding_queue

    while True:
        try:
            client = get_qdrant_client()
            counters = await asyncio.to_thread(reconcile_embedding_queue, client)
            if counters.get("enqueued") or counters.get("failed"):
                print(f"[EmbeddingReconcile] {counters}")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[EmbeddingReconcile] Ошибка сверки (повтор на следующем проходе): {e}")
        await asyncio.sleep(EMBEDDING_RECONCILE_INTERVAL_SEC)


async def _loudness_sync_loop():
    """Periodically delivers analyzed loudness results from Qdrant to SQLite.

    ``heavy_worker`` writes results to the shared Qdrant while the server keeps
    its own SQLite; without this pull the catalog stays ``pending`` for tracks
    the worker already analyzed. One pass at startup, then repeats at the
    configured interval. Passes never overlap, and any Qdrant outage is logged
    and retried on the next tick so it cannot affect the API.

    The periodic pass only updates tracks the server catalog already knows
    (``create_missing=False``); recovering missing catalog rows stays the job of
    the library scanner / startup sync, so an unexpected Qdrant point cannot
    silently add a track to the catalog. The client is created and closed inside
    the worker thread (``run_loudness_sync``), so task cancellation cannot close
    it mid-pass.
    """
    from services.loudness_sync_service import run_loudness_sync

    while True:
        try:
            counters = await asyncio.to_thread(run_loudness_sync, create_missing=False)
            if counters.get("synced") or counters.get("failed"):
                print(f"[LoudnessSync] {counters}")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[LoudnessSync] Ошибка синхронизации (повтор на следующем проходе): {e}")
        await asyncio.sleep(LOUDNESS_SYNC_INTERVAL_SEC)


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
        else:
            from services.library_service import sync_missing_tracks_to_db
            asyncio.create_task(asyncio.to_thread(sync_missing_tracks_to_db))
    except Exception as e:
        print(f"[Startup] Предупреждение при стартовой проверке библиотеки: {e}")

    reconcile_task = None
    reconcile_owner = None
    if EMBEDDING_RECONCILE_ENABLED:
        reconcile_owner = _acquire_reconcile_owner()
        if reconcile_owner is not None:
            reconcile_task = asyncio.create_task(_embedding_reconcile_loop())

    loudness_task = None
    loudness_owner = None
    if LOUDNESS_SYNC_ENABLED:
        loudness_owner = _acquire_loudness_sync_owner()
        if loudness_owner is not None:
            loudness_task = asyncio.create_task(_loudness_sync_loop())

    try:
        yield
    finally:
        if reconcile_task is not None:
            reconcile_task.cancel()
            try:
                await reconcile_task
            except asyncio.CancelledError:
                pass
        if reconcile_owner is not None and reconcile_owner is not True:
            reconcile_owner.close()
        if loudness_task is not None:
            loudness_task.cancel()
            try:
                await loudness_task
            except asyncio.CancelledError:
                pass
        if loudness_owner is not None and loudness_owner is not True:
            loudness_owner.close()


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
