import {
  createOfflineId,
  getOfflineSession,
  isOfflineSessionCurrent,
} from '../session';
import { recordOutcome, recordStarted } from './runtime';

const MAX_DURATION_MS = 86400000;
const toMillis = (seconds) =>
  Number.isFinite(seconds)
    ? Math.max(0, Math.min(MAX_DURATION_MS, Math.round(seconds * 1000)))
    : 0;

export function createPlaybackEpisode(
  requestId,
  trackId,
  context,
  playbackRate,
  duration,
) {
  return {
    requestId,
    trackId: String(trackId),
    context,
    playbackRate,
    duration,
    session: getOfflineSession(),
    position: null,
    listenSeconds: 0,
  };
}

export function observePlayback(episode, event, intent) {
  if (!episode || episode.finished || !isOfflineSessionCurrent(episode.session))
    return;
  if (episode.sourceAttemptId !== event.sourceAttemptId) {
    episode.sourceAttemptId = event.sourceAttemptId;
    episode.position = null;
    episode.seeking = false;
  }
  if (Number.isFinite(event.duration) && event.duration > 0)
    episode.duration = event.duration;
  if (event.nativeEvent === 'seekIntent') episode.seeking = true;
  if (event.nativeEvent === 'seek')
    episode.seeking = event.seekCompleted !== true;
  if (
    episode.seeking ||
    event.isBuffering ||
    event.error ||
    event.mediaServicesDidReset ||
    ['error', 'reset', 'finish'].includes(event.nativeEvent) ||
    !Number.isFinite(event.currentTime) ||
    event.currentTime < 0
  ) {
    episode.position = null;
    return;
  }
  if (
    event.nativeEvent === 'loaded' ||
    event.nativeEvent === 'intent' ||
    event.nativeEvent === 'seek'
  ) {
    episode.position = event.currentTime;
    episode.sampledAt = Date.now();
    return;
  }
  if (event.nativeEvent !== 'progress') return;
  if (
    intent !== 'play' ||
    event.nativeIntent !== 'play' ||
    !event.playing ||
    !event.isLoaded
  ) {
    episode.position = null;
    return;
  }
  const now = Date.now();
  const advance =
    episode.position === null ? 0 : event.currentTime - episode.position;
  // A delayed observer can legitimately span more than one 100 ms update.
  const rate =
    event.playbackRate > 0 ? event.playbackRate : episode.playbackRate();
  const maximum = Math.max(0, (now - episode.sampledAt) / 1000) * rate + 0.25;
  episode.position = event.currentTime;
  episode.sampledAt = now;
  if (!(advance > 0 && advance <= maximum)) return;
  episode.listenSeconds += advance;
  if (!episode.play) {
    episode.play = {
      trackId: episode.trackId,
      context: episode.context,
      playbackId: createOfflineId(),
      occurredAt: new Date(now).toISOString(),
    };
    episode.start = recordStarted(episode.session, episode.play).catch(
      (error) => {
        if (isOfflineSessionCurrent(episode.session))
          console.warn(
            '[Outbox] Could not record playback start:',
            error.message,
          );
      },
    );
  }
}

export function completePlayback(episode, outcome) {
  if (!episode || episode.finished) return;
  episode.finished = outcome;
  if (!episode.play || !isOfflineSessionCurrent(episode.session)) return;
  const listenDurationMs = toMillis(episode.listenSeconds);
  if (!listenDurationMs) return;
  const trackDurationMs = toMillis(episode.duration || 0);
  episode.start
    .then(() => {
      if (isOfflineSessionCurrent(episode.session))
        return recordOutcome(episode.session, {
          ...episode.play,
          outcome,
          listenDurationMs,
          trackDurationMs,
        });
    })
    .catch((error) => {
      if (isOfflineSessionCurrent(episode.session))
        console.warn(
          '[Outbox] Could not record playback outcome:',
          error.message,
        );
    });
}
