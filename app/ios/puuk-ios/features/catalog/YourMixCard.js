import React, { useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
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

export default function YourMixCard({ onPress }) {
  const insets = useSafeAreaInsets();
  const pressScale = useSharedValue(1);

  // Gradient animation: smooth organic flow from top to bottom
  const flowProgress = useSharedValue(0);
  const glowPulse = useSharedValue(0);

  useEffect(() => {
    flowProgress.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 6000, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 6000, easing: Easing.sin }),
      ),
      -1,
      true,
    );

    glowPulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 3200, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 3200, easing: Easing.sin }),
      ),
      -1,
      true,
    );
  }, [flowProgress, glowPulse]);

  const topHeaderOffset = (insets?.top || 44) + 64;
  const cardHeight = topHeaderOffset + 210;

  const animatedCardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pressScale.value }],
  }));

  // Animated gradient wave moving smoothly from top to bottom
  const animatedFlowStyle = useAnimatedStyle(() => {
    const p = flowProgress.value;
    const translateY = -16 + p * 32;
    const opacity = 0.55 + p * 0.35;
    return {
      opacity,
      transform: [{ translateY }],
    };
  });

  // Breathing pulse for the entire perimeter inner glow halo
  const animatedInnerGlowStyle = useAnimatedStyle(() => {
    const p = glowPulse.value;
    const opacity = 0.72 + p * 0.28;
    return {
      opacity,
    };
  });

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
          {/* 1. Base Top-to-Bottom Sunset Flame Gradient */}
          <LinearGradient
            colors={[
              '#FF4A0A',
              '#E03B00',
              '#A02500',
              '#551102',
              '#200508',
              '#000000',
            ]}
            locations={[0, 0.22, 0.46, 0.7, 0.88, 1.0]}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            style={StyleSheet.absoluteFill}
            testID="your-mix-base-gradient"
          />

          {/* 2. Animated Fluid Luminescence Gradient Flow (top to bottom) */}
          <AnimatedLinearGradient
            colors={['#FFA040', '#FF4D00', '#B52000', 'transparent']}
            locations={[0, 0.32, 0.68, 1.0]}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            style={[StyleSheet.absoluteFill, animatedFlowStyle]}
            testID="your-mix-animated-gradient"
          />

          {/* 3. Smooth Bottom Transition Gradient into black catalog */}
          <LinearGradient
            colors={[
              'transparent',
              'rgba(0, 0, 0, 0.35)',
              'rgba(0, 0, 0, 0.8)',
            ]}
            locations={[0, 0.6, 1.0]}
            start={{ x: 0.5, y: 0.5 }}
            end={{ x: 0.5, y: 1 }}
            style={StyleSheet.absoluteFill}
          />

          {/* 4. Inner Halo Glow Along Entire Border (all sides & rounded corners) */}
          <AnimatedView
            style={[StyleSheet.absoluteFill, animatedInnerGlowStyle]}
            pointerEvents="none"
            testID="your-mix-inner-glow"
          >
            {/* Top edge inner glow halo */}
            <LinearGradient
              colors={[
                'rgba(255, 220, 160, 0.75)',
                'rgba(255, 130, 40, 0.3)',
                'transparent',
              ]}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={styles.innerGlowTop}
            />

            {/* Bottom edge & rounded corners inner glow halo */}
            <LinearGradient
              colors={[
                'transparent',
                'rgba(255, 80, 20, 0.25)',
                'rgba(255, 140, 60, 0.65)',
              ]}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={styles.innerGlowBottom}
            />

            {/* Left border inner glow halo */}
            <LinearGradient
              colors={[
                'rgba(255, 140, 40, 0.55)',
                'rgba(255, 80, 20, 0.2)',
                'transparent',
              ]}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={styles.innerGlowLeft}
            />

            {/* Right border inner glow halo */}
            <LinearGradient
              colors={[
                'transparent',
                'rgba(255, 80, 20, 0.2)',
                'rgba(255, 140, 40, 0.55)',
              ]}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={styles.innerGlowRight}
            />

            {/* Crisp luminous rim and soft diffusion perimeter */}
            <View style={styles.innerBorderRim} />
            <View style={styles.innerBorderSoftHaze} />
          </AnimatedView>

          {/* 5. Centered Clean Content Positioned Below Header */}
          <View
            style={[
              styles.contentContainer,
              { paddingTop: topHeaderOffset - 16, paddingBottom: 24 },
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
    marginBottom: 20,
  },
  touchable: {
    width: '100%',
  },
  cardInner: {
    width: '100%',
    overflow: 'hidden',
    backgroundColor: '#121214',
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  innerGlowTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 48,
  },
  innerGlowBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 56,
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
  },
  innerGlowLeft: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 36,
    borderBottomLeftRadius: 32,
  },
  innerGlowRight: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: 36,
    borderBottomRightRadius: 32,
  },
  innerBorderRim: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 130, 40, 0.45)',
    borderTopColor: 'rgba(255, 210, 150, 0.8)',
    borderBottomColor: 'rgba(255, 100, 30, 0.5)',
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
  },
  innerBorderSoftHaze: {
    ...StyleSheet.absoluteFillObject,
    margin: 1.5,
    borderWidth: 5,
    borderColor: 'rgba(255, 130, 40, 0.16)',
    borderTopColor: 'rgba(255, 200, 140, 0.28)',
    borderBottomColor: 'rgba(255, 90, 20, 0.18)',
    borderBottomLeftRadius: 30.5,
    borderBottomRightRadius: 30.5,
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
    textShadowColor: 'rgba(255, 100, 20, 0.5)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 14,
  },
});
