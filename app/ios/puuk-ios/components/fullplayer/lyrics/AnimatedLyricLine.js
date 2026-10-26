import React, { useEffect, useRef } from 'react';
import { Pressable } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withDelay,
  Easing,
  interpolateColor,
} from 'react-native-reanimated';
import { getProgressiveValues, getWaveSpring } from './lyricDepth';

/**
 * AnimatedLyricLine: Individual lyric line with staggered traffic-jam spring wave propagation.
 * Lines follow one after another like cars in a traffic jam ("как машины в пробке").
 *
 * Direct parity with web implementation (LyricLineRow.tsx & lyricsDepth.ts):
 * - Leading line (index === activeIndex) reacts immediately with delay = 0
 * - Trailing lines (index > activeIndex) follow with traffic-jam reaction delay (130ms, 230ms, ...)
 * - Ahead lines (index < activeIndex) follow with cascade pull upward (45ms, 100ms, ...)
 * - When manual scrolling occurs (isManualScrolling = true), wave delay is disabled (0ms)
 *   and all lines scroll synchronously as a single solid unit with full clarity.
 */
const AnimatedLyricLine = ({
  text,
  index,
  activeIndex,
  targetY = 0,
  isActive = false,
  isInitial = false,
  isManualScrolling = false,
  baseStyle,
  onLayout,
  onPress,
}) => {
  const progressive = isManualScrolling
    ? isActive
      ? { scale: 1.03, opacity: 1.0, blur: 0 }
      : { scale: 1.0, opacity: 1.0, blur: 0 }
    : getProgressiveValues(index, activeIndex);

  const spring = getWaveSpring(index, activeIndex, isInitial, isManualScrolling);
  const delayMs = Math.round((spring.delay || 0) * 1000);
  const springStiffness = spring.stiffness;
  const springDamping = spring.damping;
  const springMass = spring.mass;

  const targetYRef = useRef(targetY);
  targetYRef.current = targetY;

  const lineY = useSharedValue(targetY);
  const lineScale = useSharedValue(progressive.scale);
  const lineOpacity = useSharedValue(progressive.opacity);
  const colorProgress = useSharedValue(
    isActive ? 1.0 : (Math.abs(index - activeIndex) <= 1 ? 0.6 : 0.25)
  );

  useEffect(() => {
    // Initial mount or track reset: snap without animation
    if (isInitial) {
      lineY.value = targetY;
      lineScale.value = progressive.scale;
      lineOpacity.value = progressive.opacity;
      colorProgress.value = isActive ? 1.0 : (Math.abs(index - activeIndex) <= 1 ? 0.6 : 0.25);
      return;
    }

    // Manual scroll: synchronous spring with zero delay & full clarity
    if (isManualScrolling) {
      const manualSpring = {
        stiffness: 260,
        damping: 28,
        mass: 0.55,
      };
      lineY.value = withSpring(targetY, manualSpring);
      lineScale.value = withSpring(progressive.scale, manualSpring);
      lineOpacity.value = withSpring(progressive.opacity, manualSpring);
      colorProgress.value = withSpring(isActive ? 1.0 : 0.85, manualSpring);
      return;
    }

    const springConfig = {
      stiffness: springStiffness,
      damping: springDamping,
      mass: springMass,
    };
    const targetColor = isActive
      ? 1.0
      : Math.abs(index - activeIndex) <= 1
        ? 0.6
        : 0.25;

    // Line switching and opacity/scale/color changes execute identically:
    // same delay, same spring physics parameters, synchronized movement
    if (delayMs > 0) {
      lineY.value = withDelay(delayMs, withSpring(targetY, springConfig));
      lineScale.value = withDelay(
        delayMs,
        withSpring(progressive.scale, springConfig),
      );
      lineOpacity.value = withDelay(
        delayMs,
        withSpring(progressive.opacity, springConfig),
      );
      colorProgress.value = withDelay(
        delayMs,
        withSpring(targetColor, springConfig),
      );
    } else {
      lineY.value = withSpring(targetY, springConfig);
      lineScale.value = withSpring(progressive.scale, springConfig);
      lineOpacity.value = withSpring(progressive.opacity, springConfig);
      colorProgress.value = withSpring(targetColor, springConfig);
    }
  }, [
    targetY,
    activeIndex,
    isActive,
    isInitial,
    isManualScrolling,
    index,
    progressive.scale,
    progressive.opacity,
    delayMs,
    springStiffness,
    springDamping,
    springMass,
  ]);

  const animatedLineStyle = useAnimatedStyle(() => {
    return {
      opacity: lineOpacity.value,
      transform: [
        { translateY: lineY.value },
        { scale: lineScale.value },
      ],
      transformOrigin: 'left center',
    };
  });

  const animatedTextStyle = useAnimatedStyle(() => {
    const textColor = interpolateColor(
      colorProgress.value,
      [0, 0.55, 1],
      ['rgba(215, 215, 225, 0.65)', 'rgba(235, 235, 245, 0.85)', '#ffffff']
    );
    return {
      color: textColor,
    };
  });

  return (
    <Animated.View
      onLayout={(e) => onLayout && onLayout(index, e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
    >
      <Pressable
        onPress={onPress}
        disabled={!onPress}
        style={({ pressed }) => [{ opacity: pressed ? 0.8 : 1 }]}
      >
        <Animated.View style={animatedLineStyle}>
          <Animated.Text style={[baseStyle, animatedTextStyle]}>
            {text}
          </Animated.Text>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
};

export default AnimatedLyricLine;
