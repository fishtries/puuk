import {
  getOfflineSession,
  isOfflineSessionCurrent,
  readCollection,
  subscribeOfflineIndex,
} from '../../offline';
import {
  saveOfflineCollection,
  removeOfflineCollection,
  isCollectionSaved,
  collectionProgress,
} from '../../offline/collections';
import {
  SHARE_LINKS_ENABLED,
  presentShareEntity,
} from '../../utils/shareLinks';
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import CoverImage from '../../shared/media/CoverImage';
import { subscribeArtistCreditsUpdated } from '../../shared/domain/artistCreditEvents';
import { authFetch, SERVER_URL } from '../../shared/api/api';
import { getTrackId, normalizeTrack } from '../../shared/domain/trackAdapter';
import {
  normalizeAlbum,
  getSelectableArtists,
} from '../../shared/domain/artistCredits';
import ArtistSelector from '../../shared/components/ArtistSelector';

export default function AlbumScreen({
  route,
  navigation,
  onPlayTrackList,
  onPressEllipsis,
}) {
  const { albumId, albumTitle, coverArt } = route.params;
  const session = getOfflineSession();
  const key = { kind: 'album', collectionId: albumId };
  const [saved, setSaved] = useState(false);
  const [progress, setProgress] = useState(null);
  const [album, setAlbum] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState(null);

  const requestRef = useRef(0);
  const snapshotRevision = useRef(0);
  useEffect(() => {
    if (!session) return;
    let active = true;
    const unsubscribe = subscribeOfflineIndex((event) => {
      if (event.type !== 'collection' || event.session !== session ||
          event.kind !== 'album' || String(event.collectionId) !== String(albumId)) return;
      const revision = ++snapshotRevision.current;
      readCollection(session, { kind: 'album', collectionId: albumId }).then((snapshot) => {
        if (!snapshot || !active || revision !== snapshotRevision.current || !isOfflineSessionCurrent(session)) return;
        setTracks(snapshot.tracks.map((t) => normalizeTrack(t, { serverUrl: SERVER_URL })).filter(Boolean));
        setErrorMessage(null);
        setIsLoading(false);
      }).catch(() => {});
    });
    return () => { active = false; snapshotRevision.current += 1; unsubscribe(); };
  }, [session, albumId]);

  useEffect(() => () => { requestRef.current += 1; }, [albumId, session]);
  const fetchAlbum = useCallback(async () => {
    const request = ++requestRef.current;
    const revision = snapshotRevision.current;
    const current = () => revision === snapshotRevision.current && request === requestRef.current && (!session || isOfflineSessionCurrent(session));
    setIsLoading(true);
    setErrorMessage(null);
    try {
      let snapshot = null;
      if (session) {
        snapshot = await readCollection(session, key);
        if (!current()) return;
        if (snapshot) {
          setTracks(
            snapshot.tracks
              .map((t) => normalizeTrack(t, { serverUrl: SERVER_URL }))
              .filter(Boolean),
          );
          setIsLoading(false);
        }
      }
      const response = await authFetch(`/api/albums/${albumId}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.tracks))
        throw new Error('Invalid album response');
      if (!current()) return;
      setAlbum(normalizeAlbum(data.album));
      const rawTracks = data.tracks;
      if (session && (await isCollectionSaved(session, key)))
        await saveOfflineCollection(session, key, {
          title: data.album?.title || albumTitle,
          tracks: rawTracks,
        }, { requireSaved: true, replaceSnapshot: true, expectedUpdatedAt: snapshot?.updatedAt ?? null });
      if (!current()) return;
      const normalizedTracks = rawTracks
        .map((t) => normalizeTrack(t, { serverUrl: SERVER_URL }))
        .filter(Boolean);
      setTracks(normalizedTracks);
    } catch (error) {
      if (!current()) return;
      console.error('Fetch album detail error:', error);
      if ((!session || !(await readCollection(session, key))) && current())
        setErrorMessage('Не удалось загрузить альбом');
    } finally {
      if (current()) setIsLoading(false);
    }
  }, [albumId, session, albumTitle]);

  // Загрузка при открытии и обновление при возврате из редактора альбома.
  useFocusEffect(
    useCallback(() => {
      fetchAlbum();
      return () => { requestRef.current += 1; };
    }, [fetchAlbum]),
  );

  useEffect(
    () => subscribeArtistCreditsUpdated(() => fetchAlbum()),
    [fetchAlbum],
  );

  useEffect(() => {
    if (!session) return;
    isCollectionSaved(session, key)
      .then(setSaved)
      .catch(() => {});
  }, [session, albumId]);
  useEffect(() => {
    if (!session || !saved) return;
    let active = true;
    const refresh = () =>
      collectionProgress(session, tracks)
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
  }, [session, tracks, saved]);
  const toggleCollection = async () => {
    if (!session) return;
    if (saved) await removeOfflineCollection(session, key);
    else
      await saveOfflineCollection(session, key, {
        title: album?.title || albumTitle,
        tracks,
      });
    if (isOfflineSessionCurrent(session)) setSaved(!saved);
  };

  const renderTrack = ({ item, index }) => (
    <TouchableOpacity
      style={styles.trackRow}
      activeOpacity={0.6}
      onPress={() => onPlayTrackList(tracks, index)}
    >
      <Text style={styles.trackNumber}>
        {item.track_number
          ? String(item.track_number).split('/')[0]
          : index + 1}
      </Text>
      <View style={styles.trackInfo}>
        <Text style={styles.trackTitle} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={styles.trackArtist} numberOfLines={1}>
          {item.artist}
        </Text>
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
  const albumArtist = album?.artists?.length
    ? album.artists.map((artist) => artist.name).join(', ')
    : album?.album_artist || album?.artist;
  const selectableArtists = getSelectableArtists(album);
  const metaParts = [];
  if (albumArtist) metaParts.push(albumArtist);
  if (album?.year) metaParts.push(String(album.year));
  if (album?.track_count) metaParts.push(`${album.track_count} трек(ов)`);

  const secondaryMetaParts = [];
  if (album?.year) secondaryMetaParts.push(String(album.year));
  if (album?.track_count)
    secondaryMetaParts.push(`${album.track_count} трек(ов)`);

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
          {resolvedTitle}
        </Text>
        <TouchableOpacity
          onPress={() => navigation.navigate('AlbumEdit', { albumId, album })}
          style={styles.editButton}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="create-outline" size={22} color="#fff" />
        </TouchableOpacity>
        {SHARE_LINKS_ENABLED && album && !isLoading && !errorMessage && (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Поделиться альбомом"
            onPress={() => presentShareEntity(album, 'album')}
            style={{ padding: 12 }}
          >
            <Ionicons name="share-outline" size={22} color="#fff" />
          </TouchableOpacity>
        )}
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
          keyExtractor={(item, index) =>
            `${getTrackId(item) ?? index}-${index}`
          }
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <View style={styles.albumHeader}>
              <CoverImage source={resolvedCover} style={styles.coverImage} />
              <Text style={styles.albumTitleText}>{resolvedTitle}</Text>
              {session && (
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={toggleCollection}
                >
                  <Text style={styles.albumMetaText}>
                    {saved ? 'Удалить загрузку' : 'Скачать альбом'}
                  </Text>
                </TouchableOpacity>
              )}
              {progress && (
                <Text style={styles.albumMetaText}>
                  Скачано {progress.ready} из {progress.total}
                </Text>
              )}
              {selectableArtists.length > 0 && albumArtist ? (
                <View style={styles.albumMetaRow}>
                  <ArtistSelector
                    entity={album}
                    identity={albumId}
                    display={albumArtist}
                    onSelect={(artistId) =>
                      navigation.navigate('ArtistDetail', { artistId })
                    }
                    controlStyle={styles.albumArtistControl}
                    textStyle={styles.albumMetaText}
                  />
                  {secondaryMetaParts.map((part, idx) => (
                    <React.Fragment key={`${idx}-${part}`}>
                      <Text style={styles.albumMetaText}> · </Text>
                      <Text style={styles.albumMetaText}>{part}</Text>
                    </React.Fragment>
                  ))}
                </View>
              ) : (
                metaParts.length > 0 && (
                  <Text style={styles.albumMetaText}>
                    {metaParts.join(' · ')}
                  </Text>
                )
              )}
            </View>
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.stateText}>
                В этом альбоме пока нет треков
              </Text>
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
  albumMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
  albumArtistControl: {
    alignSelf: 'center',
    justifyContent: 'center',
    alignItems: 'center',
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
