ALTER TABLE playlist_tracks RENAME TO playlist_tracks_before_occurrences;
CREATE TABLE playlist_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    import_slot TEXT
);
INSERT INTO playlist_tracks (playlist_id,track_id,position,added_at)
    SELECT playlist_id,track_id,position,added_at FROM playlist_tracks_before_occurrences
    WHERE playlist_id IS NOT NULL AND track_id IS NOT NULL;
DROP TABLE playlist_tracks_before_occurrences;
CREATE INDEX idx_playlist_tracks_order ON playlist_tracks(playlist_id,position,id);
CREATE INDEX idx_playlist_tracks_track ON playlist_tracks(track_id);
CREATE UNIQUE INDEX idx_playlist_tracks_import_slot ON playlist_tracks(playlist_id,import_slot)
    WHERE import_slot IS NOT NULL;
CREATE TABLE telegram_playlist_imports (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    playlist_id INTEGER NOT NULL UNIQUE REFERENCES playlists(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id,source)
);
CREATE TABLE telegram_track_imports (
    source TEXT PRIMARY KEY,
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    sha256 TEXT NOT NULL,
    evidence TEXT NOT NULL
);
CREATE INDEX idx_telegram_track_imports_hash ON telegram_track_imports(sha256);
CREATE TABLE user_saved_albums (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id,album_id)
);
CREATE TABLE telegram_album_covers (
    album_id INTEGER PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
    image BLOB NOT NULL,
    mime TEXT NOT NULL
);
CREATE TABLE telegram_playlist_positions (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    slot TEXT NOT NULL,
    source_rank INTEGER NOT NULL,
    display_position INTEGER NOT NULL,
    title TEXT NOT NULL,
    track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL,
    removed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (playlist_id,slot)
);
CREATE TABLE user_saved_playlists (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id,playlist_id)
);
ALTER TABLE tracks ADD COLUMN audio_review_blocked INTEGER NOT NULL DEFAULT 0;
CREATE TABLE recording_reviews (
    id INTEGER PRIMARY KEY,
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    revision TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued',
    file_path TEXT NOT NULL,
    source TEXT NOT NULL,
    retry_at REAL NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    UNIQUE (track_id,revision)
);
CREATE TABLE telegram_import_analysis (
    track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    revision TEXT NOT NULL,
    refresh INTEGER NOT NULL
);
CREATE TABLE retired_import_paths (
    rel_path TEXT PRIMARY KEY,
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE
);
