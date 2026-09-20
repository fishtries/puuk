import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  Image,
  TouchableOpacity,
  Dimensions,
  FlatList,
  ActivityIndicator,
  StyleSheet,
  Pressable,
  ScrollView
} from 'react-native';
import { SafeAreaView, SafeAreaProvider, useSafeAreaInsets, initialWindowMetrics } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import QueueItem from './QueueItem';
import CoverImage from './CoverImage';
import { parseLrc, isLrcSynced, extractPlainLyrics } from '../utils/lrcParser';
import { authFetch, SERVER_URL } from '../utils/api';

import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withSequence,
  runOnJS,
  interpolate,
  Extrapolation,
  withDelay,
  FadeInDown,
  FadeOutDown,
  FadeInUp,
  FadeOutUp,
  LinearTransition,
  FadeIn,
  FadeOut,
  Easing,
  interpolateColor,
  cancelAnimation,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import MaskedView from '@react-native-masked-view/masked-view';
import { easeGradient } from 'react-native-easing-gradient';
import { Gesture, GestureDetector, GestureHandlerRootView, FlatList as GestureHandlerFlatList, ScrollView as GestureHandlerScrollView } from 'react-native-gesture-handler';

const { width, height } = Dimensions.get('window');

const ChasingArrowsIcon = ({ progress, direction = 'right', size = 32, spacing = 16, color = '#ffffff' }) => {
  const t0Style = useAnimatedStyle(() => ({
    position: 'absolute',
    opacity: interpolate(progress.value, [0, 1], [0, 1]),
    transform: [{ translateX: interpolate(progress.value, [0, 1], [-spacing - spacing / 2, -spacing / 2]) }]
  }));
  const t1Style = useAnimatedStyle(() => ({
    position: 'absolute',
    opacity: 1,
    transform: [{ translateX: interpolate(progress.value, [0, 1], [-spacing / 2, spacing / 2]) }]
  }));
  const t2Style = useAnimatedStyle(() => ({
    position: 'absolute',
    opacity: interpolate(progress.value, [0, 1], [1, 0]),
    transform: [{ translateX: interpolate(progress.value, [0, 1], [spacing / 2, spacing + spacing / 2]) }]
  }));

  return (
    <View style={{
      width: 40,
      height: 40,
      justifyContent: 'center',
      alignItems: 'center',
      transform: [{ rotate: direction === 'right' ? '0deg' : '180deg' }]
    }}>
      <Animated.View style={t0Style}><Ionicons name="play" size={size} color={color} /></Animated.View>
      <Animated.View style={t1Style}><Ionicons name="play" size={size} color={color} /></Animated.View>
      <Animated.View style={t2Style}><Ionicons name="play" size={size} color={color} /></Animated.View>
    </View>
  );
};

const TopBlurOverlay = ({ animatedBgStyle, insets }) => {
  const { colors, locations } = easeGradient({
    colorStops: {
      0: { color: "rgba(0,0,0,1)" },
      0.4: { color: "rgba(0,0,0,0.95)" },
      1: { color: "rgba(0,0,0,0)" },
    },
  });
  const topHeight = (insets?.top || 47) + 155;
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: topHeight, zIndex: 10 }} pointerEvents="none">
      <MaskedView maskElement={<LinearGradient locations={locations} colors={colors} style={StyleSheet.absoluteFill} />} style={StyleSheet.absoluteFill}>
        <BlurView intensity={40} tint="default" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { opacity: 0.7 }]}>
          <Animated.View style={[StyleSheet.absoluteFill, animatedBgStyle]} />
        </View>
      </MaskedView>
    </View>
  );
};

const BottomBlurOverlay = ({ insets }) => {
  const { colors, locations } = easeGradient({
    colorStops: {
      0: { color: "rgba(0,0,0,0)" },
      0.5: { color: "rgba(0,0,0,0.95)" },
      1: { color: "rgba(0,0,0,1)" },
    },
  });

  const bottomInset = insets?.bottom || 34;
  const blurHeight = bottomInset + 310;

  return (
    <View
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: blurHeight,
        zIndex: 10,
      }}
      pointerEvents="none"
    >
      <MaskedView
        maskElement={
          <LinearGradient
            locations={locations}
            colors={colors}
            style={StyleSheet.absoluteFill}
          />
        }
        style={StyleSheet.absoluteFill}
      >
        <BlurView intensity={50} tint="dark" style={StyleSheet.absoluteFill} />
      </MaskedView>
    </View>
  );
};

