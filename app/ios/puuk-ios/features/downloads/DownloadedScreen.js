import React, { useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { removeOfflineCollection } from '../../offline/collections';
import { isOfflineSessionCurrent } from '../../offline';
import { getSettings } from '../../shared/storage/settings';
import useDownloaded from './useDownloaded';

export const formatBytes = (bytes) =>
  `${((bytes || 0) / 1024 ** 3).toFixed(2)} GiB`;
export function reasonText(reason, ru) {
  const messages = {
    queued: ['Queued', 'В очереди'],
    transferring: ['Downloading', 'Загрузка'],
    verifying: ['Verifying', 'Проверка'],
    failed: ['Download failed', 'Ошибка загрузки'],
    cancelled: ['Download cancelled', 'Загрузка отменена'],
    ready: ['Ready', 'Готово'],
    space: ['Waiting for space', 'Ожидание свободного места'],
    network: ['Waiting for network', 'Ожидание сети'],
    retry: ['Waiting to retry', 'Ожидание повторной попытки'],
    unsupported: [
      'Downloads are not supported in this build',
      'Загрузки не поддерживаются в этой сборке',
    ],
    unavailable: ['Currently unavailable', 'Сейчас недоступно'],
    'insufficient-candidates': [
      'Not enough recommendations',
      'Недостаточно рекомендаций',
    ],
  };
  return messages[reason]?.[ru ? 1 : 0] || '';
}
export default function DownloadedScreen({
  navigation,
  onPlayTrackList,
  onOpenAuthModal,
}) {
  const data = useDownloaded();
  const [busy, setBusy] = useState(null);
  const ru = getSettings().language === 'ru';
  const text = (en, russian) => (ru ? russian : en);
  const remove = async (item) => {
    setBusy(item.key.collectionId);
    try {
      const ok = await removeOfflineCollection(data.session, item.key);
      if (!ok && isOfflineSessionCurrent(data.session)) throw new Error();
    } catch (_) {
      Alert.alert(
        text('Could not remove download', 'Не удалось удалить загрузку'),
      );
    } finally {
      setBusy(null);
    }
  };
  return (
    <View style={s.container}>
      <ScrollView contentContainerStyle={s.content}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={text('Back', 'Назад')}
          onPress={() => navigation.goBack()}
          style={s.back}
        >
          <Ionicons name="chevron-back" size={24} color="#FFDAB9" />
        </TouchableOpacity>
        <Text accessibilityRole="header" style={s.heading}>
          {text('Downloaded', 'Скачанное')}
        </Text>
        {!data ? (
          <Text style={s.note}>
            {text(
              'Offline library is unavailable. Sign in to access downloads.',
              'Офлайн-библиотека недоступна. Войдите, чтобы открыть загрузки.',
            )}
          </Text>
        ) : (
          <>
            {data.downloadStatus === 'unsupported' && (
              <Text style={s.warning}>{reasonText('unsupported', ru)}</Text>
            )}
            {data.budget && (
              <Text style={s.note}>
                {text('On this device', 'На устройстве')}:{' '}
                {formatBytes(data.budget.usedBytes)} /{' '}
                {formatBytes(data.budget.limitBytes)}
              </Text>
            )}
            {data.budget?.overLimitBytes > 0 && (
              <Text style={s.warning}>
                {text(
                  'Over the limit. Remove selected downloads below or change the limit in settings.',
                  'Лимит превышен. Удалите выбранные загрузки ниже или измените лимит в настройках.',
                )}
              </Text>
            )}
            {data.wave && (
              <Text style={s.note}>
                {text('My Wave ready', 'Моя Волна готово')}:{' '}
                {Math.floor(data.wave.readyMinutes)} / {data.wave.targetMinutes}{' '}
                {text('min', 'мин')}
                {reasonText(data.wave.pauseReason, ru)
                  ? ` · ${reasonText(data.wave.pauseReason, ru)}`
                  : ''}
              </Text>
            )}
            {!!reasonText(data.budget?.pauseReason, ru) && (
              <Text style={s.warning}>
                {reasonText(data.budget.pauseReason, ru)}
              </Text>
            )}
            <TouchableOpacity
              accessibilityRole="button"
              onPress={onOpenAuthModal}
              style={s.control}
            >
              <Text style={s.action}>
                {text('Storage settings', 'Настройки памяти')}
              </Text>
            </TouchableOpacity>
            {data.collections.length === 0 && (
              <Text style={s.note}>
                {text(
                  'No downloads yet. Save an album or playlist to listen offline.',
                  'Пока нет загрузок. Сохраните альбом или плейлист для прослушивания без сети.',
                )}
              </Text>
            )}
            {data.collections.map((item) => {
              const favorites = item.key.kind === 'favorites';
              const title = favorites
                ? text('Favorites', 'Избранное')
                : item.title || text('Untitled', 'Без названия');
              const ready = item.tracks.filter(
                (_, i) => item.progress.tracks[i]?.state === 'ready',
              );
              const open = () =>
                favorites
                  ? navigation.navigate('Playlist', {
                      playlistId: 'favorites',
                      playlistName: title,
                    })
                  : item.key.kind === 'album'
                    ? navigation.navigate('Album', {
                        albumId: item.key.collectionId,
                        albumTitle: title,
                      })
                    : navigation.navigate('Playlist', {
                        playlistId: item.key.collectionId,
                        playlistName: title,
                      });
              return (
                <View
                  key={`${item.key.kind}:${item.key.collectionId}`}
                  style={s.card}
                >
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`${title}, ${item.progress.ready} / ${item.progress.total}`}
                    onPress={open}
                    style={s.control}
                  >
                    <Text style={s.title}>{title}</Text>
                    <Text style={s.note}>
                      {item.progress.ready} / {item.progress.total}{' '}
                      {text('ready', 'готово')}
                    </Text>
                  </TouchableOpacity>
                  {item.progress.total === 0 && (
                    <Text style={s.note}>
                      {text(
                        'No tracks in this collection.',
                        'В этой коллекции пока нет треков.',
                      )}
                    </Text>
                  )}
                  {item.progress.total > item.progress.ready && (
                    <Text style={s.note}>
                      {text(
                        'Some tracks are not ready yet.',
                        'Некоторые треки ещё не готовы.',
                      )}
                    </Text>
                  )}
                  {item.tracks.map((track, index) => {
                    const state =
                      item.progress.tracks[index]?.state || 'queued';
                    const status =
                      reasonText(state, ru) ||
                      text('Status unavailable', 'Статус недоступен');
                    const readyIndex = item.tracks
                      .slice(0, index)
                      .filter(
                        (_, i) => item.progress.tracks[i]?.state === 'ready',
                      ).length;
                    return state === 'ready' ? (
                      <TouchableOpacity
                        key={`${track.id}:${index}`}
                        accessibilityRole="button"
                        accessibilityLabel={`${text('Play', 'Воспроизвести')} ${track.title}, ${track.artist || ''}`}
                        onPress={() => onPlayTrackList(ready, readyIndex)}
                        style={s.track}
                      >
                        <Text style={s.title}>{track.title}</Text>
                        <Text style={s.note}>
                          {track.artist} · {status}
                        </Text>
                      </TouchableOpacity>
                    ) : (
                      <View
                        key={`${track.id}:${index}`}
                        accessible
                        accessibilityLabel={`${track.title}, ${track.artist || ''}, ${status}`}
                        style={s.track}
                      >
                        <Text style={s.title}>{track.title}</Text>
                        <Text style={s.note}>
                          {track.artist ? `${track.artist} · ` : ''}
                          {status}
                        </Text>
                      </View>
                    );
                  })}
                  {!favorites && (
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={`${text('Remove download', 'Удалить загрузку')}: ${title}`}
                      disabled={busy !== null}
                      onPress={() => remove(item)}
                      style={s.control}
                    >
                      <Text style={s.action}>
                        {busy === item.key.collectionId
                          ? text('Removing…', 'Удаление…')
                          : text('Remove from device', 'Удалить с устройства')}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
          </>
        )}
      </ScrollView>
    </View>
  );
}
const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  content: { paddingHorizontal: 20, paddingTop: 55, paddingBottom: 140 },
  back: {
    minHeight: 44,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    minWidth: 44,
  },
  heading: { fontSize: 28, fontWeight: '700', color: '#fff', marginBottom: 16 },
  card: {
    backgroundColor: '#111115',
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
  },
  control: { minHeight: 44, justifyContent: 'center' },
  track: {
    minHeight: 52,
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: '#444',
    paddingVertical: 8,
  },
  title: { color: '#fff', fontSize: 16, fontWeight: '600', flexShrink: 1 },
  note: { color: '#aaa', fontSize: 14, marginVertical: 4 },
  warning: { color: '#FFDAB9', fontSize: 14, marginVertical: 6 },
  action: { color: '#FFDAB9', fontSize: 15, fontWeight: '600' },
});
