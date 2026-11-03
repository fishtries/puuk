/**
 * Preload scheduler for audio tracks.
 * Manages priority queue (current 0.5, urgent 0, next 1, next-next 2),
 * strictly enforces concurrency limits without separate bypasses,
 * coordinates with AudioCache as the single point of download execution,
 * promotes existing tasks to higher priority, avoids duplicate downloads,
 * reports statuses to UI (idle, queued, downloading, ready, failed, cancelled),
 * defers cancellation of out-of-window tasks by a grace period,
 * narrows limits by network policy (Wi-Fi / cellular / unknown / offline),
 * and yields background bandwidth to playback pressure (startup/stall/recovery).
 */

import defaultAudioCache from './audioCache';
import {
  getCurrentNetworkPolicy,
  subscribeNetworkPolicy,
  isPolicyOnline,
  SAFE_NETWORK_POLICY,
} from './networkPolicy';
import { SERVER_URL } from '../shared/api/api';
import { normalizeStreamUrl } from './streamUrl';
import { getTrackId } from '../shared/domain/trackAdapter';

export const TRACK_STATUS = {
  IDLE: 'idle',
  QUEUED: 'queued',
  DOWNLOADING: 'downloading',
  READY: 'ready',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export const GRACE_PERIOD_MS = 3000;
export const STALE_SYNC_LIMIT = 2;
export const MAX_ACTIVE_TASKS = 2;
export const MAX_GRACE_CANCEL_ACTIVE = 2;
export const MAX_DESIRED_JOBS = 3;
export const PRIORITY_CURRENT = 0.5;
export const PRIORITY_URGENT = 0;
export const CURRENT_CACHE_STABLE_DELAY_MS = 5000;
export const STABLE_RESUME_RAMP_MS = 1000;

export const PLAYBACK_PHASE = {
  STARTUP: 'startup',
  STALLED: 'stalled',
  RECOVERING: 'recovering',
  SUSPENDED: 'suspended',
  STABLE: 'stable',
  IDLE: 'idle',
};

const PRESSURE_PHASES = new Set([
  PLAYBACK_PHASE.STARTUP,
  PLAYBACK_PHASE.STALLED,
  PLAYBACK_PHASE.RECOVERING,
  PLAYBACK_PHASE.SUSPENDED,
]);

function abortError() {
  const error = new Error('Download cancelled');
  error.name = 'AbortError';
  return error;
}

export class PreloadScheduler {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxConcurrent=2] - Максимум параллельных загрузок
   * @param {number} [options.lookahead=2] - Сколько будущих треков предзагружать
   * @param {Object} [options.cache] - Экземпляр AudioCache
   * @param {Function} [options.getStreamUrl] - Функция получения URL потока из трека
   * @param {Function} [options.getNetworkPolicy] - Функция получения текущей политики сети
   * @param {Function} [options.subscribeNetworkPolicy] - Функция подписки на изменения сети
   * @param {number} [options.currentCacheDelayMs=5000] - Задержка cacheCurrent после stable
   * @param {number} [options.stableRampMs=1000] - Задержка второго слота после stable
   */
  constructor(options = {}) {
    this._explicitServerUrl = options.serverUrl || null;
    this._getServerUrl =
      typeof options.getServerUrl === 'function'
        ? options.getServerUrl
        : () => this._explicitServerUrl || SERVER_URL;
    this._lastServerUrl = this._resolveServerUrl();
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.lookahead = options.lookahead ?? 2;
    this.cache = options.cache || defaultAudioCache;
    this.getStreamUrl =
      options.getStreamUrl || ((t) => normalizeStreamUrl(t, this.serverUrl));
    this.gracePeriodMs = options.gracePeriodMs ?? GRACE_PERIOD_MS;
    this.staleSyncLimit = options.staleSyncLimit ?? STALE_SYNC_LIMIT;
    this.currentCacheDelayMs =
      options.currentCacheDelayMs ?? CURRENT_CACHE_STABLE_DELAY_MS;
    this.stableRampMs = options.stableRampMs ?? STABLE_RESUME_RAMP_MS;
    this.getNetworkPolicy = options.getNetworkPolicy || getCurrentNetworkPolicy;
    this.subscribeNetworkPolicy =
      options.subscribeNetworkPolicy || subscribeNetworkPolicy;

    this.queue = []; // [{ trackId, track, priority, options, epoch, promise, resolve, reject, purpose }]
    this.activeTasks = new Map(); // trackId => item
    this.statuses = new Map(); // trackId => TRACK_STATUS
    this.errors = new Map(); // trackId => error
    this.listeners = new Set();
    this.currentTrackId = null;
    this.epoch = 0;
    this.graceTimers = new Map(); // trackId => timeout id (отложенная отмена)
    this.pendingCancelCount = new Map(); // trackId => сколько sync подряд задача не нужна
    this.isInitialized = true;

    this.lastCurrentTrack = undefined;
    this.lastUpNextQueue = [];
    this.lastOptions = {};

    // Playback pressure (edge-triggered) and stable-resume ramp.
    this.playbackPressure = null; // { requestId, phase } | null
    this.resumeTimers = []; // timeout ids for the stable resume ramp
    this.rampStartedCount = 0; // starts allowed during the 1s ramp
    this.offline = false;
    this._itemSeq = 0; // Monotonic sequence counter for queue desirability ordering

    // Current-track caching (cacheCurrent). It is a normal bounded job with
    // PRIORITY_CURRENT in this.queue/activeTasks — no separate bypass lane.
    this.currentCacheTimer = null;
    this.currentCacheTrackId = null;

    // Cancelled-but-unsettled FileSystem work keeps its slot until the
    // underlying cache promise settles (contract 4.4). Bounded by active cap.
    this.settlingTasks = new Map(); // trackId => { promise, settle }

    this._unsubscribeNetwork = null;
    if (typeof this.subscribeNetworkPolicy === 'function') {
      try {
        this._unsubscribeNetwork = this.subscribeNetworkPolicy((policy) => {
          this._onNetworkPolicyChanged(policy);
        });
      } catch (err) {
        console.warn(
          '[PreloadScheduler] Failed to subscribe to network policy:',
          err,
        );
      }
    }
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

  _checkServerChange() {
    const current = this._resolveServerUrl();
    if (this._lastServerUrl && current !== this._lastServerUrl) {
      this._lastServerUrl = current;
      this._handleServerChange(current);
      return true;
    }
    this._lastServerUrl = current;
    return false;
  }

  _handleServerChange(_newServerUrl) {
    this.epoch += 1;
    this._cancelAllBackgroundWork('server_change');
  }

  /**
   * Действующие лимиты: сконфигурированные, суженные политикой сети.
   * Если тип сети неизвестен/null — применяется безопасная политика (maxConcurrent: 1, lookahead: 1).
   * @private
   */
  _effectiveLimits() {
    let maxConcurrent = this.maxConcurrent;
    let lookahead = this.lookahead;
    try {
      const rawPolicy =
        typeof this.getNetworkPolicy === 'function'
          ? this.getNetworkPolicy()
          : null;
      const policy = rawPolicy || SAFE_NETWORK_POLICY;
      if (policy) {
        maxConcurrent = Math.min(maxConcurrent, policy.maxConcurrent);
        lookahead = Math.min(lookahead, policy.lookahead);
      }
    } catch {
      maxConcurrent = Math.min(
        maxConcurrent,
        SAFE_NETWORK_POLICY.maxConcurrent,
      );
      lookahead = Math.min(lookahead, SAFE_NETWORK_POLICY.lookahead);
    }
    return { maxConcurrent, lookahead };
  }

  /**
   * @private
   * @returns {boolean} true если сеть разрешает старт фоновых загрузок
   */
  _isOnline() {
    try {
      const policy =
        typeof this.getNetworkPolicy === 'function'
          ? this.getNetworkPolicy()
          : null;
      return isPolicyOnline(policy);
    } catch {
      return true;
    }
  }

  /**
   * @private
   * @returns {'startup'|'stalled'|'recovering'|'suspended'|null}
   */
  _currentPressurePhase() {
    if (!this.playbackPressure) return null;
    return PRESSURE_PHASES.has(this.playbackPressure.phase)
      ? this.playbackPressure.phase
      : null;
  }

  _isPressureActive() {
    return this._currentPressurePhase() !== null;
  }

  /**
   * Устанавливает текущий играющий трек и защищает его от отмены.
   * @param {Object|null} track
   */
  setCurrentTrack(track) {
    const rawId = getTrackId(track);
    const idStr = rawId !== null ? String(rawId) : null;
    this.currentTrackId = idStr;
    if (idStr !== null) {
      this._clearGraceTimer(idStr);
      this.pendingCancelCount.delete(idStr);
    }
  }

  /**
   * Сообщает планировщику о давлении воспроизведения (startup/stall/recovery).
   *
   * Edge-triggered и идемпотентно по паре requestId+phase: повторные тики с той же
   * парой ничего не отменяют и не перезапускают. Новый pressure-edge один раз
   * отменяет каждую активную фоновую (FileSystem) загрузку, включая cacheCurrent,
   * и оставляет только желаемые метаданные очереди для последующего rescheduling.
   * Phase 'stable' возобновляет работу с ramp: один слот сразу, второй после
   * stableRampMs; новый pressure-edge отменяет ramp. 'idle' — ничего не запускает.
   * Native current playback никогда не является задачей планировщика и не отменяется.
   *
   * @param {{requestId?: string|number|null, phase: 'startup'|'stalled'|'recovering'|'suspended'|'stable'|'idle'}} pressure
   */
  setPlaybackPressure(pressure) {
    const phase = pressure?.phase;
    const requestId =
      pressure?.requestId === undefined || pressure?.requestId === null
        ? null
        : String(pressure.requestId);
    const next = phase ? { requestId, phase } : null;

    const same =
      (this.playbackPressure === null && next === null) ||
      (this.playbackPressure !== null &&
        next !== null &&
        this.playbackPressure.phase === next.phase &&
        this.playbackPressure.requestId === next.requestId);

    if (same) return;

    this.playbackPressure = next;

    if (PRESSURE_PHASES.has(phase)) {
      this._clearResumeRamp();
      this._clearCurrentCacheTimer();
      this._cancelAllBackgroundWork('pressure');
      return;
    }

    if (phase === PLAYBACK_PHASE.STABLE) {
      this._clearResumeRamp();
      this._clearCurrentCacheTimer();

      // If a current cache job exists or is queued, enforce eligibility delay after entering stable
      const hasCurrentJob =
        this.currentCacheTrackId !== null ||
        this.queue.some((item) => item.purpose === 'current');
      if (hasCurrentJob && this.currentCacheDelayMs > 0) {
        this.currentCacheTimer = setTimeout(() => {
          this.currentCacheTimer = null;
          this._pump();
        }, this.currentCacheDelayMs);
      }

      this._scheduleStableResume();
      if (this.lastCurrentTrack !== undefined) {
        const { force: _force, ...syncOpts } = this.lastOptions || {};
        this.syncQueue(this.lastCurrentTrack, this.lastUpNextQueue, syncOpts);
      }
      return;
    }

    // idle (или неизвестная фаза): ramp/current-cache таймеры не должны висеть.
    this._clearResumeRamp();
    this._clearCurrentCacheTimer();
  }

  /**
   * @returns {{requestId: string|null, phase: string}|null}
   */
  getPlaybackPressure() {
    return this.playbackPressure;
  }

  _clearResumeRamp() {
    for (const timer of this.resumeTimers) clearTimeout(timer);
    this.resumeTimers = [];
    this.rampStartedCount = 0;
  }

  /**
   * Возобновление после stable: ровно один старт до истечения 1000мс
   * (даже если первая задача завершилась раньше). Второй слот только после 1000мс.
   * @private
   */
  _scheduleStableResume() {
    const { maxConcurrent } = this._effectiveLimits();
    if (maxConcurrent < 2) {
      // Один слот: ramp не нужен, стартуем сразу.
      this._pump();
      return;
    }
    this.rampStartedCount = 0;
    const timer = setTimeout(() => {
      this.resumeTimers = this.resumeTimers.filter((t) => t !== timer);
      this.rampStartedCount = 0;
      if (
        this.playbackPressure?.phase === PLAYBACK_PHASE.STABLE &&
        this._isOnline()
      ) {
        this._pump();
      }
    }, this.stableRampMs);
    this.resumeTimers.push(timer);
    this._pump();
  }

  _clearCurrentCacheTimer() {
    if (this.currentCacheTimer) clearTimeout(this.currentCacheTimer);
    this.currentCacheTimer = null;
  }

  /**
   * Немедленная отмена всей фоновой (FileSystem) работы по reason.
   * Слот отменённой задачи не освобождается, пока не settle-ится underlying
   * cache promise (bounded cancelling accounting). Native current stream не трогаем.
   * @private
   */
  _cancelAllBackgroundWork(_reason) {
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    this.pendingCancelCount.clear();

    const active = Array.from(this.activeTasks.entries());
    for (const [trackId, task] of active) {
      this._cancelTaskNow(trackId, task, { keepSlot: true });
    }
    this.activeTasks.clear();

    for (const item of Array.from(this.queue)) {
      this.cache.cancel(item.trackId);
      if (item) item.attemptToken = (item.attemptToken || 0) + 1;
      if (item.reject) item.reject(abortError());
      this._setStatus(item.trackId, TRACK_STATUS.CANCELLED, {
        purpose: item.purpose,
      });
    }
    this.queue = [];

    this.currentCacheTrackId = null;
    this._clearCurrentCacheTimer();
  }

  /**
   * Реакция на изменение политики сети: пересинхронизирует очередь с новыми лимитами.
   * Offline останавливает старт новых задач; reconnect делает ровно один pump,
   * подчинённый pressure/ramp.
   * @private
   */
  _onNetworkPolicyChanged(_policy) {
    const online =
      _policy && typeof _policy.isConnected === 'boolean'
        ? isPolicyOnline(_policy)
        : this._isOnline();
    const wasOffline = this.offline;
    this.offline = !online;

    if (this.lastCurrentTrack !== undefined) {
      const { force: _force, ...networkOptions } = this.lastOptions || {};
      this.syncQueue(
        this.lastCurrentTrack,
        this.lastUpNextQueue,
        networkOptions,
      );
    }
    if (online && wasOffline) {
      // Однократное возобновление; далее обычный pump уважает pressure.
      this._pump();
    }
  }

  destroy() {
    if (this._unsubscribeNetwork) {
      this._unsubscribeNetwork();
      this._unsubscribeNetwork = null;
    }
    this._clearResumeRamp();
    this.cancelAll();
    this.listeners.clear();
  }

  init() {
    this.cancelAll();
    this.queue = [];
    this.activeTasks.clear();
    this.statuses.clear();
    this.errors.clear();
    this.currentTrackId = null;
    this.epoch += 1;
    this.isInitialized = true;
    return this;
  }

  /**
   * Синхронизирует планировщик с текущей воспроизводимой очередью.
   * Ставит в очередь актуальные треки с соответствующим приоритетом.
   * Задачи, выпавшие из окна lookahead, не отменяются мгновенно: им даётся
   * grace period, за который они успевают завершиться (защита от «дрожи» очереди).
   * Мгновенная отмена применяется только по force (смена режима воспроизведения)
   * или когда задача остаётся ненужной несколько синков подряд.
   *
   * @param {Object|null} currentTrack - Текущий играющий трек
   * @param {Array<Object>} upNextQueue - Будущая очередь воспроизведения
   * @param {Object} [options] - Опции (заголовки auth и т.д.)
   * @param {boolean} [options.force] - Принудительная мгновенная отмена устаревших задач
   */
  syncQueue(currentTrack, upNextQueue = [], options = {}) {
    this._checkServerChange();
    this.lastCurrentTrack = currentTrack;
    this.lastUpNextQueue = upNextQueue;
    this.lastOptions = options;

    this.epoch += 1;
    const currentEpoch = this.epoch;
    const { force = false, ...fetchOptions } = options;
    const currentRawId = getTrackId(currentTrack);
    this.currentTrackId = currentRawId !== null ? String(currentRawId) : null;
    const { lookahead } = this._effectiveLimits();

    // Окно кандидатов: upNextQueue[0] (next, priority 1), upNextQueue[1] (next-next, priority 2)
    // Ограничение Section 4.4: desired current + lookahead не более 3 задач.
    const candidates = [];
    const neededTrackIds = new Set();
    const maxCandidates =
      this.currentCacheTrackId !== null
        ? Math.max(1, MAX_DESIRED_JOBS - 1)
        : MAX_DESIRED_JOBS;
    const effectiveLookahead = Math.min(lookahead, maxCandidates);

    if (upNextQueue && Array.isArray(upNextQueue)) {
      const window = upNextQueue.slice(0, effectiveLookahead);
      for (let i = 0; i < window.length; i++) {
        const track = window[i];
        const rawId = getTrackId(track);
        if (rawId === null) continue;
        const trackIdStr = String(rawId);
        neededTrackIds.add(trackIdStr);
        candidates.push({
          trackId: trackIdStr,
          track,
          priority: i + 1, // priority 1, 2...
          options: fetchOptions,
          epoch: currentEpoch,
          purpose: i === 0 ? 'next' : 'lookahead',
        });
      }
    }

    if (this.currentCacheTrackId !== null) {
      neededTrackIds.add(this.currentCacheTrackId);
    }

    // 1. Активные загрузки: отложенная отмена через grace period
    // Важно: текущий трек (currentTrackId) и срочные задачи (priority 0) НЕ отменяем никогда.
    for (const [trackId, task] of Array.from(this.activeTasks.entries())) {
      if (
        trackId === this.currentTrackId ||
        task?.priority === 0 ||
        task?.purpose === 'current'
      ) {
        this._clearGraceTimer(trackId);
        this.pendingCancelCount.delete(trackId);
        continue;
      }
      if (!neededTrackIds.has(trackId)) {
        if (force) {
          this._cancelTaskNow(trackId, task);
          continue;
        }
        const staleCount = (this.pendingCancelCount.get(trackId) || 0) + 1;
        this.pendingCancelCount.set(trackId, staleCount);
        // Мгновенно отменяем только после нескольких «ненужных» синков подряд
        if (staleCount >= this.staleSyncLimit) {
          this._cancelTaskNow(trackId, task);
        } else {
          this._scheduleGraceCancel(trackId, task);
        }
      } else {
        this._clearGraceTimer(trackId);
        this.pendingCancelCount.delete(trackId);
      }
    }

    // 2. Очередь ожидания: та же политика отложенной отмены с таймером
    const remainingQueue = [];
    for (const item of Array.from(this.queue)) {
      if (
        neededTrackIds.has(item.trackId) ||
        item.trackId === this.currentTrackId ||
        item.priority === 0 ||
        item.purpose === 'current'
      ) {
        this._clearGraceTimer(item.trackId);
        this.pendingCancelCount.delete(item.trackId);
        remainingQueue.push(item);
      } else if (force) {
        this._cancelQueuedItemNow(item);
      } else {
        const staleCount = (this.pendingCancelCount.get(item.trackId) || 0) + 1;
        this.pendingCancelCount.set(item.trackId, staleCount);
        if (staleCount >= this.staleSyncLimit) {
          this._cancelQueuedItemNow(item);
        } else {
          this._scheduleGraceCancel(item.trackId, item);
          remainingQueue.push(item); // остаётся в очереди до конца grace period
        }
      }
    }
    this.queue = remainingQueue;

    // 3. Обрабатываем кандидатов
    for (const cand of candidates) {
      this._clearGraceTimer(cand.trackId);
      this.pendingCancelCount.delete(cand.trackId);
      const downloadState =
        typeof this.cache.getDownloadState === 'function'
          ? this.cache.getDownloadState(cand.trackId)
          : this.cache.isCached(cand.trackId)
            ? { status: 'cached' }
            : { status: 'idle' };

      if (downloadState.status === 'cached') {
        this._setStatus(cand.trackId, TRACK_STATUS.READY, {
          uri: downloadState.uri,
          purpose: cand.purpose,
        });
        continue;
      }

      // Если задача уже активна в планировщике:
      if (this.activeTasks.has(cand.trackId)) {
        const activeItem = this.activeTasks.get(cand.trackId);
        activeItem.epoch = currentEpoch;
        activeItem.priority = cand.priority;
        this._setStatus(cand.trackId, TRACK_STATUS.DOWNLOADING, {
          purpose: cand.purpose,
        });
        continue;
      }

      // Если загрузка уже идёт напрямую через cache (например, из PlaybackCoordinator.play):
      if (downloadState.status === 'downloading') {
        this._setStatus(cand.trackId, TRACK_STATUS.DOWNLOADING, {
          purpose: cand.purpose,
        });
        if (downloadState.promise) {
          downloadState.promise
            .then((uri) => {
              if (this.getStatus(cand.trackId) === TRACK_STATUS.DOWNLOADING) {
                this._setStatus(cand.trackId, TRACK_STATUS.READY, {
                  uri,
                  purpose: cand.purpose,
                });
              }
            })
            .catch((err) => {
              if (this.getStatus(cand.trackId) === TRACK_STATUS.DOWNLOADING) {
                this._setStatus(cand.trackId, TRACK_STATUS.FAILED, {
                  error: err,
                  purpose: cand.purpose,
                });
              }
            });
        }
        continue;
      }

      const existingInQueue = this.queue.find(
        (q) => q.trackId === cand.trackId,
      );
      if (existingInQueue) {
        // Обновляем приоритет и эпоху
        existingInQueue.priority = cand.priority;
        existingInQueue.epoch = currentEpoch;
      } else {
        const currentStatus = this.getStatus(cand.trackId);
        if (
          currentStatus !== TRACK_STATUS.DOWNLOADING &&
          currentStatus !== TRACK_STATUS.READY
        ) {
          let resolveFn, rejectFn;
          const promise = new Promise((res, rej) => {
            resolveFn = res;
            rejectFn = rej;
          });
          promise.catch(() => {});

          cand.promise = promise;
          cand.resolve = resolveFn;
          cand.reject = rejectFn;
          cand.seq = ++this._itemSeq;

          this.queue.push(cand);
          this._setStatus(cand.trackId, TRACK_STATUS.QUEUED, {
            purpose: cand.purpose,
          });
        }
      }
    }

    // 4. Сортируем очередь по приоритету (меньший номер priority = выше приоритет)
    this.queue.sort(this._comparePriority);
    this._trimDesiredQueue();

    // 5. Запускаем обработку очереди
    this._pump();
  }

  /**
   * Кеширует текущий трек в общем ограниченном бюджете планировщика.
   *
   * - priority 0.5 (urgent 0, next 1, next-next 2), dedup по треку;
   * - eligibility 5 с после stable — таймер держит планировщик, J07 не дублирует;
   * - повторные вызовы для того же трека разделяют один promise;
   * - кеш-hit резолвится сразу без сети;
   * - pressure при отмене отклоняет promise с AbortError;
   * - текущая задача — обычный элемент общей очереди/активного лимита;
   * - провал текущего кеша — фоновый исход, не ошибка native current stream.
   *
   * @param {Object} track
   * @param {Object} [options] - заголовки/сигнал/параметры загрузки
   * @returns {Promise<string|null>}
   */
  cacheCurrent(track, options = {}) {
    this._checkServerChange();
    const rawId = getTrackId(track);
    if (rawId === null)
      return Promise.reject(new Error('Track must have an id'));
    const trackIdStr = String(rawId);

    const cachedUri = this.cache.getCachedUri(trackIdStr);
    if (cachedUri) {
      this._setStatus(trackIdStr, TRACK_STATUS.READY, {
        uri: cachedUri,
        purpose: 'current',
      });
      return Promise.resolve(cachedUri);
    }

    // Dedup: тот же текущий трек уже стоит в очереди или качается.
    const existingJob = this._findCurrentJob(trackIdStr);
    if (existingJob) return existingJob.promise;

    // Другой текущий трек вытесняется новым: его слот удержится до settle.
    if (this.currentCacheTrackId !== null) {
      const previous = this._findJob(this.currentCacheTrackId);
      if (previous) this._cancelTaskNow(previous.trackId, previous);
    }

    // Если загрузка того же трека уже идёт через cache напрямую — присоединяемся.
    const ongoing =
      typeof this.cache.getOngoingPromise === 'function'
        ? this.cache.getOngoingPromise(trackIdStr)
        : null;
    if (ongoing) {
      const promise = ongoing.then(
        (uri) => {
          this._setStatus(trackIdStr, TRACK_STATUS.READY, {
            uri,
            purpose: 'current',
          });
          return uri;
        },
        (err) => {
          if (err?.name === 'AbortError') {
            this._setStatus(trackIdStr, TRACK_STATUS.CANCELLED, {
              purpose: 'current',
            });
          } else {
            this._setStatus(trackIdStr, TRACK_STATUS.FAILED, {
              error: err,
              purpose: 'current',
            });
          }
          throw err;
        },
      );
      promise.catch(() => {});
      return promise;
    }

    let resolveFn, rejectFn;
    const promise = new Promise((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    promise.catch(() => {});

    const job = {
      trackId: trackIdStr,
      track,
      priority: PRIORITY_CURRENT,
      purpose: 'current',
      options,
      epoch: this.epoch,
      seq: ++this._itemSeq,
      promise,
      resolve: resolveFn,
      reject: rejectFn,
      attemptToken: 0,
    };
    this.currentCacheTrackId = trackIdStr;
    this.queue.push(job);
    this.queue.sort(this._comparePriority);
    this._setStatus(trackIdStr, TRACK_STATUS.QUEUED, { purpose: 'current' });
    this._trimDesiredQueue();

    // Планировщик владеет задержкой eligibility: 5 с после stable.
    this._clearCurrentCacheTimer();
    const stableNow =
      this.playbackPressure?.phase === PLAYBACK_PHASE.STABLE ||
      this.playbackPressure === null;
    if (stableNow && this.currentCacheDelayMs > 0) {
      this.currentCacheTimer = setTimeout(() => {
        this.currentCacheTimer = null;
        if (this.currentCacheTrackId === trackIdStr) this._pump();
      }, this.currentCacheDelayMs);
      return promise;
    }

    this._pump();
    return promise;
  }

  _findJob(trackId) {
    const id = String(trackId);
    return (
      this.activeTasks.get(id) ||
      this.queue.find((item) => item.trackId === id) ||
      null
    );
  }

  _findCurrentJob(trackId) {
    const id = String(trackId);
    if (this.currentCacheTrackId !== id) return null;
    return this._findJob(id);
  }

  /**
   * Срочная загрузка (приоритет 0).
   * Добавляется в общий планировщик, не обходит лимиты concurrency.
   * Если загрузка уже идёт — возвращает существующий promise.
   * Если задача уже была в очереди — повышает её приоритет до 0.
   * Pressure никогда не обходится: новая фоновая работа при активном
   * playback pressure не стартует.
   *
   * @param {Object} track
   * @param {Object} [options]
   * @param {string|number} [options.currentTrackId]
   * @returns {Promise<string>}
   */
  async preloadImmediate(track, options = {}) {
    this._checkServerChange();
    const rawId = getTrackId(track);
    if (rawId === null) throw new Error('Track must have an id');
    const trackIdStr = String(rawId);
    const rawCurrentId = getTrackId(options.currentTrackId);
    const activeCurrentId =
      rawCurrentId !== null ? String(rawCurrentId) : this.currentTrackId;

    if (activeCurrentId !== null && activeCurrentId !== undefined) {
      this.currentTrackId = activeCurrentId;
      this._clearGraceTimer(activeCurrentId);
      this.pendingCancelCount.delete(activeCurrentId);
    }

    // Срочная загрузка освобождает полосу от задач, уже выпавших из окна.
    // Защита: текущий трек (activeCurrentId / this.currentTrackId) и сам целевой трек НЕ отменяются.
    for (const [staleTrackId] of Array.from(this.graceTimers.entries())) {
      const staleTask =
        this.activeTasks.get(staleTrackId) ||
        this.queue.find((item) => item.trackId === staleTrackId);
      if (
        !staleTask ||
        staleTrackId === trackIdStr ||
        staleTrackId === activeCurrentId ||
        staleTrackId === this.currentTrackId
      ) {
        continue;
      }
      if (this.activeTasks.get(staleTrackId) === staleTask) {
        this._cancelTaskNow(staleTrackId, staleTask);
      } else {
        this._cancelQueuedItemNow(staleTask);
      }
    }

    // 1. Если трек уже закеширован — сразу возвращаем URI
    if (this.cache.isCached(trackIdStr)) {
      const uri = this.cache.getCachedUri(trackIdStr);
      this._setStatus(trackIdStr, TRACK_STATUS.READY, {
        uri,
        purpose: 'urgent',
      });
      return uri;
    }

    // 2. Если трек уже активно скачивается в планировщике:
    const activeItem = this.activeTasks.get(trackIdStr);
    if (activeItem) {
      activeItem.priority = 0;
      activeItem.purpose = 'urgent';
      this._setStatus(trackIdStr, TRACK_STATUS.DOWNLOADING, {
        purpose: 'urgent',
      });
      return activeItem.promise;
    }

    // 3. Если трек уже скачивается в AudioCache напрямую:
    const downloadState =
      typeof this.cache.getDownloadState === 'function'
        ? this.cache.getDownloadState(trackIdStr)
        : null;

    if (
      downloadState &&
      downloadState.status === 'downloading' &&
      downloadState.promise
    ) {
      this._setStatus(trackIdStr, TRACK_STATUS.DOWNLOADING, {
        purpose: 'urgent',
      });
      // Если стоял в очереди ожидания, удаляем, так как он уже скачивается
      this.queue = this.queue.filter((q) => q.trackId !== trackIdStr);
      try {
        const uri = await downloadState.promise;
        this._setStatus(trackIdStr, TRACK_STATUS.READY, {
          uri,
          purpose: 'urgent',
        });
        return uri;
      } catch (err) {
        this._setStatus(trackIdStr, TRACK_STATUS.FAILED, {
          error: err,
          purpose: 'urgent',
        });
        throw err;
      }
    }

    // 4. Если трек уже есть в очереди ожидания: повышаем приоритет до 0
    const existingInQueue = this.queue.find((q) => q.trackId === trackIdStr);
    if (existingInQueue) {
      existingInQueue.priority = 0;
      existingInQueue.purpose = 'urgent';
      existingInQueue.seq = ++this._itemSeq;
      if (existingInQueue.trackId === this.currentCacheTrackId) {
        this.currentCacheTrackId = null;
        this._clearCurrentCacheTimer();
      }
      if (options) {
        existingInQueue.options = { ...existingInQueue.options, ...options };
      }
      this.queue.sort(this._comparePriority);
      this._trimDesiredQueue();
      this._pump();
      return existingInQueue.promise;
    }

    // 5. Создаём новую срочную задачу с priority = 0 в общем планировщике
    let resolveFn, rejectFn;
    const promise = new Promise((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    promise.catch(() => {});

    const item = {
      trackId: trackIdStr,
      track,
      priority: 0,
      purpose: 'urgent',
      options,
      epoch: this.epoch,
      seq: ++this._itemSeq,
      promise,
      resolve: resolveFn,
      reject: rejectFn,
    };

    this.queue.unshift(item);
    this.queue.sort(this._comparePriority);
    this._setStatus(trackIdStr, TRACK_STATUS.QUEUED, { purpose: 'urgent' });
    this._trimDesiredQueue();
    this._pump();
    return promise;
  }

  /**
   * Получает текущий статус трека для UI.
   * @param {string|number} trackId
   * @returns {string} TRACK_STATUS
   */
  getStatus(trackId) {
    const rawId = getTrackId(trackId);
    if (rawId === null) return TRACK_STATUS.IDLE;
    const trackIdStr = String(rawId);

    if (this.cache.isCached(trackIdStr)) {
      return TRACK_STATUS.READY;
    }

    if (this.statuses.has(trackIdStr)) {
      return this.statuses.get(trackIdStr);
    }

    if (
      typeof this.cache.isDownloading === 'function' &&
      this.cache.isDownloading(trackIdStr)
    ) {
      return TRACK_STATUS.DOWNLOADING;
    }

    return TRACK_STATUS.IDLE;
  }

  /**
   * Получает последнюю ошибку загрузки трека (если была).
   * @param {string|number} trackId
   * @returns {Error|null}
   */
  getError(trackId) {
    const rawId = getTrackId(trackId);
    if (rawId === null) return null;
    return this.errors.get(String(rawId)) || null;
  }

  /**
   * Подписка на изменение статусов треков.
   * @param {Function} listener ({ trackId, status, error, uri, purpose }) => void
   * @returns {Function} unsubscribe function
   */
  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _comparePriority(a, b) {
    return a.priority - b.priority;
  }

  /**
   * Compares items to rank most desirable first for Section 4.4 bounded queue limit:
   * 1. Among urgent items (priority 0), newer requests supersede older ones.
   * 2. Lower priority number is more desirable (priority 0 > 0.5 > 1 > 2).
   * 3. Among same non-urgent priority, newer request is more desirable.
   * @private
   */
  _compareDesirability(a, b) {
    if (a.priority === 0 && b.priority === 0) {
      return (b.seq || 0) - (a.seq || 0);
    }
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return (b.seq || 0) - (a.seq || 0);
  }

  /**
   * Enforces Section 4.4 bounded queue limit:
   * Latest desired current + lookahead including urgent jobs remains <= 3 (MAX_DESIRED_JOBS).
   * Obsolete jobs beyond the cap are cancelled and their promises settle with AbortError.
   * @private
   */
  _trimDesiredQueue() {
    const desiredItems = this.queue.filter(
      (item) => !this.graceTimers.has(item.trackId),
    );

    const maxAllowed = Math.max(1, MAX_DESIRED_JOBS - this.activeTasks.size);
    if (desiredItems.length <= maxAllowed) {
      return;
    }

    const sorted = [...desiredItems].sort(this._compareDesirability.bind(this));
    const toCancel = sorted.slice(maxAllowed);
    for (const item of toCancel) {
      this._cancelQueuedItemNow(item);
    }
  }

  _clearGraceTimer(trackId) {
    const id = String(trackId);
    const timer = this.graceTimers.get(id);
    if (timer) clearTimeout(timer);
    this.graceTimers.delete(id);
  }

  _scheduleGraceCancel(trackId, task) {
    const id = String(trackId);
    if (this.graceTimers.has(id)) return;
    // Bounded grace-cancelling jobs (Section 4.4): retain at most 2 old active jobs
    if (this.graceTimers.size >= MAX_GRACE_CANCEL_ACTIVE) {
      const oldestId = this.graceTimers.keys().next().value;
      const oldestTask =
        this.activeTasks.get(oldestId) ||
        this.queue.find((q) => q.trackId === oldestId);
      if (oldestTask) this._cancelTaskNow(oldestId, oldestTask);
    }
    const timer = setTimeout(() => {
      this.graceTimers.delete(id);
      const stillActive = this.activeTasks.get(id) === task;
      const stillQueued = this.queue.includes(task);
      if (!stillActive && !stillQueued) return;
      if (
        id === this.currentTrackId ||
        task.priority === 0 ||
        task.purpose === 'current'
      )
        return;
      this._cancelTaskNow(id, task);
      this._pump();
    }, this.gracePeriodMs);
    this.graceTimers.set(id, timer);
  }

  /**
   * Отменяет задачу. Если задача была активна, её слот удерживается до settle
   * underlying cache promise (bounded cancelling accounting); иначе слот
   * освобождается сразу после удаления из очереди.
   *
   * @param {string} trackId
   * @param {Object} task
   * @param {Object} [opts]
   * @param {boolean} [opts.keepSlot] - удерживать слот даже если задача не активна
   * @private
   */
  _cancelTaskNow(trackId, task, opts = {}) {
    const id = String(trackId);
    this._clearGraceTimer(id);
    this.pendingCancelCount.delete(id);
    if (this.currentCacheTrackId === id) {
      this.currentCacheTrackId = null;
      this._clearCurrentCacheTimer();
    }
    this.cache.cancel(id);
    if (task) {
      task.attemptToken = (task.attemptToken || 0) + 1;
    }
    const wasActive = this.activeTasks.get(id) === task;
    if (wasActive) this.activeTasks.delete(id);
    const queueIndex = this.queue.indexOf(task);
    if (queueIndex !== -1) this.queue.splice(queueIndex, 1);
    if (task?.reject) {
      task.reject(abortError());
    }
    this._setStatus(id, TRACK_STATUS.CANCELLED, {
      purpose: task?.purpose,
    });

    // Hold the slot for the *original* underlying cache promise, captured
    // before cancellation so a late cache settlement is still observed.
    if (wasActive || opts.keepSlot) {
      this._holdSlotUntilSettled(id, task, opts);
    }
  }

  /**
   * Удерживает слот отменённой задачи до settle её исходного cache promise.
   * Учёт ограничен MAX_ACTIVE_TASKS: лишние (сверх лимита) не удерживаются,
   * чтобы карта не росла бесконечно.
   * @private
   */
  _holdSlotUntilSettled(id, task) {
    if (this.settlingTasks.has(id)) return;

    const underlying = task?.downloadPromise || task?.promise;
    if (!underlying || typeof underlying.then !== 'function') {
      // Нечего ждать: слот освобождается синхронно.
      return;
    }

    let settle;
    const promise = new Promise((resolve) => {
      settle = resolve;
    });
    const entry = { promise, settle };
    this.settlingTasks.set(id, entry);
    // `then(onSettled, onSettled)` on a promise that already rejected without
    // a handler still reports unhandled rejection to Node; attach our own
    // catch chain first so settlement is observed without any dangling report.
    underlying.then(
      () => this._releaseSettlingTask(id, entry),
      () => this._releaseSettlingTask(id, entry),
    );
  }

  _releaseSettlingTask(id, entry) {
    if (this.settlingTasks.get(id) !== entry) return;
    this.settlingTasks.delete(id);
    entry.settle();
    this._pump();
  }

  _cancelQueuedItemNow(item) {
    this._cancelTaskNow(item.trackId, item);
  }

  /**
   * Отменяет все активные и запланированные загрузки.
   */
  cancelAll() {
    this._clearResumeRamp();
    this._clearCurrentCacheTimer();
    this.currentCacheTrackId = null;

    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    this.pendingCancelCount.clear();

    for (const [trackId, task] of Array.from(this.activeTasks.entries())) {
      this._cancelTaskNow(trackId, task);
    }
    this.activeTasks.clear();

    for (const item of this.queue) {
      if (item) item.attemptToken = (item.attemptToken || 0) + 1;
      this.cache.cancel(item.trackId);
      if (item.reject) {
        item.reject(abortError());
      }
      this._setStatus(item.trackId, TRACK_STATUS.CANCELLED, {
        purpose: item?.purpose,
      });
    }
    this.queue = [];
  }

  // --- Внутренние методы ---

  _setStatus(trackId, status, extra = {}) {
    const trackIdStr = String(trackId);
    this.statuses.set(trackIdStr, status);

    if (status === TRACK_STATUS.FAILED && extra.error) {
      this.errors.set(trackIdStr, extra.error);
    } else if (
      status === TRACK_STATUS.READY ||
      status === TRACK_STATUS.QUEUED
    ) {
      this.errors.delete(trackIdStr);
    }

    // Уведомляем подписчиков UI
    for (const listener of this.listeners) {
      try {
        listener({
          trackId: trackIdStr,
          status,
          error: extra.error || null,
          uri: extra.uri || null,
          purpose: extra.purpose || null,
        });
      } catch (err) {
        console.error('[PreloadScheduler] listener error:', err);
      }
    }
  }

  /**
   * Занятые слоты = активные задачи + отменённые, но ещё не settled.
   * Не освобождает слот до settle underlying cache promise.
   * @private
   */
  _occupiedSlots() {
    return this.activeTasks.size + this.settlingTasks.size;
  }

  /**
   * @private
   * @returns {number} сколько слотов реально можно занять сейчас (с учётом ramp)
   */
  _capacity() {
    const { maxConcurrent } = this._effectiveLimits();
    let cap = maxConcurrent;
    if (this.playbackPressure?.phase === PLAYBACK_PHASE.STABLE) {
      if (this.resumeTimers.length > 0) {
        // Ramp active: only ONE start permitted before 1000ms, even if first job completes early
        if (this.rampStartedCount >= 1) {
          return 0;
        }
        cap = Math.min(cap, 1);
      }
    }
    return Math.max(0, Math.min(cap - this._occupiedSlots(), MAX_ACTIVE_TASKS));
  }

  _pump() {
    if (this._isPressureActive() || !this._isOnline()) {
      return;
    }

    const { maxConcurrent, lookahead } = this._effectiveLimits();
    // 1. Если во главе очереди стоит срочная задача (priority 0), а все слоты заняты менее приоритетными задачами (>0)
    const hasUrgent = this.queue.length > 0 && this.queue[0].priority === 0;
    if (hasUrgent && this.activeTasks.size >= maxConcurrent) {
      let lowestPriTask = null;
      for (const [_, task] of this.activeTasks.entries()) {
        if (task.priority > 0) {
          if (!lowestPriTask || task.priority > lowestPriTask.priority) {
            lowestPriTask = task;
          }
        }
      }
      if (lowestPriTask) {
        // Уступаем слот для срочной задачи: отменяем текущую фоновую загрузку и возвращаем её в очередь.
        // Сохраняем исходный promise / resolve / reject, чтобы внешний код не остался с зависшим промисом!
        // Инкрементируем attemptToken, чтобы старая отменённая попытка не могла сбросить или перетереть новую попытку!
        lowestPriTask.attemptToken = (lowestPriTask.attemptToken || 0) + 1;
        this.cache.cancel(lowestPriTask.trackId);
        this.activeTasks.delete(lowestPriTask.trackId);
        this._holdSlotUntilSettled(lowestPriTask.trackId, lowestPriTask);
        this._setStatus(lowestPriTask.trackId, TRACK_STATUS.QUEUED, {
          purpose: lowestPriTask.purpose,
        });

        this.queue.push(lowestPriTask);
        this.queue.sort(this._comparePriority);
        this._trimDesiredQueue();
      }
    }

    // 2. Запускаем задачи строго в пределах maxConcurrent (общий лимит).
    let capacity = this._capacity();
    while (capacity > 0 && this.queue.length > 0) {
      // Ищем следующую подходящую задачу:
      // Не запускаем задачи, ожидающие отложенной отмены (graceTimers),
      // задачи того же трека, чья отмена ещё не завершилась (settlingTasks),
      // задачи кеширования текущего до истечения eligibility таймера,
      // и не запускаем фоновые задачи, превышающие текущий lookahead.
      const eligibleIndex = this.queue.findIndex((item) => {
        if (this.graceTimers.has(item.trackId)) return false;
        if (this.settlingTasks.has(item.trackId)) return false;
        if (item.purpose === 'current' && this.currentCacheTimer !== null) {
          return false;
        }
        if (item.priority > 0 && item.priority > lookahead) return false;
        return true;
      });
      if (eligibleIndex === -1) break;

      const [item] = this.queue.splice(eligibleIndex, 1);
      if (!item) break;

      // Если файл уже закеширован
      const cachedUri = this.cache.getCachedUri(item.trackId);
      if (cachedUri) {
        if (item.trackId === this.currentCacheTrackId) {
          this.currentCacheTrackId = null;
        }
        this._setStatus(item.trackId, TRACK_STATUS.READY, {
          uri: cachedUri,
          purpose: item.purpose,
        });
        if (item.resolve) item.resolve(cachedUri);
        continue;
      }

      this._startDownload(item);
      capacity -= 1;
    }
  }

  async _startDownload(item) {
    this._checkServerChange();
    if (
      this.playbackPressure?.phase === PLAYBACK_PHASE.STABLE &&
      this.resumeTimers.length > 0
    ) {
      this.rampStartedCount = (this.rampStartedCount || 0) + 1;
    }
    const attemptId = (item.attemptToken || 0) + 1;
    item.attemptToken = attemptId;
    const itemEpoch = item.epoch;
    this.activeTasks.set(item.trackId, item);
    this._setStatus(item.trackId, TRACK_STATUS.DOWNLOADING, {
      purpose: item.purpose,
    });

    const streamUrl = this.getStreamUrl(item.track);

    try {
      const downloadPromise = this.cache.getOrFetch(
        item.trackId,
        streamUrl,
        item.options,
      );
      item.downloadPromise = downloadPromise;
      if (downloadPromise && typeof downloadPromise.catch === 'function') {
        downloadPromise.catch(() => {});
      }
      const uri = await downloadPromise;
      if (
        item.attemptToken !== attemptId ||
        (itemEpoch !== undefined && item.epoch !== itemEpoch)
      ) {
        // Попытка была вытеснена или отменена до завершения; игнорируем устаревший результат
        return;
      }
      if (item.trackId === this.currentCacheTrackId) {
        this.currentCacheTrackId = null;
      }
      this._setStatus(item.trackId, TRACK_STATUS.READY, {
        uri,
        purpose: item.purpose,
      });
      if (item.resolve) {
        item.resolve(uri);
      }
      return uri;
    } catch (err) {
      if (
        item.attemptToken !== attemptId ||
        (itemEpoch !== undefined && item.epoch !== itemEpoch)
      ) {
        // Попытка была вытеснена или отменена; игнорируем ошибку устаревшей попытки
        return;
      }
      if (item.trackId === this.currentCacheTrackId) {
        this.currentCacheTrackId = null;
      }
      if (err?.message?.includes('cancelled') || err?.name === 'AbortError') {
        this._setStatus(item.trackId, TRACK_STATUS.CANCELLED, {
          purpose: item.purpose,
        });
      } else {
        this._setStatus(item.trackId, TRACK_STATUS.FAILED, {
          error: err,
          purpose: item.purpose,
        });
      }
      if (item.reject) {
        item.reject(err);
      }
    } finally {
      if (
        this.activeTasks.get(item.trackId) === item &&
        item.attemptToken === attemptId
      ) {
        this.activeTasks.delete(item.trackId);
        this._pump();
      }
    }
  }
}

const defaultPreloadScheduler = new PreloadScheduler();
export default defaultPreloadScheduler;
