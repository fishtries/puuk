import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Dimensions,
  ActivityIndicator,
  TextInput,
  Keyboard,
  DeviceEventEmitter,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import CoverImage from './CoverImage';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeInRight,
  LinearTransition,
} from 'react-native-reanimated';
import { authFetch, SERVER_URL } from '../utils/api';
import { getSettings, addSettingsListener } from '../utils/settings';

const { width } = Dimensions.get('window');
const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

// ─── Search Result Track Row ─────────────────────────────────────────────
const SearchResultRow = ({ track, onPress, index, onPressEllipsis, isCurrentPlaying, isPlaying, accentColor }) => (
  <AnimatedTouchable
    entering={FadeInDown.delay(index * 25).duration(250)}
    style={[styles.resultRow, isCurrentPlaying && { backgroundColor: '#181614', borderLeftWidth: 3, borderLeftColor: accentColor }]}
    activeOpacity={0.65}
    onPress={() => onPress(track)}
  >
    <CoverImage source={track.coverArt} style={styles.resultImage} />
    <View style={styles.resultInfo}>
      <Text style={[styles.resultTitle, isCurrentPlaying && { color: accentColor }]} numberOfLines={1}>
        {track.title}
      </Text>
      <Text style={styles.resultArtist} numberOfLines={1}>
        {track.artist} {track.album && track.album !== 'Unknown Album' ? `• ${track.album}` : ''}
      </Text>
    </View>

    {isCurrentPlaying && isPlaying && (
      <Ionicons
        name="volume-high"
        size={18}
        color={accentColor}
        style={{ marginRight: 8 }}
      />
    )}

    <TouchableOpacity 
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      onPress={() => onPressEllipsis && onPressEllipsis(track)}
      style={styles.ellipsisBtn}
    >
      <Ionicons name="ellipsis-horizontal" size={18} color="#666" />
    </TouchableOpacity>
  </AnimatedTouchable>
);

// ─── Artist Card ──────────────────────────────────────────────────────────
const ArtistCard = ({ artist, onPress, index, accentColor }) => (
  <AnimatedTouchable
    entering={FadeInRight.delay(index * 35).duration(300)}
    style={styles.artistCard}
    activeOpacity={0.7}
    onPress={() => onPress(artist)}
  >
    <View style={styles.artistAvatar}>
      {artist.coverArt ? (
        <CoverImage source={artist.coverArt} style={styles.artistImage} />
      ) : (
        <View style={styles.artistPlaceholder}>
          <Ionicons name="person" size={32} color={accentColor} />
        </View>
      )}
    </View>
    <Text style={styles.artistName} numberOfLines={1}>
      {artist.name}
    </Text>
    <Text style={styles.artistSub} numberOfLines={1}>
      {artist.track_count} {artist.track_count === 1 ? 'track' : 'tracks'}
    </Text>
  </AnimatedTouchable>
);

// ─── Album Card ───────────────────────────────────────────────────────────
const AlbumCard = ({ album, onPress, index }) => (
  <AnimatedTouchable
    entering={FadeInRight.delay(index * 35).duration(300)}
    style={styles.albumCard}
    activeOpacity={0.7}
    onPress={() => onPress(album)}
  >
    <View style={styles.albumCoverContainer}>
      <CoverImage source={album.coverArt} style={styles.albumImage} />
      <View style={styles.albumIconBadge}>
        <Ionicons name="disc-outline" size={18} color="#fff" />
      </View>
    </View>
    <Text style={styles.albumTitle} numberOfLines={1}>
      {album.title}
    </Text>
    <Text style={styles.albumArtist} numberOfLines={1}>
      {album.artist}
    </Text>
  </AnimatedTouchable>
);

