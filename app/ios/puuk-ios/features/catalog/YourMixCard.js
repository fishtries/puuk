import React, { useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  RadialGradient,
  Stop,
  Polygon,
  Rect,
  Ellipse,
  G,
  Filter,
  FeGaussianBlur,
} from 'react-native-svg';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withSpring,
  Easing,
  FadeInDown,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

const AnimatedView = Animated.createAnimatedComponent(View);
const AnimatedLinearGradient = Animated.createAnimatedComponent(LinearGradient);

// Luminous embers / dust particles floating within the light shaft
const PARTICLES = [
  // Upper light shaft particles
  {
    id: 1,
    x: 0.49,
    y: 0.18,
    size: 2.2,
    opacity: 0.95,
    color: '#FFFFFF',
    group: 1,
  },
  {
    id: 2,
    x: 0.44,
    y: 0.25,
    size: 3.0,
    opacity: 0.85,
    color: '#FFF4C2',
    group: 2,
  },
  {
    id: 3,
    x: 0.54,
    y: 0.28,
    size: 1.8,
    opacity: 0.8,
    color: '#FFE58F',
    group: 3,
  },
  {
    id: 4,
    x: 0.4,
    y: 0.34,
    size: 2.5,
    opacity: 0.75,
    color: '#FFD666',
    group: 1,
  },
  {
    id: 5,
    x: 0.58,
    y: 0.36,
    size: 3.2,
    opacity: 0.7,
    color: '#FFA940',
    group: 2,
  },
  {
    id: 6,
    x: 0.47,
    y: 0.39,
    size: 2.0,
    opacity: 0.9,
    color: '#FFFBE6',
    group: 3,
  },

  // Mid particles around "your mix"
  {
    id: 7,
    x: 0.32,
    y: 0.45,
    size: 3.5,
    opacity: 0.75,
    color: '#FFA940',
    group: 1,
  },
  {
    id: 8,
    x: 0.43,
    y: 0.48,
    size: 2.0,
    opacity: 0.95,
    color: '#FFFFFF',
    group: 2,
  },
  {
    id: 9,
    x: 0.66,
    y: 0.49,
    size: 2.6,
    opacity: 0.7,
    color: '#FF9C1A',
    group: 3,
  },
  {
    id: 10,
    x: 0.37,
    y: 0.53,
    size: 1.8,
    opacity: 0.85,
    color: '#FFE58F',
    group: 1,
  },
  {
    id: 11,
    x: 0.62,
    y: 0.55,
    size: 3.0,
    opacity: 0.75,
    color: '#FA8C16',
    group: 2,
  },
  {
    id: 12,
    x: 0.51,
    y: 0.57,
    size: 2.4,
    opacity: 0.95,
    color: '#FFFBE6',
    group: 3,
  },

  // Lower particles floating downwards/outwards
  {
    id: 13,
    x: 0.28,
    y: 0.63,
    size: 3.2,
    opacity: 0.65,
    color: '#FA8C16',
    group: 1,
  },
  {
    id: 14,
    x: 0.42,
    y: 0.65,
    size: 2.2,
    opacity: 0.8,
    color: '#FFC069',
    group: 2,
  },
  {
    id: 15,
    x: 0.57,
    y: 0.67,
    size: 1.9,
    opacity: 0.75,
    color: '#FFD666',
    group: 3,
  },
  {
    id: 16,
    x: 0.72,
    y: 0.69,
    size: 3.4,
    opacity: 0.55,
    color: '#D46B08',
    group: 1,
  },
  {
    id: 17,
    x: 0.35,
    y: 0.73,
    size: 2.2,
    opacity: 0.65,
    color: '#FA8C16',
    group: 2,
  },
  {
    id: 18,
    x: 0.64,
    y: 0.75,
    size: 1.8,
    opacity: 0.6,
    color: '#FFA940',
    group: 3,
  },
  {
    id: 19,
    x: 0.48,
    y: 0.78,
    size: 2.8,
    opacity: 0.7,
    color: '#FFC069',
    group: 1,
  },
  {
    id: 20,
    x: 0.22,
    y: 0.8,
    size: 2.0,
    opacity: 0.45,
    color: '#AD4E00',
    group: 2,
  },
  {
    id: 21,
    x: 0.77,
    y: 0.82,
    size: 2.2,
    opacity: 0.45,
    color: '#AD4E00',
    group: 3,
  },
  {
    id: 22,
    x: 0.44,
    y: 0.84,
    size: 2.5,
    opacity: 0.55,
    color: '#FA8C16',
    group: 1,
  },
  {
    id: 23,
    x: 0.55,
    y: 0.86,
    size: 1.7,
    opacity: 0.5,
    color: '#FFD666',
    group: 2,
  },
  {
    id: 24,
    x: 0.36,
    y: 0.9,
    size: 2.0,
    opacity: 0.35,
    color: '#D46B08',
    group: 3,
  },
  {
    id: 25,
    x: 0.63,
    y: 0.91,
    size: 2.1,
    opacity: 0.35,
    color: '#D46B08',
    group: 1,
  },
];

