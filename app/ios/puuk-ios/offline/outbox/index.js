export { createSQLiteOutboxStorage } from './storage';
export { createOutboxTransport } from './transport';

const MAX_BATCH = 50;
const MAX_DURATION_MS = 86400000;
const ratings = new Set(['like', 'dislike', 'neutral']);
const contexts = new Set(['manual', 'wave', 'unknown']);

function validateTrackId(trackId) {
  if (
    typeof trackId !== 'string' ||
    !trackId ||
    trackId === '.' ||
    trackId === '..' ||
    /[/\\\x00-\x1f]/.test(trackId)
  ) {
    throw new TypeError('Invalid outbox track ID');
  }
}

function playbackBody({
  trackId,
  playbackId,
  occurredAt,
  context = 'unknown',
}) {
  validateTrackId(trackId);
  if (
    typeof playbackId !== 'string' ||
    !playbackId ||
    playbackId.length > 128 ||
    typeof occurredAt !== 'string' ||
    !/(Z|[+-]\d{2}:\d{2})$/i.test(occurredAt) ||
    !Number.isFinite(Date.parse(occurredAt)) ||
    !contexts.has(context)
  ) {
    throw new TypeError('Invalid playback identity or time');
  }
  return { playback_id: playbackId, occurred_at: occurredAt, context };
}

function validDuration(ms) {
  return Number.isSafeInteger(ms) && ms >= 0 && ms <= MAX_DURATION_MS;
}

function retryDelay(job, outcome, now, random) {
  const backoff = Math.min(300000, 1000 * 2 ** Math.min(job.attempts, 10));
  if (!outcome.rateLimited) return Math.round(backoff * (0.5 + random() / 2));
  const raw = outcome.retryAfter?.trim();
  const retryAfter =
    raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now;
  return Math.max(
    backoff,
    Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : 60000,
  );
}

function sameSession(a, b) {
  return (
    a &&
    b &&
    a.activationId === b.activationId &&
    a.generation === b.generation &&
    a.owner.origin === b.owner.origin &&
    a.owner.userId === b.owner.userId
  );
}

export function createOfflineOutbox({
  storage,
  send,
  isSessionCurrent,
  createId,
  now = Date.now,
  random = Math.random,
}) {
  let running;
  let unauthorizedSession;

  const requireSession = (session) => {
    if (!isSessionCurrent(session))
      throw new Error('Offline outbox session changed');
  };

  const write = async (session, action) => {
    requireSession(session);
    const result = await action();
    requireSession(session);
    return result;
  };

  async function deliver(session, signal) {
    const settled = [];
    const isActive = () => !signal.aborted && isSessionCurrent(session);
    for (let count = 0; count < MAX_BATCH && isActive(); count += 1) {
      const job = await storage.claim(session, now());
      if (!job || !isActive()) break;

      const outcome = await send(session, job, signal);
      if (outcome.state === 'unauthorized') {
        if (isActive()) unauthorizedSession = session;
        return { state: 'unauthorized', settled };
      }
      if (!isActive() || outcome.state === 'cancelled')
        return { state: 'paused', settled };

      const disposition =
        outcome.state === 'retry'
          ? {
              ...outcome,
              dueAt: now() + retryDelay(job, outcome, now(), random),
            }
          : outcome;
      await storage.settle(session, job, disposition);
      if (!isActive()) return { state: 'paused', settled };
      if (outcome.state !== 'retry') {
        settled.push({
          kind: job.kind,
          trackId: job.trackId,
          eventId: job.eventId,
          state: outcome.state,
        });
      }
    }
    if (!isActive()) return { state: 'paused', settled };
    const nextDueAt = await storage.nextDueAt(session);
    if (!isActive()) return { state: 'paused', settled };
    return {
      state: nextDueAt == null ? 'drained' : 'pending',
      nextDueAt,
      settled,
    };
  }

  function drain(session) {
    if (!isSessionCurrent(session))
      return Promise.resolve({ state: 'paused', settled: [] });
    if (sameSession(session, unauthorizedSession)) {
      return Promise.resolve({ state: 'unauthorized', settled: [] });
    }
    if (running) {
      if (sameSession(running.session, session)) return running.promise;
      return running.promise.catch(() => {}).then(() => drain(session));
    }
    const controller = new AbortController();
    const promise = deliver(session, controller.signal)
      .catch((error) => {
        if (controller.signal.aborted || !isSessionCurrent(session))
          return { state: 'paused', settled: [] };
        throw error;
      })
      .finally(() => {
        running = undefined;
      });
    running = { session, controller, promise };
    return promise;
  }

  return {
    getRating: (session, trackId) =>
      write(session, () => storage.getRating(session, trackId)),

    listRatingOverlay: (session, trackId) =>
      write(session, () => storage.listRatingOverlay(session, trackId)),

    readRatingSnapshot: (session) =>
      write(session, () => storage.readRatingSnapshot(session)),

    reconcileRatings: (session, ratings, favoriteIds, dislikes) =>
      write(session, () =>
        storage.reconcileRatings(session, ratings, favoriteIds, dislikes),
      ),

    setRating(session, trackId, rating, track) {
      validateTrackId(trackId);
      if (!ratings.has(rating)) throw new TypeError('Invalid offline rating');
      const eventId = createId();
      const body = { rating, operation_id: eventId };
      return write(session, () =>
        storage.setRating(session, { trackId, eventId, body, track }),
      );
    },

    recordStarted(session, play) {
      const body = playbackBody(play);
      return write(session, () =>
        storage.enqueuePlayback(session, {
          kind: 'history',
          trackId: play.trackId,
          eventId: play.playbackId,
          body,
        }),
      );
    },

    recordOutcome(session, play) {
      const body = playbackBody(play);
      if (
        !['skip', 'finish'].includes(play.outcome) ||
        !validDuration(play.listenDurationMs) ||
        !validDuration(play.trackDurationMs) ||
        play.listenDurationMs === 0
      ) {
        throw new TypeError('Invalid playback outcome');
      }
      return write(session, () =>
        storage.enqueuePlayback(session, {
          kind: 'feedback',
          trackId: play.trackId,
          eventId: play.playbackId,
          body: {
            ...body,
            event_id: play.playbackId,
            track_id: play.trackId,
            event_type: play.outcome,
            listen_duration_ms: play.listenDurationMs,
            track_duration_ms: play.trackDurationMs,
            client: 'ios',
          },
        }),
      );
    },

    drain,
    cancelDrain(session) {
      if (sameSession(running?.session, session)) running.controller.abort();
    },
  };
}
