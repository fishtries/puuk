import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  AccessibilityInfo,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  parseLrc,
  isLrcSynced,
  extractPlainLyrics,
} from '../../../utils/lrcParser';
import { authFetch } from '../../../shared/api/api';
import { getTrackId } from '../../../shared/domain/trackAdapter';
import { usePlaybackPosition } from '../../../hooks/playbackStatus';

import Animated, {
  useSharedValue,
  useReducedMotion,
  useAnimatedStyle,
  useAnimatedReaction,
  withSpring,
  withTiming,
  withDecay,
  runOnJS,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';

import AnimatedLyricLine from './AnimatedLyricLine';
import { TopBlurOverlay, BottomBlurOverlay } from '../BlurOverlays';
import { computeActiveLyricIndex } from './lyricDepth';
import { parsePlainLyrics } from './plainLyrics';
import {
  validateAndParseWordLyrics,
  computeActiveWordLineIndex,
} from './wordLyricsParser';

const LyricSpacer = React.memo(function LyricSpacer({ index, height }) {
  return <View testID={`lyric-spacer-${index}`} accessible={false} style={{ height }} />;
});

const LYRIC_LINE_STYLE = {
  color: '#ffffff', fontSize: 23, fontWeight: '700', textAlign: 'left',
  marginVertical: 24, lineHeight: 33, letterSpacing: -0.4,
};

const createLyricsStyles = ({
  width,
  height,
  insets,
  isEffectivelyCompact,
}) => ({
  appleLyricsContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: width,
    height: height,
    backgroundColor: 'transparent',
  },
  lyricsMiniHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 30,
    height: 40,
  },
  lyricsMiniArtSpacer: {
    width: 44,
    height: 44,
    marginRight: 16,
  },
  lyricsMiniTextContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  lyricsMiniTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: 'bold',
    letterSpacing: -0.25,
  },
  lyricsMiniArtist: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    letterSpacing: -0.125,
  },
  syncedLyricsWrapper: {
    flex: 1,
    width: width,
    height: height,
    overflow: 'hidden',
  },
  syncedLyricsList: {
    width: width,
    paddingTop: (insets?.top || 47) + 115,
    paddingBottom: isEffectivelyCompact
      ? (insets?.bottom || 34) + 160
      : (insets?.bottom || 34) + 235,
    paddingHorizontal: 30,
  },
  lyricsScrollView: {
    width: width,
    height: height,
  },
  lyricLine: LYRIC_LINE_STYLE,
  noLyricsText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 18,
    textAlign: 'center',
    marginTop: 100,
  },
  lyricsHeartBtn: {
    padding: 6,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
  },
  plainLyricsWrapper: {
    paddingVertical: 10,
    paddingBottom: 40,
  },
  plainSectionTitle: {
    color: '#FFDAB9',
    fontSize: 14,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginTop: 22,
    marginBottom: 8,
  },
  plainLyricText: {
    color: '#ffffff',
    fontSize: 21,
    fontWeight: '600',
    lineHeight: 34,
    letterSpacing: -0.3,
    marginVertical: 4,
    textAlign: 'left',
  },
  plainStanzaSpacer: {
    height: 18,
  },
});

