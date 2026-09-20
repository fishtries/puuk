import React, { useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';

const SERVER_URL = 'http://192.168.1.117:8000';

export default function AddToPlaylistModal({ visible, track, onClose }) {
  const [playlists, setPlaylists] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (visible) {
      fetchPlaylists();
    }
  }, [visible]);

  const fetchPlaylists = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`${SERVER_URL}/api/playlists`);
      if (response.ok) {
        setPlaylists(await response.json());
      }
    } catch (e) {
      console.warn("Fetch playlists error:", e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddToPlaylist = async (playlist) => {
    if (!track) return;
    try {
      const response = await fetch(`${SERVER_URL}/api/playlists/${playlist.id}/tracks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track_id: track.id })
      });
      const data = await response.json();
      if (data.status === 'already_exists') {
        Alert.alert("Notice", "Track is already in this playlist.");
      } else {
        Alert.alert("Success", "Track added to playlist!");
      }
      onClose();
    } catch (e) {
      Alert.alert("Error", "Failed to add track.");
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.title}>Add to Playlist</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>
          </View>

          {isLoading ? (
            <ActivityIndicator color="#6C3AED" style={{ marginTop: 20 }} />
          ) : (
            <FlatList
              data={playlists}
              keyExtractor={(item) => item.id.toString()}
              contentContainerStyle={styles.list}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.playlistRow}
                  onPress={() => handleAddToPlaylist(item)}
                >
                  <Ionicons name="list" size={24} color="#8e8e93" style={{ marginRight: 12 }} />
                  <Text style={styles.playlistName}>{item.name}</Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <Text style={styles.emptyText}>You have no playlists</Text>
              }
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  container: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    height: '60%',
    padding: 20,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#fff',
  },
  list: {
    paddingBottom: 20,
  },
  playlistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  playlistName: {
    fontSize: 16,
    color: '#fff',
  },
  emptyText: {
    color: '#8e8e93',
    textAlign: 'center',
    marginTop: 20,
  },
});
