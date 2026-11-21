import React, { useLayoutEffect, useState, useCallback, useMemo, memo } from 'react';
import { Pressable, View, Text, StyleSheet } from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withDelay,
  interpolateColor,
  useReducedMotion,
} from 'react-native-reanimated';
import { getProgressiveValues, getWaveSpring } from './lyricDepth';

const useLyricsReducedMotion = useReducedMotion || (() => false);

// Motion/color are updated by the parent shared values. The glyph subtree
// itself does not need a React commit when the active line or target changes.
const LineText = memo(function LineText({ text, baseStyle, animatedStyle }) {
  return <Animated.Text style={[baseStyle, animatedStyle]}>{text}</Animated.Text>;
});

export const wordSweepProgress = (segment, currentMs) => {
  'worklet';
  return Math.max(0, Math.min(1, (currentMs - segment.startMs) / (segment.endMs - segment.startMs)));
};

const hasWordSweep = (segment, second) => second !== null &&
  segment.endMs >= second * 1000 - 150 && segment.startMs <= second * 1000 + 1250;
const isPastWord = (segment, second) => second !== null && segment.endMs <= second * 1000;

const WordSweep = ({ width, segment, playbackMs, textStyle }) => {
  const sweepStyle = useAnimatedStyle(() => {
    const progress = wordSweepProgress(segment, playbackMs.value);
    return {
      opacity: progress > 0 && progress < 1 ? 1 : 0,
      transform: [{ translateX: -width * 2.1 + width * 1.2 * progress }],
    };
  });
  return (
    <MaskedView pointerEvents="none" accessible={false}
      style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}
      maskElement={<Text style={[textStyle, { color: 'black' }]}>{segment.text}</Text>}>
      <Animated.View style={[{ width: width * 3, height: '100%',
        transform: [{ translateX: -width * 2.1 }] }, sweepStyle]}>
        <LinearGradient colors={['#fff', '#fff', 'rgba(255,255,255,0)']}
          locations={[0, 0.64, 0.7]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill} />
      </Animated.View>
    </MaskedView>
  );
};

const TimedWord = memo(({ segment, playbackMs, textStyle, isPast }) => {
  const [width, setWidth] = useState(0);
  const handleLayout = useCallback((event) => {
    const measured = event.nativeEvent.layout.width;
    setWidth((previous) => Math.abs(previous - measured) > 0.5 ? measured : previous);
  }, []);
  const wordColor = useAnimatedStyle(() => ({
    color: (playbackMs ? playbackMs.value >= segment.endMs : isPast)
      ? '#fff' : 'rgba(215,215,225,0.40)',
  }));
  return (
    <View accessible={false} onLayout={handleLayout}>
      <Animated.Text style={[textStyle, wordColor]}>{segment.text}</Animated.Text>
      {playbackMs && width > 0 && <WordSweep width={width} segment={segment}
        playbackMs={playbackMs} textStyle={textStyle} />}
    </View>
  );
});

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
 *
 * Word timings drive a masked gradient sweep through each glyph. Completed
 * words remain filled; future words keep a dim base. Layout is measured once
 * per word, without moving or scaling the letters during highlighting.
 * Lines without timings retain the existing line-level presentation.
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
  words,
  segments,
  hasWordTimings = false,
  wordWindowSecond = null,
  playbackMs,
}) => {
  const reducedMotion = useLyricsReducedMotion();
  const progressive = isManualScrolling
    ? isActive
      ? { scale: 1.03, opacity: 1.0, blur: 0 }
      : { scale: 1.0, opacity: 1.0, blur: 0 }
    : getProgressiveValues(index, activeIndex);

  const spring = getWaveSpring(index, activeIndex, isInitial, isManualScrolling);
  const delayMs = reducedMotion ? 0 : Math.round((spring.delay || 0) * 1000);
  const springStiffness = reducedMotion ? 400 : spring.stiffness;
  const springDamping = reducedMotion ? 40 : spring.damping;
  const springMass = reducedMotion ? 0.3 : spring.mass;

  const lineY = useSharedValue(targetY);
  const lineScale = useSharedValue(progressive.scale);
  const lineOpacity = useSharedValue(progressive.opacity);
  const colorProgress = useSharedValue(
    isActive ? 1.0 : (Math.abs(index - activeIndex) <= 1 ? 0.6 : 0.25)
  );

  useLayoutEffect(() => {
    // Initial mount or track reset: snap without animation
    if (isInitial || reducedMotion) {
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
    reducedMotion,
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

  const resolvedStyle = useMemo(() => StyleSheet.flatten(baseStyle) || {}, [baseStyle]);
  const { marginVertical, marginTop, marginBottom } = resolvedStyle;
  const wordTextStyle = useMemo(() => {
    const { marginVertical, marginTop, marginBottom, ...typography } = resolvedStyle;
    return typography;
  }, [resolvedStyle]);
  const handleLayout = useCallback((event) => {
    const { y, height } = event.nativeEvent.layout;
    onLayout?.(index, y, height);
  }, [index, onLayout]);

  // Render content with word-level highlights if applicable
  const renderLineContent = () => {
    if (!hasWordTimings || !segments || segments.length === 0) {
      return text;
    }

    // Scroll focus does not control whether a sounding word is highlighted.
    if (hasWordTimings) {
      return segments.map((seg, i) => {
        if (!seg.isWord) {
          return (
            <Text key={`sep-${i}`} style={[wordTextStyle, { color: 'rgba(215,215,225,0.40)' }]}>
              {seg.text}
            </Text>
          );
        }

        const sweeps = hasWordSweep(seg, wordWindowSecond);
        return (
          <TimedWord key={seg.id || `word-${i}`} segment={seg}
            playbackMs={sweeps ? playbackMs : undefined} textStyle={wordTextStyle}
            isPast={!sweeps && isPastWord(seg, wordWindowSecond)} />
        );
      });
    }

    // Lines without timings retain the existing uniform coloring.
    return text;
  };

  return (
    <View collapsable={false} onLayout={handleLayout}>
      <Pressable
        onPress={onPress}
        disabled={!onPress}
        accessibilityLabel={text}
        accessibilityRole="button"
        accessibilityHint="Tap to seek to this line"
        style={({ pressed }) => [{ opacity: pressed ? 0.8 : 1 }]}
      >
        <Animated.View style={animatedLineStyle}>
          {hasWordTimings ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline',
              marginTop: marginTop ?? marginVertical, marginBottom: marginBottom ?? marginVertical }}>
              {renderLineContent()}
            </View>
          ) : (
            <LineText text={text} baseStyle={baseStyle} animatedStyle={animatedTextStyle} />
          )}
        </Animated.View>
      </Pressable>
    </View>
  );
};

export default memo(AnimatedLyricLine, (previous, next) => {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (key !== 'wordWindowSecond' && !Object.is(previous[key], next[key])) return false;
  }
  if (previous.wordWindowSecond === next.wordWindowSecond || !next.hasWordTimings) return true;
  const previousSecond = previous.wordWindowSecond ?? null;
  const nextSecond = next.wordWindowSecond ?? null;
  return (next.segments || []).every(segment => {
    if (!segment.isWord) return true;
    const swept = hasWordSweep(segment, previousSecond);
    if (swept !== hasWordSweep(segment, nextSecond)) return false;
    return swept || isPastWord(segment, previousSecond) === isPastWord(segment, nextSecond);
  });
});
