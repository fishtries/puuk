/**
 * Preload scheduler for audio tracks.
 * Manages priority queue (urgent/priority 0, next/priority 1, next-next/priority 2),
 * strictly enforces concurrency limits without separate bypasses,
 * coordinates with AudioCache as the single point of download execution,
 * promotes existing tasks to higher priority, avoids duplicate downloads,
 * reports statuses to UI (idle, queued, downloading, ready, failed, cancelled),
 * defers cancellation of out-of-window tasks by a grace period,
 * and narrows limits by network policy (Wi-Fi / cellular / unknown).
 */

import defaultAudioCache from './audioCache';
import { getCurrentNetworkPolicy, subscribeNetworkPolicy, SAFE_NETWORK_POLICY } from './networkPolicy';
import { SERVER_URL } from './api';
import { normalizeStreamUrl } from './streamUrl';

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

export class PreloadScheduler {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxConcurrent=2] - Максимум параллельных загрузок
   * @param {number} [options.lookahead=2] - Сколько будущих треков предзагружать
   * @param {Object} [options.cache] - Экземпляр AudioCache
   * @param {Function} [options.getStreamUrl] - Функция получения URL потока из трека
   * @param {Function} [options.getNetworkPolicy] - Функция получения текущей политики сети
   * @param {Function} [options.subscribeNetworkPolicy] - Функция подписки на изменения сети
   */
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || SERVER_URL;
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.lookahead = options.lookahead ?? 2;
    this.cache = options.cache || defaultAudioCache;
    this.getStreamUrl = options.getStreamUrl || ((t) => normalizeStreamUrl(t, this.serverUrl));
    this.gracePeriodMs = options.gracePeriodMs ?? GRACE_PERIOD_MS;
    this.staleSyncLimit = options.staleSyncLimit ?? STALE_SYNC_LIMIT;
    this.getNetworkPolicy = options.getNetworkPolicy || getCurrentNetworkPolicy;
    this.subscribeNetworkPolicy = options.subscribeNetworkPolicy || subscribeNetworkPolicy;

    this.queue = []; // [{ trackId, track, priority, options, epoch, promise, resolve, reject, preempted }]
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

    this._unsubscribeNetwork = null;
    if (typeof this.subscribeNetworkPolicy === 'function') {
      try {
        this._unsubscribeNetwork = this.subscribeNetworkPolicy((policy) => {
          this._onNetworkPolicyChanged(policy);
        });
      } catch (err) {
        console.warn('[PreloadScheduler] Failed to subscribe to network policy:', err);
      }
    }
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
      const rawPolicy = typeof this.getNetworkPolicy === 'function' ? this.getNetworkPolicy() : null;
      const policy = rawPolicy || SAFE_NETWORK_POLICY;
      if (policy) {
        maxConcurrent = Math.min(maxConcurrent, policy.maxConcurrent);
        lookahead = Math.min(lookahead, policy.lookahead);
      }
    } catch {
      maxConcurrent = Math.min(maxConcurrent, SAFE_NETWORK_POLICY.maxConcurrent);
      lookahead = Math.min(lookahead, SAFE_NETWORK_POLICY.lookahead);
    }
    return { maxConcurrent, lookahead };
  }

  /**
   * Устанавливает текущий играющий трек и защищает его от отмены.
   * @param {Object|null} track
   */
  setCurrentTrack(track) {
    const idStr = track?.id !== undefined && track?.id !== null ? String(track.id) : null;
    this.currentTrackId = idStr;
    if (idStr) {
      this._clearGraceTimer(idStr);
      this.pendingCancelCount.delete(idStr);
    }
  }

  /**
   * Реакция на изменение политики сети: пересинхронизирует очередь с новыми лимитами.
   * @private
   */
  _onNetworkPolicyChanged(_policy) {
    if (this.lastCurrentTrack !== undefined) {
      const { force: _force, ...networkOptions } = this.lastOptions || {};
      this.syncQueue(this.lastCurrentTrack, this.lastUpNextQueue, networkOptions);
    } else {
      this._pump();
    }
  }

  destroy() {
    if (this._unsubscribeNetwork) {
      this._unsubscribeNetwork();
      this._unsubscribeNetwork = null;
    }
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
    this.lastCurrentTrack = currentTrack;
    this.lastUpNextQueue = upNextQueue;
    this.lastOptions = options;

    this.epoch += 1;
    const currentEpoch = this.epoch;
    const { force = false, ...fetchOptions } = options;
    this.currentTrackId = (currentTrack?.id !== undefined && currentTrack?.id !== null)
      ? String(currentTrack.id)
      : null;
    const { lookahead } = this._effectiveLimits();

    // Окно кандидатов: upNextQueue[0] (next, priority 1), upNextQueue[1] (next-next, priority 2)
    const candidates = [];
    const neededTrackIds = new Set();

    if (upNextQueue && Array.isArray(upNextQueue)) {
      const window = upNextQueue.slice(0, lookahead);
      for (let i = 0; i < window.length; i++) {
        const track = window[i];
        if (!track?.id && track?.id !== 0) continue;
        const trackIdStr = String(track.id);
        neededTrackIds.add(trackIdStr);
        candidates.push({
          trackId: trackIdStr,
          track,
          priority: i + 1, // priority 1, 2...
          options: fetchOptions,
          epoch: currentEpoch,
        });
      }
    }

    // 1. Активные загрузки: отложенная отмена через grace period
    // Важно: текущий трек (currentTrackId) и срочные задачи (priority 0) НЕ отменяем никогда.
    for (const [trackId, task] of Array.from(this.activeTasks.entries())) {
      if (trackId === this.currentTrackId || task?.priority === 0) {
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
      if (neededTrackIds.has(item.trackId) || item.trackId === this.currentTrackId || item.priority === 0) {
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
      const downloadState = typeof this.cache.getDownloadState === 'function'
        ? this.cache.getDownloadState(cand.trackId)
        : (this.cache.isCached(cand.trackId) ? { status: 'cached' } : { status: 'idle' });

      if (downloadState.status === 'cached') {
        this._setStatus(cand.trackId, TRACK_STATUS.READY, { uri: downloadState.uri });
        continue;
      }

      // Если задача уже активна в планировщике:
      if (this.activeTasks.has(cand.trackId)) {
        const activeItem = this.activeTasks.get(cand.trackId);
        activeItem.epoch = currentEpoch;
        activeItem.priority = cand.priority;
        this._setStatus(cand.trackId, TRACK_STATUS.DOWNLOADING);
        continue;
      }

      // Если загрузка уже идёт напрямую через cache (например, из PlaybackCoordinator.play):
      if (downloadState.status === 'downloading') {
        this._setStatus(cand.trackId, TRACK_STATUS.DOWNLOADING);
        if (downloadState.promise) {
          downloadState.promise
            .then((uri) => {
              if (this.getStatus(cand.trackId) === TRACK_STATUS.DOWNLOADING) {
                this._setStatus(cand.trackId, TRACK_STATUS.READY, { uri });
              }
            })
            .catch((err) => {
              if (this.getStatus(cand.trackId) === TRACK_STATUS.DOWNLOADING) {
                this._setStatus(cand.trackId, TRACK_STATUS.FAILED, { error: err });
              }
            });
        }
        continue;
      }

      const existingInQueue = this.queue.find(q => q.trackId === cand.trackId);
      if (existingInQueue) {
        // Обновляем приоритет и эпоху
        existingInQueue.priority = cand.priority;
        existingInQueue.epoch = currentEpoch;
      } else {
        const currentStatus = this.getStatus(cand.trackId);
        if (currentStatus !== TRACK_STATUS.DOWNLOADING && currentStatus !== TRACK_STATUS.READY) {
          let resolveFn, rejectFn;
          const promise = new Promise((res, rej) => {
            resolveFn = res;
            rejectFn = rej;
          });
          promise.catch(() => {});

          cand.promise = promise;
          cand.resolve = resolveFn;
          cand.reject = rejectFn;

          this.queue.push(cand);
          this._setStatus(cand.trackId, TRACK_STATUS.QUEUED);
        }
      }
    }

    // 4. Сортируем очередь по приоритету (меньший номер priority = выше приоритет)
    this.queue.sort((a, b) => a.priority - b.priority);

    // 5. Запускаем обработку очереди
    this._pump();
  }

  /**
   * Срочная загрузка (приоритет 0).
   * Добавляется в общий планировщик, не обходит лимиты concurrency.
   * Если загрузка уже идёт — возвращает существующий promise.
   * Если задача уже была в очереди — повышает её приоритет до 0.
   *
   * @param {Object} track
   * @param {Object} [options]
   * @param {string|number} [options.currentTrackId]
   * @returns {Promise<string>}
   */
  async preloadImmediate(track, options = {}) {
    if (!track?.id && track?.id !== 0) throw new Error('Track must have an id');
    const trackIdStr = String(track.id);
    const activeCurrentId = options.currentTrackId !== undefined && options.currentTrackId !== null
      ? String(options.currentTrackId)
      : this.currentTrackId;

    if (activeCurrentId) {
      this.currentTrackId = activeCurrentId;
      this._clearGraceTimer(activeCurrentId);
      this.pendingCancelCount.delete(activeCurrentId);
    }

    // Срочная загрузка освобождает полосу от задач, уже выпавших из окна.
    // Защита: текущий трек (activeCurrentId / this.currentTrackId) и сам целевой трек НЕ отменяются.
    for (const [staleTrackId] of Array.from(this.graceTimers.entries())) {
      const staleTask = this.activeTasks.get(staleTrackId)
        || this.queue.find((item) => item.trackId === staleTrackId);
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
      this._setStatus(trackIdStr, TRACK_STATUS.READY, { uri });
      return uri;
    }

    // 2. Если трек уже активно скачивается в планировщике:
    const activeItem = this.activeTasks.get(trackIdStr);
    if (activeItem) {
      activeItem.priority = 0;
      this._setStatus(trackIdStr, TRACK_STATUS.DOWNLOADING);
      return activeItem.promise;
    }

    // 3. Если трек уже скачивается в AudioCache напрямую:
    const downloadState = typeof this.cache.getDownloadState === 'function'
      ? this.cache.getDownloadState(trackIdStr)
      : null;

    if (downloadState && downloadState.status === 'downloading' && downloadState.promise) {
      this._setStatus(trackIdStr, TRACK_STATUS.DOWNLOADING);
      // Если стоял в очереди ожидания, удаляем, так как он уже скачивается
      this.queue = this.queue.filter(q => q.trackId !== trackIdStr);
      try {
        const uri = await downloadState.promise;
        this._setStatus(trackIdStr, TRACK_STATUS.READY, { uri });
        return uri;
      } catch (err) {
        this._setStatus(trackIdStr, TRACK_STATUS.FAILED, { error: err });
        throw err;
      }
    }

    // 4. Если трек уже есть в очереди ожидания: повышаем приоритет до 0
    const existingInQueue = this.queue.find(q => q.trackId === trackIdStr);
    if (existingInQueue) {
      existingInQueue.priority = 0;
      if (options) {
        existingInQueue.options = { ...existingInQueue.options, ...options };
      }
      this.queue.sort((a, b) => a.priority - b.priority);
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
      options,
      epoch: this.epoch,
      promise,
      resolve: resolveFn,
      reject: rejectFn,
    };

    this.queue.unshift(item);
    this.queue.sort((a, b) => a.priority - b.priority);
    this._setStatus(trackIdStr, TRACK_STATUS.QUEUED);
    this._pump();
    return promise;
  }

  /**
   * Получает текущий статус трека для UI.
   * @param {string|number} trackId
   * @returns {string} TRACK_STATUS
   */
  getStatus(trackId) {
    if (!trackId && trackId !== 0) return TRACK_STATUS.IDLE;
    const trackIdStr = String(trackId);

    if (this.cache.isCached(trackIdStr)) {
      return TRACK_STATUS.READY;
    }

    if (this.statuses.has(trackIdStr)) {
      return this.statuses.get(trackIdStr);
    }

    if (typeof this.cache.isDownloading === 'function' && this.cache.isDownloading(trackIdStr)) {
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
    if (!trackId && trackId !== 0) return null;
    return this.errors.get(String(trackId)) || null;
  }

  /**
   * Подписка на изменение статусов треков.
   * @param {Function} listener ({ trackId, status, error, uri }) => void
   * @returns {Function} unsubscribe function
   */
  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    const timer = setTimeout(() => {
      this.graceTimers.delete(id);
      const stillActive = this.activeTasks.get(id) === task;
      const stillQueued = this.queue.includes(task);
      if (!stillActive && !stillQueued) return;
      if (id === this.currentTrackId || task.priority === 0) return;
      this._cancelTaskNow(id, task);
      this._pump();
    }, this.gracePeriodMs);
    this.graceTimers.set(id, timer);
  }

  _cancelTaskNow(trackId, task) {
    const id = String(trackId);
    this._clearGraceTimer(id);
    this.pendingCancelCount.delete(id);
    this.cache.cancel(id);
    if (task) {
      task.attemptToken = (task.attemptToken || 0) + 1;
    }
    if (this.activeTasks.get(id) === task) this.activeTasks.delete(id);
    const queueIndex = this.queue.indexOf(task);
    if (queueIndex !== -1) this.queue.splice(queueIndex, 1);
    if (task?.reject) {
      const error = new Error('Download cancelled');
      error.name = 'AbortError';
      task.reject(error);
    }
    this._setStatus(id, TRACK_STATUS.CANCELLED);
  }

  _cancelQueuedItemNow(item) {
    this._cancelTaskNow(item.trackId, item);
  }

  /**
   * Отменяет все активные и запланированные загрузки.
   */
  cancelAll() {
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    this.pendingCancelCount.clear();

    for (const [trackId, task] of Array.from(this.activeTasks.entries())) {
      if (task) task.attemptToken = (task.attemptToken || 0) + 1;
      this.cache.cancel(trackId);
      if (task.reject) {
        const err = new Error('Download cancelled');
        err.name = 'AbortError';
        task.reject(err);
      }
      this._setStatus(trackId, TRACK_STATUS.CANCELLED);
    }
    this.activeTasks.clear();

    for (const item of this.queue) {
      if (item) item.attemptToken = (item.attemptToken || 0) + 1;
      this.cache.cancel(item.trackId);
      if (item.reject) {
        const err = new Error('Download cancelled');
        err.name = 'AbortError';
        item.reject(err);
      }
      this._setStatus(item.trackId, TRACK_STATUS.CANCELLED);
    }
    this.queue = [];
  }

  // --- Внутренние методы ---

  _setStatus(trackId, status, extra = {}) {
    const trackIdStr = String(trackId);
    this.statuses.set(trackIdStr, status);

    if (status === TRACK_STATUS.FAILED && extra.error) {
      this.errors.set(trackIdStr, extra.error);
    } else if (status === TRACK_STATUS.READY || status === TRACK_STATUS.QUEUED) {
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
        });
      } catch (err) {
        console.error('[PreloadScheduler] listener error:', err);
      }
    }
  }

  _pump() {
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
        this._setStatus(lowestPriTask.trackId, TRACK_STATUS.QUEUED);

        this.queue.push(lowestPriTask);
        this.queue.sort((a, b) => a.priority - b.priority);
      }
    }

    // 2. Запускаем задачи строго в пределах maxConcurrent
    while (this.activeTasks.size < maxConcurrent && this.queue.length > 0) {
      // Ищем следующую подходящую задачу:
      // Не запускаем задачи, ожидающие отложенной отмены (graceTimers),
      // и не запускаем фоновые задачи, превышающие текущий lookahead
      const eligibleIndex = this.queue.findIndex((item) => {
        if (this.graceTimers.has(item.trackId)) return false;
        if (item.priority > 0 && item.priority > lookahead) return false;
        return true;
      });
      if (eligibleIndex === -1) break;

      const [item] = this.queue.splice(eligibleIndex, 1);
      if (!item) break;

      // Если файл уже закеширован
      const cachedUri = this.cache.getCachedUri(item.trackId);
      if (cachedUri) {
        this._setStatus(item.trackId, TRACK_STATUS.READY, { uri: cachedUri });
        if (item.resolve) item.resolve(cachedUri);
        continue;
      }

      this._startDownload(item);
    }
  }

  async _startDownload(item) {
    const attemptId = (item.attemptToken || 0) + 1;
    item.attemptToken = attemptId;
    this.activeTasks.set(item.trackId, item);
    this._setStatus(item.trackId, TRACK_STATUS.DOWNLOADING);

    const streamUrl = this.getStreamUrl(item.track);

    try {
      const uri = await this.cache.getOrFetch(item.trackId, streamUrl, item.options);
      if (item.attemptToken !== attemptId) {
        // Попытка была вытеснена или отменена до завершения; игнорируем устаревший результат
        return;
      }
      this._setStatus(item.trackId, TRACK_STATUS.READY, { uri });
      if (item.resolve) {
        item.resolve(uri);
      }
      return uri;
    } catch (err) {
      if (item.attemptToken !== attemptId) {
        // Попытка была вытеснена или отменена; игнорируем ошибку устаревшей попытки
        return;
      }
      if (err?.message?.includes('cancelled') || err?.name === 'AbortError') {
        this._setStatus(item.trackId, TRACK_STATUS.CANCELLED);
      } else {
        this._setStatus(item.trackId, TRACK_STATUS.FAILED, { error: err });
      }
      if (item.reject) {
        item.reject(err);
      }
    } finally {
      if (this.activeTasks.get(item.trackId) === item && item.attemptToken === attemptId) {
        this.activeTasks.delete(item.trackId);
        this._pump();
      }
    }
  }
}

const defaultPreloadScheduler = new PreloadScheduler();
export default defaultPreloadScheduler;