const getLyricTarget = (rel) => {
  'worklet';
  const absRel = Math.abs(rel);
  if (absRel === 0) {
    return { scale: 1.0, opacity: 1.0, color: 1.0 };
  } else if (absRel === 1) {
    return { scale: 0.96, opacity: 0.60, color: 0.58 };
  } else if (absRel === 2) {
    return { scale: 0.94, opacity: 0.45, color: 0.38 };
  } else if (absRel === 3) {
    return { scale: 0.92, opacity: 0.32, color: 0.22 };
  } else if (absRel === 4) {
    return { scale: 0.91, opacity: 0.22, color: 0.12 };
  } else if (absRel === 5) {
    return { scale: 0.90, opacity: 0.16, color: 0.06 };
  } else if (absRel === 6) {
    return { scale: 0.89, opacity: 0.11, color: 0.02 };
  } else {
    return { scale: 0.88, opacity: 0.08, color: 0.0 };
  }
};

const computeActiveLyricIndex = (lyricsList, curTime) => {
  if (!lyricsList || lyricsList.length === 0) return -1;
  const firstWithTime = lyricsList.find(l => l.time !== null);
  if (!firstWithTime) return -2; // unsynced
  if (curTime < firstWithTime.time) return -1; // intro before first line
  return lyricsList.findIndex((line, i) => {
    if (line.time === null) return false;
    if (curTime < line.time) return false;
    const nextLine = lyricsList.slice(i + 1).find(l => l.time !== null);
    if (!nextLine) return true;
    return curTime < nextLine.time;
  });
};

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
  playTrack,
  onAddToPlaylist,
  onToggleLike,
  isLiked
}) => {
  const trackIsLiked = isLiked !== undefined ? isLiked : !!currentTrack?.is_liked;
  const insets = initialWindowMetrics?.insets || { top: 47, bottom: 34, left: 0, right: 0 };
  const bgColor = useSharedValue('#4c2e4f');
  const [isQueueVisible, setIsQueueVisible] = useState(false);
  const [isSliding, setIsSliding] = useState(false);
  const queueTransition = useSharedValue(0);
  const queueAnimationRef = useRef(false);
  const [slideValue, setSlideValue] = useState(0);

  const [lyrics, setLyrics] = useState([]);
  const [plainLyricsText, setPlainLyricsText] = useState('');
  const [hasSyncedLyrics, setHasSyncedLyrics] = useState(false);
  const [isLyricsView, setIsLyricsView] = useState(false);
  const [isLyricsMounted, setIsLyricsMounted] = useState(false);
  const isLyricsMountedRef = useRef(false);
  isLyricsMountedRef.current = isLyricsMounted;
  const lyricsTransition = useSharedValue(0);
  const lyricsRotation = useSharedValue(0);

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

  const [isLoadingLyrics, setIsLoadingLyrics] = useState(false);
  const [isAutoScrollPaused, setIsAutoScrollPaused] = useState(false);
  const lyricsScrollRef = useRef(null);
  const lyricLayouts = useRef({});

  const [isLyricsCompact, setIsLyricsCompact] = useState(false);
  const isLyricsCompactRef = useRef(false);
  isLyricsCompactRef.current = isLyricsCompact;
  const isEffectivelyCompact = isLyricsView && isLyricsCompact;
  const inactivityTimerRef = useRef(null);

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

  const triggerExitCompactMode = useCallback(() => {
    if (exitCompactModeRef.current) {
      exitCompactModeRef.current();
    }
  }, []);

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
  const handleCloseRef = useRef(null);

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
      if (handleCloseRef.current) {
        handleCloseRef.current();
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

  // === АНИМАЦИИ КНОПОК УПРАВЛЕНИЯ ===
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

  // === REANIMATED СОСТОЯНИЯ (работают в нативном потоке) ===
  const expandProgress = useSharedValue(0);
  const contentOpacity = useSharedValue(0);
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
      expandProgress.value = withTiming(1, {
        duration: 320,
        easing: Easing.bezier(0.2, 0.9, 0.3, 1),
      });
      contentOpacity.value = withTiming(1, { duration: 250 });
      setIsQueueVisible(false);
      cancelAnimation(queueTransition);
      queueTransition.value = 0;
      setIsLyricsCompact(false);
      setIsLyricsView(false);
      setIsLyricsMounted(false);
      isLyricsMountedRef.current = false;
      cancelAnimation(lyricsTransition);
      cancelAnimation(lyricsRotation);
      lyricsTransition.value = 0;
      lyricsRotation.value = 0;
    } else {
      contentOpacity.value = withTiming(0, { duration: 180 });
      expandProgress.value = withTiming(0, {
        duration: 250,
        easing: Easing.bezier(0.25, 1, 0.5, 1),
      });
      setIsLyricsCompact(false);
      setIsLyricsView(false);
      setIsLyricsMounted(false);
      isLyricsMountedRef.current = false;
      setIsQueueVisible(false);
      cancelAnimation(queueTransition);
      cancelAnimation(lyricsTransition);
      cancelAnimation(lyricsRotation);
      queueTransition.value = 0;
      lyricsTransition.value = 0;
      lyricsRotation.value = 0;
    }
  }, [isPlayerVisible]);

  useEffect(() => {
    if (playerExpandToken && playerExpandToken > 0) {
      expandProgress.value = withTiming(1, {
        duration: 320,
        easing: Easing.bezier(0.2, 0.9, 0.3, 1),
      });
      contentOpacity.value = withTiming(1, { duration: 250 });
      setIsQueueVisible(false);
      cancelAnimation(queueTransition);
      queueTransition.value = 0;
      setIsLyricsCompact(false);
      setIsLyricsView(false);
      setIsLyricsMounted(false);
      isLyricsMountedRef.current = false;
      cancelAnimation(lyricsTransition);
      cancelAnimation(lyricsRotation);
      lyricsTransition.value = 0;
      lyricsRotation.value = 0;
    }
  }, [playerExpandToken]);

  useEffect(() => {
    if (currentTrack?.coverArt && currentTrack.coverArt.includes('/api/cover/')) {
      const colorUrl = currentTrack.coverArt.replace('/api/cover/', '/api/color/');
      fetch(colorUrl)
        .then(r => r.json())
        .then(data => {
          if (data.color) {
            bgColor.value = withTiming(data.color, { duration: 800 });
          }
        })
        .catch(err => console.log('Failed to fetch color', err));
    }
  }, [currentTrack]);

  // Синхронизация полосы прогресса с аудио
  useEffect(() => {
    if (!isSliding && duration > 0) {
      slideProgressShared.value = withTiming(currentTime / duration, { duration: 250 });
    }
  }, [currentTime, duration, isSliding]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const onExpandRef = useRef(onExpand);
  onExpandRef.current = onExpand;

  const handleClose = useCallback(() => {
    contentOpacity.value = withTiming(0, { duration: 180 });
    expandProgress.value = withTiming(0, {
      duration: 250,
      easing: Easing.bezier(0.25, 1, 0.5, 1),
    });
    setIsLyricsCompact(false);
    setIsLyricsView(false);
    setIsLyricsMounted(false);
    isLyricsMountedRef.current = false;
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
  }, []);
  handleCloseRef.current = handleClose;

  const handleExpand = useCallback(() => {
    expandProgress.value = withTiming(1, {
      duration: 320,
      easing: Easing.bezier(0.2, 0.9, 0.3, 1),
    });
    contentOpacity.value = withTiming(1, { duration: 250 });
    setIsQueueVisible(false);
    cancelAnimation(queueTransition);
    queueTransition.value = 0;
    setIsLyricsCompact(false);
    setIsLyricsView(false);
    setIsLyricsMounted(false);
    isLyricsMountedRef.current = false;
    cancelAnimation(lyricsTransition);
    cancelAnimation(lyricsRotation);
    lyricsTransition.value = 0;
    lyricsRotation.value = 0;
    if (onExpandRef.current) {
      onExpandRef.current();
    }
  }, []);

  const createSwipeDownGesture = () => {
    return Gesture.Pan()
      .activeOffsetY(10)
      .failOffsetY(-15)
      .onUpdate((event) => {
        'worklet';
        if (event.translationY >= 0) {
          const prog = Math.max(0, 1 - (event.translationY / (height * 0.75)));
          expandProgress.value = prog;
        }
      })
      .onEnd((event) => {
        'worklet';
        if (event.translationY > 70 || event.velocityY > 350) {
          expandProgress.value = withTiming(0, {
            duration: 250,
            easing: Easing.bezier(0.25, 1, 0.5, 1),
          });
          contentOpacity.value = withTiming(0, { duration: 180 });
          runOnJS(handleClose)();
        } else {
          expandProgress.value = withSpring(1, {
            damping: 28,
            stiffness: 220,
            mass: 0.8,
          });
          contentOpacity.value = withTiming(1, { duration: 200 });
        }
      })
      .onFinalize((event, success) => {
        'worklet';
        if (!success && expandProgress.value < 0.99 && expandProgress.value > 0.01) {
          expandProgress.value = withSpring(1, {
            damping: 28,
            stiffness: 220,
            mass: 0.8,
          });
          contentOpacity.value = withTiming(1, { duration: 200 });
        }
      });
  };

  const headerSwipeGesture = useMemo(() => createSwipeDownGesture(), []);
  const mainSwipeGesture = useMemo(() => createSwipeDownGesture(), []);
  const bottomSwipeGesture = useMemo(() => createSwipeDownGesture(), []);
  const lyricsHeaderSwipeGesture = useMemo(() => createSwipeDownGesture(), []);
  const queueHeaderSwipeGesture = useMemo(() => createSwipeDownGesture(), []);

  const animatedContainerStyle = useAnimatedStyle(() => {
    return {
      top: interpolate(expandProgress.value, [0, 1], [height - 157, 0], Extrapolation.CLAMP),
      bottom: interpolate(expandProgress.value, [0, 1], [94, 0], Extrapolation.CLAMP),
      left: interpolate(expandProgress.value, [0, 1], [10, 0], Extrapolation.CLAMP),
      right: interpolate(expandProgress.value, [0, 1], [10, 0], Extrapolation.CLAMP),
      borderRadius: interpolate(expandProgress.value, [0, 1], [14, 0], Extrapolation.CLAMP),
      position: 'absolute',
      overflow: 'hidden',
    };
  });

  const miniPlayerAnimatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(expandProgress.value, [0, 0.15], [1, 0], Extrapolation.CLAMP);
    const translateY = interpolate(expandProgress.value, [0, 0.15], [0, -15], Extrapolation.CLAMP);
    return {
      opacity,
      transform: [{ translateY }],
      zIndex: expandProgress.value < 0.1 ? 50 : -1,
    };
  });

  const contentAnimatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(expandProgress.value, [0.06, 0.35], [0, 1], Extrapolation.CLAMP) * contentOpacity.value;
    const translateY = interpolate(expandProgress.value, [0, 1], [30, 0], Extrapolation.CLAMP);
    return {
      opacity,
      transform: [{ translateY }],
    };
  });

  const gradientOverlayAnimatedStyle = useAnimatedStyle(() => {
    const gradOpacity = interpolate(expandProgress.value, [0.08, 0.35], [0, 1], Extrapolation.CLAMP);
    return {
      opacity: gradOpacity * contentOpacity.value,
    };
  });

  // === НАСТРОЙКА ЖЕСТА "ПОЛЗУНКА ПЕРЕМОТКИ" (Native Thread) ===
  const scrubGesture = Gesture.Pan()
    // Разрешаем ползунку ловить касания параллельно со свайпом (хотя они не перекрываются, это хорошая практика)
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

  const toggleQueue = () => {
    const nextState = !isQueueVisible;
    if (nextState) {
      queueAnimationRef.current = true;
      setTimeout(() => { queueAnimationRef.current = false; }, 1000);
      if (isLyricsView) {
        setIsLyricsCompact(false);
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
  const TARGET_DELTA_Y = -40 - (BIG_ART_SIZE / 2);

  const albumArtFlipStyle = useAnimatedStyle(() => {
    const rotateY = lyricsRotation.value;

    const scale = interpolate(
      lyricsTransition.value,
      [0, 1],
      [1, TARGET_SCALE],
      Extrapolation.CLAMP
    );

    const translateX = interpolate(
      lyricsTransition.value,
      [0, 1],
      [0, TARGET_DELTA_X],
      Extrapolation.CLAMP
    );
    const translateY = interpolate(
      lyricsTransition.value,
      [0, 1],
      [0, TARGET_DELTA_Y],
      Extrapolation.CLAMP
    );

    const shadowOpacity = interpolate(
      lyricsTransition.value,
      [0, 1],
      [0.5, 0.15],
      Extrapolation.CLAMP
    );
    const shadowRadius = interpolate(
      lyricsTransition.value,
      [0, 1],
      [15, 4],
      Extrapolation.CLAMP
    );
    const elevation = interpolate(
      lyricsTransition.value,
      [0, 1],
      [10, 2],
      Extrapolation.CLAMP
    );

    return {
      opacity: 1,
      shadowOpacity,
      shadowRadius,
      elevation,
      transform: [
        { translateX },
        { translateY },
        { perspective: 1200 },
        { rotateY: `${rotateY}deg` },
        { scale },
      ],
    };
  });

  const albumArtRadiusStyle = useAnimatedStyle(() => {
    const radius = interpolate(
      lyricsTransition.value,
      [0, 1],
      [12, 6 / TARGET_SCALE],
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
    const translateY = interpolate(
      lyricsTransition.value,
      [0, 0.55],
      [0, -45],
      Extrapolation.CLAMP
    );
    const opacity = interpolate(
      lyricsTransition.value,
      [0, 0.38],
      [1, 0],
      Extrapolation.CLAMP
    );
    const scale = interpolate(
      lyricsTransition.value,
      [0, 0.45],
      [1, 0.94],
      Extrapolation.CLAMP
    );
    return {
      opacity,
      transform: [{ translateY }, { scale }],
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
      lyricsTransition.value,
      [0, 0.38],
      [1, 0.88],
      Extrapolation.CLAMP
    );
    return {
      transform: [{ scale }],
    };
  });

  const playerHeaderAnimatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      lyricsTransition.value,
      [0, 0.3],
      [1, 0],
      Extrapolation.CLAMP
    );
    const translateY = interpolate(
      lyricsTransition.value,
      [0, 0.3],
      [0, -15],
      Extrapolation.CLAMP
    );
    return {
      opacity,
      transform: [{ translateY }],
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

  const formatTime = (ms) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  };

  const position = isSliding ? slideValue * 1000 : currentTime * 1000;
  const durMs = duration * 1000;

  if (!currentTrack) return null;

  const getTrackDetails = (track) => {
    if (!track) return { displayTitle: '', displayArtist: '' };
    return {
      displayTitle: track.title || '',
      displayArtist: track.artist || ''
    };
  };

  const { displayTitle, displayArtist } = getTrackDetails(currentTrack);

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, { zIndex: 100 }]}
      pointerEvents="box-none"
    >
      <GestureHandlerRootView style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <Animated.View style={[styles.container, animatedContainerStyle]} pointerEvents="auto">
          {/* Base dark background for mini player */}
          <View style={{ ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(30, 30, 30, 0.95)' }} />

          {/* Плавно меняющийся сплошной цветной фон */}
          <Animated.View style={[StyleSheet.absoluteFill, animatedBgStyle]} />

          {/* Градиент затемнения (от полностью прозрачного до цвета подвала) */}
          <Animated.View style={[StyleSheet.absoluteFill, gradientOverlayAnimatedStyle]} pointerEvents="none">
            <LinearGradient
              colors={['#120d1400', '#120d14']}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>


          {/* Mini Player UI */}
          <Animated.View
            style={[
              styles.miniPlayerContainer,
              miniPlayerAnimatedStyle,
            ]}
            pointerEvents={isPlayerVisible ? 'none' : 'auto'}
          >
            <TouchableOpacity
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}
              onPress={handleExpand}
              activeOpacity={0.9}
            >
              <CoverImage source={currentTrack.coverArt} style={styles.miniPlayerImage} />
              <View style={styles.miniPlayerInfo}>
                <Text style={styles.miniPlayerTitle} numberOfLines={1}>{displayTitle}</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity style={styles.miniPlayerButton} onPress={(e) => { e.stopPropagation(); togglePlayPause(); }}>
              <Ionicons name={isPlaying ? "pause" : "play"} size={28} color="#ffffff" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.miniPlayerButton} onPress={(e) => { e.stopPropagation(); fetchNextTrack(); }}>
              <Ionicons name="play-forward" size={28} color="#ffffff" />
            </TouchableOpacity>
          </Animated.View>

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

          <Animated.View
            style={[
              styles.safeArea,
              {
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                paddingTop: insets.top + 10,
                paddingBottom: insets.bottom + 35,
                width: width,
                height: height,
                zIndex: 20,
              },
              contentAnimatedStyle
            ]}
            pointerEvents={isPlayerVisible ? 'box-none' : 'none'}
          >

            {/* In full player view, show drag indicator at top */}
            <GestureDetector gesture={headerSwipeGesture}>
              <Animated.View
                style={[styles.playerHeader, playerHeaderAnimatedStyle]}
                pointerEvents={isLyricsView ? 'none' : 'auto'}
              >
                <TouchableOpacity
                  style={styles.closeButton}
                  onPress={handleClose}
                  hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
                  activeOpacity={0.7}
                >
                  <Ionicons name="chevron-down" size={26} color="rgba(255, 255, 255, 0.7)" />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleClose}
                  hitSlop={{ top: 15, bottom: 15, left: 20, right: 20 }}
                  activeOpacity={0.7}
                >
                  <View style={styles.dragIndicator} />
                </TouchableOpacity>
                <View style={styles.closeButton} />
              </Animated.View>
            </GestureDetector>

            {/* Middle container: Cover art & info when NOT in lyrics view, or queue view */}
            <View style={{ flex: 1, width: '100%', justifyContent: 'flex-start' }} pointerEvents={isLyricsView ? 'box-none' : 'auto'}>
              <Animated.View
                style={[playerAnimatedStyle, { width: '100%', alignItems: 'center', flex: 1 }]}
                pointerEvents={isLyricsView || isQueueVisible ? 'none' : 'auto'}
              >
                <GestureDetector gesture={mainSwipeGesture}>
                  <Animated.View style={{ width: '100%', flex: 1, alignItems: 'center', backgroundColor: 'transparent' }}>
                    <Animated.View style={[styles.artContainer, albumArtFlipStyle]}>
                      <Animated.View style={[{ width: '100%', height: '100%', overflow: 'hidden' }, albumArtRadiusStyle]}>
                        <CoverImage
                          source={currentTrack.coverArt}
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

              <Animated.View
                style={[queueAnimatedStyle, StyleSheet.absoluteFill]}
                pointerEvents={(isQueueVisible && !isLyricsView) ? 'auto' : 'none'}
              >
                <View style={styles.queueContainer}>
                  <GestureDetector gesture={queueHeaderSwipeGesture}>
                    <Animated.View style={{ width: '100%', paddingBottom: 15, backgroundColor: 'transparent' }}>
                      <Text style={styles.queueTitle}>These are next</Text>
                    </Animated.View>
                  </GestureDetector>
                  <GestureHandlerFlatList
                    data={upNextQueue}
                    keyExtractor={(item, index) => item.id + index.toString()}
                    showsVerticalScrollIndicator={false}
                    renderItem={({ item, index }) => (
                      <QueueItem
                        item={item}
                        index={index}
                        isVisible={isQueueVisible}
                        shouldAnimate={queueAnimationRef.current}
                        onPress={() => playTrack(item)}
                      />
                    )}
                  />
                </View>
              </Animated.View>
            </View>

            {/* Bottom controls container */}
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

                  {!isEffectivelyCompact && (
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
                  )}

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
                        <TouchableOpacity onPress={() => {
                          if (isLyricsView) {
                            setIsLyricsCompact(false);
                            setIsLyricsView(false);
                          } else {
                            setIsQueueVisible(false);
                            cancelAnimation(queueTransition);
                            queueTransition.value = withTiming(0, { duration: 250 });
                            setIsLyricsMounted(true);
                            setIsLyricsView(true);
                          }
                        }} style={styles.compactBtn}>
                          <Ionicons name={isLyricsView ? "text" : "text-outline"} size={isEffectivelyCompact ? 26 : 26} color={isLyricsView ? "#6C3AED" : "#e5e5ea"} />
                        </TouchableOpacity>
                      </Animated.View>

                      {!isEffectivelyCompact && (
                        <Animated.View
                          layout={LinearTransition.springify()}
                          exiting={FadeOut.duration(300)}
                          entering={FadeIn.duration(300)}
                        >
                          <TouchableOpacity onPress={toggleQueue} style={styles.compactBtn}>
                            <Ionicons name="list" size={26} color={isQueueVisible ? "#ff2d55" : "#e5e5ea"} />
                          </TouchableOpacity>
                        </Animated.View>
                      )}
                    </Animated.View>
                  </Animated.View>

                </Animated.View>
              </GestureDetector>
            </Animated.View>

          </Animated.View>
        </Animated.View>
      </GestureHandlerRootView>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#333',
  },
  safeArea: {
    alignItems: 'center',
    paddingHorizontal: 30,
    justifyContent: 'space-between',
    paddingTop: 10,
    paddingBottom: 20,
  },
  playerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    height: 40,
  },
  closeButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dragIndicator: {
    width: 40,
    height: 5,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    borderRadius: 3,
  },
  artContainer: {
    width: width - 60,
    height: width - 60,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 15,
    elevation: 10,
    marginBottom: 20,
    marginTop: 20,
  },
  albumArt: {
    width: '100%',
    height: '100%',
    borderRadius: 10,
  },
  albumArtPlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#1c1c1e',
  },
  trackInfoContainer: {
    width: '100%',
    marginBottom: 30,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  textContainer: {
    flex: 1,
    paddingRight: 10,
  },
  titleText: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  artistText: {
    color: '#e5e5ea',
    fontSize: 18,
    opacity: 0.8,
  },
  progressContainer: {
    width: '100%',
    paddingVertical: 10,
    marginBottom: 10,
  },
  progressBarBackground: {
    width: '100%',
    height: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 2,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 5,
  },
  progressBarFill: {
    height: 4,
    backgroundColor: '#ffffff',
    borderRadius: 2,
    position: 'absolute',
    left: 0,
  },
  progressThumb: {
    width: 8,
    height: 8,
    backgroundColor: '#ffffff',
    borderRadius: 4,
    position: 'absolute',
    marginLeft: -4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  timeText: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 12,
    fontWeight: '500',
  },
  controlsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '80%',
    marginBottom: 30,
  },
  controlButton: {
    padding: 10,
  },
  playPauseButton: {
    padding: 10,
  },
  bottomControls: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '60%',
    marginTop: 10,
  },
  queueContainer: {
    flex: 1,
    width: '100%',
    marginTop: 20,
    marginBottom: 20,
  },
  queueTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#ffffff',
    marginBottom: 15,
  },
  normalBottomRow: {
    flexDirection: 'column',
    width: '100%',
    alignItems: 'center',
  },
  compactHandleContainer: {
    width: '100%',
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
    marginBottom: -2,
  },
  compactHandlePill: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.35)',
  },
  compactBottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    paddingHorizontal: 5,
    paddingTop: 6,
    paddingBottom: 15,
  },
  compactMediaControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    width: 'auto',
    marginBottom: 0,
  },
  compactRightControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 15,
    width: 'auto',
  },
  compactBtn: {
    padding: 5,
  },
  miniPlayerContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 63,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    zIndex: 10,
  },
  miniPlayerImage: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: '#ccc',
  },
  miniPlayerImagePlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#1c1c1e',
  },
  miniPlayerInfo: {
    flex: 1,
    paddingHorizontal: 12,
  },
  miniPlayerTitle: {
    fontSize: 16,
    fontWeight: '500',
    color: '#ffffff',
  },
  miniPlayerButton: {
    padding: 8,
  },
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
  lyricsMiniArt: {
    width: 44,
    height: 44,
    borderRadius: 6,
    marginRight: 16,
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
  lyricsCloseButton: {
    padding: 5,
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
  lyricLineActive: {
    color: '#ffffff',
    transform: [{ scale: 1.02 }],
  },
  noLyricsText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 18,
    textAlign: 'center',
    marginTop: 100,
  },
  heartBtn: {
    padding: 6,
    justifyContent: 'center',
    alignItems: 'center',
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

export default FullPlayerModal;
