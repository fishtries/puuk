import React, { useState, useEffect, useRef, useCallback } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  FlatList,
  Alert,
  DeviceEventEmitter,
  Platform,
} from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { SymbolView } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import AppHeader from './components/AppHeader';
import FullPlayerModal from './components/FullPlayerModal';
import HomeScreen from './components/HomeScreen';
import SearchScreen from './components/SearchScreen';
import LibraryScreen from './components/LibraryScreen';
import AlbumScreen from './components/AlbumScreen';
import PlaylistScreen from './components/PlaylistScreen';
import AddToPlaylistModal from './components/AddToPlaylistModal';
import TrackContextMenuModal from './components/TrackContextMenuModal';
import TrackEditScreen from './components/TrackEditScreen';
import LoginModal from './components/LoginModal';
import { authFetch, checkAuth, addAuthListener, SERVER_URL, setServerUrl } from './utils/api';
import { getSettings, loadSettings, addSettingsListener } from './utils/settings';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

const MainTabsScreen = React.memo(function MainTabsScreen({
  tracks,
  isPlaying,
  currentTrack,
  playTrack,
  playTrackList,
  startWave,
  setTrackToManage,
  currentUser,
  onOpenAuthModal,
}) {
  const [activeTab, setActiveTab] = useState('Home');
  const [accentColor, setAccentColor] = useState(() => getSettings().accentColor || '#FFDAB9');
  const [hapticsEnabled, setHapticsEnabled] = useState(() => getSettings().hapticsEnabled ?? true);

  useEffect(() => {
    const unsub = addSettingsListener((s) => {
      if (s.accentColor) setAccentColor(s.accentColor);
      if (typeof s.hapticsEnabled === 'boolean') setHapticsEnabled(s.hapticsEnabled);
    });
    return unsub;
  }, []);

  const handleTabPress = useCallback((tabName) => {
    if (hapticsEnabled) {
      Haptics.selectionAsync().catch(() => {});
    }
    if (activeTab === tabName) {
      DeviceEventEmitter.emit(`PUUK_SCROLL_TO_TOP_${tabName.toUpperCase()}`);
    }
    setActiveTab(tabName);
  }, [activeTab, hapticsEnabled]);

  const renderHome = useCallback(
    tabProps => (
      <HomeScreen
        {...tabProps}
        tracks={tracks}
        isPlaying={isPlaying}
        currentTrack={currentTrack}
        onPlayTrack={playTrack}
        onStartWave={startWave}
        onPressEllipsis={setTrackToManage}
        currentUser={currentUser}
        onOpenAuthModal={onOpenAuthModal}
      />
    ),
    [tracks, isPlaying, currentTrack, playTrack, startWave, setTrackToManage, currentUser, onOpenAuthModal]
  );

  const renderSearch = useCallback(
    tabProps => (
      <SearchScreen
        {...tabProps}
        isPlaying={isPlaying}
        currentTrack={currentTrack}
        onPlayTrack={playTrack}
        onAddToPlaylist={setTrackToManage}
        onPressEllipsis={setTrackToManage}
        currentUser={currentUser}
        onOpenAuthModal={onOpenAuthModal}
      />
    ),
    [isPlaying, currentTrack, playTrack, setTrackToManage, currentUser, onOpenAuthModal]
  );

  const renderLibrary = useCallback(
    tabProps => (
      <LibraryScreen
        {...tabProps}
        isPlaying={isPlaying}
        currentTrack={currentTrack}
        onPlayTrack={playTrack}
        onPlayTrackList={playTrackList}
        onPressEllipsis={setTrackToManage}
        currentUser={currentUser}
        onOpenAuthModal={onOpenAuthModal}
      />
    ),
    [isPlaying, currentTrack, playTrack, playTrackList, setTrackToManage, currentUser, onOpenAuthModal]
  );

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: '#000' }}>
        <AppHeader
          activeTab={activeTab}
          currentUser={currentUser}
          onOpenAuthModal={onOpenAuthModal}
          onAddPlaylist={() => DeviceEventEmitter.emit('PUUK_CREATE_PLAYLIST')}
        />
      </SafeAreaView>
      <Tab.Navigator
        screenOptions={{
          lazy: false,
          detachInactiveScreens: false,
          headerShown: false,
          tabBarStyle: {
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            borderTopColor: 'rgba(255, 255, 255, 0.15)',
            borderTopWidth: StyleSheet.hairlineWidth,
            backgroundColor: 'transparent',
            elevation: 0,
          },
          tabBarBackground: () => (
            <View style={StyleSheet.absoluteFill}>
              <BlurView
                tint={Platform.OS === 'ios' ? 'systemChromeMaterialDark' : 'dark'}
                intensity={95}
                style={StyleSheet.absoluteFill}
              />
              <View
                style={[
                  StyleSheet.absoluteFill,
                  { backgroundColor: 'rgba(0, 0, 0, 0.35)' },
                ]}
              />
            </View>
          ),
          tabBarActiveTintColor: accentColor,
          tabBarInactiveTintColor: '#8E8E93',
          tabBarLabelStyle: {
            fontSize: 10,
            fontWeight: '500',
            letterSpacing: 0.12,
            marginBottom: Platform.OS === 'ios' ? 0 : 3,
          },
          tabBarIconStyle: {
            marginTop: 4,
          },
        }}
      >
        <Tab.Screen 
          name="Home" 
          listeners={{
            tabPress: () => handleTabPress('Home'),
            focus: () => setActiveTab('Home'),
          }}
          options={{ 
            tabBarLabel: 'Home', 
            tabBarIcon: ({ focused, color }) => (
              <SymbolView
                name={focused ? 'house.fill' : 'house'}
                size={24}
                tintColor={color}
                fallback={
                  <Ionicons
                    name={focused ? 'home' : 'home-outline'}
                    color={color}
                    size={24}
                  />
                }
              />
            ),
          }}
        >
          {renderHome}
        </Tab.Screen>
        <Tab.Screen 
          name="Search" 
          listeners={{
            tabPress: () => handleTabPress('Search'),
            focus: () => setActiveTab('Search'),
          }}
          options={{ 
            tabBarLabel: 'Search', 
            tabBarIcon: ({ focused, color }) => (
              <SymbolView
                name="magnifyingglass"
                size={24}
                weight={focused ? 'semibold' : 'regular'}
                tintColor={color}
                fallback={
                  <Ionicons
                    name={focused ? 'search' : 'search-outline'}
                    color={color}
                    size={24}
                  />
                }
              />
            ),
          }}
        >
          {renderSearch}
        </Tab.Screen>
        <Tab.Screen 
          name="Library" 
          listeners={{
            tabPress: () => handleTabPress('Library'),
            focus: () => setActiveTab('Library'),
          }}
          options={{ 
            tabBarLabel: 'Library', 
            tabBarIcon: ({ focused, color }) => (
              <SymbolView
                name={focused ? 'square.stack.fill' : 'square.stack'}
                size={24}
                tintColor={color}
                fallback={
                  <Ionicons
                    name={focused ? 'albums' : 'albums-outline'}
                    color={color}
                    size={24}
                  />
                }
              />
            ),
          }}
        >
          {renderLibrary}
        </Tab.Screen>
      </Tab.Navigator>
    </View>
  );
});

