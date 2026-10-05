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
import { authFetch } from '../utils/api';

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
  isLiked,
  expandProgress: externalExpandProgress,
  bottomBarHeight,
  topPeekHeight,
  insets: propInsets,
}) => {
  const trackIsLiked = isLiked !== undefined ? isLiked : !!currentTrack?.is_liked;
  const insets = propInsets || initialWindowMetrics?.insets || { top: 47, bottom: 34, left: 0, right: 0 };
  const effectiveBottomBarHeight = bottomBarHeight || (64 + (insets.bottom || 34));
  const effectiveTopPeekHeight = topPeekHeight || ((insets.top || 47) + 46);
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
  const internalExpandProgress = useSharedValue(0);
  const expandProgress = externalExpandProgress || internalExpandProgress;
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
      if (!externalExpandProgress) {
        expandProgress.value = withTiming(1, {
          duration: 320,
          easing: Easing.bezier(0.2, 0.9, 0.3, 1),
        });
      }
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
      if (!externalExpandProgress) {
        expandProgress.value = withTiming(0, {
          duration: 250,
          easing: Easing.bezier(0.25, 1, 0.5, 1),
        });
      }
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
  }, [isPlayerVisible, externalExpandProgress]);

  useEffect(() => {
    if (playerExpandToken && playerExpandToken > 0) {
      if (!externalExpandProgress) {
        expandProgress.value = withTiming(1, {
          duration: 320,
          easing: Easing.bezier(0.2, 0.9, 0.3, 1),
        });
      }
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
  }, [playerExpandToken, externalExpandProgress]);

  useEffect(() => {
    if (currentTrack?.coverArt && currentTrack.coverArt.includes('/api/cover/')) {
      const colorUrl = currentTrack.coverArt.replace('/api/cover/', '/api/color/');
      authFetch(colorUrl)
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
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
    if (!externalExpandProgress) {
      expandProgress.value = withTiming(0, {
        duration: 250,
        easing: Easing.bezier(0.25, 1, 0.5, 1),
      });
    }
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
  }, [externalExpandProgress]);

  const handleExpand = useCallback(() => {
    if (!externalExpandProgress) {
      expandProgress.value = withTiming(1, {
        duration: 320,
        easing: Easing.bezier(0.2, 0.9, 0.3, 1),
      });
    }
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
  }, [externalExpandProgress]);

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
          runOnJS(handleClose)();
        } else {
          expandProgress.value = withSpring(1, {
            damping: 28,
            stiffness: 220,
            mass: 0.8,
          });
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
        }
      });
  };

  const mainSwipeGesture = useMemo(() => createSwipeDownGesture(), []);
  const bottomSwipeGesture = useMemo(() => createSwipeDownGesture(), []);
  const lyricsHeaderSwipeGesture = useMemo(() => createSwipeDownGesture(), []);
  const queueHeaderSwipeGesture = useMemo(() => createSwipeDownGesture(), []);

  const gradientOverlayAnimatedStyle = useAnimatedStyle(() => {
    const gradOpacity = interpolate(expandProgress.value, [0.08, 0.4], [0, 1], Extrapolation.CLAMP);
    return {
      opacity: gradOpacity,
    };
  });

  const playerControlsAnimatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      expandProgress.value,
      [0.2, 0.75],
      [0, 1],
      Extrapolation.CLAMP
    );
    const translateY = interpolate(
      expandProgress.value,
      [0.2, 1],
      [50, 0],
      Extrapolation.CLAMP
    );
    return {
      opacity,
      transform: [{ translateY }],
    };
  });

  const lyricsModalContentAnimatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(expandProgress.value, [0.85, 1], [0, 1], Extrapolation.CLAMP);
    return {
      opacity,
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

  // Morphing calculations: mini-player to full-player
  const miniScale = MINI_ART_SIZE / BIG_ART_SIZE;
  const miniCenterX = 16 + MINI_ART_SIZE / 2; // 38
  const fullCenterX = width / 2;
  const expandDeltaX = miniCenterX - fullCenterX;

  const fullArtTopY = effectiveTopPeekHeight + 30; // safeArea paddingTop (effectiveTopPeekHeight + 10) + marginTop 20
  const fullArtCenterY = fullArtTopY + BIG_ART_SIZE / 2;
  const TARGET_DELTA_Y = (effectiveTopPeekHeight + 32) - fullArtCenterY;

  const miniArtTopY = height - effectiveBottomBarHeight + 10;
  const miniArtCenterY = miniArtTopY + MINI_ART_SIZE / 2; // height - effectiveBottomBarHeight + 32
  const expandDeltaY = miniArtCenterY - fullArtCenterY;

  const fullTextTopY = fullArtTopY + BIG_ART_SIZE + 20;
  const fullTextCenterY = fullTextTopY + 23;
  const miniTextCenterY = height - effectiveBottomBarHeight + 32;
  const expandDeltaTextX = 72 - 30; // 42
  const expandDeltaTextY = miniTextCenterY - fullTextCenterY;

  const albumArtFlipStyle = useAnimatedStyle(() => {
    const rotateY = lyricsRotation.value;

    const expandScale = interpolate(
      expandProgress.value,
      [0, 1],
      [miniScale, 1],
      Extrapolation.CLAMP
    );
    const expandTranslateX = interpolate(
      expandProgress.value,
      [0, 1],
      [expandDeltaX, 0],
      Extrapolation.CLAMP
    );
    const expandTranslateY = interpolate(
      expandProgress.value,
      [0, 1],
      [expandDeltaY, 0],
      Extrapolation.CLAMP
    );

    const lyricsScale = interpolate(
      lyricsTransition.value,
      [0, 1],
      [1, TARGET_SCALE],
      Extrapolation.CLAMP
    );
    const lyricsTranslateX = interpolate(
      lyricsTransition.value,
      [0, 1],
      [0, TARGET_DELTA_X],
      Extrapolation.CLAMP
    );
    const lyricsTranslateY = interpolate(
      lyricsTransition.value,
      [0, 1],
      [0, TARGET_DELTA_Y],
      Extrapolation.CLAMP
    );

    const scale = expandScale * lyricsScale;
    const translateX = expandTranslateX + lyricsTranslateX;
    const translateY = expandTranslateY + lyricsTranslateY;

    const shadowOpacity = interpolate(
      expandProgress.value,
      [0, 1],
      [0, 0.5],
      Extrapolation.CLAMP
    ) * interpolate(
      lyricsTransition.value,
      [0, 1],
      [1, 0.3],
      Extrapolation.CLAMP
    );
    const shadowRadius = interpolate(
      expandProgress.value,
      [0, 1],
      [0, 15],
      Extrapolation.CLAMP
    ) * interpolate(
      lyricsTransition.value,
      [0, 1],
      [1, 4 / 15],
      Extrapolation.CLAMP
    );
    const elevation = interpolate(
      expandProgress.value,
      [0, 1],
      [0, 10],
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
    const baseRadius = interpolate(
      expandProgress.value,
      [0, 1],
      [8 / miniScale, 12],
      Extrapolation.CLAMP
    );
    const radius = interpolate(
      lyricsTransition.value,
      [0, 1],
      [baseRadius, 6 / TARGET_SCALE],
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
    const expandTranslateX = interpolate(
      expandProgress.value,
      [0, 1],
      [expandDeltaTextX, 0],
      Extrapolation.CLAMP
    );
    const expandTranslateY = interpolate(
      expandProgress.value,
      [0, 1],
      [expandDeltaTextY, 0],
      Extrapolation.CLAMP
    );
    const expandScale = interpolate(
      expandProgress.value,
      [0, 1],
      [0.65, 1],
      Extrapolation.CLAMP
    );

    const lyricsTranslateY = interpolate(
      lyricsTransition.value,
      [0, 0.55],
      [0, -45],
      Extrapolation.CLAMP
    );
    const lyricsOpacity = interpolate(
      lyricsTransition.value,
      [0, 0.38],
      [1, 0],
      Extrapolation.CLAMP
    );
    const lyricsScale = interpolate(
      lyricsTransition.value,
      [0, 0.45],
      [1, 0.94],
      Extrapolation.CLAMP
    );

    return {
      opacity: lyricsOpacity,
      transform: [
        { translateX: expandTranslateX },
        { translateY: expandTranslateY + lyricsTranslateY },
        { scale: expandScale * lyricsScale },
      ],
      transformOrigin: 'left center',
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
      expandProgress.value,
      [0.65, 1],
      [0.1, 1],
      Extrapolation.CLAMP
    ) * interpolate(
      lyricsTransition.value,
      [0, 0.38],
      [1, 0.88],
      Extrapolation.CLAMP
    );
    const opacity = interpolate(
      expandProgress.value,
      [0.65, 0.95],
      [0, 1],
      Extrapolation.CLAMP
    );
    return {
      opacity,
      transform: [{ scale }],
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

  const fallbackTrack = useMemo(() => ({
    id: 'placeholder',
    title: 'Puuk Music',
    artist: 'Select a track to start',
    coverArt: null,
  }), []);

  const activeTrack = currentTrack || fallbackTrack;

  const getTrackDetails = (track) => {
    if (!track) return { displayTitle: '', displayArtist: '' };
    return {
      displayTitle: track.title || 'Puuk Music',
      displayArtist: track.artist || 'Select a track to start'
    };
  };

  const { displayTitle, displayArtist } = getTrackDetails(activeTrack);

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, { zIndex: 1 }]}
      pointerEvents={isPlayerVisible ? 'auto' : 'none'}
    >
      <GestureHandlerRootView style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <View style={styles.container} pointerEvents="auto">
          {/* Base pitch black background */}
          <View style={{ ...StyleSheet.absoluteFillObject, backgroundColor: '#000000' }} />

          {/* Плавно меняющийся сплошной цветной фон */}
          <Animated.View style={[StyleSheet.absoluteFill, animatedBgStyle]} />

          {/* Градиент затемнения (от полностью прозрачного до цвета подвала) */}
          <Animated.View style={[StyleSheet.absoluteFill, gradientOverlayAnimatedStyle]} pointerEvents="none">
            <LinearGradient
              colors={['#00000000', '#000000']}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>

          <AppleLyricsView
            isLyricsView={isLyricsView}
            isLyricsMounted={isLyricsMounted}
            currentTrack={activeTrack}
            currentTime={currentTime}
            isPlayerVisible={isPlayerVisible}
            isQueueVisible={isQueueVisible}
            seekTo={seekTo}
            onToggleLike={onToggleLike}
            trackIsLiked={trackIsLiked}
            displayTitle={displayTitle}
            displayArtist={displayArtist}
            insets={{ ...insets, top: effectiveTopPeekHeight }}
            width={width}
            height={height}
            contentAnimatedStyle={lyricsModalContentAnimatedStyle}
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
                paddingTop: effectiveTopPeekHeight + 10,
                paddingBottom: insets.bottom + 25,
                width: width,
                height: height,
                zIndex: 20,
              },
            ]}
            pointerEvents={isPlayerVisible ? 'box-none' : 'none'}
          >

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
                          source={activeTrack?.coverArt}
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
            <Animated.View style={[{ width: '100%' }, playerControlsAnimatedStyle]}>
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
        </View>
      </GestureHandlerRootView>
    </Animated.View>
  );
};


export default FullPlayerModal;
