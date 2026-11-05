/**
 * Playback Coordinator.
 * Coordinates AudioPlayer (expo-audio), AudioCache, and PreloadScheduler.
 * Implements gapless preload/replace mechanism, remote URI fallback,
 * idempotent playback, generation/token race protection,
 * fine-grained error classification, and debug-gated diagnostics.
 */

import defaultAudioCache from './audioCache';
import defaultPreloadScheduler, { TRACK_STATUS } from './preloadScheduler';
import { resolveCoverUri, prefetchCover } from '../shared/media/CoverImage';
import {
  SERVER_URL,
  getCachedAuthToken,
  getAuthToken,
} from '../shared/api/api';
import { getSettings } from '../shared/storage/settings';
import {
  applyTrackNormalization,
  computeEffectivePlayerVolume,
  computeTrackNormalizationGainDb,
} from './loudnessNormalization';
import { getTrackId, areTrackIdsEqual } from '../shared/domain/trackAdapter';

// Native expo-audio preload is disabled because it registers an AVQueuePlayer in the native registry,
// which triggers an NSInvalidArgumentException / HostFunction crash in unpatched iOS binaries.
// Background preloading is handled safely and reliably by PreloadScheduler + AudioCache using local file URIs.
let expoPreloadNative = null;

export const BYPASS_AUDIO_CACHE = false;

const isDev =
  typeof __DEV__ !== 'undefined'
    ? Boolean(globalThis.__DEV__)
    : typeof process !== 'undefined' &&
      process.env &&
      process.env.NODE_ENV !== 'production';

/**
 * Классифицированная ошибка воспроизведения.
 */
export class PlaybackError extends Error {
  /**
   * @param {string} message
   * @param {Object} [options]
   * @param {'local_cache_error' | 'remote_replace_error' | 'play_error' | 'network_timeout' | 'auth_error' | 'unknown'} [options.type]
   * @param {Error} [options.cause]
   * @param {string} [options.trackId]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'PlaybackError';
    this.type = options.type || 'unknown';
    this.code = this.type;
    this.cause = options.cause || null;
    this.trackId = options.trackId ? String(options.trackId) : null;
  }
}

/**
 * Классифицирует произвольную ошибку воспроизведения.
 * @param {Error|any} err
 * @param {string|number} [trackId]
 * @returns {PlaybackError}
 */
export function classifyPlaybackError(err, trackId) {
  if (err instanceof PlaybackError) {
    return err;
  }

  const msg = err?.message || String(err || '');
  const status =
    typeof err?.status === 'number'
      ? err.status
      : typeof err?.statusCode === 'number'
        ? err.statusCode
        : typeof err?.response?.status === 'number'
          ? err.response.status
          : null;
  let type = 'unknown';

  if (status === 401 || status === 403) {
    type = 'auth_error';
  } else if (status === 404) {
    type = 'not_found';
  } else if (
    status === 408 ||
    err?.name === 'TimeoutError' ||
    /\b(timeout|timed out)\b/i.test(msg)
  ) {
    type = 'network_timeout';
  } else if (/\b(cache|local)\b/i.test(msg)) {
    type = 'local_cache_error';
  } else if (/\b(play|playback)\b/i.test(msg)) {
    type = 'play_error';
  } else {
    type = 'remote_replace_error';
  }

  return new PlaybackError(msg, { type, cause: err, trackId });
}

/**
 * Сравнивает два объекта заголовков без учёта регистра ключей.
 */
export function areHeadersEqual(a, b) {
  if (a === b) return true;
  if (!a && !b) return true;
  const normA = {};
  if (a) {
    for (const [k, v] of Object.entries(a)) {
      if (typeof v === 'string') normA[k.toLowerCase()] = v.trim();
    }
  }
  const normB = {};
  if (b) {
    for (const [k, v] of Object.entries(b)) {
      if (typeof v === 'string') normB[k.toLowerCase()] = v.trim();
    }
  }
  const keysA = Object.keys(normA);
  const keysB = Object.keys(normB);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (normA[k] !== normB[k]) return false;
  }
  return true;
}

import { normalizeStreamUrl } from './streamUrl';
export {
  normalizeStreamUrl,
  applyTrackNormalization,
  computeEffectivePlayerVolume,
  computeTrackNormalizationGainDb,
};

export class PlaybackCoordinator {
  constructor(options = {}) {
    this.cache = options.cache || defaultAudioCache;
    this.scheduler = options.scheduler || defaultPreloadScheduler;
    this.preloadNative = options.preloadNative || null;
    this._explicitServerUrl = options.serverUrl || null;
    this._getServerUrl =
      typeof options.getServerUrl === 'function'
        ? options.getServerUrl
        : () => this._explicitServerUrl || SERVER_URL;
    this._lastServerUrl = this._resolveServerUrl();
    this.bypassCache =
      options.bypassCache !== undefined
        ? options.bypassCache
        : BYPASS_AUDIO_CACHE;
    this.debug = Boolean(options.debug);

    // Monotonic clock (injectable for deterministic testing)
    this.clock =
      typeof options.clock === 'function'
        ? options.clock
        : () =>
            typeof globalThis.performance !== 'undefined' &&
            globalThis.performance.now
              ? globalThis.performance.now()
              : Date.now();

    // Native capability / Source Identity Version
    this.identityAvailable = false;
    this._player = null;

    // Independent current state
    this.current = {
      requestId: null,
      trackId: null,
      sourceAttemptId: null,
      source: null, // 'local' | 'remote' | null
      status: 'idle', // 'idle' | 'starting' | 'playing' | 'paused' | 'interrupted' | 'stalled' | 'recovering' | 'error'
      intent: 'play', // 'play' | 'pause'
      positionSeconds: 0,
      error: null, // null | { kind: 'auth'|'not_found'|'transient'|'playback'|'timeout', retryable: boolean, message?: string }
      recoveryCount: 0, // 0 or 1 for this episode
    };

    // Independent next state
    this.next = {
      trackId: null,
      status: TRACK_STATUS.IDLE,
      error: null,
    };

    // Compatibility fields
    this.currentTrack = null;
    this.currentTrackId = null;
    this.currentPlayUri = null;
    this.currentIsLocal = false;
    this._currentSourceHeaders = null;
    this.playbackGeneration = 0;
    this.serverEpoch = 0;
    this.upNextQueue = [];
    this.listeners = new Set();

    this.networkStatus = 'good'; // 'good' | 'slow' | 'error'
    this.nextTrackStatus = TRACK_STATUS.IDLE;
    this.networkError = null;
    this.lastErrorType = null;
    this.lastCacheError = null;
    this.isBufferingSlow = false;
    this._bufferingTimeout = null;
    this._backgroundCacheTimer = null;
    this.backgroundCacheDelayMs = options.backgroundCacheDelayMs ?? 5000;

    // Watchdogs and budgets (§4.2)
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15000;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 10000;
    this.episodeTotalMs = options.episodeTotalMs ?? 30000;
    this.recoveryDelayMs = options.recoveryDelayMs ?? 800;
    this.headerTimeoutMs = options.headerTimeoutMs ?? 5000;
    this.seekTimeoutMs = options.seekTimeoutMs ?? 5000;

    // Episode & confirmation tracking
    this._episodeStartTime = 0;
    this._episodeDeadline = 0;
    this._activeEpisodeType = null; // 'startup' | 'stall' | null
    this._stallEpisodeDeadline = 0;
    this._episodeDeadlineTimer = null;
    this._recoveryGeneration = 0;
    this._waitForLoaded = false;
    this._loadedCompletionCallback = null;
    this._lastProgressTime = 0;
    this._lastConfirmedPosition = null;
    this._confirmedPlaybackStarted = false;
    this._finishHandled = false;
    this._acceptedIntentRevision = -1;
    this._lastSeekTarget = null;
    this._seekPending = false;
    this._seekCompletionCallback = null;
    this._authEpoch = options.authEpoch ?? 0;
    this._getHeadersAsyncFn = null;

    // Timers
    this._startupTimer = null;
    this._stallTimer = null;
    this._recoveryTimer = null;
    this._activeRetryPromise = null;

    // Stable proof tracking (§4.2: >=2 advancing progress spanning 1,000 ms, net advance >= 0.25 s)
    this._progressEvents = [];
    this._hasStableProof = false;

    // Bounded dev diagnostics ring buffer (max 200 entries, safe sanitized fields)
    this._diagnosticsRing = [];
    this._lastProgressDiagnosticTime = -Infinity;

    // Monotonic ID counters
    this._requestIdCounter = 0;
    this._attemptIdCounter = 0;
    this._startedRequestIds = new Set();
    this._retryGeneration = 0;

    // Subscribe to preload scheduler events
    this._unsubscribeScheduler = this.scheduler.addListener((event) => {
      this._handleSchedulerEvent(event);
    });
  }

  get serverUrl() {
    if (this._explicitServerUrl) return this._explicitServerUrl;
    return typeof this._getServerUrl === 'function'
      ? this._getServerUrl()
      : SERVER_URL;
  }

  set serverUrl(value) {
    this._explicitServerUrl = value;
  }

  _resolveServerUrl() {
    const raw = this.serverUrl;
    return (raw || SERVER_URL || 'https://web.puuk.fun')
      .trim()
      .replace(/\/+$/, '');
  }

  _checkIdentityCapability(player) {
    this._player = player;
    if (
      player &&
      player.puukSourceIdentityVersion === 1 &&
      typeof player.replaceWithAttempt === 'function' &&
      typeof player.playForAttempt === 'function' &&
      typeof player.seekForAttempt === 'function'
    ) {
      this.identityAvailable = true;
    } else {
      this.identityAvailable = false;
    }
    return this.identityAvailable;
  }
  _getActiveEpisodeDeadline() {
    if (this._activeEpisodeType === 'stall' && this._stallEpisodeDeadline > 0) {
      return this._stallEpisodeDeadline;
    }
    return this._episodeDeadline || this.clock() + this.episodeTotalMs;
  }

  _clearWatchdogs() {
    if (this._startupTimer) {
      clearTimeout(this._startupTimer);
      this._startupTimer = null;
    }
    if (this._stallTimer) {
      clearTimeout(this._stallTimer);
      this._stallTimer = null;
    }
  }

  _armEpisodeDeadlineTimer(deadline) {
    if (this._episodeDeadlineTimer) {
      clearTimeout(this._episodeDeadlineTimer);
      this._episodeDeadlineTimer = null;
    }
    if (!this.identityAvailable) {
      return;
    }
    const delay = Math.max(0, deadline - this.clock());
    this._episodeDeadlineTimer = setTimeout(() => {
      this._episodeDeadlineTimer = null;
      if (this.current.intent === 'play') {
        this._recordDiagnostic('episode_deadline_fired');
        this._terminateWithError(
          new PlaybackError(
            `Playback episode total deadline exceeded (${this.episodeTotalMs}ms)`,
            {
              type: 'network_timeout',
              trackId: this.current.trackId,
            },
          ),
        );
      }
    }, delay);
  }

