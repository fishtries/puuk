import { getSettings, addSettingsListener } from '../shared/storage/settings';
import { getTrackId } from '../shared/domain/trackAdapter';
import {
  cleanupUnretainedMedia,
  displayTrack,
  listDownloadJobs,
  listPlayableTracks,
} from './index';
import {
  listReasonTracks,
  listRetentionReasons,
  releaseRetentionForCleanup,
  setRetentionReason,
} from './collections';
import {
  getBackgroundDownloadStatus,
  subscribeBackgroundDownloadStatus,
} from './downloads/runtime';
import { getLocalDislikeIds } from './outbox/runtime';
import { offlineDatabase } from './storage';
import {
  getOfflineSession,
  isOfflineSessionCurrent,
  notifyOfflineIndex,
  ownerKey,
  subscribeOfflineIndex,
} from './session';
import {
  enforceStorageBudget,
  readStorageBudget,
  setWaveBudgetReclaimer,
} from './budget';
import { DEFAULT_WAVE_RESERVE_MINUTES } from './policy';

export const WAVE_REASON = Object.freeze({
  kind: 'wave',
  collectionId: 'reserve',
});
export const WAVE_JOB_REASON = 'wave:reserve';
const id = (track) => String(getTrackId(track));
export const waveTrackDuration = (track) =>
  Number.isFinite(track.duration) ? Math.max(0, track.duration) : 0;
const targetMinutes = () =>
  getSettings()?.waveReserveMinutes ?? DEFAULT_WAVE_RESERVE_MINUTES;
const recentLimit = 50;
const queueLimit = 400;
let activeMode;
let suppressed = new Set();

async function database(session) {
  if (!isOfflineSessionCurrent(session)) return null;
  const db = await offlineDatabase();
  if (!isOfflineSessionCurrent(session)) return null;
  db.runSync(`CREATE TABLE IF NOT EXISTS wave_state (
    owner TEXT PRIMARY KEY, current_track TEXT, future TEXT NOT NULL, history TEXT NOT NULL
  )`);
  return db;
}

export async function readWaveQueue(session = getOfflineSession()) {
  const db = await database(session);
  if (!db) return null;
  const row = db.getFirstSync(
    'SELECT * FROM wave_state WHERE owner=?',
    ownerKey(session.owner),
  );
  return row
    ? {
        current: JSON.parse(row.current_track),
        future: JSON.parse(row.future),
        history: JSON.parse(row.history),
      }
    : null;
}

export async function saveWaveQueue(session, { current, future, history }) {
  if (!current) return false;
  const db = await database(session);
  if (!db) return false;
  const owner = ownerKey(session.owner);
  const previous = db.getFirstSync(
    'SELECT * FROM wave_state WHERE owner=?',
    owner,
  );
  if (!previous || id(JSON.parse(previous.current_track)) !== id(current))
    suppressed.clear();
  const saved = [
    JSON.stringify(displayTrack(current)),
    JSON.stringify(
      future.slice(0, queueLimit).map(displayTrack).filter(Boolean),
    ),
    JSON.stringify(
      history.slice(-recentLimit).map(displayTrack).filter(Boolean),
    ),
  ];
  if (
    previous &&
    [previous.current_track, previous.future, previous.history].every(
      (entry, i) => entry === saved[i],
    )
  )
    return true;
  db.runSync(
    'INSERT OR REPLACE INTO wave_state VALUES (?,?,?,?)',
    owner,
    ...saved,
  );
  notifyOfflineIndex({ type: 'wave-queue', session });
  return true;
}

export function setWavePlaybackMode(session, mode) {
  if (!isOfflineSessionCurrent(session)) return;
  if (activeMode?.session === session && activeMode.mode === mode) return;
  activeMode = { session, mode };
  notifyOfflineIndex({ type: 'wave-mode', session });
}

