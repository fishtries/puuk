import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  ScrollView,
  FlatList,
  Alert,
  ActionSheetIOS,
  DeviceEventEmitter,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import CoverImage from './CoverImage';
import AppHeader from './AppHeader';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withSequence,
  withDelay,
  withSpring,
  interpolate,
  Easing,
  FadeInDown,
  FadeInRight,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { authFetch, SERVER_URL } from '../utils/api';

const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

// ─── Visualizers ───────────────────────────────────────────────────
const ContinuousWaveBar = ({ index, isActive }) => {
  const height = useSharedValue(40);
  useEffect(() => {
    if (isActive) {
      height.value = withDelay(
        index * 250,
        withRepeat(
          withSequence(
            withTiming(130 + Math.random() * 40, { duration: 1200 + Math.random() * 600, easing: Easing.inOut(Easing.ease) }),
            withTiming(40 + Math.random() * 20, { duration: 1200 + Math.random() * 600, easing: Easing.inOut(Easing.ease) }),
          ),
          -1,
          true
        )
      );
    } else {
      height.value = withTiming(40, { duration: 800 });
    }
  }, [isActive]);

  const animatedStyle = useAnimatedStyle(() => ({ height: height.value }));
  return (
    <Animated.View
      style={[
        {
          width: 180,
          borderRadius: 90,
          backgroundColor: '#FFDAB9',
          marginHorizontal: -70,
          opacity: 0.95,
        },
        animatedStyle,
      ]}
    />
  );
};

const ContinuousWaveVisualizer = ({ isActive }) => (
  <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 160, justifyContent: 'center', width: '100%' }}>
    {Array.from({ length: 5 }).map((_, i) => (
      <ContinuousWaveBar key={i} index={i} isActive={isActive} />
    ))}
    <View style={{ position: 'absolute', bottom: -50, left: -100, right: -100, height: 80, backgroundColor: '#FFDAB9' }} />
  </View>
);

const SectionHeader = ({ title, onPress, buttonText = "All" }) => (
  <View style={styles.sectionHeader}>
    <Text style={styles.sectionTitle}>{title}</Text>
    {onPress && (
      <TouchableOpacity onPress={onPress} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Text style={styles.sectionSeeAll}>{buttonText}</Text>
      </TouchableOpacity>
    )}
  </View>
);

// ─── Animated Slogan ───────────────────────────────────────────────
const AnimatedSlogan = ({ isWaveActive, wavePhrase, onStartWave }) => {
  const progress = useSharedValue(isWaveActive ? 1 : 0);
  const [leftWidth, setLeftWidth] = useState(0);
  const [rightWidth, setRightWidth] = useState(0);

  useEffect(() => {
    progress.value = withSpring(isWaveActive ? 1 : 0, { damping: 20, stiffness: 120 });
  }, [isWaveActive]);

  const leftTextStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(progress.value, [0, 1], [0, leftWidth / 2 + 20]) }],
    opacity: interpolate(progress.value, [0, 0.5, 1], [1, 0, 0]),
  }));
  const rightTextStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(progress.value, [0, 1], [0, -(rightWidth / 2 + 20)]) }],
    opacity: interpolate(progress.value, [0, 0.5, 1], [1, 0, 0]),
  }));
  const buttonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(progress.value, [0, 1], [1, 1.8]) }],
  }));
  const leftSpacerStyle = useAnimatedStyle(() => ({
    width: interpolate(progress.value, [0, 1], [leftWidth + 12, 0]),
    height: 44,
    justifyContent: 'center',
  }));
  const rightSpacerStyle = useAnimatedStyle(() => ({
    width: interpolate(progress.value, [0, 1], [rightWidth + 12, 0]),
    height: 44,
    justifyContent: 'center',
  }));

  return (
    <View style={styles.sloganContainer}>
      <Text style={[styles.sloganText, { position: 'absolute', opacity: 0 }]} onLayout={(e) => setLeftWidth(e.nativeEvent.layout.width)}>{wavePhrase[0]}</Text>
      <Text style={[styles.sloganText, { position: 'absolute', opacity: 0 }]} onLayout={(e) => setRightWidth(e.nativeEvent.layout.width)}>{wavePhrase[1]}</Text>
      <Animated.View style={leftSpacerStyle}>
        {leftWidth > 0 && <Animated.Text numberOfLines={1} style={[styles.sloganText, leftTextStyle, { position: 'absolute', right: 12, width: leftWidth, textAlign: 'right' }]}>{wavePhrase[0]}</Animated.Text>}
      </Animated.View>
      <AnimatedTouchable style={[styles.inlinePlayBtn, buttonStyle, { zIndex: 10 }]} onPress={onStartWave} activeOpacity={0.8}>
        <Ionicons name={isWaveActive ? "pause" : "play"} size={22} color="#1c1c1e" style={{ marginLeft: isWaveActive ? 0 : 1.5 }} />
      </AnimatedTouchable>
      <Animated.View style={rightSpacerStyle}>
        {rightWidth > 0 && <Animated.Text numberOfLines={1} style={[styles.sloganText, rightTextStyle, { position: 'absolute', left: 12, width: rightWidth, textAlign: 'left' }]}>{wavePhrase[1]}</Animated.Text>}
      </Animated.View>
    </View>
  );
};