// ─── Main SearchScreen ─────────────────────────────────────────────
export default function SearchScreen({
  navigation,
  onPlayTrack,
  onAddToPlaylist,
  currentUser,
  onOpenAuthModal,
  currentTrack,
  isPlaying,
}) {
  const [accentColor, setAccentColor] = useState(() => getSettings().accentColor || '#FFDAB9');
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState({ tracks: [], albums: [], artists: [] });
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const searchTimerRef = useRef(null);
  const searchInputRef = useRef(null);
  const scrollViewRef = useRef(null);

  useEffect(() => {
    const unsub = addSettingsListener((s) => {
      if (s.accentColor) setAccentColor(s.accentColor);
    });
    return unsub;
  }, []);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('PUUK_SCROLL_TO_TOP_SEARCH', () => {
      scrollViewRef.current?.scrollTo({ y: 0, animated: true });
    });
    return () => sub.remove();
  }, []);

  // Auto-focus search input on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      searchInputRef.current?.focus();
    }, 400);
    return () => clearTimeout(timer);
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  // ── Search with debounce ──
  const performSearch = useCallback(async (query) => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults({ tracks: [], albums: [], artists: [] });
      setIsSearching(false);
      setHasSearched(false);
      return;
    }

    setIsSearching(true);
    try {
      const response = await authFetch(
        `/api/search?q=${encodeURIComponent(trimmed)}&limit=30`
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      let tracks = [];
      let albums = [];
      let artists = [];

      if (Array.isArray(data)) {
        tracks = data.map((t) => ({
          ...t,
          coverArt: t.coverArt || `${SERVER_URL}/api/cover/${t.id}`,
        }));
      } else if (data && typeof data === 'object') {
        tracks = (data.tracks || []).map((t) => ({
          ...t,
          coverArt: t.coverArt || `${SERVER_URL}/api/cover/${t.id}`,
        }));
        albums = data.albums || [];
        artists = data.artists || [];
      }

      setResults({ tracks, albums, artists });
    } catch (error) {
      console.warn('Search error:', error);
      setResults({ tracks: [], albums: [], artists: [] });
    } finally {
      setIsSearching(false);
      setHasSearched(true);
    }
  }, []);

  const handleSearchChange = useCallback((text) => {
    setSearchQuery(text);
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }
    if (!text.trim()) {
      setResults({ tracks: [], albums: [], artists: [] });
      setHasSearched(false);
      return;
    }
    searchTimerRef.current = setTimeout(() => {
      performSearch(text);
    }, 350);
  }, [performSearch]);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setResults({ tracks: [], albums: [], artists: [] });
    setHasSearched(false);
    searchInputRef.current?.focus();
  }, []);

  const handleTrackPress = useCallback((track) => {
    onPlayTrack(track);
    Keyboard.dismiss();
  }, [onPlayTrack]);

  const handleAlbumPress = useCallback((album) => {
    Keyboard.dismiss();
    navigation.navigate('Album', {
      albumId: album.id,
      albumTitle: album.title,
      coverArt: album.coverArt,
    });
  }, [navigation]);

  const handleArtistPress = useCallback((artist) => {
    // Fill search bar with artist name and trigger search
    setSearchQuery(artist.name);
    performSearch(artist.name);
    Keyboard.dismiss();
  }, [performSearch]);

  const totalResults = results.tracks.length + results.albums.length + results.artists.length;

  const showArtists = results.artists.length > 0;
  const showAlbums = results.albums.length > 0;
  const showTracks = results.tracks.length > 0;

  return (
    <View style={styles.container}>
      {/* ── Search Bar ── */}
      <Animated.View entering={FadeInDown.duration(400)} style={styles.searchBarSection}>
        <View style={styles.searchBarContainer}>
          <Ionicons name="search" size={18} color="#8e8e93" style={styles.searchIcon} />
          <TextInput
            ref={searchInputRef}
            style={styles.searchInput}
            placeholder="Tracks, artists, albums..."
            placeholderTextColor="#666"
            value={searchQuery}
            onChangeText={handleSearchChange}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={clearSearch} style={styles.searchClearBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={18} color="#8E8E93" />
            </TouchableOpacity>
          )}
        </View>
      </Animated.View>

      {/* ── Content ── */}
      <ScrollView
        ref={scrollViewRef}
        style={styles.scrollView}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: currentTrack ? 175 : 105 }
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {/* Initial state — no query */}
        {!searchQuery.trim() && !hasSearched && (
          <Animated.View entering={FadeIn.duration(500)} style={styles.initialState}>
            <View style={styles.initialIconContainer}>
              <Ionicons name="search" size={44} color="#444" />
            </View>
            <Text style={styles.initialTitle}>Find your music</Text>
            <Text style={styles.initialHint}>Search by track, artist name, or album title</Text>
          </Animated.View>
        )}

        {/* Loading */}
        {isSearching && (
          <Animated.View entering={FadeIn.duration(200)} style={styles.loadingState}>
            <ActivityIndicator color={accentColor} size="small" />
            <Text style={styles.loadingText}>Searching...</Text>
          </Animated.View>
        )}

        {/* ─── Search Results ─── */}
        {!isSearching && hasSearched && totalResults > 0 && (
          <View style={styles.resultsWrapper}>
            {/* 1. Artists Section */}
            {showArtists && (
              <View style={styles.sectionBlock}>
                <Text style={styles.sectionTitle}>Artists</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.horizontalScroll}>
                  {results.artists.map((artist, idx) => (
                    <ArtistCard
                      key={`art-${artist.name}-${idx}`}
                      artist={artist}
                      onPress={handleArtistPress}
                      index={idx}
                      accentColor={accentColor}
                    />
                  ))}
                </ScrollView>
              </View>
            )}

            {/* 2. Albums Section */}
            {showAlbums && (
              <View style={styles.sectionBlock}>
                <Text style={styles.sectionTitle}>Albums</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.horizontalScroll}>
                  {results.albums.map((album, idx) => (
                    <AlbumCard
                      key={`alb-${album.id}-${idx}`}
                      album={album}
                      onPress={handleAlbumPress}
                      index={idx}
                    />
                  ))}
                </ScrollView>
              </View>
            )}

            {/* 3. Tracks Section */}
            {showTracks && (
              <View style={styles.sectionBlock}>
                <Text style={styles.sectionTitle}>Tracks</Text>
                <View style={styles.resultsList}>
                  {results.tracks.map((track, index) => (
                    <SearchResultRow
                      key={`search-${track.id}`}
                      track={track}
                      onPress={handleTrackPress}
                      index={index}
                      onPressEllipsis={onAddToPlaylist}
                      isCurrentPlaying={currentTrack?.id === track.id}
                      isPlaying={isPlaying}
                      accentColor={accentColor}
                    />
                  ))}
                </View>
              </View>
            )}
          </View>
        )}

        {/* Empty results */}
        {!isSearching && hasSearched && totalResults === 0 && (
          <Animated.View entering={FadeIn.duration(400)} style={styles.emptyState}>
            <Ionicons name="musical-notes-outline" size={48} color="#333" />
            <Text style={styles.emptyTitle}>No results found</Text>
            <Text style={styles.emptyHint}>Try checking spelling or searching for another artist, track, or album</Text>
          </Animated.View>
        )}

        {/* Bottom spacer */}
        <View style={{ height: 120 }} />
      </ScrollView>
    </View>
  );
}

