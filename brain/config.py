"""Central configuration: environment-driven settings and shared constants."""

import os

SERVER_IP = os.getenv("SERVER_IP", "192.168.1.117")
QDRANT_URL = os.getenv("QDRANT_URL", f"http://{SERVER_IP}:6333")
COLLECTION_NAME = "tracks"
MUSIC_DIR = os.getenv("MUSIC_DIR", "/mnt/data/projects/puuk/music")
BASE_DIR = os.path.dirname(__file__)
DEFAULT_COVER_PATH = os.path.join(BASE_DIR, "default_cover.jpg")
DEFAULT_COVER_COLOR = "#13141f"
ARTIST_ARTWORK_DIR = os.getenv("ARTIST_ARTWORK_DIR", os.path.join(BASE_DIR, "artist_artwork"))
WAVE_PERSONALIZATION_WEIGHT = float(os.getenv("WAVE_PERSONALIZATION_WEIGHT", "0.35"))
# Доля exploration-пула кандидатов от чистого вектора вкуса (ширина выхода за кластер трека).
WAVE_EXPLORE_RATIO = float(os.getenv("WAVE_EXPLORE_RATIO", "0.25"))

# Тесты изолируют БД через PUUK_DB_PATH (см. test_db_path.py); по умолчанию — рабочая база.
DB_PATH = os.getenv("PUUK_DB_PATH") or os.path.join(BASE_DIR, "puuk.db")

# Доставка готовых loudness-результатов из общего Qdrant в серверный SQLite.
# heavy_worker анализирует локально и пишет в Qdrant; серверный API читает свою
# SQLite (deploy не синкает *.db), поэтому результаты нужно периодически
# забирать обратно. Интервал, блокировка владельца и таймаут Qdrant настраиваются
# отдельно от embedding-сверки (изоляция отказов: одна интеграция не валит другую).
LOUDNESS_SYNC_ENABLED = os.getenv("LOUDNESS_SYNC_ENABLED", "true").lower() in ("true", "1", "yes")
LOUDNESS_SYNC_INTERVAL_SEC = float(os.getenv("LOUDNESS_SYNC_INTERVAL_SEC", "300"))
LOUDNESS_SYNC_LOCK_PATH = os.getenv("LOUDNESS_SYNC_LOCK", "/tmp/puuk_loudness_sync.lock")
LOUDNESS_SYNC_QDRANT_TIMEOUT_SEC = float(os.getenv("LOUDNESS_SYNC_QDRANT_TIMEOUT_SEC", "15"))


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

# Delivery security configuration is centralized here. Disabled installations need
# no provider credentials; enabling any boundary validates its complete inputs.
import re as _re
import secrets as _secrets
from urllib.parse import urlsplit as _urlsplit


def _delivery_bool(name):
    value = os.getenv(name, 'false').lower()
    if value not in ('true', 'false', '1', '0', 'yes', 'no'):
        raise ValueError(f'{name}: invalid boolean')
    return value in ('true', '1', 'yes')


def _delivery_int(name, default, low, high):
    try:
        value = int(os.getenv(name, str(default)))
        if low <= value <= high:
            return value
    except ValueError:
        pass
    raise ValueError(f'{name}: invalid range')


JWT_SECRET = os.getenv('JWT_SECRET') or _secrets.token_hex(32)
JWT_EXPIRATION_DAYS = _delivery_int('JWT_EXPIRATION_DAYS', 30, 1, 365)
MEDIA_TICKET_TTL_SECONDS = _delivery_int('MEDIA_TICKET_TTL_SECONDS', 600, 60, 1800)
CDN_DELIVERY_ENABLED = _delivery_bool('CDN_DELIVERY_ENABLED')
CDN_ORIGIN_ENABLED = _delivery_bool('CDN_ORIGIN_ENABLED')
CDN_PURGE_ENABLED = _delivery_bool('CDN_PURGE_ENABLED')
CDN_BASE_URL = os.getenv('CDN_BASE_URL', 'https://media.puuk.fun')
CDN_SIGNING_SECRET = os.getenv('CDN_SIGNING_SECRET', '')
CDN_ORIGIN_SECRET = os.getenv('CDN_ORIGIN_SECRET', '')
CDN_RESOURCE_ID = os.getenv('CDN_RESOURCE_ID', '')
CDN_PURGE_TOKEN = os.getenv('CDN_PURGE_TOKEN', '')
CDN_TICKET_TTL_SECONDS = _delivery_int('CDN_TICKET_TTL_SECONDS', 1800, 60, 1800)
CDN_DELIVERY_EPOCH = os.getenv('CDN_DELIVERY_EPOCH', 'direct-v1')
if not _re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', CDN_DELIVERY_EPOCH):
    raise ValueError('CDN_DELIVERY_EPOCH: invalid identifier')
_pilot = os.getenv('CDN_PILOT_USER_IDS', '')
if _pilot and not _re.fullmatch(r'[1-9][0-9]*(,[1-9][0-9]*)*', _pilot):
    raise ValueError('CDN_PILOT_USER_IDS: expected positive database IDs')
CDN_PILOT_USER_IDS = frozenset(int(value) for value in _pilot.split(',') if value)
DELIVERY_LOCK_DIR = os.getenv('DELIVERY_LOCK_DIR', '')


def get_delivery_lock_dir():
    return DELIVERY_LOCK_DIR or os.path.join(os.path.dirname(os.path.abspath(os.getenv('PUUK_DB_PATH') or DB_PATH)), '.delivery-locks')


def validate_delivery_config():
    base = _urlsplit(CDN_BASE_URL)
    if (base.scheme != 'https' or not base.hostname or base.netloc != base.hostname
            or base.path or base.query or base.fragment or base.username):
        raise ValueError('CDN_BASE_URL: expected exact HTTPS origin')
    if CDN_ORIGIN_ENABLED or CDN_DELIVERY_ENABLED:
        if not _re.fullmatch(r'[0-9a-f]{64}', CDN_ORIGIN_SECRET):
            raise ValueError('CDN_ORIGIN_SECRET: invalid security configuration')
        if len(CDN_SIGNING_SECRET) != 32 or not _re.fullmatch(r'[!-~]{32}', CDN_SIGNING_SECRET):
            raise ValueError('CDN_SIGNING_SECRET: invalid security configuration')
        if len({JWT_SECRET, CDN_SIGNING_SECRET, CDN_ORIGIN_SECRET}) != 3:
            raise ValueError('Delivery secrets must be independent')
    if CDN_PURGE_ENABLED or CDN_DELIVERY_ENABLED:
        if not _re.fullmatch(r'[a-zA-Z0-9_-]{1,50}', CDN_RESOURCE_ID) or not CDN_PURGE_TOKEN or len(CDN_PURGE_TOKEN)>7000 or any(ord(c)<33 or ord(c)>126 for c in CDN_PURGE_TOKEN):
            raise ValueError('CDN purge: incomplete security configuration')
    return True


validate_delivery_config()
