import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated from 'react-native-reanimated';
import CoverImage from '../CoverImage';

const MiniPlayerBar = ({
  styles,
  currentTrack,
  displayTitle,
  isPlaying,
  isPlayerVisible,
  handleExpand,
  togglePlayPause,
  fetchNextTrack,
  miniPlayerAnimatedStyle,
}) => {
  return (
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
  );
};

export default MiniPlayerBar;
