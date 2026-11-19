import { acquirePlayable, getOfflineSession, isOfflineSessionCurrent, markMissing } from '../offline';
/**
 * Playback Coordinator.
 * Coordinates AudioPlayer (expo-audio), AudioCache, and PreloadScheduler.
 * Implements gapless preload/replace mechanism, remote URI fallback,
 * idempotent playback, generation/token race protection,
 * fine-grained error classification, and debug-gated diagnostics.
 */

import { mediaDelivery, boundedMediaOperation } from '../shared/api/media';
import defaultAudioCache from './audioCache';
import defaultPreloadScheduler, { TRACK_STATUS } from './preloadScheduler';
import { isServerCoverUri, resolveCoverUri, resolveLockScreenCover, prefetchCover } from '../shared/media/CoverImage';
import {
  SERVER_URL,
  addSessionListener,
  getAuthSessionGeneration,
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

  const msg = err?.message || '';
  const safeMessage = 'Playback error';
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

  return new PlaybackError(safeMessage, { type, trackId });
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
    this._offlineLease = null;
    this.resolveMedia = options.resolveMedia || ((track, opts) => mediaDelivery.resolve(track, opts));
    this._mediaController = null;
    this._mediaDescriptor = null;
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
      error: null, // null | { kind: 'auth'|'not_found'|'transient'|'playback'|'timeout', retryable: boolean, message?: string, holdTrack?: boolean }
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

    // Buffering observation and explicit Retry command timeouts
    this.stallTimeoutMs = options.stallTimeoutMs ?? 7000;
    this.headerTimeoutMs = options.headerTimeoutMs ?? 3000;
    this.seekTimeoutMs = options.seekTimeoutMs ?? 5000;

    // Intent and progress confirmation
    this._intentGeneration = 0;
    this._loadedCompletionCallback = null;
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
    this._stallTimer = null;
    this._activeRetryPromise = null;
    this._manualRetryToken = null;

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
  _clearStallWatchdog() {
    if (this._stallTimer) {
      clearTimeout(this._stallTimer);
      this._stallTimer = null;
    }
  }

  _armStallWatchdog(attemptId, requestId) {
    this._clearStallWatchdog();
    if (!this.identityAvailable) {
      return;
    }
    // The native item stays installed and owns buffering and resumption.
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
      }
    }, this.stallTimeoutMs);
  }

  _cancelRetry(reason = 'cancelled') {
    this._intentGeneration += 1;
    if (this._manualRetryToken) {
      this._manualRetryToken = null;
      if (reason !== 'user_seek' && reason !== 'user_seekIntent')
        this._seekPending = false;
    }
    if (this._retryCancel) this._retryCancel();
    if (this._loadedCompletionCallback) {
      this._loadedCompletionCallback(null);
      this._loadedCompletionCallback = null;
    }
    if (this._seekCompletionCallback) {
      this._seekCompletionCallback(null);
      this._seekCompletionCallback = null;
    }
  }

  async _resolveRemote(track, { force = false } = {}) {
    const selection = this.playbackGeneration;
    const auth = getAuthSessionGeneration();
    const server = this._resolveServerUrl();
    const controller = this._mediaController;
    let negotiated = false;
    const descriptor = await boundedMediaOperation(
      signal => this.resolveMedia(track, {
        force,
        priority: 'current',
        signal,
        consumeNegotiation: () => {
          if (negotiated) return false;
          negotiated = true;
          return true;
        },
      }),
      { signal: controller?.signal },
    );
    if (
      selection !== this.playbackGeneration ||
      auth !== getAuthSessionGeneration() ||
      server !== this._resolveServerUrl() ||
      controller?.signal.aborted
    ) {
      throw new PlaybackError('Superseded', { type: 'abort' });
    }
    this._mediaDescriptor = descriptor;
    return descriptor;
  }

  foreground() {
    this._mediaController?.abort();
    this._mediaController = new AbortController();
    mediaDelivery.invalidate();
    this.cache.setForeground?.(true);
  }

  _terminateWithError(error, { holdTrack = false } = {}) {
    this._clearStallWatchdog();
    this._cancelRetry('error');
    this.current.status = 'error';
    this._mediaController?.abort();
    this._terminating = true;
    this._terminalUnloaded = false;
    this._terminalUnloadFailed = false;
    if (!holdTrack) {
      try {
        this._unloadSource(this._player);
        this._terminalUnloaded = true;
      } catch {
        this._terminalUnloadFailed = true;
        // Best effort stop when unload is unavailable. Never infer that it succeeded.
        try { this._player?.pause?.(); } catch {}
        this.current.intent = 'pause';
      }
    }
    this._terminating = false;
    this.current.status = 'error';
    const isAuth = error.type === 'auth_error' || error.type === 'auth';
    const isNotFound = error.type === 'not_found' || [403, 404, 410].includes(error.status) || error.type === 'security';
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
      ...(holdTrack && { holdTrack }),
      message: this._terminalUnloadFailed ? 'Unable to unload audio' : safeMessage,
    };
    this.networkStatus = 'error';
    this.networkError = this.current.error.message;
    this.lastErrorType = error.type || kind;
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
      'terminated_error',
      'cancelled',
      'intent_play',
      'intent_pause',
      'intent_seek',
      'stable_proof',
      'stall_timeout_fired',
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
    };

    if (this._diagnosticsRing.length >= 200) {
      this._diagnosticsRing.shift();
    }
    this._diagnosticsRing.push(entry);
  }

  getDiagnostics() {
    return [...this._diagnosticsRing];
  }

  _unloadSource(player) {
    if (typeof player?.replace !== 'function') throw new Error('unload unavailable');
    const result = player.replace(null);
    // Expo's replace is synchronous. A rejected or deferred command cannot
    // establish that native playback has released the file.
    if (typeof result?.then === 'function') {
      Promise.resolve(result).catch(() => {});
      throw new Error('unload unconfirmed');
    }
    if (result === false) throw new Error('unload rejected');
    this._offlineLease?.release();
    this._offlineLease = null;
  }

  cancelCurrent(reason = 'superseded', player = null) {
    this._mediaController?.abort();
    this._mediaDescriptor = null;
    this.playbackGeneration += 1;
    this._clearStallWatchdog();
    this._cancelRetry(reason);
    this._activeRetryPromise = null;

    if (reason === 'auth-change' || reason === 'logout') {
      this._authEpoch += 1;
    }

    this.current.requestId = null;
    this.current.sourceAttemptId = null;
    this.current.trackId = null;
    this.current.status = 'idle';
    this.current.source = null;
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
      reason === 'dismiss' || reason === 'server' || reason === 'token'
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

    try { p?.setActiveForLockScreen?.(false); } catch {}
    try { this._unloadSource(p); } catch {}
    this.cache?.setActiveTrackId?.(null);
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

    if (type === 'play' && (this._terminalUnloadFailed || this.current.error)) {
      this._notifyState();
      return; // Retry must first prepare a valid source.
    }

    if (type === 'pause') {
      this.current.intent = 'pause';
      this.current.status = 'paused';
      this._clearStallWatchdog();
      this._cancelRetry('user_pause');
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
        this._cancelRetry('user_play');
      this.current.intent = 'play';
      const isResuming =
        this.current.status === 'paused' ||
        this.current.status === 'interrupted';
      if (isResuming) {
        this.current.status = 'starting'; // Remains starting until progress confirms audio!
        this._confirmedPlaybackStarted = false;
        this._hasStableProof = false;
        this._progressEvents = [];
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
      this._cancelRetry('user_seek');
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

    // Resolve terminal state before creating a retry token or mutating generations.
    if (this._terminalUnloadFailed) {
      try {
        this._unloadSource(player);
        this._terminalUnloadFailed = false;
        this._terminalUnloaded = true;
      } catch {
        this._notifyState();
        return { isLocal: false, uri: null, requestId };
      }
    }
    // Snapshot native intent before any awaited ticket operation. Every installation
    // compares it under the native source lock, including paused preparation.
    let retrySnapshot = null;
    if (this.identityAvailable) {
      try { retrySnapshot = player.currentStatus; } catch {}
      const expectedAttempt = this._terminalUnloaded ? null : this.current.sourceAttemptId;
      const atomicIntent = player.puukExpectedIntentVersion === 1 &&
        typeof player.replaceWithExpectedIntent === 'function';
      if (retrySnapshot?.sourceIdentityVersion !== 1 ||
          retrySnapshot.sourceAttemptId !== expectedAttempt ||
          !['play', 'pause'].includes(retrySnapshot.nativeIntent) ||
          !Number.isInteger(retrySnapshot.intentRevision) || retrySnapshot.intentRevision < 0 ||
          (retrySnapshot.nativeIntent === 'pause' && !atomicIntent)) {
        // Older binaries cannot prepare paused sources atomically. Keep the error
        // visible and require a rebuilt binary rather than install without a guard.
        this.current.intent = 'pause';
        this._notifyState();
        return { isLocal: false, uri: null, requestId };
      }
      this.current.intent = retrySnapshot.nativeIntent;
      this._acceptedIntentRevision = retrySnapshot.intentRevision;
    }

    this._clearStallWatchdog();
    this._cancelRetry('manual_retry');
    const retryGen = ++this._retryGeneration;
    this._manualRetryToken = retryGen;
    const generation = ++this.playbackGeneration;
    const intentGeneration = this._intentGeneration;
    if (options.authEpoch !== undefined) this._authEpoch = options.authEpoch;
    const auth = this._authEpoch;
    const intent = this.current.intent;
    const target = this.current.positionSeconds ?? 0;
    let attempt = this.current.sourceAttemptId;
    const isStale = () =>
      this._retryGeneration !== retryGen ||
      this.playbackGeneration !== generation ||
      this._intentGeneration !== intentGeneration ||
      this._authEpoch !== auth ||
      this.current.requestId !== requestId ||
      this.current.sourceAttemptId !== attempt;
    const result = {
      isLocal: false,
      uri: null,
      requestId,
      sourceAttemptId: attempt,
    };
    this._mediaController?.abort();
    this._mediaController = new AbortController();
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
      const getHeaders = options.getHeaders || options.getHeadersAsync;
      if (getHeaders) this._getHeadersAsyncFn = getHeaders;
      const descriptor = await this._retryWait(
        () => this._resolveRemote(track, { force: true }),
        3000,
        isStale,
      );
      if (isStale()) return result;
      const uri = descriptor.uri;
      const cleanHeaders = { ...descriptor.headers };
      const source = { uri, headers: cleanHeaders };
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
          if (!this.identityAvailable) return player.replace(source);
          if (player.puukExpectedIntentVersion === 1 &&
              typeof player.replaceWithExpectedIntent === 'function') {
            return player.replaceWithExpectedIntent(source, attempt,
              retrySnapshot.intentRevision, retrySnapshot.sourceAttemptId,
              retrySnapshot.nativeIntent);
          }
          // Legacy guarded API supports play intent only; paused path was rejected above.
          return player.replaceWithAttempt(source, attempt,
            retrySnapshot.intentRevision, retrySnapshot.sourceAttemptId);
        },
        this.headerTimeoutMs,
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
      this._terminalUnloaded = false;
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
              this.seekTimeoutMs,
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
          this.seekTimeoutMs,
          isStale,
        );
      } else if (target > 0 && typeof player.seekTo === 'function') {
        await this._retryWait(
          () => player.seekTo(target),
          this.seekTimeoutMs,
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
          this.seekTimeoutMs,
          isStale,
        );
        if (isStale()) return result;
        if (this.identityAvailable && acceptedPlay !== true)
          throw new PlaybackError('Resume rejected', { type: 'play_error' });
        this.current.status = 'starting';
      } else {
        this.current.status = 'paused';
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
    if (this._terminating || this.current.error) return { accepted: false, didStart: false, didFinish: false };
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
      this._clearStallWatchdog();
      this._cancelRetry('native_pause');
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
        this._confirmedPlaybackStarted = false;
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
        this._cancelRetry('user_seekIntent');
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
      !sourceError &&
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

      if (this.current.status === 'stalled' && this._hasStableProof) {
        this.scheduler?.setPlaybackPressure?.({
          requestId: this.current.requestId,
          phase: 'stable',
        });
      }

      if (!this._confirmedPlaybackStarted) {
        this._confirmedPlaybackStarted = true;
        const reqId = this.current.requestId;
        const isFirstForLogicalRequest =
          reqId && !this._startedRequestIds.has(reqId);
        if (isFirstForLogicalRequest) {
          this._startedRequestIds.add(reqId);
          while (this._startedRequestIds.size > 200) this._startedRequestIds.delete(this._startedRequestIds.values().next().value);
          didStart = true;
        } else if (!reqId) {
          didStart = true;
        }
        this.networkError = null;
        this.lastErrorType = null;
      }
      this.current.status = 'playing';
      this.networkStatus = 'good';
      this._armStallWatchdog(this.current.sourceAttemptId, this.current.requestId);

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

    if (!sourceError && (event.nativeEvent === 'finish' || event.didJustFinish)) {
      if (!this._finishHandled) {
        this._finishHandled = true;
        didFinish = true;
        this.current.status = 'idle';
        this._clearStallWatchdog();
        this._cancelRetry('finish');
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
              typeof event.error === 'string' ? event.error : 'Native playback error',
            );
      const error = classifyPlaybackError(errorPayload, this.current.trackId);

      if (
        this.current.source === 'local' &&
        error.type !== 'auth_error' &&
        error.type !== 'not_found'
      ) {
        if (this._offlineLease) {
          const { session, mediaKey } = this._offlineLease;
          markMissing(session, mediaKey, 'native_source_failed').catch(() => {});
        } else if (this.currentPlayUri) {
          this.cache
            ?.invalidate?.(this.current.trackId, this.currentPlayUri)
            ?.catch(() => {});
        }
        this._terminateWithError(
          new PlaybackError('Local audio failed', {
            type: 'local_cache_error',
            cause: errorPayload,
            trackId: this.current.trackId,
          }),
        );
      } else {
        const holdTrack = this.current.source === 'remote';
        if (holdTrack && !this._seekPending && Number.isFinite(event.currentTime)) {
          this.current.positionSeconds = Math.max(
            this.current.positionSeconds,
            event.currentTime,
          );
        }
        this._terminateWithError(error, { holdTrack });
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
        const repairIntent = this._intentGeneration;
        const ownsRepair = () =>
          this.playbackGeneration === repairGeneration &&
          this.current.requestId === repairRequest &&
          this._authEpoch === repairAuth &&
          this._intentGeneration === repairIntent;
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

    const offlineSession = getOfflineSession();
    // 1. Нормализация URL
    const normalizedStreamUrl = normalizeStreamUrl(track, currentServerUrl);

    // 2. Проверка локального кеша
    let localUri = null;
    if (this.bypassCache || options.bypassLocal || options.offlineOnly) {
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
      !this.current.error &&
      (!offlineSession || this._offlineLease) &&
      !serverChanged &&
      sameHeaders &&
      ((!options.force &&
        this.currentTrackId === trackIdStr &&
        this.currentPlayUri === expectedUri) ||
        (isRerenderOfCurrent && expectedIsLocal === this.currentIsLocal))
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
    this._mediaController?.abort();
    this._mediaController = new AbortController();
    this.playbackGeneration += 1;
    const currentGeneration = this.playbackGeneration;
    const requestServerEpoch = this.serverEpoch;
    const apiGeneration = getAuthSessionGeneration();
    const isCurrent = () =>
      this.playbackGeneration === currentGeneration &&
      this.serverEpoch === requestServerEpoch &&
      getAuthSessionGeneration() === apiGeneration && this._resolveServerUrl() === currentServerUrl;

    let sourceAttemptId = `att_${++this._attemptIdCounter}_${Date.now()}`;

    if (this._backgroundCacheTimer) {
      clearTimeout(this._backgroundCacheTimer);
      this._backgroundCacheTimer = null;
    }

    this.currentTrack = track;
    this.currentTrackId = trackIdStr;
    this.cache?.setActiveTrackId?.(trackIdStr);
    this._terminalUnloaded = false;
    this._terminalUnloadFailed = false;

    this._activeRetryPromise = null;

    // Reset progress tracking for the new source
    this._lastConfirmedPosition = null;
    this._confirmedPlaybackStarted = false;
    this._finishHandled = false;
    this._acceptedIntentRevision = -1;
    this._lastSeekTarget = null;
    this._seekPending = false;
    this._progressEvents = [];
    this._hasStableProof = false;
    this._clearStallWatchdog();
    this._cancelRetry('new_selection');

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
    };

    this._explicitInstallAttempt = sourceAttemptId;
    this._recordDiagnostic('play');

    if (
      this.scheduler &&
      typeof this.scheduler.setPlaybackPressure === 'function'
    ) {
      this.scheduler.setPlaybackPressure({ requestId, phase: 'startup' });
    }

    // Немедленное синхронное обновление метаданных и обложки на экране блокировки/шторке,
    // не дожидаясь окончания сетевой буферизации аудио и вызова player.play().
    this.applyLockScreenMetadata(player, track, isCurrent);
    this.applyVolumeNormalization(player, track, options);

    let isLocal = false;
    let playUri = null;

    let offlineLease = null;
    if (offlineSession && !options.bypassLocal) {
      offlineLease = await acquirePlayable(offlineSession, trackIdStr, track.content_version)
        .catch(() => null);
      if (!isCurrent() || !isOfflineSessionCurrent(offlineSession)) {
        offlineLease?.release();
        return { superseded: true, uri: null, isLocal: false };
      }
      if (offlineLease) {
        localUri = offlineLease.uri;
        this.current.source = 'local';
      }
    }
    if (!offlineLease && !this.bypassCache && !options.bypassLocal && !options.offlineOnly && this.cache.prepareTrack) {
      await this.cache.prepareTrack(track, { signal: this._mediaController.signal });
      if (!isCurrent()) return { superseded: true, uri: null, isLocal: false };
      localUri = this.cache.getCachedUri(trackIdStr);
    }

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
        if (replaceRes.superseded) {
          offlineLease?.release();
          return {
            isLocal: false,
            uri: null,
            requestId,
            sourceAttemptId,
            confirmation: this.identityAvailable ? 'pending' : 'unavailable',
            superseded: true,
          };
        }
        this._offlineLease?.release();
        this._offlineLease = offlineLease ? { ...offlineLease, session: offlineSession } : null;
      } catch (localErr) {
        if (offlineLease) {
          offlineLease.release();
          markMissing(offlineSession, offlineLease.mediaKey, 'replace_failed').catch(() => {});
          offlineLease = null;
        }
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
      if (options.offlineOnly) {
        const error = new PlaybackError('Local audio unavailable', { type: 'local_cache_error', trackId: trackIdStr });
        this._terminateWithError(error);
        throw error;
      }
      if (
        !normalizedStreamUrl ||
        (!normalizedStreamUrl.startsWith('http://') &&
          !normalizedStreamUrl.startsWith('https://'))
      ) {
        const urlErr = new PlaybackError(
          'Invalid stream URL',
          {
            type: 'remote_replace_error',
            trackId: trackIdStr,
          },
        );
        this._error('[Coordinator][Stage 1: normalize_url FAILED]', urlErr);
        throw urlErr;
      }

      isLocal = false;
      playUri = normalizedStreamUrl;
      this._log('[Coordinator][Stage 3: remote_replace]', {
        trackId: trackIdStr,
        normalizedStreamUrl,
      });

      let descriptor;
      try { descriptor = await this._resolveRemote(track); }
      catch (e) { if (!isCurrent()) return { superseded: true, uri: null, isLocal: false }; this._terminateWithError(e); throw e; }
      if (!isCurrent()) return { superseded: true, uri: null, isLocal: false };
      playUri = descriptor.uri;
      cleanHeaders = { ...descriptor.headers };
      hasHeaders = Object.keys(cleanHeaders).length > 0;
      const source = { uri: playUri, headers: cleanHeaders };

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
        const error = classifyPlaybackError(remoteErr, trackIdStr);
        this._terminateWithError(error);
        throw error;
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
                .getOrFetch(trackIdStr, this._mediaDescriptor, {
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

    if (this.current.error) {
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
    if (!isLocal) {
      this._offlineLease?.release();
      this._offlineLease = null;
    }
    this.currentPlayUri = playUri;
    this.currentIsLocal = isLocal;
    this._currentSourceHeaders = hasHeaders ? cleanHeaders : null;

    // СТАДИЯ 5: Обновление метаданных Lock Screen
    this._log('[Coordinator][Stage 5: lock_screen]', {
      trackId: trackIdStr,
      title: track?.title,
    });

    try {
      if (!offlineLease) await this.updateLockScreenMetadata(player, track, isCurrent);
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
    if (!currentTrack) this.cache?.setActiveTrackId?.(null);
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
   * Защищённая обложка будет добавлена после получения короткого билета.
   */
  applyLockScreenMetadata(player, track, isCurrent = null) {
    if (!player || typeof player.setActiveForLockScreen !== 'function') return;
    if (isCurrent && !isCurrent()) return;

    try {
      const artworkUrl = track?.coverArt && !isServerCoverUri(track.coverArt)
        ? resolveCoverUri(track.coverArt) : undefined;
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
      const generation = getAuthSessionGeneration();
      const artworkUrl = await resolveLockScreenCover(track?.coverArt).catch(() => undefined);
      if (generation !== getAuthSessionGeneration()) return;
      if (isCurrent && !isCurrent()) return;

      if (this.currentTrack && !areTrackIdsEqual(track, this.currentTrack)) {
        // Трек уже сменился — не перезаписываем экран блокировки устаревшими данными
        return;
      }

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

    const offlineSession = getOfflineSession();
    const ticket = this._mediaDescriptor;
    const mediaKey = this.current.source === 'local'
      ? this._offlineLease?.mediaKey
      : offlineSession && ticket?.contentVersion && ticket.trackId === this.current.trackId
        ? { owner: offlineSession.owner, trackId: ticket.trackId, contentVersion: ticket.contentVersion }
        : undefined;
    return {
      identityAvailable: this.identityAvailable,
      current: { ...this.current, mediaKey },
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
if (typeof addSessionListener === 'function') addSessionListener(reason => defaultPlaybackCoordinator.cancelCurrent(reason === 'server' ? 'server' : 'logout'));
export default defaultPlaybackCoordinator;
