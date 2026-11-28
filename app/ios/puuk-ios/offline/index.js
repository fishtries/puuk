import {
  hasActiveMediaTransfer, hasCacheReservation, withStorageAdmission,
} from './budget';
import { offlineCoverFile } from './artworkFiles';
import { nextCollectionRevision } from './collectionRevision';
import { getTrackId } from '../shared/domain/trackAdapter';
import { getOfflineRootUri, offlineDatabase, offlineFile } from './storage';
import {
  createOfflineId,
  getOfflineSession as getCurrentSession,
  isOfflineSessionCurrent,
  notifyOfflineIndex,
  ownerKey,
} from './session';

export { getOfflineRootUri };
export {
  getOfflineSession,
  isOfflineSessionCurrent,
  openOfflineSession,
  subscribeOfflineIndex,
} from './session';

export const LAST_PLAYED_COLLECTION = Object.freeze({
  kind: 'internal',
  collectionId: 'last-played',
});
export const FAVORITES_COLLECTION = Object.freeze({
  kind: 'favorites',
  collectionId: 'favorites',
});

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_OBJECT_BYTES = 1024 * 1024 * 1024;
const leases = new Map();
const foregroundOperations = new Set();

async function useIndex(session, fallback, action) {
  if (!isOfflineSessionCurrent(session)) return fallback;
  const db = await offlineDatabase();
  return isOfflineSessionCurrent(session)
    ? action(db, ownerKey(session.owner))
    : fallback;
}

const keyMatches = (session, key) =>
  session &&
  key?.owner &&
  ownerKey(session.owner) === ownerKey(key.owner) &&
  SHA256.test(key.contentVersion);
const mediaKey = (session, trackId, contentVersion) => ({
  owner: session.owner,
  trackId,
  contentVersion,
});

// Catalog DTOs can contain permission URLs. Store display data only.
export function displayTrack(track) {
  const id = getTrackId(track);
  if (id === null) return null;
  const {
    title,
    artist,
    artists,
    artist_id,
    album,
    album_id,
    album_artists,
    duration,
    loudness_status,
    normalization_gain_db,
    explicit,
  } = track;
  return {
    id,
    title,
    artist,
    artists,
    artist_id,
    album,
    album_id,
    album_artists,
    duration,
    loudness_status,
    normalization_gain_db,
    explicit,
  };
}

export function readCollection(session, { kind, collectionId }) {
  return useIndex(session, null, (db, owner) => {
    const row = db.getFirstSync(
      'SELECT * FROM collection WHERE owner=? AND kind=? AND id=?',
      owner,
      kind,
      String(collectionId),
    );
    return (
      row && {
        title: row.title,
        tracks: JSON.parse(row.tracks),
        updatedAt: row.updated_at,
      }
    );
  });
}

export function saveCollection(
  session,
  { kind, collectionId },
  { title, tracks },
) {
  return useIndex(session, false, (db, owner) => {
    const snapshot = tracks.map(displayTrack);
    if (snapshot.some((track) => track === null)) return false;
    db.withTransactionSync(() => db.runSync(
      'INSERT OR REPLACE INTO collection VALUES (?, ?, ?, ?, ?, ?)',
      owner,
      kind,
      String(collectionId),
      title,
      JSON.stringify(snapshot),
      nextCollectionRevision(db, owner, kind, String(collectionId)),
    ));
    notifyOfflineIndex({ type: 'collection', session, kind, collectionId });
    return true;
  });
}


// A monotonic token fences delayed metadata probes, including an A → B → A change.
function bumpVersionRevision(db, owner, trackId) {
  db.runSync('CREATE TABLE IF NOT EXISTS track_version_revision (owner TEXT NOT NULL, track_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(owner,track_id))');
  db.runSync(`INSERT INTO track_version_revision VALUES (?, ?, 1)
    ON CONFLICT(owner,track_id) DO UPDATE SET revision=revision+1`, owner, trackId);
}