export default function YourMixCard({ onPress }) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const W = windowWidth || 390;

  const pressScale = useSharedValue(1);

  // Organic fluid gradient wave animation
  const flowProgress = useSharedValue(0);

  // Volumetric god rays breathing animation
  const rayPulse = useSharedValue(0);

  // Particle drift animations for 3 groups
  const floatAnim1 = useSharedValue(0);
  const swayAnim1 = useSharedValue(0);
  const pulseAnim1 = useSharedValue(0);

  const floatAnim2 = useSharedValue(0);
  const swayAnim2 = useSharedValue(0);
  const pulseAnim2 = useSharedValue(0);

  const floatAnim3 = useSharedValue(0);
  const swayAnim3 = useSharedValue(0);
  const pulseAnim3 = useSharedValue(0);

  useEffect(() => {
    flowProgress.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 6000, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 6000, easing: Easing.sin }),
      ),
      -1,
      true,
    );

    rayPulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 4800, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 4800, easing: Easing.sin }),
      ),
      -1,
      true,
    );

    // Group 1 particles
    floatAnim1.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 4200, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 4200, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      true,
    );
    swayAnim1.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 5200, easing: Easing.inOut(Easing.sin) }),
        withTiming(-1, { duration: 5200, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      true,
    );
    pulseAnim1.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 2800, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 2800, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      true,
    );

    // Group 2 particles
    floatAnim2.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 4900, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 4900, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      true,
    );
    swayAnim2.value = withRepeat(
      withSequence(
        withTiming(-1, { duration: 5800, easing: Easing.inOut(Easing.sin) }),
        withTiming(1, { duration: 5800, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      true,
    );
    pulseAnim2.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 3400, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 3400, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      true,
    );

    // Group 3 particles
    floatAnim3.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 3800, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 3800, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      true,
    );
    swayAnim3.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 4500, easing: Easing.inOut(Easing.sin) }),
        withTiming(-1, { duration: 4500, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      true,
    );
    pulseAnim3.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 2600, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      true,
    );
  }, [
    flowProgress,
    rayPulse,
    floatAnim1,
    swayAnim1,
    pulseAnim1,
    floatAnim2,
    swayAnim2,
    pulseAnim2,
    floatAnim3,
    swayAnim3,
    pulseAnim3,
  ]);

  const topHeaderOffset = (insets?.top || 44) + 64;
  const cardHeight = topHeaderOffset + 215;
  const apexX = W * 0.5;
  const textCenterY = topHeaderOffset + 50;

  const animatedCardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pressScale.value }],
  }));

  // Flowing luminescence gradient
  const animatedFlowStyle = useAnimatedStyle(() => {
    const p = flowProgress.value;
    const translateY = -12 + p * 24;
    const opacity = 0.55 + p * 0.35;
    return {
      opacity,
      transform: [{ translateY }],
    };
  });

  // Breathing pulse for volumetric light rays
  const animatedRaysStyle = useAnimatedStyle(() => {
    const p = rayPulse.value;
    return {
      opacity: 0.88 + p * 0.12,
      transform: [{ scaleY: 0.98 + p * 0.04 }],
    };
  });

  // Particle drift animated styles
  const floatGroup1 = useAnimatedStyle(() => ({
    transform: [
      { translateY: -10 * floatAnim1.value },
      { translateX: 4 * swayAnim1.value },
    ],
    opacity: 0.8 + 0.2 * pulseAnim1.value,
  }));

  const floatGroup2 = useAnimatedStyle(() => ({
    transform: [
      { translateY: 11 * floatAnim2.value },
      { translateX: -5 * swayAnim2.value },
    ],
    opacity: 0.75 + 0.25 * pulseAnim2.value,
  }));

  const floatGroup3 = useAnimatedStyle(() => ({
    transform: [
      { translateY: -8 * floatAnim3.value },
      { translateX: -3 * swayAnim3.value },
    ],
    opacity: 0.85 + 0.15 * pulseAnim3.value,
  }));

  const handlePressIn = () => {
    pressScale.value = withSpring(0.98, { damping: 20, stiffness: 260 });
  };

  const handlePressOut = () => {
    pressScale.value = withSpring(1, { damping: 20, stiffness: 240 });
  };

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    if (onPress) {
      onPress();
    }
  };

  return (
    <Animated.View
      entering={FadeInDown.duration(600).springify()}
      style={styles.cardOuter}
    >
      <TouchableOpacity
        activeOpacity={1}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onPress={handlePress}
        style={styles.touchable}
        accessibilityRole="button"
        accessibilityLabel="your mix"
        testID="your-mix-card"
      >
        <AnimatedView
          style={[styles.cardInner, { height: cardHeight }, animatedCardStyle]}
        >
          {/* 1. Base Top-to-Bottom Sunset Flame Background Gradient */}
          <LinearGradient
            colors={[
              '#FF4A0A',
              '#D83A00',
              '#9E2400',
              '#591100',
              '#240400',
              '#000000',
            ]}
            locations={[0, 0.22, 0.46, 0.7, 0.88, 1.0]}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            style={StyleSheet.absoluteFill}
            testID="your-mix-base-gradient"
          />

          {/* 2. Animated Fluid Luminescence Gradient Flow */}
          <AnimatedLinearGradient
            colors={['#FFA040', '#FF5000', '#B52000', 'transparent']}
            locations={[0, 0.32, 0.68, 1.0]}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            style={[StyleSheet.absoluteFill, animatedFlowStyle]}
            testID="your-mix-animated-gradient"
          />

          {/* 3. Volumetric God Rays & Celestial Light Shaft (SVG) */}
          <AnimatedView
            style={[StyleSheet.absoluteFill, animatedRaysStyle]}
            pointerEvents="none"
            testID="your-mix-god-rays"
          >
            <Svg
              width="100%"
              height={cardHeight}
              viewBox={`0 0 ${W} ${cardHeight}`}
            >
              <Defs>
                {/* Gaussian Blur Filters for Soft, Dreamy, Volumetric Rays */}
                <Filter
                  id="god-rays-blur-core"
                  x="-50%"
                  y="-20%"
                  width="200%"
                  height="140%"
                >
                  <FeGaussianBlur stdDeviation={20} />
                </Filter>

                <Filter
                  id="god-rays-blur-wide"
                  x="-60%"
                  y="-20%"
                  width="220%"
                  height="140%"
                >
                  <FeGaussianBlur stdDeviation={34} />
                </Filter>

                <Filter
                  id="god-rays-blur-diffuse"
                  x="-60%"
                  y="-20%"
                  width="220%"
                  height="140%"
                >
                  <FeGaussianBlur stdDeviation={48} />
                </Filter>

                {/* Sun Flare at top center source */}
                <RadialGradient
                  id="sun-flare"
                  cx={apexX}
                  cy={0}
                  r={W * 0.55}
                  gradientUnits="userSpaceOnUse"
                >
                  <Stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
                  <Stop offset="14%" stopColor="#FFF6CB" stopOpacity="0.85" />
                  <Stop offset="32%" stopColor="#FFD563" stopOpacity="0.65" />
                  <Stop offset="55%" stopColor="#FFA01A" stopOpacity="0.35" />
                  <Stop offset="78%" stopColor="#D94500" stopOpacity="0.12" />
                  <Stop offset="100%" stopColor="#8A1500" stopOpacity="0" />
                </RadialGradient>

                {/* Broad ambient light cone gradient */}
                <SvgLinearGradient
                  id="ray-ambient-cone"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <Stop offset="0%" stopColor="#FFE580" stopOpacity="0.5" />
                  <Stop offset="28%" stopColor="#FFA820" stopOpacity="0.32" />
                  <Stop offset="65%" stopColor="#FF5500" stopOpacity="0.12" />
                  <Stop offset="100%" stopColor="#FF2000" stopOpacity="0" />
                </SvgLinearGradient>

                {/* Central main ray gradient */}
                <SvgLinearGradient id="ray-center" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0%" stopColor="#FFFDF0" stopOpacity="0.82" />
                  <Stop offset="25%" stopColor="#FFEBA0" stopOpacity="0.68" />
                  <Stop offset="50%" stopColor="#FFBF38" stopOpacity="0.45" />
                  <Stop offset="75%" stopColor="#FF7E00" stopOpacity="0.2" />
                  <Stop offset="100%" stopColor="#FF4000" stopOpacity="0" />
                </SvgLinearGradient>

                {/* Inner left ray gradient */}
                <SvgLinearGradient
                  id="ray-inner-left"
                  x1="0.45"
                  y1="0"
                  x2="0.30"
                  y2="1"
                >
                  <Stop offset="0%" stopColor="#FFF8D8" stopOpacity="0.62" />
                  <Stop offset="30%" stopColor="#FFD870" stopOpacity="0.46" />
                  <Stop offset="65%" stopColor="#FF9820" stopOpacity="0.22" />
                  <Stop offset="100%" stopColor="#FF4500" stopOpacity="0" />
                </SvgLinearGradient>

                {/* Inner right ray gradient */}
                <SvgLinearGradient
                  id="ray-inner-right"
                  x1="0.55"
                  y1="0"
                  x2="0.70"
                  y2="1"
                >
                  <Stop offset="0%" stopColor="#FFF8D8" stopOpacity="0.62" />
                  <Stop offset="30%" stopColor="#FFD870" stopOpacity="0.46" />
                  <Stop offset="65%" stopColor="#FF9820" stopOpacity="0.22" />
                  <Stop offset="100%" stopColor="#FF4500" stopOpacity="0" />
                </SvgLinearGradient>

                {/* Mid left ray gradient */}
                <SvgLinearGradient
                  id="ray-mid-left"
                  x1="0.40"
                  y1="0"
                  x2="0.15"
                  y2="1"
                >
                  <Stop offset="0%" stopColor="#FFF0B0" stopOpacity="0.52" />
                  <Stop offset="35%" stopColor="#FFC450" stopOpacity="0.35" />
                  <Stop offset="70%" stopColor="#FF7400" stopOpacity="0.15" />
                  <Stop offset="100%" stopColor="#FF3000" stopOpacity="0" />
                </SvgLinearGradient>

                {/* Mid right ray gradient */}
                <SvgLinearGradient
                  id="ray-mid-right"
                  x1="0.60"
                  y1="0"
                  x2="0.85"
                  y2="1"
                >
                  <Stop offset="0%" stopColor="#FFF0B0" stopOpacity="0.52" />
                  <Stop offset="35%" stopColor="#FFC450" stopOpacity="0.35" />
                  <Stop offset="70%" stopColor="#FF7400" stopOpacity="0.15" />
                  <Stop offset="100%" stopColor="#FF3000" stopOpacity="0" />
                </SvgLinearGradient>

                {/* Outer left ray gradient */}
                <SvgLinearGradient
                  id="ray-outer-left"
                  x1="0.35"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <Stop offset="0%" stopColor="#FFE690" stopOpacity="0.38" />
                  <Stop offset="40%" stopColor="#FFAA30" stopOpacity="0.22" />
                  <Stop offset="80%" stopColor="#FF6000" stopOpacity="0.08" />
                  <Stop offset="100%" stopColor="#FF2500" stopOpacity="0" />
                </SvgLinearGradient>

                {/* Outer right ray gradient */}
                <SvgLinearGradient
                  id="ray-outer-right"
                  x1="0.65"
                  y1="0"
                  x2="1"
                  y2="1"
                >
                  <Stop offset="0%" stopColor="#FFE690" stopOpacity="0.38" />
                  <Stop offset="40%" stopColor="#FFAA30" stopOpacity="0.22" />
                  <Stop offset="80%" stopColor="#FF6000" stopOpacity="0.08" />
                  <Stop offset="100%" stopColor="#FF2500" stopOpacity="0" />
                </SvgLinearGradient>

                {/* Soft glow aura behind the title text */}
                <RadialGradient
                  id="text-halo"
                  cx={apexX}
                  cy={textCenterY}
                  rx={W * 0.4}
                  ry={55}
                  gradientUnits="userSpaceOnUse"
                >
                  <Stop offset="0%" stopColor="#FFD266" stopOpacity="0.32" />
                  <Stop offset="45%" stopColor="#FF9000" stopOpacity="0.16" />
                  <Stop offset="100%" stopColor="#FF4000" stopOpacity="0" />
                </RadialGradient>
              </Defs>

              {/* Layer 1: Super-wide diffuse ambient light cone with max blur */}
              <G filter="url(#god-rays-blur-diffuse)">
                <Polygon
                  points={`${apexX - 35},0 ${apexX + 35},0 ${apexX + 220},${cardHeight} ${apexX - 220},${cardHeight}`}
                  fill="url(#ray-ambient-cone)"
                />
              </G>

              {/* Layer 2: Wide & Mid angled rays with wide Gaussian blur */}
              <G filter="url(#god-rays-blur-wide)">
                {/* Outer Left Ray */}
                <Polygon
                  points={`${apexX - 42},0 ${apexX - 24},0 ${apexX - 210},${cardHeight} ${apexX - 300},${cardHeight}`}
                  fill="url(#ray-outer-left)"
                />
                {/* Outer Right Ray */}
                <Polygon
                  points={`${apexX + 24},0 ${apexX + 42},0 ${apexX + 300},${cardHeight} ${apexX + 210},${cardHeight}`}
                  fill="url(#ray-outer-right)"
                />
                {/* Mid Left Ray */}
                <Polygon
                  points={`${apexX - 32},0 ${apexX - 16},0 ${apexX - 145},${cardHeight} ${apexX - 230},${cardHeight}`}
                  fill="url(#ray-mid-left)"
                />
                {/* Mid Right Ray */}
                <Polygon
                  points={`${apexX + 16},0 ${apexX + 32},0 ${apexX + 230},${cardHeight} ${apexX + 145},${cardHeight}`}
                  fill="url(#ray-mid-right)"
                />
              </G>

              {/* Layer 3: Core central shafts with soft Gaussian blur */}
              <G filter="url(#god-rays-blur-core)">
                {/* Inner Left Ray */}
                <Polygon
                  points={`${apexX - 20},0 ${apexX - 4},0 ${apexX - 75},${cardHeight} ${apexX - 155},${cardHeight}`}
                  fill="url(#ray-inner-left)"
                />
                {/* Inner Right Ray */}
                <Polygon
                  points={`${apexX + 4},0 ${apexX + 20},0 ${apexX + 155},${cardHeight} ${apexX + 75},${cardHeight}`}
                  fill="url(#ray-inner-right)"
                />
                {/* Center Main Beam */}
                <Polygon
                  points={`${apexX - 24},0 ${apexX + 24},0 ${apexX + 85},${cardHeight} ${apexX - 85},${cardHeight}`}
                  fill="url(#ray-center)"
                />
                {/* Soft Text Aura Glow */}
                <Ellipse
                  cx={apexX}
                  cy={textCenterY}
                  rx={W * 0.4}
                  ry={55}
                  fill="url(#text-halo)"
                />
              </G>

              {/* Radiant Sun Flare at top center origin */}
              <Rect
                x="0"
                y="0"
                width={W}
                height={cardHeight * 0.75}
                fill="url(#sun-flare)"
              />
            </Svg>
          </AnimatedView>

          {/* 4. Floating Luminous Embers & Sparks */}
          <View
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
            testID="your-mix-particles"
          >
            {PARTICLES.map((p) => {
              const groupStyle =
                p.group === 1
                  ? floatGroup1
                  : p.group === 2
                    ? floatGroup2
                    : floatGroup3;
              const left = p.x * W - p.size / 2;
              const top = p.y * cardHeight - p.size / 2;

              return (
                <AnimatedView
                  key={p.id}
                  style={[
                    styles.particleDot,
                    {
                      left,
                      top,
                      width: p.size,
                      height: p.size,
                      borderRadius: p.size / 2,
                      backgroundColor: p.color,
                      opacity: p.opacity,
                    },
                    groupStyle,
                  ]}
                />
              );
            })}
          </View>

          {/* 5. Smooth Bottom Transition Gradient into black catalog */}
          <LinearGradient
            colors={[
              'transparent',
              'rgba(0, 0, 0, 0.35)',
              'rgba(0, 0, 0, 0.85)',
              '#000000',
            ]}
            locations={[0, 0.45, 0.8, 1.0]}
            start={{ x: 0.5, y: 0.4 }}
            end={{ x: 0.5, y: 1 }}
            style={StyleSheet.absoluteFill}
          />

          {/* 6. Centered Title Typography Positioned in the Light Beam */}
          <View
            style={[
              styles.contentContainer,
              { paddingTop: topHeaderOffset + 30, paddingBottom: 24 },
            ]}
          >
            <Text style={styles.titleText}>your mix</Text>
          </View>
        </AnimatedView>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  cardOuter: {
    width: '100%',
    marginBottom: 16,
  },
  touchable: {
    width: '100%',
  },
  cardInner: {
    width: '100%',
    overflow: 'hidden',
    backgroundColor: '#000000',
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  particleDot: {
    position: 'absolute',
    shadowColor: '#FFAA00',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 3,
  },
  contentContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  titleText: {
    fontSize: 36,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: -0.8,
    textAlign: 'center',
    textShadowColor: 'rgba(150, 35, 0, 0.7)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 14,
  },
});
