import React, { useMemo, useLayoutEffect } from 'react';
import { View, Pressable, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SymbolView } from 'expo-symbols';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
  Easing,
  cancelAnimation,
  FadeIn,
  FadeOut,
  LinearTransition,
  interpolate,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import ChasingArrowsIcon from './ChasingArrowsIcon';
import ProgressBar from './ProgressBar';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedTouchableOpacity =
  Animated.createAnimatedComponent(TouchableOpacity);

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
  onToggleQueue,
  onToggleLyrics,
  hasLyrics = false,
  onUserInteraction,
  accentColor,
}) => {
  const activeAccentColor = accentColor || '#FFDAB9';

  const compactProgress = useSharedValue(isEffectivelyCompact ? 1 : 0);

  useLayoutEffect(() => {
    compactProgress.value = withSpring(isEffectivelyCompact ? 1 : 0, {
      damping: 20,
      stiffness: 160,
      mass: 0.8,
    });
  }, [isEffectivelyCompact]);

  const notifyUserInteraction = () => {
    if (!isEffectivelyCompact && onUserInteraction) {
      onUserInteraction();
    }
  };

  // 1. Кнопка НАЗАД (Back)
  const backPressScale = useSharedValue(1);
  const backHighlightOpacity = useSharedValue(0);
  const backChasingProgress = useSharedValue(0);

  const handleBackPressIn = () => {
    notifyUserInteraction();
    backPressScale.value = withTiming(0.88, { duration: 120 });
    backHighlightOpacity.value = withTiming(1, { duration: 100 });
  };
  const handleBackPressOut = () => {
    backPressScale.value = withSpring(1, {
      damping: 14,
      stiffness: 180,
      mass: 0.7,
    });
    backHighlightOpacity.value = withTiming(0, { duration: 240 });
  };
  const handleBackPress = () => {
    notifyUserInteraction();
    cancelAnimation(backChasingProgress);
    backChasingProgress.value = 0;
    backChasingProgress.value = withTiming(
      1,
      { duration: 300, easing: Easing.bezier(0.22, 1, 0.36, 1) },
      (finished) => {
        'worklet';
        if (finished) {
          backChasingProgress.value = 0;
        }
      },
    );
    playPreviousTrack();
  };

  const backAnimatedStyle = useAnimatedStyle(() => {
    const scale = interpolate(compactProgress.value, [0, 1], [1, 0.75]);
    return {
      transform: [{ scale: backPressScale.value * scale }],
    };
  });

  const backHighlightStyle = useAnimatedStyle(() => {
    return {
      opacity: backHighlightOpacity.value,
    };
  });

  // 2. Кнопка ИГРАТЬ/ПАУЗА (Play/Pause)
  // Apple Music-style press feedback and in-place SF Symbol Magic Replace transition
  const playPausePressScale = useSharedValue(1);
  const playPauseHighlightOpacity = useSharedValue(0);

  const handlePlayPausePressIn = () => {
    notifyUserInteraction();
    playPausePressScale.value = withTiming(0.88, { duration: 120 });
    playPauseHighlightOpacity.value = withTiming(1, { duration: 100 });
  };
  const handlePlayPausePressOut = () => {
    playPausePressScale.value = withSpring(1, {
      damping: 14,
      stiffness: 180,
      mass: 0.7,
    });
    playPauseHighlightOpacity.value = withTiming(0, { duration: 240 });
  };

  const playPauseAnimatedStyle = useAnimatedStyle(() => {
    const scale = interpolate(compactProgress.value, [0, 1], [1, 0.75]);
    return {
      transform: [{ scale: playPausePressScale.value * scale }],
    };
  });

  const playPauseHighlightStyle = useAnimatedStyle(() => {
    return {
      opacity: playPauseHighlightOpacity.value,
    };
  });

  // 3. Кнопка ДАЛЕЕ (Next)
  const nextPressScale = useSharedValue(1);
  const nextHighlightOpacity = useSharedValue(0);
  const nextChasingProgress = useSharedValue(0);

  const handleNextPressIn = () => {
    notifyUserInteraction();
    nextPressScale.value = withTiming(0.88, { duration: 120 });
    nextHighlightOpacity.value = withTiming(1, { duration: 100 });
  };
  const handleNextPressOut = () => {
    nextPressScale.value = withSpring(1, {
      damping: 14,
      stiffness: 180,
      mass: 0.7,
    });
    nextHighlightOpacity.value = withTiming(0, { duration: 240 });
  };
  const handleNextPress = () => {
    notifyUserInteraction();
    cancelAnimation(nextChasingProgress);
    nextChasingProgress.value = 0;
    nextChasingProgress.value = withTiming(
      1,
      { duration: 300, easing: Easing.bezier(0.22, 1, 0.36, 1) },
      (finished) => {
        'worklet';
        if (finished) {
          nextChasingProgress.value = 0;
        }
      },
    );
    fetchNextTrack();
  };

  const nextAnimatedStyle = useAnimatedStyle(() => {
    const scale = interpolate(compactProgress.value, [0, 1], [1, 0.75]);
    return {
      transform: [{ scale: nextPressScale.value * scale }],
    };
  });

  const nextHighlightStyle = useAnimatedStyle(() => {
    return {
      opacity: nextHighlightOpacity.value,
    };
  });

  const handleExitCompact = () => {
    if (triggerExitCompactMode) {
      triggerExitCompactMode();
    } else if (exitCompactMode) {
      exitCompactMode();
    }
  };

  const swipeUpCompactGesture = useMemo(() => {
    return Gesture.Pan()
      .enabled(isEffectivelyCompact)
      .activeOffsetY(-8)
      .failOffsetY(50)
      .onEnd((event) => {
        'worklet';
        if (event.translationY < -8 || event.velocityY < -150) {
          runOnJS(handleExitCompact)();
        }
      });
  }, [isEffectivelyCompact, triggerExitCompactMode, exitCompactMode]);

  const sideBtnContainerStyle = useAnimatedStyle(() => {
    const size = interpolate(compactProgress.value, [0, 1], [64, 48]);
    return {
      width: size,
      height: size,
    };
  });

  const sideHighlightBgStyle = useAnimatedStyle(() => {
    const size = interpolate(compactProgress.value, [0, 1], [64, 48]);
    return {
      width: size,
      height: size,
      borderRadius: size / 2,
      opacity: backHighlightOpacity.value,
    };
  });

  const nextHighlightBgStyle = useAnimatedStyle(() => {
    const size = interpolate(compactProgress.value, [0, 1], [64, 48]);
    return {
      width: size,
      height: size,
      borderRadius: size / 2,
      opacity: nextHighlightOpacity.value,
    };
  });

  const playBtnContainerStyle = useAnimatedStyle(() => {
    const size = interpolate(compactProgress.value, [0, 1], [72, 54]);
    return {
      width: size,
      height: size,
    };
  });

  const playHighlightBgStyle = useAnimatedStyle(() => {
    const size = interpolate(compactProgress.value, [0, 1], [72, 54]);
    return {
      width: size,
      height: size,
      borderRadius: size / 2,
      opacity: playPauseHighlightOpacity.value,
    };
  });

  const lyricsBtnContainerStyle = useAnimatedStyle(() => {
    const size = interpolate(compactProgress.value, [0, 1], [44, 38]);
    const radius = interpolate(compactProgress.value, [0, 1], [12, 11]);
    return {
      width: size,
      height: size,
      borderRadius: radius,
    };
  });

  const lyricsIconAnimatedStyle = useAnimatedStyle(() => {
    const scale = interpolate(compactProgress.value, [0, 1], [1, 22 / 24]);
    return {
      transform: [{ scale }],
    };
  });

  const topSlotAnimatedStyle = useAnimatedStyle(() => {
    const height = interpolate(compactProgress.value, [0, 1], [58, 28]);
    return {
      height,
      overflow: 'hidden',
      width: '100%',
    };
  });

  return (
    <Animated.View style={{ width: '100%', zIndex: 20 }}>
      <GestureDetector
        gesture={Gesture.Simultaneous(
          bottomSwipeGesture,
          swipeUpCompactGesture,
        )}
      >
        <Animated.View
          layout={LinearTransition.springify()}
          style={{ width: '100%' }}
        >
          <Animated.View style={topSlotAnimatedStyle}>
            {isEffectivelyCompact ? (
              <Animated.View
                key="compact-handle"
                entering={FadeIn.duration(200)}
                exiting={FadeOut.duration(200)}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  height: 28,
                  justifyContent: 'center',
                }}
              >
                <Pressable
                  onPress={handleExitCompact}
                  hitSlop={{ top: 20, bottom: 15, left: 30, right: 30 }}
                  style={styles.compactHandleContainer}
                  accessibilityRole="button"
                  accessibilityLabel="Развернуть элементы управления"
                >
                  {({ pressed }) => (
                    <View
                      style={[
                        styles.compactHandlePill,
                        pressed && { opacity: 0.6 },
                      ]}
                    />
                  )}
                </Pressable>
              </Animated.View>
            ) : (
              <Animated.View
                key="expanded-progress"
                entering={FadeIn.duration(200)}
                exiting={FadeOut.duration(200)}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                }}
              >
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
              </Animated.View>
            )}
          </Animated.View>

          <Animated.View
            layout={LinearTransition.springify().damping(90).stiffness(370)}
            style={
              isEffectivelyCompact
                ? styles.compactBottomRow
                : styles.normalBottomRow
            }
          >
            <Animated.View
              layout={LinearTransition.springify().damping(60).stiffness(300)}
              style={
                isEffectivelyCompact
                  ? styles.compactMediaControls
                  : styles.controlsContainer
              }
            >
              <AnimatedPressable
                layout={LinearTransition.springify()}
                onPressIn={handleBackPressIn}
                onPressOut={handleBackPressOut}
                onPress={handleBackPress}
                style={[
                  styles.compactBtn,
                  sideBtnContainerStyle,
                  {
                    alignItems: 'center',
                    justifyContent: 'center',
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel="Предыдущий трек"
              >
                <Animated.View
                  style={[
                    {
                      position: 'absolute',
                      backgroundColor: 'rgba(255, 255, 255, 0.12)',
                    },
                    sideHighlightBgStyle,
                  ]}
                  pointerEvents="none"
                />
                <Animated.View style={backAnimatedStyle}>
                  <ChasingArrowsIcon
                    progress={backChasingProgress}
                    direction="left"
                    size={34}
                    spacing={17}
                  />
                </Animated.View>
              </AnimatedPressable>

              <AnimatedPressable
                layout={LinearTransition.springify()}
                onPressIn={handlePlayPausePressIn}
                onPressOut={handlePlayPausePressOut}
                onPress={togglePlayPause}
                style={[
                  styles.compactBtn,
                  playBtnContainerStyle,
                  {
                    alignItems: 'center',
                    justifyContent: 'center',
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel={isPlaying ? 'Пауза' : 'Воспроизведение'}
              >
                <Animated.View
                  style={[
                    {
                      position: 'absolute',
                      backgroundColor: 'rgba(255, 255, 255, 0.12)',
                    },
                    playHighlightBgStyle,
                  ]}
                  pointerEvents="none"
                />
                <Animated.View style={playPauseAnimatedStyle}>
                  <SymbolView
                    name={isPlaying ? 'pause.fill' : 'play.fill'}
                    size={48}
                    weight="bold"
                    tintColor="#ffffff"
                    resizeMode="scaleAspectFit"
                    fallback={
                      <Ionicons
                        name={isPlaying ? 'pause' : 'play'}
                        size={48}
                        color="#ffffff"
                      />
                    }
                  />
                </Animated.View>
              </AnimatedPressable>

              <AnimatedPressable
                layout={LinearTransition.springify()}
                onPressIn={handleNextPressIn}
                onPressOut={handleNextPressOut}
                onPress={handleNextPress}
                style={[
                  styles.compactBtn,
                  sideBtnContainerStyle,
                  {
                    alignItems: 'center',
                    justifyContent: 'center',
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel="Следующий трек"
              >
                <Animated.View
                  style={[
                    {
                      position: 'absolute',
                      backgroundColor: 'rgba(255, 255, 255, 0.12)',
                    },
                    nextHighlightBgStyle,
                  ]}
                  pointerEvents="none"
                />
                <Animated.View style={nextAnimatedStyle}>
                  <ChasingArrowsIcon
                    progress={nextChasingProgress}
                    direction="right"
                    size={34}
                    spacing={17}
                  />
                </Animated.View>
              </AnimatedPressable>
            </Animated.View>

            <Animated.View
              layout={LinearTransition.springify()}
              style={
                isEffectivelyCompact
                  ? styles.compactRightControls
                  : styles.bottomControls
              }
            >
              <Animated.View layout={LinearTransition.springify()}>
                <AnimatedTouchableOpacity
                  onPress={onToggleLyrics}
                  disabled={!hasLyrics}
                  activeOpacity={0.7}
                  style={[
                    styles.toggleSquircleBtn,
                    lyricsBtnContainerStyle,
                    isLyricsView && styles.toggleSquircleBtnActive,
                    !hasLyrics && { opacity: 0.3 },
                  ]}
                  accessibilityState={{
                    disabled: !hasLyrics,
                    selected: isLyricsView,
                  }}
                  accessibilityLabel="Текст песни"
                >
                  <Animated.View style={lyricsIconAnimatedStyle}>
                    <Ionicons
                      name={isLyricsView ? 'text' : 'text-outline'}
                      size={24}
                      color={isLyricsView ? '#ffffff' : '#e5e5ea'}
                    />
                  </Animated.View>
                </AnimatedTouchableOpacity>
              </Animated.View>

              {!isEffectivelyCompact && (
                <Animated.View
                  layout={LinearTransition.springify()}
                  exiting={FadeOut.duration(300)}
                  entering={FadeIn.duration(300)}
                >
                  <TouchableOpacity
                    onPress={onToggleQueue}
                    activeOpacity={0.7}
                    style={[
                      styles.toggleSquircleBtn,
                      isQueueVisible && styles.toggleSquircleBtnActive,
                    ]}
                    accessibilityState={{ selected: isQueueVisible }}
                    accessibilityLabel="Очередь воспроизведения"
                  >
                    <Ionicons
                      name="list"
                      size={24}
                      color={isQueueVisible ? '#ffffff' : '#e5e5ea'}
                    />
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

export default React.memo(PlayerControls);
