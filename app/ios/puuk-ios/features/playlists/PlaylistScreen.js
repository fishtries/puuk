import { saveRatingWithFeedback, showRatingError } from '../downloads/ratingFeedback';
import {
  saveOfflineCollection,
  removeOfflineCollection,
  isCollectionSaved,
  collectionProgress,
} from '../../offline/collections';
import { overlayFavorites } from '../../offline/collections/runtime';
import { getRatingOverlay, waitForOutboxDrain } from '../../offline/outbox/runtime';
import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { authFetch, SERVER_URL } from '../../shared/api/api';
import {
  getSettings,
  addSettingsListener,
} from '../../shared/storage/settings';
import {
  getTrackId,
  areTrackIdsEqual,
  normalizeTrack,
} from '../../shared/domain/trackAdapter';
import CoverImage from '../../shared/media/CoverImage';
import {
  FAVORITES_COLLECTION,
  getOfflineSession,
  isOfflineSessionCurrent,
  readCollection,
  readFavoriteDownloads,
  subscribeOfflineIndex,
} from '../../offline';
import { saveFavoriteOffline } from '../../offline/foreground';

export default function PlaylistScreen({
  route,
  navigation,
  onPlayTrackList,
  onPressEllipsis,
}) {
  const {
    playlistId,
    playlistName,
    tracks: initialTracks,
    subtitle: customSubtitle,
    coverArt: customCoverArt,
    isReadOnly,
  } = route?.params || {};
  const isFavorites = playlistId === 'favorites';
  const hasInitialTracks =
    Array.isArray(initialTracks) && initialTracks.length > 0;
  const isCustomOrReadOnly = Boolean(isReadOnly || hasInitialTracks);
  const [tracks, setTracks] = useState(hasInitialTracks ? initialTracks : []);
  const [isLoading, setIsLoading] = useState(!hasInitialTracks);
  const [accentColor, setAccentColor] = useState(
    () => getSettings().accentColor || '#FFDAB9',
  );

  useEffect(() => {
    const unsub = addSettingsListener((s) => {
      if (s.accentColor) setAccentColor(s.accentColor);
    });
    return unsub;
  }, []);

  const [savedIds, setSavedIds] = useState([]);
  const [savingId, setSavingId] = useState(null);
  const offlineSession = getOfflineSession();
  const collectionKey = { kind: 'playlist', collectionId: playlistId };
  const [savedCollection, setSavedCollection] = useState(false);
  const [hasCompleteSnapshot, setHasCompleteSnapshot] = useState(false);
  const [progress, setProgress] = useState(null);
  const snapshotRevision = useRef(0);
  useEffect(() => {
    if (!offlineSession || isCustomOrReadOnly) return;
    let active = true;
    const key = isFavorites ? FAVORITES_COLLECTION : { kind: 'playlist', collectionId: playlistId };
    const unsubscribe = subscribeOfflineIndex((event) => {
      if (event.type !== 'collection' || event.session !== offlineSession ||
          event.kind !== key.kind || String(event.collectionId) !== String(key.collectionId)) return;
      const revision = ++snapshotRevision.current;
      (async () => {
        const snapshot = await readCollection(offlineSession, key);
        if (!snapshot) return;
        const raw = isFavorites ? overlayFavorites(snapshot.tracks, await getRatingOverlay(offlineSession)) : snapshot.tracks;
        if (!active || revision !== snapshotRevision.current || !isOfflineSessionCurrent(offlineSession)) return;
        setTracks(raw.map((t) => normalizeTrack(t, { serverUrl: SERVER_URL })).filter(Boolean));
        setHasCompleteSnapshot(true);
        setIsLoading(false);
      })().catch(() => {});
    });
    return () => { active = false; snapshotRevision.current += 1; unsubscribe(); };
  }, [offlineSession, playlistId, isFavorites, isCustomOrReadOnly]);

  useEffect(() => {
    if (!offlineSession || isFavorites || isCustomOrReadOnly) return;
    isCollectionSaved(offlineSession, collectionKey)
      .then(setSavedCollection)
      .catch(() => {});
  }, [offlineSession, playlistId, isFavorites, isCustomOrReadOnly]);
  const toggleCollection = async () => {
    if (!offlineSession) return;
    if (savedCollection)
      await removeOfflineCollection(offlineSession, collectionKey);
    else
      await saveOfflineCollection(offlineSession, collectionKey, {
        title: playlistName,
        tracks,
      });
    if (isOfflineSessionCurrent(offlineSession))
      setSavedCollection(!savedCollection);
  };
  useEffect(() => {
    if (!offlineSession || (!isFavorites && !savedCollection)) return;
    let active = true;
    const refresh = () =>
      collectionProgress(offlineSession, tracks)
        .then((value) => {
          if (active) setProgress(value);
        })
        .catch(() => {});
    refresh();
    const unsubscribe = subscribeOfflineIndex(({ type }) => {
      if (['published', 'missing', 'collection'].includes(type)) refresh();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [offlineSession, tracks, savedCollection, isFavorites]);

  useEffect(() => {
    if (!offlineSession) return;
    let active = true;
    let latest = 0;
    const refresh = () => {
      const request = ++latest;
      readFavoriteDownloads(offlineSession)
        .then(({ ready }) => {
          if (
            active &&
            request === latest &&
            isOfflineSessionCurrent(offlineSession)
          )
            setSavedIds(ready);
        })
        .catch(() => {});
    };
    refresh();
    const unsubscribe = subscribeOfflineIndex(({ type }) => {
      if (type === 'published' || type === 'missing') refresh();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [offlineSession]);

  const saveOffline = async (track) => {
    if (!offlineSession || savingId !== null) return;
    setSavingId(String(getTrackId(track)));
    try {
      if (await saveFavoriteOffline(offlineSession, track)) return;
      if (isOfflineSessionCurrent(offlineSession))
        Alert.alert('Не удалось скачать трек');
    } catch {
      if (isOfflineSessionCurrent(offlineSession))
        Alert.alert('Не удалось скачать трек');
    } finally {
      if (isOfflineSessionCurrent(offlineSession)) setSavingId(null);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    setHasCompleteSnapshot(false);
    if (!hasInitialTracks) {
      fetchPlaylist(controller.signal);
    }
    return () => controller.abort();
  }, [playlistId, hasInitialTracks, offlineSession]);

  const fetchPlaylist = async (signal) => {
    const revision = snapshotRevision.current;
    setIsLoading(true);
    try {
      if (isFavorites) {
        const canUpdate = () =>
          !signal.aborted && revision === snapshotRevision.current &&
          getOfflineSession() === offlineSession &&
          (!offlineSession || isOfflineSessionCurrent(offlineSession));
        const showTracks = (raw) =>
          setTracks(
            raw
              .map((t) => normalizeTrack(t, { serverUrl: SERVER_URL }))
              .filter(Boolean),
          );
        const saved = offlineSession
          ? await readCollection(offlineSession, FAVORITES_COLLECTION).catch(
              () => null,
            )
          : null;
        if (!canUpdate()) return;
        if (saved) {
          const projected = overlayFavorites(saved.tracks, await getRatingOverlay(offlineSession));
          if (!canUpdate()) return;
          showTracks(projected);
          setIsLoading(false);
        }
        if (offlineSession) await waitForOutboxDrain(offlineSession);
        if (!canUpdate()) return;
        const response = await (offlineSession
          ? authFetch('/api/favorites', { signal, retry: 0 })
          : authFetch('/api/favorites'));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data) || !canUpdate()) return;
        const projected = offlineSession
          ? overlayFavorites(data, await getRatingOverlay(offlineSession))
          : data;
        if (!canUpdate()) return;
        showTracks(projected);
      } else {
        const saved = offlineSession
          ? await readCollection(offlineSession, collectionKey).catch(
              () => null,
            )
          : null;
        if (
          saved &&
          !signal.aborted &&
          isOfflineSessionCurrent(offlineSession)
        ) {
          setTracks(
            saved.tracks
              .map((t) => normalizeTrack(t, { serverUrl: SERVER_URL }))
              .filter(Boolean),
          );
          setHasCompleteSnapshot(true);
          setIsLoading(false);
        }
        const response = await (offlineSession
          ? authFetch(`/api/playlists/${playlistId}`, { signal })
          : authFetch(`/api/playlists/${playlistId}`));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (signal.aborted) return;
        if (!Array.isArray(data?.tracks))
          throw new Error('Invalid playlist response');
        const raw = data.tracks;
        setHasCompleteSnapshot(true);
        if (
          offlineSession &&
          (await isCollectionSaved(offlineSession, collectionKey))
        )
          await saveOfflineCollection(offlineSession, collectionKey, {
            title: playlistName,
            tracks: raw,
          }, { requireSaved: true, replaceSnapshot: true, expectedUpdatedAt: saved?.updatedAt ?? null });
        if (signal.aborted || revision !== snapshotRevision.current || (offlineSession && !isOfflineSessionCurrent(offlineSession))) return;
        setTracks(
          raw
            .map((t) => normalizeTrack(t, { serverUrl: SERVER_URL }))
            .filter(Boolean),
        );
      }
    } catch (error) {
      if (
        !signal.aborted &&
        (!offlineSession || isOfflineSessionCurrent(offlineSession))
      ) {
        console.error('Fetch playlist tracks error:', error);
      }
    } finally {
      if (
        !signal.aborted &&
        (!offlineSession || isOfflineSessionCurrent(offlineSession))
      )
        setIsLoading(false);
    }
  };

  const handleRemoveTrack = async (trackOrId) => {
    const trackId = getTrackId(trackOrId);
    if (trackId === null) return;

    Alert.alert(
      isFavorites ? 'Remove Favorite' : 'Remove Track',
      isFavorites
        ? 'Remove this track from your favorites?'
        : 'Are you sure you want to remove this track from the playlist?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              if (isFavorites) {
                if (offlineSession)
                  await saveRatingWithFeedback(offlineSession, trackOrId, 'neutral');
                else
                  await authFetch(
                    `/api/tracks/${encodeURIComponent(String(trackId))}/like`,
                    { method: 'DELETE' },
                  );
              } else {
                await authFetch(
                  `/api/playlists/${encodeURIComponent(String(playlistId))}/tracks/${encodeURIComponent(String(trackId))}`,
                  {
                    method: 'DELETE',
                  },
                );
              }
              setTracks((prev) =>
                prev.filter((t) => !areTrackIdsEqual(t, trackId)),
              );
            } catch (e) {
              console.error('Remove track error', e);
              if (isFavorites) showRatingError();
            }
          },
        },
      ],
    );
  };

  const renderTrack = ({ item, index }) => {
    const trackId = String(getTrackId(item));
    const isSaved = savedIds.includes(trackId);
    return (
      <TouchableOpacity
        style={styles.trackRow}
        activeOpacity={0.6}
        onPress={() => onPlayTrackList(tracks, index)}
        onLongPress={() => onPressEllipsis?.(item)}
      >
        <Text style={styles.trackNumber}>{index + 1}</Text>
        {item.coverArt && (
          <CoverImage source={item.coverArt} style={styles.trackThumb} />
        )}
        <View style={styles.trackInfo}>
          <Text style={styles.trackTitle} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.trackArtist} numberOfLines={1}>
            {item.artist}
          </Text>
        </View>
        {offlineSession && isFavorites && (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={
              isSaved ? `${item.title} скачан` : `Скачать ${item.title}`
            }
            disabled={savingId !== null || isSaved}
            onPress={() => saveOffline(item)}
            style={styles.downloadButton}
          >
            {savingId === trackId ? (
              <ActivityIndicator color={accentColor} />
            ) : (
              <Ionicons
                name={isSaved ? 'checkmark-circle-outline' : 'download-outline'}
                size={20}
                color={isSaved ? accentColor : '#aaa'}
              />
            )}
          </TouchableOpacity>
        )}
        {onPressEllipsis && (
          <TouchableOpacity
            onPress={() => onPressEllipsis(item)}
            accessibilityRole="button"
            accessibilityLabel={`Действия с ${item.title}`}
            style={{
              width: 44,
              height: 44,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="ellipsis-horizontal" size={20} color="#aaa" />
          </TouchableOpacity>
        )}
        {!isCustomOrReadOnly && (
          <TouchableOpacity
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            onPress={() => handleRemoveTrack(item)}
          >
            <Ionicons name="trash-outline" size={18} color="#ff453a" />
          </TouchableOpacity>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
        >
          <Ionicons name="chevron-back" size={28} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {playlistName}
        </Text>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={accentColor} size="large" />
        </View>
      ) : (
        <FlatList
          data={tracks}
          keyExtractor={(item, idx) => `${getTrackId(item) ?? idx}-${idx}`}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <View style={styles.playlistHeader}>
              {customCoverArt || (hasInitialTracks && tracks[0]?.coverArt) ? (
                <CoverImage
                  source={customCoverArt || tracks[0]?.coverArt}
                  style={styles.coverImage}
                />
              ) : (
                <View
                  style={[
                    styles.coverImage,
                    styles.coverPlaceholder,
                    isFavorites && styles.favoritesCoverPlaceholder,
                  ]}
                >
                  <Ionicons
                    name={isFavorites ? 'heart' : 'list'}
                    size={52}
                    color={isFavorites ? accentColor : '#555'}
                  />
                </View>
              )}
              <Text style={styles.playlistTitleText}>{playlistName}</Text>
              {offlineSession && !isFavorites && !isCustomOrReadOnly && hasCompleteSnapshot && (
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={toggleCollection}
                >
                  <Text style={styles.playlistSubtitleText}>
                    {savedCollection ? 'Удалить загрузку' : 'Скачать плейлист'}
                  </Text>
                </TouchableOpacity>
              )}
              {progress && (
                <Text style={styles.playlistSubtitleText}>
                  Скачано {progress.ready} из {progress.total}
                </Text>
              )}
              <Text style={styles.playlistSubtitleText}>
                {customSubtitle ? `${customSubtitle} • ` : ''}
                {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'}
              </Text>
            </View>
          }
          renderItem={renderTrack}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>
                {isFavorites
                  ? 'No favorite tracks yet'
                  : 'No tracks in this playlist yet'}
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
  downloadButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
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
