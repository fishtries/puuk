import { useState, useCallback, useRef, useEffect } from 'react';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import {
  authFetch,
  SERVER_URL,
  getAuthHeaders,
  getCachedAuthHeaders,
  getCachedUser,
  addAuthListener,
  getSavedUser,
  isRetryableStatus,
  isNetworkError,
  ApiError,
} from '../utils/api';
import defaultPlaybackCoordinator from '../utils/playbackCoordinator';
import { clearSavedLastTrack } from '../utils/settings';

/**
 * Единое DTO трека для плеера: волна/API отдаёт разные формы (id|track_id),
 * здесь форма нормализуется.
 */
export function normalizeTrackDto(source) {
  const id = (source?.id !== undefined && source?.id !== null)
    ? source.id
    : source?.track_id;
  return {
    id,
    title: source?.title || 'Unknown Track',
    artist: source?.artist || 'My Wave',
    bpm: source?.bpm || 0,
    stream_url: source?.stream_url,
    is_liked: !!source?.is_liked,
    coverArt: source?.coverArt || `${SERVER_URL}/api/cover/${id}`,
  };
}

// Паритет с backend MAX_EXCLUDE_IDS: длиннее список клиент не передает.
const MAX_EXCLUDE_IDS = 100;
// Ограничение будущего буфера волны и истории сессии.
const MAX_QUEUE_BUFFER = 20;
const MAX_HISTORY = 50;
const HISTORY_COOLDOWN_MS = 30000;

function capIds(ids, limit = MAX_EXCLUDE_IDS) {
  const valid = ids.filter(id => id !== undefined && id !== null && id !== '');
  const unique = [...new Set(valid)];
  return unique.length > limit ? unique.slice(unique.length - limit) : unique;
}

/** URL /api/wave/queue с повторяющимися query-параметрами исключений. */
function buildWaveQueueUrl(trackId, { excludeIds = [], queuedIds = [] } = {}) {
  const params = new URLSearchParams();
  if (trackId !== undefined && trackId !== null) {
    params.append('current_track_id', String(trackId));
  }
  for (const id of capIds(excludeIds)) params.append('exclude_track_ids', String(id));
  for (const id of capIds(queuedIds)) params.append('queued_track_ids', String(id));
  return `/api/wave/queue?${params.toString()}`;
}

/** Слияние пачки рекомендаций с буфером без дублей. */
function mergeUniqueQueue(existing, incoming, maxBuffer = MAX_QUEUE_BUFFER) {
  const seen = new Set(existing.map(t => (t?.id !== undefined && t?.id !== null ? t.id : t?.track_id)));
  const merged = [...existing];
  for (const track of incoming) {
    const trackId = track?.id !== undefined && track?.id !== null ? track.id : track?.track_id;
    if (trackId === undefined || trackId === null || seen.has(trackId)) continue;
    seen.add(trackId);
    merged.push(track);
  }
  return merged.length > maxBuffer ? merged.slice(0, maxBuffer) : merged;
}