export function captureDesiredVersion(session, trackId) {
  return useIndex(session, null, (db, owner) => {
    db.runSync('CREATE TABLE IF NOT EXISTS track_version_revision (owner TEXT NOT NULL, track_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(owner,track_id))');
    const id = String(trackId);
    const row = db.getFirstSync('SELECT desired_version FROM track_version WHERE owner=? AND track_id=?', owner, id);
    const revision = db.getFirstSync('SELECT revision FROM track_version_revision WHERE owner=? AND track_id=?', owner, id)?.revision || 0;
    return row?.desired_version ? { version: row.desired_version, revision } : null;
  });
}

export function confirmDesiredVersion(session, trackId, expected, version) {
  if (!SHA256.test(version) || !expected || version === expected.version) return Promise.resolve(false);
  return useIndex(session, false, (db, owner) => {
    const id = String(trackId);
    let changed = false;
    db.withTransactionSync(() => {
      const row = db.getFirstSync('SELECT desired_version FROM track_version WHERE owner=? AND track_id=?', owner, id);
      const revision = db.getFirstSync('SELECT revision FROM track_version_revision WHERE owner=? AND track_id=?', owner, id)?.revision || 0;
      const retained = db.getFirstSync('SELECT 1 FROM retention_reason WHERE owner=? AND track_id=? LIMIT 1', owner, id);
      if (!retained || row?.desired_version !== expected.version || revision !== expected.revision) return;
      db.runSync('UPDATE track_version SET desired_version=? WHERE owner=? AND track_id=?', version, owner, id);
      bumpVersionRevision(db, owner, id);
      changed = true;
    });
    if (changed) notifyOfflineIndex({ type: 'version', session, trackId: id });
    return changed;
  });
}

function findMedia(db, owner, trackId, contentVersion) {
  if (contentVersion)
    return db.getFirstSync(
      'SELECT * FROM media WHERE owner=? AND track_id=? AND version=?',
      owner,
      trackId,
      contentVersion,
    );
  return db.getFirstSync(
    `SELECT media.* FROM media
    LEFT JOIN track_version USING (owner, track_id)
    WHERE owner=? AND track_id=? AND (desired_version IS NULL OR version=desired_version)
    ORDER BY verified_at DESC LIMIT 1`,
    owner,
    trackId,
  );
}

function removeMissing(db, session, row) {
  db.withTransactionSync(() => {
    db.runSync('CREATE TABLE IF NOT EXISTS media_cleanup (path TEXT PRIMARY KEY, owner TEXT NOT NULL)');
    db.runSync('INSERT OR IGNORE INTO media_cleanup VALUES (?,?)', row.path, row.owner);
    db.runSync('DELETE FROM media WHERE path=?', row.path);
    db.runSync(
      `UPDATE job SET state='queued', schedule_state='queued', operation_id=NULL, staging_path=NULL, final_path=NULL, verified=NULL
      WHERE owner=? AND activation_id=? AND track_id=? AND version=? AND state='ready'`,
      row.owner,
      session.activationId,
      row.track_id,
      row.version,
    );
  });
  notifyOfflineIndex({
    type: 'missing',
    session,
    mediaKey: mediaKey(session, row.track_id, row.version),
  });
  void retryMediaCleanupFiles(session).catch(() => {});
}

function matchesFile(file, bytes) {
  return file.exists && file.size === bytes;
}

export function markMissing(session, key, _reason) {
  if (!keyMatches(session, key)) return Promise.resolve(false);
  return useIndex(session, false, (db, owner) => {
    const row = findMedia(db, owner, String(key.trackId), key.contentVersion);
    if (!row) return false;
    removeMissing(db, session, row);
    return true;
  });
}

function verifiedMedia(db, session, row) {
  if (!row) return null;
  const file = offlineFile(row.path);
  if (matchesFile(file, row.bytes)) return file;
  removeMissing(db, session, row);
  return null;
}

export function acquirePlayable(session, trackId, contentVersion) {
  return useIndex(session, null, (db, owner) => {
    const row = findMedia(db, owner, String(trackId), contentVersion);
    const file = verifiedMedia(db, session, row);
    if (!file) return null;
    leases.set(file.uri, (leases.get(file.uri) || 0) + 1);
    let released = false;
    return {
      uri: file.uri,
      mediaKey: mediaKey(session, row.track_id, row.version),
      release() {
        if (released) return;
        released = true;
        const count = leases.get(file.uri);
        if (count === 1) leases.delete(file.uri);
        else leases.set(file.uri, count - 1);
        if (count === 1) void retryMediaCleanup(session).catch(() => {});
      },
    };
  });
}