// ─── Cards ───────────────────────────────────────────
const ItemCard = ({ item, onPress, index, isPlaylist, onLongPress }) => (
  <AnimatedTouchable
    entering={FadeInRight.delay(index * 60).duration(400)}
    style={styles.trackCard}
    activeOpacity={0.7}
    onPress={() => onPress(item)}
    onLongPress={() => onLongPress && onLongPress(item)}
  >
    <CoverImage source={item.coverArt} style={styles.trackCardImage} />
    <Text style={styles.trackCardTitle} numberOfLines={1}>{isPlaylist ? item.name : item.title}</Text>
    {!isPlaylist && <Text style={styles.trackCardArtist} numberOfLines={1}>Album</Text>}
  </AnimatedTouchable>
);

const LibraryTrackRow = ({ track, onPress, index, onPressEllipsis }) => (
  <AnimatedTouchable
    entering={FadeInDown.delay(index * 20).duration(350)}
    style={styles.libraryRow}
    activeOpacity={0.6}
    onPress={() => onPress(track)}
  >
    <CoverImage source={track.coverArt} style={styles.libraryRowImage} />
    <View style={styles.libraryRowInfo}>
      <Text style={styles.libraryRowTitle} numberOfLines={1}>{track.title}</Text>
      <Text style={styles.libraryRowArtist} numberOfLines={1}>{track.artist}</Text>
    </View>
    <TouchableOpacity 
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      onPress={() => onPressEllipsis && onPressEllipsis(track)}
    >
      <Ionicons name="ellipsis-horizontal" size={18} color="#555" />
    </TouchableOpacity>
  </AnimatedTouchable>
);

