import { nextCollectionRevision } from '../collectionRevision';
import { getTrackId } from '../../shared/domain/trackAdapter';
import {
  displayTrack,
  isOfflineSessionCurrent,
  readMediaKey,
  listDownloadJobs,
  cleanupUnretainedMedia,
  retryMediaCleanup,
} from '..';
import { ownerKey, notifyOfflineIndex } from '../session';
import { offlineDatabase } from '../storage';
import {
  enqueueBackgroundDownload,
  cancelBackgroundDownload,
} from '../downloads/runtime';

// One queue serializes reason changes and their scheduler side effects in this process.
let tail = Promise.resolve();
const serial = (work) => {
  const result = tail.then(work, work);
  tail = result.catch(() => {});
  return result;
};
const identity = (key) => [String(key.kind), String(key.collectionId)];
function initialize(db) {
  db.execSync(`CREATE TABLE IF NOT EXISTS retention_reason (
    owner TEXT NOT NULL, track_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
    track TEXT, PRIMARY KEY(owner, track_id, kind, id)
  );
  CREATE TABLE IF NOT EXISTS saved_collection (
    owner TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
    PRIMARY KEY(owner, kind, id)
  );`);
}
async function database(session) {
  if (!isOfflineSessionCurrent(session)) return null;
  const db = await offlineDatabase();
  if (!isOfflineSessionCurrent(session)) return null;
  initialize(db);
  const active = db.getFirstSync('SELECT * FROM activation WHERE singleton=1');
  return active?.owner === ownerKey(session.owner) &&
    active.activation_id === session.activationId
    ? db
    : null;
}
const idOf = (track) => {
  const id = getTrackId(track);
  return id == null ? null : String(id);
};

async function reconcile(session, db, owner, ids) {
  for (const id of ids) {
    if (!isOfflineSessionCurrent(session)) return;
    const reason = db.getFirstSync(
      'SELECT * FROM retention_reason WHERE owner=? AND track_id=? LIMIT 1',
      owner,
      id,
    );
    if (reason) {
      if (!(await readMediaKey(session, id))) {
        await enqueueBackgroundDownload(
          session,
          reason.track ? JSON.parse(reason.track) : id,
          `${reason.kind}:${reason.id}`,
        );
      }
    } else {
      const jobs = await listDownloadJobs(session);
      const job = jobs.find(
        (item) => String(item.trackId) === id && item.state !== 'ready',
      );
      if (job && isOfflineSessionCurrent(session))
        await cancelBackgroundDownload(session, job.jobId);
      if (isOfflineSessionCurrent(session))
        await cleanupUnretainedMedia(session, id);
    }
  }
}

// The caller supplies only a complete successful response. Duplicates remain in the snapshot,
// while retention is deduplicated by track ID.
export function saveOfflineCollection(
  session,
  key,
  { title, tracks },
  {
    selected = true,
    snapshotTracks = tracks,
    expectedUpdatedAt,
    replaceSnapshot = expectedUpdatedAt === undefined,
    requireSaved = false,
    guard = () => true,
  } = {},
) {
  return serial(async () => {
    if (!Array.isArray(tracks) || !Array.isArray(snapshotTracks)) return false;
    const normalized = tracks.map(displayTrack);
    const snapshot = snapshotTracks.map(displayTrack);
    if (normalized.some((t) => !t) || snapshot.some((t) => !t)) return false;
    const db = await database(session);
    if (!db) return false;
    const owner = ownerKey(session.owner),
      [kind, id] = identity(key);
    const old = db
      .getAllSync(
        'SELECT track_id FROM retention_reason WHERE owner=? AND kind=? AND id=?',
        owner,
        kind,
        id,
      )
      .map((r) => r.track_id);
    if (expectedUpdatedAt !== undefined) {
      const current = db.getFirstSync(
        'SELECT updated_at FROM collection WHERE owner=? AND kind=? AND id=?',
        owner,
        kind,
        id,
      );
      if ((current?.updated_at ?? null) !== expectedUpdatedAt) return false;
    }
    if (!guard() || !isOfflineSessionCurrent(session)) return false;
    if (
      requireSaved &&
      !db.getFirstSync(
        'SELECT 1 FROM saved_collection WHERE owner=? AND kind=? AND id=?',
        owner,
        kind,
        id,
      )
    )
      return false;
    db.withTransactionSync(() => {
      if (replaceSnapshot)
        db.runSync(
          'INSERT OR REPLACE INTO collection VALUES (?, ?, ?, ?, ?, ?)',
          owner,
          kind,
          id,
          title || '',
          JSON.stringify(snapshot),
          nextCollectionRevision(db, owner, kind, id),
        );
      db.runSync(
        'DELETE FROM retention_reason WHERE owner=? AND kind=? AND id=?',
        owner,
        kind,
        id,
      );
      if (selected) {
        db.runSync(
          'INSERT OR IGNORE INTO saved_collection VALUES (?, ?, ?)',
          owner,
          kind,
          id,
        );
        for (const track of normalized)
          db.runSync(
            'INSERT OR REPLACE INTO retention_reason VALUES (?, ?, ?, ?, ?)',
            owner,
            idOf(track),
            kind,
            id,
            JSON.stringify(track),
          );
      } else
        db.runSync(
          'DELETE FROM saved_collection WHERE owner=? AND kind=? AND id=?',
          owner,
          kind,
          id,
        );
    });
    notifyOfflineIndex({ type: 'collection', session, kind, collectionId: id });
    await reconcile(
      session,
      db,
      owner,
      new Set([...old, ...normalized.map(idOf)]),
    );
    return isOfflineSessionCurrent(session);
  });
}

