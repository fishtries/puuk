import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Dimensions,
  StyleSheet,
  Platform,
} from 'react-native';
import { initialWindowMetrics } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import CoverImage, { prefetchCover } from './CoverImage';
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
  ReduceMotion,
} from 'react-native-reanimated';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';

import AppleLyricsView from './fullplayer/lyrics/AppleLyricsView';
import QueuePanel from './fullplayer/QueuePanel';
import PlayerControls from './fullplayer/PlayerControls';
import PlayerNetworkBanner from './fullplayer/PlayerNetworkBanner';
import { MenuView } from '@react-native-menu/menu';
import TrackLoadingBadge from './fullplayer/TrackLoadingBadge';
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
  history,
  previousTrack,
  nextTrack,
  playTrack,
  onAddToPlaylist,
  onEditTrack,
  onToggleLike,
  isLiked,
  expandProgress: externalExpandProgress,
  bottomBarHeight,
  topPeekHeight,
  insets: propInsets,
  dismissProgress,
  dismissDragY,
  networkStatus = 'good',
  nextTrackStatus = 'idle',
  networkError = null,
  isBufferingSlow = false,
  onRetryPreload,
}) => {
  const trackIsLiked = isLiked !== undefined ? isLiked : !!currentTrack?.is_liked;
  const insets = propInsets || initialWindowMetrics?.insets || { top: 47, bottom: 34, left: 0, right: 0 };
  const effectiveBottomBarHeight = bottomBarHeight || (64 + (insets.bottom || 34));
  const effectiveTopInset = insets?.top || 47;
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
    if (!currentTrack || currentTrack.id === 'placeholder') return;

    if (currentTrack.cover_color) {
      bgColor.value = currentTrack.cover_color;
    }

    const trackId = currentTrack.id;
    if (trackId) {
      authFetch(`/api/color/${encodeURIComponent(trackId)}`)
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then(data => {
          if (data?.color) {
            bgColor.value = data.color;
          }
        })
        .catch(err => {
          if (currentTrack?.coverArt && currentTrack.coverArt.includes('/api/cover/')) {
            const colorUrl = currentTrack.coverArt.replace('/api/cover/', '/api/color/');
            authFetch(colorUrl)
              .then(r => r.ok && r.json())
              .then(data => {
                if (data?.color) {
                  bgColor.value = data.color;
                }
              })
              .catch(() => {});
          }
        });
    }
  }, [currentTrack?.id, currentTrack?.cover_color, currentTrack?.coverArt]);

  // Синхронизация полосы прогресса с аудио (только когда плеер раскрыт)
  useEffect(() => {
    if (isPlayerVisible && !isSliding && duration > 0) {
      slideProgressShared.value = withTiming(currentTime / duration, { duration: 250 });
    }
  }, [currentTime, duration, isSliding, isPlayerVisible]);

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

  const isClosingShared = useSharedValue(false);

  useEffect(() => {
    if (isPlayerVisible) {
      isClosingShared.value = false;
    }
  }, [isPlayerVisible]);

  const createSwipeDownGesture = () => {
    return Gesture.Pan()
      .activeOffsetY(8)
      .failOffsetX([-20, 20])
      .onStart(() => {
        'worklet';
        isClosingShared.value = false;
      })
      .onUpdate((event) => {
        'worklet';
        if (event.translationY >= 0) {
          const prog = Math.max(0, 1 - (event.translationY / (height * 0.75)));
          expandProgress.value = prog;
        }
      })
      .onEnd((event) => {
        'worklet';
        if (event.translationY > 35 || event.velocityY > 200) {
          isClosingShared.value = true;
          expandProgress.value = withTiming(0, {
            duration: 250,
            easing: Easing.bezier(0.25, 1, 0.5, 1),
          });
          runOnJS(handleClose)();
        } else {
          isClosingShared.value = false;
          expandProgress.value = withSpring(1, {
            damping: 28,
            stiffness: 220,
            mass: 0.8,
            reduceMotion: ReduceMotion.System,
          });
        }
      })
      .onFinalize((event, success) => {
        'worklet';
        if (isClosingShared.value) return;
        if (!success && expandProgress.value < 0.99 && expandProgress.value > 0.01) {
          expandProgress.value = withSpring(1, {
            damping: 28,
            stiffness: 220,
            mass: 0.8,
            reduceMotion: ReduceMotion.System,
          });
        }
      });
  };

  const effectiveNextTrack = useMemo(() => {
    const curId = currentTrack?.id ?? currentTrack?.track_id;
    if (nextTrack && (nextTrack.id ?? nextTrack.track_id) !== curId) {
      return nextTrack;
    }
    if (upNextQueue && upNextQueue.length > 0) {
      const candidate = upNextQueue[0];
      if ((candidate?.id ?? candidate?.track_id) !== curId) {
        return candidate;
      }
    }
    return null;
  }, [nextTrack, upNextQueue, currentTrack]);

  const effectivePrevTrack = useMemo(() => {
    const curId = currentTrack?.id ?? currentTrack?.track_id;
    if (previousTrack && (previousTrack.id ?? previousTrack.track_id) !== curId) {
      return previousTrack;
    }
    if (history && history.length > 0) {
      const candidate = history[history.length - 1];
      if ((candidate?.id ?? candidate?.track_id) !== curId) {
        return candidate;
      }
    }
    return null;
  }, [previousTrack, history, currentTrack]);

  const hasNextShared = useSharedValue(false);
  const hasPrevShared = useSharedValue(false);

  useEffect(() => {
    hasNextShared.value = Boolean(effectiveNextTrack);
  }, [effectiveNextTrack]);

  useEffect(() => {
    hasPrevShared.value = Boolean(effectivePrevTrack);
  }, [effectivePrevTrack]);

  useEffect(() => {
    if (effectiveNextTrack?.coverArt) {
      prefetchCover(effectiveNextTrack.coverArt);
    }
    if (effectivePrevTrack?.coverArt) {
      prefetchCover(effectivePrevTrack.coverArt);
    }
  }, [effectiveNextTrack?.coverArt, effectivePrevTrack?.coverArt]);

  const albumSwipeX = useSharedValue(0);
  const isSwipingAlbum = useSharedValue(false);
  const isTransitioningShared = useSharedValue(false);
  const transitionDirection = useSharedValue(0);
  const fallbackTimeoutRef = useRef(null);

  useLayoutEffect(() => {
    if (fallbackTimeoutRef.current) {
      clearTimeout(fallbackTimeoutRef.current);
      fallbackTimeoutRef.current = null;
    }

    if (transitionDirection.value === 1) {
      // Swiped to NEXT: old track exited left (-width).
      // New track enters from the RIGHT (+width * 0.45) and springs into 0.
      albumSwipeX.value = width * 0.45;
      albumSwipeX.value = withSpring(0, {
        damping: 28,
        stiffness: 220,
        mass: 0.8,
        reduceMotion: ReduceMotion.System,
      });
    } else if (transitionDirection.value === -1) {
      // Swiped to PREV: old track exited right (+width).
      // New track enters from the LEFT (-width * 0.45) and springs into 0.
      albumSwipeX.value = -width * 0.45;
      albumSwipeX.value = withSpring(0, {
        damping: 28,
        stiffness: 220,
        mass: 0.8,
        reduceMotion: ReduceMotion.System,
      });
    } else {
      albumSwipeX.value = 0;
    }

    transitionDirection.value = 0;
    isTransitioningShared.value = false;
    isSwipingAlbum.value = false;
  }, [currentTrack?.id, width]);

  useEffect(() => {
    return () => {
      if (fallbackTimeoutRef.current) {
        clearTimeout(fallbackTimeoutRef.current);
      }
    };
  }, []);

  const triggerSwipeHaptic = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, []);

  const handleSwipeNextComplete = useCallback(() => {
    if (fallbackTimeoutRef.current) {
      clearTimeout(fallbackTimeoutRef.current);
    }
    const timer = setTimeout(() => {
      if (transitionDirection.value !== 0) {
        albumSwipeX.value = withSpring(0, {
          damping: 28,
          stiffness: 220,
          mass: 0.8,
          reduceMotion: ReduceMotion.System,
        });
        transitionDirection.value = 0;
        isTransitioningShared.value = false;
        isSwipingAlbum.value = false;
      }
    }, 800);
    if (typeof timer?.unref === 'function') {
      timer.unref();
    }
    fallbackTimeoutRef.current = timer;

    if (upNextQueue && upNextQueue.length > 0) {
      fetchNextTrack?.();
    } else if (effectiveNextTrack) {
      if (playTrack) {
        playTrack(effectiveNextTrack);
      } else {
        fetchNextTrack?.();
      }
    } else {
      fetchNextTrack?.();
    }
  }, [fetchNextTrack, playTrack, upNextQueue, effectiveNextTrack]);

  const handleSwipePrevComplete = useCallback(() => {
    if (fallbackTimeoutRef.current) {
      clearTimeout(fallbackTimeoutRef.current);
    }
    const timer = setTimeout(() => {
      if (transitionDirection.value !== 0) {
        albumSwipeX.value = withSpring(0, {
          damping: 28,
          stiffness: 220,
          mass: 0.8,
          reduceMotion: ReduceMotion.System,
        });
        transitionDirection.value = 0;
        isTransitioningShared.value = false;
        isSwipingAlbum.value = false;
      }
    }, 800);
    if (typeof timer?.unref === 'function') {
      timer.unref();
    }
    fallbackTimeoutRef.current = timer;

    if (history && history.length > 0) {
      playPreviousTrack?.({ force: true });
    } else if (effectivePrevTrack) {
      if (playTrack) {
        playTrack(effectivePrevTrack);
      } else {
        playPreviousTrack?.({ force: true });
      }
    } else {
      playPreviousTrack?.({ force: true });
    }
  }, [playPreviousTrack, playTrack, history, effectivePrevTrack]);

  const albumHorizontalGesture = useMemo(() => {
    return Gesture.Pan()
      .enabled(Boolean(isPlayerVisible && !isLyricsView && !isQueueVisible))
      .activeOffsetX([-12, 12])
      .failOffsetY([-20, 20])
      .onStart(() => {
        'worklet';
        if (isTransitioningShared.value) return;
        isSwipingAlbum.value = true;
      })
      .onUpdate((event) => {
        'worklet';
        if (isTransitioningShared.value) return;
        const dx = event.translationX;
        if (dx > 0 && !hasPrevShared.value) {
          albumSwipeX.value = dx * 0.25;
        } else if (dx < 0 && !hasNextShared.value) {
          albumSwipeX.value = dx * 0.25;
        } else {
          albumSwipeX.value = dx;
        }
      })
      .onEnd((event) => {
        'worklet';
        if (isTransitioningShared.value) return;
        const dx = event.translationX;
        const vx = event.velocityX;
        const threshold = width * 0.28;

        if ((dx < -threshold || vx < -350) && hasNextShared.value) {
          isTransitioningShared.value = true;
          transitionDirection.value = 1;
          runOnJS(triggerSwipeHaptic)();
          albumSwipeX.value = withSpring(
            -width * 1.05,
            {
              damping: 28,
              stiffness: 220,
              mass: 0.8,
              velocity: vx,
              reduceMotion: ReduceMotion.System,
            },
            (finished) => {
              'worklet';
              if (finished) {
                runOnJS(handleSwipeNextComplete)();
              }
            }
          );
        } else if ((dx > threshold || vx > 350) && hasPrevShared.value) {
          isTransitioningShared.value = true;
          transitionDirection.value = -1;
          runOnJS(triggerSwipeHaptic)();
          albumSwipeX.value = withSpring(
            width * 1.05,
            {
              damping: 28,
              stiffness: 220,
              mass: 0.8,
              velocity: vx,
              reduceMotion: ReduceMotion.System,
            },
            (finished) => {
              'worklet';
              if (finished) {
                runOnJS(handleSwipePrevComplete)();
              }
            }
          );
        } else {
          albumSwipeX.value = withSpring(
            0,
            {
              damping: 28,
              stiffness: 220,
              mass: 0.8,
              velocity: vx,
              reduceMotion: ReduceMotion.System,
            },
            (finished) => {
              'worklet';
              if (finished) {
                isSwipingAlbum.value = false;
              }
            }
          );
        }
      })
      .onFinalize(() => {
        'worklet';
        if (!isTransitioningShared.value && albumSwipeX.value !== 0) {
          albumSwipeX.value = withSpring(0, {
            damping: 28,
            stiffness: 220,
            mass: 0.8,
            reduceMotion: ReduceMotion.System,
          });
          isSwipingAlbum.value = false;
        }
      });
  }, [
    isPlayerVisible,
    isLyricsView,
    isQueueVisible,
    width,
    triggerSwipeHaptic,
    handleSwipeNextComplete,
    handleSwipePrevComplete,
  ]);

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

  const topGrabberAnimatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      expandProgress.value,
      [0.4, 0.85],
      [0, 1],
      Extrapolation.CLAMP
    ) * (1 - lyricsTransition.value);
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

  const fullArtTopY = effectiveTopInset + 71; // safeArea paddingTop (effectiveTopInset + 6) + grabber 19 + header 40 + marginTop 6
  const fullArtCenterY = fullArtTopY + BIG_ART_SIZE / 2;
  const TARGET_DELTA_Y = (effectiveTopInset + 32) - fullArtCenterY;

  const miniArtTopY = height - effectiveBottomBarHeight + 10;
  const miniArtCenterY = miniArtTopY + MINI_ART_SIZE / 2; // height - effectiveBottomBarHeight + 32
  const expandDeltaY = miniArtCenterY - fullArtCenterY;

  const fullTextTopY = fullArtTopY + BIG_ART_SIZE + 20;
  const fullTextCenterY = fullTextTopY + 27;
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

    const swipeScale = interpolate(
      Math.abs(albumSwipeX.value),
      [0, width],
      [1, 0.92],
      Extrapolation.CLAMP
    );
    const swipeOpacity = interpolate(
      Math.abs(albumSwipeX.value),
      [0, width * 0.75],
      [1, 0.75],
      Extrapolation.CLAMP
    );
    const swipeTranslateX = albumSwipeX.value * interpolate(
      expandProgress.value,
      [0.9, 1],
      [0, 1],
      Extrapolation.CLAMP
    ) * (1 - lyricsTransition.value);

    const scale = expandScale * lyricsScale * (expandProgress.value > 0.9 ? swipeScale : 1);
    const translateX = expandTranslateX + lyricsTranslateX + swipeTranslateX;
    const translateY = expandTranslateY + lyricsTranslateY;

    const dismissY = ((dismissDragY ? dismissDragY.value : 0) +
      interpolate(
        dismissProgress ? dismissProgress.value : 0,
        [0, 1],
        [0, effectiveBottomBarHeight + 20],
        Extrapolation.CLAMP
      )) * (1 - expandProgress.value);
    const dismissOpacity = interpolate(
      dismissProgress ? dismissProgress.value : 0,
      [0, 0.7],
      [1, 0],
      Extrapolation.CLAMP
    );

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

    const expandOpacity = interpolate(
      expandProgress.value,
      [0, 0.005],
      [0, 1],
      Extrapolation.CLAMP
    );

    return {
      opacity: expandOpacity * dismissOpacity * (expandProgress.value > 0.9 ? swipeOpacity : 1),
      shadowOpacity,
      shadowRadius,
      elevation,
      transform: [
        { translateX },
        { translateY: translateY + dismissY },
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
      [15 / 24, 1],
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

    const dismissY = ((dismissDragY ? dismissDragY.value : 0) +
      interpolate(
        dismissProgress ? dismissProgress.value : 0,
        [0, 1],
        [0, effectiveBottomBarHeight + 20],
        Extrapolation.CLAMP
      )) * (1 - expandProgress.value);
    const dismissOpacity = interpolate(
      dismissProgress ? dismissProgress.value : 0,
      [0, 0.7],
      [1, 0],
      Extrapolation.CLAMP
    );

    const expandOpacity = interpolate(
      expandProgress.value,
      [0, 0.005],
      [0, 1],
      Extrapolation.CLAMP
    );

    return {
      opacity: lyricsOpacity * expandOpacity * dismissOpacity,
      transform: [
        { translateX: expandTranslateX },
        { translateY: expandTranslateY + lyricsTranslateY + dismissY },
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

  const ambientCoverAnimatedStyle = useAnimatedStyle(() => {
    return {
      opacity: interpolate(expandProgress.value, [0, 0.4], [0, 1], Extrapolation.CLAMP),
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

  const handleMenuAction = useCallback(({ nativeEvent }) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}

    if (nativeEvent.event === 'add_to_playlist') {
      if (onAddToPlaylist) onAddToPlaylist(activeTrack);
    } else if (nativeEvent.event === 'edit_track') {
      if (onEditTrack) onEditTrack(activeTrack);
    }
  }, [activeTrack, onAddToPlaylist, onEditTrack]);

  const menuActions = useMemo(() => [
    {
      id: 'add_to_playlist',
      title: 'Add to Playlist',
      image: Platform.select({ ios: 'plus.circle' }),
    },
    ...(onEditTrack
      ? [
          {
            id: 'edit_track',
            title: 'Edit Track',
            image: Platform.select({ ios: 'pencil' }),
          },
        ]
      : []),
  ], [onEditTrack]);

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

          {/* Dynamic ambient cover art background for expanded player */}
          {activeTrack?.coverArt && (
            <Animated.View style={[StyleSheet.absoluteFill, ambientCoverAnimatedStyle]} pointerEvents="none">
              <CoverImage
                source={activeTrack.coverArt}
                style={[StyleSheet.absoluteFill, { transform: [{ scale: 1.4 }] }]}
                blurRadius={40}
                resizeMode="cover"
              />
              <BlurView intensity={35} tint="dark" style={StyleSheet.absoluteFill} />
              <LinearGradient
                colors={['rgba(0,0,0,0.2)', 'rgba(0,0,0,0.45)', 'rgba(0,0,0,0.85)']}
                locations={[0, 0.45, 1]}
                style={StyleSheet.absoluteFill}
              />
            </Animated.View>
          )}

          {!activeTrack?.coverArt && (
            <Animated.View style={[StyleSheet.absoluteFill, gradientOverlayAnimatedStyle]} pointerEvents="none">
              <LinearGradient
                colors={['#120d1400', '#120d14']}
                style={StyleSheet.absoluteFill}
              />
            </Animated.View>
          )}

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
            insets={insets}
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
                paddingTop: effectiveTopInset + 6,
                paddingBottom: 0,
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
                    {/* Top Grabber / Pull Trigger & Sub-header */}
                    <Animated.View style={[{ width: '100%' }, topGrabberAnimatedStyle]}>
                      <TouchableOpacity
                        onPress={handleClose}
                        hitSlop={{ top: 15, bottom: 20, left: 40, right: 40 }}
                        activeOpacity={0.6}
                        style={styles.topGrabberContainer}
                      >
                        <View style={styles.topGrabberPill} />
                      </TouchableOpacity>

                      <View style={styles.topHeaderRow}>
                        <View style={{ flex: 1 }} />
                        <View style={styles.topHeaderRight}>
                          <TrackLoadingBadge
                            isLoading={isLoading}
                            isBufferingSlow={isBufferingSlow}
                            networkStatus={networkStatus}
                            nextTrackStatus={nextTrackStatus}
                          />

                          <MenuView
                            title={displayTitle}
                            onPressAction={handleMenuAction}
                            actions={menuActions}
                            shouldOpenOnLongPress={false}
                          >
                            <View
                              style={styles.topMenuButton}
                              accessibilityRole="button"
                              accessibilityLabel="Track options"
                            >
                              <Ionicons name="ellipsis-horizontal" size={17} color="#ffffff" />
                            </View>
                          </MenuView>
                        </View>
                      </View>
                    </Animated.View>

                    <GestureDetector gesture={albumHorizontalGesture}>
                      <Animated.View
                        style={[styles.artContainer, albumArtFlipStyle]}
                        accessibilityRole="image"
                        accessibilityLabel={displayTitle ? `${displayTitle} by ${displayArtist}, album cover` : 'Album cover'}
                        accessibilityHint="Swipe left for next track, swipe right for previous track, swipe down to close"
                      >
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
                    </GestureDetector>

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
              <PlayerNetworkBanner
                networkStatus={networkStatus}
                nextTrackStatus={nextTrackStatus}
                networkError={networkError}
                isBufferingSlow={isBufferingSlow}
                onRetry={onRetryPreload}
                onSkip={fetchNextTrack}
              />
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
                onToggleQueue={toggleQueue}
                onToggleLyrics={handleToggleLyrics}
              />
              <GestureDetector gesture={bottomSwipeGesture}>
                <View
                  style={{
                    width: '100%',
                    height: (insets?.bottom || 34) + 12,
                    backgroundColor: 'transparent',
                  }}
                />
              </GestureDetector>
            </Animated.View>

          </Animated.View>
        </View>
      </GestureHandlerRootView>
    </Animated.View>
  );
};


export default FullPlayerModal;