export async function readMediaKey(session, trackId, contentVersion) {
  const key = await useIndex(session, null, (db, owner) => {
    const row = findMedia(db, owner, String(trackId), contentVersion);
    return verifiedMedia(db, session, row) ? mediaKey(session, row.track_id, row.version) : null;
  });
  return isOfflineSessionCurrent(session) ? key : null;
}

// Check only the displayed collection or reserve, yielding between batches on large libraries.
export async function readPlayableIds(session, trackIds) {
  const ids = [...new Set(trackIds.filter(id => id != null).map(String))];
  const ready = new Set();
  const batchSize = 32;
  for (let start = 0; start < ids.length; start += batchSize) {
    if (start) await new Promise(resolve => setTimeout(resolve, 0));
    if (!isOfflineSessionCurrent(session)) return new Set();
    const batch = ids.slice(start, start + batchSize);
    await useIndex(session, null, (db, owner) => {
      const rows = db.getAllSync(
        `SELECT m.track_id, m.owner, m.path, m.version, m.bytes FROM media m
         LEFT JOIN track_version USING (owner, track_id)
         WHERE m.owner=? AND m.track_id IN (${batch.map(() => '?').join(',')})
           AND (desired_version IS NULL OR m.version=desired_version)
         ORDER BY m.verified_at DESC`, owner, ...batch,
      );
      const seen = new Set();
      for (const row of rows) {
        if (seen.has(row.track_id)) continue;
        seen.add(row.track_id);
        if (verifiedMedia(db, session, row)) ready.add(row.track_id);
      }
    });
  }
  return isOfflineSessionCurrent(session) ? ready : new Set();
}

export function listPlayableTracks(session) {
  return useIndex(session, [], async (db, owner) => {
    const rows = await db.getAllAsync(
      `SELECT m.* FROM media m JOIN track_version v ON v.owner=m.owner AND
       v.track_id=m.track_id AND v.desired_version=m.version WHERE m.owner=?
       ORDER BY m.verified_at DESC, m.track_id`, owner,
    );
    const tracks = [];
    let sliceStart = Date.now();
    for (const row of rows) {
      if (Date.now() - sliceStart >= 6) {
        await new Promise(resolve => setTimeout(resolve, 0));
        sliceStart = Date.now();
      }
      if (!isOfflineSessionCurrent(session)) return [];
      if (matchesFile(offlineFile(row.path), row.bytes)) {
        tracks.push(row.track ? JSON.parse(row.track) : { id: row.track_id });
      } else if (db.getFirstSync('SELECT 1 FROM media WHERE path=?', row.path)) {
        // A publication or cleanup may have replaced this row since the snapshot.
        removeMissing(db, session, row);
      }
    }
    return tracks;
  });
}

export function readLyrics(session, key) {
  const unknown = { state: 'unknown' };
  if (!keyMatches(session, key)) return Promise.resolve(unknown);
  return useIndex(session, unknown, (db, owner) => {
    const row = db.getFirstSync(
      'SELECT result FROM lyrics WHERE owner=? AND track_id=? AND version=?',
      owner,
      String(key.trackId),
      key.contentVersion,
    );
    return row ? JSON.parse(row.result) : unknown;
  });
}

export function saveLyricsResult(session, key, result) {
  if (
    !keyMatches(session, key) ||
    !['ready', 'absent', 'unknown'].includes(result?.state) ||
    (result.state === 'ready' && !result.payload)
  )
    return Promise.resolve(false);
  return useIndex(session, false, (db, owner) => {
    const previous = db.getFirstSync(
      'SELECT result FROM lyrics WHERE owner=? AND track_id=? AND version=?',
      owner,
      String(key.trackId),
      key.contentVersion,
    );
    if (
      result.state === 'unknown' &&
      previous &&
      JSON.parse(previous.result).state !== 'unknown'
    )
      return false;
    db.runSync(
      'INSERT OR REPLACE INTO lyrics VALUES (?, ?, ?, ?)',
      owner,
      String(key.trackId),
      key.contentVersion,
      JSON.stringify(result),
    );
    notifyOfflineIndex({ type: 'lyrics', session, mediaKey: key });
    return true;
  });
}

