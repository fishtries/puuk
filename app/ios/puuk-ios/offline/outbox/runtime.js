import { AppState } from 'react-native';
import { authFetch } from '../../shared/api/api';
import { getTrackId } from '../../shared/domain/trackAdapter';
import {
  getCurrentNetworkPolicy,
  subscribeNetworkPolicy,
} from '../../utils/networkPolicy';
import { displayTrack, FAVORITES_COLLECTION, saveCollection } from '..';
import {
  createOfflineId,
  getOfflineSession,
  isOfflineSessionCurrent,
  notifyOfflineIndex,
  ownerKey,
  subscribeOfflineIndex,
} from '../session';
import { offlineDatabase } from '../storage';
import {
  createOfflineOutbox,
  createOutboxTransport,
  createSQLiteOutboxStorage,
} from '.';

async function transaction(session, work) {
  const checkSession = () => {
    if (!isOfflineSessionCurrent(session))
      throw new Error('Offline outbox session changed');
  };
  const db = await offlineDatabase();
  checkSession();
  let result;
  db.withTransactionSync(() => {
    const activation = db.getFirstSync(
      'SELECT * FROM activation WHERE singleton=1',
    );
    if (
      activation?.owner !== ownerKey(session.owner) ||
      activation.activation_id !== session.activationId
    )
      throw new Error('Offline outbox activation changed');
    result = work(db);
  });
  checkSession();
  return result;
}

const outbox = createOfflineOutbox({
  storage: createSQLiteOutboxStorage({ transaction }),
  send: createOutboxTransport({ authFetch }),
  isSessionCurrent: isOfflineSessionCurrent,
  createId: createOfflineId,
});

const RETRY_REFRESH_MS = 5000;
const REFRESH_TIMEOUT_MS = 10000;
let run;
let stopSync;
let favoritesSnapshotRevision = 0;

const online = () => getCurrentNetworkPolicy()?.isConnected !== false;
const current = (job) => run === job && isOfflineSessionCurrent(job.session);
const notify = (job, event) => {
  if (current(job)) notifyOfflineIndex({ ...event, session: job.session });
};

export const getRatingOverlay = (session) => outbox.listRatingOverlay(session);

export function overlayFavoriteTracks(tracks, ratings) {
  const byId = new Map(
    tracks.map((track) => [String(getTrackId(track)), track]),
  );
  for (const { trackId, rating, track, state } of ratings) {
    if (state === 'failed') continue;
    if (rating !== 'like' || state === 'missing') byId.delete(trackId);
    else if (!byId.has(trackId) && track) byId.set(trackId, track);
  }
  return [...byId.values()].map((track) =>
    track.is_liked ? track : { ...track, is_liked: true },
  );
}

export async function projectFavoriteTracks(session, tracks) {
  return overlayFavoriteTracks(tracks, await getRatingOverlay(session));
}

export function captureFavoritesSnapshotGuard(session) {
  const revision = favoritesSnapshotRevision;
  return () =>
    isOfflineSessionCurrent(session) && revision === favoritesSnapshotRevision;
}

export function overlayDislikeIds(dislikes, ratings) {
  const ids = new Set([...dislikes].map(String));
  for (const { trackId, rating, state } of ratings) {
    if (state === 'failed') continue;
    if (state !== 'missing' && rating === 'dislike') ids.add(trackId);
    else ids.delete(trackId);
  }
  return ids;
}

export async function getLocalRatingIds(session) {
  const [snapshot, ratings] = await Promise.all([
    outbox.readRatingSnapshot(session),
    getRatingOverlay(session),
  ]);
  const favorites = new Set(snapshot?.favoriteIds || []);
  for (const { trackId, rating, state } of ratings) {
    if (state === 'failed') continue;
    if (state !== 'missing' && rating === 'like') favorites.add(trackId);
    else favorites.delete(trackId);
  }
  return { favorites, dislikes: overlayDislikeIds(snapshot?.dislikes || [], ratings) };
}

