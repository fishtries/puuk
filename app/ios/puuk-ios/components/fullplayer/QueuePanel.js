import React, {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  useWindowDimensions,
} from 'react-native';
import Animated, { useSharedValue } from 'react-native-reanimated';
import { GestureDetector, FlatList } from 'react-native-gesture-handler';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import QueueItem from '../QueueItem';
import ArtistSelector from '../../shared/components/ArtistSelector';
import PlayerHeader from './PlayerHeader';
import playerStyles, { QUEUE_COVER_SIZE, PLAYER_HEADER_CONTENT_GAP } from './playerStyles';
import { getTrackId } from '../../shared/domain/trackAdapter';
import { queueKey } from '../../utils/queueIdentity';

const DraggedCell = createContext(null);
function QueueCell({ index, style, children, ...props }) {
  const draggedIndex = useContext(DraggedCell);
  return (
    <View
      {...props}
      style={[style, { zIndex: draggedIndex === index ? 10 : 0 }]}
    >
      {children}
    </View>
  );
}

function ModeButton({ label, icon, active, onPress, badge, disabled }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled }}
      style={[
        styles.mode,
        active && styles.modeActive,
        disabled && { opacity: 0.4 },
      ]}
    >
      <Ionicons
        name={icon}
        size={22}
        color={active ? '#242026' : 'rgba(255,255,255,0.9)'}
      />
      {badge && <Text style={styles.badge}>{badge}</Text>}
    </TouchableOpacity>
  );
}

