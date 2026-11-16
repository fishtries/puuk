CREATE TABLE IF NOT EXISTS share_entities (
 entity_type TEXT NOT NULL CHECK(entity_type IN ('track','album','artist')),
 public_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','alias','deleted')),
 target_id TEXT,
 created_at INTEGER NOT NULL DEFAULT (unixepoch()),
 changed_at INTEGER NOT NULL DEFAULT (unixepoch()),
 PRIMARY KEY(entity_type,public_id),
 CHECK((state='alias' AND target_id IS NOT NULL AND target_id<>public_id) OR (state<>'alias' AND target_id IS NULL))
);
CREATE TABLE IF NOT EXISTS track_path_claims (
 rel_path TEXT PRIMARY KEY,
 track_id TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS delivery_versions (
 track_id TEXT PRIMARY KEY,
 state TEXT NOT NULL DEFAULT 'pending',
 content_version TEXT,
 fingerprint TEXT,
 content_length INTEGER,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at REAL NOT NULL DEFAULT 0,
 lease_until REAL,
 fence TEXT,
 reason TEXT,
 changed_at REAL NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS delivery_exposures (
 track_id TEXT NOT NULL,
 content_version TEXT NOT NULL,
 ever_exposed INTEGER NOT NULL DEFAULT 1,
 max_expires_at INTEGER NOT NULL,
 retired_at REAL,
 reconciliation_needed INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(track_id,content_version)
);
CREATE TABLE IF NOT EXISTS cdn_purge_outbox (
 id TEXT PRIMARY KEY,
 track_id TEXT NOT NULL,
 path TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at REAL NOT NULL DEFAULT 0,
 first_attempt_at REAL,
 operation_started_at REAL,
 lease_until REAL,
 fence TEXT,
 operation_id TEXT,
 revision INTEGER NOT NULL DEFAULT 1,
 submitted_revision INTEGER NOT NULL DEFAULT 0,
 reason TEXT,
 drain_until REAL NOT NULL,
 created_at REAL NOT NULL DEFAULT (unixepoch()),
 changed_at REAL NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS purge_active_path ON cdn_purge_outbox(path) WHERE state IN ('pending','submitting','polling','failed');
CREATE INDEX IF NOT EXISTS purge_due ON cdn_purge_outbox(state,next_attempt_at);
CREATE TABLE IF NOT EXISTS delivery_control (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cdn_purge_requeues (
 budget_id TEXT PRIMARY KEY,
 job_id TEXT NOT NULL,
 incident_id TEXT NOT NULL,
 previous_attempts INTEGER NOT NULL,
 previous_reason TEXT,
 created_at REAL NOT NULL DEFAULT (unixepoch())
);
