import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Dimensions,
  StyleSheet,
} from 'react-native';
import { initialWindowMetrics } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import CoverImage from './CoverImage';

import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';

import AppleLyricsView from './fullplayer/lyrics/AppleLyricsView';
import MiniPlayerBar from './fullplayer/MiniPlayerBar';
import QueuePanel from './fullplayer/QueuePanel';
import PlayerControls from './fullplayer/PlayerControls';
import styles from './fullplayer/playerStyles';

const { width, height } = Dimensions.get('window');

const FullPlayerModal = ({
  isPlayerVisible,
  playerExpandToken,
  onExpand,
  onClose,
  currentTrack,
  isPlaying,
  currentTime,
  duration,
  togglePlayPause,
  fetchNextTrack,
  playPreviousTrack,
  isLoading,
  seekTo,
  upNextQueue,
  playTrack,
  onAddToPlaylist,
  onToggleLike,
  isLiked
}) => {
  const trackIsLiked = isLiked !== undefined ? isLiked : !!currentTrack?.is_liked;
  const insets = initialWindowMetrics?.insets || { top: 47, bottom: 34, left: 0, right: 0 };
  const bgColor = useSharedValue('#4c2e4f');
  const [isQueueVisible, setIsQueueVisible] = useState(false);
  const [isSliding, setIsSliding] = useState(false);
  const queueTransition = useSharedValue(0);
  const queueAnimationRef = useRef(false);
  const [slideValue, setSlideValue] = useState(0);

  const [isLyricsView, setIsLyricsView] = useState(false);
  const [isLyricsMounted, setIsLyricsMounted] = useState(false);
  const lyricsTransition = useSharedValue(0);
  const lyricsRotation = useSharedValue(0);

  const [isLyricsCompact, setIsLyricsCompact] = useState(false);
  const isEffectivelyCompact = isLyricsView && isLyricsCompact;
  const exitCompactModeRef = useRef(null);
  const handleExitCompactMode = useCallback((fn) => {
    exitCompactModeRef.current = fn;
  }, []);
  const triggerExitCompactMode = useCallback(() => {
    if (exitCompactModeRef.current) {
      exitCompactModeRef.current();
    }
  }, []);

  // === REANIMATED СОСТОЯНИЯ (работают в нативном потоке) ===
  const expandProgress = useSharedValue(0);
  const contentOpacity = useSharedValue(0);
  const isSlidingShared = useSharedValue(false);
  const sliderWidthShared = useSharedValue(1);
  const slideProgressShared = useSharedValue(0);
  const durationShared = useSharedValue(0);

  useEffect(() => {
    durationShared.value = duration || 0;
  }, [duration]);

  // Анимация появления/скрытия плеера
  useEffect(() => {
    if (isPlayerVisible) {
      expandProgress.value = withTiming(1, {
        duration: 320,
        easing: Easing.bezier(0.2, 0.9, 0.3, 1),
      });
      contentOpacity.value = withTiming(1, { duration: 250 });
      setIsQueueVisible(false);
      cancelAnimation(queueTransition);
      queueTransition.value = 0;
      setIsLyricsView(false);
      setIsLyricsMounted(false);
      cancelAnimation(lyricsTransition);
      cancelAnimation(lyricsRotation);
      lyricsTransition.value = 0;
      lyricsRotation.value = 0;
    } else {
      contentOpacity.value = withTiming(0, { duration: 180 });
      expandProgress.value = withTiming(0, {
        duration: 250,
        easing: Easing.bezier(0.25, 1, 0.5, 1),
      });
      setIsLyricsView(false);
      setIsLyricsMounted(false);
      setIsQueueVisible(false);
      cancelAnimation(queueTransition);
      cancelAnimation(lyricsTransition);
      cancelAnimation(lyricsRotation);
      queueTransition.value = 0;
      lyricsTransition.value = 0;
      lyricsRotation.value = 0;
    }
  }, [isPlayerVisible]);

  useEffect(() => {
    if (playerExpandToken && playerExpandToken > 0) {
      expandProgress.value = withTiming(1, {
        duration: 320,
        easing: Easing.bezier(0.2, 0.9, 0.3, 1),
      });
      contentOpacity.value = withTiming(1, { duration: 250 });
      setIsQueueVisible(false);
      cancelAnimation(queueTransition);
      queueTransition.value = 0;
      setIsLyricsView(false);
      setIsLyricsMounted(false);
      cancelAnimation(lyricsTransition);
      cancelAnimation(lyricsRotation);
      lyricsTransition.value = 0;
      lyricsRotation.value = 0;
    }
  }, [playerExpandToken]);

  useEffect(() => {
    if (currentTrack?.coverArt && currentTrack.coverArt.includes('/api/cover/')) {
      const colorUrl = currentTrack.coverArt.replace('/api/cover/', '/api/color/');
      fetch(colorUrl)
        .then(r => r.json())
        .then(data => {
          if (data.color) {
            bgColor.value = withTiming(data.color, { duration: 800 });
          }
        })
        .catch(err => console.log('Failed to fetch color', err));
    }
  }, [currentTrack]);

  // Синхронизация полосы прогресса с аудио
  useEffect(() => {
    if (!isSliding && duration > 0) {
      slideProgressShared.value = withTiming(currentTime / duration, { duration: 250 });
    }
  }, [currentTime, duration, isSliding]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const onExpandRef = useRef(onExpand);
  onExpandRef.current = onExpand;

  const handleClose = useCallback(() => {
    contentOpacity.value = withTiming(0, { duration: 180 });
    expandProgress.value = withTiming(0, {
      duration: 250,
      easing: Easing.bezier(0.25, 1, 0.5, 1),
    });
    setIsLyricsView(false);
    setIsLyricsMounted(false);
    setIsQueueVisible(false);
    cancelAnimation(queueTransition);
    cancelAnimation(lyricsTransition);
    cancelAnimation(lyricsRotation);
    queueTransition.value = 0;
    lyricsTransition.value = 0;
    lyricsRotation.value = 0;
    if (onCloseRef.current) {
      onCloseRef.current();
    }
  }, []);

  const handleExpand = useCallback(() => {
    expandProgress.value = withTiming(1, {
      duration: 320,
      easing: Easing.bezier(0.2, 0.9, 0.3, 1),
    });
    contentOpacity.value = withTiming(1, { duration: 250 });
    setIsQueueVisible(false);
    cancelAnimation(queueTransition);
    queueTransition.value = 0;
    setIsLyricsView(false);
    setIsLyricsMounted(false);
    cancelAnimation(lyricsTransition);
    cancelAnimation(lyricsRotation);
    lyricsTransition.value = 0;
    lyricsRotation.value = 0;
    if (onExpandRef.current) {
      onExpandRef.current();
    }
  }, []);

  const createSwipeDownGesture = () => {
    return Gesture.Pan()
      .activeOffsetY(10)
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
        if (event.translationY > 70 || event.velocityY > 350) {
          expandProgress.value = withTiming(0, {
            duration: 250,
            easing: Easing.bezier(0.25, 1, 0.5, 1),
          });
          contentOpacity.value = withTiming(0, { duration: 180 });
          runOnJS(handleClose)();
        } else {
          expandProgress.value = withSpring(1, {
            damping: 28,
            stiffness: 220,
            mass: 0.8,
          });
          contentOpacity.value = withTiming(1, { duration: 200 });
        }
      })
      .onFinalize((event, success) => {
        'worklet';
        if (!success && expandProgress.value < 0.99 && expandProgress.value > 0.01) {
          expandProgress.value = withSpring(1, {
            damping: 28,
            stiffness: 220,
            mass: 0.8,
          });
          contentOpacity.value = withTiming(1, { duration: 200 });
        }
      });
  };

  const headerSwipeGesture = useMemo(() => createSwipeDownGesture(), []);
  const mainSwipeGesture = useMemo(() => createSwipeDownGesture(), []);
  const bottomSwipeGesture = useMemo(() => createSwipeDownGesture(), []);
  const lyricsHeaderSwipeGesture = useMemo(() => createSwipeDownGesture(), []);
  const queueHeaderSwipeGesture = useMemo(() => createSwipeDownGesture(), []);

  const animatedContainerStyle = useAnimatedStyle(() => {
    return {
      top: interpolate(expandProgress.value, [0, 1], [height - 157, 0], Extrapolation.CLAMP),
      bottom: interpolate(expandProgress.value, [0, 1], [94, 0], Extrapolation.CLAMP),
      left: interpolate(expandProgress.value, [0, 1], [10, 0], Extrapolation.CLAMP),
      right: interpolate(expandProgress.value, [0, 1], [10, 0], Extrapolation.CLAMP),
      borderRadius: interpolate(expandProgress.value, [0, 1], [14, 0], Extrapolation.CLAMP),
      position: 'absolute',
      overflow: 'hidden',
    };
  });

  const miniPlayerAnimatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(expandProgress.value, [0, 0.15], [1, 0], Extrapolation.CLAMP);
    const translateY = interpolate(expandProgress.value, [0, 0.15], [0, -15], Extrapolation.CLAMP);
    return {
      opacity,
      transform: [{ translateY }],
      zIndex: expandProgress.value < 0.1 ? 50 : -1,
    };
  });

  const contentAnimatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(expandProgress.value, [0.06, 0.35], [0, 1], Extrapolation.CLAMP) * contentOpacity.value;
    const translateY = interpolate(expandProgress.value, [0, 1], [30, 0], Extrapolation.CLAMP);
    return {
      opacity,
      transform: [{ translateY }],
    };
  });

  const gradientOverlayAnimatedStyle = useAnimatedStyle(() => {
    const gradOpacity = interpolate(expandProgress.value, [0.08, 0.35], [0, 1], Extrapolation.CLAMP);
    return {
      opacity: gradOpacity * contentOpacity.value,
    };
  });

  const toggleQueue = () => {
    const nextState = !isQueueVisible;
    if (nextState) {
      queueAnimationRef.current = true;
      setTimeout(() => { queueAnimationRef.current = false; }, 1000);
      if (isLyricsView) {
        setIsLyricsView(false);
        cancelAnimation(lyricsTransition);
        cancelAnimation(lyricsRotation);
        lyricsTransition.value = withTiming(0, { duration: 300 });
        lyricsRotation.value = withTiming(0, { duration: 300 });
      }
    }
    setIsQueueVisible(nextState);
    cancelAnimation(queueTransition);
    queueTransition.value = withTiming(nextState ? 1 : 0, { duration: 350 });
  };

  const handleToggleLyrics = () => {
    if (isLyricsView) {
      setIsLyricsView(false);
    } else {
      setIsQueueVisible(false);
      cancelAnimation(queueTransition);
      queueTransition.value = withTiming(0, { duration: 250 });
      setIsLyricsMounted(true);
      setIsLyricsView(true);
    }
  };

  const playerAnimatedStyle = useAnimatedStyle(() => {
    return {
      opacity: 1 - queueTransition.value,
      transform: [{ scale: 1 - queueTransition.value * 0.1 }],
    };
  });

  const queueAnimatedStyle = useAnimatedStyle(() => {
    const isHidden = queueTransition.value <= 0.001 || isLyricsView;
    return {
      opacity: isLyricsView ? 0 : queueTransition.value,
      transform: [{ translateY: (1 - queueTransition.value) * 50 }],
      zIndex: queueTransition.value > 0.01 && !isLyricsView ? 10 : -1,
      display: isHidden ? 'none' : 'flex',
    };
  });

  const BIG_ART_SIZE = width - 60;
  const MINI_ART_SIZE = 44;
  const TARGET_SCALE = MINI_ART_SIZE / BIG_ART_SIZE;
  const TARGET_DELTA_X = 52 - (width / 2);
  const TARGET_DELTA_Y = -40 - (BIG_ART_SIZE / 2);

  const albumArtFlipStyle = useAnimatedStyle(() => {
    const rotateY = lyricsRotation.value;

    const scale = interpolate(
      lyricsTransition.value,
      [0, 1],
      [1, TARGET_SCALE],
      Extrapolation.CLAMP
    );

    const translateX = interpolate(
      lyricsTransition.value,
      [0, 1],
      [0, TARGET_DELTA_X],
      Extrapolation.CLAMP
    );
    const translateY = interpolate(
      lyricsTransition.value,
      [0, 1],
      [0, TARGET_DELTA_Y],
      Extrapolation.CLAMP
    );

    const shadowOpacity = interpolate(
      lyricsTransition.value,
      [0, 1],
      [0.5, 0.15],
      Extrapolation.CLAMP
    );
    const shadowRadius = interpolate(
      lyricsTransition.value,
      [0, 1],
      [15, 4],
      Extrapolation.CLAMP
    );
    const elevation = interpolate(
      lyricsTransition.value,
      [0, 1],
      [10, 2],
      Extrapolation.CLAMP
    );

    return {
      opacity: 1,
      shadowOpacity,
      shadowRadius,
      elevation,
      transform: [
        { translateX },
        { translateY },
        { perspective: 1200 },
        { rotateY: `${rotateY}deg` },
        { scale },
      ],
    };
  });

  const albumArtRadiusStyle = useAnimatedStyle(() => {
    const radius = interpolate(
      lyricsTransition.value,
      [0, 1],
      [12, 6 / TARGET_SCALE],
      Extrapolation.CLAMP
    );
    return {
      borderRadius: radius,
    };
  });

  const albumArtSheenStyle = useAnimatedStyle(() => {
    const sheen = interpolate(
      lyricsRotation.value,
      [0, 90, 180, 270, 360],
      [0, 0.35, 0, 0.35, 0],
      Extrapolation.CLAMP
    );
    return {
      opacity: sheen,
    };
  });

  const trackInfoAnimatedStyle = useAnimatedStyle(() => {
    const translateY = interpolate(
      lyricsTransition.value,
      [0, 0.55],
      [0, -45],
      Extrapolation.CLAMP
    );
    const opacity = interpolate(
      lyricsTransition.value,
      [0, 0.38],
      [1, 0],
      Extrapolation.CLAMP
    );
    const scale = interpolate(
      lyricsTransition.value,
      [0, 0.45],
      [1, 0.94],
      Extrapolation.CLAMP
    );
    return {
      opacity,
      transform: [{ translateY }, { scale }],
    };
  });

  const trackInfoTextAnimatedStyle = useAnimatedStyle(() => {
    const translateX = interpolate(
      lyricsTransition.value,
      [0, 0.45],
      [0, 16],
      Extrapolation.CLAMP
    );
    return {
      transform: [{ translateX }],
    };
  });

  const trackInfoHeartAnimatedStyle = useAnimatedStyle(() => {
    const scale = interpolate(
      lyricsTransition.value,
      [0, 0.38],
      [1, 0.88],
      Extrapolation.CLAMP
    );
    return {
      transform: [{ scale }],
    };
  });

  const playerHeaderAnimatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      lyricsTransition.value,
      [0, 0.3],
      [1, 0],
      Extrapolation.CLAMP
    );
    const translateY = interpolate(
      lyricsTransition.value,
      [0, 0.3],
      [0, -15],
      Extrapolation.CLAMP
    );
    return {
      opacity,
      transform: [{ translateY }],
    };
  });

  const lyricsViewAnimatedStyle = useAnimatedStyle(() => {
    return {
      opacity: lyricsTransition.value > 0.005 ? 1 : 0,
    };
  });

  const lyricsContentAnimatedStyle = useAnimatedStyle(() => {
    const translateY = interpolate(
      lyricsTransition.value,
      [0, 1],
      [140, 0],
      Extrapolation.CLAMP
    );
    const opacity = interpolate(
      lyricsTransition.value,
      [0.08, 0.65, 1],
      [0, 0.85, 1],
      Extrapolation.CLAMP
    );
    return {
      opacity,
      transform: [{ translateY }],
    };
  });

  const lyricsMiniTextAnimatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      lyricsTransition.value,
      [0.72, 0.98],
      [0, 1],
      Extrapolation.CLAMP
    );
    const translateY = interpolate(
      lyricsTransition.value,
      [0.72, 0.98],
      [12, 0],
      Extrapolation.CLAMP
    );
    return {
      opacity,
      transform: [{ translateY }],
    };
  });

  const lyricsMiniHeartAnimatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      lyricsTransition.value,
      [0.72, 0.98],
      [0, 1],
      Extrapolation.CLAMP
    );
    const translateY = interpolate(
      lyricsTransition.value,
      [0.72, 0.98],
      [12, 0],
      Extrapolation.CLAMP
    );
    return {
      opacity,
      transform: [{ translateY }],
    };
  });

  const lyricsMiniHeaderAnimatedStyle = useAnimatedStyle(() => {
    return {
      opacity: lyricsTransition.value > 0.01 ? 1 : 0,
    };
  });

  const lyricsOverlaysAnimatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      lyricsTransition.value,
      [0.2, 0.85],
      [0, 1],
      Extrapolation.CLAMP
    );
    return { opacity };
  });

  const animatedBgStyle = useAnimatedStyle(() => {
    return {
      backgroundColor: bgColor.value,
      opacity: interpolate(expandProgress.value, [0, 0.5], [0, 1], Extrapolation.CLAMP),
    };
  });

  if (!currentTrack) return null;

  const getTrackDetails = (track) => {
    if (!track) return { displayTitle: '', displayArtist: '' };
    return {
      displayTitle: track.title || '',
      displayArtist: track.artist || ''
    };
  };

  const { displayTitle, displayArtist } = getTrackDetails(currentTrack);

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, { zIndex: 100 }]}
      pointerEvents="box-none"
    >
      <GestureHandlerRootView style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <Animated.View style={[styles.container, animatedContainerStyle]} pointerEvents="auto">
          {/* Base dark background for mini player */}
          <View style={{ ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(30, 30, 30, 0.95)' }} />

          {/* Плавно меняющийся сплошной цветной фон */}
          <Animated.View style={[StyleSheet.absoluteFill, animatedBgStyle]} />

          {/* Градиент затемнения (от полностью прозрачного до цвета подвала) */}
          <Animated.View style={[StyleSheet.absoluteFill, gradientOverlayAnimatedStyle]} pointerEvents="none">
            <LinearGradient
              colors={['#120d1400', '#120d14']}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>


          {/* Mini Player UI */}
          <MiniPlayerBar
            styles={styles}
            currentTrack={currentTrack}
            displayTitle={displayTitle}
            isPlaying={isPlaying}
            isPlayerVisible={isPlayerVisible}
            handleExpand={handleExpand}
            togglePlayPause={togglePlayPause}
            fetchNextTrack={fetchNextTrack}
            miniPlayerAnimatedStyle={miniPlayerAnimatedStyle}
          />

          <AppleLyricsView
            isLyricsView={isLyricsView}
            isLyricsMounted={isLyricsMounted}
            currentTrack={currentTrack}
            currentTime={currentTime}
            isPlayerVisible={isPlayerVisible}
            isQueueVisible={isQueueVisible}
            seekTo={seekTo}
            onToggleLike={onToggleLike}
            trackIsLiked={trackIsLiked}
            displayTitle={displayTitle}
            displayArtist={displayArtist}
            insets={insets}
            width={width}
            height={height}
            contentAnimatedStyle={contentAnimatedStyle}
            lyricsTransition={lyricsTransition}
            lyricsRotation={lyricsRotation}
            animatedBgStyle={animatedBgStyle}
            lyricsViewAnimatedStyle={lyricsViewAnimatedStyle}
            lyricsMiniHeaderAnimatedStyle={lyricsMiniHeaderAnimatedStyle}
            lyricsMiniTextAnimatedStyle={lyricsMiniTextAnimatedStyle}
            lyricsMiniHeartAnimatedStyle={lyricsMiniHeartAnimatedStyle}
            lyricsOverlaysAnimatedStyle={lyricsOverlaysAnimatedStyle}
            lyricsContentAnimatedStyle={lyricsContentAnimatedStyle}
            setIsLyricsView={setIsLyricsView}
            setIsLyricsMounted={setIsLyricsMounted}
            lyricsHeaderSwipeGesture={lyricsHeaderSwipeGesture}
            onClose={handleClose}
            onExitCompactMode={handleExitCompactMode}
            onLyricsCompactChange={setIsLyricsCompact}
          />

          <Animated.View
            style={[
              styles.safeArea,
              {
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                paddingTop: insets.top + 10,
                paddingBottom: insets.bottom + 35,
                width: width,
                height: height,
                zIndex: 20,
              },
              contentAnimatedStyle
            ]}
            pointerEvents={isPlayerVisible ? 'box-none' : 'none'}
          >

            {/* In full player view, show drag indicator at top */}
            <GestureDetector gesture={headerSwipeGesture}>
              <Animated.View
                style={[styles.playerHeader, playerHeaderAnimatedStyle]}
                pointerEvents={isLyricsView ? 'none' : 'auto'}
              >
                <TouchableOpacity
                  style={styles.closeButton}
                  onPress={handleClose}
                  hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
                  activeOpacity={0.7}
                >
                  <Ionicons name="chevron-down" size={26} color="rgba(255, 255, 255, 0.7)" />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleClose}
                  hitSlop={{ top: 15, bottom: 15, left: 20, right: 20 }}
                  activeOpacity={0.7}
                >
                  <View style={styles.dragIndicator} />
                </TouchableOpacity>
                <View style={styles.closeButton} />
              </Animated.View>
            </GestureDetector>

            {/* Middle container: Cover art & info when NOT in lyrics view, or queue view */}
            <View style={{ flex: 1, width: '100%', justifyContent: 'flex-start' }} pointerEvents={isLyricsView ? 'box-none' : 'auto'}>
              <Animated.View
                style={[playerAnimatedStyle, { width: '100%', alignItems: 'center', flex: 1 }]}
                pointerEvents={isLyricsView || isQueueVisible ? 'none' : 'auto'}
              >
                <GestureDetector gesture={mainSwipeGesture}>
                  <Animated.View style={{ width: '100%', flex: 1, alignItems: 'center', backgroundColor: 'transparent' }}>
                    <Animated.View style={[styles.artContainer, albumArtFlipStyle]}>
                      <Animated.View style={[{ width: '100%', height: '100%', overflow: 'hidden' }, albumArtRadiusStyle]}>
                        <CoverImage
                          source={currentTrack.coverArt}
                          style={{ width: '100%', height: '100%' }}
                        />
                        <Animated.View
                          style={[
                            StyleSheet.absoluteFillObject,
                            { backgroundColor: '#000' },
                            albumArtSheenStyle,
                          ]}
                          pointerEvents="none"
                        />
                      </Animated.View>
                    </Animated.View>

                    <Animated.View style={[styles.trackInfoContainer, trackInfoAnimatedStyle]}>
                      <View style={styles.titleRow}>
                        <Animated.View style={[styles.textContainer, trackInfoTextAnimatedStyle]}>
                          <Text style={styles.titleText} numberOfLines={1}>{displayTitle}</Text>
                          <Text style={styles.artistText} numberOfLines={1}>{displayArtist}</Text>
                        </Animated.View>
                        <Animated.View style={trackInfoHeartAnimatedStyle}>
                          <TouchableOpacity
                            onPress={() => onToggleLike && onToggleLike()}
                            hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
                            style={styles.heartBtn}
                          >
                            <Ionicons
                              name={trackIsLiked ? "heart" : "heart-outline"}
                              size={28}
                              color={trackIsLiked ? "#ff2d55" : "#e5e5ea"}
                            />
                          </TouchableOpacity>
                        </Animated.View>
                      </View>
                    </Animated.View>

                    {/* Spacer view covering the entire empty space between trackInfo and progress bar */}
                    <View style={{ flex: 1, width: '100%', backgroundColor: 'transparent' }} />
                  </Animated.View>
                </GestureDetector>
              </Animated.View>

              <QueuePanel
                styles={styles}
                queueAnimatedStyle={queueAnimatedStyle}
                isQueueVisible={isQueueVisible}
                isLyricsView={isLyricsView}
                queueHeaderSwipeGesture={queueHeaderSwipeGesture}
                upNextQueue={upNextQueue}
                queueAnimationRef={queueAnimationRef}
                playTrack={playTrack}
              />
            </View>

            {/* Bottom controls container */}
            <PlayerControls
              styles={styles}
              isEffectivelyCompact={isEffectivelyCompact}
              isPlaying={isPlaying}
              isLoading={isLoading}
              currentTime={currentTime}
              duration={duration}
              togglePlayPause={togglePlayPause}
              fetchNextTrack={fetchNextTrack}
              playPreviousTrack={playPreviousTrack}
              seekTo={seekTo}
              isLyricsView={isLyricsView}
              isQueueVisible={isQueueVisible}
              isSliding={isSliding}
              setIsSliding={setIsSliding}
              setSlideValue={setSlideValue}
              isSlidingShared={isSlidingShared}
              sliderWidthShared={sliderWidthShared}
              slideProgressShared={slideProgressShared}
              durationShared={durationShared}
              slideValue={slideValue}
              bottomSwipeGesture={bottomSwipeGesture}
              exitCompactMode={triggerExitCompactMode}
              triggerExitCompactMode={triggerExitCompactMode}
              onAddToPlaylist={onAddToPlaylist}
              onToggleQueue={toggleQueue}
              onToggleLyrics={handleToggleLyrics}
            />

          </Animated.View>
        </Animated.View>
      </GestureHandlerRootView>
    </Animated.View>
  );
};


export default FullPlayerModal;
