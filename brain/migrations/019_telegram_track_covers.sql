CREATE TABLE telegram_track_covers (
    track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    image BLOB NOT NULL,
    mime TEXT NOT NULL
);
