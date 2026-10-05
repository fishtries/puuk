import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  View,
  Dimensions,
  StyleSheet,
  Text,
  TouchableOpacity,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets, initialWindowMetrics } from 'react-native-safe-area-context';
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation,
  Easing,
} from 'react-native-reanimated';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';

import FullPlayerModal from './components/FullPlayerModal';
import MiniPlayerBar from './components/fullplayer/MiniPlayerBar';
import GlowTrackBoundary from './components/fullplayer/GlowTrackBoundary';
import AddToPlaylistModal from './components/AddToPlaylistModal';
import TrackContextMenuModal from './components/TrackContextMenuModal';
import LoginModal from './components/LoginModal';
import RootNavigator from './navigation/RootNavigator';
import usePlayerController from './hooks/usePlayerController';
import { authFetch, checkAuth, addAuthListener, SERVER_URL, setServerUrl } from './utils/api';
import { loadSettings, getSavedLastTrack, setSavedLastTrack, getSettings, addSettingsListener } from './utils/settings';

const { height } = Dimensions.get('window');

function AppContent() {
  const insets = useSafeAreaInsets();
  const [tracks, setTracks] = useState([]);
  const [trackToAdd, setTrackToAdd] = useState(null);
  const [trackToManage, setTrackToManage] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [isAuthChecking, setIsAuthChecking] = useState(true);
  const [isAuthModalVisible, setIsAuthModalVisible] = useState(false);
  const [accentColor, setAccentColor] = useState(() => getSettings().accentColor || '#FFDAB9');

  useEffect(() => {
    const unsub = addSettingsListener((s) => {
      if (s.accentColor) setAccentColor(s.accentColor);
    });
    return unsub;
  }, []);

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

  const fallbackTrack = useMemo(() => ({
    id: null,
    title: 'Puuk Music',
    artist: 'Select a track to start',
    coverArt: null,
  }), []);

  const activeTrack = currentTrack || (tracks.length > 0 ? tracks[0] : fallbackTrack);
  const displayTitle = activeTrack?.title || 'Puuk Music';

  // Геометрия подложки плеера и карточки главных экранов
  const bottomBarHeight = 64 + (insets.bottom || 34);
  const topPeekHeight = (insets.top || 47) + 46;
  const cardTravel = Math.max(100, height - bottomBarHeight - topPeekHeight);

  // Reanimated shared progress (0 = свернуто, мини-плеер внизу; 1 = раскрыт плеер под карточкой)
  const expandProgress = useSharedValue(0);

  const handleClose = useCallback(() => {
    setIsPlayerVisible(false);
  }, [setIsPlayerVisible]);

  const handleExpand = useCallback(() => {
    setIsPlayerVisible(true);
  }, [setIsPlayerVisible]);

  // Синхронизация состояния плеера с анимацией карточки
  useEffect(() => {
    if (isPlayerVisible) {
      expandProgress.value = withSpring(1, {
        damping: 28,
        stiffness: 220,
        mass: 0.8,
      });
    } else {
      expandProgress.value = withTiming(0, {
        duration: 260,
        easing: Easing.bezier(0.25, 1, 0.5, 1),
      });
    }
  }, [isPlayerVisible]);

  useEffect(() => {
    if (playerExpandToken && playerExpandToken > 0) {
      expandProgress.value = withSpring(1, {
        damping: 28,
        stiffness: 220,
        mass: 0.8,
      });
    }
  }, [playerExpandToken]);

  // Анимированный сдвиг карточки вверх при раскрытии плеера снизу
  const animatedCardStyle = useAnimatedStyle(() => {
    const translateY = interpolate(
      expandProgress.value,
      [0, 1],
      [0, -cardTravel],
      Extrapolation.CLAMP
    );
    return {
      transform: [{ translateY }],
    };
  });

  // Появление верхней скругленной шапки («Swipe down to hide»)
  const topPeekAnimatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(expandProgress.value, [0.75, 1], [0, 1], Extrapolation.CLAMP);
    return {
      opacity,
    };
  });

  // Анимация мини-плеера (обертка остается прозрачной, кнопки плавно исчезают внутри MiniPlayerBar)
  const miniPlayerAnimatedStyle = useAnimatedStyle(() => {
    return {};
  });

  // Жест свайпа вверх по мини-плееру для раскрытия плеера снизу
  const miniPlayerSwipeGesture = useMemo(() => {
    return Gesture.Pan()
      .activeOffsetY(-8)
      .failOffsetY(15)
      .onUpdate((event) => {
        'worklet';
        if (event.translationY <= 0) {
          const prog = Math.min(1, Math.max(0, -event.translationY / (height * 0.75)));
          expandProgress.value = prog;
        }
      })
      .onEnd((event) => {
        'worklet';
        if (event.translationY < -50 || event.velocityY < -300) {
          expandProgress.value = withSpring(1, {
            damping: 28,
            stiffness: 220,
            mass: 0.8,
          });
          runOnJS(handleExpand)();
        } else {
          expandProgress.value = withTiming(0, {
            duration: 250,
            easing: Easing.bezier(0.25, 1, 0.5, 1),
          });
        }
      });
  }, [handleExpand]);

  const handleMiniPlayPause = useCallback(() => {
    if (!currentTrack) {
      if (tracks.length > 0) {
        playTrack(tracks[0]);
      } else {
        startWave();
      }
    } else {
      togglePlayPause();
    }
  }, [currentTrack, tracks, playTrack, startWave, togglePlayPause]);

  // Жест свайпа вниз по верхней шапке для закрытия плеера
  const topPeekSwipeGesture = useMemo(() => {
    return Gesture.Pan()
      .activeOffsetY(5)
      .failOffsetY(-15)
      .onUpdate((event) => {
        'worklet';
        if (event.translationY >= 0) {
          const prog = Math.max(0, 1 - (event.translationY / (height * 0.75)));
          expandProgress.value = prog;
        }
      })
      .onEnd((event) => {
        'worklet';
        if (event.translationY > 50 || event.velocityY > 300) {
          expandProgress.value = withTiming(0, {
            duration: 250,
            easing: Easing.bezier(0.25, 1, 0.5, 1),
          });
          runOnJS(handleClose)();
        } else {
          expandProgress.value = withSpring(1, {
            damping: 28,
            stiffness: 220,
            mass: 0.8,
          });
        }
      });
  }, [handleClose]);

  // Последовательная инициализация настроек и авторизации при старте приложения
  useEffect(() => {
    let isMounted = true;

    async function initApp() {
      try {
        const s = await loadSettings();
        if (s?.serverUrl) {
          setServerUrl(s.serverUrl);
        }

        const savedTrack = await getSavedLastTrack();
        if (savedTrack && !currentTrack) {
          setCurrentTrack(savedTrack);
        }

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

  useEffect(() => {
    if (currentTrack && currentTrack.id) {
      setSavedLastTrack(currentTrack);
    }
  }, [currentTrack]);

  // Загрузка треков с сервера
  useEffect(() => {
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
      <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
        <StatusBar style="light" />
        <ActivityIndicator size="large" color="#FA243C" />
      </View>
    );
  }

  if (!currentUser) {
    return (
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
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000' }}>
      <StatusBar style="light" />

      {/* СЛОЙ 0 (ПОДЛОЖКА): Плеер на весь экран под карточкой */}
      <FullPlayerModal
        isPlayerVisible={isPlayerVisible}
        playerExpandToken={playerExpandToken}
        onExpand={handleExpand}
        onClose={handleClose}
        currentTrack={activeTrack}
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
        onAddToPlaylist={() => setTrackToManage(activeTrack)}
        onToggleLike={() => handleToggleLike(activeTrack)}
        isLiked={!!activeTrack?.is_liked}
        expandProgress={expandProgress}
        topPeekHeight={topPeekHeight}
        bottomBarHeight={bottomBarHeight}
        insets={insets}
      />

      {/* СЛОЙ 1 (ПЕРЕДНИЙ ПЛАН): Карточка приложения, поднимающаяся вверх при открытии плеера */}
      <Animated.View
        style={[
          styles.cardContainer,
          {
            bottom: bottomBarHeight,
            borderBottomLeftRadius: 32,
            borderBottomRightRadius: 32,
          },
          animatedCardStyle,
        ]}
      >
        <NavigationContainer ref={navigationRef}>
          <RootNavigator
            tracks={tracks}
            isPlaying={isPlaying}
            currentTrack={activeTrack}
            playTrack={playTrack}
            playTrackList={playTrackList}
            startWave={startWave}
            setTrackToManage={setTrackToManage}
            currentUser={currentUser}
            onOpenAuthModal={() => setIsAuthModalVisible(true)}
            expandProgress={expandProgress}
            isPlayerVisible={isPlayerVisible}
          />
        </NavigationContainer>

        {/* Верхняя скругленная шапка карточки («Swipe down to hide»), остающаяся вверху экрана при открытом плеере */}
        <Animated.View
          style={[
            styles.topPeekOverlay,
            { height: topPeekHeight },
            topPeekAnimatedStyle,
          ]}
          pointerEvents={isPlayerVisible ? 'auto' : 'none'}
        >
          <BlurView
            tint={Platform.OS === 'ios' ? 'systemChromeMaterialDark' : 'dark'}
            intensity={90}
            style={StyleSheet.absoluteFill}
          />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0, 0, 0, 0.35)' }]} />

          <GestureDetector gesture={topPeekSwipeGesture}>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={handleClose}
              style={styles.topPeekTouchArea}
            >
              <View style={styles.topPeekHandle} />
              <View style={styles.topPeekRow}>
                <Ionicons name="chevron-down" size={14} color="rgba(255, 255, 255, 0.7)" />
                <Text style={styles.topPeekText}>Swipe down to hide</Text>
              </View>
            </TouchableOpacity>
          </GestureDetector>
        </Animated.View>

        {/* Светящаяся полоса-индикатор прогресса трека вдоль нижней скругленной границы */}
        <GlowTrackBoundary
          currentTime={status.currentTime}
          duration={status.duration}
          isPlaying={isPlaying}
          accentColor={accentColor}
        />
      </Animated.View>

      {/* СЛОЙ 2 (ВЕРХНИЙ): Мини-плеер внизу экрана (всегда виден в свернутом виде) */}
      <Animated.View
        style={[
          styles.miniPlayerWrapper,
          { height: bottomBarHeight },
          miniPlayerAnimatedStyle,
        ]}
        pointerEvents={isPlayerVisible ? 'none' : 'auto'}
      >
        <MiniPlayerBar
          currentTrack={activeTrack}
          displayTitle={displayTitle}
          isPlaying={isPlaying}
          isPlayerVisible={isPlayerVisible}
          handleExpand={handleExpand}
          togglePlayPause={handleMiniPlayPause}
          fetchNextTrack={fetchNextTrack}
          panGesture={miniPlayerSwipeGesture}
          bottomBarHeight={bottomBarHeight}
          insets={insets}
          expandProgress={expandProgress}
          hideMediaInfo={true}
        />
      </Animated.View>

      {/* Модальные окна поверх всего интерфейса */}
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
    </GestureHandlerRootView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <AppContent />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  cardContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: '#000000',
    overflow: 'hidden',
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
    zIndex: 10,
  },
  miniPlayerWrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'transparent',
    zIndex: 25,
  },
  topPeekOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    justifyContent: 'flex-end',
    alignItems: 'center',
    overflow: 'hidden',
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255, 255, 255, 0.15)',
    zIndex: 50,
  },
  topPeekTouchArea: {
    width: '100%',
    paddingTop: 6,
    paddingBottom: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topPeekHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
    marginBottom: 6,
  },
  topPeekRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  topPeekText: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 12,
    fontWeight: '500',
    letterSpacing: 0.2,
  },
});
