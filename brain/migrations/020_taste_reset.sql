CREATE TABLE IF NOT EXISTS user_taste_resets (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reset_at TEXT NOT NULL,
    history_id INTEGER NOT NULL,
    feedback_id INTEGER NOT NULL
);
ALTER TABLE user_favorites ADD COLUMN before_taste_reset INTEGER NOT NULL DEFAULT 0;
