ALTER TABLE user_history ADD COLUMN playback_id TEXT;
ALTER TABLE user_history ADD COLUMN context TEXT;
ALTER TABLE user_history ADD COLUMN received_at TEXT;
ALTER TABLE user_wave_feedback ADD COLUMN playback_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_history_playback ON user_history(user_id, playback_id) WHERE playback_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_history_track_occurrence ON user_history(user_id, track_id, julianday(played_at) DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_playback ON user_wave_feedback(user_id, playback_id) WHERE playback_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS user_rating_operations (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    rating TEXT NOT NULL,
    PRIMARY KEY (user_id, operation_id)
);
