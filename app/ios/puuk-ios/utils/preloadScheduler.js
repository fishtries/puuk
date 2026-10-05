/**
 * Preload scheduler for audio tracks.
 * Manages priority queue (current, next, next-next), limits concurrency,
 * avoids duplicate downloads, cancels stale downloads when the logical queue changes,
 * and reports statuses to UI (idle, queued, downloading, ready, failed, cancelled).
 */

import defaultAudioCache from './audioCache';

export const TRACK_STATUS = {
  IDLE: 'idle',
  QUEUED: 'queued',
  DOWNLOADING: 'downloading',
  READY: 'ready',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export class PreloadScheduler {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxConcurrent=2] - Максимум параллельных загрузок
   * @param {number} [options.lookahead=2] - Сколько будущих треков предзагружать
   * @param {Object} [options.cache] - Экземпляр AudioCache
   * @param {Function} [options.getStreamUrl] - Функция получения URL потока из трека
   */
  constructor(options = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.lookahead = options.lookahead ?? 2;
    this.cache = options.cache || defaultAudioCache;
    this.getStreamUrl = options.getStreamUrl || ((t) => t?.stream_url || (t?.id ? `/api/stream/${t.id}` : null));

    this.queue = []; // [{ trackId, track, priority, options }]
    this.activeTasks = new Map(); // trackId => item
    this.statuses = new Map(); // trackId => TRACK_STATUS
    this.errors = new Map(); // trackId => error
    this.listeners = new Set();
    this.currentTrackId = null;
    this.epoch = 0;
    this.isInitialized = true;
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
   * Отменяет предзагрузку треков, которые выпали из окна lookahead.
   * Ставит в очередь актуальные треки с соответствующим приоритетом.
   *
   * @param {Object|null} currentTrack - Текущий играющий трек
   * @param {Array<Object>} upNextQueue - Будущая очередь воспроизведения
   * @param {Object} [options] - Опции (заголовки auth и т.д.)
   */
  syncQueue(currentTrack, upNextQueue = [], options = {}) {
    this.epoch += 1;
    const currentEpoch = this.epoch;
    this.currentTrackId = currentTrack?.id ? String(currentTrack.id) : null;

    // Окно кандидатов: upNextQueue[0] (next, priority 1), upNextQueue[1] (next-next, priority 2)
    const candidates = [];
    const neededTrackIds = new Set();

    if (upNextQueue && Array.isArray(upNextQueue)) {
      const window = upNextQueue.slice(0, this.lookahead);
      for (let i = 0; i < window.length; i++) {
        const track = window[i];
        if (!track?.id) continue;
        const trackIdStr = String(track.id);
        neededTrackIds.add(trackIdStr);
        candidates.push({
          trackId: trackIdStr,
          track,
          priority: i + 1, // priority 1, 2...
          options,
          epoch: currentEpoch,
        });
      }
    }

    // 1. Отменяем активные загрузки, которые больше не нужны
    for (const [trackId] of Array.from(this.activeTasks.entries())) {
      if (!neededTrackIds.has(trackId)) {
        this.cache.cancel(trackId);
        this.activeTasks.delete(trackId);
        this._setStatus(trackId, TRACK_STATUS.CANCELLED);
      }
    }

    // 2. Отменяем всё из очереди ожидания, что больше не входит в neededTrackIds
    const remainingQueue = [];
    for (const item of this.queue) {
      if (neededTrackIds.has(item.trackId)) {
        remainingQueue.push(item);
      } else {
        this.cache.cancel(item.trackId);
        this._setStatus(item.trackId, TRACK_STATUS.CANCELLED);
      }
    }
    this.queue = remainingQueue;

    // 2. Добавляем новые кандидаты, если их ещё нет в очереди и они ещё не скачаны
    for (const cand of candidates) {
      if (this.cache.isCached(cand.trackId)) {
        this._setStatus(cand.trackId, TRACK_STATUS.READY);
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
          this.queue.push(cand);
          this._setStatus(cand.trackId, TRACK_STATUS.QUEUED);
        }
      }
    }

    // 3. Сортируем очередь по приоритету (меньший номер priority = выше приоритет)
    this.queue.sort((a, b) => a.priority - b.priority);

    // 4. Запускаем обработку очереди
    this._pump();
  }

  /**
   * Срочная загрузка (например, текущий трек с приоритетом 0).
   * @param {Object} track
   * @param {Object} [options]
   * @returns {Promise<string>}
   */
  async preloadImmediate(track, options = {}) {
    if (!track?.id) throw new Error('Track must have an id');
    const trackIdStr = String(track.id);

    if (this.cache.isCached(trackIdStr)) {
      this._setStatus(trackIdStr, TRACK_STATUS.READY);
      return this.cache.getCachedUri(trackIdStr);
    }

    // Снимаем из обычной очереди, если стоял там
    this.queue = this.queue.filter(q => q.trackId !== trackIdStr);

    this._setStatus(trackIdStr, TRACK_STATUS.DOWNLOADING);
    const streamUrl = this.getStreamUrl(track);

    try {
      this.activeTaskCount++;
      const uri = await this.cache.getOrFetch(trackIdStr, streamUrl, options);
      this._setStatus(trackIdStr, TRACK_STATUS.READY, { uri });
      return uri;
    } catch (err) {
      this._setStatus(trackIdStr, TRACK_STATUS.FAILED, { error: err });
      throw err;
    } finally {
      this.activeTaskCount = Math.max(0, this.activeTaskCount - 1);
      this._pump();
    }
  }

  /**
   * Получает текущий статус трека для UI.
   * @param {string|number} trackId
   * @returns {string} TRACK_STATUS
   */
  getStatus(trackId) {
    if (!trackId) return TRACK_STATUS.IDLE;
    const trackIdStr = String(trackId);

    if (this.cache.isCached(trackIdStr)) {
      return TRACK_STATUS.READY;
    }

    return this.statuses.get(trackIdStr) || TRACK_STATUS.IDLE;
  }

  /**
   * Получает последнюю ошибку загрузки трека (если была).
   * @param {string|number} trackId
   * @returns {Error|null}
   */
  getError(trackId) {
    if (!trackId) return null;
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

  /**
   * Отменяет все активные и запланированные загрузки.
   */
  cancelAll() {
    for (const item of this.queue) {
      this.cache.cancel(item.trackId);
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
    while (this.activeTasks.size < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;

      // Если файл уже закеширован
      if (this.cache.isCached(item.trackId)) {
        this._setStatus(item.trackId, TRACK_STATUS.READY);
        continue;
      }

      this._startDownload(item);
    }
  }

  async _startDownload(item) {
    this.activeTasks.set(item.trackId, item);
    this._setStatus(item.trackId, TRACK_STATUS.DOWNLOADING);

    const streamUrl = this.getStreamUrl(item.track);

    try {
      const uri = await this.cache.getOrFetch(item.trackId, streamUrl, item.options);
      this._setStatus(item.trackId, TRACK_STATUS.READY, { uri });
    } catch (err) {
      if (err?.message?.includes('cancelled') || err?.name === 'AbortError') {
        this._setStatus(item.trackId, TRACK_STATUS.CANCELLED);
      } else {
        this._setStatus(item.trackId, TRACK_STATUS.FAILED, { error: err });
      }
    } finally {
      this.activeTasks.delete(item.trackId);
      this._pump();
    }
  }
}

const defaultPreloadScheduler = new PreloadScheduler();
export default defaultPreloadScheduler;