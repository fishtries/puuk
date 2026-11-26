import { readWavePlan, startWavePlanSync } from './wavePlan';
import { getSettings, addSettingsListener } from '../shared/storage/settings';
import { getTrackId } from '../shared/domain/trackAdapter';
import {
  cleanupUnretainedMedia,
  displayTrack,
  listDownloadJobs,
  listPlayableTracks,
  readPlayableIds,
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
import { getLocalDislikeIds, getLocalRatingIds } from './outbox/runtime';
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
export const LOCAL_WAVE_BATCH_SIZE = 12;
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
  db.execSync(`
    CREATE TABLE IF NOT EXISTS wave_state (
      owner TEXT PRIMARY KEY, current_track TEXT, future TEXT NOT NULL, history TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wave_reserve (
      owner TEXT PRIMARY KEY, future TEXT NOT NULL
    );
  `);
  return db;
}

const selectWaveState = `SELECT state.*, reserve.future AS reserve_future
  FROM wave_state state LEFT JOIN wave_reserve reserve USING (owner)
  WHERE state.owner=?`;

export async function readWaveQueue(session = getOfflineSession()) {
  const db = await database(session);
  if (!db) return null;
  const row = db.getFirstSync(selectWaveState, ownerKey(session.owner));
  return row
    ? {
        current: JSON.parse(row.current_track),
        future: JSON.parse(row.future),
        history: JSON.parse(row.history),
        reserve: JSON.parse(row.reserve_future ?? row.future),
        localFuture: row.reserve_future != null && row.reserve_future !== row.future,
      }
    : null;
}

export async function saveWaveQueue(
  session,
  { current, future, history },
  { updateReserve = true } = {},
) {
  if (!current) return false;
  const db = await database(session);
  if (!db) return false;
  const owner = ownerKey(session.owner);
  const previous = db.getFirstSync(selectWaveState, owner);
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
  // An older snapshot used the playback queue as its download plan.
  const oldReserve = previous?.reserve_future ?? previous?.future;
  const reserve = updateReserve ? saved[1] : oldReserve ?? '[]';
  if (
    previous &&
    oldReserve === reserve &&
    [previous.current_track, previous.future, previous.history].every(
      (entry, i) => entry === saved[i],
    )
  )
    return true;
  db.withTransactionSync(() => {
    db.runSync('INSERT OR REPLACE INTO wave_state VALUES (?,?,?,?)', owner, ...saved);
    if (previous?.reserve_future !== reserve)
      db.runSync('INSERT OR REPLACE INTO wave_reserve VALUES (?,?)', owner, reserve);
  });
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
  return (queue?.reserve || []).filter((track) => {
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

function artistKey(track) {
  const artist = track?.artists?.[0]?.name ?? track?.artist;
  return typeof artist === 'string' ? artist.trim().toLowerCase() : '';
}

function pickRecommendation(plan, seed, playable, played, history, oldest, artist, favorites) {
  if (!plan) return null;
  const last = id(history.at(-1));
  const eligible = (key) => {
    if (!playable.has(key)) return false;
    if (oldest === -1) return !played.has(key);
    return key !== last || playable.size === 1;
  };
  const neighbors = seed && plan.next[id(seed)];
  const choices = Array.isArray(neighbors) ? neighbors.filter(eligible) : [];
  if (!choices.length) {
    for (const key of plan.starts) {
      if (eligible(key)) choices.push(key);
      if (choices.length === LOCAL_WAVE_BATCH_SIZE) break;
    }
  }
  if (!choices.length) return null;
  const weights = choices.map((key, rank) => {
    const sameArtist = artist && artistKey(playable.get(key)) === artist;
    const age = played.has(key) ? history.length - played.get(key) : history.length + 1;
    return Math.min(age, 8) * (favorites.has(key) ? 1.5 : 1) * (sameArtist ? 0.4 : 1) / (1 + rank);
  });
  let roll = Math.random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return choices[i];
  }
  return choices.at(-1);
}

export async function selectLocalWaveTracks(
  session,
  { current, future = [], history = [], exclude = [] },
) {
  const [library, ratings, retained, snapshot, plan] = await Promise.all([
    listPlayableTracks(session),
    getLocalRatingIds(session),
    listReasonTracks(session, WAVE_REASON),
    readWaveQueue(session),
    readWavePlan(session),
  ]);
  if (!isOfflineSessionCurrent(session)) return { tracks: [], reserveIds: new Set() };
  const reserveIds = new Set([...retained, ...(snapshot?.reserve || []).map(id)]);
  const excluded = new Set([...exclude.map(id), id(current), ...ratings.dislikes, ...(plan?.blocked || [])]);
  const playable = new Map(
    library.filter((track) => !excluded.has(id(track))).map((track) => [id(track), track]),
  );
  const tracks = future.filter((track) => playable.delete(id(track)));
  const lastPlayed = new Map(history.map((track, index) => [id(track), index]));
  const remaining = [...playable].map(([key, track]) => ({
    track,
    artist: artistKey(track),
    lastPlayed: lastPlayed.get(key) ?? -1,
    priority: Number(reserveIds.has(key)) + Number(ratings.favorites.has(key)),
    tieBreaker: Math.random(),
  }));
  remaining.sort((a, b) => a.lastPlayed - b.lastPlayed ||
    b.priority - a.priority || a.tieBreaker - b.tieBreaker);
  let artist = artistKey(tracks.at(-1) ?? current ?? history.at(-1));
  while (tracks.length < LOCAL_WAVE_BATCH_SIZE && remaining.length) {
    const seed = tracks.at(-1) ?? current;
    const key = pickRecommendation(plan, seed, playable, lastPlayed, history,
      remaining[0].lastPlayed, artist, ratings.favorites);
    let next = 0;
    if (key !== null) {
      next = remaining.findIndex(candidate => id(candidate.track) === key);
    } else if (artist && artist === remaining[0].artist) {
      next = remaining.findIndex(candidate => candidate.lastPlayed === remaining[0].lastPlayed &&
        candidate.artist && candidate.artist !== artist);
    }
    const [pick] = remaining.splice(Math.max(0, next), 1);
    playable.delete(id(pick.track));
    tracks.push(pick.track);
    artist = pick.artist;
  }
  return { tracks: [...tracks, ...remaining.map(({ track }) => track)], reserveIds };
}

export async function readOfflineWaveStatus(session = getOfflineSession(), storageBudget) {
  const queue = await readWaveQueue(session);
  if (!isOfflineSessionCurrent(session)) return null;
  const [future, jobs, budget] = await Promise.all([
    candidates(session, queue),
    listDownloadJobs(session),
    storageBudget === undefined ? readStorageBudget(session) : storageBudget,
  ]);
  const readyIds = await readPlayableIds(session, future.map(id));
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
  if (queue?.current) keep.add(id(queue.current));
  const replaced = existing.filter(trackId => !keep.has(trackId));
  const ready = await readPlayableIds(session, replaced);
  for (const trackId of replaced) {
    // Verified reserve remains available after a recommendation refresh. On
    // pressure, the reclaimer puts replaced and played entries first.
    if (ready.has(trackId)) continue;
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
  const stopPlanSync = startWavePlanSync();
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
    const ordered = (queue?.reserve || []).map(id);
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
    const ready = await readPlayableIds(session, evict);
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
    stopPlanSync();
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
