CREATE TABLE IF NOT EXISTS artist_play_starts (
    user_id INTEGER NOT NULL,
    track_id TEXT NOT NULL,
    played_on TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, track_id, played_on),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_artist_play_starts_track_day
    ON artist_play_starts(track_id, played_on);

CREATE TABLE IF NOT EXISTS artist_artwork (
    artist_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1,
    has_artwork INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
