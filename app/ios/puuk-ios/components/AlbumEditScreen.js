import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  DeviceEventEmitter,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import CoverImage from './CoverImage';
import { authFetch } from '../utils/api';

export default function AlbumEditScreen({ route, navigation }) {
  const { albumId, album: initialAlbum } = route.params;

  const [title, setTitle] = useState(initialAlbum?.title || '');
  const [albumArtist, setAlbumArtist] = useState(
    initialAlbum?.album_artist || initialAlbum?.artist || ''
  );
  const [year, setYear] = useState(initialAlbum?.year ? String(initialAlbum.year) : '');

  const [coverAction, setCoverAction] = useState('keep');
  const [coverPreview, setCoverPreview] = useState(initialAlbum?.coverArt || null);
  const [coverBase64, setCoverBase64] = useState(null);

  const [trackCount, setTrackCount] = useState(initialAlbum?.track_count || 0);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    authFetch(`/api/albums/${albumId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || !data.album) return;
        const a = data.album;
        setTitle(a.title || '');
        setAlbumArtist(a.album_artist || a.artist || '');
        setYear(a.year ? String(a.year) : '');
        setCoverPreview(a.coverArt || null);
        setTrackCount(a.track_count || (data.tracks ? data.tracks.length : 0));
      })
      .catch(() => {});
  }, [albumId]);

  const handlePickCover = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission Required', 'Allow access to your photo library to choose a cover.');
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
      setCoverAction('replace');
    }
  };

  const handleRemoveCover = () => {
    setCoverBase64(null);
    setCoverPreview(null);
    setCoverAction(coverAction === 'remove' ? 'keep' : 'remove');
  };

  const handleSave = async () => {
    if (!title.trim()) {
      Alert.alert('Error', 'Album title cannot be empty');
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        title: title.trim(),
        album_artist: albumArtist.trim(),
        year: year.trim() || null,
        cover_action: coverAction,
        cover_base64: coverAction === 'replace' ? coverBase64 : null,
      };

      const res = await authFetch(`/api/albums/${albumId}`, { method: 'PATCH', body: payload });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || 'Failed to update album');
      }

      const result = await res.json();
      DeviceEventEmitter.emit('PUUK_ALBUM_UPDATED', {
        previousAlbumId: Number(albumId),
        album: result.album,
      });

      if (result.status === 'partial') {
        Alert.alert(
          'Частично сохранено',
          `Не удалось обновить ${result.failed_tracks?.length || 0} трек(ов).`,
          [{ text: 'OK', onPress: () => navigation.goBack() }]
        );
      } else {
        Alert.alert('Готово', result.merged ? 'Альбомы объединены' : 'Альбом обновлён', [
          { text: 'OK', onPress: () => navigation.goBack() },
        ]);
      }
    } catch (e) {
      Alert.alert('Error', e.message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={28} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Edit Album</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.warningBox}>
          <Ionicons name="information-circle-outline" size={16} color="#FFDAB9" />
          <Text style={styles.warningText}>
            Изменения будут записаны в теги всех {trackCount || ''} трек(ов) этого альбома.
          </Text>
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Название альбома</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="Album title"
            placeholderTextColor="#555"
          />
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Исполнитель альбома</Text>
          <TextInput
            style={styles.input}
            value={albumArtist}
            onChangeText={setAlbumArtist}
            placeholder="Daft Punk / Various Artists"
            placeholderTextColor="#555"
          />
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Год</Text>
          <TextInput
            style={styles.input}
            value={year}
            onChangeText={setYear}
            placeholder="1997"
            placeholderTextColor="#555"
            keyboardType="numbers-and-punctuation"
          />
        </View>

        <View style={styles.coverSection}>
          <TouchableOpacity style={styles.coverWrapper} activeOpacity={0.85} onPress={handlePickCover}>
            {coverPreview ? (
              <CoverImage source={coverPreview} style={styles.coverImage} />
            ) : (
              <View style={styles.coverPlaceholder}>
                <Ionicons name="image-outline" size={32} color="#555" />
              </View>
            )}
          </TouchableOpacity>

          <View style={styles.coverButtons}>
            <TouchableOpacity style={styles.coverBtn} onPress={handlePickCover}>
              <Ionicons name="image-outline" size={16} color="#fff" />
              <Text style={styles.coverBtnText}>Выбрать</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.coverBtn} onPress={handleRemoveCover}>
              <Ionicons name="trash-outline" size={16} color="#ff6b6b" />
              <Text style={[styles.coverBtnText, { color: '#ff6b6b' }]}>Удалить</Text>
            </TouchableOpacity>
          </View>
        </View>

        <TouchableOpacity
          style={[styles.saveButton, isSaving && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={isSaving}
        >
          {isSaving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.saveButtonText}>Сохранить альбом</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1c1c1e',
  },
  backButton: { marginRight: 16 },
  headerTitle: { fontSize: 20, fontWeight: 'bold', color: '#fff', flex: 1 },
  scrollContent: { padding: 20, gap: 18, paddingBottom: 80 },
  warningBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#141414',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#262626',
  },
  warningText: { color: '#b0b0b0', fontSize: 13, flex: 1, lineHeight: 18 },
  fieldGroup: { gap: 8 },
  label: { color: '#8e8e93', fontSize: 13, fontWeight: '600' },
  input: {
    height: 46,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: '#141414',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#262626',
    color: '#fff',
    fontSize: 15,
  },
  coverSection: { alignItems: 'center', gap: 16, marginTop: 8 },
  coverWrapper: {
    width: 200,
    height: 200,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#1c1c1e',
  },
  coverImage: { width: '100%', height: '100%' },
  coverPlaceholder: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  coverButtons: { flexDirection: 'row', gap: 12 },
  coverBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#141414',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#262626',
  },
  coverBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  saveButton: {
    height: 50,
    borderRadius: 12,
    backgroundColor: '#6C3AED',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  saveButtonDisabled: { opacity: 0.6 },
  saveButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