const findJob = (db, session, owner, jobId) =>
  db.getFirstSync(
    'SELECT * FROM job WHERE id=? AND owner=? AND activation_id=?',
    jobId,
    owner,
    session.activationId,
  );

export function queueDownload(session, trackId, reason, track) {
  return useIndex(session, null, (db, owner) => {
    const id = String(trackId);
    const transport =
      reason === 'foreground-favorites' ? 'foreground' : 'background';
    db.runSync(
      `INSERT OR IGNORE INTO job (id, owner, activation_id, track_id, reason, transport)
      VALUES (?, ?, ?, ?, ?, ?)`,
      createOfflineId(),
      owner,
      session.activationId,
      id,
      typeof reason === 'string' ? reason : JSON.stringify(reason ?? null),
      transport,
    );
    db.runSync(
      `UPDATE job SET state='queued', schedule_state='queued', operation_id=NULL, staging_path=NULL, final_path=NULL, verified=NULL
       WHERE owner=? AND activation_id=? AND track_id=? AND transport=? AND state='ready'
       AND (EXISTS (SELECT 1 FROM track_version v WHERE v.owner=job.owner AND v.track_id=job.track_id AND v.desired_version<>job.version)
       OR NOT EXISTS (SELECT 1 FROM media m WHERE m.owner=job.owner AND m.track_id=job.track_id AND m.version=job.version))`,
      owner, session.activationId, id, transport,
    );
    if (track && typeof track === 'object') {
      db.runSync(
        "UPDATE job SET track=? WHERE owner=? AND activation_id=? AND track_id=? AND transport=? AND state='queued'",
        JSON.stringify(displayTrack(track)), owner, session.activationId, id, transport,
      );
    }
    const job = db.getFirstSync(
      'SELECT id FROM job WHERE owner=? AND activation_id=? AND track_id=? AND transport=?',
      owner,
      session.activationId,
      id,
      transport,
    );
    return { jobId: job.id };
  });
}

export function reserveTransfer(session, jobId, descriptor, { localCopy = false } = {}) {
  const {
    trackId,
    contentLength,
    contentVersion,
    track,
    mime = 'audio/mpeg',
  } = descriptor;
  if (
    !SHA256.test(contentVersion) ||
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > MAX_OBJECT_BYTES
  )
    return Promise.resolve(null);
  const owner = session && ownerKey(session.owner);
  const eligible = (db) => {
    const job = findJob(db, session, owner, jobId);
    return job?.track_id === String(trackId) &&
      ['queued', 'ready'].includes(job.state) && job.schedule_state !== 'cancelled';
  };
  const inspect = (db) => {
    if (hasCacheReservation(session.owner, trackId, contentVersion) ||
        hasActiveMediaTransfer(db, session.owner, trackId, contentVersion))
      return { waitingForTransfer: true };
    const existing = findMedia(db, owner, String(trackId), contentVersion);
    if (!existing || !matchesFile(offlineFile(existing.path), contentLength)) return null;
    db.withTransactionSync(() => {
      bumpVersionRevision(db, owner, String(trackId));
      db.runSync('INSERT OR REPLACE INTO track_version VALUES (?, ?, ?)', owner, String(trackId), contentVersion);
      db.runSync("UPDATE job SET state='ready', schedule_state='ready', version=? WHERE id=?", contentVersion, jobId);
    });
    return { mediaKey: mediaKey(session, String(trackId), contentVersion) };
  };
  return useIndex(session, null, (db) => {
    if (!eligible(db)) return null;
    const job = findJob(db, session, owner, jobId);
    return withStorageAdmission(session, contentLength, () => {
    const operationId = createOfflineId();
    const stagingPath = `staging/${operationId}.part`;
    const finalPath = `media/${operationId}.mp3`;
    db.withTransactionSync(() => {
      bumpVersionRevision(db, owner, job.track_id);
      db.runSync(
        'INSERT OR REPLACE INTO track_version VALUES (?, ?, ?)',
        owner,
        job.track_id,
        contentVersion,
      );
      db.runSync(
        `UPDATE job SET operation_id=?, staging_path=?, final_path=?, version=?, expected_bytes=?, mime=?,
        track=?, state='transferring', verified=NULL, native_session_id=NULL, native_task_id=NULL WHERE id=?`,
        operationId,
        stagingPath,
        finalPath,
        contentVersion,
        contentLength,
        mime,
        JSON.stringify(track ? displayTrack(track) : null),
        jobId,
      );
    });
    if (job.transport === 'foreground') foregroundOperations.add(operationId);
    return {
      jobId,
      operationId,
      stagingPath,
      stagingUri: offlineFile(stagingPath).uri,
    };
    }, { trackId, background: job.transport === 'background', allowEviction: !localCopy, eligible, inspect });
  });
}