const AppleLyricsView = ({
  player,
  isLyricsView,
  isLyricsMounted,
  currentTrack,
  currentTime: fallbackTime,
  isPlayerVisible,
  isQueueVisible,
  seekTo,
  onToggleLike,
  trackIsLiked,
  displayTitle,
  displayArtist,
  insets,
  width,
  height,
  contentAnimatedStyle,
  lyricsTransition,
  lyricsRotation,
  lyricsViewAnimatedStyle,
  lyricsMiniHeaderAnimatedStyle,
  lyricsMiniTextAnimatedStyle,
  lyricsMiniHeartAnimatedStyle,
  lyricsContentAnimatedStyle,
  setIsLyricsView,
  setIsLyricsMounted,
  lyricsHeaderSwipeGesture,
  onClose,
  onExitCompactMode,
  onLyricsCompactChange,
  onRegisterResetTimer,
  isControlsInteractionActive = false,
}) => {
  const position = usePlaybackPosition(player, isPlayerVisible);
  const currentTime = player ? position.currentTime : fallbackTime;
  const [lyrics, setLyrics] = useState([]);
  const [plainLyricsText, setPlainLyricsText] = useState('');
  const [hasSyncedLyrics, setHasSyncedLyrics] = useState(false);
  const [hasWordLyrics, setHasWordLyrics] = useState(false);
  const isLyricsMountedRef = useRef(false);
  isLyricsMountedRef.current = isLyricsMounted;

  const [isLoadingLyrics, setIsLoadingLyrics] = useState(false);
  const lyricsScrollRef = useRef(null);
  const { fontScale } = useWindowDimensions();
  const [isScreenReaderEnabled, setIsScreenReaderEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.resolve(AccessibilityInfo.isScreenReaderEnabled()).then(enabled => {
      if (live) setIsScreenReaderEnabled(Boolean(enabled));
    });
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setIsScreenReaderEnabled);
    return () => { live = false; subscription?.remove(); };
  }, []);

  // Wave motion states & refs matching web version (AppleLyricsStream.tsx)
  const [baseTargetY, setBaseTargetY] = useState(0);
  const baseTargetYShared = useSharedValue(0);
  const manualScrollY = useSharedValue(0);
  const returnOpacity = useSharedValue(1);
  const pendingReturnFade = useRef(false);
  const reducedMotion = useReducedMotion();
  const dragStartY = useSharedValue(0);
  const contentHeight = useSharedValue(800);
  const heightShared = useSharedValue(height);

  useEffect(() => {
    heightShared.value = height;
  }, [height]);

  const [isManualScrolling, setIsManualScrolling] = useState(false);
  const isManualScrollingRef = useRef(false);
  isManualScrollingRef.current = isManualScrolling;

  const [isInitialMount, setIsInitialMount] = useState(true);
  const manualScrollTimeoutRef = useRef(null);
  const lyricLayouts = useRef({ context: null, heights: {} });
  const [layoutVersion, setLayoutVersion] = useState(0);
  const layoutFrame = useRef(null);
  const [scrollWindowY, setScrollWindowY] = useState(0);
  const heightRef = useRef(height);
  heightRef.current = height;

  // Track dragging AND native decay on the UI thread. React moves its render
  // window only every half viewport; the finger never waits for a React frame.
  useAnimatedReaction(
    () => Math.round(manualScrollY.value / Math.max(1, heightShared.value / 2)),
    (bucket, previous) => {
      if (bucket !== previous) runOnJS(setScrollWindowY)(bucket * heightShared.value / 2);
    },
  );

  const [isLyricsCompact, setIsLyricsCompact] = useState(false);
  const isLyricsCompactRef = useRef(false);
  isLyricsCompactRef.current = isLyricsCompact;
  const isEffectivelyCompact = isLyricsView && isLyricsCompact;
  const inactivityTimerRef = useRef(null);
  const controlsInteractionRef = useRef(isControlsInteractionActive);
  controlsInteractionRef.current = isControlsInteractionActive;

  useEffect(() => {
    if (onLyricsCompactChange) {
      onLyricsCompactChange(isLyricsCompact);
    }
  }, [isLyricsCompact, onLyricsCompactChange]);

  useEffect(() => {
    if (isLyricsView) {
      setIsLyricsMounted(true);
      isLyricsMountedRef.current = true;
      cancelAnimation(lyricsTransition);
      cancelAnimation(lyricsRotation);
      lyricsTransition.value = withTiming(1, {
        duration: 750,
        easing: Easing.bezier(0.16, 1, 0.3, 1),
      });
      lyricsRotation.value = withTiming(360, {
        duration: 850,
        easing: Easing.out(Easing.back(1)),
      });
    } else {
      cancelAnimation(lyricsTransition);
      cancelAnimation(lyricsRotation);
      if (!isPlayerVisible) {
        lyricsTransition.value = 0;
        lyricsRotation.value = 0;
        setIsLyricsMounted(false);
        isLyricsMountedRef.current = false;
        return;
      }
      if (isLyricsMountedRef.current) {
        lyricsTransition.value = withTiming(
          0,
          {
            duration: 500,
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          },
          (finished) => {
            if (finished) {
              runOnJS(setIsLyricsMounted)(false);
            }
          },
        );
        lyricsRotation.value = withTiming(0, {
          duration: 500,
          easing: Easing.out(Easing.cubic),
        });
      } else {
        lyricsTransition.value = 0;
        lyricsRotation.value = 0;
        setIsLyricsMounted(false);
        isLyricsMountedRef.current = false;
      }
    }
  }, [
    isLyricsView,
    isPlayerVisible,
    lyricsTransition,
    lyricsRotation,
    setIsLyricsMounted,
  ]);

  const resetInactivityTimer = useCallback(() => {
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    if (isLyricsView && !isLyricsCompactRef.current && !controlsInteractionRef.current) {
      inactivityTimerRef.current = setTimeout(() => {
        isLyricsCompactRef.current = true;
        setIsLyricsCompact(true);
      }, 3000);
    }
  }, [isLyricsView]);

  useEffect(() => {
    resetInactivityTimer();
  }, [isControlsInteractionActive, resetInactivityTimer]);

  useEffect(() => {
    if (isLyricsView) {
      isLyricsCompactRef.current = false;
      setIsLyricsCompact(false);
      resetInactivityTimer();
    } else {
      isLyricsCompactRef.current = false;
      setIsLyricsCompact(false);
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
      }
    }
  }, [isLyricsView, resetInactivityTimer]);

  const exitCompactMode = useCallback(() => {
    isLyricsCompactRef.current = false;
    setIsLyricsCompact(false);
    resetInactivityTimer();
  }, [resetInactivityTimer]);

  const onExitCompactModeRef = useRef(onExitCompactMode);
  onExitCompactModeRef.current = onExitCompactMode;
  useEffect(() => {
    if (onExitCompactModeRef.current) {
      onExitCompactModeRef.current(exitCompactMode);
    }
  }, [exitCompactMode]);

  const onRegisterResetTimerRef = useRef(onRegisterResetTimer);
  onRegisterResetTimerRef.current = onRegisterResetTimer;
  useEffect(() => {
    if (onRegisterResetTimerRef.current) {
      onRegisterResetTimerRef.current(resetInactivityTimer);
    }
  }, [resetInactivityTimer]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const trackId = getTrackId(currentTrack);
  const layoutContext = `${trackId}:${width}:${fontScale}`;
  if (lyricLayouts.current.context !== layoutContext) {
    lyricLayouts.current = { context: layoutContext, heights: {} };
  }
  const lineLayouts = useMemo(() => {
    // Use estimates only for rows that have not entered the measured window.
    // The same heights size spacers and locate the active row, so opening a
    // long song never needs to mount every text/animation subtree at once.
    const scale = fontScale || 1;
    const charsPerRow = Math.max(1, Math.floor((width - 60) / (LYRIC_LINE_STYLE.fontSize * scale * 0.52)));
    let y = (insets?.top || 47) + 115;
    return lyrics.map((line, index) => {
      const measured = lyricLayouts.current.heights[index];
      const rows = measured == null ? line.text.split('\n').reduce((count, text) =>
        count + Math.max(1, Math.ceil(Array.from(text).length / charsPerRow)), 0) : 0;
      const lineHeight = measured ?? LYRIC_LINE_STYLE.marginVertical * 2 + LYRIC_LINE_STYLE.lineHeight * scale * rows;
      const layout = { y, height: lineHeight };
      y += lineHeight;
      return layout;
    });
  }, [lyrics, layoutVersion, layoutContext, width, fontScale, insets?.top]);
  const trackIdRef = useRef(trackId);
  trackIdRef.current = trackId;

  // Reset flags and scroll positions on track change
  useEffect(() => {
    if (manualScrollTimeoutRef.current) {
      clearTimeout(manualScrollTimeoutRef.current);
    }
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
    }
    cancelAnimation(manualScrollY);
    manualScrollY.value = 0;
    pendingReturnFade.current = false;
    returnOpacity.value = 1;
    setScrollWindowY(0);
    setIsManualScrolling(false);
    isManualScrollingRef.current = false;
    setBaseTargetY(0);
    baseTargetYShared.value = 0;
    setIsInitialMount(true);
    if (isLyricsView) {
      isLyricsCompactRef.current = false;
      setIsLyricsCompact(false);
      resetInactivityTimer();
    }
  }, [trackId, isLyricsView, resetInactivityTimer]);

  // Transition from initial snap mount to animated wave springs
  useEffect(() => {
    if (isInitialMount) {
      const t = setTimeout(() => {
        setIsInitialMount(false);
      }, 250);
      return () => clearTimeout(t);
    }
  }, [isInitialMount]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (manualScrollTimeoutRef.current) {
        clearTimeout(manualScrollTimeoutRef.current);
      }
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
      }
      if (layoutFrame.current !== null) cancelAnimationFrame(layoutFrame.current);
    };
  }, []);

  // Fetch track lyrics with race-condition guard (A -> B -> A) and HTTP status check
  useEffect(() => {
    let isCancelled = false;
    const currentTrackId = trackId;

    if (
      currentTrackId !== null &&
      currentTrackId !== undefined &&
      String(currentTrackId).trim() !== ''
    ) {
      setIsLoadingLyrics(true);
      setLyrics([]);
      setPlainLyricsText('');
      setHasSyncedLyrics(false);
      setHasWordLyrics(false);

      authFetch(`/api/tracks/${encodeURIComponent(String(currentTrackId))}/lyrics`)
        .then((res) => {
          if (
            res.ok === false ||
            (res.status !== undefined && (res.status < 200 || res.status >= 300))
          ) {
            throw new Error(`HTTP ${res.status}`);
          }
          return res.json();
        })
        .then((data) => {
          if (isCancelled || trackIdRef.current !== currentTrackId) {
            return;
          }

          if (data && data.wordLyrics) {
            const parsedWord = validateAndParseWordLyrics(data.wordLyrics, currentTrackId);
            if (parsedWord) {
              setHasWordLyrics(true);
              setHasSyncedLyrics(true);
              setLyrics(parsedWord.lines);
              const plain =
                data.plainLyrics || parsedWord.lines.map((l) => l.text).join('\n');
              setPlainLyricsText(plain);
              return;
            }
          }

          setHasWordLyrics(false);
          if (data && data.lyrics) {
            const raw = data.lyrics;
            const isSynced =
              data.isSynced !== undefined ? data.isSynced : isLrcSynced(raw);
            setHasSyncedLyrics(isSynced);

            const parsed = parseLrc(raw);
            setLyrics(parsed);

            // Plain text fallback
            const plain = data.plainLyrics || extractPlainLyrics(raw);
            setPlainLyricsText(plain);
          } else {
            setLyrics([]);
            setPlainLyricsText('');
            setHasSyncedLyrics(false);
          }
        })
        .catch(() => {
          if (isCancelled || trackIdRef.current !== currentTrackId) {
            return;
          }
          setLyrics([]);
          setPlainLyricsText('');
          setHasSyncedLyrics(false);
          setHasWordLyrics(false);
        })
        .finally(() => {
          if (!isCancelled && trackIdRef.current === currentTrackId) {
            setIsLoadingLyrics(false);
          }
        });
    } else {
      setLyrics([]);
      setPlainLyricsText('');
      setHasSyncedLyrics(false);
      setHasWordLyrics(false);
      setIsLoadingLyrics(false);
    }

    return () => {
      isCancelled = true;
    };
  }, [trackId]);

  // Active lyric index computation (word-level or line-level)
  const activeIndex = useMemo(() => {
    if (!hasSyncedLyrics || lyrics.length === 0) return -1;
    if (hasWordLyrics) {
      return computeActiveWordLineIndex(lyrics, currentTime);
    }
    return computeActiveLyricIndex(lyrics, currentTime);
  }, [hasSyncedLyrics, hasWordLyrics, lyrics, currentTime]);

  // Resolve focus in the same render as highlighting. An effect-driven target
  // gives the new active line one commit of color with its old position.
  const activeLayout = lineLayouts[activeIndex];
  const activeTargetY = activeLayout && hasSyncedLyrics
    ? Math.max(160, height * 0.4) - activeLayout.y - activeLayout.height / 2 : 0;
  const focusedTargetY = !isManualScrolling && isPlayerVisible
    ? activeTargetY : baseTargetY;
  const activeTargetRef = useRef(activeTargetY);
  activeTargetRef.current = activeTargetY;
  const baseTargetRef = useRef(baseTargetY);
  baseTargetRef.current = baseTargetY;

  useEffect(() => {
    setBaseTargetY((previous) => Math.abs(previous - focusedTargetY) > 0.5 ? focusedTargetY : previous);
  }, [focusedTargetY]);

  useEffect(() => {
    baseTargetYShared.value = baseTargetY;
  }, [baseTargetY, baseTargetYShared]);

  // Record line layout from children
  const handleLineLayout = useCallback((index, _y, lineHeight) => {
    if (lyricLayouts.current.context !== layoutContext) return;
    const previous = lyricLayouts.current.heights[index];
    if (previous != null && Math.abs(previous - lineHeight) < 0.5) return;
    lyricLayouts.current.heights[index] = lineHeight;
    // Batch native measurements so a long song doesn't cause a React commit
    // for every measured line. Reconcile estimates when a row enters the window.
    if (layoutFrame.current === null) {
      layoutFrame.current = requestAnimationFrame(() => {
        layoutFrame.current = null;
        setLayoutVersion(version => version + 1);
      });
    }
  }, [layoutContext]);

  useEffect(() => {
    if (!isManualScrolling && pendingReturnFade.current) {
      pendingReturnFade.current = false;
      returnOpacity.value = withTiming(1, { duration: 150 });
    }
  }, [isManualScrolling, returnOpacity]);

  // Manual scroll gesture handlers with full 60/120fps UI-thread momentum
  const handleManualScrollStart = useCallback(() => {
    pendingReturnFade.current = false;
    cancelAnimation(returnOpacity);
    returnOpacity.value = 1;
    if (manualScrollTimeoutRef.current) {
      clearTimeout(manualScrollTimeoutRef.current);
    }
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
    }
    if (!isManualScrollingRef.current) {
      setIsManualScrolling(true);
      isManualScrollingRef.current = true;
    }
  }, [returnOpacity]);

  const handleManualScrollFinished = useCallback(() => {
    setIsManualScrolling(false);
    isManualScrollingRef.current = false;
  }, []);

  const scheduleManualScrollResume = useCallback(() => {
    if (!isManualScrollingRef.current) return;
    if (manualScrollTimeoutRef.current) {
      clearTimeout(manualScrollTimeoutRef.current);
    }
    if (!isLyricsCompactRef.current) {
      resetInactivityTimer();
    }
    manualScrollTimeoutRef.current = setTimeout(() => {
      const distance = Math.abs(baseTargetRef.current + manualScrollY.value - activeTargetRef.current);
      cancelAnimation(manualScrollY);
      if (reducedMotion || distance >= heightRef.current) {
        // Jump between render windows instead of mounting every intermediate
        // window during a multi-screen spring. Reveal only the destination.
        pendingReturnFade.current = !reducedMotion;
        returnOpacity.value = reducedMotion ? 1 : 0;
        setIsInitialMount(true);
        setScrollWindowY(0);
        manualScrollY.value = 0;
      } else {
        manualScrollY.value = withSpring(0, { damping: 26, stiffness: 200, mass: 0.8 });
      }
      handleManualScrollFinished();
    }, 3000);
  }, [resetInactivityTimer, handleManualScrollFinished, manualScrollY, reducedMotion, returnOpacity]);

  // Native touch completion is a fallback when a recognizer is detached or
  // cancelled before its worklet finalizer reaches JS. It also covers taps.
  const handleLyricsTouchFinished = useCallback(() => {
    if (isManualScrollingRef.current) {
      scheduleManualScrollResume();
    } else {
      resetInactivityTimer();
    }
  }, [scheduleManualScrollResume, resetInactivityTimer]);

  // Handle line click: cancel manual scroll, reset offset, and seek
  const handleLineClick = useCallback(
    (time) => {
      setIsInitialMount(true);
      if (manualScrollTimeoutRef.current) {
        clearTimeout(manualScrollTimeoutRef.current);
      }
      cancelAnimation(manualScrollY);
      manualScrollY.value = withSpring(0, {
        damping: 26,
        stiffness: 220,
        mass: 0.8,
      });
      setIsManualScrolling(false);
      isManualScrollingRef.current = false;
      if (time !== null && seekTo) {
        seekTo(time);
      }
      if (!isLyricsCompactRef.current) {
        resetInactivityTimer();
      }
    },
    [seekTo, resetInactivityTimer, manualScrollY],
  );

  const panGesture = useMemo(() => {
    return Gesture.Pan()
      .activeOffsetY([-6, 6])
      .failOffsetX([-35, 35])
      .onStart(() => {
        'worklet';
        cancelAnimation(manualScrollY);
        dragStartY.value = manualScrollY.value;
        runOnJS(handleManualScrollStart)();
      })
      .onUpdate((event) => {
        'worklet';
        const focalY = Math.max(160, heightShared.value * 0.4);
        const cHeight = Math.max(heightShared.value, contentHeight.value);
        const maxS = Math.max(0, -baseTargetYShared.value + 60);
        const minS = Math.min(
          0,
          -(cHeight - focalY) - baseTargetYShared.value - 120,
        );

        const next = dragStartY.value + event.translationY;
        if (next > maxS) {
          manualScrollY.value = maxS + (next - maxS) * 0.35;
        } else if (next < minS) {
          manualScrollY.value = minS + (next - minS) * 0.35;
        } else {
          manualScrollY.value = next;
        }
      })
      .onEnd((event) => {
        'worklet';
        const focalY = Math.max(160, heightShared.value * 0.4);
        const cHeight = Math.max(heightShared.value, contentHeight.value);
        const maxS = Math.max(0, -baseTargetYShared.value + 60);
        const minS = Math.min(
          0,
          -(cHeight - focalY) - baseTargetYShared.value - 120,
        );

        if (manualScrollY.value > maxS) {
          manualScrollY.value = withSpring(maxS, {
            damping: 24,
            stiffness: 200,
          });
        } else if (manualScrollY.value < minS) {
          manualScrollY.value = withSpring(minS, {
            damping: 24,
            stiffness: 200,
          });
        } else {
          manualScrollY.value = withDecay({
            velocity: event.velocityY,
            clamp: [minS, maxS],
            rubberBandEffect: true,
            rubberBandFactor: 0.6,
            deceleration: 0.998,
          });
        }
      })
      .onFinalize(() => {
        'worklet';
        // Also runs for cancellation by another gesture / system interruption.
        runOnJS(scheduleManualScrollResume)();
      });
  }, [
    handleManualScrollStart,
    scheduleManualScrollResume,
    manualScrollY,
    dragStartY,
    heightShared,
    contentHeight,
    baseTargetYShared,
  ]);

  const animatedListStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateY: manualScrollY.value }],
      opacity: returnOpacity.value,
    };
  });

  const internalLyricsOverlaysStyle = useAnimatedStyle(() => {
    if (!lyricsTransition) return { opacity: 1 };
    const val =
      typeof lyricsTransition.value === 'number' ? lyricsTransition.value : 1;
    const clamped = Math.max(0.2, Math.min(0.85, val));
    const opacity = (clamped - 0.2) / 0.65;
    return { opacity };
  });

  const styles = useMemo(
    () =>
      createLyricsStyles({
        width,
        height,
        insets,
        isEffectivelyCompact,
      }),
    [width, height, insets?.top, insets?.bottom, isEffectivelyCompact],
  );

  const currentMs = Math.round((currentTime || 0) * 1000);
  // React only needs word phase transitions. The shared audio clock below
  // supplies intermediate sweep positions without rebuilding every lyric row.
  const wordBoundaries = useMemo(() => [...new Set(lyrics.flatMap(line =>
    (line.words || []).flatMap(word => [word.startMs, word.endMs + 60])
  ))].sort((a, b) => a - b), [lyrics]);
  let boundaryLow = 0;
  let boundaryHigh = wordBoundaries.length;
  while (boundaryLow < boundaryHigh) {
    const middle = (boundaryLow + boundaryHigh) >>> 1;
    if (wordBoundaries[middle] <= currentMs) boundaryLow = middle + 1;
    else boundaryHigh = middle;
  }
  const wordRenderMs = boundaryLow > 0 ? wordBoundaries[boundaryLow - 1] : -1;
  const playbackMs = useSharedValue(currentMs);
  const lastPlaybackMs = useRef(currentMs);
  useEffect(() => {
    const delta = currentMs - lastPlaybackMs.current;
    lastPlaybackMs.current = currentMs;
    // Smooth observed audio positions only; never extrapolate past a pause.
    playbackMs.value = reducedMotion || delta <= 0 || delta > 250
      ? currentMs
      : withTiming(currentMs, { duration: 100, easing: Easing.linear });
  }, [currentMs, playbackMs, reducedMotion]);

  const linePressHandlers = useMemo(
    () => lyrics.map((line) => () => handleLineClick(line.time)),
    [lyrics, handleLineClick],
  );

  const renderedSyncedLyrics = useMemo(() => {
    if (!isPlayerVisible && !isLyricsView && !isLyricsMounted) return null;
    if (!hasSyncedLyrics || lyrics.length === 0) return null;
    return lyrics.map((line, idx) => {
      const rowKey = `${layoutContext}:${line.id || idx}`;
      const isActive = activeIndex >= 0 && idx === activeIndex;
      const layout = lineLayouts[idx];
      const top = layout.y + focusedTargetY + scrollWindowY;
      const destinationTop = layout.y + activeTargetY;
      const inReturnViewport = isManualScrolling && destinationTop + layout.height >= 0 && destinationTop <= height;
      // Keep one viewport of overscan on each side. Measured spacers preserve
      // the natural positions and scroll bounds of multiline and word lyrics.
      if (!isScreenReaderEnabled && !isActive && !inReturnViewport &&
          (top + layout.height < -height || top > height * 2)) {
        return <LyricSpacer key={rowKey} index={idx} height={layout.height} />;
      }
      return (
        <AnimatedLyricLine
          key={rowKey}
          text={line.text}
          index={idx}
          activeIndex={activeIndex}
          targetY={focusedTargetY}
          isActive={isActive}
          isInitial={isInitialMount}
          isManualScrolling={isManualScrolling}
          baseStyle={styles.lyricLine}
          onLayout={handleLineLayout}
          onPress={linePressHandlers[idx]}
          words={line.words}
          segments={line.segments}
          hasWordTimings={Boolean(line.hasWordTimings)}
          currentMs={line.hasWordTimings
            ? wordRenderMs < line.startMs ? -1 : Math.min(wordRenderMs, line.endMs + 60)
            : 0}
          playbackMs={playbackMs}
        />
      );
    });
  }, [
    isPlayerVisible,
    isLyricsView,
    isLyricsMounted,
    layoutContext,
    trackId,
    width,
    fontScale,
    layoutVersion,
    lineLayouts,
    scrollWindowY,
    height,
    isScreenReaderEnabled,
    hasSyncedLyrics,
    lyrics,
    activeIndex,
    activeTargetY,
    focusedTargetY,
    isInitialMount,
    isManualScrolling,
    styles.lyricLine,
    handleLineLayout,
    linePressHandlers,
    wordRenderMs,
    playbackMs,
  ]);

  const renderedPlainLyrics = useMemo(() => {
    if (!plainLyricsText || plainLyricsText.trim().length === 0) return null;
    return parsePlainLyrics(
      plainLyricsText || lyrics.map((l) => l.text).join('\n'),
    ).map((row, idx) => {
      if (row.type === 'stanza') {
        return <View key={idx} style={styles.plainStanzaSpacer} />;
      }
      if (row.type === 'header') {
        return (
          <Text key={idx} style={styles.plainSectionTitle}>
            {row.text}
          </Text>
        );
      }
      return (
        <Text key={idx} style={styles.plainLyricText}>
          {row.text}
        </Text>
      );
    });
  }, [
    plainLyricsText,
    lyrics,
    styles.plainStanzaSpacer,
    styles.plainSectionTitle,
    styles.plainLyricText,
  ]);

  const renderedHeader = useMemo(() => (
    <GestureDetector gesture={lyricsHeaderSwipeGesture}>
      <Animated.View style={[styles.lyricsMiniHeader, lyricsMiniHeaderAnimatedStyle, {
        zIndex: 20, position: 'absolute', top: 0, left: 0, right: 0,
        paddingTop: (insets?.top || 47) + 10, height: (insets?.top || 47) + 64,
        backgroundColor: 'transparent', paddingHorizontal: 30,
      }]}>
        <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}
          onPress={() => setIsLyricsView(false)} activeOpacity={0.8}>
          <View style={styles.lyricsMiniArtSpacer} />
          <Animated.View style={[styles.lyricsMiniTextContainer, lyricsMiniTextAnimatedStyle]}>
            <Text style={styles.lyricsMiniTitle} numberOfLines={1}>{displayTitle}</Text>
            <Text style={styles.lyricsMiniArtist} numberOfLines={1}>{displayArtist}</Text>
          </Animated.View>
        </TouchableOpacity>
        <Animated.View style={lyricsMiniHeartAnimatedStyle}>
          <TouchableOpacity onPress={() => onToggleLike && onToggleLike()}
            hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }} style={styles.lyricsHeartBtn}>
            <Ionicons name={trackIsLiked ? 'heart' : 'heart-outline'} size={24}
              color={trackIsLiked ? '#ff2d55' : '#e5e5ea'} />
          </TouchableOpacity>
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  ), [lyricsHeaderSwipeGesture, styles, lyricsMiniHeaderAnimatedStyle,
    lyricsMiniTextAnimatedStyle, lyricsMiniHeartAnimatedStyle, insets?.top,
    setIsLyricsView, displayTitle, displayArtist, onToggleLike, trackIsLiked]);

  return (
    <>
      {(isPlayerVisible || isLyricsView || isLyricsMounted) && (
        <Animated.View
          style={[
            styles.appleLyricsContainer,
            contentAnimatedStyle,
            lyricsViewAnimatedStyle,
            {
              position: 'absolute',
              top: 0,
              left: 0,
              width: width,
              height: height,
              zIndex: 5,
            },
          ]}
          pointerEvents={
            !isPlayerVisible || isQueueVisible || !isLyricsView
              ? 'none'
              : 'auto'
          }
        >
          {/* Header changes with track/actions, never with audio position. */}
          {renderedHeader}

          {/* Body */}
          <Animated.View
            style={[
              { flex: 1, width: '100%', overflow: 'hidden' },
              lyricsContentAnimatedStyle,
            ]}
          >
            {isLoadingLyrics ? (
              <ActivityIndicator
                color="#fff"
                size="large"
                style={{ marginTop: 200 }}
              />
            ) : hasSyncedLyrics && lyrics.length > 0 ? (
              /* Synced Lyrics with Staggered Traffic-Jam Wave Propagation */
              <GestureDetector gesture={panGesture}>
                <Animated.View style={styles.syncedLyricsWrapper}
                  onTouchEnd={handleLyricsTouchFinished}
                  onTouchCancel={handleLyricsTouchFinished}>
                  <Animated.View
                    style={[styles.syncedLyricsList, animatedListStyle]}
                    onLayout={(e) => {
                      contentHeight.value = e.nativeEvent.layout.height;
                    }}
                  >
                    {renderedSyncedLyrics}
                  </Animated.View>
                </Animated.View>
              </GestureDetector>
            ) : plainLyricsText && plainLyricsText.trim().length > 0 ? (
              /* Plain Unsynced Lyrics fallback */
              <ScrollView
                ref={lyricsScrollRef}
                style={styles.lyricsScrollView}
                showsVerticalScrollIndicator={false}
                onScrollBeginDrag={() => {
                  if (inactivityTimerRef.current) {
                    clearTimeout(inactivityTimerRef.current);
                  }
                }}
                onScrollEndDrag={() => {
                  if (!isLyricsCompactRef.current) {
                    resetInactivityTimer();
                  }
                }}
                onMomentumScrollEnd={() => {
                  if (!isLyricsCompactRef.current) {
                    resetInactivityTimer();
                  }
                }}
                contentContainerStyle={{
                  paddingTop: insets.top + 115,
                  paddingBottom: isEffectivelyCompact
                    ? (insets.bottom || 34) + 160
                    : (insets.bottom || 34) + 235,
                  paddingHorizontal: 30,
                }}
              >
                <View style={styles.plainLyricsWrapper}>
                  {renderedPlainLyrics}
                </View>
              </ScrollView>
            ) : (
              <Text style={styles.noLyricsText}>Lyrics not found</Text>
            )}
          </Animated.View>

          {/* Top and Bottom Blur Vignettes */}
          <Animated.View
            style={[StyleSheet.absoluteFill, internalLyricsOverlaysStyle]}
            pointerEvents="none"
          >
            <TopBlurOverlay insets={insets} />
            <BottomBlurOverlay insets={insets} />
          </Animated.View>
        </Animated.View>
      )}
    </>
  );
};

export default React.memo(AppleLyricsView);