export async function getLocalDislikeIds(session) {
  return (await getLocalRatingIds(session)).dislikes;
}

async function fetchRatings(job) {
  const { session, controller } = job;
  const request = new AbortController();
  let timer;
  let cancel;
  try {
    const timeout = new Promise((_, reject) => {
      cancel = () => {
        request.abort();
        reject(new Error('Rating refresh aborted'));
      };
      controller.signal.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(cancel, REFRESH_TIMEOUT_MS);
    });
    if (controller.signal.aborted) cancel();
    const read = async (path) => {
      const response = await authFetch(session.owner.origin + path, {
        signal: request.signal,
        retry: 0,
        timeout: REFRESH_TIMEOUT_MS,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error('Invalid rating snapshot');
      return data;
    };
    return await Promise.race([
      Promise.all([read('/api/favorites'), read('/api/dislikes')]),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', cancel);
    request.abort();
  }
}

async function refreshRatings(job) {
  const { session } = job;
  // Only operations that had settled before the GETs may be reconciled by their results.
  const before = await getRatingOverlay(session);
  if (!current(job)) return;
  const [favorites, dislikes] = await fetchRatings(job);
  if (!dislikes.every((id) => typeof id === 'string' || typeof id === 'number'))
    throw new Error('Invalid dislike snapshot');
  if (!current(job)) return;
  const reconciled = before.filter((rating) => rating.state !== 'pending');
  // Persist the authoritative base. Readers reapply the durable overlay even after restart.
  favoritesSnapshotRevision += 1;
  const saved = await saveCollection(session, FAVORITES_COLLECTION, {
    title: 'Favorites',
    tracks: favorites,
  });
  if (!current(job)) return;
  if (!saved) throw new Error('Could not save rating snapshot');
  const favoriteIds = favorites.map(getTrackId).map(String);
  await outbox.reconcileRatings(session, reconciled, favoriteIds, dislikes);
  if (!current(job)) return;
  // A rating commit during SQLite reconciliation also belongs in this projection.
  const ratings = await getRatingOverlay(session);
  job.hasRefreshed = true;
  notify(job, {
    type: 'ratings-refreshed',
    favorites,
    favoriteIds,
    dislikes,
    overlay: ratings,
    reconciled: new Set(reconciled.map((entry) => entry.operationId)),
  });
}

function schedule(job, dueAt) {
  if (!current(job)) return;
  clearTimeout(job.timer);
  if (!online()) return;
  job.timer = setTimeout(
    () => drain(job),
    Math.min(Math.max(0, dueAt - Date.now()), 2 ** 31 - 1),
  );
}

async function drainAttempt(job) {
  if (!current(job) || job.draining || !online()) return;
  job.draining = true;
  let dueAt = null;
  try {
    do {
      job.requested = false;
      const result = await outbox.drain(job.session);
      if (!current(job) || ['paused', 'unauthorized'].includes(result.state))
        return;
      dueAt = result.nextDueAt;
      if (result.settled.length)
        notify(job, { type: 'outbox-settled', settled: result.settled });
      const changed = result.settled.some(
        ({ kind, state }) =>
          (kind === 'rating' || kind === 'feedback') &&
          ['synced', 'missing'].includes(state),
      );
      job.refresh ||=
        changed || result.settled.some(({ kind }) => kind === 'rating');
      job.refreshWave ||= changed;
      if (
        job.refresh &&
        !job.requested &&
        Date.now() >= job.refreshDueAt &&
        !(dueAt != null && dueAt <= Date.now())
      ) {
        const refreshWave = job.refreshWave;
        job.refresh = false;
        job.refreshWave = false;
        try {
          await refreshRatings(job);
          job.refreshFailures = 0;
          job.refreshDueAt = 0;
          if (refreshWave)
            notify(job, {
              type: 'interactions-drained',
              settled: result.settled,
            });
        } catch (error) {
          job.refresh = true;
          job.refreshWave ||= refreshWave;
          job.refreshDueAt =
            Date.now() +
            Math.min(300000, RETRY_REFRESH_MS * 2 ** job.refreshFailures);
          if (current(job) && job.refreshFailures === 0)
            console.warn('[Outbox] Could not refresh ratings:', error.message);
          job.refreshFailures = Math.min(job.refreshFailures + 1, 6);
        }
      }
    } while (job.requested && current(job) && online());
  } catch (error) {
    if (current(job)) console.warn('[Outbox] Could not drain:', error.message);
    dueAt = Date.now() + RETRY_REFRESH_MS;
  } finally {
    job.draining = false;
  }
  if (job.refresh)
    dueAt = Math.min(
      dueAt ?? Infinity,
      job.refreshDueAt || Date.now() + RETRY_REFRESH_MS,
    );
  if (dueAt != null) schedule(job, dueAt);
}

function drain(job) {
  if (!current(job) || !online()) return Promise.resolve();
  if (job.drainPromise) return job.drainPromise;
  const promise = drainAttempt(job);
  job.drainPromise = promise;
  promise.finally(() => {
    if (job.drainPromise === promise) job.drainPromise = null;
  });
  return promise;
}

// Wait for one bounded drain attempt, including any work already in flight.
export async function waitForOutboxDrain(session) {
  const job = run;
  if (!job || job.session !== session || !current(job) || !online()) return;
  requestDrain(job);
  await job.drainPromise;
}

function requestDrain(job, refresh = false) {
  if (!job || !current(job)) return;
  job.requested = true;
  job.refresh ||= refresh;
  job.refreshWave ||= refresh;
  if (refresh) job.refreshDueAt = 0;
  clearTimeout(job.timer);
  void drain(job);
}

export function startOutboxSync() {
  stopSync?.();
  function close() {
    if (!run) return;
    clearTimeout(run.timer);
    run.controller.abort();
    outbox.cancelDrain(run.session);
    run = null;
  }
  function open(session) {
    if (!session || run?.session === session) return;
    close();
    const job = {
      session,
      controller: new AbortController(),
      refreshDueAt: 0,
      refreshFailures: 0,
    };
    run = job;
    Promise.all([getRatingOverlay(session), outbox.readRatingSnapshot(session)])
      .then(([overlay, snapshot]) => {
        if (!job.hasRefreshed)
          notify(job, { type: 'rating-overlay', overlay, snapshot });
      })
      .catch((error) => {
        if (current(job))
          console.warn('[Outbox] Could not load ratings:', error.message);
      });
    requestDrain(job, true);
  }
  const unsubSession = subscribeOfflineIndex(({ type, session }) => {
    if (type === 'closed' && run?.session === session) close();
    if (type === 'opened') open(session);
  });
  const unsubNetwork = subscribeNetworkPolicy((policy) => {
    if (policy?.isConnected !== false) requestDrain(run, true);
    else if (run) clearTimeout(run.timer);
  });
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') requestDrain(run, true);
  });
  function stop() {
    if (stopSync !== stop) return;
    stopSync = null;
    unsubSession();
    unsubNetwork();
    appState.remove();
    close();
  }
  stopSync = stop;
  open(getOfflineSession());
  return stop;
}

export async function setLocalRating(session, track, rating) {
  const dto = displayTrack(track);
  if (!dto) throw new Error('Invalid offline rating track');
  const trackId = String(dto.id);
  const result = await outbox.setRating(session, trackId, rating, dto);
  if (isOfflineSessionCurrent(session))
    notifyOfflineIndex({
      type: 'rating',
      session,
      entry: { ...result, trackId, track: dto },
    });
  requestDrain(run);
  return result;
}

export async function recordStarted(session, play) {
  await outbox.recordStarted(session, play);
  requestDrain(run);
}

export async function recordOutcome(session, play) {
  await outbox.recordOutcome(session, play);
  requestDrain(run);
}
