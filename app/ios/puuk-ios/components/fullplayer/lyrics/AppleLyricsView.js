import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  StyleSheet
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { parseLrc, isLrcSynced, extractPlainLyrics } from '../../../utils/lrcParser';
import { authFetch } from '../../../utils/api';

import Animated, {
  withTiming,
  runOnJS,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import { GestureDetector } from 'react-native-gesture-handler';

import AnimatedLyricLine from './AnimatedLyricLine';
import { TopBlurOverlay, BottomBlurOverlay } from '../BlurOverlays';
import { computeActiveLyricIndex } from './lyricDepth';

const createLyricsStyles = ({
  width,
  height,
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
  },
  lyricsMiniTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  lyricsMiniArtist: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 14,
  },
  lyricsScrollView: {
    width: width,
    height: height,
  },
  lyricLine: {
    color: '#ffffff',
    fontSize: 23,
    fontWeight: '700',
    textAlign: 'left',
    marginVertical: 24,
    lineHeight: 33,
    letterSpacing: -0.4,
  },
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
  }
});

const AppleLyricsView = ({
  isLyricsView,
  isLyricsMounted,
  currentTrack,
  currentTime,
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
  animatedBgStyle,
  lyricsViewAnimatedStyle,
  lyricsMiniHeaderAnimatedStyle,
  lyricsMiniTextAnimatedStyle,
  lyricsMiniHeartAnimatedStyle,
  lyricsOverlaysAnimatedStyle,
  lyricsContentAnimatedStyle,
  setIsLyricsView,
  setIsLyricsMounted,
  lyricsHeaderSwipeGesture,
  onClose,
  onExitCompactMode,
  onLyricsCompactChange,
}) => {
  const [lyrics, setLyrics] = useState([]);
  const [plainLyricsText, setPlainLyricsText] = useState('');
  const [hasSyncedLyrics, setHasSyncedLyrics] = useState(false);
  const isLyricsMountedRef = useRef(false);
  isLyricsMountedRef.current = isLyricsMounted;

  const [isLoadingLyrics, setIsLoadingLyrics] = useState(false);
  const [isAutoScrollPaused, setIsAutoScrollPaused] = useState(false);
  const lyricsScrollRef = useRef(null);
  const lyricLayouts = useRef({});

  const [isLyricsCompact, setIsLyricsCompact] = useState(false);
  const isLyricsCompactRef = useRef(false);
  isLyricsCompactRef.current = isLyricsCompact;
  const isEffectivelyCompact = isLyricsView && isLyricsCompact;
  const inactivityTimerRef = useRef(null);

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
        lyricsTransition.value = withTiming(0, {
          duration: 500,
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        }, (finished) => {
          if (finished) {
            runOnJS(setIsLyricsMounted)(false);
          }
        });
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
  }, [isLyricsView, isPlayerVisible]);

  const resetInactivityTimer = useCallback(() => {
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    if (isLyricsView && !isLyricsCompactRef.current) {
      inactivityTimerRef.current = setTimeout(() => {
        setIsLyricsCompact(true);
      }, 7000);
    }
  }, [isLyricsView]);

  const exitCompactMode = useCallback(() => {
    setIsLyricsCompact(false);
    resetInactivityTimer();
  }, [resetInactivityTimer]);

  const exitCompactModeRef = useRef(exitCompactMode);
  exitCompactModeRef.current = exitCompactMode;

  const onExitCompactModeRef = useRef(onExitCompactMode);
  onExitCompactModeRef.current = onExitCompactMode;
  useEffect(() => {
    if (onExitCompactModeRef.current) {
      onExitCompactModeRef.current(exitCompactMode);
    }
  }, [exitCompactMode]);

  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;

  const lyricsRef = useRef(lyrics);
  lyricsRef.current = lyrics;

  const isLyricsViewRef = useRef(isLyricsView);
  isLyricsViewRef.current = isLyricsView;

  const lastScrolledIndexRef = useRef(-1);
  const lyricsInteractionTimerRef = useRef(null);
  const isLyricsInteractingRef = useRef(false);
  const lastInteractionTimeRef = useRef(0);
  const isProgrammaticScrollRef = useRef(false);
  const programmaticScrollTimeoutRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const scrollToActiveLyric = useCallback((animated = true) => {
    if (!isPlayerVisible || !isLyricsViewRef.current || !lyricsRef.current || lyricsRef.current.length === 0 || !lyricsScrollRef.current) return;
    const index = computeActiveLyricIndex(lyricsRef.current, currentTimeRef.current);
    const scrollIndex = index <= 0 ? 0 : index;
    lastScrolledIndexRef.current = scrollIndex;
    const targetY = lyricLayouts.current[scrollIndex];
    const scrollY = Math.max(0, (targetY !== undefined ? targetY : scrollIndex * 80) - 240);

    isProgrammaticScrollRef.current = true;
    if (programmaticScrollTimeoutRef.current) {
      clearTimeout(programmaticScrollTimeoutRef.current);
    }
    lyricsScrollRef.current.scrollTo({ y: scrollY, animated });
    programmaticScrollTimeoutRef.current = setTimeout(() => {
      isProgrammaticScrollRef.current = false;
    }, 800);
  }, [isPlayerVisible]);

  const startLyricsInteractionTimer = useCallback(() => {
    lastInteractionTimeRef.current = Date.now();
    isLyricsInteractingRef.current = true;
    setIsAutoScrollPaused(true);
    if (lyricsInteractionTimerRef.current) {
      clearTimeout(lyricsInteractionTimerRef.current);
    }
    lyricsInteractionTimerRef.current = setTimeout(() => {
      isLyricsInteractingRef.current = false;
      setIsAutoScrollPaused(false);
      scrollToActiveLyric(true);
    }, 5000);
  }, [scrollToActiveLyric]);

  const handleLyricsInteraction = useCallback(() => {
    setIsAutoScrollPaused(true);
    if (isLyricsCompactRef.current) {
      exitCompactMode();
    }
    resetInactivityTimer();
    startLyricsInteractionTimer();
  }, [exitCompactMode, resetInactivityTimer, startLyricsInteractionTimer]);

  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) {
      return;
    }
    setIsAutoScrollPaused(true);
    handleLyricsInteraction();
  }, [handleLyricsInteraction]);

  const handleScrollBeginDrag = useCallback(() => {
    isProgrammaticScrollRef.current = false;
    setIsAutoScrollPaused(true);
    handleLyricsInteraction();
  }, [handleLyricsInteraction]);

  const handleScrollEndDrag = useCallback((event) => {
    const offsetY = event.nativeEvent?.contentOffset?.y ?? 0;
    const velocityY = event.nativeEvent?.velocity?.y ?? 0;
    if (offsetY < -45 || (offsetY < 0 && velocityY < -0.6)) {
      if (onCloseRef.current) {
        onCloseRef.current();
      }
      return;
    }
    startLyricsInteractionTimer();
  }, [startLyricsInteractionTimer]);

  const handleMomentumScrollBegin = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;
    if (lyricsInteractionTimerRef.current) {
      clearTimeout(lyricsInteractionTimerRef.current);
    }
    isLyricsInteractingRef.current = true;
    lastInteractionTimeRef.current = Date.now();
    setIsAutoScrollPaused(true);
  }, []);

  const handleMomentumScrollEnd = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;
    startLyricsInteractionTimer();
  }, [startLyricsInteractionTimer]);

  useEffect(() => {
    resetInactivityTimer();
    return () => {
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
      if (lyricsInteractionTimerRef.current) clearTimeout(lyricsInteractionTimerRef.current);
      if (programmaticScrollTimeoutRef.current) clearTimeout(programmaticScrollTimeoutRef.current);
    };
  }, [isLyricsView, isLyricsCompact, resetInactivityTimer]);

  useEffect(() => {
    if (!isLyricsView) {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
      }
      setIsLyricsCompact(false);
      if (lyricsInteractionTimerRef.current) {
        clearTimeout(lyricsInteractionTimerRef.current);
      }
      isLyricsInteractingRef.current = false;
      lastInteractionTimeRef.current = 0;
      lastScrolledIndexRef.current = -1;
      setIsAutoScrollPaused(false);
    }
  }, [isLyricsView]);

  useEffect(() => {
    if (currentTrack?.id) {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
      }
      setIsLyricsCompact(false);
      if (lyricsInteractionTimerRef.current) {
        clearTimeout(lyricsInteractionTimerRef.current);
      }
      isLyricsInteractingRef.current = false;
      lastInteractionTimeRef.current = 0;
      setIsAutoScrollPaused(false);
      setIsLoadingLyrics(true);
      lastScrolledIndexRef.current = -1;
      authFetch(`/api/tracks/${currentTrack.id}/lyrics`)
        .then(res => res.json())
        .then(data => {
          if (data && data.lyrics) {
            const raw = data.lyrics;
            const isSynced = data.isSynced !== undefined ? data.isSynced : isLrcSynced(raw);
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
        .catch(err => {
          setLyrics([]);
          setPlainLyricsText('');
          setHasSyncedLyrics(false);
        })
        .finally(() => setIsLoadingLyrics(false));
    }
  }, [currentTrack]);

  useEffect(() => {
    if (!isPlayerVisible || !isLyricsView || !hasSyncedLyrics) {
      lastScrolledIndexRef.current = -1;
      return;
    }
    // Block autoscroll if user interacted within the last 5 seconds!
    const timeSinceInteraction = Date.now() - lastInteractionTimeRef.current;
    if (isLyricsInteractingRef.current || timeSinceInteraction < 5000 || isAutoScrollPaused) {
      return;
    }
    if (lyrics.length > 0 && lyricsScrollRef.current) {
      const index = computeActiveLyricIndex(lyrics, currentTime);
      const scrollIndex = index <= 0 ? 0 : index;
      if (scrollIndex !== lastScrolledIndexRef.current) {
        const isFirst = lastScrolledIndexRef.current === -1;
        lastScrolledIndexRef.current = scrollIndex;
        const targetY = lyricLayouts.current[scrollIndex];
        const scrollY = Math.max(0, (targetY !== undefined ? targetY : scrollIndex * 80) - 240);

        isProgrammaticScrollRef.current = true;
        if (programmaticScrollTimeoutRef.current) {
          clearTimeout(programmaticScrollTimeoutRef.current);
        }
        lyricsScrollRef.current.scrollTo({ y: scrollY, animated: !isFirst });
        programmaticScrollTimeoutRef.current = setTimeout(() => {
          isProgrammaticScrollRef.current = false;
        }, 800);
      }
    }
  }, [currentTime, isLyricsView, lyrics, isAutoScrollPaused, hasSyncedLyrics]);

  const styles = useMemo(() => createLyricsStyles({
    width,
    height,
  }), [width, height]);

  return (
    <>
      {/* Lyrics View (Full Screen, behind safeArea controls) */}
      {(isLyricsView || isLyricsMounted) && (
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
            }
          ]}
          onTouchStart={handleLyricsInteraction}
          onTouchMove={handleLyricsInteraction}
          pointerEvents={(!isPlayerVisible || isQueueVisible || !isLyricsView) ? 'none' : 'auto'}
        >
          <GestureDetector gesture={lyricsHeaderSwipeGesture}>
            <Animated.View
              style={[
                styles.lyricsMiniHeader,
                lyricsMiniHeaderAnimatedStyle,
                {
                  zIndex: 20,
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  paddingTop: insets.top + 10,
                  height: (insets.top || 47) + 65,
                  backgroundColor: 'transparent',
                  paddingHorizontal: 30,
                }
              ]}
            >
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}
                onPress={() => setIsLyricsView(false)}
                activeOpacity={0.8}
              >
                <View style={styles.lyricsMiniArtSpacer} />
                <Animated.View style={[styles.lyricsMiniTextContainer, lyricsMiniTextAnimatedStyle]}>
                  <Text style={styles.lyricsMiniTitle} numberOfLines={1}>{displayTitle}</Text>
                  <Text style={styles.lyricsMiniArtist} numberOfLines={1}>{displayArtist}</Text>
                </Animated.View>
              </TouchableOpacity>
              <Animated.View style={lyricsMiniHeartAnimatedStyle}>
                <TouchableOpacity
                  onPress={() => onToggleLike && onToggleLike()}
                  hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
                  style={styles.lyricsHeartBtn}
                >
                  <Ionicons
                    name={trackIsLiked ? "heart" : "heart-outline"}
                    size={24}
                    color={trackIsLiked ? "#ff2d55" : "#e5e5ea"}
                  />
                </TouchableOpacity>
              </Animated.View>
            </Animated.View>
          </GestureDetector>

          <Animated.View style={[{ flex: 1, width: '100%' }, lyricsContentAnimatedStyle]}>
            {isLoadingLyrics ? (
              <ActivityIndicator color="#fff" size="large" style={{ marginTop: 200 }} />
            ) : (lyrics.length > 0 || (plainLyricsText && plainLyricsText.trim().length > 0)) ? (
              <ScrollView
                ref={lyricsScrollRef}
                style={styles.lyricsScrollView}
                showsVerticalScrollIndicator={false}
                scrollEventThrottle={16}
                onTouchStart={handleLyricsInteraction}
                onScroll={handleScroll}
                onScrollBeginDrag={handleScrollBeginDrag}
                onScrollEndDrag={handleScrollEndDrag}
                onMomentumScrollBegin={handleMomentumScrollBegin}
                onMomentumScrollEnd={handleMomentumScrollEnd}
                contentContainerStyle={{
                  paddingTop: insets.top + 115,
                  paddingBottom: isEffectivelyCompact ? ((insets.bottom || 34) + 160) : ((insets.bottom || 34) + 235),
                  paddingHorizontal: 30,
                }}
              >
                {!hasSyncedLyrics ? (
                  <View style={styles.plainLyricsWrapper}>
                    {(plainLyricsText || lyrics.map(l => l.text).join('\n'))
                      .split('\n')
                      .map((line, idx) => {
                        const trimmed = line.trim();
                        if (!trimmed) {
                          return <View key={idx} style={styles.plainStanzaSpacer} />;
                        }
                        const isHeader = /^\[.+\]$/.test(trimmed);
                        if (isHeader) {
                          return (
                            <Text key={idx} style={styles.plainSectionTitle}>
                              {trimmed.replace(/^\[|\]$/g, '')}
                            </Text>
                          );
                        }
                        return (
                          <Text key={idx} style={styles.plainLyricText}>
                            {trimmed}
                          </Text>
                        );
                      })}
                  </View>
                ) : (
                  (() => {
                    const activeIndex = computeActiveLyricIndex(lyrics, currentTime);

                    return lyrics.map((line, idx) => {
                      const isActive = activeIndex >= 0 && idx === activeIndex;
                      const distance = activeIndex === -2
                        ? 0
                        : activeIndex === -1
                          ? (idx + 1)
                          : Math.abs(idx - activeIndex);

                      return (
                        <AnimatedLyricLine
                          key={idx}
                          text={line.text}
                          isActive={isActive}
                          distance={distance}
                          activeIndex={activeIndex}
                          isAutoScrollPaused={isAutoScrollPaused}
                          index={idx}
                          baseStyle={styles.lyricLine}
                          onLayout={(i, y) => {
                            lyricLayouts.current[i] = y;
                          }}
                          onPressIn={handleLyricsInteraction}
                          onPress={() => {
                            handleLyricsInteraction();
                            if (line.time !== null && seekTo) {
                              seekTo(line.time);
                            }
                          }}
                        />
                      );
                    });
                  })()
                )}
              </ScrollView>
            ) : (
              <Text style={styles.noLyricsText}>Lyrics not found</Text>
            )}
          </Animated.View>

          <Animated.View style={[StyleSheet.absoluteFill, lyricsOverlaysAnimatedStyle]} pointerEvents="none">
            <TopBlurOverlay animatedBgStyle={animatedBgStyle} insets={insets} />
            <BottomBlurOverlay insets={insets} />
          </Animated.View>
        </Animated.View>
      )}
    </>
  );
};

export default AppleLyricsView;
