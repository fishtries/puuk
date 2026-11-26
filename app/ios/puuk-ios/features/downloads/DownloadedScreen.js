import React, { useMemo, useState } from 'react';
import {
  Alert,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useIsFocused } from '@react-navigation/native';
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
  isCovered = false,
}) {
  const focused = useIsFocused();
  const data = useDownloaded(focused && !isCovered);
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
  const sections = useMemo(
    () =>
      (data?.collections || []).map((collection) => {
        const ready = [];
        const readyIndexes = collection.tracks.map((track, index) => {
          if (collection.progress.tracks[index]?.state !== 'ready') return -1;
          ready.push(track);
          return ready.length - 1;
        });
        return {
          key: `${collection.key.kind}:${collection.key.collectionId}`,
          collection,
          data: collection.tracks,
          ready,
          readyIndexes,
        };
      }),
    [data?.collections],
  );

  const collectionTitle = (item) =>
    item.key.kind === 'favorites'
      ? text('Favorites', 'Избранное')
      : item.title || text('Untitled', 'Без названия');
  const header = (
    <>
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
            onPress={() => navigation.navigate('OfflineSettings')}
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
        </>
      )}
    </>
  );
  return (
    <View style={s.container}>
      <SectionList
        sections={sections}
        keyExtractor={(track, index) => `${track.id}:${index}`}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={s.content}
        ListHeaderComponent={header}
        renderSectionHeader={({ section: { collection } }) => {
          const { key, progress } = collection;
          const title = collectionTitle(collection);
          const open = () =>
            key.kind === 'album'
              ? navigation.navigate('Album', {
                  albumId: key.collectionId,
                  albumTitle: title,
                })
              : navigation.navigate('Playlist', {
                  playlistId:
                    key.kind === 'favorites' ? 'favorites' : key.collectionId,
                  playlistName: title,
                });
          return (
            <View style={[s.card, s.cardHeader]}>
              <TouchableOpacity
                accessibilityRole="button"
                style={s.control}
                accessibilityLabel={`${title}, ${progress.ready} / ${progress.total}`}
                onPress={open}
              >
                <Text style={s.title}>{title}</Text>
                <Text style={s.note}>
                  {progress.ready} / {progress.total} {text('ready', 'готово')}
                </Text>
              </TouchableOpacity>
              {progress.total === 0 && (
                <Text style={s.note}>
                  {text(
                    'No tracks in this collection.',
                    'В этой коллекции пока нет треков.',
                  )}
                </Text>
              )}
              {progress.total > progress.ready && (
                <Text style={s.note}>
                  {text(
                    'Some tracks are not ready yet.',
                    'Некоторые треки ещё не готовы.',
                  )}
                </Text>
              )}
            </View>
          );
        }}
        renderItem={({ item: track, index, section }) => {
          const state =
            section.collection.progress.tracks[index]?.state || 'queued';
          const status =
            reasonText(state, ru) ||
            text('Status unavailable', 'Статус недоступен');
          const contents = (
            <>
              <Text style={s.title}>{track.title}</Text>
              <Text style={s.note}>
                {track.artist ? `${track.artist} · ` : ''}
                {status}
              </Text>
            </>
          );
          return (
            <View style={s.card}>
              {state === 'ready' ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  style={s.track}
                  accessibilityLabel={`${text('Play', 'Воспроизвести')} ${track.title}, ${track.artist || ''}`}
                  onPress={() =>
                    onPlayTrackList(section.ready, section.readyIndexes[index])
                  }
                >
                  {contents}
                </TouchableOpacity>
              ) : (
                <View
                  accessible
                  style={s.track}
                  accessibilityLabel={`${track.title}, ${track.artist || ''}, ${status}`}
                >
                  {contents}
                </View>
              )}
            </View>
          );
        }}
        renderSectionFooter={({ section: { collection } }) => (
          <View style={[s.card, s.cardFooter]}>
            {collection.key.kind !== 'favorites' && (
              <TouchableOpacity
                accessibilityRole="button"
                style={s.control}
                accessibilityLabel={`${text('Remove download', 'Удалить загрузку')}: ${collectionTitle(collection)}`}
                disabled={busy !== null}
                onPress={() => remove(collection)}
              >
                <Text style={s.action}>
                  {busy === collection.key.collectionId
                    ? text('Removing…', 'Удаление…')
                    : text('Remove from device', 'Удалить с устройства')}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      />
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
    paddingHorizontal: 14,
  },
  cardHeader: {
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    paddingTop: 14,
    marginTop: 12,
  },
  cardFooter: {
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    paddingBottom: 14,
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
