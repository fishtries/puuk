import React, { useState, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';

import { ActivityIndicator } from 'react-native';

import FullPlayerModal from './components/FullPlayerModal';
import AddToPlaylistModal from './components/AddToPlaylistModal';
import TrackContextMenuModal from './components/TrackContextMenuModal';
import LoginModal from './components/LoginModal';
import RootNavigator from './navigation/RootNavigator';
import usePlayerController from './hooks/usePlayerController';
import { authFetch, checkAuth, addAuthListener, SERVER_URL, setServerUrl } from './utils/api';
import { loadSettings } from './utils/settings';

export default function App() {
  const [tracks, setTracks] = useState([]);
  const [trackToAdd, setTrackToAdd] = useState(null);
  const [trackToManage, setTrackToManage] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [isAuthChecking, setIsAuthChecking] = useState(true);
  const [isAuthModalVisible, setIsAuthModalVisible] = useState(false);

  const navigationRef = useNavigationContainerRef();

  const {
    player,
    status,
    currentTrack,
    setCurrentTrack,
    isPlaying,
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
  } = usePlayerController({ setTracks });

  // Последовательная инициализация настроек и авторизации при старте приложения
  useEffect(() => {
    let isMounted = true;

    async function initApp() {
      try {
        // 1. Сначала загружаем настройки и применяем сохранённый serverUrl
        const s = await loadSettings();
        if (s?.serverUrl) {
          setServerUrl(s.serverUrl);
        }

        // 2. Проверяем сохранённую сессию и валидируем с сервером
        const user = await checkAuth();
        if (isMounted) {
          if (user) setCurrentUser(user);
          setIsAuthChecking(false);
        }
      } catch (e) {
        console.warn('[App init error]', e);
        if (isMounted) {
          setIsAuthChecking(false);
        }
      }
    }

    initApp();

    const unsubscribe = addAuthListener((user) => {
      if (isMounted) {
        setCurrentUser(user);
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  // Загрузка треков с сервера
  useEffect(() => {
    // Гость не получает каталог: сначала обязательный вход
    if (!currentUser) {
      setTracks([]);
      return;
    }
    const controller = new AbortController();
    const fetchInitialTracks = async () => {
      try {
        const response = await authFetch('/api/tracks', {
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const tracksWithCovers = data.map(t => ({
          ...t,
          coverArt: t.coverArt || `${SERVER_URL}/api/cover/${t.id}`
        }));
        setTracks(tracksWithCovers);
        if (tracksWithCovers.length > 0 && !currentTrack) {
          setCurrentTrack(tracksWithCovers[0]);
        }
      } catch (e) {
        if (e.name !== 'AbortError') {
          console.warn("Fetch tracks error:", e);
        }
      }
    };
    fetchInitialTracks();
    return () => controller.abort();
  }, [currentUser]);

  if (isAuthChecking) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
          <StatusBar style="light" />
          <ActivityIndicator size="large" color="#FA243C" />
        </View>
      </SafeAreaProvider>
    );
  }

  // Закрытый режим: без сессии — только неотключаемое окно входа
  if (!currentUser) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <StatusBar style="light" />
          <LoginModal
            visible
            mandatory
            onClose={() => {}}
            currentUser={currentUser}
            onLoginSuccess={(u) => setCurrentUser(u)}
          />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <StatusBar style="light" />
        <NavigationContainer ref={navigationRef}>
          <RootNavigator
            tracks={tracks}
            isPlaying={isPlaying}
            currentTrack={currentTrack}
            playTrack={playTrack}
            playTrackList={playTrackList}
            startWave={startWave}
            setTrackToManage={setTrackToManage}
            currentUser={currentUser}
            onOpenAuthModal={() => setIsAuthModalVisible(true)}
          />
        </NavigationContainer>

        <FullPlayerModal
          isPlayerVisible={isPlayerVisible}
          playerExpandToken={playerExpandToken}
          onExpand={requestExpandPlayer}
          onClose={() => setIsPlayerVisible(false)}
          currentTrack={currentTrack}
          isPlaying={isPlaying}
          currentTime={status.currentTime}
          duration={status.duration}
          togglePlayPause={togglePlayPause}
          fetchNextTrack={fetchNextTrack}
          playPreviousTrack={playPreviousTrack}
          isLoading={isLoading}
          seekTo={(pos) => player.seekTo(pos)}
          upNextQueue={upNextQueue}
          playTrack={playTrack}
          onAddToPlaylist={() => setTrackToManage(currentTrack)}
          onToggleLike={() => handleToggleLike(currentTrack)}
          isLiked={!!currentTrack?.is_liked}
        />

        <TrackContextMenuModal
          visible={!!trackToManage}
          track={trackToManage}
          onClose={() => setTrackToManage(null)}
          onAddToPlaylist={(track) => setTrackToAdd(track)}
          onEditTrack={(track) => {
             navigationRef.navigate('TrackEdit', { track });
          }}
        />

        <AddToPlaylistModal
          visible={!!trackToAdd}
          track={trackToAdd}
          onClose={() => setTrackToAdd(null)}
        />

        <LoginModal
          visible={isAuthModalVisible}
          onClose={() => setIsAuthModalVisible(false)}
          currentUser={currentUser}
          onLoginSuccess={(u) => setCurrentUser(u)}
        />

      </View>
    </SafeAreaProvider>
  );
}
