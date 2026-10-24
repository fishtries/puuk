import React from 'react';
import { View, Text } from 'react-native';
import Animated from 'react-native-reanimated';
import CoverImage from '../../shared/media/CoverImage';

const MiniPlayerTrackCard = ({ track, title, artist, width, style, styles }) => {
  if (!track && !title) return null;

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width,
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: 16,
        },
        style,
      ]}
      pointerEvents="none"
    >
      <CoverImage source={track?.coverArt} style={styles.miniPlayerImage} />
      <View style={styles.miniPlayerInfo}>
        <Text style={styles.miniPlayerTitle} numberOfLines={1}>
          {title || track?.title || 'Puuk Music'}
        </Text>
        <Text style={styles.miniPlayerArtist} numberOfLines={1}>
          {artist || track?.artist || 'Select a track to start'}
        </Text>
      </View>
    </Animated.View>
  );
};

export default MiniPlayerTrackCard;