async function candidates(session, queue) {
  const disliked = await getLocalDislikeIds(session);
  const seen = new Set(queue?.current ? [id(queue.current)] : []);
  return (queue?.future || []).filter((track) => {
    const key = id(track);
    if (seen.has(key) || disliked.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function desiredTracks(tracks) {
  const desired = [];
  const target = targetMinutes() * 60;
  let seconds = 0;
  for (const track of tracks) {
    if (seconds >= target) break;
    desired.push(track);
    seconds += waveTrackDuration(track);
  }
  return desired;
}

export async function selectLocalWaveTracks(
  session,
  { current, future, history = [], exclude = [] },
) {
  const [ordered, library, disliked] = await Promise.all([
    candidates(session, { current, future }),
    listPlayableTracks(session),
    getLocalDislikeIds(session),
  ]);
  if (!isOfflineSessionCurrent(session)) return { reserve: [], library: [] };
  const ready = new Set(library.map(id));
  const excluded = new Set(exclude.map(id));
  const reserve = ordered.filter(
    (track) =>
      ready.has(id(track)) &&
      !disliked.has(id(track)) &&
      !excluded.has(id(track)),
  );
  const recent = [...history, current].filter(Boolean).map(id);
  const pool = library.filter(
    (track) =>
      id(track) !== id(current) &&
      !disliked.has(id(track)) &&
      !excluded.has(id(track)),
  );
  const lastPlayed = new Map(recent.map((trackId, index) => [trackId, index]));
  pool.sort(
    (a, b) => (lastPlayed.get(id(a)) ?? -1) - (lastPlayed.get(id(b)) ?? -1),
  );
  return { reserve, library: pool };
}

export async function readOfflineWaveStatus(session = getOfflineSession()) {
  const queue = await readWaveQueue(session);
  if (!isOfflineSessionCurrent(session)) return null;
  const [future, jobs, budget, playable] = await Promise.all([
    candidates(session, queue),
    listDownloadJobs(session),
    readStorageBudget(session),
    listPlayableTracks(session),
  ]);
  const readyIds = new Set(playable.map(id));
  const verified = future.filter((track) => readyIds.has(id(track)));
  if (!isOfflineSessionCurrent(session)) return null;
  const readySeconds = verified.reduce(
    (seconds, track) => seconds + waveTrackDuration(track),
    0,
  );
  const futureIds = new Set(future.map(id));
  const state = jobs
    .filter((job) => futureIds.has(job.trackId))
    .map((job) => job.state);
  const target = targetMinutes();
  const bridge = getBackgroundDownloadStatus();
  const pauseReason =
    readySeconds >= target * 60
      ? null
      : budget?.overLimitBytes ||
          state.includes('space') ||
          future.some((track) => suppressed.has(id(track)))
        ? 'space'
        : state.includes('network')
          ? 'network'
          : bridge === 'unsupported' || bridge === 'unavailable'
            ? bridge
            : state.includes('retry')
              ? 'retry'
              : future.length &&
                  state.some((value) =>
                    ['queued', 'transferring', 'verifying'].includes(value),
                  )
                ? null
                : 'insufficient-candidates';
  return {
    mode: isOfflineSessionCurrent(activeMode?.session)
      ? activeMode.mode
      : 'idle',
    readySeconds,
    readyMinutes: readySeconds / 60,
    targetMinutes: target,
    pauseReason,
    upcomingCount: future.length,
    readyCount: verified.length,
  };
}

export function subscribeOfflineAvailability(listener) {
  const unsubscribe = subscribeOfflineIndex(listener);
  const settings = addSettingsListener(listener);
  const bridge = subscribeBackgroundDownloadStatus(listener);
  return () => {
    unsubscribe();
    settings();
    bridge();
  };
}

async function syncRetention(session) {
  const queue = await readWaveQueue(session);
  const target = desiredTracks(await candidates(session, queue));
  const existing = await listReasonTracks(session, WAVE_REASON);
  const keep = new Set(target.map(id));
  const ready = new Set((await listPlayableTracks(session)).map(id));
  if (queue?.current) keep.add(id(queue.current));
  for (const trackId of existing) {
    // Verified reserve remains available after a recommendation refresh. On
    // pressure, the reclaimer puts replaced and played entries first.
    if (keep.has(trackId) || ready.has(trackId)) continue;
    await setRetentionReason(session, trackId, WAVE_REASON, false);
  }
  if (getBackgroundDownloadStatus() !== 'available') return;
  for (const track of target) {
    if (!isOfflineSessionCurrent(session)) return;
    if (!existing.includes(id(track)) && !suppressed.has(id(track)))
      await setRetentionReason(session, track, WAVE_REASON, true);
  }
}

export function startOfflineWave() {
  let stopped = false;
  let queued = false;
  let running = false;
  const wake = async () => {
    queued = true;
    if (running) return;
    running = true;
    try {
      while (queued && !stopped) {
        queued = false;
        const session = getOfflineSession();
        if (session) {
          await syncRetention(session);
          await enforceStorageBudget(session);
        }
      }
    } catch (error) {
      if (!stopped)
        console.warn(
          '[Offline Wave] Storage reconciliation failed',
          error.message,
        );
    } finally {
      running = false;
    }
  };
  const contents = subscribeOfflineIndex(({ type }) => {
    if (type === 'closed' || type === 'opened') {
      activeMode = null;
      suppressed = new Set();
    }
    if (
      [
        'opened',
        'wave-queue',
        'rating',
        'ratings-refreshed',
        'lyrics',
      ].includes(type)
    )
      void wake();
  });
  const settings = addSettingsListener(({ key }) => {
    if (key === 'offlineBudgetBytes' || key === 'waveReserveMinutes') {
      suppressed.clear();
      void wake();
    }
  });
  const bridge = subscribeBackgroundDownloadStatus(() => {
    void wake();
  });
  setWaveBudgetReclaimer(async (session, fits, { background, trackId }) => {
    const queue = await readWaveQueue(session);
    const ordered = (queue?.future || []).map(id);
    const position = ordered.indexOf(String(trackId));
    const tracks = await listReasonTracks(session, WAVE_REASON);
    const protectedId = queue?.current ? id(queue.current) : null;
    const evict = [
      ...tracks.filter(
        (track) => track !== protectedId && !ordered.includes(track),
      ),
      ...ordered
        .slice(background && position >= 0 ? position + 1 : 0)
        .reverse()
        .filter((track) => track !== protectedId && tracks.includes(track)),
    ];
    const ready = new Set((await listPlayableTracks(session)).map(id));
    for (const track of new Set(evict)) {
      if (!isOfflineSessionCurrent(session) || fits()) break;
      if (!ready.has(track)) continue;
      const reasons = await listRetentionReasons(session, track);
      if (
        reasons.some(
          (reason) =>
            reason.kind !== WAVE_REASON.kind ||
            reason.collectionId !== WAVE_REASON.collectionId,
        )
      )
        continue;
      suppressed.add(track);
      await releaseRetentionForCleanup(session, track, WAVE_REASON);
      await cleanupUnretainedMedia(session, track);
    }
  });
  void wake();
  return () => {
    stopped = true;
    bridge();
    settings();
    contents();
    setWaveBudgetReclaimer(undefined);
  };
}

export async function waveJobPriorities(session) {
  const queue = await readWaveQueue(session);
  const planned = desiredTracks(await candidates(session, queue));
  const retained = new Set(await listReasonTracks(session, WAVE_REASON));
  return new Map(
    planned
      .filter((track) => retained.has(id(track)))
      .map((track, position) => [id(track), position]),
  );
}

async function hasOtherDownloadReason(session, trackId) {
  const reasons = await listRetentionReasons(session, trackId);
  if (
    reasons.some(
      (reason) =>
        reason.kind !== WAVE_REASON.kind ||
        reason.collectionId !== WAVE_REASON.collectionId,
    )
  )
    return true;
  return false;
}

// Keep two near positions ahead of normal replenishment, and yield a launch
// opportunity to saved collections after a bounded run of Wave work.
export function createWaveJobOrder() {
  let activation;
  let waveTurns = 0;
  return async (session, jobs, now) => {
    if (activation !== session.activationId) {
      activation = session.activationId;
      waveTurns = 0;
    }
    const positions = await waveJobPriorities(session);
    const reserve = [];
    const library = [];
    for (const job of jobs) {
      if (job.nextAttemptAt > now) continue;
      if (positions.has(job.trackId)) reserve.push(job);
      else if (
        job.reason !== WAVE_JOB_REASON ||
        (await hasOtherDownloadReason(session, job.trackId))
      )
        library.push(job);
    }
    reserve.sort((a, b) => positions.get(a.trackId) - positions.get(b.trackId));
    if (!reserve.length || !library.length) return [...reserve, ...library];
    if (
      waveTurns >= 3 ||
      (positions.get(reserve[0].trackId) >= 2 && waveTurns > 0)
    ) {
      waveTurns = 0;
      return [library[0], reserve[0], ...library.slice(1), ...reserve.slice(1)];
    }
    waveTurns += 1;
    return [reserve[0], library[0], ...reserve.slice(1), ...library.slice(1)];
  };
}
