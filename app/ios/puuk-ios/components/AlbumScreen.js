import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import CoverImage from './CoverImage';
import { authFetch } from '../utils/api';

export default function AlbumScreen({ route, navigation, onPlayTrack, onPressEllipsis }) {
  const { albumId, albumTitle, coverArt } = route.params;
  const [album, setAlbum] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState(null);

  const fetchAlbum = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const response = await authFetch(`/api/albums/${albumId}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setAlbum(data.album || null);
      setTracks(Array.isArray(data.tracks) ? data.tracks : []);
    } catch (error) {
      console.error('Fetch album detail error:', error);
      setErrorMessage('Не удалось загрузить альбом');
    } finally {
      setIsLoading(false);
    }
  }, [albumId]);

  // Загрузка при открытии и обновление при возврате из редактора альбома.
  useFocusEffect(
    useCallback(() => {
      fetchAlbum();
    }, [fetchAlbum])
  );

  const renderTrack = ({ item, index }) => (
    <TouchableOpacity
      style={styles.trackRow}
      activeOpacity={0.6}
      onPress={() => onPlayTrack(item)}
    >
      <Text style={styles.trackNumber}>{item.track_number ? String(item.track_number).split('/')[0] : index + 1}</Text>
      <View style={styles.trackInfo}>
        <Text style={styles.trackTitle} numberOfLines={1}>{item.title}</Text>
        <Text style={styles.trackArtist} numberOfLines={1}>{item.artist}</Text>
      </View>
      <TouchableOpacity
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        onPress={() => onPressEllipsis && onPressEllipsis(item)}
      >
        <Ionicons name="ellipsis-horizontal" size={18} color="#555" />
      </TouchableOpacity>
    </TouchableOpacity>
  );

  const resolvedTitle = album?.title || albumTitle;
  const resolvedCover = album?.coverArt || coverArt;
  const metaParts = [];
  if (album?.album_artist || album?.artist) metaParts.push(album.album_artist || album.artist);
  if (album?.year) metaParts.push(String(album.year));
  if (album?.track_count) metaParts.push(`${album.track_count} трек(ов)`);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={28} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{resolvedTitle}</Text>
        <TouchableOpacity
          onPress={() => navigation.navigate('AlbumEdit', { albumId, album })}
          style={styles.editButton}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="create-outline" size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color="#6C3AED" size="large" />
        </View>
      ) : errorMessage ? (
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={32} color="#8e8e93" />
          <Text style={styles.stateText}>{errorMessage}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={fetchAlbum}>
            <Text style={styles.retryText}>Повторить</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={tracks}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <View style={styles.albumHeader}>
              <CoverImage source={resolvedCover} style={styles.coverImage} />
              <Text style={styles.albumTitleText}>{resolvedTitle}</Text>
              {metaParts.length > 0 && (
                <Text style={styles.albumMetaText}>{metaParts.join(' · ')}</Text>
              )}
            </View>
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.stateText}>В этом альбоме пока нет треков</Text>
            </View>
          }
          renderItem={renderTrack}
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
  editButton: {
    marginLeft: 12,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    gap: 12,
  },
  stateText: {
    color: '#8e8e93',
    fontSize: 15,
    textAlign: 'center',
  },
  retryButton: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#1c1c1e',
  },
  retryText: {
    color: '#fff',
    fontWeight: '600',
  },
  listContent: {
    paddingBottom: 20,
  },
  albumHeader: {
    alignItems: 'center',
    paddingVertical: 30,
    paddingHorizontal: 20,
  },
  coverImage: {
    width: 200,
    height: 200,
    borderRadius: 12,
    backgroundColor: '#1c1c1e',
    marginBottom: 20,
  },
  coverPlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  albumTitleText: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
    textAlign: 'center',
  },
  albumMetaText: {
    fontSize: 14,
    color: '#8e8e93',
    marginTop: 8,
    textAlign: 'center',
  },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  trackNumber: {
    fontSize: 16,
    color: '#8e8e93',
    width: 30,
  },
  trackInfo: {
    flex: 1,
    marginRight: 16,
  },
  trackTitle: {
    fontSize: 16,
    color: '#fff',
    fontWeight: '500',
    marginBottom: 4,
  },
  trackArtist: {
    fontSize: 14,
    color: '#8e8e93',
  },
});
