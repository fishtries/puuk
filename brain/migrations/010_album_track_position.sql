-- Migration 010: Album track position for source ordering

ALTER TABLE tracks ADD COLUMN album_track_position INTEGER;
CREATE INDEX IF NOT EXISTS idx_tracks_album_position ON tracks(album_id, album_track_position);
