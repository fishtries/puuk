import { Directory, File, Paths } from 'expo-file-system';

export const getOfflineRootUri = () =>
  new Directory(Paths.document, 'puuk-offline').uri;
export const offlineFile = (path) => {
  if (!/^(?:(?:staging|media)\/[a-f0-9-]+\.(?:part|mp3)|covers\/[a-f0-9]{64}\.jpg)$/.test(path)) {
    throw new Error('Invalid offline file path');
  }
  return new File(getOfflineRootUri(), path);
};

let connection;
export function offlineDatabase() {
  if (!connection) {
    connection = (async () => {
      const root = new Directory(getOfflineRootUri());
      root.create({ intermediates: true, idempotent: true });
      for (const name of ['staging', 'media']) {
        new Directory(root, name).create({
          intermediates: true,
          idempotent: true,
        });
      }
      const { openDatabaseAsync } = require('expo-sqlite');
      const db = await openDatabaseAsync('index.sqlite', {}, root.uri);
      await db.execAsync(
        'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;',
      );
      const { user_version: version } = await db.getFirstAsync(
        'PRAGMA user_version',
      );
      if (version > 1) throw new Error('Unsupported offline index version');
      if (version === 0)
        await db.withTransactionAsync(() =>
          db.execAsync(`
        CREATE TABLE activation (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          owner TEXT NOT NULL, activation_id TEXT NOT NULL
        );
        CREATE TABLE collection (
          owner TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
          title TEXT NOT NULL, tracks TEXT NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY (owner, kind, id)
        );
        CREATE TABLE track_version (
          owner TEXT NOT NULL, track_id TEXT NOT NULL, desired_version TEXT NOT NULL,
          PRIMARY KEY (owner, track_id)
        );
        CREATE TABLE media (
          owner TEXT NOT NULL, track_id TEXT NOT NULL, version TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL, mime TEXT NOT NULL,
          track TEXT, verified_at INTEGER NOT NULL,
          PRIMARY KEY (owner, track_id, version)
        );
        CREATE TABLE lyrics (
          owner TEXT NOT NULL, track_id TEXT NOT NULL, version TEXT NOT NULL, result TEXT NOT NULL,
          PRIMARY KEY (owner, track_id, version)
        );
        CREATE TABLE job (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, activation_id TEXT NOT NULL, track_id TEXT NOT NULL,
          reason TEXT NOT NULL, operation_id TEXT UNIQUE, staging_path TEXT, final_path TEXT,
          version TEXT, expected_bytes INTEGER, mime TEXT, track TEXT, verified INTEGER,
          native_session_id TEXT, native_task_id TEXT,
          state TEXT NOT NULL DEFAULT 'queued', transport TEXT NOT NULL,
          schedule_state TEXT NOT NULL DEFAULT 'queued', attempt INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL DEFAULT 0, handled_operation TEXT,
          UNIQUE (owner, activation_id, track_id, transport)
        );
        PRAGMA user_version = 1;
      `),
        );
      return db;
    })().catch((error) => {
      connection = null;
      throw error;
    });
  }
  return connection;
}