export function attachNativeTask(
  session,
  jobId,
  operationId,
  { nativeSessionId, nativeTaskId },
) {
  return useIndex(session, false, (db, owner) =>
    Boolean(
      db.runSync(
        `UPDATE job SET native_session_id=?, native_task_id=? WHERE id=? AND operation_id=? AND owner=?
      AND activation_id=? AND state='transferring'`,
        String(nativeSessionId),
        String(nativeTaskId),
        jobId,
        operationId,
        owner,
        session.activationId,
      ).changes,
    ),
  );
}

function finishPublication(db, session, job) {
  const desired = db.getFirstSync(
    'SELECT desired_version FROM track_version WHERE owner=? AND track_id=?',
    job.owner,
    job.track_id,
  );
  if (desired?.desired_version !== job.version) return null;

  const stage = offlineFile(job.staging_path);
  const final = offlineFile(job.final_path);
  const existing = findMedia(db, job.owner, job.track_id, job.version);
  const alreadyReady =
    existing && matchesFile(offlineFile(existing.path), job.expected_bytes);
  if (!alreadyReady && !final.exists) {
    if (!matchesFile(stage, job.expected_bytes)) return null;
    // SDK 58 same-volume moveSync uses the native rename without yielding to JS.
    stage.moveSync(final, { overwrite: false });
  }
  if (!alreadyReady && !matchesFile(final, job.expected_bytes)) return null;
  db.withTransactionSync(() => {
    if (!alreadyReady) {
      db.runSync(
        'INSERT OR REPLACE INTO media VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        job.owner,
        job.track_id,
        job.version,
        job.final_path,
        job.expected_bytes,
        job.mime,
        job.track,
        Date.now(),
      );
    }
    db.runSync(
      "UPDATE job SET state='ready', schedule_state='ready' WHERE id=? AND operation_id=?",
      job.id,
      job.operation_id,
    );
  });
  try {
    if (alreadyReady && stage.exists) stage.delete();
  } catch {
    /* The published file is independent of staging. */
  }
  foregroundOperations.delete(job.operation_id);
  const key = mediaKey(session, job.track_id, job.version);
  notifyOfflineIndex({ type: 'published', session, mediaKey: key });
  void pruneSupersededMedia(session, job.track_id).then(() => retryMediaCleanupFiles(session)).catch(() => {});
  void retryMediaCleanup(session).catch(() => {});
  return key;
}

export function publishVerifiedDownload(
  session,
  { jobId, operationId, receipt },
) {
  return useIndex(session, null, (db, owner) => {
    const job = findJob(db, session, owner, jobId);
    if (
      !job ||
      job.operation_id !== operationId ||
      job.schedule_state === 'cancelled' ||
      receipt?.stagingPath !== job.staging_path ||
      receipt.status !== 200 ||
      receipt.bytes !== job.expected_bytes ||
      receipt.sha256 !== job.version
    )
      return null;
    if (job.state === 'ready') {
      const existing = findMedia(db, owner, job.track_id, job.version);
      return existing &&
        matchesFile(offlineFile(existing.path), job.expected_bytes)
        ? mediaKey(session, job.track_id, job.version)
        : null;
    }
    if (job.state !== 'transferring' && job.state !== 'verifying') return null;
    if (
      job.state === 'transferring' &&
      !matchesFile(offlineFile(job.staging_path), job.expected_bytes)
    )
      return null;
    // Durable verification receipt precedes file rename. A restart can finish either side of it.
    db.runSync(
      "UPDATE job SET state='verifying', verified=1 WHERE id=?",
      jobId,
    );
    return finishPublication(db, session, job);
  });
}

