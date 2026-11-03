import React, { useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ScrollView,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import CoverImage from '../../shared/media/CoverImage';
import { areTrackIdsEqual, getTrackId } from '../../shared/domain/trackAdapter';

const COLUMN_GAP = 12;
const HORIZONTAL_PADDING = 20;

/**
 * Splits tracks into columns where each column contains 2 tracks stacked vertically.
 *
 * @param {Array<Object>} tracks
 * @param {number} [rowsCount=2]
 * @returns {Array<Array<Object>>}
 */
export function chunkTracksIntoColumns(tracks, rowsCount = 2) {
  if (!Array.isArray(tracks) || tracks.length === 0) return [];
  const columns = [];
  for (let i = 0; i < tracks.length; i += rowsCount) {
    columns.push(tracks.slice(i, i + rowsCount));
  }
  return columns;
}

// Alias for backward compatibility
export const chunkTracksIntoPages = chunkTracksIntoColumns;

/**
 * Single track row inside a column (width ~85% of screen).
 */
export const RecentlyListenedTrackRow = React.memo(function RecentlyListenedTrackRow({
  track,
  currentTrack,
  isPlaying,
  onPlayTrack,
  onPressEllipsis,
}) {
  const isCurrent = areTrackIdsEqual(track, currentTrack);
  const trackId = getTrackId(track);

  const handlePress = useCallback(() => {
    if (onPlayTrack) {
      onPlayTrack(track);
    }
  }, [onPlayTrack, track]);

  const handleEllipsis = useCallback(
    (e) => {
      e?.stopPropagation?.();
      if (onPressEllipsis) {
        onPressEllipsis(track);
      }
    },
    [onPressEllipsis, track],
  );

  const title = track.title || 'Unknown Track';
  const artist = track.artist || 'Unknown Artist';

  return (
    <TouchableOpacity
      style={styles.trackRow}
      activeOpacity={0.75}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`Воспроизвести ${title}, ${artist}`}
      testID={`recently-listened-card-${trackId}`}
    >
      <View style={styles.coverWrapper}>
        <CoverImage source={track.coverArt} style={styles.coverImage} />

        {isCurrent && (
          <View
            style={styles.playbackBadge}
            accessibilityLabel={isPlaying ? 'Воспроизводится' : 'На паузе'}
            testID={`recently-listened-${isPlaying ? 'playing' : 'paused'}-${trackId}`}
          >
            <Ionicons
              name={isPlaying ? 'play' : 'pause'}
              size={16}
              color="#FFFFFF"
            />
          </View>
        )}
      </View>

      <View style={styles.trackInfo}>
        <Text style={styles.trackTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.trackArtist} numberOfLines={1}>
          {artist}
        </Text>
      </View>

      <TouchableOpacity
        style={styles.ellipsisButton}
        activeOpacity={0.7}
        onPress={handleEllipsis}
        accessibilityRole="button"
        accessibilityLabel={`Действия для трека ${title}`}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        testID={`recently-listened-ellipsis-${trackId}`}
      >
        <Ionicons name="ellipsis-horizontal" size={18} color="#8e8e93" />
      </TouchableOpacity>
    </TouchableOpacity>
  );
});

// Alias for backwards compatibility
export const RecentlyListenedCard = RecentlyListenedTrackRow;

export default function RecentlyListenedSection({
  tracks = [],
  isLoading = false,
  currentTrack = null,
  isPlaying = false,
  onPlayTrack,
  onPressEllipsis,
}) {
  const windowDims = useWindowDimensions();
  const screenWidth = windowDims?.width || 390;

  // Each column is ~85% of screen width, leaving ~12-15% peek of next column
  const columnWidth = useMemo(() => {
    return Math.round(screenWidth * 0.85);
  }, [screenWidth]);

  const columns = useMemo(() => {
    return chunkTracksIntoColumns(tracks, 2);
  }, [tracks]);

  const hasTracks = Array.isArray(tracks) && tracks.length > 0;

  const renderColumn = useCallback(
    ({ item: columnTracks, index: colIndex }) => (
      <View
        style={[styles.column, { width: columnWidth }]}
        testID={`recently-listened-column-${colIndex}`}
      >
        {columnTracks.map((track) => (
          <RecentlyListenedTrackRow
            key={String(getTrackId(track))}
            track={track}
            currentTrack={currentTrack}
            isPlaying={isPlaying}
            onPlayTrack={onPlayTrack}
            onPressEllipsis={onPressEllipsis}
          />
        ))}
      </View>
    ),
    [columnWidth, currentTrack, isPlaying, onPlayTrack, onPressEllipsis],
  );

  const keyExtractor = useCallback(
    (column, colIdx) => {
      const ids = column.map((t) => getTrackId(t)).join('_');
      return ids || String(colIdx);
    },
    [],
  );

  const ItemSeparator = useCallback(
    () => <View style={styles.separator} />,
    [],
  );

  // Empty state: render null (no header, no margins)
  if (!isLoading && !hasTracks) {
    return null;
  }

  return (
    <View style={styles.container} testID="recently-listened-section">
      <View style={styles.sectionHeader}>
        <View style={styles.headerTitleCol}>
          <Text style={styles.sectionTitle}>Recently listened</Text>
        </View>
      </View>

      {isLoading && !hasTracks ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.scrollList}
        >
          <View
            style={[styles.column, { width: columnWidth }]}
            testID="recently-listened-skeleton"
          >
            {[1, 2].map((key) => (
              <View key={key} style={styles.trackRow}>
                <View style={[styles.coverWrapper, styles.skeletonBox]} />
                <View style={styles.trackInfo}>
                  <View
                    style={[styles.skeletonText, { width: '70%', height: 14 }]}
                  />
                  <View
                    style={[
                      styles.skeletonText,
                      { width: '45%', height: 12, marginTop: 6 },
                    ]}
                  />
                </View>
              </View>
            ))}
          </View>
          <View style={{ width: COLUMN_GAP }} />
          {/* Peek of next column */}
          <View style={[styles.column, { width: 50 }]}>
            {[1, 2].map((key) => (
              <View key={key} style={styles.trackRow}>
                <View style={[styles.coverWrapper, styles.skeletonBox]} />
              </View>
            ))}
          </View>
        </ScrollView>
      ) : (
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={columns}
          keyExtractor={keyExtractor}
          renderItem={renderColumn}
          ItemSeparatorComponent={ItemSeparator}
          contentContainerStyle={styles.scrollList}
          snapToInterval={columnWidth + COLUMN_GAP}
          decelerationRate="fast"
          snapToAlignment="start"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 20,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  headerTitleCol: {
    flex: 1,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: -0.3,
  },
  scrollList: {
    paddingHorizontal: HORIZONTAL_PADDING,
    paddingBottom: 4,
  },
  separator: {
    width: COLUMN_GAP,
  },
  column: {
    flexDirection: 'column',
    gap: 8,
  },
  trackRow: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#161618',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  coverWrapper: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: '#242428',
    overflow: 'hidden',
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
  },
  coverImage: {
    width: '100%',
    height: '100%',
  },
  playbackBadge: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  trackInfo: {
    flex: 1,
    marginLeft: 10,
    justifyContent: 'center',
  },
  trackTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#ffffff',
    letterSpacing: -0.2,
  },
  trackArtist: {
    fontSize: 13,
    fontWeight: '400',
    color: '#8e8e93',
    marginTop: 2,
  },
  ellipsisButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  skeletonBox: {
    backgroundColor: '#242428',
  },
  skeletonText: {
    borderRadius: 4,
    backgroundColor: '#242428',
  },
});
