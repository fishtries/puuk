"""Central configuration: environment-driven settings and shared constants."""

import os

SERVER_IP = os.getenv("SERVER_IP", "192.168.1.117")
QDRANT_URL = os.getenv("QDRANT_URL", f"http://{SERVER_IP}:6333")
COLLECTION_NAME = "tracks"
MUSIC_DIR = os.getenv("MUSIC_DIR", "/mnt/data/projects/puuk/music")
BASE_DIR = os.path.dirname(__file__)
DEFAULT_COVER_PATH = os.path.join(BASE_DIR, "default_cover.jpg")
DEFAULT_COVER_COLOR = "#13141f"
WAVE_PERSONALIZATION_WEIGHT = float(os.getenv("WAVE_PERSONALIZATION_WEIGHT", "0.35"))
# Доля exploration-пула кандидатов от чистого вектора вкуса (ширина выхода за кластер трека).
WAVE_EXPLORE_RATIO = float(os.getenv("WAVE_EXPLORE_RATIO", "0.25"))

# Тесты изолируют БД через PUUK_DB_PATH (см. test_db_path.py); по умолчанию — рабочая база.
DB_PATH = os.getenv("PUUK_DB_PATH") or os.path.join(BASE_DIR, "puuk.db")


def get_base_url(request) -> str:
    """Resolve public base URL: explicit BASE_URL env wins, otherwise derive from request."""
    explicit_base = os.getenv("BASE_URL")
    if explicit_base:
        return explicit_base.rstrip("/")
    try:
        return str(request.base_url).rstrip("/")
    except Exception:
        return f"http://{SERVER_IP}:8000"


def get_effective_music_dir() -> str:
    """MUSIC_DIR with graceful fallback to brain/temp_audio (local development)."""
    path = os.getenv("MUSIC_DIR", MUSIC_DIR)
    if not os.path.exists(path):
        local_fallback = os.path.join(BASE_DIR, "temp_audio")
        if os.path.exists(local_fallback):
            return os.path.realpath(local_fallback)
        os.makedirs(path, exist_ok=True)
    return os.path.realpath(path)