  _armStartupWatchdog(attemptId, requestId) {
    if (this._startupTimer) {
      clearTimeout(this._startupTimer);
      this._startupTimer = null;
    }
    if (!this.identityAvailable) {
      return;
    }
    const remainingEpisode = Math.max(
      0,
      this._getActiveEpisodeDeadline() - this.clock(),
    );
    const delay = Math.min(this.startupTimeoutMs, remainingEpisode);
    if (delay <= 0) {
      return;
    }
    this._startupTimer = setTimeout(() => {
      this._startupTimer = null;
      if (
        this.current.sourceAttemptId === attemptId &&
        this.current.requestId === requestId &&
        !this._confirmedPlaybackStarted &&
        this.current.intent === 'play'
      ) {
        this._recordDiagnostic('startup_timeout_fired');
        if (this.identityAvailable && this.current.recoveryCount === 0) {
          this._scheduleAutoRecovery(this._player, 'startup_timeout');
        } else {
          this._terminateWithError(
            new PlaybackError(`Startup timeout (${this.startupTimeoutMs}ms)`, {
              type: 'network_timeout',
              trackId: this.current.trackId,
            }),
          );
        }
      }
    }, delay);
  }

  _armStallWatchdog(attemptId, requestId) {
    if (this._stallTimer) {
      clearTimeout(this._stallTimer);
      this._stallTimer = null;
    }
    if (!this.identityAvailable) {
      return;
    }
    const delay = this.stallTimeoutMs;
    this._stallTimer = setTimeout(() => {
      this._stallTimer = null;
      if (
        this.current.sourceAttemptId === attemptId &&
        this.current.requestId === requestId &&
        this.current.intent === 'play'
      ) {
        this.current.status = 'stalled';
        this.networkStatus = 'slow';
        if (
          this.scheduler &&
          typeof this.scheduler.setPlaybackPressure === 'function'
        ) {
          this.scheduler.setPlaybackPressure({
            requestId: this.current.requestId,
            phase: 'stalled',
          });
        }
        this._recordDiagnostic('stall_timeout_fired');
        this._notifyState();

        // Later stall episode deadline is anchored to last accepted advancing progress
        // only after sustainable proof has completed the startup episode.
        if (this._hasStableProof) {
          this._activeEpisodeType = 'stall';
          this._stallEpisodeDeadline =
            (this._lastProgressTime || this.clock()) + this.episodeTotalMs;
          this._armEpisodeDeadlineTimer(this._stallEpisodeDeadline);
        }

        const activeDeadline = this._getActiveEpisodeDeadline();
        if (
          this.identityAvailable &&
          this.current.recoveryCount === 0 &&
          this.clock() + this.recoveryDelayMs < activeDeadline
        ) {
          this._scheduleAutoRecovery(this._player, 'stall_timeout');
        } else {
          this._terminateWithError(
            new PlaybackError(
              `Playback stall timeout (${this.stallTimeoutMs}ms)`,
              {
                type: 'network_timeout',
                trackId: this.current.trackId,
              },
            ),
          );
        }
      }
    }, delay);
  }

  _cancelRecovery(reason = 'cancelled') {
    this._recoveryGeneration = (this._recoveryGeneration || 0) + 1;
    if (this._manualRetryToken) {
      this._manualRetryToken = null;
      if (reason !== 'user_seek' && reason !== 'user_seekIntent')
        this._seekPending = false;
    }
    if (this._retryCancel) this._retryCancel();
    if (this._recoveryTimer) {
      clearTimeout(this._recoveryTimer);
      this._recoveryTimer = null;
    }
    if (this._loadedCompletionCallback) {
      this._loadedCompletionCallback(null);
      this._loadedCompletionCallback = null;
    }
    if (this._seekCompletionCallback) {
      this._seekCompletionCallback(null);
      this._seekCompletionCallback = null;
    }
  }

  _scheduleAutoRecovery(player, trigger, causeError = null) {
    if (this.current.recoveryCount >= 1 || !this.identityAvailable) {
      const classified = classifyPlaybackError(
        causeError,
        this.current.trackId,
      );
      this._terminateWithError(classified);
      return;
    }

    const now = this.clock();
    const activeDeadline = this._getActiveEpisodeDeadline();
    if (now + this.recoveryDelayMs >= activeDeadline) {
      this._terminateWithError(
        new PlaybackError('Playback episode total deadline exceeded', {
          type: 'network_timeout',
          trackId: this.current.trackId,
        }),
      );
      return;
    }

    this.current.recoveryCount = 1;
    this.current.status =
      trigger === 'stall_timeout' ? 'stalled' : 'recovering';
    this._hasStableProof = false;
    this._progressEvents = [];
    this._clearWatchdogs();
    if (
      this.scheduler &&
      typeof this.scheduler.setPlaybackPressure === 'function'
    ) {
      this.scheduler.setPlaybackPressure({
        requestId: this.current.requestId,
        phase: trigger === 'stall_timeout' ? 'stalled' : 'recovering',
      });
    }
    this._recordDiagnostic('recovery_scheduled');
    this._notifyState();

    this._cancelRecovery('rescheduled');
    const recoveryGen = this._recoveryGeneration;

    this._recoveryTimer = setTimeout(() => {
      this._recoveryTimer = null;
      this._performRecovery(player, trigger, causeError, recoveryGen);
    }, this.recoveryDelayMs);
  }

  async _performRecovery(player, trigger, causeError, recoveryGen) {
    if (
      this._recoveryGeneration !== recoveryGen ||
      this.current.intent !== 'play'
    ) {
      return;
    }

    const activeDeadline = this._getActiveEpisodeDeadline();
    const remainingBudget = activeDeadline - this.clock();
    if (remainingBudget <= 0) {
      this._terminateWithError(
        new PlaybackError('Playback episode total deadline exceeded', {
          type: 'network_timeout',
          trackId: this.current.trackId,
        }),
      );
      return;
    }

    const currentGen = this.playbackGeneration;
    const currentReq = this.current.requestId;
    const currentAuth = this._authEpoch;
    const currentTrack = this.currentTrack;
    const currentTrackId = this.current.trackId;
    const previousAttempt = this.current.sourceAttemptId;
    const previousRevision = this._acceptedIntentRevision;
    const targetPosition = this._lastSeekTarget ?? this.current.positionSeconds;

    if (!currentTrack || !currentReq || !previousAttempt) return;
    if (!Number.isInteger(previousRevision) || previousRevision < 0) {
      this._terminateWithError(
        new PlaybackError('Missing native revision', { type: 'play_error' }),
      );
      return;
    }

    // DO NOT change this.current.sourceAttemptId here! It remains previousAttempt during header acquisition!
    let cleanHeaders = {};
    if (typeof this._getHeadersAsyncFn === 'function') {
      const headerTimeout = Math.min(
        this.headerTimeoutMs,
        Math.max(0, remainingBudget),
      );
      let headerTimer;
      try {
        const headerPromise = this._getHeadersAsyncFn();
        const timeoutPromise = new Promise(
          (_, reject) =>
            (headerTimer = setTimeout(
              () => reject(new Error('Header timeout')),
              headerTimeout,
            )),
        );
        const asyncHeaders = await Promise.race([
          headerPromise,
          timeoutPromise,
        ]);
        if (asyncHeaders && typeof asyncHeaders === 'object') {
          for (const [k, v] of Object.entries(asyncHeaders)) {
            if (typeof v === 'string' && v.trim()) cleanHeaders[k] = v.trim();
          }
        }
      } catch (hErr) {
        if (
          this._recoveryGeneration !== recoveryGen ||
          this.playbackGeneration !== currentGen ||
          this.current.requestId !== currentReq ||
          this._authEpoch !== currentAuth ||
          this.current.intent !== 'play'
        ) {
          return;
        }
        this._warn('[Coordinator] Header acquisition failed during recovery');
        this._terminateWithError(
          new PlaybackError('Header acquisition failed during recovery', {
            type: 'network_timeout',
            cause: hErr,
            trackId: currentTrackId,
          }),
        );
        return;
      } finally {
        clearTimeout(headerTimer);
      }
    } else if (this._currentSourceHeaders) {
      cleanHeaders = { ...this._currentSourceHeaders };
    }

    // Guard check after async headers
    if (
      this._recoveryGeneration !== recoveryGen ||
      this.playbackGeneration !== currentGen ||
      this.current.requestId !== currentReq ||
      this._authEpoch !== currentAuth ||
      this.current.intent !== 'play'
    ) {
      return;
    }

    const currentServerUrl = this._resolveServerUrl();
    if (this._lastServerUrl && this._lastServerUrl !== currentServerUrl) {
      this._lastServerUrl = currentServerUrl;
      this.serverEpoch += 1;
      if (this.scheduler && typeof this.scheduler.cancelAll === 'function') {
        this.scheduler.cancelAll();
      }
    }
    const normalizedStreamUrl = normalizeStreamUrl(
      currentTrack,
      currentServerUrl,
    );
    const source =
      Object.keys(cleanHeaders).length > 0
        ? { uri: normalizedStreamUrl, headers: cleanHeaders }
        : { uri: normalizedStreamUrl };

    const newAttemptId = `att_${++this._attemptIdCounter}_${Date.now()}`;
    const previousSource = this.current.source;
    this.current.sourceAttemptId = newAttemptId;
    this.current.source = 'remote';
    this._seekPending = true;
    this._loadedAttemptId = null;
    if (
      this.identityAvailable &&
      player &&
      typeof player.replaceWithAttempt === 'function'
    ) {
      let ok;
      try {
        ok = player.replaceWithAttempt(
          source,
          newAttemptId,
          previousRevision,
          previousAttempt,
        );
      } catch (error) {
        if (
          this._recoveryGeneration === recoveryGen &&
          this.playbackGeneration === currentGen &&
          this.current.requestId === currentReq &&
          this._authEpoch === currentAuth
        ) {
          this.current.sourceAttemptId = previousAttempt;
          this._terminateWithError(
            classifyPlaybackError(error, currentTrackId),
          );
        }
        return;
      }
      if (!ok) {
        if (this.current.sourceAttemptId === newAttemptId) {
          this.current.sourceAttemptId = previousAttempt;
          this.current.source = previousSource;
          this._seekPending = false;
          if (
            this._recoveryGeneration === recoveryGen &&
            this.playbackGeneration === currentGen &&
            this.current.requestId === currentReq &&
            this._authEpoch === currentAuth &&
            this.current.intent === 'play'
          ) {
            // Native veto is final for this episode. Do not leave a spinner or
            // manufacture play permission; Retry can restore paused, then a
            // fresh explicit Play authorizes the newly loaded source.
            this.current.intent = 'pause';
            this._terminateWithError(
              new PlaybackError('Recovery source rejected', {
                type: 'play_error',
              }),
            );
          }
        }
        return;
      }
    } else {
      return; // Automatic recovery is never enabled for a legacy player.
    }

    // Guard check after replace
    if (
      this._recoveryGeneration !== recoveryGen ||
      this.playbackGeneration !== currentGen ||
      this.current.requestId !== currentReq ||
      this._authEpoch !== currentAuth ||
      this.current.intent !== 'play'
    ) {
      return;
    }

    // Now publish the new attempt identity!
    this.current.sourceAttemptId = newAttemptId;
    this.current.source = 'remote';
    this.currentPlayUri = normalizedStreamUrl;
    this.currentIsLocal = false;
    this._currentSourceHeaders =
      Object.keys(cleanHeaders).length > 0 ? cleanHeaders : null;

    let seekSucceeded = true;
    if (player) {
      if (
        this.identityAvailable &&
        typeof player.seekForAttempt === 'function'
      ) {
        seekSucceeded = false;

        // If in public flow with loaded tracking, wait matching loaded before seek
        if (this._loadedAttemptId !== newAttemptId) {
          const loadedTimeout = Math.min(
            5000,
            Math.max(0, this._getActiveEpisodeDeadline() - this.clock()),
          );
          let loadedArrived = false;
          await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(), loadedTimeout);
            this._loadedCompletionCallback = (ev) => {
              clearTimeout(timer);
              loadedArrived = Boolean(
                ev && ev.sourceAttemptId === newAttemptId,
              );
              resolve();
            };
          });

          const isStaleLoaded =
            this._recoveryGeneration !== recoveryGen ||
            this.playbackGeneration !== currentGen ||
            this.current.requestId !== currentReq ||
            this._authEpoch !== currentAuth ||
            this.current.intent !== 'play';

          if (isStaleLoaded || !loadedArrived) {
            if (!isStaleLoaded && !loadedArrived) {
              this._terminateWithError(
                new PlaybackError('Loaded timeout before recovery seek', {
                  type: 'network_timeout',
                  trackId: currentTrackId,
                }),
              );
            }
            return;
          }
        }

