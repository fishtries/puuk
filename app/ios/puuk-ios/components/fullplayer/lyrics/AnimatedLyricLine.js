import React, { useEffect, useRef } from 'react';
import { Pressable } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withSequence,
  withDelay,
  FadeInDown,
  Easing,
  interpolateColor,
} from 'react-native-reanimated';
import { getLyricTarget } from './lyricDepth';

const AnimatedLyricLine = ({
  text,
  isActive,
  distance,
  index,
  activeIndex,
  isAutoScrollPaused = false,
  baseStyle,
  onLayout,
  onPress,
  onPressIn,
}) => {
  const initialRel = activeIndex === -2
    ? 0
    : activeIndex === -1
      ? (index + 1)
      : (index - activeIndex);
  const normalTarget = activeIndex === -2
    ? { scale: 1.0, opacity: 0.92, color: 1.0 }
    : getLyricTarget(initialRel);

  const initialTarget = isAutoScrollPaused
    ? (isActive ? { scale: 1.0, opacity: 1.0, color: 1.0 } : { scale: 1.0, opacity: 0.65, color: 0.45 })
    : normalTarget;

  const waveY = useSharedValue(0);
  const lineScale = useSharedValue(initialTarget.scale);
  const lineOpacity = useSharedValue(initialTarget.opacity);
  const colorProgress = useSharedValue(initialTarget.color);
  const lastActiveIndex = useRef(-1);
  const wasPausedRef = useRef(isAutoScrollPaused);

  useEffect(() => {
    if (activeIndex === -2) {
      lastActiveIndex.current = -2;
      waveY.value = 0;
      lineScale.value = 1.0;
      lineOpacity.value = 0.92;
      colorProgress.value = 1.0;
      return;
    }

    if (isAutoScrollPaused) {
      wasPausedRef.current = true;
      lastActiveIndex.current = activeIndex;
      waveY.value = withTiming(0, { duration: 150 });
      if (isActive) {
        lineScale.value = withTiming(1.0, { duration: 200, easing: Easing.out(Easing.cubic) });
        lineOpacity.value = withTiming(1.0, { duration: 200, easing: Easing.out(Easing.cubic) });
        colorProgress.value = withTiming(1.0, { duration: 200, easing: Easing.out(Easing.cubic) });
      } else {
        lineScale.value = withTiming(1.0, { duration: 200, easing: Easing.out(Easing.cubic) });
        lineOpacity.value = withTiming(0.65, { duration: 200, easing: Easing.out(Easing.cubic) });
        colorProgress.value = withTiming(0.45, { duration: 200, easing: Easing.out(Easing.cubic) });
      }
      return;
    }

    if (wasPausedRef.current) {
      wasPausedRef.current = false;
      lastActiveIndex.current = activeIndex;
      const rel = activeIndex === -1 ? (index + 1) : (index - activeIndex);
      const target = getLyricTarget(rel);
      waveY.value = withTiming(0, { duration: 200 });
      lineScale.value = withTiming(target.scale, { duration: 350, easing: Easing.out(Easing.cubic) });
      lineOpacity.value = withTiming(target.opacity, { duration: 350, easing: Easing.out(Easing.cubic) });
      colorProgress.value = withTiming(target.color, { duration: 350, easing: Easing.out(Easing.cubic) });
      return;
    }

    if (activeIndex === -1) {
      lastActiveIndex.current = -1;
      const target = getLyricTarget(index + 1);
      waveY.value = 0;
      lineScale.value = target.scale;
      lineOpacity.value = target.opacity;
      colorProgress.value = target.color;
      return;
    }

    const rel = index - activeIndex;

    if (lastActiveIndex.current === -1) {
      if (activeIndex === 0) {
        // Transition from intro (-1) to first line (0)
      } else {
        lastActiveIndex.current = activeIndex;
        const target = getLyricTarget(rel);
        waveY.value = 0;
        lineScale.value = target.scale;
        lineOpacity.value = target.opacity;
        colorProgress.value = target.color;
        return;
      }
    }

    if (lastActiveIndex.current !== activeIndex) {
      const prevIdx = lastActiveIndex.current === -1 ? -1 : lastActiveIndex.current;
      const diff = activeIndex - prevIdx;
      const direction = diff > 0 ? 1 : -1;

      if (direction > 0) {
        if (diff === 1) {
          if (rel === 0) {
            waveY.value = withSequence(
              withTiming(-12, { duration: 180, easing: Easing.out(Easing.cubic) }),
              withSpring(0, { damping: 22, stiffness: 125, mass: 0.8 })
            );
            lineScale.value = withTiming(1.0, { duration: 280, easing: Easing.out(Easing.cubic) });
            lineOpacity.value = withTiming(1.0, { duration: 280, easing: Easing.out(Easing.cubic) });
            colorProgress.value = withTiming(1.0, { duration: 280, easing: Easing.out(Easing.cubic) });
          } else if (rel === -1) {
            waveY.value = withSequence(
              withTiming(-26, { duration: 160, easing: Easing.out(Easing.cubic) }),
              withSpring(0, { damping: 20, stiffness: 115, mass: 0.8 })
            );
            lineScale.value = withTiming(0.96, { duration: 280, easing: Easing.out(Easing.cubic) });
            lineOpacity.value = withTiming(0.60, { duration: 280, easing: Easing.out(Easing.cubic) });
            colorProgress.value = withTiming(0.58, { duration: 280, easing: Easing.out(Easing.cubic) });
          } else if (rel === -2) {
            waveY.value = withSequence(
              withTiming(-13, { duration: 170, easing: Easing.out(Easing.quad) }),
              withSpring(0, { damping: 22, stiffness: 120, mass: 0.8 })
            );
            lineScale.value = withTiming(0.94, { duration: 280, easing: Easing.out(Easing.cubic) });
            lineOpacity.value = withTiming(0.45, { duration: 280, easing: Easing.out(Easing.cubic) });
            colorProgress.value = withTiming(0.38, { duration: 280, easing: Easing.out(Easing.cubic) });
          } else if (rel === -3) {
            waveY.value = withDelay(
              40,
              withSequence(
                withTiming(-7, { duration: 180, easing: Easing.out(Easing.quad) }),
                withSpring(0, { damping: 22, stiffness: 120, mass: 0.8 })
              )
            );
            lineScale.value = withTiming(0.92, { duration: 280, easing: Easing.out(Easing.cubic) });
            lineOpacity.value = withTiming(0.32, { duration: 280, easing: Easing.out(Easing.cubic) });
            colorProgress.value = withTiming(0.22, { duration: 280, easing: Easing.out(Easing.cubic) });
          } else if (rel < -3) {
            const target = getLyricTarget(rel);
            waveY.value = withSpring(0, { damping: 22, stiffness: 120 });
            lineScale.value = withTiming(target.scale, { duration: 280, easing: Easing.out(Easing.cubic) });
            lineOpacity.value = withTiming(target.opacity, { duration: 280, easing: Easing.out(Easing.cubic) });
            colorProgress.value = withTiming(target.color, { duration: 280, easing: Easing.out(Easing.cubic) });
          } else if (rel === 1) {
            const d1 = 70;
            waveY.value = withDelay(
              d1,
              withSequence(
                withTiming(-8, { duration: 220, easing: Easing.out(Easing.cubic) }),
                withSpring(0, { damping: 22, stiffness: 120, mass: 0.85 })
              )
            );
            lineScale.value = withDelay(d1, withTiming(0.96, { duration: 280, easing: Easing.out(Easing.cubic) }));
            lineOpacity.value = withDelay(d1, withTiming(0.60, { duration: 280, easing: Easing.out(Easing.cubic) }));
            colorProgress.value = withDelay(d1, withTiming(0.58, { duration: 280, easing: Easing.out(Easing.cubic) }));
          } else if (rel === 2) {
            const d2 = 140;
            waveY.value = withDelay(
              d2,
              withSequence(
                withTiming(-5.5, { duration: 230, easing: Easing.out(Easing.cubic) }),
                withSpring(0, { damping: 22, stiffness: 120, mass: 0.85 })
              )
            );
            lineScale.value = withDelay(d2, withTiming(0.94, { duration: 280, easing: Easing.out(Easing.cubic) }));
            lineOpacity.value = withDelay(d2, withTiming(0.45, { duration: 280, easing: Easing.out(Easing.cubic) }));
            colorProgress.value = withDelay(d2, withTiming(0.38, { duration: 280, easing: Easing.out(Easing.cubic) }));
          } else if (rel === 3) {
            const d3 = 210;
            waveY.value = withDelay(
              d3,
              withSequence(
                withTiming(-3.8, { duration: 240, easing: Easing.out(Easing.cubic) }),
                withSpring(0, { damping: 22, stiffness: 120, mass: 0.85 })
              )
            );
            lineScale.value = withDelay(d3, withTiming(0.92, { duration: 280, easing: Easing.out(Easing.cubic) }));
            lineOpacity.value = withDelay(d3, withTiming(0.32, { duration: 280, easing: Easing.out(Easing.cubic) }));
            colorProgress.value = withDelay(d3, withTiming(0.22, { duration: 280, easing: Easing.out(Easing.cubic) }));
          } else if (rel === 4) {
            const d4 = 280;
            waveY.value = withDelay(
              d4,
              withSequence(
                withTiming(-2.4, { duration: 240, easing: Easing.out(Easing.cubic) }),
                withSpring(0, { damping: 22, stiffness: 120, mass: 0.85 })
              )
            );
            lineScale.value = withDelay(d4, withTiming(0.91, { duration: 280, easing: Easing.out(Easing.cubic) }));
            lineOpacity.value = withDelay(d4, withTiming(0.22, { duration: 280, easing: Easing.out(Easing.cubic) }));
            colorProgress.value = withDelay(d4, withTiming(0.12, { duration: 280, easing: Easing.out(Easing.cubic) }));
          } else if (rel === 5) {
            const d5 = 350;
            waveY.value = withDelay(
              d5,
              withSequence(
                withTiming(-1.5, { duration: 240, easing: Easing.out(Easing.cubic) }),
                withSpring(0, { damping: 22, stiffness: 120, mass: 0.85 })
              )
            );
            lineScale.value = withDelay(d5, withTiming(0.90, { duration: 280, easing: Easing.out(Easing.cubic) }));
            lineOpacity.value = withDelay(d5, withTiming(0.16, { duration: 280, easing: Easing.out(Easing.cubic) }));
            colorProgress.value = withDelay(d5, withTiming(0.06, { duration: 280, easing: Easing.out(Easing.cubic) }));
          } else if (rel === 6) {
            const d6 = 420;
            waveY.value = withDelay(
              d6,
              withSequence(
                withTiming(-0.8, { duration: 240, easing: Easing.out(Easing.cubic) }),
                withSpring(0, { damping: 22, stiffness: 120, mass: 0.85 })
              )
            );
            lineScale.value = withDelay(d6, withTiming(0.89, { duration: 280, easing: Easing.out(Easing.cubic) }));
            lineOpacity.value = withDelay(d6, withTiming(0.11, { duration: 280, easing: Easing.out(Easing.cubic) }));
            colorProgress.value = withDelay(d6, withTiming(0.02, { duration: 280, easing: Easing.out(Easing.cubic) }));
          } else {
            const target = getLyricTarget(rel);
            waveY.value = withSpring(0, { damping: 22, stiffness: 120 });
            lineScale.value = withTiming(target.scale, { duration: 280, easing: Easing.out(Easing.cubic) });
            lineOpacity.value = withTiming(target.opacity, { duration: 280, easing: Easing.out(Easing.cubic) });
            colorProgress.value = withTiming(target.color, { duration: 280, easing: Easing.out(Easing.cubic) });
          }
        } else {
          const target = getLyricTarget(rel);
          waveY.value = withSpring(0, { damping: 24, stiffness: 130 });
          lineScale.value = withTiming(target.scale, { duration: 280, easing: Easing.out(Easing.cubic) });
          lineOpacity.value = withTiming(target.opacity, { duration: 280, easing: Easing.out(Easing.cubic) });
          colorProgress.value = withTiming(target.color, { duration: 280, easing: Easing.out(Easing.cubic) });
        }
      } else {
        if (diff === -1) {
          if (rel === 0) {
            waveY.value = withSequence(
              withTiming(12, { duration: 180, easing: Easing.out(Easing.cubic) }),
              withSpring(0, { damping: 22, stiffness: 125, mass: 0.8 })
            );
            lineScale.value = withTiming(1.0, { duration: 280, easing: Easing.out(Easing.cubic) });
            lineOpacity.value = withTiming(1.0, { duration: 280, easing: Easing.out(Easing.cubic) });
            colorProgress.value = withTiming(1.0, { duration: 280, easing: Easing.out(Easing.cubic) });
          } else if (rel === 1) {
            waveY.value = withSequence(
              withTiming(26, { duration: 160, easing: Easing.out(Easing.cubic) }),
              withSpring(0, { damping: 20, stiffness: 115, mass: 0.8 })
            );
            lineScale.value = withTiming(0.96, { duration: 280, easing: Easing.out(Easing.cubic) });
            lineOpacity.value = withTiming(0.60, { duration: 280, easing: Easing.out(Easing.cubic) });
            colorProgress.value = withTiming(0.58, { duration: 280, easing: Easing.out(Easing.cubic) });
          } else if (rel === 2) {
            waveY.value = withSequence(
              withTiming(13, { duration: 170, easing: Easing.quad }),
              withSpring(0, { damping: 22, stiffness: 120, mass: 0.8 })
            );
            lineScale.value = withTiming(0.94, { duration: 280, easing: Easing.out(Easing.cubic) });
            lineOpacity.value = withTiming(0.45, { duration: 280, easing: Easing.out(Easing.cubic) });
            colorProgress.value = withTiming(0.38, { duration: 280, easing: Easing.out(Easing.cubic) });
          } else if (rel === 3) {
            waveY.value = withDelay(
              40,
              withSequence(
                withTiming(7, { duration: 180, easing: Easing.quad }),
                withSpring(0, { damping: 22, stiffness: 120, mass: 0.8 })
              )
            );
            lineScale.value = withTiming(0.92, { duration: 280, easing: Easing.out(Easing.cubic) });
            lineOpacity.value = withTiming(0.32, { duration: 280, easing: Easing.out(Easing.cubic) });
            colorProgress.value = withTiming(0.22, { duration: 280, easing: Easing.out(Easing.cubic) });
          } else if (rel > 3) {
            const target = getLyricTarget(rel);
            waveY.value = withSpring(0, { damping: 22, stiffness: 120 });
            lineScale.value = withTiming(target.scale, { duration: 280, easing: Easing.out(Easing.cubic) });
            lineOpacity.value = withTiming(target.opacity, { duration: 280, easing: Easing.out(Easing.cubic) });
            colorProgress.value = withTiming(target.color, { duration: 280, easing: Easing.out(Easing.cubic) });
          } else if (rel === -1) {
            const d1 = 70;
            waveY.value = withDelay(
              d1,
              withSequence(
                withTiming(8, { duration: 200, easing: Easing.out(Easing.cubic) }),
                withSpring(0, { damping: 22, stiffness: 120, mass: 0.85 })
              )
            );
            lineScale.value = withDelay(d1, withTiming(0.96, { duration: 280, easing: Easing.out(Easing.cubic) }));
            lineOpacity.value = withDelay(d1, withTiming(0.60, { duration: 280, easing: Easing.out(Easing.cubic) }));
            colorProgress.value = withDelay(d1, withTiming(0.58, { duration: 280, easing: Easing.out(Easing.cubic) }));
          } else if (rel === -2) {
            const d2 = 140;
            waveY.value = withDelay(
              d2,
              withSequence(
                withTiming(5.5, { duration: 210, easing: Easing.out(Easing.cubic) }),
                withSpring(0, { damping: 22, stiffness: 120, mass: 0.85 })
              )
            );
            lineScale.value = withDelay(d2, withTiming(0.94, { duration: 280, easing: Easing.out(Easing.cubic) }));
            lineOpacity.value = withDelay(d2, withTiming(0.45, { duration: 280, easing: Easing.out(Easing.cubic) }));
            colorProgress.value = withDelay(d2, withTiming(0.38, { duration: 280, easing: Easing.out(Easing.cubic) }));
          } else if (rel === -3) {
            const d3 = 210;
            waveY.value = withDelay(
              d3,
              withSequence(
                withTiming(3.8, { duration: 220, easing: Easing.out(Easing.cubic) }),
                withSpring(0, { damping: 22, stiffness: 120, mass: 0.85 })
              )
            );
            lineScale.value = withDelay(d3, withTiming(0.92, { duration: 280, easing: Easing.out(Easing.cubic) }));
            lineOpacity.value = withDelay(d3, withTiming(0.32, { duration: 280, easing: Easing.out(Easing.cubic) }));
            colorProgress.value = withDelay(d3, withTiming(0.22, { duration: 280, easing: Easing.out(Easing.cubic) }));
          } else if (rel === -4) {
            const d4 = 280;
            waveY.value = withDelay(
              d4,
              withSequence(
                withTiming(2.4, { duration: 220, easing: Easing.out(Easing.cubic) }),
                withSpring(0, { damping: 22, stiffness: 120, mass: 0.85 })
              )
            );
            lineScale.value = withDelay(d4, withTiming(0.91, { duration: 280, easing: Easing.out(Easing.cubic) }));
            lineOpacity.value = withDelay(d4, withTiming(0.22, { duration: 280, easing: Easing.out(Easing.cubic) }));
            colorProgress.value = withDelay(d4, withTiming(0.12, { duration: 280, easing: Easing.out(Easing.cubic) }));
          } else if (rel === -5) {
            const d5 = 350;
            waveY.value = withDelay(
              d5,
              withSequence(
                withTiming(1.5, { duration: 220, easing: Easing.out(Easing.cubic) }),
                withSpring(0, { damping: 22, stiffness: 120, mass: 0.85 })
              )
            );
            lineScale.value = withDelay(d5, withTiming(0.90, { duration: 280, easing: Easing.out(Easing.cubic) }));
            lineOpacity.value = withDelay(d5, withTiming(0.16, { duration: 280, easing: Easing.out(Easing.cubic) }));
            colorProgress.value = withDelay(d5, withTiming(0.06, { duration: 280, easing: Easing.out(Easing.cubic) }));
          } else if (rel === -6) {
            const d6 = 420;
            waveY.value = withDelay(
              d6,
              withSequence(
                withTiming(0.8, { duration: 220, easing: Easing.out(Easing.cubic) }),
                withSpring(0, { damping: 22, stiffness: 120, mass: 0.85 })
              )
            );
            lineScale.value = withDelay(d6, withTiming(0.89, { duration: 280, easing: Easing.out(Easing.cubic) }));
            lineOpacity.value = withDelay(d6, withTiming(0.11, { duration: 280, easing: Easing.out(Easing.cubic) }));
            colorProgress.value = withDelay(d6, withTiming(0.02, { duration: 280, easing: Easing.out(Easing.cubic) }));
          } else {
            const target = getLyricTarget(rel);
            waveY.value = withSpring(0, { damping: 22, stiffness: 120 });
            lineScale.value = withTiming(target.scale, { duration: 280, easing: Easing.out(Easing.cubic) });
            lineOpacity.value = withTiming(target.opacity, { duration: 280, easing: Easing.out(Easing.cubic) });
            colorProgress.value = withTiming(target.color, { duration: 280, easing: Easing.out(Easing.cubic) });
          }
        } else {
          const target = getLyricTarget(rel);
          waveY.value = withSpring(0, { damping: 24, stiffness: 130 });
          lineScale.value = withTiming(target.scale, { duration: 280, easing: Easing.out(Easing.cubic) });
          lineOpacity.value = withTiming(target.opacity, { duration: 280, easing: Easing.out(Easing.cubic) });
          colorProgress.value = withTiming(target.color, { duration: 280, easing: Easing.out(Easing.cubic) });
        }
      }
    }
    lastActiveIndex.current = activeIndex;
  }, [activeIndex, isAutoScrollPaused, isActive, index]);

  const animatedLineStyle = useAnimatedStyle(() => {
    return {
      opacity: lineOpacity.value,
      transform: [
        { translateY: waveY.value },
        { scale: lineScale.value },
      ],
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
      entering={FadeInDown.delay(Math.min(index * 40, 800)).duration(400)}
      onLayout={(e) => onLayout && onLayout(index, e.nativeEvent.layout.y)}
    >
      <Pressable
        onPress={onPress}
        onPressIn={onPressIn}
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
