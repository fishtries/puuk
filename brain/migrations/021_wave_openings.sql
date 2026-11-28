CREATE TABLE IF NOT EXISTS user_wave_openings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    track_ids TEXT NOT NULL
);
