-- Migration 014: Verified word-level lyrics storage and provenance
-- Stores validated Contract v1 wordLyrics snapshots separate from tracks.lyrics

CREATE TABLE IF NOT EXISTS track_word_lyrics (
    track_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL DEFAULT 1,
    revision TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    provenance_json TEXT,
    audio_sha256 TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    file_mtime_ns INTEGER NOT NULL,
    imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_word_lyrics_track ON track_word_lyrics(track_id);
CREATE INDEX IF NOT EXISTS idx_word_lyrics_active ON track_word_lyrics(track_id, is_active);
