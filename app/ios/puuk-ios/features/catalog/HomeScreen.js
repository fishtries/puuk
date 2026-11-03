import React, { useRef, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Platform,
  DeviceEventEmitter,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInDown } from 'react-native-reanimated';
import CoverImage from '../../shared/media/CoverImage';
import YourMixCard from './YourMixCard';
import GenreMixesSection from './GenreMixesSection';
import RecentlyListenedSection from './RecentlyListenedSection';
import { useRecentlyListened } from './useRecentlyListened';

const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

const SectionHeader = ({ title }) => (
  <View style={styles.sectionHeader}>
    <Text style={styles.sectionTitle}>{title}</Text>
  </View>
);

const LibraryTrackRow = React.memo(function LibraryTrackRow({
  track,
  onPress,
  index,
  onPressEllipsis,
}) {
  const handlePress = useCallback(() => {
    if (onPress) onPress(track);
  }, [onPress, track]);

  const handleEllipsis = useCallback(() => {
    if (onPressEllipsis) onPressEllipsis(track);
  }, [onPressEllipsis, track]);

  return (
    <AnimatedTouchable
      entering={FadeInDown.delay(Math.min(index * 20, 300)).duration(350)}
      style={styles.libraryRow}
      activeOpacity={0.6}
      onPress={handlePress}
    >
      <CoverImage source={track.coverArt} style={styles.libraryRowImage} />
      <View style={styles.libraryRowInfo}>
        <Text style={styles.libraryRowTitle} numberOfLines={1}>
          {track.title}
        </Text>
        <Text style={styles.libraryRowArtist} numberOfLines={1}>
          {track.artist}
        </Text>
      </View>
      <TouchableOpacity
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        onPress={handleEllipsis}
      >
        <Ionicons name="ellipsis-horizontal" size={18} color="#555" />
      </TouchableOpacity>
    </AnimatedTouchable>
  );
});

export default function HomeScreen({
  tracks = [],
  isPlaying,
  currentTrack,
  onPlayTrack,
  onPlayTrackList,
  onStartWave,
  onAddToPlaylist,
  onPressEllipsis,
  onLoadMoreTracks,
  hasMoreTracks,
  isLoadingMoreTracks,
  currentUser,
  navigation,
  accentColor,
  genreMixes,
}) {
  const flatListRef = useRef(null);
  const insets = React.useContext(SafeAreaInsetsContext);
  const topInset = insets?.top || (Platform.OS === 'ios' ? 44 : 0);
  const headerScrimHeight = topInset + 84;

  const {
    tracks: recentlyListenedTracks,
    isLoading: isRecentlyListenedLoading,
  } = useRecentlyListened({ currentUser });

  const handleStartWave = useCallback(() => {
    if (onStartWave) onStartWave();
  }, [onStartWave]);

  const handleEndReached = useCallback(() => {
    if (
      hasMoreTracks &&
      !isLoadingMoreTracks &&
      typeof onLoadMoreTracks === 'function'
    ) {
      onLoadMoreTracks();
    }
  }, [hasMoreTracks, isLoadingMoreTracks, onLoadMoreTracks]);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      'PUUK_SCROLL_TO_TOP_HOME',
      () => {
        flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
      },
    );
    return () => sub.remove();
  }, []);

  const renderItem = useCallback(
    ({ item, index }) => (
      <LibraryTrackRow
        track={item}
        onPress={onPlayTrack}
        index={index}
        onPressEllipsis={onAddToPlaylist || onPressEllipsis}
      />
    ),
    [onPlayTrack, onAddToPlaylist, onPressEllipsis],
  );

  const keyExtractor = useCallback(
    (item, index) => String(item.id || item.track_id || index),
    [],
  );

  const handleEllipsisTrack = onAddToPlaylist || onPressEllipsis;

  const ListHeader = useMemo(
    () => (
      <>
        <YourMixCard onPress={handleStartWave} />
        <GenreMixesSection
          currentUser={currentUser}
          navigation={navigation}
          onPlayTrackList={onPlayTrackList}
          accentColor={accentColor}
          sections={genreMixes}
        />
        <RecentlyListenedSection
          tracks={recentlyListenedTracks}
          isLoading={isRecentlyListenedLoading}
          currentTrack={currentTrack}
          isPlaying={isPlaying}
          onPlayTrack={onPlayTrack}
          onPressEllipsis={handleEllipsisTrack}
        />
        {tracks.length > 0 && <SectionHeader title="Tracks" />}
      </>
    ),
    [
      handleStartWave,
      currentUser,
      navigation,
      onPlayTrackList,
      accentColor,
      genreMixes,
      recentlyListenedTracks,
      isRecentlyListenedLoading,
      currentTrack,
      isPlaying,
      onPlayTrack,
      handleEllipsisTrack,
      tracks.length,
    ],
  );

  const ListFooter = useMemo(
    () => (
      <>
        {isLoadingMoreTracks && (
          <View style={styles.loadingMoreContainer}>
            <ActivityIndicator size="small" color="#FFDAB9" />
          </View>
        )}
        <View style={{ height: 120 }} />
      </>
    ),
    [isLoadingMoreTracks],
  );

  return (
    <View style={styles.container} testID="home-screen">
      <FlatList
        ref={flatListRef}
        data={tracks}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        ListHeaderComponent={ListHeader}
        ListFooterComponent={ListFooter}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: currentTrack ? 100 : 70 },
        ]}
        showsVerticalScrollIndicator={false}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        initialNumToRender={15}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews={Platform.OS !== 'android'}
      />
      <View
        pointerEvents="none"
        style={[styles.headerScrim, { height: headerScrimHeight }]}
        testID="home-header-scrim"
      >
        <LinearGradient
          colors={[
            'rgba(0, 0, 0, 0.85)',
            'rgba(0, 0, 0, 0.65)',
            'rgba(0, 0, 0, 0.35)',
            'rgba(0, 0, 0, 0.08)',
            'transparent',
          ]}
          locations={[0, 0.35, 0.65, 0.88, 1.0]}
          style={StyleSheet.absoluteFill}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  headerScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 5,
  },
  scrollContent: {
    paddingTop: 0,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: 20,
    marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: -0.3,
  },
  libraryList: {
    paddingHorizontal: 20,
  },
  libraryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  libraryRowImage: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: '#1c1c1e',
  },
  libraryRowInfo: {
    flex: 1,
    marginLeft: 14,
    justifyContent: 'center',
  },
  libraryRowTitle: {
    fontSize: 16,
    fontWeight: '500',
    color: '#ffffff',
    marginBottom: 3,
  },
  libraryRowArtist: {
    fontSize: 14,
    color: '#8e8e93',
  },
  loadingMoreContainer: {
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