export function resetTransfer(session, jobId, operationId) {
  const foreground = foregroundOperations.delete(operationId);
  if (foreground && !isOfflineSessionCurrent(session)) {
    const active = getCurrentSession();
    if (active) {
      void reapInactiveTransfers(active, [], { foregroundOnly: true }).catch(() => {});
    }
  }
  return useIndex(session, false, (db, owner) => {
    const job = findJob(db, session, owner, jobId);
    if (
      !job ||
      job.operation_id !== operationId ||
      !['transferring', 'verifying'].includes(job.state)
    )
      return false;
    for (const path of [job.staging_path, job.final_path]) {
      const file = offlineFile(path);
      if (file.exists && !leases.has(file.uri)) file.delete();
    }
    db.runSync(
      `UPDATE job SET state='queued', operation_id=NULL, staging_path=NULL, final_path=NULL,
      verified=NULL, native_session_id=NULL, native_task_id=NULL WHERE id=?`,
      jobId,
    );
    notifyOfflineIndex({ type: 'budget', session });
    void retryMediaCleanup(session).catch(() => {});
    return true;
  });
}

export async function reconcileTransfers(
  session,
  {
    receipts = [],
    tasks = [],
    foregroundOnly = false,
    backgroundOnly = false,
  } = {},
) {
  for (const completion of receipts)
    await publishVerifiedDownload(session, completion);
  const jobs = await useIndex(session, [], (db, owner) =>
    db.getAllSync(
      "SELECT * FROM job WHERE owner=? AND activation_id=? AND state IN ('transferring','verifying')",
      owner,
      session.activationId,
    ),
  );
  for (const job of jobs) {
    if (foregroundOnly && job.transport !== 'foreground') continue;
    if (backgroundOnly && job.transport !== 'background') continue;
    if (
      tasks.some(
        (task) =>
          task.jobId === job.id && task.operationId === job.operation_id,
      )
    )
      continue;
    if (
      job.schedule_state !== 'cancelled' && job.verified &&
      (await useIndex(session, null, (db) => {
        const current = findJob(db, session, job.owner, job.id);
        return current?.state === 'verifying' &&
          current.operation_id === job.operation_id
          ? finishPublication(db, session, current)
          : null;
      }))
    )
      continue;
    await resetTransfer(session, job.id, job.operation_id);
  }
}

// S2 calls this only after reconciling native tasks. Stale activations can
// never publish, and an in-process S1 writer keeps its own operation pinned.
export async function reapInactiveTransfers(session, liveOperations, { foregroundOnly = false } = {}) {
  const stillCurrent = () => session ? isOfflineSessionCurrent(session) : !getCurrentSession();
  if (!stillCurrent()) return;
  const db = await offlineDatabase();
  if (!stillCurrent()) return;
  const live = new Set(liveOperations);
  const rows = db.getAllSync(
    "SELECT * FROM job WHERE state IN ('transferring','verifying') AND (? IS NULL OR activation_id<>? OR owner<>?)",
    session?.activationId ?? null, session?.activationId ?? null, session ? ownerKey(session.owner) : '',
  );
  for (const row of rows) {
    if (foregroundOnly && row.transport !== 'foreground') continue;
    if (live.has(row.operation_id) || foregroundOperations.has(row.operation_id)) continue;
    try {
      for (const path of [row.staging_path, row.final_path]) {
        if (!path || db.getFirstSync('SELECT 1 FROM media WHERE path=?', path)) continue;
        const file = offlineFile(path);
        if (file.exists && !leases.has(file.uri)) file.delete();
      }
      db.runSync(`UPDATE job SET state='queued', schedule_state='cancelled', operation_id=NULL,
        staging_path=NULL, final_path=NULL, verified=NULL, native_session_id=NULL, native_task_id=NULL
        WHERE id=? AND operation_id=?`, row.id, row.operation_id);
    } catch { /* A failed cleanup stays charged for a later reconciliation. */ }
  }
}

