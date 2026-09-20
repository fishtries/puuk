import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View,
  Pressable,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withSequence,
  runOnJS,
  FadeIn,
  FadeOut,
  LinearTransition,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import ChasingArrowsIcon from './ChasingArrowsIcon';
import ProgressBar from './ProgressBar';

const PlayerControls = ({
  styles,
  isEffectivelyCompact,
  isPlaying,
  isLoading,
  currentTime,
  duration,
  togglePlayPause,
  fetchNextTrack,
  playPreviousTrack,
  seekTo,
  isLyricsView,
  isQueueVisible,
  isSliding,
  setIsSliding,
  setSlideValue,
  isSlidingShared,
  sliderWidthShared,
  slideProgressShared,
  durationShared,
  slideValue,
  bottomSwipeGesture,
  exitCompactMode,
  triggerExitCompactMode,
  onAddToPlaylist,
  onToggleQueue,
  onToggleLyrics,
}) => {
  const isFirstRenderPlay = useRef(true);
  const isFirstRenderLoading = useRef(true);

  // 1. Кнопка НАЗАД (Back)
  const backPressScale = useSharedValue(1);
  const backTranslationX = useSharedValue(0);
  const backChasingProgress = useSharedValue(0);

  const handleBackPressIn = () => {
    backPressScale.value = withTiming(0.85, { duration: 200 });
    backTranslationX.value = withTiming(-8, { duration: 200 });
  };
  const handleBackPressOut = () => {
    backPressScale.value = withSpring(1, { damping: 20, stiffness: 90 });
    backTranslationX.value = withSpring(0, { damping: 20, stiffness: 90 });
  };
  const handleBackPress = () => {
    backChasingProgress.value = withTiming(1, { duration: 350 }, (finished) => {
      if (finished) {
        backChasingProgress.value = 0;
      }
    });
    playPreviousTrack();
  };

  const backAnimatedStyle = useAnimatedStyle(() => {
    return {
      transform: [
        { scale: backPressScale.value },
        { translateX: backTranslationX.value }
      ],
    };
  });

  // 2. Кнопка ИГРАТЬ/ПАУЗА (Play/Pause)
  const playPausePressScale = useSharedValue(1);
  const playPauseScale = useSharedValue(1);
  const [renderedPlayIcon, setRenderedPlayIcon] = useState(isPlaying ? "pause" : "play");

  useEffect(() => {
    if (isFirstRenderPlay.current) {
      isFirstRenderPlay.current = false;
      setRenderedPlayIcon(isPlaying ? "pause" : "play");
      return;
    }
    playPauseScale.value = withSequence(
      withTiming(0, { duration: 150 }, (finished) => {
        if (finished) {
          runOnJS(setRenderedPlayIcon)(isPlaying ? "pause" : "play");
        }
      }),
      withSpring(1, { damping: 20, stiffness: 90 })
    );
  }, [isPlaying]);

  const handlePlayPausePressIn = () => {
    playPausePressScale.value = withTiming(0.85, { duration: 200 });
  };
  const handlePlayPausePressOut = () => {
    playPausePressScale.value = withSpring(1, { damping: 20, stiffness: 90 });
  };

  const playPauseAnimatedStyle = useAnimatedStyle(() => {
    return {
      transform: [{ scale: playPauseScale.value * playPausePressScale.value }],
    };
  });

  // 3. Кнопка ДАЛЕЕ (Next)
  const nextPressScale = useSharedValue(1);
  const nextTransitionScale = useSharedValue(1);
  const nextTranslationX = useSharedValue(0);
  const nextChasingProgress = useSharedValue(0);
  const [renderedNextLoading, setRenderedNextLoading] = useState(isLoading);

  useEffect(() => {
    if (isFirstRenderLoading.current) {
      isFirstRenderLoading.current = false;
      setRenderedNextLoading(isLoading);
      return;
    }
    nextTransitionScale.value = withSequence(
      withTiming(0, { duration: 150 }, (finished) => {
        if (finished) {
          runOnJS(setRenderedNextLoading)(isLoading);
        }
      }),
      withSpring(1, { damping: 20, stiffness: 90 })
    );
  }, [isLoading]);

  const handleNextPressIn = () => {
    if (!isLoading) {
      nextPressScale.value = withTiming(0.85, { duration: 200 });
      nextTranslationX.value = withTiming(8, { duration: 200 });
    }
  };
  const handleNextPressOut = () => {
    nextPressScale.value = withSpring(1, { damping: 20, stiffness: 90 });
    nextTranslationX.value = withSpring(0, { damping: 20, stiffness: 90 });
  };
  const handleNextPress = () => {
    nextChasingProgress.value = withTiming(1, { duration: 350 }, (finished) => {
      if (finished) {
        nextChasingProgress.value = 0;
      }
    });
    fetchNextTrack();
  };

  const nextAnimatedStyle = useAnimatedStyle(() => {
    return {
      transform: [
        { scale: nextTransitionScale.value * nextPressScale.value },
        { translateX: nextTranslationX.value }
      ],
    };
  });

  const swipeUpCompactGesture = useMemo(() => {
    return Gesture.Pan()
      .enabled(isEffectivelyCompact)
      .activeOffsetY(-8)
      .failOffsetY(20)
      .onEnd((event) => {
        'worklet';
        if (event.translationY < -10 || event.velocityY < -150) {
          runOnJS(triggerExitCompactMode)();
        }
      });
  }, [isEffectivelyCompact, triggerExitCompactMode]);

  return (
    <Animated.View layout={LinearTransition.springify()} style={{ width: '100%', zIndex: 20 }}>
      <GestureDetector gesture={Gesture.Simultaneous(bottomSwipeGesture, swipeUpCompactGesture)}>
        <Animated.View layout={LinearTransition.springify()} style={{ width: '100%' }}>

          {isEffectivelyCompact && (
            <Pressable
              onPress={exitCompactMode}
              hitSlop={{ top: 20, bottom: 15, left: 30, right: 30 }}
              style={styles.compactHandleContainer}
            >
              <View style={styles.compactHandlePill} />
            </Pressable>
          )}

          <ProgressBar
            styles={styles}
            isSliding={isSliding}
            setIsSliding={setIsSliding}
            setSlideValue={setSlideValue}
            seekTo={seekTo}
            currentTime={currentTime}
            duration={duration}
            isSlidingShared={isSlidingShared}
            sliderWidthShared={sliderWidthShared}
            slideProgressShared={slideProgressShared}
            durationShared={durationShared}
            slideValue={slideValue}
            isEffectivelyCompact={isEffectivelyCompact}
          />

          <Animated.View
            layout={LinearTransition.springify()}
            style={isEffectivelyCompact ? styles.compactBottomRow : styles.normalBottomRow}
          >
            <Animated.View layout={LinearTransition.springify()} style={isEffectivelyCompact ? styles.compactMediaControls : styles.controlsContainer}>
              <Pressable
                onPressIn={handleBackPressIn}
                onPressOut={handleBackPressOut}
                onPress={handleBackPress}
                style={styles.compactBtn}
              >
                <Animated.View layout={LinearTransition.springify()} style={backAnimatedStyle}>
                  <ChasingArrowsIcon progress={backChasingProgress} direction="left" size={isEffectivelyCompact ? 28 : 34} spacing={16} />
                </Animated.View>
              </Pressable>

              <Pressable
                onPressIn={handlePlayPausePressIn}
                onPressOut={handlePlayPausePressOut}
                onPress={togglePlayPause}
                style={styles.compactBtn}
              >
                <Animated.View layout={LinearTransition.springify()} style={playPauseAnimatedStyle}>
                  <Ionicons name={renderedPlayIcon} size={isEffectivelyCompact ? 36 : 48} color="#ffffff" />
                </Animated.View>
              </Pressable>

              <Pressable
                onPressIn={handleNextPressIn}
                onPressOut={handleNextPressOut}
                onPress={handleNextPress}
                disabled={isLoading}
                style={styles.compactBtn}
              >
                <Animated.View layout={LinearTransition.springify()} style={nextAnimatedStyle}>
                  {renderedNextLoading ? (
                    <ActivityIndicator color="#ffffff" size={isEffectivelyCompact ? "small" : "large"} />
                  ) : (
                    <ChasingArrowsIcon progress={nextChasingProgress} direction="right" size={isEffectivelyCompact ? 28 : 34} spacing={16} />
                  )}
                </Animated.View>
              </Pressable>
            </Animated.View>

            <Animated.View layout={LinearTransition.springify()} style={isEffectivelyCompact ? styles.compactRightControls : styles.bottomControls}>
              <Animated.View layout={LinearTransition.springify()}>
                <TouchableOpacity onPress={() => onAddToPlaylist && onAddToPlaylist()} style={styles.compactBtn}>
                  <Ionicons name="add-circle-outline" size={isEffectivelyCompact ? 26 : 26} color="#e5e5ea" />
                </TouchableOpacity>
              </Animated.View>

              <Animated.View layout={LinearTransition.springify()}>
                <TouchableOpacity onPress={onToggleLyrics} style={styles.compactBtn}>
                  <Ionicons name={isLyricsView ? "text" : "text-outline"} size={isEffectivelyCompact ? 26 : 26} color={isLyricsView ? "#6C3AED" : "#e5e5ea"} />
                </TouchableOpacity>
              </Animated.View>

              {!isEffectivelyCompact && (
                <Animated.View
                  layout={LinearTransition.springify()}
                  exiting={FadeOut.duration(300)}
                  entering={FadeIn.duration(300)}
                >
                  <TouchableOpacity onPress={onToggleQueue} style={styles.compactBtn}>
                    <Ionicons name="list" size={26} color={isQueueVisible ? "#ff2d55" : "#e5e5ea"} />
                  </TouchableOpacity>
                </Animated.View>
              )}
            </Animated.View>
          </Animated.View>

        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
};

export default PlayerControls;
