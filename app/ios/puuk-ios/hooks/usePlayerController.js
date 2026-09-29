import { useState, useCallback, useRef, useEffect } from 'react';
import { Alert } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import { authFetch, SERVER_URL, getAuthHeaders } from '../utils/api';

/**
 * Единое DTO трека для плеера: волна/API отдаёт разные формы (id|track_id),
 * здесь форма нормализуется. Заменяет три дублированных маппинга.
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

/** URL /api/wave/queue с повторяющимися query-параметрами исключений (контракт этапа 2). */
function buildWaveQueueUrl(trackId, { excludeIds = [], queuedIds = [] } = {}) {
  const params = new URLSearchParams();
  params.append('current_track_id', trackId);
  for (const id of capIds(excludeIds)) params.append('exclude_track_ids', id);
  for (const id of capIds(queuedIds)) params.append('queued_track_ids', id);
  return `/api/wave/queue?${params.toString()}`;
}

/** Слияние пачки рекомендаций с буфером без дублей: сначала буфер, потом новая пачка.
 * При переполнении хвост обрезается — первые будущие треки (ближайшие к текущему) сохраняются. */
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

  // Сессия волны: prefetch рекомендаций подмешивает в буфер только в wave-сессии,
  // ручные плейлисты (playTrackList) не загрязняются.
  const isWaveSessionRef = useRef(false);
  // Эпоха очереди: любое обновление очереди инвалидирует in-flight ответы fetchQueue,
  // чтобы поздний wave-ответ не влился в ручной плейлист (race playTrack → playTrackList).
  const queueEpochRef = useRef(0);
  // Защита от двойного перехода (кнопка + авто-advance).
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

  const requestExpandPlayer = useCallback(() => {
    setIsPlayerVisible(true);
    setPlayerExpandToken(prev => prev + 1);
  }, []);

  const loadAndPlay = useCallback(async (track) => {
    const streamUrl = track.stream_url || `${SERVER_URL}/api/stream/${track.id}`;
    // Закрытый режим: JWT передаётся заголовком (expo-audio AudioSource.headers), не в URL
    const headers = await getAuthHeaders();
    player.replace({ uri: streamUrl, headers });
    player.play();

    // Экран блокировки, Пункт управления и Dynamic Island iOS
    try {
      if (typeof player.setActiveForLockScreen === 'function') {
        player.setActiveForLockScreen(
          true,
          {
            title: track.title || 'Unknown Track',
            artist: track.artist || 'Unknown Artist',
            albumTitle: track.album || 'Puuk',
            artworkUrl: track.coverArt,
          },
          {
            isLiveStream: false,
            showSeekForward: true,
            showSeekBackward: true,
          }
        );
      }
    } catch (err) {
      console.warn('Failed to set lock screen controls:', err);
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
      // Слияние вместо замены: остаток буфера сохраняется, дубли невозможны.
      // Ответ инвалидируется, если очередь успела обновиться (сменился режим/трек).
      if (epoch !== queueEpochRef.current) return;
      setUpNextQueue(prev => mergeUniqueQueue(prev, data.map(normalizeTrackDto)));
    } catch (error) {
      if (error.name !== 'AbortError') {
        Alert.alert("Error", "Failed to load queue.");
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
        loadAndPlay(nextTrack);
        setIsLoading(false);

        if (isWaveSessionRef.current && newQueue.length < 3) {
          // Подгружаем пачку по семантике этапа 2:
          // exclude — недавно проигранное (история + текущий),
          // queued — то, что уже стоит в буфере.
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

        // Записываем прослушивание в историю пользователя
        authFetch(`/api/tracks/${nextTrack.id}/history`, { method: 'POST' }).catch(() => {});
      } else {
        // Если очередь пуста, просто останавливаем
        player.pause();
      }
    } finally {
      isAdvancingRef.current = false;
    }
  }, [currentTrack, upNextQueue, player, loadAndPlay, fetchQueue, currentTime, duration]);

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
    // Очередь волны от выбранного трека; играли — исключаем, чтобы не сыпалось назад.
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

  // Переключение лайка / избранного
  const handleToggleLike = useCallback(async (track) => {
    if (!track) return;
    const currentLiked = !!track.is_liked;
    const newLiked = !currentLiked;

    // Оптимистичное обновление состояния
    setCurrentTrack(prev => prev && prev.id === track.id ? { ...prev, is_liked: newLiked } : prev);
    setTracks(prev => prev.map(t => t.id === track.id ? { ...t, is_liked: newLiked } : t));

    try {
      const response = await authFetch(`/api/tracks/${track.id}/like`, {
        method: newLiked ? 'POST' : 'DELETE'
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (err) {
      console.warn("Failed to toggle like:", err);
      // Откат при ошибке
      setCurrentTrack(prev => prev && prev.id === track.id ? { ...prev, is_liked: currentLiked } : prev);
      setTracks(prev => prev.map(t => t.id === track.id ? { ...t, is_liked: currentLiked } : t));
    }
  }, [setTracks]);

  // Запуск "Моей волны" — берём случайный трек и запускаем цепочку рекомендаций
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
      // Новая сессия волны: играли до этого — исключаем.
      fetchQueue(waveTrack.id, undefined, {
        excludeIds: [...history.map(t => t.id), currentTrack?.id],
        queuedIds: [],
      });
      loadAndPlay(waveTrack);
    } catch (error) {
      if (error.name !== 'AbortError') {
        Alert.alert("Error", "Failed to start wave.");
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
  };
}