// ─── Styles ────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  // ── Search Bar ──
  searchBarSection: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
  },
  searchBarContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16161c',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#262630',
    paddingHorizontal: 12,
    height: 44,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    color: '#fff',
    paddingVertical: 0,
  },
  searchClearBtn: {
    padding: 4,
    marginLeft: 4,
  },

  // ── Scroll ──
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
  },

  // ── Section ──
  resultsWrapper: {
    marginTop: 4,
  },
  sectionBlock: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: -0.3,
    marginBottom: 12,
  },
  horizontalScroll: {
    gap: 14,
    paddingBottom: 4,
  },

  // ── Artist Card ──
  artistCard: {
    width: 96,
    alignItems: 'center',
  },
  artistAvatar: {
    width: 78,
    height: 78,
    borderRadius: 39,
    overflow: 'hidden',
    backgroundColor: '#1c1c22',
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#2c2c36',
  },
  artistImage: {
    width: '100%',
    height: '100%',
  },
  artistPlaceholder: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#1c1917',
  },
  artistName: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    width: '100%',
    marginBottom: 2,
  },
  artistSub: {
    color: '#8E8E93',
    fontSize: 11,
    textAlign: 'center',
  },

  // ── Album Card ──
  albumCard: {
    width: 126,
  },
  albumCoverContainer: {
    width: 126,
    height: 126,
    borderRadius: 14,
    backgroundColor: '#1c1c22',
    overflow: 'hidden',
    marginBottom: 8,
    position: 'relative',
    borderWidth: 1,
    borderColor: '#2a2a34',
  },
  albumImage: {
    width: '100%',
    height: '100%',
  },
  albumIconBadge: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  albumTitle: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 2,
  },
  albumArtist: {
    color: '#8E8E93',
    fontSize: 11,
  },

  // ── Initial State ──
  initialState: {
    alignItems: 'center',
    paddingTop: 80,
    gap: 12,
  },
  initialIconContainer: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: '#16161c',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#24242e',
  },
  initialTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#fff',
  },
  initialHint: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
  },

  // ── Loading ──
  loadingState: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
    gap: 10,
  },
  loadingText: {
    color: '#8e8e93',
    fontSize: 14,
  },

  // ── Results List ──
  resultsList: {
    backgroundColor: '#111115',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#1e1e26',
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1c1c22',
  },
  resultImage: {
    width: 46,
    height: 46,
    borderRadius: 8,
    backgroundColor: '#1c1c22',
  },
  resultInfo: {
    flex: 1,
    marginLeft: 12,
    justifyContent: 'center',
  },
  resultTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
    marginBottom: 3,
  },
  resultArtist: {
    fontSize: 13,
    color: '#8e8e93',
  },
  ellipsisBtn: {
    padding: 6,
  },

  // ── Empty ──
  emptyState: {
    alignItems: 'center',
    paddingTop: 80,
    gap: 8,
    paddingHorizontal: 20,
  },
  emptyTitle: {
    fontSize: 18,
    color: '#8e8e93',
    fontWeight: '600',
    marginTop: 8,
  },
  emptyHint: {
    fontSize: 13,
    color: '#666',
    textAlign: 'center',
    lineHeight: 18,
  },
});
