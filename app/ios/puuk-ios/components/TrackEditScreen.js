import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  DeviceEventEmitter
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import CoverImage from './CoverImage';
import { authFetch, SERVER_URL } from '../utils/api';
import { getSettings, addSettingsListener } from '../utils/settings';

export default function TrackEditScreen({ route, navigation }) {
  const { track } = route.params;

  const [accentColor, setAccentColor] = useState(() => getSettings().accentColor || '#FFDAB9');

  // Track field states
  const [title, setTitle] = useState(track.title || '');
  const [artist, setArtist] = useState(track.artist || '');
  const [album, setAlbum] = useState(track.album || '');
  const [lyrics, setLyrics] = useState('');

  // Cover states
  const originalCover = track.coverArt || `${SERVER_URL}/api/cover/${track.id}`;
  const [coverPreview, setCoverPreview] = useState(originalCover);
  const [coverUrl, setCoverUrl] = useState(null);
  const [coverBase64, setCoverBase64] = useState(null);

  // Internet metadata search states
  const [metadataQuery, setMetadataQuery] = useState(`${track.artist || ''} ${track.title || ''}`.trim());
  const [isSearchingMetadata, setIsSearchingMetadata] = useState(false);
  const [metadataResults, setMetadataResults] = useState([]);

  // Lyrics search states
  const [lyricsQuery, setLyricsQuery] = useState(`${track.artist || ''} ${track.title || ''}`.trim());
  const [isSearchingLyrics, setIsSearchingLyrics] = useState(false);
  const [lyricsResults, setLyricsResults] = useState([]);

  // Saving state
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const unsub = addSettingsListener((s) => {
      if (s.accentColor) setAccentColor(s.accentColor);
    });
    return unsub;
  }, []);

  useEffect(() => {
    // Fetch fresh track details from server (album, lyrics, etc.)
    authFetch(`/api/tracks/${track.id}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) {
          if (data.title) setTitle(data.title);
          if (data.artist) setArtist(data.artist);
          if (data.album && data.album !== 'Unknown Album') setAlbum(data.album);
          if (data.lyrics) setLyrics(data.lyrics);
          if (data.coverArt) {
            // Append timestamp to avoid cached image if refreshed
            setCoverPreview(data.coverArt);
          }
        }
      })
      .catch(() => {});
  }, [track.id]);

  // Pick cover from photo library ("добавить обложку сам")
  const handlePickImage = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          'Permission Required',
          'Please allow access to your photo library to choose a cover image.'
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.85,
        base64: true,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
        setCoverPreview(asset.uri);
        setCoverBase64(asset.base64 ? `data:image/jpeg;base64,${asset.base64}` : null);
        setCoverUrl(null);
      }
    } catch (e) {
      console.warn('Image picker error:', e);
      Alert.alert('Error', 'Failed to pick image from photo library');
    }
  };

  // Revert cover to original
  const handleRevertCover = () => {
    setCoverPreview(originalCover);
    setCoverUrl(null);
    setCoverBase64(null);
  };

  // Search metadata from internet (iTunes / Deezer)
  const handleSearchMetadata = async () => {
    const q = metadataQuery.trim();
    if (!q) {
      Alert.alert('Empty query', 'Please enter track title or artist to search');
      return;
    }
    setIsSearchingMetadata(true);
    try {
      const res = await authFetch(`/api/metadata/search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data = await res.json();
        setMetadataResults(data);
        if (!data || data.length === 0) {
          Alert.alert('Not Found', 'No metadata matches found for this query');
        }
      } else {
        Alert.alert('Error', 'Failed to search metadata from internet');
      }
    } catch (e) {
      Alert.alert('Error', 'Network error while searching metadata');
    } finally {
      setIsSearchingMetadata(false);
    }
  };

  // Apply downloaded metadata result
  const handleApplyMetadata = (result) => {
    if (result.title) setTitle(result.title);
    if (result.artist) setArtist(result.artist);
    if (result.album) setAlbum(result.album);
    if (result.cover_url) {
      setCoverPreview(result.cover_url);
      setCoverUrl(result.cover_url);
      setCoverBase64(null);
    }
    const combined = `${result.artist || ''} ${result.title || ''}`.trim();
    if (combined) {
      setLyricsQuery(combined);
    }
    setMetadataResults([]);
  };

  // Search lyrics from LRCLIB
  const handleSearchLyrics = async () => {
    const q = lyricsQuery.trim();
    if (!q) return;
    setIsSearchingLyrics(true);
    try {
      const res = await authFetch(`/api/lyrics/search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data = await res.json();
        setLyricsResults(data || []);
      }
    } catch (e) {
      Alert.alert('Error', 'Failed to search lyrics');
    } finally {
      setIsSearchingLyrics(false);
    }
  };

  // Apply chosen lyric
  const handleSelectLyric = (result) => {
    const best = result.syncedLyrics || result.plainLyrics || '';
    setLyrics(best);
    setLyricsResults([]);
  };

  // Save all changes
  const handleSave = async () => {
    if (!title.trim()) {
      Alert.alert('Error', 'Track title cannot be empty');
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        title: title.trim(),
        artist: artist.trim(),
        album: album.trim() || 'Unknown Album',
        lyrics: lyrics || '',
        cover_url: coverUrl,
        cover_base64: coverBase64,
      };

      const res = await authFetch(`/api/tracks/${track.id}`, {
        method: 'PATCH',
        body: payload
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || 'Failed to update track');
      }

      // Notify rest of the app about update
      DeviceEventEmitter.emit('PUUK_TRACK_UPDATED', {
        id: track.id,
        title: title.trim(),
        artist: artist.trim(),
        album: album.trim() || 'Unknown Album',
        coverArt: coverPreview,
      });

      Alert.alert('Success', 'Track metadata and cover updated successfully', [
        { text: 'OK', onPress: () => navigation.goBack() }
      ]);
    } catch (e) {
      Alert.alert('Error', e.message);
    } finally {
      setIsSaving(false);
    }
  };

  const hasCustomCover = !!(coverUrl || coverBase64);

  return (
    <KeyboardAvoidingView 
      style={styles.container} 
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={28} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Edit Track</Text>
      </View>

      <ScrollView 
        contentContainerStyle={styles.scrollContent} 
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* ─── Cover Art Section ─── */}
        <View style={styles.coverSection}>
          <TouchableOpacity 
            style={styles.coverImageWrapper} 
            activeOpacity={0.85} 
            onPress={handlePickImage}
          >
            <CoverImage source={coverPreview} style={styles.coverImage} />
            <View style={styles.coverOverlayBadge}>
              <Ionicons name="camera" size={18} color="#fff" />
            </View>
          </TouchableOpacity>

          <View style={styles.coverActionsRow}>
            <TouchableOpacity 
              style={[styles.coverActionButton, { borderColor: accentColor }]}
              onPress={handlePickImage}
              activeOpacity={0.7}
            >
              <Ionicons name="image-outline" size={16} color={accentColor} style={{ marginRight: 6 }} />
              <Text style={[styles.coverActionText, { color: accentColor }]}>Choose Photo</Text>
            </TouchableOpacity>

            {hasCustomCover && (
              <TouchableOpacity 
                style={styles.coverRevertButton}
                onPress={handleRevertCover}
                activeOpacity={0.7}
              >
                <Ionicons name="reload-outline" size={16} color="#8E8E93" style={{ marginRight: 4 }} />
                <Text style={styles.coverRevertText}>Reset</Text>
              </TouchableOpacity>
            )}
          </View>

          {hasCustomCover && (
            <Text style={[styles.coverStatusText, { color: accentColor }]}>
              • New cover ready to save
            </Text>
          )}
        </View>

        {/* ─── Auto-fill Metadata from Internet ─── */}
        <View style={styles.cardSection}>
          <View style={styles.sectionHeaderRow}>
            <Ionicons name="globe-outline" size={18} color={accentColor} style={{ marginRight: 6 }} />
            <Text style={styles.sectionTitle}>Auto-fill from Internet</Text>
          </View>
          <Text style={styles.sectionSubtitle}>
            Fetch title, artist, album, and high-res cover art from iTunes & Deezer
          </Text>

          <View style={styles.searchRow}>
            <TextInput
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
              value={metadataQuery}
              onChangeText={setMetadataQuery}
              placeholder="Artist or Track name..."
              placeholderTextColor="#666"
              autoCorrect={false}
            />
            <TouchableOpacity 
              style={[styles.searchButton, { backgroundColor: accentColor }]} 
              onPress={handleSearchMetadata} 
              disabled={isSearchingMetadata}
              activeOpacity={0.8}
            >
              {isSearchingMetadata ? (
                <ActivityIndicator color="#1c1c1e" size="small" />
              ) : (
                <Ionicons name="search" size={20} color="#1c1c1e" />
              )}
            </TouchableOpacity>
          </View>

          {metadataResults.length > 0 && (
            <View style={styles.resultsContainer}>
              <View style={styles.resultsHeader}>
                <Text style={styles.resultsCountText}>Found {metadataResults.length} matches:</Text>
                <TouchableOpacity onPress={() => setMetadataResults([])}>
                  <Text style={styles.closeResultsText}>Close</Text>
                </TouchableOpacity>
              </View>

              {metadataResults.map((res, idx) => (
                <TouchableOpacity 
                  key={`meta-${idx}`} 
                  style={styles.metadataResultItem} 
                  activeOpacity={0.7}
                  onPress={() => handleApplyMetadata(res)}
                >
                  <CoverImage source={res.cover_url} style={styles.resultThumb} />
                  <View style={styles.resultInfo}>
                    <Text style={styles.resultTitle} numberOfLines={1}>
                      {res.title}
                    </Text>
                    <Text style={styles.resultMeta} numberOfLines={1}>
                      {res.artist} {res.album ? `• ${res.album}` : ''} {res.year ? `(${res.year})` : ''}
                    </Text>
                  </View>
                  <View style={[styles.applyBadge, { backgroundColor: accentColor }]}>
                    <Text style={styles.applyBadgeText}>Apply</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* ─── Track Fields ─── */}
        <View style={styles.fieldsContainer}>
          <Text style={styles.label}>Track Title</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="Track title"
            placeholderTextColor="#666"
          />

          <Text style={styles.label}>Artist</Text>
          <TextInput
            style={styles.input}
            value={artist}
            onChangeText={setArtist}
            placeholder="Artist name"
            placeholderTextColor="#666"
          />

          <Text style={styles.label}>Album</Text>
          <TextInput
            style={styles.input}
            value={album}
            onChangeText={setAlbum}
            placeholder="Album name"
            placeholderTextColor="#666"
          />
        </View>

        {/* ─── Lyrics Section ─── */}
        <View style={styles.cardSection}>
          <View style={styles.sectionHeaderRow}>
            <Ionicons name="musical-notes-outline" size={18} color={accentColor} style={{ marginRight: 6 }} />
            <Text style={styles.sectionTitle}>Lyrics (LRCLIB)</Text>
          </View>

          <View style={styles.searchRow}>
            <TextInput
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
              value={lyricsQuery}
              onChangeText={setLyricsQuery}
              placeholder="Search lyrics query..."
              placeholderTextColor="#666"
              autoCorrect={false}
            />
            <TouchableOpacity 
              style={[styles.searchButton, { backgroundColor: accentColor }]} 
              onPress={handleSearchLyrics} 
              disabled={isSearchingLyrics}
              activeOpacity={0.8}
            >
              {isSearchingLyrics ? (
                <ActivityIndicator color="#1c1c1e" size="small" />
              ) : (
                <Ionicons name="search" size={20} color="#1c1c1e" />
              )}
            </TouchableOpacity>
          </View>

          {lyricsResults.length > 0 && (
            <View style={styles.resultsContainer}>
              {lyricsResults.slice(0, 5).map((res, idx) => (
                <TouchableOpacity 
                  key={`lyric-${idx}`} 
                  style={styles.resultItem} 
                  onPress={() => handleSelectLyric(res)}
                >
                  <Text style={styles.resultTitle}>{res.trackName} - {res.artistName}</Text>
                  <Text style={styles.resultMeta}>
                    [{res.syncedLyrics ? 'SYNCED' : 'PLAIN'}] {res.albumName}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <Text style={[styles.label, { marginTop: 14 }]}>Lyrics text (LRC or Plain)</Text>
          <TextInput
            style={styles.textArea}
            value={lyrics}
            onChangeText={setLyrics}
            multiline
            placeholder="No lyrics saved yet..."
            placeholderTextColor="#666"
            textAlignVertical="top"
          />
        </View>

        {/* ─── Save Button ─── */}
        <TouchableOpacity 
          style={[styles.saveButton, { backgroundColor: accentColor }]} 
          onPress={handleSave} 
          disabled={isSaving}
          activeOpacity={0.85}
        >
          {isSaving ? (
            <ActivityIndicator color="#1c1c1e" size="small" />
          ) : (
            <Text style={styles.saveButtonText}>Save Changes</Text>
          )}
        </TouchableOpacity>

        <View style={{ height: 50 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#22222a',
  },
  backButton: {
    marginRight: 12,
  },
  headerTitle: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  scrollContent: {
    padding: 16,
  },
  coverSection: {
    alignItems: 'center',
    marginVertical: 12,
  },
  coverImageWrapper: {
    width: 150,
    height: 150,
    borderRadius: 16,
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#1c1c22',
    borderWidth: 1,
    borderColor: '#2a2a34',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
  },
  coverImage: {
    width: '100%',
    height: '100%',
  },
  coverOverlayBadge: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  coverActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    gap: 10,
  },
  coverActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: 1,
    backgroundColor: '#16161a',
  },
  coverActionText: {
    fontSize: 13,
    fontWeight: '600',
  },
  coverRevertButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: '#1c1c22',
  },
  coverRevertText: {
    color: '#8E8E93',
    fontSize: 13,
    fontWeight: '500',
  },
  coverStatusText: {
    fontSize: 12,
    marginTop: 8,
    fontWeight: '600',
  },
  cardSection: {
    backgroundColor: '#121216',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#202028',
    padding: 14,
    marginTop: 16,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sectionTitle: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  sectionSubtitle: {
    color: '#8E8E93',
    fontSize: 12,
    marginTop: 3,
    marginBottom: 12,
  },
  fieldsContainer: {
    marginTop: 8,
  },
  label: {
    color: '#8E8E93',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    backgroundColor: '#16161c',
    color: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#262630',
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  searchButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    marginLeft: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 44,
  },
  resultsContainer: {
    backgroundColor: '#16161c',
    borderRadius: 10,
    marginTop: 10,
    padding: 8,
    borderWidth: 1,
    borderColor: '#262630',
  },
  resultsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2a2a36',
  },
  resultsCountText: {
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '600',
  },
  closeResultsText: {
    color: '#8E8E93',
    fontSize: 12,
  },
  metadataResultItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#22222a',
  },
  resultThumb: {
    width: 42,
    height: 42,
    borderRadius: 6,
    backgroundColor: '#1c1c22',
    marginRight: 10,
  },
  resultInfo: {
    flex: 1,
  },
  resultTitle: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  resultMeta: {
    color: '#8E8E93',
    fontSize: 12,
    marginTop: 2,
  },
  applyBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    marginLeft: 8,
  },
  applyBadgeText: {
    color: '#1c1c1e',
    fontSize: 12,
    fontWeight: '700',
  },
  resultItem: {
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#22222a',
  },
  textArea: {
    backgroundColor: '#16161c',
    color: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#262630',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 13,
    height: 160,
    lineHeight: 18,
  },
  saveButton: {
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  saveButtonText: {
    color: '#1c1c1e',
    fontSize: 16,
    fontWeight: '700',
  },
});
