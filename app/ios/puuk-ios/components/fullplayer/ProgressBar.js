import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  runOnJS,
  FadeIn,
  FadeOut,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

const ProgressBar = ({
  styles,
  seekTo,
  currentTime = 0,
  duration = 0,
  isSlidingShared,
  sliderWidthShared,
  slideProgressShared,
  durationShared,
  isEffectivelyCompact,
  // Props kept for backwards compatibility with tests / callers:
  isSliding: _isSlidingProp,
  setIsSliding: _setIsSlidingProp,
  setSlideValue: _setSlideValueProp,
  slideValue: _slideValueProp,
}) => {
  const [scrubSeconds, setScrubSeconds] = useState(null);
  const lastReportedSecRef = useRef(null);

  const updateScrubSec = useCallback((sec) => {
    if (sec !== lastReportedSecRef.current) {
      lastReportedSecRef.current = sec;
      setScrubSeconds(sec);
    }
  }, []);

  const handleSeekEnd = useCallback((targetTime) => {
    lastReportedSecRef.current = null;
    setScrubSeconds(null);
    if (targetTime !== null && targetTime !== undefined) {
      seekTo?.(targetTime);
    }
  }, [seekTo]);

  const scrubGesture = Gesture.Pan()
    .onBegin((event) => {
      'worklet';
      isSlidingShared.value = true;
      const width = sliderWidthShared.value || 1;
      const ratio = Math.max(0, Math.min(1, event.x / width));
      slideProgressShared.value = ratio;
      const targetSec = Math.floor(ratio * durationShared.value);
      runOnJS(updateScrubSec)(targetSec);
    })
    .onUpdate((event) => {
      'worklet';
      const width = sliderWidthShared.value || 1;
      const ratio = Math.max(0, Math.min(1, event.x / width));
      slideProgressShared.value = ratio;
      const targetSec = Math.floor(ratio * durationShared.value);
      runOnJS(updateScrubSec)(targetSec);
    })
    .onEnd(() => {
      'worklet';
      isSlidingShared.value = false;
      const targetTime = slideProgressShared.value * durationShared.value;
      runOnJS(handleSeekEnd)(targetTime);
    })
    .onFinalize(() => {
      'worklet';
      if (isSlidingShared.value) {
        isSlidingShared.value = false;
        runOnJS(handleSeekEnd)(null);
      }
    });

  // Hardware-accelerated GPU transforms — NO LAYOUT RECALCULATIONS
  const progressFillStyle = useAnimatedStyle(() => {
    const width = sliderWidthShared.value || 1;
    const progress = Math.max(0, Math.min(1, slideProgressShared.value));
    return {
      transform: [{ translateX: (progress - 1) * width }],
    };
  });

  const progressThumbStyle = useAnimatedStyle(() => {
    const width = sliderWidthShared.value || 1;
    const progress = Math.max(0, Math.min(1, slideProgressShared.value));
    return {
      opacity: isSlidingShared.value ? 1 : 0,
      transform: [
        { translateX: progress * width },
        { scale: isSlidingShared.value ? 1 : 0.001 },
      ],
    };
  });

  const barHeightAnimatedStyle = useAnimatedStyle(() => {
    return {
      height: isSlidingShared.value ? 8 : 4,
      borderRadius: isSlidingShared.value ? 4 : 2,
    };
  });

  const formatTime = (secs) => {
    const s = Math.max(0, Math.floor(secs || 0));
    const minutes = Math.floor(s / 60);
    const seconds = s % 60;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  };

  if (isEffectivelyCompact) return null;

  const currentSeconds = scrubSeconds !== null ? scrubSeconds : currentTime;
  const totalDuration = duration || 0;
  const remainingSeconds = Math.max(0, totalDuration - currentSeconds);

  return (
    <Animated.View
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
          <View style={{ justifyContent: 'center' }}>
            <Animated.View
              style={[
                styles.progressBarBackground,
                barHeightAnimatedStyle,
                { overflow: 'hidden' },
              ]}
            >
              <Animated.View
                style={[
                  styles.progressBarFill,
                  { width: '100%', height: '100%' },
                  progressFillStyle,
                ]}
              />
            </Animated.View>
            <Animated.View
              style={[
                styles.progressThumb,
                progressThumbStyle,
              ]}
              pointerEvents="none"
            />
          </View>
          <View style={styles.timeRow}>
            <Text style={styles.timeText}>{formatTime(currentSeconds)}</Text>
            <Text style={styles.timeText}>-{formatTime(remainingSeconds)}</Text>
          </View>
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
};

export default React.memo(ProgressBar);
