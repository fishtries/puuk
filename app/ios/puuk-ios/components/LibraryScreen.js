import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActionSheetIOS,
  RefreshControl,
  ActivityIndicator,
  DeviceEventEmitter
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  FadeInDown,
  FadeInRight,
  LinearTransition
} from 'react-native-reanimated';

import CoverImage from './CoverImage';
import { authFetch } from '../utils/api';
import { getSettings, addSettingsListener } from '../utils/settings';

const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

// Relative time formatting for history
function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffSec = Math.floor((now - date) / 1000);

    if (diffSec < 60) return 'Just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    if (diffSec < 172800) return 'Yesterday';
    return date.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
  } catch (e) {
    return '';
  }
}

export default function LibraryScreen({
  navigation,
  isPlaying,
  currentTrack,
  onPlayTrack,
  onPlayTrackList,
  onPressEllipsis,
  currentUser,
  onOpenAuthModal
}) {
  const [accentColor, setAccentColor] = useState(() => getSettings().accentColor || '#FFDAB9');
  const [favorites, setFavorites] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [history, setHistory] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const scrollViewRef = useRef(null);

  useEffect(() => {
    const unsub = addSettingsListener((s) => {
      if (s.accentColor) setAccentColor(s.accentColor);
    });
    return unsub;
  }, []);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('PUUK_SCROLL_TO_TOP_LIBRARY', () => {
      scrollViewRef.current?.scrollTo({ y: 0, animated: true });
    });
    return () => sub.remove();
  }, []);

  // Загрузка данных библиотеки (избранное, плейлисты, история)
  const fetchLibraryData = useCallback(async () => {
    try {
      const [favsRes, plsRes, histRes] = await Promise.all([
        authFetch('/api/favorites'),
        authFetch('/api/playlists'),
        authFetch('/api/history')
      ]);

      if (favsRes.ok) {
        const favsData = await favsRes.json();
        setFavorites(favsData);
      }
      if (plsRes.ok) {
        const plsData = await plsRes.json();
        setPlaylists(plsData);
      }
      if (histRes.ok) {
        const histData = await histRes.json();
        setHistory(histData);
      }
    } catch (err) {
      console.warn('Failed to load user library data:', err);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    setIsLoading(true);
    fetchLibraryData();
  }, [fetchLibraryData, currentUser]);

  const onRefresh = () => {
    setIsRefreshing(true);
    fetchLibraryData();
  };

  // Create new playlist
  const handleCreatePlaylist = useCallback(() => {
    Alert.prompt(
      'New Playlist',
      'Enter name for the new playlist',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Create',
          onPress: async (name) => {
            const trimmed = name?.trim();
            if (!trimmed) return;
            try {
              const res = await authFetch('/api/playlists', {
                method: 'POST',
                body: { name: trimmed }
              });
              if (res.ok) {
                fetchLibraryData();
              } else {
                Alert.alert('Error', 'Failed to create playlist');
              }
            } catch (e) {
              Alert.alert('Error', 'Network error while creating playlist');
            }
          }
        }
      ],
      'plain-text'
    );
  }, [fetchLibraryData]);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('PUUK_CREATE_PLAYLIST', handleCreatePlaylist);
    return () => sub.remove();
  }, [handleCreatePlaylist]);

  // Track deleted from library (TrackEditScreen): drop it from local lists
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('PUUK_TRACK_DELETED', ({ id }) => {
      setFavorites((prev) => prev.filter((t) => t.id !== id));
      setHistory((prev) => prev.filter((t) => t.id !== id));
    });
    return () => sub.remove();
  }, []);

  // Playlist management menu (rename, delete)
  const handlePlaylistLongPress = (playlist) => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ['Cancel', 'Rename', 'Delete Playlist'],
        destructiveButtonIndex: 2,
        cancelButtonIndex: 0,
        title: playlist.name
      },
      async (buttonIndex) => {
        if (buttonIndex === 1) {
          Alert.prompt(
            'Rename',
            'Enter new playlist name',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Save',
                onPress: async (newName) => {
                  const trimmed = newName?.trim();
                  if (!trimmed) return;
                  try {
                    const res = await authFetch(`/api/playlists/${playlist.id}`, {
                      method: 'PATCH',
                      body: { name: trimmed }
                    });
                    if (res.ok) fetchLibraryData();
                  } catch (e) {
                    Alert.alert('Error', 'Failed to update playlist');
                  }
                }
              }
            ],
            'plain-text',
            playlist.name
          );
        } else if (buttonIndex === 2) {
          Alert.alert(
            'Delete Playlist?',
            `Are you sure you want to delete "${playlist.name}"?`,
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: async () => {
                  try {
                    const res = await authFetch(`/api/playlists/${playlist.id}`, {
                      method: 'DELETE'
                    });
                    if (res.ok) fetchLibraryData();
                  } catch (e) {
                    Alert.alert('Error', 'Failed to delete playlist');
                  }
                }
              }
            ]
          );
        }
      }
    );
  };

  // Переключение лайка из библиотеки
  const handleToggleFavorite = async (track) => {
    const isCurrentlyLiked = favorites.some((t) => t.id === track.id);
    if (isCurrentlyLiked) {
      setFavorites((prev) => prev.filter((t) => t.id !== track.id));
      try {
        await authFetch(`/api/tracks/${track.id}/like`, { method: 'DELETE' });
      } catch (e) {
        console.warn('Failed to remove favorite:', e);
        fetchLibraryData();
      }
    } else {
      setFavorites((prev) => [track, ...prev]);
      try {
        await authFetch(`/api/tracks/${track.id}/like`, { method: 'POST' });
      } catch (e) {
        console.warn('Failed to add favorite:', e);
        fetchLibraryData();
      }
    }
  };

  // ─── Track Row Render ──────────────────────────────────────────
  const renderTrackItem = (track, index, showTime = false) => {
    const isCurrentPlaying = currentTrack?.id === track.id;
    const isLiked = favorites.some((f) => f.id === track.id);

    return (
      <AnimatedTouchable
        key={`${track.id}-${index}`}
        layout={LinearTransition.springify()}
        entering={FadeInDown.delay(index * 25).duration(300)}
        style={[
          styles.trackRow,
          isCurrentPlaying && {
            backgroundColor: '#1b1816',
            borderWidth: 1,
            borderColor: 'rgba(255, 218, 185, 0.25)'
          }
        ]}
        activeOpacity={0.65}
        onPress={() => onPlayTrack && onPlayTrack(track)}
      >
        <CoverImage source={track.coverArt} style={styles.trackImage} />

        <View style={styles.trackInfo}>
          <Text
            style={[
              styles.trackTitle,
              isCurrentPlaying && { color: accentColor }
            ]}
            numberOfLines={1}
          >
            {track.title}
          </Text>
          <View style={styles.trackMetaRow}>
            <Text style={styles.trackArtist} numberOfLines={1}>
              {track.artist}
            </Text>
            {showTime && track.played_at && (
              <Text style={styles.trackTimeAgo}>
                • {formatRelativeTime(track.played_at)}
              </Text>
            )}
          </View>
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
          hitSlop={{ top: 12, bottom: 12, left: 10, right: 10 }}
          onPress={() => handleToggleFavorite(track)}
          style={styles.trackLikeBtn}
        >
          <Ionicons
            name={isLiked ? 'heart' : 'heart-outline'}
            size={20}
            color={isLiked ? accentColor : '#555'}
          />
        </TouchableOpacity>

        <TouchableOpacity
          hitSlop={{ top: 12, bottom: 12, left: 10, right: 12 }}
          onPress={() => onPressEllipsis && onPressEllipsis(track)}
          style={styles.trackEllipsisBtn}
        >
          <Ionicons name="ellipsis-horizontal" size={18} color="#666" />
        </TouchableOpacity>
      </AnimatedTouchable>
    );
  };

  // ─── Playlist Card Render ────────────────────────────────────
  const renderPlaylistCard = (playlist, index) => (
    <AnimatedTouchable
      key={`pl-${playlist.id}-${index}`}
      entering={FadeInRight.delay((index + 2) * 40).duration(350)}
      style={styles.playlistCard}
      activeOpacity={0.7}
      onPress={() =>
        navigation.navigate('Playlist', {
          playlistId: playlist.id,
          playlistName: playlist.name
        })
      }
      onLongPress={() => handlePlaylistLongPress(playlist)}
    >
      <View style={styles.playlistCardCover}>
        <CoverImage source={playlist.coverArt} style={styles.playlistCardImage} />
        <View style={styles.playlistCardOverlayIcon}>
          <Ionicons name="musical-notes" size={20} color="#fff" />
        </View>
      </View>
      <Text style={styles.playlistCardTitle} numberOfLines={1}>
        {playlist.name}
      </Text>
      <Text style={styles.playlistCardSubtitle} numberOfLines={1}>
        {playlist.track_count ? `${playlist.track_count} ${playlist.track_count === 1 ? 'track' : 'tracks'}` : 'Playlist'}
      </Text>
    </AnimatedTouchable>
  );

  return (
    <View style={styles.container}>
      {isLoading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator color={accentColor} size="large" />
        </View>
      ) : (
        <ScrollView
          ref={scrollViewRef}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: currentTrack ? 175 : 105 }
          ]}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={onRefresh}
              tintColor={accentColor}
            />
          }
        >
          {/* ─── Section: Playlists ─── */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Playlists</Text>
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.horizontalScroll}
          >
            {/* 1. Create Playlist Card */}
            <TouchableOpacity
              style={styles.createPlaylistCard}
              activeOpacity={0.7}
              onPress={handleCreatePlaylist}
            >
              <View style={styles.createPlaylistDashed}>
                <Ionicons name="add" size={32} color={accentColor} />
              </View>
              <Text style={styles.createPlaylistText}>Create</Text>
            </TouchableOpacity>

            {/* 2. Favorites Playlist Card */}
            <AnimatedTouchable
              entering={FadeInRight.delay(40).duration(350)}
              style={styles.playlistCard}
              activeOpacity={0.7}
              onPress={() =>
                navigation.navigate('Playlist', {
                  playlistId: 'favorites',
                  playlistName: 'Favorites'
                })
              }
            >
              <View style={[styles.playlistCardCover, styles.favoritesCover]}>
                {favorites.length > 0 && favorites[0]?.coverArt ? (
                  <>
                    <CoverImage source={favorites[0].coverArt} style={styles.playlistCardImage} />
                    <View style={styles.favoritesBadge}>
                      <Ionicons name="heart" size={18} color={accentColor} />
                    </View>
                  </>
                ) : (
                  <View style={styles.favoritesPlaceholder}>
                    <Ionicons name="heart" size={42} color={accentColor} />
                  </View>
                )}
              </View>
              <Text style={styles.playlistCardTitle} numberOfLines={1}>
                Favorites
              </Text>
              <Text style={styles.playlistCardSubtitle} numberOfLines={1}>
                {favorites.length} {favorites.length === 1 ? 'track' : 'tracks'}
              </Text>
            </AnimatedTouchable>

            {/* 3. User Playlists */}
            {playlists.map((pl, idx) => renderPlaylistCard(pl, idx))}
          </ScrollView>

          {/* ─── Section: Recently Played ─── */}
          {history.length > 0 && (
            <View style={styles.historySection}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Recently Played</Text>
              </View>

              {history.map((track, idx) =>
                renderTrackItem(track, idx, true)
              )}
            </View>
          )}

          <View style={{ height: 120 }} />
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000'
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center'
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 12
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: -0.3
  },
  horizontalScroll: {
    gap: 14,
    paddingBottom: 6
  },
  createPlaylistCard: {
    width: 130,
    alignItems: 'center'
  },
  createPlaylistDashed: {
    width: 130,
    height: 130,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#32323a',
    borderStyle: 'dashed',
    backgroundColor: '#121216',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8
  },
  createPlaylistText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600'
  },
  playlistCard: {
    width: 130
  },
  playlistCardCover: {
    width: 130,
    height: 130,
    borderRadius: 14,
    backgroundColor: '#1c1c22',
    overflow: 'hidden',
    marginBottom: 8,
    position: 'relative'
  },
  playlistCardImage: {
    width: '100%',
    height: '100%'
  },
  playlistCardOverlayIcon: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    justifyContent: 'center',
    alignItems: 'center'
  },
  playlistCardTitle: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2
  },
  playlistCardSubtitle: {
    color: '#8E8E93',
    fontSize: 12
  },
  favoritesCover: {
    backgroundColor: '#1c1917',
    borderWidth: 1,
    borderColor: 'rgba(255, 218, 185, 0.15)'
  },
  favoritesPlaceholder: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#1c1917'
  },
  favoritesBadge: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 218, 185, 0.2)'
  },
  historySection: {
    marginTop: 26
  },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#111115',
    borderRadius: 12,
    marginBottom: 8
  },
  trackImage: {
    width: 46,
    height: 46,
    borderRadius: 8,
    backgroundColor: '#1c1c22',
    marginRight: 12
  },
  trackInfo: {
    flex: 1,
    justifyContent: 'center'
  },
  trackTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#ffffff',
    marginBottom: 3
  },
  trackMetaRow: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  trackArtist: {
    fontSize: 13,
    color: '#8E8E93'
  },
  trackTimeAgo: {
    fontSize: 12,
    color: '#666',
    marginLeft: 4
  },
  trackLikeBtn: {
    padding: 6
  },
  trackEllipsisBtn: {
    padding: 6
  }
});