export default function QueuePanel({
  queueAnimatedStyle,
  isQueueVisible,
  isLyricsView,
  queueHeaderSwipeGesture,
  upNextQueue = [],
  playTrack,
  currentTrack,
  isLiked,
  onToggleLike,
  onArtistPress,
  onAlbumPress,
  onCloseQueue,
  onClose,
  menuActions,
  handleMenuAction,
  onCoverLayout,
  controls = {},
}) {
  const { fontScale } = useWindowDimensions();
  const rowHeight = Math.max(70, 56 * fontScale + 14);
  const list = useRef(null);
  const scroll = useRef(0);
  const viewport = useRef(0);
  const drag = useRef(null);
  const dragScroll = useSharedValue(0);
  const [preview, setPreview] = useState(null);
  const latest = useRef(upNextQueue);
  latest.current = upNextQueue;
  const latestControls = useRef(controls);
  latestControls.current = controls;

  const cancelDrag = useCallback(() => {
    drag.current = null;
    dragScroll.value = 0;
    setPreview(null);
  }, [dragScroll]);
  useEffect(() => {
    cancelDrag();
  }, [upNextQueue, isQueueVisible, cancelDrag]);
  useEffect(
    () => () => {
      drag.current = null;
    },
    [],
  );

  const startDrag = useCallback(
    (item) => {
      const from = latest.current.indexOf(item);
      if (from < 0) return;
      drag.current = {
        item,
        from,
        to: from,
        scroll: scroll.current,
        translation: 0,
      };
      dragScroll.value = 0;
      setPreview({ from, to: from });
    },
    [dragScroll],
  );
  const updateDrag = useCallback(
    (item, translation) => {
      const active = drag.current;
      if (!active || active.item !== item) return;
      active.translation = translation;
      const relativeY = active.from * rowHeight + translation - active.scroll;
      const maxOffset = Math.max(
        0,
        latest.current.length * rowHeight - viewport.current,
      );
      let offset = scroll.current;
      if (relativeY < 50) offset = Math.max(0, offset - 10);
      else if (relativeY > viewport.current - rowHeight - 50)
        offset = Math.min(maxOffset, offset + 10);
      if (offset !== scroll.current) {
        scroll.current = offset;
        dragScroll.value = offset - active.scroll;
        list.current?.scrollToOffset({ offset, animated: false });
      }
      const to = Math.max(
        0,
        Math.min(
          latest.current.length - 1,
          active.from +
            Math.round((translation + offset - active.scroll) / rowHeight),
        ),
      );
      if (to !== active.to) {
        active.to = to;
        setPreview({ from: active.from, to });
      }
    },
    [rowHeight, dragScroll],
  );
  const isDragging = !!preview;
  useEffect(() => {
    if (!isDragging) return;
    const timer = setInterval(() => {
      const active = drag.current;
      if (active) updateDrag(active.item, active.translation);
    }, 32);
    return () => clearInterval(timer);
  }, [isDragging, updateDrag]);
  const endDrag = useCallback(
    (item, commit) => {
      const active = drag.current;
      if (active?.item === item && commit) {
        const target = latest.current[active.to];
        if (target) latestControls.current.move?.(queueKey(item), queueKey(target));
      }
      cancelDrag();
    },
    [cancelDrag],
  );

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, queueAnimatedStyle]}
      pointerEvents={isQueueVisible && !isLyricsView ? 'auto' : 'none'}
      accessibilityElementsHidden={!isQueueVisible || isLyricsView}
    >
      <View style={styles.container}>
        <GestureDetector gesture={queueHeaderSwipeGesture}>
          <Animated.View>
            <View style={styles.headerOverlay} pointerEvents="box-none">
              <PlayerHeader
                styles={playerStyles}
                handleClose={onClose}
                displayTitle={currentTrack?.title}
                menuActions={menuActions}
                handleMenuAction={handleMenuAction}
                leadingActions={(
                  <TouchableOpacity
                    onPress={onToggleLike}
                    accessibilityRole="button"
                    accessibilityLabel={
                      isLiked ? 'Убрать из избранного' : 'В избранное'
                    }
                    accessibilityState={{ selected: !!isLiked }}
                    style={styles.like}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  >
                    <Ionicons
                      name={isLiked ? 'heart' : 'heart-outline'}
                      size={22}
                      color={isLiked ? '#ff2d55' : 'white'}
                    />
                  </TouchableOpacity>
                )}
              />
            </View>
            <View style={{ height: 11 + PLAYER_HEADER_CONTENT_GAP }} pointerEvents="none" />
            <View style={styles.nowPlaying} onLayout={(event) => {
              const { x, y, height } = event.nativeEvent.layout;
              onCoverLayout?.({ x, y: y + (height - QUEUE_COVER_SIZE) / 2, width: QUEUE_COVER_SIZE, height: QUEUE_COVER_SIZE });
            }}>
              <TouchableOpacity
                onPress={onCloseQueue}
                accessibilityRole="button"
                accessibilityLabel="Вернуться к обложке"
              >
                {/* The full player's existing cover moves into this hit area. */}
                <View style={styles.currentCover} />
              </TouchableOpacity>
              <View style={styles.currentInfo}>
                <Text numberOfLines={1} style={styles.currentTitle}>
                  {currentTrack?.title}
                </Text>
                <ArtistSelector
                  entity={currentTrack}
                  identity={getTrackId(currentTrack)}
                  display={currentTrack?.artist}
                  onSelect={onArtistPress}
                  onAlbumSelect={onAlbumPress}
                  controlStyle={playerStyles.artistButton}
                  textStyle={styles.currentArtist}
                  numberOfLines={1}
                  triggerTestID="queue-artist-button"
                />
              </View>
            </View>
          </Animated.View>
        </GestureDetector>
        <View style={styles.modes}>
          <ModeButton
            label={
              controls.shuffleEnabled
                ? 'Выключить перемешивание'
                : 'Перемешать очередь'
            }
            icon="shuffle"
            active={controls.shuffleEnabled}
            onPress={controls.toggleShuffle}
            disabled={upNextQueue.length < 2 && !controls.shuffleEnabled}
          />
          <ModeButton
            label={`Повтор: ${{ off: 'выключен', all: 'вся очередь', one: 'один трек' }[controls.repeatMode || 'off']}`}
            icon="repeat"
            badge={controls.repeatMode === 'one' ? '1' : null}
            active={controls.repeatMode && controls.repeatMode !== 'off'}
            onPress={controls.cycleRepeatMode}
          />
          <ModeButton
            label={
              controls.autoplayEnabled
                ? 'Выключить автоподбор после очереди'
                : 'Включить автоподбор после очереди'
            }
            icon="infinite"
            active={controls.autoplayEnabled}
            onPress={controls.toggleAutoplay}
          />
        </View>
        <View style={styles.heading}>
          <Text accessibilityRole="header" style={styles.headingText}>
            Далее
          </Text>
          <TouchableOpacity
            onPress={controls.clear}
            disabled={!upNextQueue.length}
            accessibilityRole="button"
            accessibilityLabel="Очистить очередь"
            style={styles.clear}
          >
            <Text
              style={[
                styles.clearText,
                !upNextQueue.length && { opacity: 0.35 },
              ]}
            >
              Очистить
            </Text>
          </TouchableOpacity>
        </View>
        <DraggedCell.Provider value={preview?.from}>
          <MaskedView
            style={styles.list}
            maskElement={
              <LinearGradient
                colors={['black', 'black', 'transparent']}
                locations={[0, 0.92, 1]}
                style={StyleSheet.absoluteFill}
              />
            }
          >
            <FlatList
              ref={list}
              data={upNextQueue}
              extraData={preview}
              keyExtractor={queueKey}
              CellRendererComponent={QueueCell}
              scrollEnabled={!preview}
              removeClippedSubviews={false}
              onLayout={(event) => {
                viewport.current = event.nativeEvent.layout.height;
              }}
              onScroll={(event) => {
                scroll.current = event.nativeEvent.contentOffset.y;
                if (drag.current)
                  dragScroll.value = scroll.current - drag.current.scroll;
              }}
              scrollEventThrottle={16}
              getItemLayout={(_data, index) => ({
                length: rowHeight,
                offset: index * rowHeight,
                index,
              })}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.listContent}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Ionicons
                    name={
                      controls.autoplayEnabled ? 'infinite' : 'list-outline'
                    }
                    size={32}
                    color="rgba(255,255,255,0.5)"
                  />
                  <Text style={styles.emptyTitle}>Очередь пуста</Text>
                  <Text style={styles.emptyText}>
                    {controls.repeatMode !== 'off'
                      ? 'Включён повтор. Добавь треки через меню.'
                      : controls.autoplayEnabled
                        ? 'После текущего трека подберём похожие.'
                        : 'Добавь треки через «Играть следующим» или «В конец очереди».'}
                  </Text>
                </View>
              }
              renderItem={({ item, index }) => {
                const from = preview?.from;
                const to = preview?.to;
                const shift =
                  preview && index !== from
                    ? from < to && index > from && index <= to
                      ? -rowHeight
                      : from > to && index >= to && index < from
                        ? rowHeight
                        : 0
                    : 0;
                const move = (delta) => {
                  const target = upNextQueue[index + delta];
                  if (target) controls.move?.(queueKey(item), queueKey(target));
                };
                return (
                  <QueueItem
                    item={item}
                    onArtistPress={onArtistPress}
                    onAlbumPress={onAlbumPress}
                    rowHeight={rowHeight}
                    dragging={preview?.from === index}
                    dragScroll={dragScroll}
                    shift={shift}
                    onPress={() =>
                      playTrack(item, { source: 'queue', queueIndex: index })
                    }
                    onRemove={() => controls.remove?.(queueKey(item))}
                    onMove={move}
                    canMoveUp={index > 0}
                    canMoveDown={index < upNextQueue.length - 1}
                    onPlayNext={() =>
                      controls.move?.(queueKey(item), queueKey(upNextQueue[0]))
                    }
                    onDragStart={startDrag}
                    onDragUpdate={updateDrag}
                    onDragEnd={endDrag}
                  />
                );
              }}
            />
          </MaskedView>
        </DraggedCell.Provider>
        {controls.undoMessage ? (
          <View style={styles.notice} accessibilityLiveRegion="polite">
            <Text style={styles.noticeText}>{controls.undoMessage}</Text>
            <TouchableOpacity
              onPress={controls.undo}
              style={styles.undo}
              accessibilityRole="button"
            >
              <Text style={styles.undoText}>Отменить</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <Text style={styles.footer}>
            {controls.repeatMode !== 'off'
              ? 'Повтор имеет приоритет над автоподбором'
              : controls.autoplayEnabled
                ? '∞  После очереди — похожая музыка'
                : 'Воспроизведение закончится вместе с очередью'}
          </Text>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingBottom: 4 },
  headerOverlay: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2 },
  nowPlaying: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    paddingRight: 84,
    gap: 12,
  },
  currentCover: {
    width: QUEUE_COVER_SIZE,
    height: QUEUE_COVER_SIZE,
  },
  currentInfo: { flex: 1, minWidth: 0 },
  currentTitle: { ...playerStyles.titleText, fontSize: 19 },
  currentArtist: {
    ...playerStyles.artistText,
    fontSize: 15,
  },
  like: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modes: { flexDirection: 'row', gap: 12, marginBottom: 10 },
  mode: {
    flex: 1,
    height: 44,
    borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  modeActive: { backgroundColor: 'rgba(255,255,255,0.85)' },
  badge: { fontSize: 12, fontWeight: '800', color: '#242026', marginLeft: 2 },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  headingText: { color: 'white', fontSize: 22, fontWeight: '700' },
  clear: { minHeight: 44, justifyContent: 'center' },
  clearText: { color: 'rgba(255,255,255,0.65)', fontSize: 16 },
  list: { flex: 1 },
  listContent: { paddingBottom: 30, flexGrow: 1 },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    gap: 8,
  },
  emptyTitle: { color: 'white', fontSize: 18, fontWeight: '600' },
  emptyText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  footer: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    paddingVertical: 10,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  noticeText: { color: 'white', fontSize: 14 },
  undo: { minHeight: 44, justifyContent: 'center' },
  undoText: { color: 'white', fontSize: 15, fontWeight: '600' },
});
