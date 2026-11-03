-- Migration 013: Clear corrupted album_track_position values
-- Erroneous values assigned from file-list order during Spotify import are cleared,
-- so disc_number and track_number determine canonical album track order.

UPDATE tracks SET album_track_position = NULL WHERE album_track_position IS NOT NULL;
