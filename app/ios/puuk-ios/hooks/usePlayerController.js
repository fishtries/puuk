import { useState, useCallback } from 'react';
import { Alert } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { authFetch, SERVER_URL } from '../utils/api';

export default function usePlayerController({ setTracks }) {
  const [currentTrack, setCurrentTrack] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPlayerVisible, setIsPlayerVisible] = useState(false);
  const [playerExpandToken, setPlayerExpandToken] = useState(0);
  const [upNextQueue, setUpNextQueue] = useState([]);
  const [history, setHistory] = useState([]);

  const player = useAudioPlayer();
  const status = useAudioPlayerStatus(player);

  const isPlaying = status.playing;
  const currentTime = status.currentTime || 0;
  const duration = status.duration || 0;

  const requestExpandPlayer = useCallback(() => {
    setIsPlayerVisible(true);
    setPlayerExpandToken(prev => prev + 1);
  }, []);

  const loadAndPlay = useCallback((track) => {
    const streamUrl = track.stream_url || `${SERVER_URL}/api/stream/${track.id}`;
    player.replace(streamUrl);
    player.play();
  }, [player]);

  const fetchQueue = useCallback(async (trackId, signal) => {
    try {
      const response = await authFetch(`/api/wave/queue?current_track_id=${trackId}`, {
        signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const formattedQueue = data.map(t => ({
        id: t.id || t.track_id,
        title: t.title || 'Unknown Track',
        artist: t.artist || 'My Wave',
        bpm: t.bpm || 0,
        stream_url: t.stream_url,
        is_liked: !!t.is_liked,
        coverArt: `${SERVER_URL}/api/cover/${t.id || t.track_id}`
      }));
      setUpNextQueue(formattedQueue);
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
    setIsLoading(true);
    setHistory(prev => [...prev, currentTrack]);

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

      if (newQueue.length < 3) {
        // Подгружаем еще треков, если очередь пустеет
        fetchQueue(nextTrack.id);
      }

      // Отправляем аналитику прослушивания для умной волны
      authFetch('/api/wave/listen', {
        method: 'POST',
        body: { track_id: currentTrack.id, listened_ratio: 1.0 }
      }).catch(e => console.error("Failed to send listen analytic", e));

      // Записываем прослушивание в историю пользователя
      authFetch(`/api/tracks/${nextTrack.id}/history`, { method: 'POST' }).catch(() => {});
    } else {
      // Если очередь пуста, просто останавливаем или играем рандом
      player.pause();
    }
  }, [currentTrack, upNextQueue, player, loadAndPlay, fetchQueue]);

  const handlePreviousTrack = useCallback(() => {
    if (history.length > 0) {
      const prevTrack = history[0];
      setHistory(prev => prev.slice(1));

      // Текущий трек возвращаем в начало очереди
      if (currentTrack) {
        setUpNextQueue(prev => [currentTrack, ...prev]);
      }

      setCurrentTrack(prevTrack);
      loadAndPlay(prevTrack);
      fetchQueue(prevTrack.id);
    } else {
      // Если истории нет, начинаем трек сначала
      player.seekTo(0);
    }
  }, [history, currentTrack, player, loadAndPlay, fetchQueue]);

  const handlePlayTrack = useCallback((track) => {
    // При ручном выборе трека
    if (currentTrack) {
      setHistory(prev => [currentTrack, ...prev].slice(0, 50));
    }
    setCurrentTrack(track);
    loadAndPlay(track);
    // Очищаем очередь и генерируем новую на основе выбранного трека
    setUpNextQueue([]);
    fetchQueue(track.id);
  }, [currentTrack, loadAndPlay, fetchQueue]);

  const handleStartWave = useCallback(async () => {
    // Кнопка плей/пауза для волны на главном экране
    if (currentTrack) {
      if (isPlaying) {
        player.pause();
      } else {
        player.play();
      }
    } else {
      try {
        const response = await authFetch('/api/wave/start');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const waveTrack = await response.json();

        const formattedTrack = {
          id: waveTrack.id || waveTrack.track_id,
          title: waveTrack.title || 'Unknown Track',
          artist: waveTrack.artist || 'My Wave',
          bpm: waveTrack.bpm || 0,
          stream_url: waveTrack.stream_url,
          is_liked: !!waveTrack.is_liked,
          coverArt: `${SERVER_URL}/api/cover/${waveTrack.id || waveTrack.track_id}`
        };

        setCurrentTrack(formattedTrack);
        loadAndPlay(formattedTrack);
        fetchQueue(waveTrack.id);
      } catch (error) {
        Alert.alert("Error", "Failed to start wave.");
      }
    }
  }, [currentTrack, isPlaying, player, loadAndPlay, fetchQueue]);

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
      setHistory(prev => [...prev, currentTrack]);
    }
    setCurrentTrack(track);
    requestExpandPlayer();
    setUpNextQueue([]);
    fetchQueue(track.id);
    loadAndPlay(track);
    authFetch(`/api/tracks/${track.id}/history`, { method: 'POST' }).catch(() => {});
  }, [currentTrack, requestExpandPlayer, fetchQueue, loadAndPlay]);

  const playTrackList = useCallback((trackList, startIndex = 0) => {
    if (!trackList || trackList.length === 0) return;
    const track = trackList[startIndex];
    const queue = trackList.slice(startIndex + 1);
    if (currentTrack && currentTrack.id !== track.id) {
      setHistory(prev => [...prev, currentTrack]);
    }
    setCurrentTrack(track);
    requestExpandPlayer();
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
      const waveTrack = {
        id: data.id || data.track_id,
        title: data.title || 'Unknown Track',
        artist: data.artist || 'My Wave',
        bpm: data.bpm || 0,
        stream_url: data.stream_url,
        coverArt: data.coverArt || `${SERVER_URL}/api/cover/${data.id || data.track_id}`,
        is_liked: !!data.is_liked
      };
      setCurrentTrack(waveTrack);
      requestExpandPlayer();
      setUpNextQueue([]);
      fetchQueue(waveTrack.id);
      loadAndPlay(waveTrack);
    } catch (error) {
      if (error.name !== 'AbortError') {
        Alert.alert("Error", "Failed to start wave.");
      }
    }
  }, [requestExpandPlayer, fetchQueue, loadAndPlay]);

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
    history,
    loadAndPlay,
    fetchQueue,
    playPreviousTrack,
    fetchNextTrack,
    handlePreviousTrack,
    handlePlayTrack,
    handleStartWave,
    togglePlayPause,
    playTrack,
    playTrackList,
    handleToggleLike,
    startWave,
  };
}
