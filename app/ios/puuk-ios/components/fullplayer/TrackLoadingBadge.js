import React from 'react';
import { StyleSheet, ActivityIndicator } from 'react-native';
import Animated, {
  LinearTransition,
  FadeIn,
  FadeOut,
  Easing,
} from 'react-native-reanimated';
import { TRACK_STATUS } from '../../utils/preloadScheduler';

export default function TrackLoadingBadge({
  isLoading = false,
  isBufferingSlow = false,
  networkStatus = 'good',
  nextTrackStatus = TRACK_STATUS.IDLE,
}) {
  const isSlow = Boolean(isBufferingSlow || networkStatus === 'slow');
  const isDownloading = nextTrackStatus === TRACK_STATUS.DOWNLOADING || nextTrackStatus === 'downloading';
  const isVisible = Boolean(isLoading || isSlow || isDownloading);

  if (!isVisible) {
    return null;
  }

  return (
    <Animated.View
      layout={LinearTransition.duration(200).easing(Easing.bezier(0.25, 1, 0.5, 1))}
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      style={[
        styles.badgeBase,
        isSlow ? styles.badgeSlow : styles.badgeNormal,
      ]}
      pointerEvents="none"
      accessibilityRole="progressbar"
      accessibilityLabel={isSlow ? 'Buffering slow network' : 'Loading track'}
    >
      <ActivityIndicator
        size="small"
        color={isSlow ? '#ffd60a' : 'rgba(255, 255, 255, 0.85)'}
        style={styles.spinner}
      />
      {isSlow && (
        <Animated.Text
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(150)}
          style={styles.textSlow}
          numberOfLines={1}
        >
          kinda slow
        </Animated.Text>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  badgeBase: {
    height: 32,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  badgeNormal: {
    width: 32,
    paddingHorizontal: 0,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderColor: 'rgba(255, 255, 255, 0.18)',
  },
  badgeSlow: {
    paddingHorizontal: 10,
    backgroundColor: 'rgba(255, 214, 10, 0.16)',
    borderColor: 'rgba(255, 214, 10, 0.35)',
  },
  spinner: {
    transform: [{ scale: 0.75 }],
  },
  textSlow: {
    color: '#ffd60a',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: -0.2,
    marginLeft: 5,
  },
});
