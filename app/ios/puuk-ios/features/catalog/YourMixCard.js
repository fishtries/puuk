import React, { useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
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

// Fluid animated mesh blob using vibrant web palette
function AnimatedMeshBlob({
  color,
  size,
  fromX,
  toX,
  fromY,
  toY,
  fromScale = 0.9,
  toScale = 1.25,
  duration = 7000,
  opacity = 0.85,
}) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withRepeat(
      withSequence(
        withTiming(1, { duration, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      true,
    );
  }, [duration]);

  const animatedStyle = useAnimatedStyle(() => {
    const p = progress.value;
    const tx = fromX + (toX - fromX) * p;
    const ty = fromY + (toY - fromY) * p;
    const scale = fromScale + (toScale - fromScale) * p;
    return {
      transform: [{ translateX: tx }, { translateY: ty }, { scale }],
    };
  });

  return (
    <AnimatedView
      style={[
        {
          position: 'absolute',
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          opacity,
        },
        animatedStyle,
      ]}
    />
  );
}

export default function YourMixCard({ onPress }) {
  const pressScale = useSharedValue(1);

  const animatedCardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pressScale.value }],
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
        <AnimatedView style={[styles.cardInner, animatedCardStyle]}>
          {/* 1. Vibrant Web Sunset Flame Base Gradient */}
          <LinearGradient
            colors={['#FF4A0A', '#E03B00', '#A02800', '#501301', '#2A080E']}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            style={StyleSheet.absoluteFill}
          />

          {/* 2. Fluid Organic Complementary Animated Blobs (web palette) */}
          {/* Radiant Sunrise Glow in Center (#FFF4D8 / #FFBD4B) */}
          <AnimatedMeshBlob
            color="#FFBD4B"
            size={300}
            fromX={30}
            toX={120}
            fromY={40}
            toY={-10}
            fromScale={1.0}
            toScale={1.35}
            duration={6200}
            opacity={0.95}
          />
          <AnimatedMeshBlob
            color="#FFF4D8"
            size={220}
            fromX={70}
            toX={140}
            fromY={50}
            toY={10}
            fromScale={0.9}
            toScale={1.25}
            duration={5600}
            opacity={0.9}
          />

          {/* Mid-Warm Coral Atmosphere (#FF6B28 / #FF4A0A) */}
          <AnimatedMeshBlob
            color="#FF6B28"
            size={260}
            fromX={-40}
            toX={40}
            fromY={20}
            toY={80}
            fromScale={0.85}
            toScale={1.2}
            duration={7200}
            opacity={0.85}
          />

          {/* Top-Right Ambient Berry Nebula Glow (#B92D73) */}
          <AnimatedMeshBlob
            color="#B92D73"
            size={240}
            fromX={160}
            toX={100}
            fromY={-40}
            toY={20}
            fromScale={1.15}
            toScale={0.85}
            duration={8200}
            opacity={0.7}
          />

          {/* 3. Soft Native Blur to Turn Blobs into Liquid Mesh */}
          <BlurView
            intensity={Platform.OS === 'ios' ? 60 : 35}
            tint="light"
            style={StyleSheet.absoluteFill}
          />

          {/* 4. Subtle Bottom Gradient for Smooth Contrast with Tracklist */}
          <LinearGradient
            colors={['transparent', 'rgba(0, 0, 0, 0.25)']}
            start={{ x: 0.5, y: 0.6 }}
            end={{ x: 0.5, y: 1 }}
            style={StyleSheet.absoluteFill}
          />

          {/* 5. Centered Clean Content Matching Sketch */}
          <View style={styles.contentContainer}>
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
    height: 270,
    overflow: 'hidden',
    backgroundColor: '#FF4A0A',
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  contentContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  titleText: {
    fontSize: 36,
    fontWeight: '800',
    color: '#000000',
    letterSpacing: -0.8,
    textAlign: 'center',
    textShadowColor: 'rgba(255, 230, 180, 0.7)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 8,
  },
});
