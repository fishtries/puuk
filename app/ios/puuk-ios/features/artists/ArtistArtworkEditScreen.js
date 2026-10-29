import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  deleteArtistArtwork,
  updateArtistArtwork,
  getArtistArtworkUrl,
} from '../../shared/api/artists';
import CoverImage from '../../shared/media/CoverImage';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MiB per Contract 4.4
const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
];
const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

export default function ArtistArtworkEditScreen({
  route,
  navigation,
  currentUser,
}) {
  const { artistId, artist } = route?.params || {};
  const effectiveUser = currentUser ?? route?.params?.currentUser;

  const [currentArtworkUrl, setCurrentArtworkUrl] = useState(() => {
    if (artist?.artwork_url) return artist.artwork_url;
    if (artist?.artwork_version > 0 && artistId) {
      return getArtistArtworkUrl(artistId, artist.artwork_version);
    }
    return null;
  });
  const [currentArtworkVersion, setCurrentArtworkVersion] = useState(
    artist?.artwork_version || 0,
  );
  const [asset, setAsset] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [statusMessage, setStatusMessage] = useState(null);

  // Contract 6.1 / 6.3: UI entry condition for admins. Server authorization is the source of truth.
  const isAdmin = effectiveUser?.role === 'admin';
  if (!isAdmin) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Назад"
            style={styles.iconButton}
          >
            <Ionicons name="chevron-back" size={26} color="#fff" />
          </TouchableOpacity>
          <Text
            style={styles.headerTitle}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            Изображение артиста
          </Text>
          <View style={styles.iconButton} />
        </View>
        <View
          style={styles.adminRestrictedContainer}
          testID="admin-restricted-view"
        >
          <Ionicons name="lock-closed-outline" size={48} color="#8e8e93" />
          <Text style={styles.restrictedTitle}>Доступ ограничен</Text>
          <Text style={styles.restrictedText}>
            Редактирование изображения доступно только администраторам.
          </Text>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Вернуться назад"
          >
            <Text style={styles.actionButtonText}>Вернуться назад</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const validateAsset = (selectedAsset) => {
    if (!selectedAsset) {
      return 'Файл не выбран';
    }

    // Size validation: <= 5 MiB
    if (selectedAsset.fileSize && selectedAsset.fileSize > MAX_FILE_SIZE) {
      return 'Файл слишком большой. Максимальный размер 5 МБ.';
    }

    // Format validation: JPEG, PNG, WebP
    const mime = (selectedAsset.mimeType || '').toLowerCase();
    const ext = (selectedAsset.fileName || selectedAsset.uri || '')
      .split('.')
      .pop()
      ?.toLowerCase();

    if (mime && !ALLOWED_MIME_TYPES.includes(mime)) {
      return 'Неподдерживаемый формат файла. Разрешены JPEG, PNG и WebP.';
    }
    if (!mime && ext && !ALLOWED_EXTENSIONS.includes(ext)) {
      return 'Неподдерживаемый формат файла. Разрешены JPEG, PNG и WebP.';
    }

    return null;
  };

  const pickImage = async () => {
    setStatusMessage(null);
    try {
      const permission =
        await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        const errorText =
          'Разрешите доступ к медиатеке, чтобы выбрать изображение.';
        setStatusMessage({ type: 'error', text: errorText });
        Alert.alert('Нет доступа', errorText);
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.9,
      });

      if (result.canceled || !result.assets?.[0]) {
        return;
      }

      const selectedAsset = result.assets[0];
      const validationError = validateAsset(selectedAsset);
      if (validationError) {
        setStatusMessage({ type: 'error', text: validationError });
        Alert.alert('Ошибка валидации', validationError);
        return;
      }

      setAsset(selectedAsset);
      setStatusMessage(null);
    } catch (err) {
      const msg = err?.message || 'Не удалось выбрать изображение';
      setStatusMessage({ type: 'error', text: msg });
      Alert.alert('Ошибка', msg);
    }
  };

  const save = async () => {
    if (!asset?.uri || isSaving || isDeleting) return;
    setStatusMessage(null);

    const validationError = validateAsset(asset);
    if (validationError) {
      setStatusMessage({ type: 'error', text: validationError });
      Alert.alert('Ошибка валидации', validationError);
      return;
    }

    setIsSaving(true);
    try {
      // Contract 4.4: multipart upload with field 'file'
      const result = await updateArtistArtwork(artistId, {
        uri: asset.uri,
        name: asset.fileName || 'artist-artwork.jpg',
        type: asset.mimeType || 'image/jpeg',
      });

      // Contract 4.4 / 6.4: cache-busting via artwork_version from the API response
      const newVersion = result?.artwork_version ?? currentArtworkVersion + 1;
      const newUrl = getArtistArtworkUrl(artistId, newVersion);

      setCurrentArtworkVersion(newVersion);
      setCurrentArtworkUrl(newUrl);
      setAsset(null);
      setStatusMessage({
        type: 'success',
        text: 'Изображение успешно обновлено',
      });

      if (typeof route?.params?.onArtworkUpdated === 'function') {
        route.params.onArtworkUpdated({
          artwork_version: newVersion,
          artwork_url: newUrl,
        });
      }

      navigation.goBack();
    } catch (error) {
      let msg = error?.message || 'Не удалось сохранить изображение';
      if (error?.status === 413) {
        msg = 'Файл слишком большой. Максимальный размер 5 МБ.';
      } else if (error?.status === 415) {
        msg = 'Неподдерживаемый формат файла. Разрешены JPEG, PNG и WebP.';
      } else if (error?.status === 403) {
        msg = 'Недостаточно прав. Требуются права администратора.';
      } else if (error?.status === 404) {
        msg = 'Артист не найден.';
      }
      setStatusMessage({ type: 'error', text: msg });
      Alert.alert('Не удалось сохранить', msg);
    } finally {
      setIsSaving(false);
    }
  };

  const remove = () => {
    if (isSaving || isDeleting) return;
    Alert.alert(
      'Удалить изображение?',
      'Будет отображаться стандартный плейсхолдер.',
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Удалить',
          style: 'destructive',
          onPress: async () => {
            setIsDeleting(true);
            setStatusMessage(null);
            try {
              // Contract 4.4: DELETE /api/artists/{artist_id}/artwork
              await deleteArtistArtwork(artistId);
              setCurrentArtworkVersion(0);
              setCurrentArtworkUrl(null);
              setAsset(null);
              setStatusMessage({
                type: 'success',
                text: 'Изображение удалено',
              });

              if (typeof route?.params?.onArtworkUpdated === 'function') {
                route.params.onArtworkUpdated({
                  artwork_version: 0,
                  artwork_url: null,
                });
              }

              navigation.goBack();
            } catch (error) {
              let msg = error?.message || 'Не удалось удалить изображение';
              if (error?.status === 403) {
                msg = 'Недостаточно прав. Требуются права администратора.';
              } else if (error?.status === 404) {
                msg = 'Артист не найден.';
              }
              setStatusMessage({ type: 'error', text: msg });
              Alert.alert('Не удалось удалить', msg);
            } finally {
              setIsDeleting(false);
            }
          },
        },
      ],
    );
  };

  const busy = isSaving || isDeleting;
  const hasArtwork = Boolean(currentArtworkVersion > 0 || currentArtworkUrl);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Назад"
          style={styles.iconButton}
        >
          <Ionicons name="chevron-back" size={26} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1} ellipsizeMode="tail">
          {artist?.name ? `Изображение: ${artist.name}` : 'Изображение артиста'}
        </Text>
        <View style={styles.iconButton} />
      </View>

      <View style={styles.content}>
        {artist?.name ? (
          <Text
            style={styles.artistName}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {artist.name}
          </Text>
        ) : null}

        <View style={styles.previewFrame}>
          {asset?.uri ? (
            <Image
              source={{ uri: asset.uri }}
              style={styles.preview}
              testID="preview-local-image"
              accessibilityLabel="Выбранное изображение"
            />
          ) : currentArtworkUrl ? (
            <CoverImage
              source={currentArtworkUrl}
              style={styles.preview}
              testID="preview-server-artwork"
              accessibilityLabel="Текущее изображение артиста"
            />
          ) : (
            <View style={styles.placeholder} testID="preview-placeholder">
              <Ionicons name="person" size={52} color="#8e8e93" />
            </View>
          )}
        </View>

        {asset ? (
          <Text style={styles.selectedBadge} numberOfLines={1}>
            Выбрано новое изображение
          </Text>
        ) : null}

        {statusMessage ? (
          <View
            style={[
              styles.statusBanner,
              statusMessage.type === 'error'
                ? styles.errorBanner
                : styles.successBanner,
            ]}
            testID={
              statusMessage.type === 'error' ? 'error-banner' : 'success-banner'
            }
          >
            <Ionicons
              name={
                statusMessage.type === 'error'
                  ? 'alert-circle-outline'
                  : 'checkmark-circle-outline'
              }
              size={18}
              color={statusMessage.type === 'error' ? '#ff453a' : '#30d158'}
            />
            <Text
              style={[
                styles.statusText,
                statusMessage.type === 'error'
                  ? styles.errorText
                  : styles.successText,
              ]}
              numberOfLines={2}
            >
              {statusMessage.text}
            </Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={styles.action}
          onPress={pickImage}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={
            asset ? 'Выбрать другое фото' : 'Выбрать изображение'
          }
          testID="pick-image-button"
        >
          <Ionicons name="image-outline" size={20} color="#fff" />
          <Text style={styles.actionText}>
            {asset ? 'Выбрать другое фото' : 'Выбрать изображение'}
          </Text>
        </TouchableOpacity>

        {hasArtwork ? (
          <TouchableOpacity
            style={styles.removeAction}
            onPress={remove}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Удалить изображение"
            testID="remove-artwork-button"
          >
            {isDeleting ? (
              <ActivityIndicator color="#ff453a" size="small" />
            ) : (
              <Text style={styles.removeText}>Удалить изображение</Text>
            )}
          </TouchableOpacity>
        ) : null}

        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.saveButton, (!asset || busy) && styles.saveDisabled]}
            onPress={save}
            disabled={!asset || busy}
            accessibilityRole="button"
            accessibilityLabel="Сохранить"
            testID="save-artwork-button"
          >
            {isSaving ? (
              <View style={styles.savingRow}>
                <ActivityIndicator color="#111" size="small" />
                <Text style={styles.saveText}>Сохранение...</Text>
              </View>
            ) : (
              <Text style={styles.saveText}>Сохранить</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  header: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#29292b',
  },
  iconButton: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  content: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 24,
  },
  artistName: {
    color: '#8e8e93',
    fontSize: 15,
    fontWeight: '500',
    marginBottom: 16,
    textAlign: 'center',
    maxWidth: '90%',
  },
  previewFrame: {
    width: 240,
    maxWidth: '100%',
    aspectRatio: 1,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#1c1c1e',
  },
  preview: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedBadge: {
    marginTop: 10,
    color: '#8e8e93',
    fontSize: 13,
  },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    maxWidth: '100%',
  },
  errorBanner: {
    backgroundColor: 'rgba(255, 69, 58, 0.15)',
  },
  successBanner: {
    backgroundColor: 'rgba(48, 209, 88, 0.15)',
  },
  statusText: {
    fontSize: 13,
    flex: 1,
  },
  errorText: {
    color: '#ff453a',
  },
  successText: {
    color: '#30d158',
  },
  action: {
    marginTop: 20,
    minHeight: 48,
    paddingHorizontal: 18,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#252527',
    borderRadius: 8,
  },
  actionText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  removeAction: {
    marginTop: 16,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  removeText: {
    color: '#ff453a',
    fontSize: 15,
    fontWeight: '500',
  },
  footer: {
    flex: 1,
    width: '100%',
    justifyContent: 'flex-end',
    paddingBottom: 16,
  },
  saveButton: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f2f2f7',
    borderRadius: 8,
  },
  saveDisabled: {
    opacity: 0.45,
  },
  savingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  saveText: {
    color: '#111',
    fontSize: 16,
    fontWeight: '700',
  },
  adminRestrictedContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  restrictedTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    marginTop: 8,
  },
  restrictedText: {
    color: '#8e8e93',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  actionButton: {
    marginTop: 16,
    backgroundColor: '#252527',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
