-- Migration 005: Auto-detected genres via Essentia

ALTER TABLE tracks ADD COLUMN auto_genres TEXT;
ALTER TABLE tracks ADD COLUMN auto_genre_model TEXT;
ALTER TABLE tracks ADD COLUMN auto_genre_updated_at TIMESTAMP;
