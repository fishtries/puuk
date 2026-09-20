import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import CoverImage from './CoverImage';

const SERVER_URL = 'http://192.168.1.117:8000';

export default function AlbumScreen({ route, navigation, onPlayTrack, onAddToPlaylist }) {
  const { albumId, albumTitle, coverArt } = route.params;
  const [tracks, setTracks] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchTracks = async () => {
      try {
        const response = await fetch(`${SERVER_URL}/api/albums/${albumId}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        setTracks(data);
      } catch (error) {
        console.error("Fetch album tracks error:", error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchTracks();
  }, [albumId]);

  const renderTrack = ({ item, index }) => (
    <TouchableOpacity
      style={styles.trackRow}
      activeOpacity={0.6}
      onPress={() => onPlayTrack(item)}
    >
      <Text style={styles.trackNumber}>{index + 1}</Text>
      <View style={styles.trackInfo}>
        <Text style={styles.trackTitle} numberOfLines={1}>{item.title}</Text>
        <Text style={styles.trackArtist} numberOfLines={1}>{item.artist}</Text>
      </View>
      <TouchableOpacity 
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        onPress={() => onAddToPlaylist && onAddToPlaylist(item)}
      >
        <Ionicons name="ellipsis-horizontal" size={18} color="#555" />
      </TouchableOpacity>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={28} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{albumTitle}</Text>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color="#6C3AED" size="large" />
        </View>
      ) : (
        <FlatList
          data={tracks}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <View style={styles.albumHeader}>
              <CoverImage source={coverArt} style={styles.coverImage} />
              <Text style={styles.albumTitleText}>{albumTitle}</Text>
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
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listContent: {
    paddingBottom: 20,
  },
  albumHeader: {
    alignItems: 'center',
    paddingVertical: 30,
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
    paddingHorizontal: 20,
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
