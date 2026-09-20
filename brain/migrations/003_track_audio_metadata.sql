-- Migration 003: Track Audio Metadata, Diagnostics, and Mutation Journal

ALTER TABLE tracks ADD COLUMN album_artist TEXT;
ALTER TABLE tracks ADD COLUMN year TEXT;
ALTER TABLE tracks ADD COLUMN genre TEXT;
ALTER TABLE tracks ADD COLUMN track_number TEXT;
ALTER TABLE tracks ADD COLUMN disc_number TEXT;
ALTER TABLE tracks ADD COLUMN comment TEXT;
ALTER TABLE tracks ADD COLUMN bitrate INTEGER;
ALTER TABLE tracks ADD COLUMN sample_rate INTEGER;
ALTER TABLE tracks ADD COLUMN channels INTEGER;
ALTER TABLE tracks ADD COLUMN format TEXT;
ALTER TABLE tracks ADD COLUMN file_size INTEGER;
ALTER TABLE tracks ADD COLUMN file_mtime_ns INTEGER;
ALTER TABLE tracks ADD COLUMN cover_version INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS track_mutation_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id TEXT NOT NULL,
    status TEXT NOT NULL, -- 'prepared', 'replaced', 'committed', 'failed'
    old_size INTEGER,
    old_mtime_ns INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mutation_journal_track ON track_mutation_journal(track_id, created_at DESC);