export default function usePlayerController({ setTracks }) {
  const [currentTrack, setCurrentTrack] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPlayerVisible, setIsPlayerVisible] = useState(false);
  const [playerExpandToken, setPlayerExpandToken] = useState(0);
  const [upNextQueue, setUpNextQueue] = useState([]);
  const [history, setHistory] = useState([]);

  // Состояние сети и предзагрузки для Network UX
  const [networkUX, setNetworkUX] = useState(defaultPlaybackCoordinator.getState());

  // Сессия волны: prefetch рекомендаций подмешивает в буфер только в wave-сессии
  const isWaveSessionRef = useRef(false);
  // Эпоха очереди: инвалидирует in-flight ответы fetchQueue
  const queueEpochRef = useRef(0);
  // Защита от двойного перехода
  const isAdvancingRef = useRef(false);

  // Дедупликация истории (30с кулдаун) и буфер повторов фоновых событий
  // Дедупликация истории (user_id + session + track_id + event) и буфер повторов фоновых событий
  const recentHistoryRef = useRef(new Map());
  const pendingBackgroundEventsRef = useRef([]);
  const isFlushingBackgroundEventsRef = useRef(false);
  const currentTrackRef = useRef(null);
  const initialUser = typeof getCachedUser === 'function' ? getCachedUser() : null;
  const currentUserIdRef = useRef(initialUser ? String(initialUser.id || initialUser.user_id || initialUser.username || 'user') : 'anonymous');
  const sessionIdRef = useRef('sess_' + Math.random().toString(36).slice(2, 9));
  const retryTimerRef = useRef(null);
  const flushPendingBackgroundEventsRef = useRef(null);
  const authEpochRef = useRef(0);
  const authAbortControllerRef = useRef(null);
  const authReadyRef = useRef(Boolean(initialUser));
  const pendingHistoryRef = useRef([]);
  const recordTrackHistoryRef = useRef(null);

  const player = useAudioPlayer();
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    currentTrackRef.current = currentTrack;
  }, [currentTrack]);

  const isPlaying = status.playing;
  const currentTime = status.currentTime || 0;
  const duration = status.duration || 0;

  // Отслеживание смены пользователя: сброс дедупликации и таймеров повтора
  useEffect(() => {
    let isMounted = true;
    const resetAuthScopedState = (user, { preservePendingHistory = false } = {}) => {
      const newUserId = user
        ? String(user.id || user.user_id || user.username || 'user')
        : 'anonymous';
      if (currentUserIdRef.current === newUserId && authReadyRef.current) return;

      currentUserIdRef.current = newUserId;
      authReadyRef.current = true;
      authEpochRef.current += 1;
      recentHistoryRef.current.clear();
      pendingBackgroundEventsRef.current = [];
      if (!preservePendingHistory) {
        pendingHistoryRef.current = [];
      }
      authAbortControllerRef.current?.abort();
      authAbortControllerRef.current = null;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    if (typeof getSavedUser === 'function') {
      try {
        const res = getSavedUser();
        if (res && typeof res.then === 'function') {
          res.then(user => {
            if (isMounted) {
              resetAuthScopedState(user, { preservePendingHistory: !authReadyRef.current });
              const pending = pendingHistoryRef.current;
              pendingHistoryRef.current = [];
              for (const item of pending) {
                recordTrackHistoryRef.current?.(item.trackId, item.event);
              }
            }
          }).catch(() => {});
        } else if (isMounted) {
          authReadyRef.current = true;
        }
      } catch {
        authReadyRef.current = true;
      }
    } else {
      authReadyRef.current = true;
    }

    const unsubscribe = typeof addAuthListener === 'function'
      ? addAuthListener((user) => {
          resetAuthScopedState(user);
        })
      : () => {};

    return () => {
      isMounted = false;
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      authAbortControllerRef.current?.abort();
    };
  }, []);

  const isRetryableError = (err, status = null) => {
    if (status !== null && status !== undefined) {
      return isRetryableStatus(status);
    }
    if (!err) return false;
    if (err.name === 'AbortError') return false;
    if (err.status && !isRetryableStatus(err.status)) return false;
    if (err.isTimeout || err.name === 'TimeoutError' || err.type === 'timeout') return true;
    if (err.isNetwork || isNetworkError(err)) return true;
    if (err.status && isRetryableStatus(err.status)) return true;
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('network') || msg.includes('timeout') || msg.includes('fetch failed')) {
      return true;
    }
    return false;
  };

  const scheduleFlush = useCallback((delayMs = 5000) => {
    if (retryTimerRef.current) return;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      flushPendingBackgroundEventsRef.current?.();
    }, delayMs);
  }, []);

  // Очистка и повтор фоновых событий при восстановлении сети или по таймеру
  const flushPendingBackgroundEvents = useCallback(async () => {
    if (isFlushingBackgroundEventsRef.current) return;
    if (pendingBackgroundEventsRef.current.length === 0) return;

    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    isFlushingBackgroundEventsRef.current = true;
    let hasFailedEvents = false;
    const flushEpoch = authEpochRef.current;
    const flushController = new AbortController();
    authAbortControllerRef.current = flushController;

    try {
      const events = [...pendingBackgroundEventsRef.current];
      pendingBackgroundEventsRef.current = [];

      const now = Date.now();
      for (const event of events) {
        if (flushEpoch !== authEpochRef.current || event.authEpoch !== flushEpoch) {
          continue;
        }
        if (now - event.timestamp > 10 * 60 * 1000 || event.attempts >= 3) {
          continue;
        }
        try {
          const options = {
            method: 'POST',
            retry: 0,
            background: true,
            signal: flushController.signal,
          };
          if (event.body) {
            options.body = event.body;
          }
          const res = await authFetch(event.url, options);
          if (flushEpoch !== authEpochRef.current) continue;
          if (!res.ok) {
            if (isRetryableStatus(res.status)) {
              throw new ApiError(`HTTP ${res.status}`, { status: res.status });
            } else {
              console.warn(`[usePlayerController] Background event permanent HTTP ${res.status} on retry (${event.url})`);
              continue;
            }
          }
        } catch (retryErr) {
          if (flushEpoch !== authEpochRef.current || retryErr?.name === 'AbortError') {
            continue;
          }
          if (isRetryableError(retryErr, retryErr?.status)) {
            event.attempts += 1;
            if (event.attempts < 3 && event.authEpoch === authEpochRef.current) {
              pendingBackgroundEventsRef.current.push(event);
              hasFailedEvents = true;
            }
          }
        }
      }
    } finally {
      isFlushingBackgroundEventsRef.current = false;
      if (authAbortControllerRef.current === flushController) {
        authAbortControllerRef.current = null;
      }
      if (hasFailedEvents && pendingBackgroundEventsRef.current.length > 0) {
        scheduleFlush(10000);
      }
    }
  }, [scheduleFlush]);

  useEffect(() => {
    flushPendingBackgroundEventsRef.current = flushPendingBackgroundEvents;
  }, [flushPendingBackgroundEvents]);

  const sendBackgroundEvent = useCallback(async (url, body = null) => {
    const options = {
      method: 'POST',
      retry: 1,
      background: true,
    };
    if (body) {
      options.body = body;
    }

    try {
      const response = await authFetch(url, options);
      if (!response.ok) {
        if (isRetryableStatus(response.status)) {
          throw new ApiError(`HTTP ${response.status}`, {
            status: response.status,
            type: response.status >= 500 ? 'server' : 'transient_http',
          });
        } else {
          console.warn(`[usePlayerController] Background event permanent HTTP ${response.status} (${url})`);
          return;
        }
      }
    } catch (err) {
      console.warn(`[usePlayerController] Background event failed (${url}):`, err?.message || err);
      if (isRetryableError(err, err?.status)) {
        const authEpoch = authEpochRef.current;
        if (pendingBackgroundEventsRef.current.length < 50) {
          pendingBackgroundEventsRef.current.push({
            url,
            body,
            timestamp: Date.now(),
            attempts: 1,
            authEpoch,
          });
        }
        scheduleFlush(5000);
      }
    }
  }, [scheduleFlush]);

  const recordTrackHistory = useCallback((trackId, event = 'listen') => {
    if (trackId === undefined || trackId === null || (trackId === '' && trackId !== 0)) return;
    if (!authReadyRef.current) {
      pendingHistoryRef.current.push({ trackId, event });
      return;
    }
    const idStr = String(trackId);
    const userId = currentUserIdRef.current || 'anonymous';
    const sessionId = sessionIdRef.current || 'default';
    const dedupKey = `${userId}:${sessionId}:${idStr}:${event}`;

    const now = Date.now();
    const lastRecorded = recentHistoryRef.current.get(dedupKey);
    if (lastRecorded && (now - lastRecorded) < HISTORY_COOLDOWN_MS) {
      return;
    }
    recentHistoryRef.current.set(dedupKey, now);

    if (recentHistoryRef.current.size > 200) {
      for (const [k, timestamp] of recentHistoryRef.current.entries()) {
        if (now - timestamp > HISTORY_COOLDOWN_MS) {
          recentHistoryRef.current.delete(k);
        }
      }
    }

    sendBackgroundEvent(`/api/tracks/${encodeURIComponent(idStr)}/history`, null);
  }, [sendBackgroundEvent]);

  useEffect(() => {
    recordTrackHistoryRef.current = recordTrackHistory;
  }, [recordTrackHistory]);

  // Конфигурация фонового воспроизведения и системной аудиосессии iOS
  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).catch(err => {
      console.warn('Failed to configure audio mode:', err);
    });
  }, []);

  // Подписка на состояние координатора (сеть, предзагрузка)
  useEffect(() => {
    const unsubscribe = defaultPlaybackCoordinator.subscribe((state) => {
      setNetworkUX(state);
      if (state?.networkStatus === 'good' && pendingBackgroundEventsRef.current.length > 0) {
        flushPendingBackgroundEvents();
      }
    });
    return unsubscribe;
  }, [flushPendingBackgroundEvents]);

  // Отслеживание медленной буферизации
  useEffect(() => {
    defaultPlaybackCoordinator.handleBufferingStatus(Boolean(status?.isBuffering));
  }, [status?.isBuffering]);

  // Синхронизация очереди с координатором и планировщиком предзагрузки
  useEffect(() => {
    let isMounted = true;
    getAuthHeaders()
      .then(headers => {
        if (isMounted) {
          defaultPlaybackCoordinator.updateQueue(currentTrack, upNextQueue, { headers });
        }
      })
      .catch(() => {
        if (isMounted) {
          defaultPlaybackCoordinator.updateQueue(currentTrack, upNextQueue, {});
        }
      });

    return () => {
      isMounted = false;
    };
  }, [currentTrack, upNextQueue]);

  const requestExpandPlayer = useCallback(() => {
    setIsPlayerVisible(true);
    setPlayerExpandToken(prev => prev + 1);
  }, []);

  /** Делегируем воспроизведение координатору */
  const loadAndPlay = useCallback((track) => {
    const reportPlaybackError = (error) => {
      console.error('[usePlayerController] loadAndPlay error:', {
        message: error?.message,
        name: error?.name,
        type: error?.type,
        trackId: track?.id ?? track?.track_id,
        trackTitle: track?.title,
      });
    };

    try {
      const cached = typeof getCachedAuthHeaders === 'function' ? getCachedAuthHeaders() : null;
      const playbackPromise = defaultPlaybackCoordinator.play(player, track, {
        headers: cached || undefined,
        getHeadersAsync: getAuthHeaders,
      });
      return Promise.resolve(playbackPromise).catch((error) => {
        reportPlaybackError(error);
        return { isLocal: false, uri: null, error };
      });
    } catch (e) {
      reportPlaybackError(e);
      return Promise.resolve({ isLocal: false, uri: null, error: e });
    }
  }, [player]);

  const fetchQueue = useCallback(async (trackId, signal, exclusions) => {
    const epoch = queueEpochRef.current;
    try {
      const response = await authFetch(buildWaveQueueUrl(trackId, exclusions), {
        signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (epoch !== queueEpochRef.current) return;
      setUpNextQueue(prev => mergeUniqueQueue(prev, data.map(normalizeTrackDto)));
    } catch (error) {
      if (error.name !== 'AbortError') {
        // Не спамим Alert, ошибка видна в UI-баннере
        console.warn('Failed to load queue:', error.message);
      }
    }
  }, []);

  const playPreviousTrack = useCallback(() => {
    if (currentTime > 3) {
      player.seekTo(0);
      return;
    }

    if (history.length > 0) {
      const newHistory = [...history];
      const prevTrack = newHistory.pop();

      if (currentTrack) {
        setUpNextQueue([currentTrack, ...upNextQueue]);
      }

      currentTrackRef.current = prevTrack;
      setHistory(newHistory);
      setCurrentTrack(prevTrack);
      loadAndPlay(prevTrack);
      const prevTrackId = (prevTrack?.id !== undefined && prevTrack?.id !== null) ? prevTrack.id : prevTrack?.track_id;
      recordTrackHistory(prevTrackId);
    } else {
      player.seekTo(0);
    }
  }, [currentTime, history, currentTrack, upNextQueue, player, loadAndPlay, recordTrackHistory]);

  const fetchNextTrack = useCallback(async () => {
    if (!currentTrack) return;
    if (isAdvancingRef.current) return;
    isAdvancingRef.current = true;

    try {
      setIsLoading(true);
      setHistory(prev => [...prev, currentTrack].slice(-MAX_HISTORY));

      let nextTrack;
      let newQueue = [...upNextQueue];

      if (newQueue.length > 0) {
        nextTrack = newQueue.shift();
        setUpNextQueue(newQueue);
      }

      if (nextTrack) {
        const nextTrackId = (nextTrack.id !== undefined && nextTrack.id !== null) ? nextTrack.id : nextTrack.track_id;
        const currentTrackId = (currentTrack.id !== undefined && currentTrack.id !== null) ? currentTrack.id : currentTrack.track_id;

        currentTrackRef.current = nextTrack;
        setCurrentTrack(nextTrack);
        const playPromise = loadAndPlay(nextTrack);

        if (isWaveSessionRef.current && newQueue.length < 3) {
          fetchQueue(nextTrackId, undefined, {
            excludeIds: [...history.map(t => (t?.id !== undefined && t?.id !== null ? t.id : t?.track_id)), currentTrackId],
            queuedIds: newQueue.map(t => (t?.id !== undefined && t?.id !== null ? t.id : t?.track_id)),
          });
        }

        // Телеметрия волны: finish при дослушивании, иначе skip
        const trackMs = Math.round((currentTrack.duration || duration || 0) * 1000);
        const listenedMs = Math.round((currentTime || 0) * 1000);
        const eventType = duration > 0 && currentTime >= duration * 0.9 ? 'finish' : 'skip';
        sendBackgroundEvent('/api/wave/feedback', {
          track_id: currentTrackId,
          event_type: eventType,
          listen_duration_ms: listenedMs,
          track_duration_ms: trackMs,
        });

        // Записываем прослушивание в историю
        recordTrackHistory(nextTrackId);

        await playPromise;
      } else {
        player.pause();
      }
    } finally {
      setIsLoading(false);
      isAdvancingRef.current = false;
    }
  }, [currentTrack, upNextQueue, player, loadAndPlay, fetchQueue, currentTime, duration, history, sendBackgroundEvent, recordTrackHistory]);

  const fetchNextTrackRef = useRef(fetchNextTrack);
  const playPreviousTrackRef = useRef(playPreviousTrack);

  useEffect(() => {
    fetchNextTrackRef.current = fetchNextTrack;
  }, [fetchNextTrack]);

  useEffect(() => {
    playPreviousTrackRef.current = playPreviousTrack;
  }, [playPreviousTrack]);

  // Слушатель команд экрана блокировки, Control Center и гарнитур
  useEffect(() => {
    if (!player || typeof player.addListener !== 'function') return;

    const nextSub = player.addListener('nextTrack', () => {
      fetchNextTrackRef.current?.();
    });

    const prevSub = player.addListener('previousTrack', () => {
      playPreviousTrackRef.current?.();
    });

    return () => {
      nextSub?.remove?.();
      prevSub?.remove?.();
    };
  }, [player]);

  // Автоматический переход к следующему треку по окончании воспроизведения
  useEffect(() => {
    if (status?.didJustFinish) {
      fetchNextTrackRef.current?.();
    }
  }, [status?.didJustFinish]);

  const togglePlayPause = useCallback(() => {
    if (isPlaying) {
      player.pause();
    } else {
      if (!currentTime && currentTrack) {
        loadAndPlay(currentTrack);
      } else {
        player.play();
      }
    }
  }, [isPlaying, currentTime, currentTrack, player, loadAndPlay]);

  const playTrack = useCallback((track) => {
    if (!track) return;
    const trackId = (track.id !== undefined && track.id !== null) ? track.id : track.track_id;
    const activeTrack = currentTrackRef.current || currentTrack;
    const currentId = (activeTrack?.id !== undefined && activeTrack?.id !== null) ? activeTrack.id : activeTrack?.track_id;

    if (activeTrack && currentId !== trackId) {
      setHistory(prev => [...prev, activeTrack].slice(-MAX_HISTORY));
    }
    if (!activeTrack || currentId !== trackId) {
      sessionIdRef.current = 'track_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    }
    currentTrackRef.current = track;
    isWaveSessionRef.current = true;
    setCurrentTrack(track);
    loadAndPlay(track);
    // Инвалидируем ответы старой очереди до запуска нового запроса.
    // Иначе fetchQueue захватит уже устаревшую эпоху и сможет примешать
    // старый ответ к новой сессии воспроизведения.
    queueEpochRef.current += 1;
    setUpNextQueue([]);
    fetchQueue(trackId, undefined, {
      excludeIds: [...history.map(t => (t?.id !== undefined && t?.id !== null ? t.id : t?.track_id)), currentId],
      queuedIds: [],
    });
    recordTrackHistory(trackId);
  }, [currentTrack, history, fetchQueue, loadAndPlay, recordTrackHistory]);

  const playTrackList = useCallback((trackList, startIndex = 0) => {
    if (!trackList || trackList.length === 0) return;
    const track = trackList[startIndex];
    const trackId = (track?.id !== undefined && track?.id !== null) ? track.id : track?.track_id;
    const activeTrack = currentTrackRef.current || currentTrack;
    const currentId = (activeTrack?.id !== undefined && activeTrack?.id !== null) ? activeTrack.id : activeTrack?.track_id;
    const queue = trackList.slice(startIndex + 1);

    if (activeTrack && currentId !== trackId) {
      setHistory(prev => [...prev, activeTrack].slice(-MAX_HISTORY));
    }
    sessionIdRef.current = 'list_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    currentTrackRef.current = track;
    isWaveSessionRef.current = false;
    setCurrentTrack(track);
    loadAndPlay(track);
    // Ручной плейлист также инвалидирует in-flight wave queue response.
    queueEpochRef.current += 1;
    setUpNextQueue(queue);
    recordTrackHistory(trackId);
  }, [currentTrack, loadAndPlay, recordTrackHistory]);

  const handleToggleLike = useCallback(async (track) => {
    if (!track) return;
    const trackId = (track.id !== undefined && track.id !== null) ? track.id : track.track_id;
    const currentLiked = !!track.is_liked;
    const newLiked = !currentLiked;

    setCurrentTrack(prev => {
      const prevId = (prev?.id !== undefined && prev?.id !== null) ? prev.id : prev?.track_id;
      return prev && prevId === trackId ? { ...prev, is_liked: newLiked } : prev;
    });
    setTracks(prev => prev.map(t => {
      const tId = (t?.id !== undefined && t?.id !== null) ? t.id : t?.track_id;
      return tId === trackId ? { ...t, is_liked: newLiked } : t;
    }));

    try {
      const response = await authFetch(`/api/tracks/${encodeURIComponent(trackId)}/like`, {
        method: newLiked ? 'POST' : 'DELETE'
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (err) {
      console.warn("Failed to toggle like:", err);
      setCurrentTrack(prev => {
        const prevId = (prev?.id !== undefined && prev?.id !== null) ? prev.id : prev?.track_id;
        return prev && prevId === trackId ? { ...prev, is_liked: currentLiked } : prev;
      });
      setTracks(prev => prev.map(t => {
        const tId = (t?.id !== undefined && t?.id !== null) ? t.id : t?.track_id;
        return tId === trackId ? { ...t, is_liked: currentLiked } : t;
      }));
    }
  }, [setTracks]);

  const startWave = useCallback(async () => {
    try {
      const response = await authFetch('/api/wave/next?current_track_id=random');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const waveTrack = normalizeTrackDto(data);
      const waveTrackId = (waveTrack.id !== undefined && waveTrack.id !== null) ? waveTrack.id : waveTrack.track_id;
      const currentTrackId = (currentTrack?.id !== undefined && currentTrack?.id !== null) ? currentTrack.id : currentTrack?.track_id;

      sessionIdRef.current = 'wave_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
      currentTrackRef.current = waveTrack;
      isWaveSessionRef.current = true;
      setCurrentTrack(waveTrack);
      loadAndPlay(waveTrack);
      queueEpochRef.current += 1;
      setUpNextQueue([]);
      fetchQueue(waveTrackId, undefined, {
        excludeIds: [...history.map(t => (t?.id !== undefined && t?.id !== null ? t.id : t?.track_id)), currentTrackId],
        queuedIds: [],
      });
      recordTrackHistory(waveTrackId);
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.warn("Failed to start wave:", error.message);
      }
    }
  }, [history, currentTrack, fetchQueue, loadAndPlay, recordTrackHistory]);

  const dismissPlayer = useCallback(async () => {
    try {
      player.pause();
    } catch (e) {
      console.warn('[usePlayerController] dismissPlayer pause error:', e);
    }
    try {
      if (typeof player.setActiveForLockScreen === 'function') {
        player.setActiveForLockScreen(false);
      }
    } catch (e) {
      console.warn('[usePlayerController] dismissPlayer lock screen error:', e);
    }
    isWaveSessionRef.current = false;
    currentTrackRef.current = null;
    setCurrentTrack(null);
    setUpNextQueue([]);
    setIsPlayerVisible(false);
    defaultPlaybackCoordinator.updateQueue(null, []);
    try {
      await clearSavedLastTrack();
    } catch (e) {
      console.warn('[usePlayerController] dismissPlayer clear storage error:', e);
    }
  }, [player]);

  return {
    player,
    status,
    currentTrack,
    setCurrentTrack,
    isPlaying,
    currentTime,
    duration,
    isLoading,
    isPlayerVisible,
    setIsPlayerVisible,
    playerExpandToken,
    requestExpandPlayer,
    upNextQueue,
    playPreviousTrack,
    fetchNextTrack,
    togglePlayPause,
    playTrack,
    playTrackList,
    handleToggleLike,
    startWave,
    dismissPlayer,
    // Network UX & Cache state (Agent 5 & 6)
    networkStatus: networkUX.networkStatus,
    nextTrackStatus: networkUX.nextTrackStatus,
    networkError: networkUX.networkError,
    isBufferingSlow: networkUX.isBufferingSlow,
    retryPreload: () => {
      getAuthHeaders().then(headers => {
        defaultPlaybackCoordinator.updateQueue(currentTrack, upNextQueue, { headers });
      });
    },
    skipToNext: fetchNextTrack,
  };
}
