import { useState, useCallback, useRef, useEffect } from 'react';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import { authFetch, SERVER_URL, getAuthHeaders } from '../utils/api';
import defaultPlaybackCoordinator from '../utils/playbackCoordinator';

/**
 * Единое DTO трека для плеера: волна/API отдаёт разные формы (id|track_id),
 * здесь форма нормализуется.
 */
function normalizeTrackDto(source) {
  const id = source?.id || source?.track_id;
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

function capIds(ids, limit = MAX_EXCLUDE_IDS) {
  const unique = [...new Set(ids.filter(Boolean))];
  return unique.length > limit ? unique.slice(unique.length - limit) : unique;
}

/** URL /api/wave/queue с повторяющимися query-параметрами исключений. */
function buildWaveQueueUrl(trackId, { excludeIds = [], queuedIds = [] } = {}) {
  const params = new URLSearchParams();
  params.append('current_track_id', trackId);
  for (const id of capIds(excludeIds)) params.append('exclude_track_ids', id);
  for (const id of capIds(queuedIds)) params.append('queued_track_ids', id);
  return `/api/wave/queue?${params.toString()}`;
}

/** Слияние пачки рекомендаций с буфером без дублей. */
function mergeUniqueQueue(existing, incoming, maxBuffer = MAX_QUEUE_BUFFER) {
  const seen = new Set(existing.map(t => t.id));
  const merged = [...existing];
  for (const track of incoming) {
    if (!track?.id || seen.has(track.id)) continue;
    seen.add(track.id);
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

  const player = useAudioPlayer();
  const status = useAudioPlayerStatus(player);

  const isPlaying = status.playing;
  const currentTime = status.currentTime || 0;
  const duration = status.duration || 0;

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
    const unsubscribe = defaultPlaybackCoordinator.subscribe(setNetworkUX);
    return unsubscribe;
  }, []);

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
  const loadAndPlay = useCallback(async (track) => {
    try {
      const headers = await getAuthHeaders();
      await defaultPlaybackCoordinator.play(player, track, { headers });
    } catch (e) {
      console.error('[usePlayerController] loadAndPlay error:', {
        message: e?.message,
        name: e?.name,
        stack: e?.stack,
        trackId: track?.id,
        trackTitle: track?.title,
      });
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

      setHistory(newHistory);
      setCurrentTrack(prevTrack);
      loadAndPlay(prevTrack);
    } else {
      player.seekTo(0);
    }
  }, [currentTime, history, currentTrack, upNextQueue, player, loadAndPlay]);

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
        setCurrentTrack(nextTrack);
        await loadAndPlay(nextTrack);
        setIsLoading(false);

        if (isWaveSessionRef.current && newQueue.length < 3) {
          fetchQueue(nextTrack.id, undefined, {
            excludeIds: [...history.map(t => t.id), currentTrack.id],
            queuedIds: newQueue.map(t => t.id),
          });
        }

        // Телеметрия волны: finish при дослушивании, иначе skip
        const trackMs = Math.round((currentTrack.duration || duration || 0) * 1000);
        const listenedMs = Math.round((currentTime || 0) * 1000);
        const eventType = duration > 0 && currentTime >= duration * 0.9 ? 'finish' : 'skip';
        authFetch('/api/wave/feedback', {
          method: 'POST',
          body: {
            track_id: currentTrack.id,
            event_type: eventType,
            listen_duration_ms: listenedMs,
            track_duration_ms: trackMs,
          }
        }).catch(e => console.error("Failed to send wave feedback", e));

        // Записываем прослушивание в историю
        authFetch(`/api/tracks/${nextTrack.id}/history`, { method: 'POST' }).catch(() => {});
      } else {
        player.pause();
      }
    } finally {
      setIsLoading(false);
      isAdvancingRef.current = false;
    }
  }, [currentTrack, upNextQueue, player, loadAndPlay, fetchQueue, currentTime, duration, history]);

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
    if (currentTrack && currentTrack.id !== track.id) {
      setHistory(prev => [...prev, currentTrack].slice(-MAX_HISTORY));
    }
    isWaveSessionRef.current = true;
    setCurrentTrack(track);
    requestExpandPlayer();
    queueEpochRef.current += 1;
    setUpNextQueue([]);
    fetchQueue(track.id, undefined, {
      excludeIds: [...history.map(t => t.id), currentTrack?.id],
      queuedIds: [],
    });
    loadAndPlay(track);
    authFetch(`/api/tracks/${track.id}/history`, { method: 'POST' }).catch(() => {});
  }, [currentTrack, history, requestExpandPlayer, fetchQueue, loadAndPlay]);

  const playTrackList = useCallback((trackList, startIndex = 0) => {
    if (!trackList || trackList.length === 0) return;
    const track = trackList[startIndex];
    const queue = trackList.slice(startIndex + 1);
    if (currentTrack && currentTrack.id !== track.id) {
      setHistory(prev => [...prev, currentTrack].slice(-MAX_HISTORY));
    }
    isWaveSessionRef.current = false;
    setCurrentTrack(track);
    requestExpandPlayer();
    queueEpochRef.current += 1;
    setUpNextQueue(queue);
    loadAndPlay(track);
    authFetch(`/api/tracks/${track.id}/history`, { method: 'POST' }).catch(() => {});
  }, [currentTrack, requestExpandPlayer, loadAndPlay]);

  const handleToggleLike = useCallback(async (track) => {
    if (!track) return;
    const currentLiked = !!track.is_liked;
    const newLiked = !currentLiked;

    setCurrentTrack(prev => prev && prev.id === track.id ? { ...prev, is_liked: newLiked } : prev);
    setTracks(prev => prev.map(t => t.id === track.id ? { ...t, is_liked: newLiked } : t));

    try {
      const response = await authFetch(`/api/tracks/${track.id}/like`, {
        method: newLiked ? 'POST' : 'DELETE'
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (err) {
      console.warn("Failed to toggle like:", err);
      setCurrentTrack(prev => prev && prev.id === track.id ? { ...prev, is_liked: currentLiked } : prev);
      setTracks(prev => prev.map(t => t.id === track.id ? { ...t, is_liked: currentLiked } : t));
    }
  }, [setTracks]);

  const startWave = useCallback(async () => {
    try {
      const response = await authFetch('/api/wave/next?current_track_id=random');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const waveTrack = normalizeTrackDto(data);
      isWaveSessionRef.current = true;
      setCurrentTrack(waveTrack);
      requestExpandPlayer();
      queueEpochRef.current += 1;
      setUpNextQueue([]);
      fetchQueue(waveTrack.id, undefined, {
        excludeIds: [...history.map(t => t.id), currentTrack?.id],
        queuedIds: [],
      });
      loadAndPlay(waveTrack);
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.warn("Failed to start wave:", error.message);
      }
    }
  }, [history, currentTrack, requestExpandPlayer, fetchQueue, loadAndPlay]);

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
