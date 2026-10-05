/**
 * Playback Coordinator.
 * Coordinates AudioPlayer (expo-audio), AudioCache, and PreloadScheduler.
 * Implements gapless preload/replace mechanism (Approach A from spike),
 * remote URI fallback, lock screen metadata updates, and network UX status reporting.
 */

import defaultAudioCache from './audioCache';
import defaultPreloadScheduler, { TRACK_STATUS } from './preloadScheduler';
import { resolveCoverUri } from '../components/CoverImage';
import { SERVER_URL, getCachedAuthToken } from './api';

// Native expo-audio preload is disabled because it registers an AVQueuePlayer in the native registry,
// which triggers an NSInvalidArgumentException / HostFunction crash in unpatched iOS binaries.
// Background preloading is handled safely and reliably by PreloadScheduler + AudioCache using local file URIs.
let expoPreloadNative = null;

export const BYPASS_AUDIO_CACHE = false;

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
  const trackId = track.id || track.track_id;
  if (!trackId && trackId !== 0) return '';
  const trackIdStr = String(trackId).trim().replace(/['"]/g, '');

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

  // Не нормализуем слеши глобально: URL уже собран из проверенных частей без дублирования слешей
  return normalized;
}

export class PlaybackCoordinator {
  constructor(options = {}) {
    this.cache = options.cache || defaultAudioCache;
    this.scheduler = options.scheduler || defaultPreloadScheduler;
    this.preloadNative = options.preloadNative || null;
    this.serverUrl = options.serverUrl || SERVER_URL;
    this.bypassCache = options.bypassCache !== undefined ? options.bypassCache : BYPASS_AUDIO_CACHE;

    this.currentTrack = null;
    this.upNextQueue = [];
    this.listeners = new Set();

    this.networkStatus = 'good'; // 'good' | 'slow' | 'error'
    this.nextTrackStatus = TRACK_STATUS.IDLE;
    this.networkError = null;
    this.isBufferingSlow = false;
    this._bufferingTimeout = null;

    // Подписываемся на события планировщика предзагрузки
    this._unsubscribeScheduler = this.scheduler.addListener((event) => {
      this._handleSchedulerEvent(event);
    });
  }

  destroy() {
    if (this._unsubscribeScheduler) {
      this._unsubscribeScheduler();
    }
    if (this._bufferingTimeout) {
      clearTimeout(this._bufferingTimeout);
    }
    this.listeners.clear();
  }

  /**
   * Воспроизводит трек с поэтапной пошаговой диагностикой:
   * 1. Нормализация URL
   * 2. Проверка локального кеша (или bypass)
   * 3. Native replace (local или remote)
   * 4. Native play
   * 5. Обновление метаданных Lock Screen
   *
   * @param {Object} player - Экземпляр AudioPlayer
   * @param {Object} track - DTO трека
   * @param {Object} [options]
   * @param {Record<string, string>} [options.headers]
   * @returns {Promise<{ isLocal: boolean, uri: string }>}
   */
  async play(player, track, options = {}) {
    if (!track?.id && track?.id !== 0) {
      console.warn('[Coordinator] play() called without valid track:', track);
      return { isLocal: false, uri: null };
    }

    this.currentTrack = track;
    const trackIdStr = String(track.id || track.track_id).trim();
    const headers = options.headers || {};
    const headersKeys = Object.keys(headers);

    // СТАДИЯ 1: Нормализация и валидация URL
    const rawStreamUrl = track.stream_url || `${this.serverUrl}/api/stream/${track.id}`;
    const normalizedStreamUrl = normalizeStreamUrl(track, this.serverUrl);

    console.log('[Coordinator][Stage 1: normalize_url]', {
      trackId: trackIdStr,
      rawStreamUrl,
      normalizedStreamUrl,
      serverUrl: this.serverUrl,
    });

    if (!normalizedStreamUrl || (!normalizedStreamUrl.startsWith('http://') && !normalizedStreamUrl.startsWith('https://'))) {
      const urlErr = new Error(`[Coordinator] Invalid stream URL: "${normalizedStreamUrl}" for track ${trackIdStr}`);
      console.error('[Coordinator][Stage 1: normalize_url FAILED]', urlErr);
      throw urlErr;
    }

    // СТАДИЯ 2: Проверка локального кеша
    let localUri = null;
    if (this.bypassCache) {
      console.log('[Coordinator][Stage 2: get_cached_uri] Cache BYPASSED by diagnostic flag');
    } else {
      try {
        localUri = this.cache.getCachedUri(trackIdStr);
        console.log('[Coordinator][Stage 2: get_cached_uri]', {
          trackId: trackIdStr,
          hasLocalUri: Boolean(localUri),
          localUri,
        });
      } catch (cacheErr) {
        console.error('[Coordinator][Stage 2: get_cached_uri FAILED]', {
          trackId: trackIdStr,
          error: cacheErr?.message,
          name: cacheErr?.name,
          stack: cacheErr?.stack,
        });
        localUri = null;
      }
    }

    // СТАДИЯ 3: Замена источника в AudioPlayer (native replace)
    let isLocal = false;
    let playUri = null;

    if (localUri) {
      isLocal = true;
      playUri = localUri;
      console.log('[Coordinator][Stage 3: local_replace]', {
        trackId: trackIdStr,
        localUri,
      });

      try {
        player.replace({ uri: localUri });
      } catch (localErr) {
        console.error('[Coordinator][Stage 3: local_replace FAILED]', {
          trackId: trackIdStr,
          localUri,
          error: localErr?.message,
          name: localErr?.name,
          stack: localErr?.stack,
        });
        isLocal = false;
        playUri = null;
      }
    }

    if (!playUri) {
      isLocal = false;
      playUri = normalizedStreamUrl;
      console.log('[Coordinator][Stage 3: remote_replace]', {
        trackId: trackIdStr,
        normalizedStreamUrl,
        headersKeys,
      });

      const cleanHeaders = {};
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === 'string' && v.trim()) cleanHeaders[k] = v.trim();
      }
      const hasHeaders = Object.keys(cleanHeaders).length > 0;
      const source = hasHeaders
        ? { uri: normalizedStreamUrl, headers: cleanHeaders }
        : { uri: normalizedStreamUrl };

      try {
        player.replace(source);
      } catch (remoteErr) {
        console.error('[Coordinator][Stage 3: remote_replace FAILED]', {
          trackId: trackIdStr,
          normalizedStreamUrl,
          headersKeys,
          error: remoteErr?.message,
          name: remoteErr?.name,
          stack: remoteErr?.stack,
        });

        // Defensive retry: если в нативном реестре остался preloadedPlayer от предыдущей сессии,
        // первый вызов player.replace() извлёк его из словаря. Второй вызов гарантированно пойдёт по ветке replaceCurrentSource!
        console.log('[Coordinator][Stage 3: remote_replace retrying once via replaceCurrentSource...]');
        try {
          player.replace(source);
        } catch (retryErr) {
          console.error('[Coordinator][Stage 3: remote_replace retry FAILED]', retryErr);
          throw remoteErr;
        }
      }

      // Запускаем фоновое кеширование (если не отключено)
      if (!this.bypassCache) {
        this.cache.getOrFetch(trackIdStr, normalizedStreamUrl, { headers }).catch((err) => {
          console.warn(`[Coordinator] Background cache for track ${trackIdStr} failed:`, err?.message);
        });
      }
    }

    // СТАДИЯ 4: Запуск воспроизведения (native play)
    console.log('[Coordinator][Stage 4: player_play]', {
      trackId: trackIdStr,
      isLocal,
      playUri,
    });

    try {
      player.play();
    } catch (playErr) {
      console.error('[Coordinator][Stage 4: player_play FAILED]', {
        trackId: trackIdStr,
        isLocal,
        playUri,
        error: playErr?.message,
        name: playErr?.name,
        stack: playErr?.stack,
      });
      throw playErr;
    }

    // СТАДИЯ 5: Обновление метаданных Lock Screen
    console.log('[Coordinator][Stage 5: lock_screen]', {
      trackId: trackIdStr,
      title: track?.title,
    });

    try {
      this.updateLockScreenMetadata(player, track);
    } catch (lockErr) {
      console.warn('[Coordinator][Stage 5: lock_screen FAILED]', lockErr?.message);
    }

    // Сбрасываем ошибку сети при успешном начале воспроизведения
    this.networkError = null;
    this.networkStatus = 'good';
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
    if (nextTrack?.id) {
      this.nextTrackStatus = this.scheduler.getStatus(nextTrack.id);
      this.networkError = this.scheduler.getError(nextTrack.id)?.message || null;
      if (this.nextTrackStatus === TRACK_STATUS.FAILED) {
        this.networkStatus = 'error';
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
   */
  updateLockScreenMetadata(player, track) {
    if (!player || typeof player.setActiveForLockScreen !== 'function') return;

    try {
      const token = getCachedAuthToken();
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
      console.warn('[Coordinator] Failed to set lock screen controls:', err);
    }
  }

  /**
   * Подписка на изменение сетевых статусов и предзагрузки для UI.
   * @param {Function} listener ({ networkStatus, nextTrackStatus, networkError, isBufferingSlow }) => void
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
      isBufferingSlow: this.isBufferingSlow,
    };
  }

  // --- Внутренние методы ---

  _handleSchedulerEvent(event) {
    const nextTrack = this.upNextQueue[0];
    if (nextTrack && String(nextTrack.id) === String(event.trackId)) {
      this.nextTrackStatus = event.status;
      if (event.status === TRACK_STATUS.READY) {
        this.networkError = null;
        this.networkStatus = 'good';
      } else if (event.status === TRACK_STATUS.FAILED) {
        this.networkError = event.error?.message || 'Failed to download';
        this.networkStatus = 'error';
      }
      this._notifyState();
    }
  }

  _nativePreloadNext(_track, _options = {}) {
    // Disabled: expo-audio native preload registers an AVQueuePlayer in the native registry,
    // which triggers an NSInvalidArgumentException / HostFunction crash in unpatched iOS binaries.
    // Background preloading is handled safely and reliably by PreloadScheduler + AudioCache using local file URIs.
  }

  _notifyState() {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('[Coordinator] listener error:', err);
      }
    }
  }
}

const defaultPlaybackCoordinator = new PlaybackCoordinator();
export default defaultPlaybackCoordinator;
