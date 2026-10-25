import React from 'react';
import { View, Text, TouchableOpacity, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useAnimatedStyle,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import { GestureDetector } from 'react-native-gesture-handler';
import MiniPlayerTrackCard from './MiniPlayerTrackCard';
import defaultStyles from './playerStyles';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const MiniPlayerBar = ({
  styles: propStyles,
  currentTrack,
  displayTitle,
  isPlaying,
  isPlayerVisible,
  handleExpand,
  togglePlayPause,
  fetchNextTrack,
  nextTrack,
  previousTrack,
  trackSwipeX,
  miniPlayerAnimatedStyle,
  panGesture,
  bottomBarHeight,
  insets,
  expandProgress,
  onToggleLike,
  isLiked,
}) => {
  const styles = propStyles || defaultStyles;
  const title = displayTitle || currentTrack?.title || 'Puuk Music';
  const artist = currentTrack?.artist || 'Select a track to start';
  const trackIsLiked =
    isLiked !== undefined ? isLiked : !!currentTrack?.is_liked;

  // От левого края экрана (0px) до блока кнопок справа (~100px)
  const trackWidth = SCREEN_WIDTH - 100;
  const slideDistance = trackWidth + 24;

  // Моментальное скрытие при старте разворачивания, чтобы не было кроссфейда с FullPlayerModal
  const trackMediaVisibilityStyle = useAnimatedStyle(() => {
    if (!expandProgress) return {};
    const isExpandedOrExpanding = expandProgress.value > 0.005;
    return {
      opacity: isExpandedOrExpanding ? 0 : 1,
    };
  });

  const currentTrackAnimatedStyle = useAnimatedStyle(() => {
    const swipeX = trackSwipeX ? trackSwipeX.value : 0;
    return {
      transform: [{ translateX: swipeX }],
    };
  });

  const nextTrackAnimatedStyle = useAnimatedStyle(() => {
    if (!nextTrack || !trackSwipeX) return { display: 'none' };
    const swipeX = trackSwipeX.value;
    return {
      transform: [{ translateX: slideDistance + swipeX }],
      display: 'flex',
    };
  });

  const prevTrackAnimatedStyle = useAnimatedStyle(() => {
    if (!previousTrack || !trackSwipeX) return { display: 'none' };
    const swipeX = trackSwipeX.value;
    return {
      transform: [{ translateX: -slideDistance + swipeX }],
      display: 'flex',
    };
  });

  const miniButtonsAnimatedStyle = useAnimatedStyle(() => {
    if (!expandProgress) return {};
    const opacity = interpolate(
      expandProgress.value,
      [0, 0.2],
      [1, 0],
      Extrapolation.CLAMP,
    );
    const translateX = interpolate(
      expandProgress.value,
      [0, 0.2],
      [0, 20],
      Extrapolation.CLAMP,
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
        { paddingLeft: 0 },
        bottomBarHeight
          ? { height: bottomBarHeight, paddingBottom: insets?.bottom || 0 }
          : null,
        miniPlayerAnimatedStyle,
      ]}
      pointerEvents={isPlayerVisible ? 'none' : 'auto'}
    >
      <TouchableOpacity
        style={{ flex: 1, height: 44, overflow: 'hidden' }}
        onPress={handleExpand}
        activeOpacity={0.85}
      >
        <Animated.View
          style={[{ flex: 1, height: 44 }, trackMediaVisibilityStyle]}
        >
          {/* Подготовленный предыдущий трек слева */}
          <MiniPlayerTrackCard
            track={previousTrack}
            title={previousTrack?.title}
            artist={previousTrack?.artist}
            width={trackWidth}
            style={prevTrackAnimatedStyle}
            styles={styles}
          />

          {/* Текущий трек по центру */}
          <MiniPlayerTrackCard
            track={currentTrack}
            title={title}
            artist={artist}
            width={trackWidth}
            style={currentTrackAnimatedStyle}
            styles={styles}
          />

          {/* Подготовленный следующий трек справа */}
          <MiniPlayerTrackCard
            track={nextTrack}
            title={nextTrack?.title}
            artist={nextTrack?.artist}
            width={trackWidth}
            style={nextTrackAnimatedStyle}
            styles={styles}
          />
        </Animated.View>
      </TouchableOpacity>

      <Animated.View
        style={[
          {
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: 'transparent',
            zIndex: 10,
          },
          miniButtonsAnimatedStyle,
        ]}
      >
        <TouchableOpacity
          testID="mini-like-button"
          style={styles.miniPlayerButton}
          onPress={(e) => {
            e.stopPropagation();
            onToggleLike && onToggleLike();
          }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          activeOpacity={0.7}
        >
          <Ionicons
            name={trackIsLiked ? 'heart' : 'heart-outline'}
            size={24}
            color={trackIsLiked ? '#ff2d55' : '#ffffff'}
          />
        </TouchableOpacity>
        <TouchableOpacity
          testID="mini-play-button"
          style={styles.miniPlayerButton}
          onPress={(e) => {
            e.stopPropagation();
            togglePlayPause();
          }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          activeOpacity={0.7}
        >
          <Ionicons
            name={isPlaying ? 'pause' : 'play'}
            size={26}
            color="#ffffff"
          />
        </TouchableOpacity>
      </Animated.View>
    </Animated.View>
  );

  if (panGesture) {
    return <GestureDetector gesture={panGesture}>{content}</GestureDetector>;
  }

  return content;
};

export default React.memo(MiniPlayerBar);
