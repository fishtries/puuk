import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useAnimatedStyle,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import { GestureDetector } from 'react-native-gesture-handler';
import CoverImage from '../CoverImage';
import defaultStyles from './playerStyles';

const MiniPlayerBar = ({
  styles: propStyles,
  currentTrack,
  displayTitle,
  isPlaying,
  isPlayerVisible,
  handleExpand,
  togglePlayPause,
  fetchNextTrack,
  miniPlayerAnimatedStyle,
  panGesture,
  bottomBarHeight,
  insets,
  expandProgress,
  hideMediaInfo = false,
}) => {
  const styles = propStyles || defaultStyles;
  const title = displayTitle || currentTrack?.title || 'Puuk Music';
  const artist = currentTrack?.artist || 'Select a track to start';

  const miniButtonsAnimatedStyle = useAnimatedStyle(() => {
    if (!expandProgress) return {};
    const opacity = interpolate(
      expandProgress.value,
      [0, 0.2],
      [1, 0],
      Extrapolation.CLAMP
    );
    const translateX = interpolate(
      expandProgress.value,
      [0, 0.2],
      [0, 20],
      Extrapolation.CLAMP
    );
    return {
      opacity,
      transform: [{ translateX }],
    };
  });

  const content = (
    <Animated.View
      style={[
        styles.miniPlayerContainer,
        bottomBarHeight ? { height: bottomBarHeight, paddingBottom: insets?.bottom || 0 } : null,
        hideMediaInfo ? { backgroundColor: 'transparent' } : null,
        miniPlayerAnimatedStyle,
      ]}
      pointerEvents={isPlayerVisible ? 'none' : 'auto'}
    >
      <TouchableOpacity
        style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}
        onPress={handleExpand}
        activeOpacity={0.85}
      >
        {!hideMediaInfo ? (
          <>
            <CoverImage source={currentTrack?.coverArt} style={styles.miniPlayerImage} />
            <View style={styles.miniPlayerInfo}>
              <Text style={styles.miniPlayerTitle} numberOfLines={1}>{title}</Text>
              <Text style={styles.miniPlayerArtist} numberOfLines={1}>{artist}</Text>
            </View>
          </>
        ) : (
          <>
            <View style={[styles.miniPlayerImage, { backgroundColor: 'transparent' }]} />
            <View style={styles.miniPlayerInfo} />
          </>
        )}
      </TouchableOpacity>

      <Animated.View style={[{ flexDirection: 'row', alignItems: 'center' }, miniButtonsAnimatedStyle]}>
        <TouchableOpacity
          style={styles.miniPlayerButton}
          onPress={(e) => {
            e.stopPropagation();
            togglePlayPause();
          }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          activeOpacity={0.7}
        >
          <Ionicons name={isPlaying ? "pause" : "play"} size={26} color="#ffffff" />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.miniPlayerButton}
          onPress={(e) => {
            e.stopPropagation();
            fetchNextTrack();
          }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          activeOpacity={0.7}
        >
          <Ionicons name="play-forward" size={26} color="#ffffff" />
        </TouchableOpacity>
      </Animated.View>
    </Animated.View>
  );

  if (panGesture) {
    return (
      <GestureDetector gesture={panGesture}>
        {content}
      </GestureDetector>
    );
  }

  return content;
};

export default MiniPlayerBar;
