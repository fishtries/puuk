-- Migration 006: distinguish completed empty predictions and retry Qdrant delivery

ALTER TABLE tracks ADD COLUMN auto_genre_status TEXT;
ALTER TABLE tracks ADD COLUMN auto_genre_sync_pending INTEGER DEFAULT 0;

UPDATE tracks
SET auto_genre_status = 'classified'
WHERE auto_genres IS NOT NULL AND auto_genre_status IS NULL;

UPDATE tracks
SET auto_genre_status = 'classified'
WHERE auto_genres IS NULL
  AND auto_genre_model IS NOT NULL
  AND auto_genre_updated_at IS NOT NULL
  AND auto_genre_status IS NULL;
