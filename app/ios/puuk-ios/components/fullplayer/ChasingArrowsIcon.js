import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useAnimatedStyle,
  interpolate,
} from 'react-native-reanimated';

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

export default ChasingArrowsIcon;