// ─── Main HomeScreen ───────────────────────────────────────────────
export default function HomeScreen({ 
  tracks, 
  isPlaying, 
  currentTrack, 
  onPlayTrack, 
  onStartWave, 
  navigation, 
  onAddToPlaylist,
  currentUser,
  onOpenAuthModal 
}) {
  const scrollViewRef = useRef(null);
  const [albums, setAlbums] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [wavePhrase] = useState(() => {
    const phrases = [["Let me", "do this"], ["Feel", "the vibe"], ["Play", "some magic"], ["Just", "listen"]];
    return phrases[Math.floor(Math.random() * phrases.length)];
  });

  const isWaveActive = isPlaying && currentTrack != null;

  const fetchLibrary = async () => {
    try {
      const [albsRes, plistsRes] = await Promise.all([
        authFetch('/api/albums'),
        authFetch('/api/playlists')
      ]);
      if (albsRes.ok) setAlbums(await albsRes.json());
      if (plistsRes.ok) setPlaylists(await plistsRes.json());
    } catch (e) {
      console.warn("Failed to fetch library", e);
    }
  };

  useEffect(() => {
    fetchLibrary();
  }, [currentUser]);

  const handleCreatePlaylist = () => {
    Alert.prompt(
      "New Playlist",
      "Enter playlist name",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Create", onPress: async (name) => {
            if (!name) return;
            try {
              const res = await authFetch('/api/playlists', {
                method: 'POST',
                body: { name }
              });
              if (res.ok) fetchLibrary();
            } catch (e) {
              Alert.alert("Error", "Failed to create playlist");
            }
        }}
      ]
    );
  };

  const handlePlaylistLongPress = (playlist) => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ['Cancel', 'Edit', 'Delete Playlist'],
        destructiveButtonIndex: 2,
        cancelButtonIndex: 0,
        title: playlist.name,
      },
      async (buttonIndex) => {
        if (buttonIndex === 1) {
          // Edit
          Alert.prompt(
            "Edit Playlist",
            "Enter new name",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Save", onPress: async (name) => {
                  if (!name) return;
                  try {
                    const res = await authFetch(`/api/playlists/${playlist.id}`, {
                      method: 'PATCH',
                      body: { name }
                    });
                    if (res.ok) fetchLibrary();
                  } catch (e) {
                    Alert.alert("Error", "Failed to update playlist");
                  }
              }}
            ],
            'plain-text',
            playlist.name
          );
        } else if (buttonIndex === 2) {
          // Delete
          Alert.alert(
            "Delete Playlist?",
            `Are you sure you want to delete "${playlist.name}"?`,
            [
              { text: "Cancel", style: "cancel" },
              { text: "Delete", style: "destructive", onPress: async () => {
                  try {
                    const res = await authFetch(`/api/playlists/${playlist.id}`, {
                      method: 'DELETE'
                    });
                    if (res.ok) fetchLibrary();
                  } catch (e) {
                    Alert.alert("Error", "Failed to delete playlist");
                  }
              }}
            ]
          );
        }
      }
    );
  };

  const handleStartWave = useCallback(() => {
    if (onStartWave) onStartWave();
  }, [onStartWave]);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('PUUK_SCROLL_TO_TOP_HOME', () => {
      scrollViewRef.current?.scrollTo({ y: 0, animated: true });
    });
    return () => sub.remove();
  }, []);

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollViewRef}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: currentTrack ? 175 : 105 }
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Wave Card */}
        <Animated.View entering={FadeInDown.duration(600).springify()}>
          <TouchableOpacity activeOpacity={0.85} onPress={handleStartWave} style={styles.waveCardOuterNew}>
            <View style={styles.waveCardDark}>
              <View style={styles.waveBackgroundVisualizer}>
                <ContinuousWaveVisualizer isActive={isWaveActive || true} />
              </View>
              <BlurView intensity={95} tint="dark" style={[StyleSheet.absoluteFill, { margin: -20 }]} />
              <View style={styles.waveCardContentNew}>
                <AnimatedSlogan isWaveActive={isWaveActive} wavePhrase={wavePhrase} onStartWave={handleStartWave} />
              </View>
            </View>
          </TouchableOpacity>
        </Animated.View>

        {/* Playlists */}
        <Animated.View entering={FadeInDown.delay(100).duration(500)}>
          <SectionHeader title="Playlists" onPress={handleCreatePlaylist} buttonText="Create" />
          {playlists.length > 0 ? (
            <FlatList
              data={playlists}
              horizontal
              showsHorizontalScrollIndicator={false}
              keyExtractor={(item) => `pl-${item.id}`}
              contentContainerStyle={styles.horizontalList}
              renderItem={({ item, index }) => (
                <ItemCard item={item} onPress={() => navigation.navigate('Playlist', { playlistId: item.id, playlistName: item.name })} onLongPress={handlePlaylistLongPress} index={index} isPlaylist />
              )}
            />
          ) : (
            <Text style={styles.emptySectionText}>No playlists yet</Text>
          )}
        </Animated.View>

        {/* Albums */}
        <Animated.View entering={FadeInDown.delay(200).duration(500)}>
          <SectionHeader title="Albums" />
          {albums.length > 0 ? (
            <FlatList
              data={albums}
              horizontal
              showsHorizontalScrollIndicator={false}
              keyExtractor={(item) => `al-${item.id}`}
              contentContainerStyle={styles.horizontalList}
              renderItem={({ item, index }) => (
                <ItemCard item={item} onPress={() => navigation.navigate('Album', { albumId: item.id, albumTitle: item.title, coverArt: item.coverArt })} index={index} />
              )}
            />
          ) : (
            <Text style={styles.emptySectionText}>No albums found</Text>
          )}
        </Animated.View>

        {/* Tracks */}
        {tracks.length > 0 && (
          <Animated.View entering={FadeInDown.delay(300).duration(500)}>
            <SectionHeader title="All Tracks" />
            <View style={styles.libraryList}>
              {tracks.map((track, index) => (
                <LibraryTrackRow 
                  key={track.id} 
                  track={track} 
                  onPress={onPlayTrack} 
                  index={index} 
                  onPressEllipsis={onAddToPlaylist}
                />
              ))}
            </View>
          </Animated.View>
        )}

        <View style={{ height: 120 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  mainHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 10, paddingBottom: 15 },
  mainHeaderTitle: { fontSize: 34, fontWeight: 'bold', color: '#ffffff' },
  headerButton: { marginLeft: 20 },
  scrollContent: { paddingTop: 8 },
  waveCardOuterNew: { marginHorizontal: 16, marginBottom: 28, borderRadius: 24, shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.5, shadowRadius: 20, elevation: 12 },
  waveCardDark: { borderRadius: 24, backgroundColor: '#121214', overflow: 'hidden', minHeight: 180, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' },
  waveBackgroundVisualizer: { position: 'absolute', bottom: -10, left: -20, right: -20, alignItems: 'center', opacity: 0.75 },
  waveCardContentNew: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, minHeight: 180, zIndex: 2 },
  sloganContainer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  sloganText: { fontSize: 26, fontWeight: '800', color: '#fff', letterSpacing: -0.5 },
  inlinePlayBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#FFDAB9', justifyContent: 'center', alignItems: 'center', shadowColor: '#FFDAB9', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 8, elevation: 6, zIndex: 10 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingHorizontal: 20, marginBottom: 14 },
  sectionTitle: { fontSize: 22, fontWeight: '700', color: '#fff', letterSpacing: -0.3 },
  sectionSeeAll: { fontSize: 15, color: '#8e8e93', fontWeight: '500' },
  emptySectionText: { color: '#555', paddingHorizontal: 20, marginBottom: 20 },
  horizontalList: { paddingLeft: 20, paddingRight: 8, paddingBottom: 28 },
  trackCard: { width: 150, marginRight: 12 },
  trackCardImage: { width: 150, height: 150, borderRadius: 12, backgroundColor: '#1c1c1e', marginBottom: 8 },
  trackCardImagePlaceholder: { justifyContent: 'center', alignItems: 'center' },
  trackCardTitle: { fontSize: 14, fontWeight: '600', color: '#fff', marginBottom: 2 },
  trackCardArtist: { fontSize: 13, color: '#8e8e93', fontWeight: '400' },
  libraryList: { paddingHorizontal: 20 },
  libraryRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  libraryRowImage: { width: 48, height: 48, borderRadius: 8, backgroundColor: '#1c1c1e' },
  libraryRowImagePlaceholder: { justifyContent: 'center', alignItems: 'center' },
  libraryRowInfo: { flex: 1, marginLeft: 14, justifyContent: 'center' },
  libraryRowTitle: { fontSize: 16, fontWeight: '500', color: '#fff', marginBottom: 3 },
  libraryRowArtist: { fontSize: 14, color: '#8e8e93' },
  profileBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#161722',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#242636',
  },
  profileUsername: {
    color: '#FFF',
    fontSize: 13,
    fontWeight: '600',
    marginLeft: 6,
  },
});