export default function App() {
  const [tracks, setTracks] = useState([]);
  const [currentTrack, setCurrentTrack] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPlayerVisible, setIsPlayerVisible] = useState(false);
  const [playerExpandToken, setPlayerExpandToken] = useState(0);

  const requestExpandPlayer = useCallback(() => {
    setIsPlayerVisible(true);
    setPlayerExpandToken(prev => prev + 1);
  }, []);

  const [upNextQueue, setUpNextQueue] = useState([]);
  const [history, setHistory] = useState([]);
  const [trackToAdd, setTrackToAdd] = useState(null);
  const [trackToManage, setTrackToManage] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [isAuthModalVisible, setIsAuthModalVisible] = useState(false);
  
  const navigationRef = useNavigationContainerRef();

  // --- Audio Logic ---
  const player = useAudioPlayer();
  const status = useAudioPlayerStatus(player);

  const isPlaying = status.playing;
  const currentTime = status.currentTime || 0;
  const duration = status.duration || 0;

  // Инициализация настроек
  useEffect(() => {
    loadSettings().then(s => {
      if (s.serverUrl) setServerUrl(s.serverUrl);
    });
  }, []);

  // Инициализация авторизации
  useEffect(() => {
    checkAuth().then(user => {
      if (user) setCurrentUser(user);
    });
    const unsubscribe = addAuthListener(user => {
      setCurrentUser(user);
    });
    return unsubscribe;
  }, []);

  // Загрузка треков с сервера
  useEffect(() => {
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

  // Воспроизведение аудио
  const loadAndPlay = (track) => {
    const streamUrl = track.stream_url || `${SERVER_URL}/api/stream/${track.id}`;
    player.replace(streamUrl);
    player.play();
  };

  const fetchQueue = async (trackId, signal) => {
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
  };

  const playPreviousTrack = () => {
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
  };

  const fetchNextTrack = async () => {
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
  };

  const handlePreviousTrack = () => {
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
  };

  const handlePlayTrack = (track) => {
    // При ручном выборе трека
    if (currentTrack) {
      setHistory(prev => [currentTrack, ...prev].slice(0, 50));
    }
    setCurrentTrack(track);
    loadAndPlay(track);
    // Очищаем очередь и генерируем новую на основе выбранного трека
    setUpNextQueue([]);
    fetchQueue(track.id);
  };

  const handleStartWave = async () => {
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
  };

  const togglePlayPause = () => {
    if (isPlaying) {
      player.pause();
    } else {
      if (!currentTime && currentTrack) {
        loadAndPlay(currentTrack);
      } else {
        player.play();
      }
    }
  };

  const playTrack = (track) => {
    if (currentTrack && currentTrack.id !== track.id) {
      setHistory(prev => [...prev, currentTrack]);
    }
    setCurrentTrack(track);
    requestExpandPlayer();
    setUpNextQueue([]);
    fetchQueue(track.id);
    loadAndPlay(track);
    authFetch(`/api/tracks/${track.id}/history`, { method: 'POST' }).catch(() => {});
  };

  const playTrackList = (trackList, startIndex = 0) => {
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
  };

  // Переключение лайка / избранного
  const handleToggleLike = async (track) => {
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
  };

  // Запуск "Моей волны" — берём случайный трек и запускаем цепочку рекомендаций
  const startWave = async () => {
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
  };

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <StatusBar style="light" />
        <NavigationContainer ref={navigationRef}>
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="MainTabs">
              {props => (
                <MainTabsScreen
                  {...props}
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
              )}
            </Stack.Screen>
            <Stack.Screen name="Album">
              {props => <AlbumScreen {...props} onPlayTrack={playTrack} onPressEllipsis={(track) => setTrackToManage(track)} />}
            </Stack.Screen>
            <Stack.Screen name="Playlist">
              {props => <PlaylistScreen {...props} onPlayTrack={playTrack} />}
            </Stack.Screen>
            <Stack.Screen name="TrackEdit" component={TrackEditScreen} />
          </Stack.Navigator>
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

const styles = StyleSheet.create({
  mainContainer: {
    flex: 1,
    backgroundColor: '#000000',
  },
  emptyStateText: {
    color: '#8e8e93',
    fontSize: 16,
    marginTop: 15,
  },
});