        // Wait matching seekCompleted: true
        const seekTimeout = Math.min(
          this.seekTimeoutMs,
          Math.max(0, this._getActiveEpisodeDeadline() - this.clock()),
        );
        let seekEventRevision = null;
        const revision = this._acceptedIntentRevision;
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            this._seekPending = false;
            resolve();
          }, seekTimeout);
          this._seekCompletionCallback = (ev) => {
            if (
              ev &&
              (ev.sourceAttemptId !== newAttemptId ||
                ev.intentRevision !== revision ||
                ev.seekOrigin !== 'recovery')
            )
              return false;
            clearTimeout(timer);
            seekSucceeded = Boolean(
              ev && ev.sourceAttemptId === newAttemptId && ev.seekCompleted,
            );
            if (ev && typeof ev.intentRevision === 'number') {
              seekEventRevision = ev.intentRevision;
            }
            this._seekPending = false;
            resolve();
          };
          this._seekPending = true;
          let seekAccepted = false;
          try {
            seekAccepted =
              Number.isInteger(revision) &&
              revision >= 0 &&
              player.seekForAttempt(newAttemptId, targetPosition, revision) ===
                true;
          } catch {
            /* A throwing native bridge fails the restoration. */
          }
          if (!seekAccepted) {
            clearTimeout(timer);
            this._seekCompletionCallback = null;
            this._seekPending = false;
            resolve();
          }
        });

        const isStaleSeek =
          this._recoveryGeneration !== recoveryGen ||
          this.playbackGeneration !== currentGen ||
          this.current.requestId !== currentReq ||
          this._authEpoch !== currentAuth ||
          this.current.intent !== 'play';

        if (isStaleSeek || !seekSucceeded) {
          if (!isStaleSeek && !seekSucceeded) {
            this._terminateWithError(
              new PlaybackError('Recovery seek completion timeout or failure', {
                type: 'network_timeout',
                trackId: currentTrackId,
              }),
            );
          }
          return;
        }

        if (seekEventRevision !== null) {
          this._acceptedIntentRevision = Math.max(
            this._acceptedIntentRevision,
            seekEventRevision,
          );
        }
        this._lastConfirmedPosition = targetPosition;
      } else if (typeof player.seekTo === 'function') {
        try {
          await player.seekTo(targetPosition);
        } catch (sErr) {}
      }
    }

    if (
      this._recoveryGeneration !== recoveryGen ||
      this.playbackGeneration !== currentGen ||
      this.current.requestId !== currentReq ||
      this._authEpoch !== currentAuth
    ) {
      return;
    }

    if (this.current.intent === 'play' && player && seekSucceeded) {
      if (
        this.identityAvailable &&
        typeof player.playForAttempt === 'function'
      ) {
        const playOk = player.playForAttempt(
          newAttemptId,
          this._acceptedIntentRevision >= 0
            ? this._acceptedIntentRevision
            : null,
        );
        if (!playOk) {
          if (
            this._recoveryGeneration === recoveryGen &&
            this.playbackGeneration === currentGen &&
            this.current.requestId === currentReq &&
            this._authEpoch === currentAuth &&
            this.current.intent === 'play'
          ) {
            this.current.intent = 'pause';
            this._terminateWithError(
              new PlaybackError('Recovery play rejected', {
                type: 'play_error',
              }),
            );
          }
          return;
        }
      } else if (typeof player.play === 'function') {
        try {
          await player.play();
        } catch (pErr) {
          this._terminateWithError(
            new PlaybackError(pErr?.message, {
              type: 'play_error',
              trackId: currentTrackId,
            }),
          );
          return;
        }
      }
      this.current.status = 'recovering'; // Remains recovering until actual progress arrives!
      this._armStartupWatchdog(newAttemptId, currentReq);
    } else {
      this.current.status = 'paused';
    }
    this._recordDiagnostic('recovery_completed');
    this._notifyState();
  }

  _terminateWithError(error) {
    this._clearWatchdogs();
    if (this._episodeDeadlineTimer) {
      clearTimeout(this._episodeDeadlineTimer);
      this._episodeDeadlineTimer = null;
    }
    this._cancelRecovery('error');
    this._activeEpisodeType = null;
    this.current.status = 'error';
    const isAuth = error.type === 'auth_error' || error.type === 'auth';
    const isNotFound = error.type === 'not_found';
    const isTimeout =
      error.type === 'network_timeout' || error.type === 'timeout';

    let kind = 'playback';
    let retryable = true;

    if (isAuth) {
      kind = 'auth';
      retryable = false;
    } else if (isNotFound) {
      kind = 'not_found';
      retryable = false;
    } else if (isTimeout) {
      kind = 'timeout';
      retryable = true;
    } else if (error.type === 'local_cache_error') {
      kind = 'transient';
      retryable = true;
    }

    const safeMessage =
      kind === 'auth'
        ? 'Authentication failed'
        : kind === 'not_found'
          ? 'Track unavailable'
          : kind === 'timeout'
            ? 'Playback timed out'
            : kind === 'transient'
              ? 'Connection issue'
              : 'Playback error';

    this.current.error = {
      kind,
      retryable,
      message: safeMessage,
    };
    this.networkStatus = 'error';
    this.networkError = safeMessage;
    this.lastErrorType = kind;
    if (
      this.scheduler &&
      typeof this.scheduler.setPlaybackPressure === 'function'
    ) {
      this.scheduler.setPlaybackPressure({
        requestId: this.current.requestId,
        phase: 'idle',
      });
    }
    this._recordDiagnostic('terminated_error', { errorKind: kind });
    this._notifyState();
  }

  _recordDiagnostic(phase, extra = {}) {
    if (!isDev) {
      return;
    }
    const safePhases = [
      'play',
      'starting',
      'playing',
      'paused',
      'interrupted',
      'stalled',
      'recovering',
      'recovery_scheduled',
      'recovery_completed',
      'terminated_error',
      'cancelled',
      'intent_play',
      'intent_pause',
      'intent_seek',
      'stable_proof',
      'startup_timeout_fired',
      'stall_timeout_fired',
      'episode_deadline_fired',
      'progress',
      'loaded',
      'seek',
      'finish',
      'error',
      'event',
      'command',
      'command_warning',
      'command_error',
    ];
    const safePhase = safePhases.includes(phase) ? phase : 'event';
    const now = Math.round(this.clock());
    if (safePhase === 'progress') {
      if (now - this._lastProgressDiagnosticTime < 1000) {
        return;
      }
      this._lastProgressDiagnosticTime = now;
    }

    const safeErrorKind = this.current.error?.kind || extra.errorKind || null;

    const entry = {
      time: now,
      phase: safePhase,
      requestId: this.current.requestId,
      attemptId: this.current.sourceAttemptId,
      trackId: this.current.trackId,
      source: this.current.source,
      intent: this.current.intent,
      status: this.current.status,
      position:
        typeof this.current.positionSeconds === 'number'
          ? this.current.positionSeconds
          : 0,
      errorKind: safeErrorKind,
      recoveryCount: this.current.recoveryCount,
    };

    if (this._diagnosticsRing.length >= 200) {
      this._diagnosticsRing.shift();
    }
    this._diagnosticsRing.push(entry);
  }

  getDiagnostics() {
    return [...this._diagnosticsRing];
  }

  cancelCurrent(reason = 'superseded', player = null) {
    this.playbackGeneration += 1;
    this._clearWatchdogs();
    if (this._episodeDeadlineTimer) {
      clearTimeout(this._episodeDeadlineTimer);
      this._episodeDeadlineTimer = null;
    }
    this._cancelRecovery(reason);
    this._activeRetryPromise = null;
    this._activeEpisodeType = null;
    this._stallEpisodeDeadline = 0;
    this._episodeDeadline = 0;

    if (reason === 'auth-change' || reason === 'logout') {
      this._authEpoch += 1;
    }

    this.current.requestId = null;
    this.current.sourceAttemptId = null;
    this.current.trackId = null;
    this.current.status = 'idle';
    this.current.intent = 'pause';

    this.currentTrack = null;
    this.currentTrackId = null;
    this.currentPlayUri = null;
    this.currentIsLocal = false;

    if (
      this.scheduler &&
      typeof this.scheduler.setPlaybackPressure === 'function'
    ) {
      this.scheduler.setPlaybackPressure({ requestId: null, phase: 'idle' });
    }

    if (
      reason === 'unmount' ||
      reason === 'logout' ||
      reason === 'auth-change' ||
      reason === 'dismiss'
    ) {
      if (this.scheduler && typeof this.scheduler.cancelAll === 'function') {
        this.scheduler.cancelAll();
      }
    }

    const p = player || this._player;
    if (p && typeof p.pause === 'function') {
      try {
        p.pause();
      } catch (e) {}
    }

    this._recordDiagnostic('cancelled');
    this._notifyState();
  }

  async setIntent(player, { type, positionSeconds, requestId } = {}) {
    if (
      requestId &&
      (!this.current.requestId || requestId !== this.current.requestId)
    ) {
      return;
    }

    if (
      !this.current.requestId ||
      (this.current.status === 'idle' && type !== 'pause')
    ) {
      return;
    }

    if (type === 'pause') {
      this.current.intent = 'pause';
      this.current.status = 'paused';
      this._clearWatchdogs();
      this._cancelRecovery('user_pause');
      if (
        this.scheduler &&
        typeof this.scheduler.setPlaybackPressure === 'function'
      ) {
        this.scheduler.setPlaybackPressure({
          requestId: this.current.requestId,
          phase: 'suspended',
        });
      }
      this._recordDiagnostic('intent_pause');
      this._notifyState();

      if (player && typeof player.pause === 'function') {
        try {
          await player.pause();
        } catch (err) {
          this._warn('[Coordinator] player.pause failed in setIntent');
        }
      }
      return;
    }

    if (type === 'play') {
      if (this._manualRetryToken && this.current.intent !== 'play')
        this._cancelRecovery('user_play');
      this.current.intent = 'play';
      const isResuming =
        this.current.status === 'paused' ||
        this.current.status === 'interrupted';
      if (isResuming) {
        this.current.status = 'starting'; // Remains starting until progress confirms audio!
        this._episodeStartTime = this.clock();
        this._episodeDeadline = this._episodeStartTime + this.episodeTotalMs;
        this._activeEpisodeType = 'startup';
        this.current.recoveryCount = 0;
        this._confirmedPlaybackStarted = false;
        this._hasStableProof = false;
        this._progressEvents = [];
        if (this.identityAvailable) {
          this._armEpisodeDeadlineTimer(this._episodeDeadline);
          this._armStartupWatchdog(
            this.current.sourceAttemptId,
            this.current.requestId,
          );
        }
        if (
          this.scheduler &&
          typeof this.scheduler.setPlaybackPressure === 'function'
        ) {
          this.scheduler.setPlaybackPressure({
            requestId: this.current.requestId,
            phase: 'startup',
          });
        }
      }
      this._recordDiagnostic('intent_play');
      this._notifyState();

      if (player) {
        try {
          if (
            this.identityAvailable &&
            typeof player.playForAttempt === 'function' &&
            this.current.sourceAttemptId
          ) {
            player.playForAttempt(this.current.sourceAttemptId, null);
          } else if (
            !this.identityAvailable &&
            typeof player.play === 'function'
          ) {
            await player.play();
          }
        } catch (err) {
          this._warn('[Coordinator] player.play failed in setIntent');
        }
      }
      return;
    }

    if (type === 'seek') {
      const targetSeconds =
        typeof positionSeconds === 'number' ? positionSeconds : 0;
      this._lastSeekTarget = targetSeconds;
      this.current.positionSeconds = targetSeconds;
      this._seekPending = true;
      this._cancelRecovery('user_seek');
      this._recordDiagnostic('intent_seek');
      this._notifyState();

      if (player) {
        try {
          if (
            this.identityAvailable &&
            typeof player.seekForAttempt === 'function' &&
            this.current.sourceAttemptId
          ) {
            player.seekForAttempt(
              this.current.sourceAttemptId,
              targetSeconds,
              null,
            );
          } else if (typeof player.seekTo === 'function') {
            await player.seekTo(targetSeconds);
          }
        } catch (err) {
          this._warn('[Coordinator] player seek failed in setIntent');
        }
      }
      return;
    }
  }

  retryCurrent(player, options = {}) {
    if (this._activeRetryPromise) {
      return this._activeRetryPromise;
    }

    const retryPromise = this._doRetryCurrent(player, options).finally(() => {
      if (this._activeRetryPromise === retryPromise) {
        this._activeRetryPromise = null;
      }
    });
    this._activeRetryPromise = retryPromise;

    return this._activeRetryPromise;
  }

  // Each retry wait owns its cancellation and timer. A late settlement cannot
  // clear the callback belonging to a newer retry.
  async _retryWait(operation, timeoutMs, isStale) {
    if (isStale()) throw new Error('Retry cancelled');
    let timer;
    let cancel;
    const cancelled = new Promise((_, reject) => {
      cancel = () => reject(new Error('Retry cancelled'));
      this._retryCancel = cancel;
      timer = setTimeout(
        () =>
          reject(
            new PlaybackError('Playback timed out', {
              type: 'network_timeout',
            }),
          ),
        Math.max(0, timeoutMs),
      );
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          if (isStale()) throw new Error('Retry cancelled');
          return operation();
        }),
        cancelled,
      ]);
      if (isStale()) throw new Error('Retry cancelled');
      return result;
    } finally {
      clearTimeout(timer);
      if (this._retryCancel === cancel) this._retryCancel = null;
    }
  }

  async _doRetryCurrent(player, options = {}) {
    const track = this.currentTrack;
    const requestId = this.current.requestId;
    if (
      !track ||
      !requestId ||
      (options.requestId && options.requestId !== requestId)
    ) {
      return { isLocal: false, uri: null };
    }

    this._clearWatchdogs();
    this._cancelRecovery('manual_retry');
    const retryGen = ++this._retryGeneration;
    this._manualRetryToken = retryGen;
    const generation = ++this.playbackGeneration;
    const recoveryGen = this._recoveryGeneration;
    if (options.authEpoch !== undefined) this._authEpoch = options.authEpoch;
    const auth = this._authEpoch;
    const intent = this.current.intent;
    const target = this.current.positionSeconds ?? 0;
    let attempt = this.current.sourceAttemptId;
    const isStale = () =>
      this._retryGeneration !== retryGen ||
      this.playbackGeneration !== generation ||
      this._recoveryGeneration !== recoveryGen ||
      this._authEpoch !== auth ||
      this.current.requestId !== requestId ||
      this.current.sourceAttemptId !== attempt;
    const result = {
      isLocal: false,
      uri: null,
      requestId,
      sourceAttemptId: attempt,
    };
    const deadline = this.clock() + this.episodeTotalMs;
    const remaining = (limit) =>
      Math.min(limit, Math.max(0, deadline - this.clock()));
    this._episodeStartTime = this.clock();
    this._episodeDeadline = deadline;
    if (this._episodeDeadlineTimer) clearTimeout(this._episodeDeadlineTimer);
    this._episodeDeadlineTimer = null;
    if (intent === 'play' && this.identityAvailable)
      this._armEpisodeDeadlineTimer(deadline);
    this._activeEpisodeType = 'startup';
    this._stallEpisodeDeadline = 0;
    this.current.recoveryCount = 0;
    this.current.error = null;
    this.current.status = intent === 'play' ? 'recovering' : 'paused';
    this.networkError = null;
    this.networkStatus = 'good';
    this.lastErrorType = null;
    this._confirmedPlaybackStarted = false;
    this._progressEvents = [];
    this._hasStableProof = false;
    this._seekPending = true;
    this.scheduler?.setPlaybackPressure?.({
      requestId,
      phase: intent === 'play' ? 'recovering' : 'suspended',
    });
    this._notifyState();

    let seekCallback = null;
    try {
      const getHeaders =
        options.getHeaders ||
        options.getHeadersAsync ||
        this._getHeadersAsyncFn;
      if (getHeaders) this._getHeadersAsyncFn = getHeaders;
      const headers = await this._retryWait(
        () =>
          getHeaders
            ? getHeaders()
            : options.headers || this._currentSourceHeaders || {},
        remaining(this.headerTimeoutMs),
        isStale,
      );
      if (isStale()) return result;
      const cleanHeaders = {};
      for (const [key, value] of Object.entries(headers || {})) {
        if (typeof value === 'string' && value.trim())
          cleanHeaders[key] = value.trim();
      }
      const server = this._resolveServerUrl();
      if (server !== this._lastServerUrl) {
        this._lastServerUrl = server;
        this.serverEpoch += 1;
        this.scheduler?.cancelAll?.();
      }
      const uri = normalizeStreamUrl(track, server);
      const source = {
        uri,
        ...(Object.keys(cleanHeaders).length ? { headers: cleanHeaders } : {}),
      };
      const oldAttempt = attempt;
      const oldSource = this.current.source;
      const oldUri = this.currentPlayUri;
      const oldIsLocal = this.currentIsLocal;
      const oldHeaders = this._currentSourceHeaders;
      const newAttempt = `att_${++this._attemptIdCounter}_${Date.now()}`;
      const accepted = await this._retryWait(
        () => {
          // Identity changes in the same synchronous turn as installation;
          // old installed-source intent remains valid until this boundary.
          attempt = newAttempt;
          result.sourceAttemptId = attempt;
          this.current.sourceAttemptId = attempt;
          this.current.source = 'remote';
          this.currentPlayUri = uri;
          this.currentIsLocal = false;
          this._currentSourceHeaders = cleanHeaders;
          this._loadedAttemptId = null;
          return this.identityAvailable
            ? player.replaceWithAttempt(source, attempt, null, null)
            : player.replace(source);
        },
        remaining(this.headerTimeoutMs),
        isStale,
      );
      if (isStale()) return result;
      if (this.identityAvailable && accepted !== true) {
        this.current.sourceAttemptId = oldAttempt;
        this.current.source = oldSource;
        this.currentPlayUri = oldUri;
        this.currentIsLocal = oldIsLocal;
        this._currentSourceHeaders = oldHeaders;
        attempt = oldAttempt;
        throw new PlaybackError('Source replacement rejected', {
          type: 'play_error',
        });
      }
      result.uri = uri;
      result.confirmation = this.identityAvailable ? 'pending' : 'unavailable';

      if (this.identityAvailable) {
        if (this._loadedAttemptId !== attempt) {
          let loadedCallback;
          try {
            await this._retryWait(
              () =>
                new Promise((resolve) => {
                  if (this._loadedAttemptId === attempt) return resolve();
                  loadedCallback = (event) => resolve(event);
                  this._loadedCompletionCallback = loadedCallback;
                }),
              remaining(this.seekTimeoutMs),
              isStale,
            );
          } finally {
            if (this._loadedCompletionCallback === loadedCallback)
              this._loadedCompletionCallback = null;
          }
        }
        if (isStale()) return result;
        const revision = this._acceptedIntentRevision;
        if (!Number.isInteger(revision) || revision < 0)
          throw new PlaybackError('Missing native revision', {
            type: 'play_error',
          });
        // Register before issuing the command: a native acknowledgement may be synchronous.
        await this._retryWait(
          () =>
            new Promise((resolve, reject) => {
              seekCallback = (event) => {
                if (
                  event?.sourceAttemptId === attempt &&
                  event.intentRevision === revision &&
                  event.seekOrigin === 'recovery'
                ) {
                  if (event.seekCompleted === true) resolve(event);
                  else
                    reject(
                      new PlaybackError('Position restoration failed', {
                        type: 'play_error',
                      }),
                    );
                  return true;
                }
                return false;
              };
              this._seekCompletionCallback = seekCallback;
              if (player.seekForAttempt(attempt, target, revision) !== true) {
                reject(
                  new PlaybackError('Position restoration rejected', {
                    type: 'play_error',
                  }),
                );
              }
            }),
          remaining(this.seekTimeoutMs),
          isStale,
        );
      } else if (target > 0 && typeof player.seekTo === 'function') {
        await this._retryWait(
          () => player.seekTo(target),
          remaining(this.seekTimeoutMs),
          isStale,
        );
      }
      if (isStale()) return result;
      this._seekPending = false;
      this.current.positionSeconds = target;
      this._lastConfirmedPosition = target;
      if (intent === 'play' && this.current.intent === 'play') {
        const acceptedPlay = await this._retryWait(
          () =>
            this.identityAvailable
              ? player.playForAttempt(attempt, this._acceptedIntentRevision)
              : player.play(),
          remaining(this.seekTimeoutMs),
          isStale,
        );
        if (isStale()) return result;
        if (this.identityAvailable && acceptedPlay !== true)
          throw new PlaybackError('Resume rejected', { type: 'play_error' });
        this.current.status = 'starting';
        if (this.identityAvailable) {
          this._armEpisodeDeadlineTimer(deadline);
          this._armStartupWatchdog(attempt, requestId);
        }
      } else {
        this.current.status = 'paused';
        this._activeEpisodeType = null;
      }
      this._notifyState();
    } catch (error) {
      if (!isStale())
        this._terminateWithError(
          classifyPlaybackError(error, this.current.trackId),
        );
    } finally {
      if (this._seekCompletionCallback === seekCallback)
        this._seekCompletionCallback = null;
      if (!isStale()) this._seekPending = false;
      if (this._manualRetryToken === retryGen) this._manualRetryToken = null;
    }
    return result;
  }

  handleNativeStatus(player, event) {
    if (
      !this.identityAvailable ||
      !event ||
      event.sourceIdentityVersion !== 1 ||
      !event.sourceAttemptId
    ) {
      return { accepted: false, didStart: false, didFinish: false };
    }

    if (event.sourceAttemptId !== this.current.sourceAttemptId) {
      return { accepted: false, didStart: false, didFinish: false };
    }

    const incomingRevision =
      typeof event.intentRevision === 'number' ? event.intentRevision : null;
    if (incomingRevision !== null) {
      if (
        this._acceptedIntentRevision >= 0 &&
        incomingRevision < this._acceptedIntentRevision
      ) {
        return { accepted: false, didStart: false, didFinish: false };
      }
    }

    this._recordDiagnostic(event.nativeEvent || 'event');

    let didStart = false;
    let didFinish = false;

    // Item failure and intent are separate facts. An error snapshot can have
    // been captured during installation, before the explicit play command,
    // and delivered ahead of that command's newer intent event. Its retained
    // pause field is not a new pause. Explicit intent events and the revision
    // fence above still own pause/seek ordering.
    // Command return is not delivery acknowledgement: queued loaded/error
    // snapshots captured by replace still precede the first native intent.
    if (
      event.nativeEvent === 'intent' &&
      this._explicitInstallAttempt === event.sourceAttemptId
    ) {
      this._explicitInstallAttempt = null;
    }
    const sourceError = event.nativeEvent === 'error' || Boolean(event.error);
    const intentEvent =
      event.nativeEvent === 'intent' || event.nativeEvent === 'seekIntent';
    const pausedPresentation =
      (!sourceError || intentEvent) &&
      (event.nativeIntent === 'pause' || event.nativeIntent === 'interrupted');
    const installingReady =
      ['loaded', 'error', 'snapshot'].includes(event.nativeEvent) &&
      this._explicitInstallAttempt === event.sourceAttemptId;
    const newPause =
      pausedPresentation &&
      !installingReady &&
      (this.current.intent !== 'pause' ||
        (event.nativeEvent === 'intent' &&
          (incomingRevision === null ||
            incomingRevision > this._acceptedIntentRevision)));
    if (newPause) {
      this.current.intent = 'pause';
      this.current.status =
        event.nativeIntent === 'interrupted' ? 'interrupted' : 'paused';
      this._clearWatchdogs();
      this._cancelRecovery('native_pause');
      if (incomingRevision !== null) {
        this._acceptedIntentRevision = Math.max(
          this._acceptedIntentRevision,
          incomingRevision,
        );
      }
      if (
        this.scheduler &&
        typeof this.scheduler.setPlaybackPressure === 'function'
      ) {
        this.scheduler.setPlaybackPressure({
          requestId: this.current.requestId,
          phase: 'suspended',
        });
      }
      this._notifyState();
      return { accepted: true, didStart: false, didFinish: false };
    }

    // Native system resume: strictly newer play revision required
    if (
      (!sourceError || intentEvent) &&
      event.nativeIntent === 'play' &&
      this.current.intent === 'pause'
    ) {
      if (
        incomingRevision !== null &&
        incomingRevision > this._acceptedIntentRevision
      ) {
        this._acceptedIntentRevision = incomingRevision;
        this.current.intent = 'play';
        this.current.status = 'starting'; // Remains starting until progress confirms audio!
        this._episodeStartTime = this.clock();
        this._episodeDeadline = this._episodeStartTime + this.episodeTotalMs;
        this._activeEpisodeType = 'startup';
        this._confirmedPlaybackStarted = false;
        if (this.identityAvailable) {
          this._armEpisodeDeadlineTimer(this._episodeDeadline);
          this._armStartupWatchdog(
            this.current.sourceAttemptId,
            this.current.requestId,
          );
        }
        if (
          this.scheduler &&
          typeof this.scheduler.setPlaybackPressure === 'function'
        ) {
          this.scheduler.setPlaybackPressure({
            requestId: this.current.requestId,
            phase: 'startup',
          });
        }
        this._notifyState();
      }
    }

    if (incomingRevision !== null) {
      this._acceptedIntentRevision = Math.max(
        this._acceptedIntentRevision,
        incomingRevision,
      );
    }

    if (event.nativeEvent === 'seekIntent') {
      if (event.seekOrigin === 'user') {
        this._seekPending = true;
        if (typeof event.seekTargetSeconds === 'number') {
          this._lastSeekTarget = event.seekTargetSeconds;
          this.current.positionSeconds = event.seekTargetSeconds;
        }
        this._cancelRecovery('user_seekIntent');
      }
      return { accepted: true, didStart: false, didFinish: false };
    }

    if (event.nativeEvent === 'loaded') {
      this._loadedAttemptId = event.sourceAttemptId;
      if (this._loadedCompletionCallback) {
        this._loadedCompletionCallback(event);
        this._loadedCompletionCallback = null;
      }
      return { accepted: true, didStart: false, didFinish: false };
    }

    if (event.nativeEvent === 'seek') {
      const callback = this._seekCompletionCallback;
      if (callback) {
        const consumed = callback(event);
        if (consumed === false)
          return { accepted: false, didStart: false, didFinish: false };
        if (this._seekCompletionCallback === callback)
          this._seekCompletionCallback = null;
      }
      if (event.seekCompleted === true) {
        this._seekPending = false;
        const pos =
          typeof event.currentTime === 'number'
            ? event.currentTime
            : this._lastSeekTarget || 0;
        this.current.positionSeconds = pos;
        this._lastConfirmedPosition = pos;
        this._progressEvents = [];
        this._hasStableProof = false;
      }
      return { accepted: true, didStart: false, didFinish: false };
    }

    // Strict confirmation requirements (§4.2):
    // ONLY nativeEvent progress AND loaded AND playing AND nativeIntent play AND finite actual advance.
    const isAdvancingTime =
      typeof event.currentTime === 'number' &&
      Number.isFinite(event.currentTime) &&
      !this._seekPending &&
      (this._lastConfirmedPosition === null
        ? event.currentTime > 0
        : event.currentTime > this._lastConfirmedPosition);

    const isConfirmedProgress =
      event.nativeEvent === 'progress' &&
      event.isLoaded === true &&
      event.playing === true &&
      event.nativeIntent === 'play' &&
      this.current.intent === 'play' &&
      isAdvancingTime;

    if (isConfirmedProgress) {
      const now = this.clock();
      this.current.positionSeconds = event.currentTime;
      this._lastConfirmedPosition = event.currentTime;
      this._lastProgressTime = now;

      if (!this._confirmedPlaybackStarted) {
        this._confirmedPlaybackStarted = true;
        const reqId = this.current.requestId;
        const isFirstForLogicalRequest =
          reqId && !this._startedRequestIds.has(reqId);
        if (isFirstForLogicalRequest) {
          this._startedRequestIds.add(reqId);
          didStart = true;
        } else if (!reqId) {
          didStart = true;
        }
        this.current.status = 'playing';
        this.networkStatus = 'good';
        this.networkError = null;
        this.lastErrorType = null;
        if (this._startupTimer) {
          clearTimeout(this._startupTimer);
          this._startupTimer = null;
        }
        this._armStallWatchdog(
          this.current.sourceAttemptId,
          this.current.requestId,
        );
      } else {
        this.current.status = 'playing';
        this.networkStatus = 'good';
        this._armStallWatchdog(
          this.current.sourceAttemptId,
          this.current.requestId,
        );
      }

      this._progressEvents.push({ time: now, position: event.currentTime });
      this._progressEvents = this._progressEvents.filter(
        (e) => now - e.time <= 10000,
      );

      if (!this._hasStableProof && this._progressEvents.length >= 2) {
        const oldest = this._progressEvents[0];
        const newest = this._progressEvents[this._progressEvents.length - 1];
        const timeSpan = newest.time - oldest.time;
        const posAdvance = newest.position - oldest.position;
        if (timeSpan >= 1000 && posAdvance >= 0.25) {
          this._hasStableProof = true;
          this._activeEpisodeType = null;
          if (this._episodeDeadlineTimer) {
            clearTimeout(this._episodeDeadlineTimer);
            this._episodeDeadlineTimer = null;
          }
          if (
            this.scheduler &&
            typeof this.scheduler.setPlaybackPressure === 'function'
          ) {
            this.scheduler.setPlaybackPressure({
              requestId: this.current.requestId,
              phase: 'stable',
            });
          }
          this._recordDiagnostic('stable_proof');
        }
      }

      this._notifyState();
    }

    if (event.nativeEvent === 'finish' || event.didJustFinish) {
      if (!this._finishHandled) {
        this._finishHandled = true;
        didFinish = true;
        this.current.status = 'idle';
        this._clearWatchdogs();
        this._cancelRecovery('finish');
        this._activeEpisodeType = null;
        if (
          this.scheduler &&
          typeof this.scheduler.setPlaybackPressure === 'function'
        ) {
          this.scheduler.setPlaybackPressure({
            requestId: this.current.requestId,
            phase: 'idle',
          });
        }
        this._notifyState();
      }
    }

    if (sourceError) {
      const errorPayload =
        event.error && typeof event.error === 'object'
          ? event.error
          : new Error(
              typeof event.error === 'string'
                ? event.error
                : 'Native playback error',
            );

      const classifiedNativeError = classifyPlaybackError(
        errorPayload,
        this.current.trackId,
      );
      if (
        classifiedNativeError.type === 'auth_error' ||
        classifiedNativeError.type === 'not_found'
      ) {
        this._terminateWithError(classifiedNativeError);
        return { accepted: true, didStart, didFinish };
      }

      if (this.current.intent !== 'play') {
        // A source failure cannot resurrect recovery after a newer JS pause.
        this._terminateWithError(classifiedNativeError);
        return { accepted: true, didStart, didFinish };
      }

      const isLocal = this.current.source === 'local';
      if (isLocal) {
        if (
          this.cache &&
          typeof this.cache.invalidate === 'function' &&
          this.currentPlayUri
        ) {
          this.cache
            .invalidate(this.current.trackId, this.currentPlayUri)
            .catch(() => {});
        }

        const activeDeadline = this._getActiveEpisodeDeadline();
        if (
          this.current.recoveryCount === 0 &&
          this.clock() + this.recoveryDelayMs < activeDeadline
        ) {
          this._scheduleAutoRecovery(player, 'local_error', errorPayload);
        } else {
          const classified = new PlaybackError(errorPayload.message, {
            type: 'local_cache_error',
            cause: errorPayload,
            trackId: this.current.trackId,
          });
          this._terminateWithError(classified);
        }
      } else {
        const activeDeadline = this._getActiveEpisodeDeadline();
        if (
          this.current.recoveryCount === 0 &&
          this.clock() + this.recoveryDelayMs < activeDeadline
        ) {
          this._scheduleAutoRecovery(player, 'remote_error', errorPayload);
        } else {
          const classified = classifyPlaybackError(
            errorPayload,
            this.current.trackId,
          );
          this._terminateWithError(classified);
        }
      }
    }

    return { accepted: true, didStart, didFinish };
  }

  destroy() {
    this.cancelCurrent('unmount');
    if (this._unsubscribeScheduler) {
      this._unsubscribeScheduler();
      this._unsubscribeScheduler = null;
    }
    if (this._bufferingTimeout) {
      clearTimeout(this._bufferingTimeout);
      this._bufferingTimeout = null;
    }
    if (this._backgroundCacheTimer) {
      clearTimeout(this._backgroundCacheTimer);
      this._backgroundCacheTimer = null;
    }
    this.listeners.clear();
  }

  /**
   * Выполняет player.replace с защитой от out-of-order завершения.
   * Если устаревший replace завершается позже, чем уже начал играть более новый трек,
   * повторно устанавливает актуальный источник, сохраняя паузу/seek (без безусловного play).
   *
   * @private
   */
  async _performReplace(
    player,
    source,
    isCurrent,
    generation,
    serverEpoch,
    attemptId = null,
  ) {
    if (!isCurrent()) {
      return { superseded: true };
    }

    if (
      this.identityAvailable &&
      typeof player.replaceWithAttempt === 'function' &&
      attemptId
    ) {
      const res = player.replaceWithAttempt(source, attemptId, null, null);
      const ok = typeof res?.then === 'function' ? await res : res;
      if (!ok) {
        return { superseded: true };
      }
    } else {
      await player.replace(source);
    }

    if (!isCurrent()) {
      // Guarded native replacement is synchronous. A late bridge promise is
      // never authority to reinstall or resume the newer logical selection.
      if (this.identityAvailable) return { superseded: true };
      if (
        this.currentPlayUri &&
        this.currentPlayUri !== source.uri &&
        this.playbackGeneration > generation &&
        (serverEpoch === undefined || this.serverEpoch === serverEpoch)
      ) {
        const repairGeneration = this.playbackGeneration;
        const repairRequest = this.current.requestId;
        const repairAuth = this._authEpoch;
        const repairIntent = this._recoveryGeneration;
        const ownsRepair = () =>
          this.playbackGeneration === repairGeneration &&
          this.current.requestId === repairRequest &&
          this._authEpoch === repairAuth &&
          this._recoveryGeneration === repairIntent;
        const currentSource = this.currentIsLocal
          ? { uri: this.currentPlayUri }
          : {
              uri: this.currentPlayUri,
              ...(this._currentSourceHeaders
                ? { headers: this._currentSourceHeaders }
                : {}),
            };
        try {
          if (!ownsRepair()) return { superseded: true };
          await player.replace(currentSource);
          if (!ownsRepair()) return { superseded: true };
          if (
            this.current.positionSeconds > 0 &&
            typeof player.seekTo === 'function'
          ) {
            await player.seekTo(this.current.positionSeconds);
            if (!ownsRepair()) return { superseded: true };
          }
          if (ownsRepair() && this.current.intent === 'play')
            await player.play();
        } catch {
          // An obsolete legacy repair cannot fail a later selection.
          if (ownsRepair()) this._warn('legacy_repair_failed');
        }
      }
      return { superseded: true };
    }

    return { superseded: false };
  }

  /**
   * Воспроизводит трек:
   * 1. Идемпотентность: если тот же трек уже загружен из того же источника, просто вызывает play()
   * 2. Generation token: защищает от race condition при быстром переключении треков (A -> B)
   * 3. Cache-first с плавным fallback на remote при локальной ошибке
   * 4. Разделение ошибок (PlaybackError)
   * 5. Диагностика скрыта под debug-флагом
   *
   * @param {Object} player - Экземпляр AudioPlayer
   * @param {Object} track - DTO трека
   * @param {Object} [options]
   * @param {Record<string, string>} [options.headers]
   * @param {boolean} [options.force] - Принудительно перезагрузить источник
   * @returns {Promise<{ isLocal: boolean, uri: string, reused?: boolean, superseded?: boolean }>}
   */
  async play(player, track, options = {}) {
    const rawTrackId = getTrackId(track);

    if (rawTrackId === null) {
      this._warn('[Coordinator] play() called without valid track:', track);
      return { isLocal: false, uri: null };
    }

    this._checkIdentityCapability(player);

    const trackIdStr = String(rawTrackId).trim();
    let requestId = options.requestId;
    if (!requestId) {
      if (
        options.isUserSelection ||
        this.currentTrackId !== trackIdStr ||
        !this.current.requestId
      ) {
        requestId = `req_${++this._requestIdCounter}_${Date.now()}`;
      } else {
        requestId = this.current.requestId;
      }
    }
    const authEpoch = options.authEpoch ?? this._authEpoch;
    this._authEpoch = authEpoch;
    const headersGetter =
      options.getHeadersAsync || options.getHeaders || this._getHeadersAsyncFn;
    if (headersGetter) {
      this._getHeadersAsyncFn = headersGetter;
    }

    const currentServerUrl = this._resolveServerUrl();
    const serverChanged = Boolean(
      this._lastServerUrl && this._lastServerUrl !== currentServerUrl,
    );
    if (serverChanged) {
      this._lastServerUrl = currentServerUrl;
      this.serverEpoch += 1;
      if (this._backgroundCacheTimer) {
        clearTimeout(this._backgroundCacheTimer);
        this._backgroundCacheTimer = null;
      }
      if (this.scheduler && typeof this.scheduler.cancelAll === 'function') {
        this.scheduler.cancelAll();
      }
    } else {
      this._lastServerUrl = currentServerUrl;
    }

    // 1. Нормализация URL
    const rawStreamUrl =
      track.stream_url ||
      `${currentServerUrl}/api/stream/${encodeURIComponent(trackIdStr)}`;
    const normalizedStreamUrl = normalizeStreamUrl(track, currentServerUrl);

    this._log('[Coordinator][Stage 1: normalize_url]', {
      trackId: trackIdStr,
      rawStreamUrl,
      normalizedStreamUrl,
      serverUrl: currentServerUrl,
    });

    if (
      !normalizedStreamUrl ||
      (!normalizedStreamUrl.startsWith('http://') &&
        !normalizedStreamUrl.startsWith('https://'))
    ) {
      const urlErr = new PlaybackError(
        `[Coordinator] Invalid stream URL: "${normalizedStreamUrl}" for track ${trackIdStr}`,
        {
          type: 'remote_replace_error',
          trackId: trackIdStr,
        },
      );
      this._error('[Coordinator][Stage 1: normalize_url FAILED]', urlErr);
      throw urlErr;
    }

    // 2. Проверка локального кеша
    let localUri = null;
    if (this.bypassCache || options.bypassLocal) {
      this._log(
        '[Coordinator][Stage 2: get_cached_uri] Cache BYPASSED by diagnostic flag',
      );
    } else {
      try {
        localUri = this.cache.getCachedUri(trackIdStr);
        this._log('[Coordinator][Stage 2: get_cached_uri]', {
          trackId: trackIdStr,
          hasLocalUri: Boolean(localUri),
          localUri,
        });
      } catch (cacheErr) {
        this._warn('[Coordinator][Stage 2: get_cached_uri FAILED]', {
          trackId: trackIdStr,
          error: cacheErr?.message,
        });
        this.lastCacheError = new PlaybackError(
          cacheErr?.message || 'Cache lookup failed',
          {
            type: 'local_cache_error',
            cause: cacheErr,
            trackId: trackIdStr,
          },
        );
        localUri = null;
      }
    }

    const expectedUri = localUri || normalizedStreamUrl;
    const expectedIsLocal = Boolean(localUri);

    const headers = options.headers || {};
    let cleanHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === 'string' && v.trim()) cleanHeaders[k] = v.trim();
    }
    let hasHeaders = Object.keys(cleanHeaders).length > 0;
    const sameHeaders =
      expectedIsLocal ||
      areHeadersEqual(cleanHeaders, this._currentSourceHeaders);

    // 3. Идемпотентность play: если уже играет тот же трек, источник и заголовки не изменились
    // Либо если это обычный ререндер уже играющего здорового трека (без смены трека и без force),
    // то уже играющий нативный источник не заменяется даже при фоновой смене адреса сервера.
    const isRerenderOfCurrent =
      !options.force &&
      !options.isUserSelection &&
      this.currentTrackId === trackIdStr &&
      Boolean(this.currentPlayUri);

    if (
      (!options.force &&
        this.currentTrackId === trackIdStr &&
        this.currentPlayUri === expectedUri &&
        sameHeaders) ||
      (isRerenderOfCurrent && serverChanged && sameHeaders)
    ) {
      this._log(
        '[Coordinator] Idempotent play() - same track, uri, and headers, resuming playback',
      );
      this.applyVolumeNormalization(player, track, options);
      try {
        if (
          this.identityAvailable &&
          typeof player.playForAttempt === 'function' &&
          this.current.sourceAttemptId
        ) {
          player.playForAttempt(this.current.sourceAttemptId, null);
        } else {
          await player.play();
        }
      } catch (playErr) {
        const classified = new PlaybackError(
          playErr?.message || 'Player play failed',
          {
            type: 'play_error',
            cause: playErr,
            trackId: trackIdStr,
          },
        );
        this.current.error = {
          kind: 'playback',
          retryable: true,
          message: classified.message,
        };
        this.current.status = 'error';
        this.networkError = classified.message;
        this.networkStatus = 'error';
        this.lastErrorType = classified.type;
        this._notifyState();
        throw classified;
      }
      return {
        isLocal: this.currentIsLocal,
        uri: this.currentPlayUri,
        requestId: this.current.requestId,
        sourceAttemptId: this.current.sourceAttemptId,
        confirmation: this.identityAvailable ? 'pending' : 'unavailable',
        reused: true,
      };
    }

    // 4. Generation token защиты от race condition при быстрых переключениях
    this.playbackGeneration += 1;
    const currentGeneration = this.playbackGeneration;
    const requestServerEpoch = this.serverEpoch;
    const isCurrent = () =>
      this.playbackGeneration === currentGeneration &&
      this.serverEpoch === requestServerEpoch;

    let sourceAttemptId = `att_${++this._attemptIdCounter}_${Date.now()}`;

    if (this._backgroundCacheTimer) {
      clearTimeout(this._backgroundCacheTimer);
      this._backgroundCacheTimer = null;
    }

    this.currentTrack = track;
    this.currentTrackId = trackIdStr;

    this._activeRetryPromise = null;

    // Reset episode state and watchdogs
    this._episodeStartTime = this.clock();
    this._episodeDeadline = this._episodeStartTime + this.episodeTotalMs;
    this._activeEpisodeType = 'startup';
    this._stallEpisodeDeadline = 0;
    this._lastProgressTime = 0;
    this._lastConfirmedPosition = null;
    this._confirmedPlaybackStarted = false;
    this._finishHandled = false;
    this._acceptedIntentRevision = -1;
    this._lastSeekTarget = null;
    this._seekPending = false;
    this._progressEvents = [];
    this._hasStableProof = false;
    this._clearWatchdogs();
    this._cancelRecovery('new_selection');
    this._waitForLoaded = true;

    const initialIntent = options.initialIntent || 'play';
    this.current = {
      requestId,
      trackId: trackIdStr,
      sourceAttemptId,
      source: expectedIsLocal ? 'local' : 'remote',
      status: initialIntent === 'pause' ? 'paused' : 'starting',
      intent: initialIntent,
      positionSeconds: 0,
      error: null,
      recoveryCount: 0,
    };

    this._explicitInstallAttempt = sourceAttemptId;
    this._recordDiagnostic('play');

    if (
      this.scheduler &&
      typeof this.scheduler.setPlaybackPressure === 'function'
    ) {
      this.scheduler.setPlaybackPressure({ requestId, phase: 'startup' });
    }

    if (this.identityAvailable) {
      this._armEpisodeDeadlineTimer(this._episodeDeadline);
      this._armStartupWatchdog(sourceAttemptId, requestId);
    }

    // Немедленное синхронное обновление метаданных и обложки на экране блокировки/шторке,
    // не дожидаясь окончания сетевой буферизации аудио и вызова player.play().
    this.applyLockScreenMetadata(player, track, isCurrent);
    this.applyVolumeNormalization(player, track, options);

    let isLocal = false;
    let playUri = null;

    // СТАДИЯ 3: Native replace
    if (localUri) {
      isLocal = true;
      playUri = localUri;
      this._log('[Coordinator][Stage 3: local_replace]', {
        trackId: trackIdStr,
        localUri,
      });

      try {
        const replaceRes = await this._performReplace(
          player,
          { uri: localUri },
          isCurrent,
          currentGeneration,
          requestServerEpoch,
          sourceAttemptId,
        );
        if (replaceRes.superseded)
          return {
            isLocal: false,
            uri: null,
            requestId,
            sourceAttemptId,
            confirmation: this.identityAvailable ? 'pending' : 'unavailable',
            superseded: true,
          };
      } catch (localErr) {
        if (!isCurrent())
          return {
            isLocal: false,
            uri: null,
            requestId,
            sourceAttemptId,
            confirmation: this.identityAvailable ? 'pending' : 'unavailable',
            superseded: true,
          };
        this._warn(
          '[Coordinator][Stage 3: local_replace FAILED, falling back to remote]',
          localErr?.message,
        );
        if (this.cache && typeof this.cache.invalidate === 'function') {
          this.cache.invalidate(trackIdStr, localUri).catch(() => {});
        }
        this.lastCacheError = new PlaybackError(
          localErr?.message || 'Local replace failed',
          {
            type: 'local_cache_error',
            cause: localErr,
            trackId: trackIdStr,
          },
        );
        isLocal = false;
        playUri = null;
        if (this.identityAvailable) {
          sourceAttemptId = `att_${++this._attemptIdCounter}_${Date.now()}`;
          this.current.sourceAttemptId = sourceAttemptId;
          this.current.source = 'remote';
        }
      }
    }

    if (!isCurrent()) {
      return {
        isLocal: false,
        uri: null,
        requestId,
        sourceAttemptId,
        confirmation: this.identityAvailable ? 'pending' : 'unavailable',
        superseded: true,
      };
    }

    if (!playUri) {
      isLocal = false;
      playUri = normalizedStreamUrl;
      this._log('[Coordinator][Stage 3: remote_replace]', {
        trackId: trackIdStr,
        normalizedStreamUrl,
      });

      // При отсутствии синхронных заголовков резолвим асинхронный геттер (например, SecureStore)
      if (!hasHeaders && typeof headersGetter === 'function') {
        try {
          const asyncHeaders = await headersGetter();
          if (asyncHeaders && typeof asyncHeaders === 'object') {
            for (const [k, v] of Object.entries(asyncHeaders)) {
              if (typeof v === 'string' && v.trim()) cleanHeaders[k] = v.trim();
            }
            hasHeaders = Object.keys(cleanHeaders).length > 0;
          }
        } catch (hdrErr) {
          this._warn(
            '[Coordinator] Failed to resolve auth headers asynchronously:',
            hdrErr?.message,
          );
        }
      }

      if (!isCurrent()) {
        return {
          isLocal: false,
          uri: null,
          requestId,
          sourceAttemptId,
          confirmation: this.identityAvailable ? 'pending' : 'unavailable',
          superseded: true,
        };
      }

      const currentServerUrlAfterHeaders = this._resolveServerUrl();
      if (
        this._lastServerUrl &&
        this._lastServerUrl !== currentServerUrlAfterHeaders
      ) {
        this._lastServerUrl = currentServerUrlAfterHeaders;
        this.serverEpoch += 1;
        requestServerEpoch = this.serverEpoch;
        if (this.scheduler && typeof this.scheduler.cancelAll === 'function') {
          this.scheduler.cancelAll();
        }
      }
      const finalStreamUrl = normalizeStreamUrl(
        track,
        currentServerUrlAfterHeaders,
      );
      playUri = finalStreamUrl;

      const source = hasHeaders
        ? { uri: finalStreamUrl, headers: cleanHeaders }
        : { uri: finalStreamUrl };

      try {
        const replaceRes = await this._performReplace(
          player,
          source,
          isCurrent,
          currentGeneration,
          requestServerEpoch,
          sourceAttemptId,
        );
        if (replaceRes.superseded)
          return {
            isLocal: false,
            uri: null,
            requestId,
            sourceAttemptId,
            confirmation: this.identityAvailable ? 'pending' : 'unavailable',
            superseded: true,
          };
      } catch (remoteErr) {
        if (!isCurrent())
          return {
            isLocal: false,
            uri: null,
            requestId,
            sourceAttemptId,
            confirmation: this.identityAvailable ? 'pending' : 'unavailable',
            superseded: true,
          };
        this._log(
          '[Coordinator][Stage 3: remote_replace retrying once via replaceCurrentSource...]',
        );

        try {
          const retryRes = await this._performReplace(
            player,
            source,
            isCurrent,
            currentGeneration,
            requestServerEpoch,
            sourceAttemptId,
          );
          if (retryRes.superseded)
            return {
              isLocal: false,
              uri: null,
              requestId,
              sourceAttemptId,
              confirmation: this.identityAvailable ? 'pending' : 'unavailable',
              superseded: true,
            };
        } catch (retryErr) {
          if (!isCurrent())
            return {
              isLocal: false,
              uri: null,
              requestId,
              sourceAttemptId,
              confirmation: this.identityAvailable ? 'pending' : 'unavailable',
              superseded: true,
            };

          this.currentPlayUri = null;
          this.currentIsLocal = false;
          const classified = classifyPlaybackError(
            retryErr || remoteErr,
            trackIdStr,
          );
          this.current.error = {
            kind: classified.type,
            retryable: true,
            message: classified.message,
          };
          this.current.status = 'error';
          this.networkError = classified.message;
          this.networkStatus = 'error';
          this.lastErrorType = classified.type;
          this._notifyState();
          throw classified;
        }
      }

      if (!isCurrent()) {
        return {
          isLocal: false,
          uri: null,
          requestId,
          sourceAttemptId,
          confirmation: this.identityAvailable ? 'pending' : 'unavailable',
          superseded: true,
        };
      }

      // Фоновое кеширование текущего трека через scheduler (scheduler управляет задержкой 5с после stable)
      if (!this.bypassCache) {
        if (
          this.scheduler &&
          typeof this.scheduler.cacheCurrent === 'function'
        ) {
          this.scheduler
            .cacheCurrent(track, { headers: cleanHeaders })
            .catch((cacheErr) => {
              this._warn(
                `[Coordinator] Background cacheCurrent for track ${trackIdStr} failed:`,
                cacheErr?.message,
              );
            });
        } else {
          const cacheDelay =
            options.cacheDelayMs !== undefined
              ? options.cacheDelayMs
              : this.backgroundCacheDelayMs;

          const triggerBackgroundCache = () => {
            if (!isCurrent()) return;
            if (this.cache && typeof this.cache.getOrFetch === 'function') {
              this.cache
                .getOrFetch(trackIdStr, normalizedStreamUrl, {
                  headers: cleanHeaders,
                })
                .catch((cacheErr) => {
                  this._warn(
                    `[Coordinator] Background cache for track ${trackIdStr} failed:`,
                    cacheErr?.message,
                  );
                });
            }
          };

          if (cacheDelay > 0) {
            this._backgroundCacheTimer = setTimeout(() => {
              this._backgroundCacheTimer = null;
              triggerBackgroundCache();
            }, cacheDelay);
          } else {
            triggerBackgroundCache();
          }
        }
      }
    }

    if (!isCurrent()) {
      return {
        isLocal: false,
        uri: null,
        requestId,
        sourceAttemptId,
        confirmation: this.identityAvailable ? 'pending' : 'unavailable',
        superseded: true,
      };
    }

    if (this.current.error || this.current.recoveryCount > 0) {
      return {
        isLocal,
        uri: playUri,
        requestId,
        sourceAttemptId,
        superseded: true,
      };
    }

    // СТАДИЯ 4: Native play
    this._log('[Coordinator][Stage 4: player_play]', {
      trackId: trackIdStr,
      isLocal,
      playUri,
    });

    this.applyVolumeNormalization(player, track, options);

    if (this.current.intent === 'play' && !options.suppressPlay) {
      if (
        this.identityAvailable &&
        typeof player.playForAttempt === 'function'
      ) {
        const playOk = player.playForAttempt(sourceAttemptId, null);
        if (!playOk) {
          const playErr = new PlaybackError(
            'player.playForAttempt rejected command',
            {
              type: 'play_error',
              trackId: trackIdStr,
            },
          );
          this.current.error = {
            kind: 'playback',
            retryable: true,
            message: playErr.message,
          };
          this.current.status = 'error';
          this.networkError = playErr.message;
          this.networkStatus = 'error';
          this.lastErrorType = playErr.type;
          this._notifyState();
          throw playErr;
        }
        this.current.status = 'starting';
      } else if (!this.identityAvailable) {
        try {
          await player.play();
        } catch (playErr) {
          if (!isCurrent())
            return {
              isLocal: false,
              uri: null,
              requestId,
              sourceAttemptId,
              confirmation: this.identityAvailable ? 'pending' : 'unavailable',
              superseded: true,
            };

          this.currentPlayUri = null;
          this.currentIsLocal = false;
          const classified = new PlaybackError(
            playErr?.message || 'Player play failed',
            {
              type: 'play_error',
              cause: playErr,
              trackId: trackIdStr,
            },
          );
          this.current.error = {
            kind: 'playback',
            retryable: true,
            message: classified.message,
          };
          this.current.status = 'error';
          this.networkError = classified.message;
          this.networkStatus = 'error';
          this.lastErrorType = classified.type;
          this._notifyState();
          throw classified;
        }
      }
    } else {
      this.current.status = 'paused';
    }

    if (!isCurrent()) {
      return {
        isLocal: false,
        uri: null,
        requestId,
        sourceAttemptId,
        confirmation: this.identityAvailable ? 'pending' : 'unavailable',
        superseded: true,
      };
    }

    // Сохраняем активный источник после успешного replace + play
    this.currentPlayUri = playUri;
    this.currentIsLocal = isLocal;
    this._currentSourceHeaders = hasHeaders ? cleanHeaders : null;

    // СТАДИЯ 5: Обновление метаданных Lock Screen
    this._log('[Coordinator][Stage 5: lock_screen]', {
      trackId: trackIdStr,
      title: track?.title,
    });

    try {
      await this.updateLockScreenMetadata(player, track, isCurrent);
    } catch (lockErr) {
      this._warn(
        '[Coordinator][Stage 5: lock_screen FAILED]',
        lockErr?.message,
      );
    }

    if (!isCurrent()) {
      return {
        isLocal: false,
        uri: null,
        requestId,
        sourceAttemptId,
        confirmation: this.identityAvailable ? 'pending' : 'unavailable',
        superseded: true,
      };
    }

    // Сбрасываем ошибку сети при успешном начале воспроизведения
    this.networkError = null;
    this.networkStatus = 'good';
    this.lastErrorType = null;
    this._notifyState();

    return {
      isLocal,
      uri: playUri,
      requestId,
      sourceAttemptId,
      confirmation: this.identityAvailable ? 'pending' : 'unavailable',
    };
  }

  /**
   * Обновляет состояние очереди в координаторе и передаёт в планировщик предзагрузки.
   *
   * @param {Object|null} currentTrack
   * @param {Array<Object>} upNextQueue
   * @param {Object} [options]
   */
  updateQueue(currentTrack, upNextQueue = [], options = {}) {
    this.currentTrack = currentTrack;
    this.upNextQueue = Array.isArray(upNextQueue) ? upNextQueue : [];

    // Защищаем текущий трек и очередь от LRU вытеснения из кеша
    if (this.cache && typeof this.cache.setProtectedTrackIds === 'function') {
      const protectedIds = [];
      const curId = getTrackId(currentTrack);
      if (curId !== null) protectedIds.push(curId);
      for (const t of this.upNextQueue) {
        const qId = getTrackId(t);
        if (qId !== null) protectedIds.push(qId);
      }
      this.cache.setProtectedTrackIds(protectedIds);
    }

    // Синхронизируем планировщик
    this.scheduler.syncQueue(currentTrack, this.upNextQueue, options);

    // Обновляем статус следующего трека
    const nextTrack = this.upNextQueue[0];
    const nextId = getTrackId(nextTrack);

    if (nextId !== null) {
      const nextIdStr = String(nextId).trim();
      this.next.trackId = nextIdStr;
      this.next.status = this.scheduler.getStatus(nextIdStr);
      this.nextTrackStatus = this.next.status;
      const err = this.scheduler.getError(nextIdStr);
      if (err) {
        this.next.error = {
          kind: 'network_error',
          retryable: true,
          message: err?.message,
        };
        if (!this.current.error) {
          this.networkError = err?.message || null;
          if (this.next.status === TRACK_STATUS.FAILED) {
            this.networkStatus = 'error';
            const classified = classifyPlaybackError(err, nextIdStr);
            this.lastErrorType = classified.type;
          }
        }
      } else {
        this.next.error = null;
        if (!this.current.error && this.networkStatus === 'error') {
          this.networkStatus = 'good';
          this.networkError = null;
          this.lastErrorType = null;
        }
      }
    } else {
      this.next.trackId = null;
      this.next.status = TRACK_STATUS.IDLE;
      this.next.error = null;
      this.nextTrackStatus = TRACK_STATUS.IDLE;
    }

    // Предзагружаем обложку следующего трека для мгновенного отображения при переключении
    if (this.upNextQueue.length > 0 && this.upNextQueue[0]?.coverArt) {
      prefetchCover(this.upNextQueue[0].coverArt);
    }

    this._notifyState();
  }

  /**
   * Отслеживает буферизацию плеера и выявляет медленное соединение.
   * @param {boolean} isBuffering
   */
  handleBufferingStatus(isBuffering) {
    if (isBuffering) {
      if (!this._bufferingTimeout) {
        // Если буферизация длится дольше 3.5 секунд — информируем о медленном интернете
        this._bufferingTimeout = setTimeout(() => {
          this.isBufferingSlow = true;
          this.networkStatus = 'slow';
          this._notifyState();
        }, 3500);
      }
    } else {
      if (this._bufferingTimeout) {
        clearTimeout(this._bufferingTimeout);
        this._bufferingTimeout = null;
      }
      if (this.isBufferingSlow) {
        this.isBufferingSlow = false;
        if (this.networkStatus === 'slow') {
          this.networkStatus = 'good';
        }
        this._notifyState();
      }
    }
  }

  /**
   * Немедленно применяет метаданные экрана блокировки (Now Playing Info) для трека.
   * Синхронно устанавливает title, artist, albumTitle и artworkUrl (если токен уже закэширован в памяти).
   * Если токен еще не был загружен в память, асинхронно дочитывает его и обновляет обложку.
   */
  applyLockScreenMetadata(player, track, isCurrent = null) {
    if (!player || typeof player.setActiveForLockScreen !== 'function') return;
    if (isCurrent && !isCurrent()) return;

    try {
      const token = getCachedAuthToken();
      const artworkUrl = track?.coverArt
        ? resolveCoverUri(track.coverArt, token)
        : undefined;
      player.setActiveForLockScreen(
        true,
        {
          title: track?.title || 'Unknown Track',
          artist: track?.artist || 'Unknown Artist',
          albumTitle: track?.album || 'Puuk',
          artworkUrl,
        },
        {
          isLiveStream: false,
          showSeekForward: false,
          showSeekBackward: false,
        },
      );

      if (!token) {
        this.updateLockScreenMetadata(player, track, isCurrent).catch((err) => {
          this._warn(
            '[Coordinator] Async token lock screen update failed:',
            err?.message,
          );
        });
      }
    } catch (err) {
      this._warn(
        '[Coordinator] Failed to set immediate lock screen controls:',
        err?.message,
      );
    }
  }

  /**
   * Применяет выравнивание громкости (нормализацию) к плееру.
   *
   * @param {Object} player
   * @param {Object|null|undefined} [track]
   * @param {Object} [options]
   * @param {boolean} [options.soundCheck]
   * @returns {number} Применённая громкость (0.0 - 1.0)
   */
  applyVolumeNormalization(player, track = this.currentTrack, options = {}) {
    const isNormalizationEnabled =
      options.soundCheck !== undefined
        ? Boolean(options.soundCheck)
        : typeof getSettings === 'function'
          ? Boolean(getSettings()?.soundCheck)
          : true;

    const effectiveVolume = applyTrackNormalization(
      player,
      track,
      isNormalizationEnabled,
    );
    this._log('[Coordinator] Applied volume normalization:', {
      trackId: getTrackId(track),
      isNormalizationEnabled,
      loudnessStatus: track?.loudness_status,
      normalizationGainDb: track?.normalization_gain_db,
      effectiveVolume,
    });
    return effectiveVolume;
  }

  /**
   * Обновляет метаданные экрана блокировки (Now Playing Info) для трека.
   * Безопасен к асинхронным гонкам и смене активного трека.
   */
  async updateLockScreenMetadata(player, track, isCurrent = null) {
    if (!player || typeof player.setActiveForLockScreen !== 'function') return;
    if (isCurrent && !isCurrent()) return;

    try {
      let token = getCachedAuthToken();
      if (!token) {
        try {
          token = await getAuthToken();
        } catch {}
      }

      if (isCurrent && !isCurrent()) return;

      if (this.currentTrack && !areTrackIdsEqual(track, this.currentTrack)) {
        // Трек уже сменился — не перезаписываем экран блокировки устаревшими данными
        return;
      }

      const artworkUrl = track?.coverArt
        ? resolveCoverUri(track.coverArt, token)
        : undefined;
      player.setActiveForLockScreen(
        true,
        {
          title: track?.title || 'Unknown Track',
          artist: track?.artist || 'Unknown Artist',
          albumTitle: track?.album || 'Puuk',
          artworkUrl,
        },
        {
          isLiveStream: false,
          showSeekForward: false,
          showSeekBackward: false,
        },
      );
    } catch (err) {
      this._warn(
        '[Coordinator] Failed to set lock screen controls:',
        err?.message,
      );
    }
  }

  /**
   * Подписка на изменение сетевых статусов и предзагрузки для UI.
   * @param {Function} listener ({ networkStatus, nextTrackStatus, networkError, isBufferingSlow, lastErrorType }) => void
   * @returns {Function} unsubscribe
   */
  subscribe(listener) {
    this.listeners.add(listener);
    // Сразу передаём текущее состояние
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState() {
    let networkStatus = 'good';
    let networkError = null;
    let lastErrorType = null;

    if (this.current.error) {
      networkStatus = 'error';
      networkError =
        this.networkError || this.current.error.message || 'Playback error';
      lastErrorType = this.lastErrorType || this.current.error.kind;
    } else if (this.networkError || this.networkStatus === 'error') {
      networkStatus = 'error';
      networkError = this.networkError;
      lastErrorType = this.lastErrorType;
    } else if (this.isBufferingSlow || this.current.status === 'stalled') {
      networkStatus = 'slow';
    } else if (this.next.error || this.next.status === TRACK_STATUS.FAILED) {
      networkStatus = 'error';
      networkError =
        this.next.error?.message || this.networkError || 'Failed to download';
      lastErrorType =
        this.next.error?.kind || this.lastErrorType || 'network_error';
    }

    return {
      identityAvailable: this.identityAvailable,
      current: { ...this.current },
      next: { ...this.next },
      networkStatus,
      nextTrackStatus: this.next.status,
      networkError,
      lastErrorType,
      isBufferingSlow: this.isBufferingSlow,
    };
  }

  // --- Внутренние методы ---

  _handleSchedulerEvent(event) {
    const nextTrack = this.upNextQueue[0];
    if (areTrackIdsEqual(nextTrack, event?.trackId)) {
      this.next.trackId = String(getTrackId(nextTrack));
      this.next.status = event.status;
      this.nextTrackStatus = event.status;

      if (event.status === TRACK_STATUS.READY) {
        this.next.error = null;
        if (!this.current.error) {
          this.networkError = null;
          this.networkStatus = 'good';
          this.lastErrorType = null;
        }
      } else if (event.status === TRACK_STATUS.FAILED) {
        this.next.error = {
          kind: 'network_error',
          retryable: true,
          message: event.error?.message || 'Failed to download',
        };
        if (!this.current.error) {
          this.networkError = event.error?.message || 'Failed to download';
          this.networkStatus = 'error';
          const classified = classifyPlaybackError(event.error, event.trackId);
          this.lastErrorType = classified.type;
        }
      }
      this._notifyState();
    }
  }

  _notifyState() {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        this._warn('[Coordinator] listener error:', err);
      }
    }
  }

  _log() {
    if (this.debug) this._recordDiagnostic('command');
  }

  _warn() {
    if (this.debug) this._recordDiagnostic('command_warning');
  }

  _error() {
    if (this.debug) this._recordDiagnostic('command_error');
  }
}

const defaultPlaybackCoordinator = new PlaybackCoordinator();
export default defaultPlaybackCoordinator;