export function listDownloadJobs(session) {
  return useIndex(session, [], (db, owner) =>
    db
      .getAllSync(
        "SELECT * FROM job WHERE owner=? AND activation_id=? AND transport='background'",
        owner,
        session.activationId,
      )
      .map((row) => ({
        jobId: row.id,
        operationId: row.operation_id,
        trackId: row.track_id,
        track: row.track ? JSON.parse(row.track) : null,
        state: row.schedule_state,
        attempt: row.attempt,
        nextAttemptAt: row.next_attempt_at,
        handledOperation: row.handled_operation,
        reason: row.reason,
      })),
  );
}

export function saveDownloadSchedule(
  session,
  { jobId, state, attempt, nextAttemptAt, handledOperation },
) {
  return useIndex(session, false, (db, owner) => {
    let changed = false;
    db.withTransactionSync(() => {
      if (state === 'cancelled') {
        const job = findJob(db, session, owner, jobId);
        if (!job || job.state === 'ready') return;
        const exists = (name) => db.getFirstSync(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name,
        );
        if (exists('retention_reason') && db.getFirstSync(
          'SELECT 1 FROM retention_reason WHERE owner=? AND track_id=? LIMIT 1', owner, job.track_id,
        )) return;
        if (exists('outbox_rating') && db.getFirstSync(
          "SELECT 1 FROM outbox_rating WHERE owner=? AND track_id=? AND rating='like' AND state='pending'", owner, job.track_id,
        )) return;
      }
      changed = Boolean(db.runSync(
        `UPDATE job SET schedule_state=?, attempt=?, next_attempt_at=?, handled_operation=?
         WHERE id=? AND owner=? AND activation_id=? AND transport='background'`,
        state, attempt, nextAttemptAt, handledOperation ?? null, jobId, owner, session.activationId,
      ).changes);
    });
    return changed;
  });
}

// Once the desired version is published, retire older copies, deferring leased files.
export function pruneSupersededMedia(session, trackId) {
  return useIndex(session, false, (db, owner) => {
    db.runSync('CREATE TABLE IF NOT EXISTS media_cleanup (path TEXT PRIMARY KEY, owner TEXT NOT NULL)');
    db.runSync('CREATE TABLE IF NOT EXISTS media_superseded_pending (owner TEXT NOT NULL, track_id TEXT NOT NULL, PRIMARY KEY(owner,track_id))');
    let pending = false;
    db.withTransactionSync(() => {
      const desired = db.getFirstSync('SELECT desired_version FROM track_version WHERE owner=? AND track_id=?', owner, String(trackId));
      if (!desired || !findMedia(db, owner, String(trackId), desired.desired_version)) return;
      const rows = db.getAllSync('SELECT path FROM media WHERE owner=? AND track_id=? AND version<>?', owner, String(trackId), desired.desired_version);
      for (const row of rows) {
        if (leases.has(offlineFile(row.path).uri)) { pending = true; continue; }
        db.runSync('INSERT OR IGNORE INTO media_cleanup VALUES (?,?)', row.path, owner);
        db.runSync('DELETE FROM media WHERE owner=? AND path=?', owner, row.path);
      }
      if (pending) db.runSync('INSERT OR IGNORE INTO media_superseded_pending VALUES (?,?)', owner, String(trackId));
      else db.runSync('DELETE FROM media_superseded_pending WHERE owner=? AND track_id=?', owner, String(trackId));
    });
    return true;
  });
}

