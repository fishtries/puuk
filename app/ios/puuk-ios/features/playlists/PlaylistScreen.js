import { saveRatingWithFeedback, showRatingError } from '../downloads/ratingFeedback';
import {
  saveOfflineCollection,
  removeOfflineCollection,
  isCollectionSaved,
} from '../../offline/collections';
import { overlayFavorites } from '../../offline/collections/runtime';
import { getRatingOverlay, waitForOutboxDrain } from '../../offline/outbox/runtime';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  DeviceEventEmitter,
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
  subscribeOfflineIndex,
} from '../../offline';
import { saveFavoriteOffline } from '../../offline/foreground';
import PlaylistTrackMenu from './PlaylistTrackMenu';
import useCollectionProgress from '../downloads/useCollectionProgress';

const PlaylistTrackRow = React.memo(function PlaylistTrackRow({
  track,
  index,
  isFavorites,
  isSaved,
  isSaving,
  downloadsDisabled,
  accentColor,
  onPlay,
  onSave,
  onAddToPlaylist,
  onEditTrack,
  onRemove,
}) {
  return (
    <View style={styles.trackRow}>
      <TouchableOpacity
        style={styles.trackBody}
        activeOpacity={0.6}
        accessibilityRole="button"
        accessibilityLabel={`Воспроизвести ${track.title}`}
        onPress={() => onPlay(index)}
      >
        {track.coverArt && (
          <CoverImage source={track.coverArt} style={styles.trackThumb} />
        )}
        <View style={styles.trackInfo}>
          <Text style={styles.trackTitle} numberOfLines={1}>
            {track.title}
          </Text>
          <Text style={styles.trackArtist} numberOfLines={1}>
            {track.artist}
          </Text>
        </View>
      </TouchableOpacity>
      {onSave && (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={
            isSaved ? `${track.title} скачан` : `Скачать ${track.title}`
          }
          disabled={downloadsDisabled || isSaved}
          onPress={() => onSave(track)}
          style={styles.downloadButton}
        >
          {isSaving ? (
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
      <PlaylistTrackMenu
        track={track}
        isFavorites={isFavorites}
        onAddToPlaylist={onAddToPlaylist}
        onEditTrack={onEditTrack}
        onRemove={onRemove}
      />
    </View>
  );
});

const trackKey = (item, index) =>
  item.playlist_entry_id == null
    ? `${getTrackId(item) ?? index}-${index}`
    : `entry:${item.playlist_entry_id}`;

export default function PlaylistScreen({
  route,
  navigation,
  onPlayTrackList,
  onAddToPlaylist,
  onEditTrack,
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

  const [savingId, setSavingId] = useState(null);
  const offlineSession = getOfflineSession();
  const collectionKey = { kind: 'playlist', collectionId: playlistId };
  const [savedCollection, setSavedCollection] = useState(false);
  const [hasCompleteSnapshot, setHasCompleteSnapshot] = useState(false);
  const progress = useCollectionProgress(
    offlineSession,
    isFavorites ? FAVORITES_COLLECTION : collectionKey,
    tracks,
    isFavorites || savedCollection,
  );
  const [isImported, setIsImported] = useState(false);
  const lastImport = useRef([]);
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
  const saveOffline = useCallback(
    async (track) => {
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
    },
    [offlineSession, savingId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setHasCompleteSnapshot(false);
    setIsImported(false);
    lastImport.current = [];
    if (!hasInitialTracks) {
      fetchPlaylist(controller.signal);
    }
    return () => controller.abort();
  }, [playlistId, hasInitialTracks, offlineSession]);

  useEffect(() => {
    if (!isImported) return;
    const controller = new AbortController();
    let loading = false;
    const timer = setInterval(async () => {
      if (loading) return;
      loading = true;
      try {
        const response = await authFetch(`/api/playlists/${playlistId}`, {
          signal: controller.signal, retry: 0,
        });
        if (!response.ok) return;
        const data = await response.json();
        if (controller.signal.aborted || !Array.isArray(data.tracks)) return;
        const refreshed = data.tracks.map((track) => normalizeTrack(track, { serverUrl: SERVER_URL })).filter(Boolean);
        const known = new Set(lastImport.current.map((track) => track.playlist_entry_id));
        const added = refreshed.filter((track) => !known.has(track.playlist_entry_id));
        lastImport.current = refreshed;
        setTracks(refreshed);
        if (added.length) DeviceEventEmitter.emit('PUUK_PLAYLIST_POSITIONS_READY', { refreshed, added });
      } catch {
        // The last loaded playlist is still available while the network recovers.
      } finally {
        loading = false;
      }
    }, 5000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [isImported, playlistId, offlineSession]);

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
        const tracks = raw.map((t) => normalizeTrack(t, { serverUrl: SERVER_URL })).filter(Boolean);
        if (data.playlist?.is_imported) {
          lastImport.current = tracks;
          setIsImported(true);
        }
        setTracks(tracks);
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

  const handleRemoveTrack = useCallback(
    async (trackOrId) => {
      const trackId = getTrackId(trackOrId);
      const entryId = isFavorites ? null : trackOrId?.playlist_entry_id;
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
                      `/api/${entryId == null ? `tracks/${encodeURIComponent(String(trackId))}` : `entries/${entryId}`}/like`,
                      { method: 'DELETE' },
                    );
                } else {
                  await authFetch(
                    `/api/playlists/${encodeURIComponent(String(playlistId))}/${entryId == null ? `tracks/${encodeURIComponent(String(trackId))}` : `entries/${entryId}`}`,
                    {
                      method: 'DELETE',
                    },
                  );
                }
                setTracks((prev) =>
                  prev.filter((t) => entryId == null ? !areTrackIdsEqual(t, trackId) : t.playlist_entry_id !== entryId),
                );
              } catch (e) {
                console.error('Remove track error', e);
                if (isFavorites) showRatingError();
              }
            },
          },
        ],
      );
    },
    [isFavorites, offlineSession, playlistId],
  );

  const playAtIndex = useCallback(
    (index) => onPlayTrackList(tracks, index),
    [onPlayTrackList, tracks],
  );
  const saveTrack = offlineSession && isFavorites ? saveOffline : undefined;
  const removeTrack = isCustomOrReadOnly ? undefined : handleRemoveTrack;
  const readyIds = progress?.readyIds;
  const renderTrack = useCallback(
    ({ item, index }) => {
      const trackId = String(getTrackId(item));
      return (
        <PlaylistTrackRow
          track={item}
          index={index}
          isFavorites={isFavorites}
          isSaved={readyIds?.has(trackId) ?? false}
          isSaving={savingId === trackId}
          downloadsDisabled={savingId !== null}
          accentColor={accentColor}
          onPlay={playAtIndex}
          onSave={saveTrack}
          onAddToPlaylist={onAddToPlaylist}
          onEditTrack={onEditTrack}
          onRemove={removeTrack}
        />
      );
    },
    [
      isFavorites,
      readyIds,
      savingId,
      accentColor,
      playAtIndex,
      saveTrack,
      onAddToPlaylist,
      onEditTrack,
      removeTrack,
    ],
  );

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
          keyExtractor={trackKey}
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
  trackBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
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
