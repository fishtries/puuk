import React from 'react';
import {
  View,
  Text,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  runOnJS,
  FadeIn,
  FadeOut,
  LinearTransition,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

const ProgressBar = ({
  styles,
  isSliding,
  setIsSliding,
  setSlideValue,
  seekTo,
  currentTime,
  duration,
  isSlidingShared,
  sliderWidthShared,
  slideProgressShared,
  durationShared,
  slideValue,
  isEffectivelyCompact,
}) => {
  const scrubGesture = Gesture.Pan()
    .onBegin((event) => {
      isSlidingShared.value = true;
      runOnJS(setIsSliding)(true);

      const ratio = Math.max(0, Math.min(1, event.x / sliderWidthShared.value));
      slideProgressShared.value = ratio;
      runOnJS(setSlideValue)(ratio * durationShared.value);
    })
    .onUpdate((event) => {
      const ratio = Math.max(0, Math.min(1, event.x / sliderWidthShared.value));
      slideProgressShared.value = ratio;
      runOnJS(setSlideValue)(ratio * durationShared.value);
    })
    .onEnd(() => {
      isSlidingShared.value = false;
      const targetTime = slideProgressShared.value * durationShared.value;
      runOnJS(seekTo)(targetTime);
      runOnJS(setIsSliding)(false);
    })
    .onFinalize(() => {
      if (isSlidingShared.value) {
        isSlidingShared.value = false;
        runOnJS(setIsSliding)(false);
      }
    });

  const progressFillStyle = useAnimatedStyle(() => {
    return {
      width: `${slideProgressShared.value * 100}%`,
    };
  });

  const progressThumbStyle = useAnimatedStyle(() => {
    return {
      left: `${slideProgressShared.value * 100}%`,
    };
  });

  const formatTime = (ms) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  };

  const position = isSliding ? slideValue * 1000 : currentTime * 1000;
  const durMs = duration * 1000;

  if (isEffectivelyCompact) return null;

  return (
    <Animated.View
      layout={LinearTransition.springify()}
      exiting={FadeOut.duration(300)}
      entering={FadeIn.duration(300)}
    >
      <GestureDetector gesture={scrubGesture}>
        <Animated.View
          style={styles.progressContainer}
          onLayout={(e) => {
            sliderWidthShared.value = e.nativeEvent.layout.width;
          }}
        >
          <View style={[styles.progressBarBackground, isSliding && { height: 8, borderRadius: 4 }]}>
            <Animated.View style={[
              styles.progressBarFill,
              progressFillStyle,
              isSliding && { height: 8, borderRadius: 4 }
            ]} />
            {isSliding && (
              <Animated.View style={[
                styles.progressThumb,
                progressThumbStyle
              ]} />
            )}
          </View>
          <View style={styles.timeRow}>
            <Text style={styles.timeText}>{formatTime(position)}</Text>
            <Text style={styles.timeText}>-{formatTime(Math.max(0, durMs - position))}</Text>
          </View>
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
};

export default ProgressBar;
