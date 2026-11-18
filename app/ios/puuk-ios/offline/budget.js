import { Directory, Paths } from 'expo-file-system';
import { getOfflineRootUri, offlineDatabase, offlineFile } from './storage';
import {
  getOfflineSession,
  isOfflineSessionCurrent,
  ownerKey,
  notifyOfflineIndex,
} from './session';
import {
  DEFAULT_OFFLINE_BUDGET_BYTES,
  OFFLINE_DISK_MARGIN_BYTES,
} from './policy';

let tail = Promise.resolve();
let cache;
let reclaimWave;
let nativeProgress = new Map();
let nativeBytes = 0;
const reservations = new Map();

const sizeOf = (file) =>
  file?.exists ? Math.max(0, Number(file.size) || 0) : 0;
const fileSizes = (dir) => {
  const files = new Map();
  // The SDK reports null size for a directory. The children are individually counted.
  if (dir.exists && typeof dir.list === 'function') {
    for (const file of dir.list()) {
      if (file instanceof Directory) {
        for (const [uri, bytes] of fileSizes(file)) files.set(uri, bytes);
      } else files.set(file.uri, sizeOf(file));
    }
  }
  return files;
};
const sum = (values) => [...values].reduce((total, bytes) => total + bytes, 0);

export function setBudgetCache(cacheAdapter) {
  cache = cacheAdapter;
}
export function setWaveBudgetReclaimer(reclaim) {
  reclaimWave = reclaim;
}

export function updateNativeTransferProgress(transfers) {
  nativeProgress = new Map(
    transfers
      .filter(
        ({ receipt, contentLength }) =>
          !receipt && Number.isSafeInteger(contentLength) && contentLength > 0,
      )
      .map(({ operationId, bytesReceived, contentLength }) => [
        operationId,
        Math.min(contentLength, Math.max(0, Number(bytesReceived) || 0)),
      ]),
  );
  nativeBytes = sum(nativeProgress.values());
}

function transferRows(db) {
  return db.getAllSync(
    "SELECT * FROM job WHERE state IN ('transferring','verifying')",
  );
}

function inventory(db) {
  const root = getOfflineRootUri();
  const media = fileSizes(new Directory(root, 'media'));
  const staging = fileSizes(new Directory(root, 'staging'));
  const coverBytes = sum(fileSizes(new Directory(root, 'covers')).values());
  const lyricsBytes = db.getFirstSync(
    'SELECT coalesce(sum(length(CAST(result AS BLOB))), 0) AS bytes FROM lyrics',
  ).bytes;
  const ordinary = cache?.files() || new Map();
  let mediaBytes = sum(media.values());
  let transferBytes = sum(staging.values()) + nativeBytes;
  let cacheBytes = sum(ordinary.values());
  let reservedBytes = 0;
  for (const row of transferRows(db)) {
    const stage = offlineFile(row.staging_path);
    const final = offlineFile(row.final_path);
    const stagedBytes = staging.get(stage.uri) ?? sizeOf(stage);
    const finalBytes = media.get(final.uri) ?? sizeOf(final);
    const progress = nativeProgress.get(row.operation_id) || 0;
    // URLSession progress can briefly describe the file just moved into staging.
    if (stagedBytes || finalBytes) transferBytes -= progress;
    if (!staging.has(stage.uri)) transferBytes += stagedBytes;
    if (finalBytes) {
      if (media.has(final.uri)) mediaBytes -= finalBytes;
      transferBytes += finalBytes;
    }
    const written = Math.max(stagedBytes, finalBytes) || progress;
    reservedBytes += Math.max(0, row.expected_bytes - written);
  }
  for (const reservation of reservations.values()) {
    const files = new Map(reservation.files.map((file) => [file.uri, file]));
    let written = 0;
    for (const [uri, file] of files) {
      const bytes = ordinary.get(uri) ?? sizeOf(file);
      if (ordinary.has(uri)) cacheBytes -= bytes;
      written += bytes;
    }
    const observed = written || reservation.progress;
    transferBytes += observed;
    reservedBytes += Math.max(0, reservation.bytes - observed);
  }

  const usedBytes =
    mediaBytes + lyricsBytes + coverBytes + cacheBytes + transferBytes;
  const limitBytes =
    require('../shared/storage/settings').getSettings()?.offlineBudgetBytes ??
    DEFAULT_OFFLINE_BUDGET_BYTES;
  const freeBytes = Number(Paths.availableDiskSpace);
  const availableDiskBytes = Number.isFinite(freeBytes)
    ? Math.max(0, freeBytes)
    : 0;
  const accountedBytes = usedBytes + reservedBytes;
  const budgetAvailableBytes = Math.max(0, limitBytes - accountedBytes);
  const diskAvailableBytes = Math.max(
    0,
    availableDiskBytes - reservedBytes - OFFLINE_DISK_MARGIN_BYTES,
  );
  return {
    limitBytes,
    usedBytes,
    accountedBytes,
    availableDiskBytes,
    reservedBytes,
    mediaBytes,
    lyricsBytes,
    coverBytes,
    cacheBytes,
    transferBytes,
    overLimitBytes: Math.max(0, accountedBytes - limitBytes),
    availableBytes: Math.min(budgetAvailableBytes, diskAvailableBytes),
    budgetAvailableBytes,
    diskAvailableBytes,
  };
}

