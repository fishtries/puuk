-- Migration 002: User Embeddings, Wave Feedback & Track Stats

CREATE TABLE IF NOT EXISTS user_embeddings (
    user_id INTEGER PRIMARY KEY,
    embedding_vector BLOB NOT NULL,
    track_count INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_wave_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    track_id TEXT NOT NULL,
    event_type TEXT NOT NULL,  -- 'like', 'skip', 'finish'
    listen_duration_ms INTEGER DEFAULT 0,
    track_duration_ms INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wave_feedback_user ON user_wave_feedback(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wave_feedback_track ON user_wave_feedback(track_id);

CREATE TABLE IF NOT EXISTS track_stats (
    track_id TEXT PRIMARY KEY,
    play_count INTEGER DEFAULT 0,
    skip_count INTEGER DEFAULT 0,
    like_count INTEGER DEFAULT 0,
    avg_listen_pct REAL DEFAULT 0.0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);
