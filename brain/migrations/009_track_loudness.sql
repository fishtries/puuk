-- Migration 009: Track loudness normalization metadata (EBU R128 / LUFS-I)

ALTER TABLE tracks ADD COLUMN loudness_lufs REAL;
ALTER TABLE tracks ADD COLUMN true_peak_db REAL;
ALTER TABLE tracks ADD COLUMN normalization_gain_db REAL;
ALTER TABLE tracks ADD COLUMN loudness_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE tracks ADD COLUMN loudness_analyzed_at TEXT;
ALTER TABLE tracks ADD COLUMN loudness_analysis_version TEXT;
ALTER TABLE tracks ADD COLUMN loudness_file_size INTEGER;
ALTER TABLE tracks ADD COLUMN loudness_file_mtime_ns INTEGER;
ALTER TABLE tracks ADD COLUMN loudness_error TEXT;
ALTER TABLE tracks ADD COLUMN loudness_retry_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_tracks_loudness_status ON tracks(loudness_status);