// S3 may call this only after its own durable reason has been removed. A tombstone
// is committed before unlink so a crash can finish cleanup without reusing a path.
export function cleanupUnretainedMedia(session, trackId) {
  return useIndex(session, false, (db, owner) => {
    db.runSync(`CREATE TABLE IF NOT EXISTS media_cleanup (
      path TEXT PRIMARY KEY, owner TEXT NOT NULL
    )`);
    db.runSync('CREATE TABLE IF NOT EXISTS media_cleanup_pending (owner TEXT NOT NULL, track_id TEXT NOT NULL, PRIMARY KEY(owner,track_id))');
    db.runSync('INSERT OR IGNORE INTO media_cleanup_pending VALUES (?,?)', owner, String(trackId));
    let allowed = false;
    db.withTransactionSync(() => {
      const exists = (name) => db.getFirstSync("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
      if (exists('retention_reason') && db.getFirstSync('SELECT 1 FROM retention_reason WHERE owner=? AND track_id=? LIMIT 1', owner, String(trackId))) return;
      if (exists('outbox_rating') && db.getFirstSync("SELECT 1 FROM outbox_rating WHERE owner=? AND track_id=? AND rating='like' AND state='pending'", owner, String(trackId))) return;
      // A foreground save and any in-flight publisher independently own their files.
      if (db.getFirstSync("SELECT 1 FROM job WHERE owner=? AND track_id=? AND (transport='foreground' OR state IN ('transferring','verifying')) LIMIT 1", owner, String(trackId))) return;
      const rows = db.getAllSync('SELECT path FROM media WHERE owner=? AND track_id=?', owner, String(trackId));
      if (rows.some((row) => leases.has(offlineFile(row.path).uri))) return;
      for (const row of rows) db.runSync('INSERT OR IGNORE INTO media_cleanup VALUES (?,?)', row.path, owner);
      db.runSync('DELETE FROM media WHERE owner=? AND track_id=?', owner, String(trackId));
      db.runSync('DELETE FROM lyrics WHERE owner=? AND track_id=?', owner, String(trackId));
      const cover = offlineCoverFile(session.owner, String(trackId));
      db.runSync('INSERT OR IGNORE INTO media_cleanup VALUES (?,?)', `covers/${cover.uri.split('/').pop()}`, owner);
      db.runSync('DELETE FROM media_cleanup_pending WHERE owner=? AND track_id=?', owner, String(trackId));
      allowed = true;
    });
    if (allowed) {
      for (const row of db.getAllSync('SELECT path FROM media_cleanup WHERE owner=?', owner)) {
        try {
          const file = offlineFile(row.path);
          if (leases.has(file.uri)) continue;
          if (file.exists) file.delete();
          db.runSync('DELETE FROM media_cleanup WHERE path=? AND owner=?', row.path, owner);
        } catch { /* Retry this unique path on the next cleanup. */ }
      }
      notifyOfflineIndex({ type: 'missing', session, trackId: String(trackId) });
    }
    return allowed;
  });
}

export async function retryMediaCleanup(session) {
  const pending = await useIndex(session, [], (db, owner) => {
    db.runSync('CREATE TABLE IF NOT EXISTS media_cleanup_pending (owner TEXT NOT NULL, track_id TEXT NOT NULL, PRIMARY KEY(owner,track_id))');
    db.runSync('CREATE TABLE IF NOT EXISTS media_superseded_pending (owner TEXT NOT NULL, track_id TEXT NOT NULL, PRIMARY KEY(owner,track_id))');
    db.runSync('CREATE TABLE IF NOT EXISTS media_cleanup (path TEXT PRIMARY KEY, owner TEXT NOT NULL)');
    cleanupMediaFiles(db, owner, session);
    return { removed: db.getAllSync('SELECT track_id FROM media_cleanup_pending WHERE owner=?', owner).map((row) => row.track_id), superseded: db.getAllSync('SELECT track_id FROM media_superseded_pending WHERE owner=?', owner).map((row) => row.track_id) };
  });
  if (!pending || Array.isArray(pending)) return;
  for (const id of pending.removed) await cleanupUnretainedMedia(session, id);
  for (const id of pending.superseded) await pruneSupersededMedia(session, id);
  if (pending.superseded.length) await retryMediaCleanupFiles(session);
}

async function retryMediaCleanupFiles(session) {
  return useIndex(session, false, (db, owner) => {
    cleanupMediaFiles(db, owner, session);
    return true;
  });
}

function cleanupMediaFiles(db, owner, session) {
  let freed = false;
  for (const row of db.getAllSync('SELECT path FROM media_cleanup WHERE owner=?', owner)) {
    try {
      const file = offlineFile(row.path);
      if (leases.has(file.uri)) continue;
      if (file.exists) {
        file.delete();
        freed = true;
      }
      db.runSync('DELETE FROM media_cleanup WHERE path=? AND owner=?', row.path, owner);
    } catch { /* Leave the tombstone for a later retry. */ }
  }
  if (freed) notifyOfflineIndex({ type: 'budget', session });
}