export function removeOfflineCollection(session, key) {
  return serial(async () => {
    const db = await database(session);
    if (!db) return false;
    const owner = ownerKey(session.owner),
      [kind, id] = identity(key);
    const old = db
      .getAllSync(
        'SELECT track_id FROM retention_reason WHERE owner=? AND kind=? AND id=?',
        owner,
        kind,
        id,
      )
      .map((r) => r.track_id);
    db.withTransactionSync(() => {
      db.runSync(
        'DELETE FROM retention_reason WHERE owner=? AND kind=? AND id=?',
        owner,
        kind,
        id,
      );
      db.runSync(
        'DELETE FROM saved_collection WHERE owner=? AND kind=? AND id=?',
        owner,
        kind,
        id,
      );
      db.runSync(
        'DELETE FROM collection WHERE owner=? AND kind=? AND id=?',
        owner,
        kind,
        id,
      );
    });
    notifyOfflineIndex({ type: 'collection', session, kind, collectionId: id });
    await reconcile(session, db, owner, new Set(old));
    return isOfflineSessionCurrent(session);
  });
}

export function setRetentionReason(session, track, reason, enabled) {
  return serial(async () => {
    const db = await database(session),
      trackId = idOf(track);
    if (!db || trackId == null) return false;
    const owner = ownerKey(session.owner),
      [kind, id] = identity(reason);
    if (enabled)
      db.runSync(
        'INSERT OR REPLACE INTO retention_reason VALUES (?, ?, ?, ?, ?)',
        owner,
        trackId,
        kind,
        id,
        JSON.stringify(displayTrack(track)),
      );
    else
      db.runSync(
        'DELETE FROM retention_reason WHERE owner=? AND track_id=? AND kind=? AND id=?',
        owner,
        trackId,
        kind,
        id,
      );
    await reconcile(session, db, owner, [trackId]);
    return isOfflineSessionCurrent(session);
  });
}

// Budget admission can run inside the download scheduler. Commit the reason
// without waiting on that scheduler's mutation queue.
export async function releaseRetentionForCleanup(session, trackId, reason) {
  const db = await database(session);
  if (!db) return false;
  db.runSync('DELETE FROM retention_reason WHERE owner=? AND track_id=? AND kind=? AND id=?',
    ownerKey(session.owner), String(trackId), ...identity(reason));
  return true;
}

export async function listReasonTracks(session, reason) {
  const db = await database(session);
  if (!db) return [];
  return db.getAllSync(
    'SELECT track_id FROM retention_reason WHERE owner=? AND kind=? AND id=?',
    ownerKey(session.owner), ...identity(reason),
  ).map((row) => row.track_id);
}

export async function listRetentionReasons(session, trackId) {
  const db = await database(session);
  if (!db) return [];
  return db
    .getAllSync(
      'SELECT kind, id FROM retention_reason WHERE owner=? AND track_id=? ORDER BY kind, id',
      ownerKey(session.owner),
      String(trackId),
    )
    .map((r) => ({ kind: r.kind, collectionId: r.id }));
}
export async function isCollectionSaved(session, key) {
  const db = await database(session);
  if (!db) return false;
  return !!db.getFirstSync(
    'SELECT 1 FROM saved_collection WHERE owner=? AND kind=? AND id=?',
    ownerKey(session.owner),
    ...identity(key),
  );
}
export async function collectionProgress(session, tracks) {
  const jobs = await listDownloadJobs(session);
  const states = await Promise.all(
    tracks.map(async (track) => {
      const id = idOf(track);
      const ready = await readMediaKey(session, id);
      return {
        trackId: id,
        state: ready
          ? 'ready'
          : jobs.find((job) => String(job.trackId) === id)?.state || 'queued',
      };
    }),
  );
  return {
    total: states.length,
    ready: states.filter((item) => item.state === 'ready').length,
    tracks: states,
  };
}
export function reconcileRetention(session) {
  return serial(async () => {
    const db = await database(session);
    if (!db) return false;
    const owner = ownerKey(session.owner);
    await retryMediaCleanup(session);
    if (!isOfflineSessionCurrent(session)) return false;
    const ids = db
      .getAllSync(
        'SELECT DISTINCT track_id FROM retention_reason WHERE owner=?',
        owner,
      )
      .map((r) => r.track_id);
    await reconcile(session, db, owner, ids);
    return isOfflineSessionCurrent(session);
  });
}

export async function listSavedCollections(session) {
  const db = await database(session);
  if (!db) return [];
  return db
    .getAllSync(
      'SELECT kind, id FROM saved_collection WHERE owner=? ORDER BY kind, id',
      ownerKey(session.owner),
    )
    .map((row) => ({ kind: row.kind, collectionId: row.id }));
}
