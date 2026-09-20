import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { authFetch, SERVER_URL } from '../utils/api';
import { getSettings, addSettingsListener } from '../utils/settings';
import CoverImage from './CoverImage';

export default function PlaylistScreen({ route, navigation, onPlayTrack }) {
  const { playlistId, playlistName } = route.params;
  const isFavorites = playlistId === 'favorites';
  const [tracks, setTracks] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [accentColor, setAccentColor] = useState(() => getSettings().accentColor || '#FFDAB9');

  useEffect(() => {
    const unsub = addSettingsListener((s) => {
      if (s.accentColor) setAccentColor(s.accentColor);
    });
    return unsub;
  }, []);

  useEffect(() => {
    fetchPlaylist();
  }, [playlistId]);

  const fetchPlaylist = async () => {
    setIsLoading(true);
    try {
      if (isFavorites) {
        const response = await authFetch('/api/favorites');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        setTracks(data || []);
      } else {
        const response = await authFetch(`/api/playlists/${playlistId}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        setTracks(data.tracks || []);
      }
    } catch (error) {
      console.error("Fetch playlist tracks error:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveTrack = async (trackId) => {
    Alert.alert(
      isFavorites ? "Remove Favorite" : "Remove Track",
      isFavorites
        ? "Remove this track from your favorites?"
        : "Are you sure you want to remove this track from the playlist?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            try {
              if (isFavorites) {
                await authFetch(`/api/tracks/${trackId}/like`, {
                  method: 'DELETE'
                });
              } else {
                await authFetch(`/api/playlists/${playlistId}/tracks/${trackId}`, {
                  method: 'DELETE',
                });
              }
              setTracks(prev => prev.filter(t => t.id !== trackId));
            } catch (e) {
              console.error("Remove track error", e);
            }
          }
        }
      ]
    );
  };

  const renderTrack = ({ item, index }) => (
    <TouchableOpacity
      style={styles.trackRow}
      activeOpacity={0.6}
      onPress={() => onPlayTrack(item)}
    >
      <Text style={styles.trackNumber}>{index + 1}</Text>
      {item.coverArt && (
        <CoverImage source={item.coverArt} style={styles.trackThumb} />
      )}
      <View style={styles.trackInfo}>
        <Text style={styles.trackTitle} numberOfLines={1}>{item.title}</Text>
        <Text style={styles.trackArtist} numberOfLines={1}>{item.artist}</Text>
      </View>
      <TouchableOpacity 
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        onPress={() => handleRemoveTrack(item.id)}
      >
        <Ionicons name="trash-outline" size={18} color="#ff453a" />
      </TouchableOpacity>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={28} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{playlistName}</Text>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={accentColor} size="large" />
        </View>
      ) : (
        <FlatList
          data={tracks}
          keyExtractor={(item, idx) => `${item.id}-${idx}`}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <View style={styles.playlistHeader}>
              <View style={[styles.coverImage, styles.coverPlaceholder, isFavorites && styles.favoritesCoverPlaceholder]}>
                <Ionicons
                  name={isFavorites ? "heart" : "list"}
                  size={52}
                  color={isFavorites ? accentColor : "#555"}
                />
              </View>
              <Text style={styles.playlistTitleText}>{playlistName}</Text>
              <Text style={styles.playlistSubtitleText}>
                {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'}
              </Text>
            </View>
          }
          renderItem={renderTrack}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>
                {isFavorites ? 'No favorite tracks yet' : 'No tracks in this playlist yet'}
              </Text>
            </View>
          }
          ListFooterComponent={<View style={{ height: 120 }} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1c1c1e',
  },
  backButton: {
    marginRight: 16,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#fff',
    flex: 1,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listContent: {
    paddingBottom: 20,
  },
  playlistHeader: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  coverImage: {
    width: 180,
    height: 180,
    borderRadius: 14,
    backgroundColor: '#1c1c1e',
    marginBottom: 16,
  },
  coverPlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  favoritesCoverPlaceholder: {
    backgroundColor: '#1c1917',
    borderWidth: 1,
    borderColor: 'rgba(255, 218, 185, 0.18)',
  },
  playlistTitleText: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
    textAlign: 'center',
    paddingHorizontal: 20,
    marginBottom: 4,
  },
  playlistSubtitleText: {
    fontSize: 14,
    color: '#8E8E93',
  },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  trackNumber: {
    fontSize: 15,
    color: '#8e8e93',
    width: 26,
  },
  trackThumb: {
    width: 40,
    height: 40,
    borderRadius: 6,
    marginRight: 12,
    backgroundColor: '#1c1c22',
  },
  trackInfo: {
    flex: 1,
    marginRight: 16,
  },
  trackTitle: {
    fontSize: 15,
    color: '#fff',
    fontWeight: '500',
    marginBottom: 3,
  },
  trackArtist: {
    fontSize: 13,
    color: '#8e8e93',
  },
  emptyState: {
    paddingTop: 50,
    alignItems: 'center',
  },
  emptyStateText: {
    color: '#8e8e93',
    fontSize: 16,
  },
});
