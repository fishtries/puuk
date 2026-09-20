"""Domain-partitioned SQLite repositories.

Each module owns the SQL for its aggregate; schema/bootstrap lives in schema.py.
Import from here (or the legacy `db` facade) rather than reaching into internals.
"""

from repositories.base import get_connection
from repositories.schema import init_db, apply_migrations
from repositories import (
    users,
    interactions,
    albums,
    tracks,
    playlists,
    wave,
)

__all__ = [
    "get_connection",
    "init_db",
    "apply_migrations",
    "users",
    "interactions",
    "albums",
    "tracks",
    "playlists",
    "wave",
]
