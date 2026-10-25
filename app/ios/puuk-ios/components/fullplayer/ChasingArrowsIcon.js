import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SymbolView } from 'expo-symbols';
import Animated, {
  useAnimatedStyle,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';

const SingleArrow = ({ size, color, isLeft }) => {
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
        transform: [{ scaleX: isLeft ? -1 : 1 }],
      }}
    >
      <SymbolView
        name="play.fill"
        size={size}
        weight="bold"
        tintColor={color}
        resizeMode="scaleAspectFit"
        fallback={<Ionicons name="play" size={size} color={color} />}
      />
    </View>
  );
};

const ChasingArrowsIcon = ({
  progress,
  direction = 'right',
  size = 32,
  spacing = 16,
  color = '#ffffff',
}) => {
  const isRight = direction === 'right';
  const isLeft = !isRight;

  const t0Style = useAnimatedStyle(() => {
    if (isRight) {
      const tx = interpolate(
        progress.value,
        [0, 1],
        [-spacing * 1.5, -spacing * 0.5],
      );
      const scale = interpolate(
        progress.value,
        [0, 0.7, 1],
        [0.1, 0.85, 1],
        Extrapolation.CLAMP,
      );
      const opacity = interpolate(
        progress.value,
        [0, 0.6, 1],
        [0, 0.85, 1],
        Extrapolation.CLAMP,
      );
      return {
        position: 'absolute',
        opacity,
        transform: [{ translateX: tx }, { scale }],
      };
    } else {
      const tx = interpolate(
        progress.value,
        [0, 1],
        [-spacing * 0.5, -spacing * 1.5],
      );
      const scale = interpolate(
        progress.value,
        [0, 0.35, 1],
        [1, 0.7, 0.1],
        Extrapolation.CLAMP,
      );
      const opacity = interpolate(
        progress.value,
        [0, 0.45, 1],
        [1, 0.5, 0],
        Extrapolation.CLAMP,
      );
      return {
        position: 'absolute',
        opacity,
        transform: [{ translateX: tx }, { scale }],
      };
    }
  });

  const t1Style = useAnimatedStyle(() => {
    if (isRight) {
      const tx = interpolate(
        progress.value,
        [0, 1],
        [-spacing * 0.5, spacing * 0.5],
      );
      return {
        position: 'absolute',
        opacity: 1,
        transform: [{ translateX: tx }, { scale: 1 }],
      };
    } else {
      const tx = interpolate(
        progress.value,
        [0, 1],
        [spacing * 0.5, -spacing * 0.5],
      );
      return {
        position: 'absolute',
        opacity: 1,
        transform: [{ translateX: tx }, { scale: 1 }],
      };
    }
  });

  const t2Style = useAnimatedStyle(() => {
    if (isRight) {
      const tx = interpolate(
        progress.value,
        [0, 1],
        [spacing * 0.5, spacing * 1.5],
      );
      const scale = interpolate(
        progress.value,
        [0, 0.35, 1],
        [1, 0.7, 0.1],
        Extrapolation.CLAMP,
      );
      const opacity = interpolate(
        progress.value,
        [0, 0.45, 1],
        [1, 0.5, 0],
        Extrapolation.CLAMP,
      );
      return {
        position: 'absolute',
        opacity,
        transform: [{ translateX: tx }, { scale }],
      };
    } else {
      const tx = interpolate(
        progress.value,
        [0, 1],
        [spacing * 1.5, spacing * 0.5],
      );
      const scale = interpolate(
        progress.value,
        [0, 0.7, 1],
        [0.1, 0.85, 1],
        Extrapolation.CLAMP,
      );
      const opacity = interpolate(
        progress.value,
        [0, 0.6, 1],
        [0, 0.85, 1],
        Extrapolation.CLAMP,
      );
      return {
        position: 'absolute',
        opacity,
        transform: [{ translateX: tx }, { scale }],
      };
    }
  });

  return (
    <View
      style={{
        width: size + spacing + 16,
        height: size + 8,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <Animated.View style={t0Style}>
        <SingleArrow size={size} color={color} isLeft={isLeft} />
      </Animated.View>
      <Animated.View style={t1Style}>
        <SingleArrow size={size} color={color} isLeft={isLeft} />
      </Animated.View>
      <Animated.View style={t2Style}>
        <SingleArrow size={size} color={color} isLeft={isLeft} />
      </Animated.View>
    </View>
  );
};

export default React.memo(ChasingArrowsIcon);
