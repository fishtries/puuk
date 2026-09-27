-- Migration 008: Album as a proper entity.
-- Identity = (title_normalized, album_artist_normalized).
-- The unique index is created in Python (backfill_album_identities) AFTER
-- legacy rows are normalized and duplicates merged, so it is safe to rely
-- on it everywhere.

ALTER TABLE albums ADD COLUMN album_artist TEXT;
ALTER TABLE albums ADD COLUMN year TEXT;
ALTER TABLE albums ADD COLUMN title_normalized TEXT;
ALTER TABLE albums ADD COLUMN album_artist_normalized TEXT;
ALTER TABLE albums ADD COLUMN created_at TIMESTAMP;
ALTER TABLE albums ADD COLUMN updated_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_albums_norm_title ON albums(title_normalized);
CREATE INDEX IF NOT EXISTS idx_albums_norm_artist ON albums(album_artist_normalized);
