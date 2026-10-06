/**
 * Playback Coordinator.
 * Coordinates AudioPlayer (expo-audio), AudioCache, and PreloadScheduler.
 * Implements gapless preload/replace mechanism, remote URI fallback,
 * idempotent playback, generation/token race protection,
 * fine-grained error classification, and debug-gated diagnostics.
 */

import defaultAudioCache from './audioCache';
import defaultPreloadScheduler, { TRACK_STATUS } from './preloadScheduler';
import { resolveCoverUri } from '../components/CoverImage';
import { SERVER_URL, getCachedAuthToken, getAuthToken } from './api';

// Native expo-audio preload is disabled because it registers an AVQueuePlayer in the native registry,
// which triggers an NSInvalidArgumentException / HostFunction crash in unpatched iOS binaries.
// Background preloading is handled safely and reliably by PreloadScheduler + AudioCache using local file URIs.
let expoPreloadNative = null;

export const BYPASS_AUDIO_CACHE = false;

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
  const status = err?.status;
  let type = 'unknown';

  if (
    status === 401 ||
    msg.includes('401') ||
    msg.toLowerCase().includes('unauthorized') ||
    msg.toLowerCase().includes('auth')
  ) {
    type = 'auth_error';
  } else if (
    status === 408 ||
    err?.name === 'TimeoutError' ||
    msg.toLowerCase().includes('timeout') ||
    msg.toLowerCase().includes('timed out')
  ) {
    type = 'network_timeout';
  } else if (
    msg.toLowerCase().includes('play') ||
    msg.toLowerCase().includes('playback')
  ) {
    type = 'play_error';
  } else if (
    msg.toLowerCase().includes('cache') ||
    msg.toLowerCase().includes('local')
  ) {
    type = 'local_cache_error';
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

/**
 * Нормализует stream URL для воспроизведения:
 * - Гарантирует корректный базовый SERVER_URL (без лишних слешей)
 * - Гарантирует формат https://<host>/api/stream/<id>
 * - Исключает двойные слеши, кавычки, пробелы
 * - Проверяет валидность URL
 *
 * @param {Object} track
 * @param {string} [serverUrl]
 * @returns {string}
 */
export function normalizeStreamUrl(track, serverUrl = SERVER_URL) {
  if (!track) return '';
  const rawTrackId = (track.id !== undefined && track.id !== null)
    ? track.id
    : track.track_id;
  if (!rawTrackId && rawTrackId !== 0) return '';
  const trackIdStr = String(rawTrackId).trim().replace(/['"]/g, '');

  const cleanServerUrl = (serverUrl || 'https://web.puuk.fun')
    .trim()
    .replace(/['"]/g, '')
    .replace(/\/+$/, '');

  const rawStream = typeof track.stream_url === 'string'
    ? track.stream_url.trim().replace(/['"]/g, '')
    : '';

  let normalized;
  const streamPathIndex = rawStream.indexOf('/api/stream/');
  if (streamPathIndex !== -1) {
    const pathPart = rawStream.slice(streamPathIndex).replace(/\/+/g, '/');
    normalized = `${cleanServerUrl}${pathPart}`;
  } else if (rawStream.startsWith('http://') || rawStream.startsWith('https://')) {
    normalized = rawStream;
  } else if (rawStream.startsWith('/')) {
    normalized = `${cleanServerUrl}${rawStream.replace(/\/+/g, '/')}`;
  } else {
    normalized = `${cleanServerUrl}/api/stream/${encodeURIComponent(trackIdStr)}`;
  }

  return normalized;
}

export class PlaybackCoordinator {
  constructor(options = {}) {
    this.cache = options.cache || defaultAudioCache;
    this.scheduler = options.scheduler || defaultPreloadScheduler;
    this.preloadNative = options.preloadNative || null;
    this.serverUrl = options.serverUrl || SERVER_URL;
    this.bypassCache = options.bypassCache !== undefined ? options.bypassCache : BYPASS_AUDIO_CACHE;
    this.debug = Boolean(options.debug);

    this.currentTrack = null;
    this.currentTrackId = null;
    this.currentPlayUri = null;
    this.currentIsLocal = false;
    this._currentSourceHeaders = null;
    this.playbackGeneration = 0;
    this.upNextQueue = [];
    this.listeners = new Set();

    this.networkStatus = 'good'; // 'good' | 'slow' | 'error'
    this.nextTrackStatus = TRACK_STATUS.IDLE;
    this.networkError = null;
    this.lastErrorType = null;
    this.lastCacheError = null;
    this.isBufferingSlow = false;
    this._bufferingTimeout = null;

    // Подписываемся на события планировщика предзагрузки
    this._unsubscribeScheduler = this.scheduler.addListener((event) => {
      this._handleSchedulerEvent(event);
    });
  }

  destroy() {
    this.playbackGeneration += 1;
    this.currentTrack = null;
    this.currentTrackId = null;
    this.currentPlayUri = null;
    this.currentIsLocal = false;
    this.networkError = null;
    this.networkStatus = 'good';
    this.lastErrorType = null;
    if (this._unsubscribeScheduler) {
      this._unsubscribeScheduler();
    }
    if (this._bufferingTimeout) {
      clearTimeout(this._bufferingTimeout);
    }
    this.listeners.clear();
  }

  /**
   * Выполняет player.replace с защитой от out-of-order завершения.
   * Если устаревший replace завершается позже, чем уже начал играть более новый трек,
   * повторно устанавливает актуальный источник, чтобы плеер не остался на старом треке.
   *
   * @private
   */
  async _performReplace(player, source, isCurrent, generation) {
    if (!isCurrent()) {
      return { superseded: true };
    }

    await player.replace(source);

    if (!isCurrent()) {
      if (this.currentPlayUri && this.currentPlayUri !== source.uri && this.playbackGeneration > generation) {
        this._warn('[Coordinator] Stale replace completed after newer track was started, re-applying current source:', {
          staleUri: source.uri,
          currentUri: this.currentPlayUri,
        });
        const currentSource = this.currentIsLocal
          ? { uri: this.currentPlayUri }
          : (this._currentSourceHeaders
              ? { uri: this.currentPlayUri, headers: this._currentSourceHeaders }
              : { uri: this.currentPlayUri });
        try {
          await player.replace(currentSource);
          await player.play();
        } catch (err) {
          this._warn('[Coordinator] Failed to re-apply current source after stale replace:', err?.message);
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
    const rawTrackId = (track?.id !== undefined && track?.id !== null)
      ? track.id
      : track?.track_id;

    if (rawTrackId === undefined || rawTrackId === null || (rawTrackId === '' && rawTrackId !== 0)) {
      this._warn('[Coordinator] play() called without valid track:', track);
      return { isLocal: false, uri: null };
    }

    const trackIdStr = String(rawTrackId).trim();

    // 1. Нормализация URL
    const rawStreamUrl = track.stream_url || `${this.serverUrl}/api/stream/${encodeURIComponent(trackIdStr)}`;
    const normalizedStreamUrl = normalizeStreamUrl(track, this.serverUrl);

    this._log('[Coordinator][Stage 1: normalize_url]', {
      trackId: trackIdStr,
      rawStreamUrl,
      normalizedStreamUrl,
      serverUrl: this.serverUrl,
    });

    if (!normalizedStreamUrl || (!normalizedStreamUrl.startsWith('http://') && !normalizedStreamUrl.startsWith('https://'))) {
      const urlErr = new PlaybackError(`[Coordinator] Invalid stream URL: "${normalizedStreamUrl}" for track ${trackIdStr}`, {
        type: 'remote_replace_error',
        trackId: trackIdStr,
      });
      this._error('[Coordinator][Stage 1: normalize_url FAILED]', urlErr);
      throw urlErr;
    }

    // 2. Проверка локального кеша
    let localUri = null;
    if (this.bypassCache) {
      this._log('[Coordinator][Stage 2: get_cached_uri] Cache BYPASSED by diagnostic flag');
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
        this.lastCacheError = new PlaybackError(cacheErr?.message || 'Cache lookup failed', {
          type: 'local_cache_error',
          cause: cacheErr,
          trackId: trackIdStr,
        });
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
    const sameHeaders = expectedIsLocal || areHeadersEqual(cleanHeaders, this._currentSourceHeaders);

    // 3. Идемпотентность play: если уже играет тот же трек, источник и заголовки не изменились
    if (!options.force && this.currentTrackId === trackIdStr && this.currentPlayUri === expectedUri && sameHeaders) {
      this._log('[Coordinator] Idempotent play() - same track, uri, and headers, resuming playback');
      try {
        await player.play();
      } catch (playErr) {
        const classified = new PlaybackError(playErr?.message || 'Player play failed', {
          type: 'play_error',
          cause: playErr,
          trackId: trackIdStr,
        });
        this.networkError = classified.message;
        this.networkStatus = 'error';
        this.lastErrorType = classified.type;
        this._notifyState();
        throw classified;
      }
      return { isLocal: this.currentIsLocal, uri: this.currentPlayUri, reused: true };
    }

    // 4. Generation token защиты от race condition при быстрых переключениях
    this.playbackGeneration += 1;
    const currentGeneration = this.playbackGeneration;
    const isCurrent = () => this.playbackGeneration === currentGeneration;

    this.currentTrack = track;
    this.currentTrackId = trackIdStr;

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
        const replaceRes = await this._performReplace(player, { uri: localUri }, isCurrent, currentGeneration);
        if (replaceRes.superseded) return { isLocal: false, uri: null, superseded: true };
      } catch (localErr) {
        if (!isCurrent()) return { isLocal: false, uri: null, superseded: true };
        this._warn('[Coordinator][Stage 3: local_replace FAILED, falling back to remote]', localErr?.message);
        this.lastCacheError = new PlaybackError(localErr?.message || 'Local replace failed', {
          type: 'local_cache_error',
          cause: localErr,
          trackId: trackIdStr,
        });
        isLocal = false;
        playUri = null;
      }
    }

    if (!isCurrent()) {
      return { isLocal: false, uri: null, superseded: true };
    }

    if (!playUri) {
      isLocal = false;
      playUri = normalizedStreamUrl;
      this._log('[Coordinator][Stage 3: remote_replace]', {
        trackId: trackIdStr,
        normalizedStreamUrl,
      });

      // При отсутствии синхронных заголовков резолвим асинхронный геттер (например, SecureStore)
      if (!hasHeaders && typeof options.getHeadersAsync === 'function') {
        try {
          const asyncHeaders = await options.getHeadersAsync();
          if (asyncHeaders && typeof asyncHeaders === 'object') {
            for (const [k, v] of Object.entries(asyncHeaders)) {
              if (typeof v === 'string' && v.trim()) cleanHeaders[k] = v.trim();
            }
            hasHeaders = Object.keys(cleanHeaders).length > 0;
          }
        } catch (hdrErr) {
          this._warn('[Coordinator] Failed to resolve auth headers asynchronously:', hdrErr?.message);
        }
      }

      if (!isCurrent()) {
        return { isLocal: false, uri: null, superseded: true };
      }

      const source = hasHeaders
        ? { uri: normalizedStreamUrl, headers: cleanHeaders }
        : { uri: normalizedStreamUrl };

      try {
        const replaceRes = await this._performReplace(player, source, isCurrent, currentGeneration);
        if (replaceRes.superseded) return { isLocal: false, uri: null, superseded: true };
      } catch (remoteErr) {
        if (!isCurrent()) return { isLocal: false, uri: null, superseded: true };
        this._log('[Coordinator][Stage 3: remote_replace retrying once via replaceCurrentSource...]');

        try {
          const retryRes = await this._performReplace(player, source, isCurrent, currentGeneration);
          if (retryRes.superseded) return { isLocal: false, uri: null, superseded: true };
        } catch (retryErr) {
          if (!isCurrent()) return { isLocal: false, uri: null, superseded: true };

          this.currentPlayUri = null;
          this.currentIsLocal = false;
          const classified = classifyPlaybackError(retryErr || remoteErr, trackIdStr);
          this.networkError = classified.message;
          this.networkStatus = 'error';
          this.lastErrorType = classified.type;
          this._notifyState();
          throw classified;
        }
      }

      if (!isCurrent()) {
        return { isLocal: false, uri: null, superseded: true };
      }

      // Запускаем фоновое кеширование (если не отключено)
      if (!this.bypassCache) {
        this.cache.getOrFetch(trackIdStr, normalizedStreamUrl, { headers: cleanHeaders }).catch((cacheErr) => {
          this._warn(`[Coordinator] Background cache for track ${trackIdStr} failed:`, cacheErr?.message);
        });
      }
    }

    if (!isCurrent()) {
      return { isLocal: false, uri: null, superseded: true };
    }

    // СТАДИЯ 4: Native play
    this._log('[Coordinator][Stage 4: player_play]', {
      trackId: trackIdStr,
      isLocal,
      playUri,
    });

    try {
      await player.play();
    } catch (playErr) {
      if (!isCurrent()) return { isLocal: false, uri: null, superseded: true };

      this.currentPlayUri = null;
      this.currentIsLocal = false;
      const classified = new PlaybackError(playErr?.message || 'Player play failed', {
        type: 'play_error',
        cause: playErr,
        trackId: trackIdStr,
      });
      this.networkError = classified.message;
      this.networkStatus = 'error';
      this.lastErrorType = classified.type;
      this._notifyState();
      throw classified;
    }

    if (!isCurrent()) {
      return { isLocal: false, uri: null, superseded: true };
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
      this._warn('[Coordinator][Stage 5: lock_screen FAILED]', lockErr?.message);
    }

    if (!isCurrent()) {
      return { isLocal: false, uri: null, superseded: true };
    }

    // Сбрасываем ошибку сети при успешном начале воспроизведения
    this.networkError = null;
    this.networkStatus = 'good';
    this.lastErrorType = null;
    this._notifyState();

    return { isLocal, uri: playUri };
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

    // Синхронизируем планировщик
    this.scheduler.syncQueue(currentTrack, this.upNextQueue, options);

    // Обновляем статус следующего трека
    const nextTrack = this.upNextQueue[0];
    const nextId = (nextTrack?.id !== undefined && nextTrack?.id !== null)
      ? nextTrack.id
      : nextTrack?.track_id;

    if (nextId !== undefined && nextId !== null && (nextId !== '' || nextId === 0)) {
      const nextIdStr = String(nextId).trim();
      this.nextTrackStatus = this.scheduler.getStatus(nextIdStr);
      const err = this.scheduler.getError(nextIdStr);
      this.networkError = err?.message || null;
      if (this.nextTrackStatus === TRACK_STATUS.FAILED) {
        this.networkStatus = 'error';
        const classified = classifyPlaybackError(err, nextIdStr);
        this.lastErrorType = classified.type;
      }
    } else {
      this.nextTrackStatus = TRACK_STATUS.IDLE;
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

      const trackId = (track?.id !== undefined && track?.id !== null) ? track.id : track?.track_id;
      if (this.currentTrack) {
        const currentId = (this.currentTrack?.id !== undefined && this.currentTrack?.id !== null)
          ? this.currentTrack.id
          : this.currentTrack?.track_id;
        if (trackId !== undefined && currentId !== undefined && String(trackId).trim() !== String(currentId).trim()) {
          // Трек уже сменился — не перезаписываем экран блокировки устаревшими данными
          return;
        }
      }

      const artworkUrl = track?.coverArt ? resolveCoverUri(track.coverArt, token) : undefined;
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
        }
      );
    } catch (err) {
      this._warn('[Coordinator] Failed to set lock screen controls:', err?.message);
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
    return {
      networkStatus: this.networkStatus,
      nextTrackStatus: this.nextTrackStatus,
      networkError: this.networkError,
      lastErrorType: this.lastErrorType || null,
      isBufferingSlow: this.isBufferingSlow,
    };
  }

  // --- Внутренние методы ---

  _handleSchedulerEvent(event) {
    const nextTrack = this.upNextQueue[0];
    const nextId = (nextTrack?.id !== undefined && nextTrack?.id !== null)
      ? nextTrack.id
      : nextTrack?.track_id;
    if (nextId !== undefined && nextId !== null && String(nextId).trim() === String(event.trackId).trim()) {
      this.nextTrackStatus = event.status;
      if (event.status === TRACK_STATUS.READY) {
        this.networkError = null;
        this.networkStatus = 'good';
        this.lastErrorType = null;
      } else if (event.status === TRACK_STATUS.FAILED) {
        this.networkError = event.error?.message || 'Failed to download';
        this.networkStatus = 'error';
        const classified = classifyPlaybackError(event.error, event.trackId);
        this.lastErrorType = classified.type;
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

  _log(...args) {
    if (this.debug) {
      console.log(...args);
    }
  }

  _warn(...args) {
    if (this.debug) {
      console.warn(...args);
    }
  }

  _error(...args) {
    if (this.debug) {
      console.error(...args);
    }
  }
}

const defaultPlaybackCoordinator = new PlaybackCoordinator();
export default defaultPlaybackCoordinator;
