CREATE TABLE IF NOT EXISTS artists (
    id TEXT PRIMARY KEY,
    normalized_name TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS track_artists (
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    artist_id TEXT NOT NULL REFERENCES artists(id),
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (track_id, artist_id),
    UNIQUE (track_id, position)
);
CREATE INDEX IF NOT EXISTS idx_track_artists_artist
    ON track_artists(artist_id, track_id);
CREATE TABLE IF NOT EXISTS album_artists (
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    artist_id TEXT NOT NULL REFERENCES artists(id),
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (album_id, artist_id),
    UNIQUE (album_id, position)
);
CREATE INDEX IF NOT EXISTS idx_album_artists_artist
    ON album_artists(artist_id, album_id);
CREATE TABLE IF NOT EXISTS artist_credit_state (
    entity_type TEXT NOT NULL CHECK (entity_type IN ('track','album')),
    entity_id TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    manual_names_json TEXT,
    source_kind TEXT NOT NULL DEFAULT 'unknown',
    source_names_json TEXT NOT NULL DEFAULT '[]',
    observed_kind TEXT NOT NULL DEFAULT 'unknown',
    observed_names_json TEXT NOT NULL DEFAULT '[]',
    recovery_album_id INTEGER,
    PRIMARY KEY (entity_type, entity_id)
);
CREATE TABLE IF NOT EXISTS artist_credit_operations (
    id TEXT PRIMARY KEY,
    actor_user_id INTEGER NOT NULL,
    request_hash TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('preview','applied','undone')),
    result_json TEXT,
    undo_result_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    applied_at TEXT,
    undone_at TEXT
);