export async function readStorageBudget(session = getOfflineSession()) {
  if (!isOfflineSessionCurrent(session)) return null;
  const db = await offlineDatabase();
  if (!isOfflineSessionCurrent(session)) return null;
  const budget = inventory(db);
  const waiting = db.getAllSync(
    "SELECT schedule_state FROM job WHERE owner=? AND activation_id=? AND schedule_state IN ('space','network')",
    ownerKey(session.owner),
    session.activationId,
  );
  const waitingForSpace = waiting.filter(
    (row) => row.schedule_state === 'space',
  ).length;
  const waitingForNetwork = waiting.length - waitingForSpace;
  return {
    ...budget,
    waitingForSpace,
    waitingForNetwork,
    pauseReason:
      budget.overLimitBytes || waitingForSpace
        ? 'space'
        : waitingForNetwork
          ? 'network'
          : null,
  };
}

export function budgetMediaKey(owner, trackId, version) {
  return JSON.stringify([
    owner.origin,
    String(owner.userId),
    String(trackId),
    version,
  ]);
}

export function hasActiveMediaTransfer(db, owner, trackId, version) {
  return !!db.getFirstSync(
    "SELECT 1 FROM job WHERE owner=? AND track_id=? AND version=? AND state IN ('transferring','verifying') LIMIT 1",
    ownerKey(owner),
    String(trackId),
    version,
  );
}

function cleanupCompletedStaging(db) {
  for (const { staging_path: path } of db.getAllSync(
    "SELECT staging_path FROM job WHERE state='ready' AND staging_path IS NOT NULL",
  )) {
    try {
      const file = offlineFile(path);
      if (file.exists) file.delete();
    } catch {
      /* Leave space charged until cleanup can be retried. */
    }
  }
}

// All admissions, including the ordinary cache, go through this process-wide
// queue. The final eligibility check and commit must be synchronous.
export function withStorageAdmission(
  session,
  bytes,
  commit,
  {
    background = false,
    trackId,
    reclaim = true,
    allowEviction = true,
    eligible = () => true,
    inspect = () => null,
  } = {},
) {
  const result = tail.then(async () => {
    if (!isOfflineSessionCurrent(session)) return null;
    const db = await offlineDatabase();
    const allowed = () => isOfflineSessionCurrent(session) && eligible(db);
    if (!allowed()) return null;
    const existing = inspect(db);
    if (existing) return existing;
    const fits = () => {
      const state = inventory(db);
      return bytes > 0
        ? bytes <= state.availableBytes
        : state.overLimitBytes === 0 &&
            state.availableDiskBytes >=
              state.reservedBytes + OFFLINE_DISK_MARGIN_BYTES;
    };
    if (allowEviction && !fits()) cleanupCompletedStaging(db);
    if (allowEviction && !fits() && cache) {
      const state = inventory(db);
      const shortage = Math.max(
        0,
        state.accountedBytes + bytes - state.limitBytes,
        bytes +
          state.reservedBytes +
          OFFLINE_DISK_MARGIN_BYTES -
          state.availableDiskBytes,
      );
      await cache.evict((freedBytes) => freedBytes >= shortage);
    }
    if (allowEviction && !fits() && reclaim && allowed())
      await reclaimWave?.(session, fits, { background, trackId });
    if (!allowed()) return null;
    return inspect(db) || (fits() ? commit(db) : null);
  });
  tail = result.catch(() => {});
  return result;
}

export function reserveCacheTransfer(
  session,
  owner,
  trackId,
  version,
  bytes,
  eligible,
) {
  const key = budgetMediaKey(owner, trackId, version);
  return withStorageAdmission(
    session,
    bytes,
    () => {
      const reservation = {
        bytes,
        files: [],
        progress: 0,
        lastProgressEvent: 0,
      };
      reservations.set(key, reservation);
      return {
        setFiles(...files) {
          reservation.files = files;
        },
        recordProgress(written) {
          if (reservations.get(key) !== reservation) return;
          reservation.progress = Math.max(
            reservation.progress,
            Math.min(bytes, written),
          );
          const now = Date.now();
          if (
            now - reservation.lastProgressEvent >= 1000 &&
            isOfflineSessionCurrent(session)
          ) {
            reservation.lastProgressEvent = now;
            notifyOfflineIndex({ type: 'transfer-progress', session });
          }
        },
        release() {
          if (reservations.get(key) !== reservation) return;
          reservations.delete(key);
          if (isOfflineSessionCurrent(session))
            notifyOfflineIndex({ type: 'budget', session });
        },
      };
    },
    {
      reclaim: false,
      eligible: (db) =>
        eligible() &&
        !reservations.has(key) &&
        !hasActiveMediaTransfer(db, owner, trackId, version),
    },
  );
}

export const hasCacheReservation = (owner, trackId, version) =>
  reservations.has(budgetMediaKey(owner, trackId, version));

export function enforceStorageBudget(session = getOfflineSession()) {
  return withStorageAdmission(session, 0, () => true);
}
