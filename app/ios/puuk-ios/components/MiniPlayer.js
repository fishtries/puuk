import React from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import CoverImage from './CoverImage';

const MiniPlayer = ({ currentTrack, isPlaying, togglePlayPause, fetchNextTrack, onPress }) => {
  if (!currentTrack) return null;

  return (
    <TouchableOpacity 
      style={styles.miniPlayer} 
      onPress={onPress}
      activeOpacity={0.9}
    >
      <CoverImage source={currentTrack.coverArt} style={styles.miniPlayerImage} />
      <View style={styles.miniPlayerInfo}>
        <Text style={styles.miniPlayerTitle} numberOfLines={1}>{currentTrack.title}</Text>
      </View>
      <TouchableOpacity style={styles.miniPlayerButton} onPress={togglePlayPause}>
        <Ionicons name={isPlaying ? "pause" : "play"} size={28} color="#ffffff" />
      </TouchableOpacity>
      <TouchableOpacity style={styles.miniPlayerButton} onPress={fetchNextTrack}>
        <Ionicons name="play-forward" size={28} color="#ffffff" />
      </TouchableOpacity>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  miniPlayer: {
    position: 'absolute',
    bottom: 20,
    left: 10,
    right: 10,
    height: 64,
    backgroundColor: 'rgba(30, 30, 30, 0.95)',
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 10,
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
    backgroundColor: '#e5e5ea',
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
});

export default MiniPlayer;
