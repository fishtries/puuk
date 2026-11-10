import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActionSheetIOS,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  runOnJS,
  ReduceMotion,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import CoverImage from '../shared/media/CoverImage';
import {
  getSelectableArtists,
  normalizeCredits,
} from '../shared/domain/artistCredits';

export default function QueueItem({
  item,
  rowHeight,
  onPress,
  onRemove,
  onMove,
  onDragStart,
  onDragUpdate,
  onDragEnd,
  dragging,
  dragScroll,
  shift = 0,
  canMoveUp,
  canMoveDown,
  onPlayNext,
  onArtistPress,
  onAlbumPress,
}) {
  const translation = useSharedValue(0);
  const lift = useSharedValue(0);
  const drag = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-4, 4])
        .onStart(() => {
          lift.value = withSpring(1, { reduceMotion: ReduceMotion.System });
          runOnJS(onDragStart)(item);
        })
        .onUpdate((event) => {
          translation.value = event.translationY;
          runOnJS(onDragUpdate)(item, event.translationY);
        })
        .onEnd(() => {
          runOnJS(onDragEnd)(item, true);
        })
        .onFinalize((_event, success) => {
          translation.value = withSpring(0, {
            reduceMotion: ReduceMotion.System,
          });
          lift.value = withSpring(0, { reduceMotion: ReduceMotion.System });
          if (!success) runOnJS(onDragEnd)(item, false);
        }),
    [item, lift, translation, onDragStart, onDragUpdate, onDragEnd],
  );
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: dragging
          ? translation.value + dragScroll.value
          : withSpring(shift, {
              damping: 25,
              stiffness: 260,
              reduceMotion: ReduceMotion.System,
            }),
      },
      { scale: 1 + lift.value * 0.025 },
    ],
    backgroundColor: `rgba(255,255,255,${lift.value * 0.12})`,
  }));
  const openMenu = () => {
    const artists = getSelectableArtists({
      artists: normalizeCredits(item.artists, item.artist_id, item.artist),
    });
    const actions = [
      { title: 'Играть следующим', action: onPlayNext },
      ...(canMoveUp
        ? [{ title: 'Переместить выше', action: () => onMove(-1) }]
        : []),
      ...(canMoveDown
        ? [{ title: 'Переместить ниже', action: () => onMove(1) }]
        : []),
      ...(onArtistPress
        ? artists.map((artist) => ({
            title: `К исполнителю: ${artist.name}`,
            action: () => onArtistPress(artist.id),
          }))
        : []),
      ...(item.album_id && onAlbumPress
        ? [
            {
              title: 'Перейти к альбому',
              action: () => onAlbumPress(item.album_id),
            },
          ]
        : []),
      { title: 'Убрать из очереди', action: onRemove },
    ];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: item.title,
        options: ['Отмена', ...actions.map((action) => action.title)],
        cancelButtonIndex: 0,
        destructiveButtonIndex: actions.length,
      },
      (selected) => {
        if (selected > 0) actions[selected - 1]?.action();
      },
    );
  };
  return (
    <Animated.View
      style={[
        styles.row,
        { height: rowHeight, zIndex: dragging ? 100 : 0 },
        animatedStyle,
      ]}
    >
      <ReanimatedSwipeable
        enabled={!dragging}
        overshootRight={false}
        rightThreshold={55}
        onSwipeableWillOpen={onRemove}
        renderRightActions={() => (
          <TouchableOpacity
            onPress={onRemove}
            accessibilityLabel={`Убрать ${item.title} из очереди`}
            style={styles.delete}
          >
            <Ionicons name="trash-outline" size={22} color="white" />
          </TouchableOpacity>
        )}
      >
        <View style={[styles.content, { height: rowHeight }]}>
          <TouchableOpacity
            style={styles.track}
            onPress={onPress}
            onLongPress={openMenu}
            accessibilityRole="button"
            accessibilityLabel={`Воспроизвести ${item.title}, ${item.artist}`}
          >
            <CoverImage source={item.coverArt} style={styles.cover} />
            <View style={styles.info}>
              <Text numberOfLines={1} style={styles.title}>
                {item.title}
              </Text>
              <Text numberOfLines={1} style={styles.artist}>
                {item.artist}
                {item.queueOrigin === 'manual' ? ' · добавлено тобой' : ''}
              </Text>
            </View>
          </TouchableOpacity>
          <GestureDetector gesture={drag}>
            <Animated.View>
              <TouchableOpacity
                onPress={openMenu}
                style={styles.handle}
                accessibilityRole="button"
                accessibilityLabel={`Действия с ${item.title}`}
                accessibilityHint="Перетащите для изменения порядка или нажмите для меню"
              >
                <Ionicons
                  name="reorder-three-outline"
                  size={27}
                  color="rgba(255,255,255,0.48)"
                />
              </TouchableOpacity>
            </Animated.View>
          </GestureDetector>
        </View>
      </ReanimatedSwipeable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { borderRadius: 12 },
  content: { flexDirection: 'row', alignItems: 'center' },
  track: { flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  cover: {
    width: 48,
    height: 48,
    borderRadius: 7,
    marginRight: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  info: { flex: 1, minWidth: 0 },
  title: { color: 'white', fontSize: 17, fontWeight: '500' },
  artist: { color: 'rgba(255,255,255,0.6)', fontSize: 14, marginTop: 3 },
  handle: {
    width: 44,
    height: 48,
    justifyContent: 'center',
    alignItems: 'flex-end',
  },
  delete: {
    width: 72,
    backgroundColor: '#b53548',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
  },
});
