import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import CoverImage from '../../shared/media/CoverImage';
import { subscribeArtistCreditsUpdated } from '../../shared/domain/artistCreditEvents';
import { SERVER_URL } from '../../shared/api/api';
import { getTrackId, normalizeTrack } from '../../shared/domain/trackAdapter';
import { getArtistDetail } from '../../shared/api/artists';

function formatDuration(seconds) {
  if (typeof seconds !== 'number' || Number.isNaN(seconds) || seconds < 0) {
    return '';
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function formatStats(artist) {
  const parts = [];
  if (typeof artist?.track_count === 'number') {
    const n = artist.track_count;
    const mod10 = n % 10;
    const mod100 = n % 100;
    let word = 'треков';
    if (mod100 < 11 || mod100 > 19) {
      if (mod10 === 1) word = 'трек';
      else if (mod10 >= 2 && mod10 <= 4) word = 'трека';
    }
    parts.push(`${n} ${word}`);
  }
  if (typeof artist?.album_count === 'number') {
    const n = artist.album_count;
    const mod10 = n % 10;
    const mod100 = n % 100;
    let word = 'альбомов';
    if (mod100 < 11 || mod100 > 19) {
      if (mod10 === 1) word = 'альбом';
      else if (mod10 >= 2 && mod10 <= 4) word = 'альбома';
    }
    parts.push(`${n} ${word}`);
  }
  return parts.join(' · ');
}

function formatPlayCount(n) {
  if (typeof n !== 'number' || n <= 0) return '';
  const mod10 = n % 10;
  const mod100 = n % 100;
  let word = 'прослушиваний';
  if (mod100 < 11 || mod100 > 19) {
    if (mod10 === 1) word = 'прослушивание';
    else if (mod10 >= 2 && mod10 <= 4) word = 'прослушивания';
  }
  return `${n} ${word}`;
}

export default function ArtistScreen({
  route,
  navigation,
  onPlayTrack,
  onPressEllipsis,
  onPressEdit,
  currentUser,
}) {
  const artistId = route?.params?.artistId || route?.params?.id;
  const effectiveUser = currentUser ?? route?.params?.currentUser;
  const isAdmin = effectiveUser?.role === 'admin';

  const [artist, setArtist] = useState(null);
  const [popularTracks, setPopularTracks] = useState([]);
  const [albums, setAlbums] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState(null);
  const [isNotFound, setIsNotFound] = useState(false);
  const [isOffline, setIsOffline] = useState(false);

  const abortControllerRef = useRef(null);
  const latestRequestIdRef = useRef(0);

  const fetchArtist = useCallback(async () => {
    if (!artistId) {
      setIsNotFound(true);
      setIsLoading(false);
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const requestId = ++latestRequestIdRef.current;

    setIsLoading(true);
    setErrorMessage(null);
    setIsNotFound(false);
    setIsOffline(false);

    try {
      const data = await getArtistDetail(artistId, {
        signal: controller.signal,
      });
      if (requestId !== latestRequestIdRef.current) {
        return;
      }
      if (!data || !data.artist) {
        setIsNotFound(true);
        return;
      }
      setArtist(data.artist);

      const rawTracks = Array.isArray(data.popular_tracks)
        ? data.popular_tracks.slice(0, 10)
        : [];
      const normalized = rawTracks
        .map((t) => normalizeTrack(t, { serverUrl: SERVER_URL }))
        .filter(Boolean);
      setPopularTracks(normalized);

      const rawAlbums = Array.isArray(data.albums) ? data.albums : [];
      setAlbums(rawAlbums);
    } catch (err) {
      if (err?.name === 'AbortError' || controller.signal.aborted) {
        return;
      }
      if (requestId !== latestRequestIdRef.current) {
        return;
      }
      const status = err?.status || err?.response?.status;
      const msg = String(err?.message || '');
      if (
        status === 404 ||
        msg.includes('404') ||
        msg.toLowerCase().includes('not found') ||
        msg.includes('не найден')
      ) {
        setIsNotFound(true);
      } else if (
        err?.type === 'offline' ||
        err?.isOffline ||
        err?.code === 'OFFLINE' ||
        msg.toLowerCase() === 'offline' ||
        msg.includes('The Internet connection appears to be offline')
      ) {
        setIsOffline(true);
        setErrorMessage('Сеть недоступна');
      } else {
        setErrorMessage(msg || 'Не удалось загрузить данные артиста');
      }
    } finally {
      if (requestId === latestRequestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [artistId]);

  useFocusEffect(
    useCallback(() => {
      fetchArtist();
      return () => {
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
        }
        latestRequestIdRef.current += 1;
      };
    }, [fetchArtist]),
  );

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      latestRequestIdRef.current += 1;
    };
  }, []);

  useEffect(() => subscribeArtistCreditsUpdated(() => fetchArtist()), [fetchArtist]);

  const renderHeader = () => (
    <View style={styles.header}>
      <TouchableOpacity
        testID="artist-back-button"
        onPress={() => navigation?.goBack?.()}
        style={styles.backButton}
        accessibilityRole="button"
        accessibilityLabel="Назад"
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      >
        <Ionicons name="chevron-back" size={28} color="#fff" />
      </TouchableOpacity>
      <Text
        testID="artist-header-title"
        style={styles.headerTitle}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {artist?.name || ''}
      </Text>
      {isAdmin ? (
        <TouchableOpacity
          testID="artist-admin-edit-button"
          style={styles.editButton}
          onPress={() => {
            if (onPressEdit) {
              onPressEdit(artist);
            } else if (navigation?.navigate) {
              navigation.navigate('ArtistEdit', { artistId, artist });
            }
          }}
          accessibilityRole="button"
          accessibilityLabel="Редактировать артиста"
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="create-outline" size={22} color="#fff" />
        </TouchableOpacity>
      ) : (
        <View style={styles.headerSpacer} />
      )}
    </View>
  );

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {renderHeader()}
        <View style={styles.center} testID="loading-state">
          <ActivityIndicator
            color="#6C3AED"
            size="large"
            accessibilityLabel="Загрузка артиста"
          />
        </View>
      </SafeAreaView>
    );
  }

  if (isNotFound) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {renderHeader()}
        <View style={styles.center} testID="not-found-state">
          <Ionicons name="alert-circle-outline" size={36} color="#8e8e93" />
          <Text style={styles.stateText}>Артист не найден</Text>
          <Text style={styles.stateSubText}>Профиль больше недоступен. Вернитесь назад, чтобы продолжить.</Text>
          {navigation?.goBack ? (
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => navigation.goBack()}
              accessibilityRole="button"
              accessibilityLabel="Назад"
            >
              <Text style={styles.actionButtonText}>Назад</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </SafeAreaView>
    );
  }

  if (isOffline) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {renderHeader()}
        <View style={styles.center} testID="offline-state" accessibilityRole="alert">
          <Ionicons name="cloud-offline-outline" size={36} color="#8e8e93" />
          <Text style={styles.stateText}>Сеть недоступна</Text>
          <Text style={styles.stateSubText}>
            Проверьте подключение к интернету и повторите попытку
          </Text>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={fetchArtist}
            accessibilityRole="button"
            accessibilityLabel="Повторить"
          >
            <Text style={styles.actionButtonText}>Повторить</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (errorMessage) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {renderHeader()}
        <View style={styles.center} testID="error-state">
          <Ionicons name="alert-circle-outline" size={36} color="#8e8e93" />
          <Text style={styles.stateText}>{errorMessage}</Text>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={fetchArtist}
            accessibilityRole="button"
            accessibilityLabel="Повторить"
          >
            <Text style={styles.actionButtonText}>Повторить</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const statsText = formatStats(artist);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {renderHeader()}
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.artistHero}>
          {artist?.artwork_url ? (
            <CoverImage
              source={artist.artwork_url}
              style={styles.avatarImage}
              testID="artist-artwork"
              accessibilityRole="image"
              accessibilityLabel={artist?.name || 'Обложка артиста'}
            />
          ) : (
            <View
              style={styles.avatarPlaceholder}
              testID="artist-no-artwork"
              accessibilityRole="image"
              accessibilityLabel="Нет обложки артиста"
            >
              <Ionicons name="person" size={56} color="#8e8e93" />
            </View>
          )}
          <Text
            testID="artist-hero-name"
            style={styles.artistName}
            numberOfLines={2}
            ellipsizeMode="tail"
          >
            {artist?.name}
          </Text>
          {isAdmin && artist && (
            <TouchableOpacity testID="artist-bulk-button" style={styles.actionButton} accessibilityRole="button" accessibilityLabel="Исправить исполнителя" onPress={() => navigation.navigate('ArtistCreditBulk', { artistId, artistName: artist.name })}>
              <Text style={styles.actionButtonText}>Исправить исполнителя</Text>
            </TouchableOpacity>
          )}
          {statsText ? (
            <Text style={styles.artistStats}>{statsText}</Text>
          ) : null}
        </View>

        {/* ── Popular Tracks (Top 10 sorted by API, no artist link) ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Популярные треки</Text>
          {popularTracks.length > 0 ? (
            <View style={styles.tracksContainer}>
              {popularTracks.map((track, index) => {
                const trackId = getTrackId(track) ?? index;
                const durationText = formatDuration(track.duration);
                const metaParts = [];
                if (track.album) {
                  metaParts.push(track.album);
                }
                if (typeof track.play_count === 'number' && track.play_count > 0) {
                  metaParts.push(formatPlayCount(track.play_count));
                }
                const trackMetaText = metaParts.join(' · ');

                return (
                  <TouchableOpacity
                    key={String(trackId)}
                    testID={`track-row-${trackId}`}
                    style={styles.trackRow}
                    activeOpacity={0.6}
                    onPress={() => onPlayTrack && onPlayTrack(track)}
                    accessibilityRole="button"
                    accessibilityLabel={`Воспроизвести ${track.title || 'трек'}`}
                  >
                    <Text style={styles.trackNumber}>{index + 1}</Text>
                    {track.coverArt ? (
                      <CoverImage
                        source={track.coverArt}
                        style={styles.trackThumb}
                      />
                    ) : null}
                    <View style={styles.trackInfo}>
                      <Text
                        style={styles.trackTitle}
                        numberOfLines={1}
                        ellipsizeMode="tail"
                      >
                        {track.title}
                      </Text>
                      {trackMetaText ? (
                        <Text
                          style={styles.trackMeta}
                          numberOfLines={1}
                          ellipsizeMode="tail"
                        >
                          {trackMetaText}
                        </Text>
                      ) : null}
                    </View>
                    {durationText ? (
                      <Text style={styles.trackDuration}>{durationText}</Text>
                    ) : null}
                    {onPressEllipsis ? (
                      <TouchableOpacity
                        testID={`track-ellipsis-${trackId}`}
                        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                        onPress={() => onPressEllipsis(track)}
                        style={styles.ellipsisBtn}
                        accessibilityRole="button"
                        accessibilityLabel="Действия с треком"
                      >
                        <Ionicons
                          name="ellipsis-horizontal"
                          size={18}
                          color="#555"
                        />
                      </TouchableOpacity>
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : (
            <View
              style={styles.emptyContainer}
              testID={
                (artist?.track_count ?? 0) === 0
                  ? 'no-tracks-state'
                  : 'no-popular-tracks-state'
              }
            >
              <Text style={styles.emptyText}>
                {(artist?.track_count ?? 0) === 0
                  ? 'Нет треков'
                  : 'Нет популярных треков'}
              </Text>
            </View>
          )}
        </View>

        {/* ── Albums (open via navigation.navigate('Album', {albumId, albumTitle, coverArt})) ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Альбомы</Text>
          {albums.length > 0 ? (
            <View style={styles.albumsContainer}>
              {albums.map((album, index) => {
                const albumId = album.id ?? index;
                return (
                  <TouchableOpacity
                    key={String(albumId)}
                    testID={`album-row-${albumId}`}
                    style={styles.albumRow}
                    activeOpacity={0.65}
                    onPress={() => {
                      if (navigation?.navigate) {
                        navigation.navigate('Album', {
                          albumId: album.id,
                          albumTitle: album.title,
                          coverArt: album.coverArt,
                        });
                      }
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Альбом ${album.title || ''}`}
                  >
                    <CoverImage
                      source={album.coverArt}
                      style={styles.albumCover}
                    />
                    <View style={styles.albumInfo}>
                      <Text
                        style={styles.albumTitle}
                        numberOfLines={1}
                        ellipsizeMode="tail"
                      >
                        {album.title}
                      </Text>
                      {Boolean(album.year) && (
                        <Text
                          style={styles.albumYear}
                          numberOfLines={1}
                          ellipsizeMode="tail"
                        >
                          {String(album.year)}
                        </Text>
                      )}
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="#555" />
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : (
            <View style={styles.emptyContainer} testID="no-albums-state">
              <Text style={styles.emptyText}>Нет альбомов</Text>
            </View>
          )}
        </View>

        <View style={styles.footerSpacer} />
      </ScrollView>
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
    marginRight: 12,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
  },
  editButton: {
    marginLeft: 12,
  },
  headerSpacer: {
    width: 22,
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
  stateSubText: {
    color: '#666',
    fontSize: 13,
    textAlign: 'center',
    maxWidth: 260,
  },
  actionButton: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#1c1c1e',
    marginTop: 8,
  },
  actionButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
  scrollContent: {
    paddingBottom: 40,
  },
  artistHero: {
    alignItems: 'center',
    paddingVertical: 28,
    paddingHorizontal: 20,
  },
  avatarImage: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: '#1c1c1e',
    marginBottom: 16,
  },
  avatarPlaceholder: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: '#1c1c1e',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  artistName: {
    fontSize: 26,
    fontWeight: 'bold',
    color: '#fff',
    textAlign: 'center',
  },
  artistStats: {
    fontSize: 14,
    color: '#8e8e93',
    marginTop: 6,
    textAlign: 'center',
  },
  section: {
    marginTop: 16,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 12,
  },
  tracksContainer: {
    gap: 2,
  },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  trackNumber: {
    fontSize: 15,
    fontWeight: '600',
    color: '#8e8e93',
    width: 24,
    textAlign: 'center',
    marginRight: 8,
  },
  trackThumb: {
    width: 40,
    height: 40,
    borderRadius: 6,
    backgroundColor: '#1c1c1e',
    marginRight: 12,
  },
  trackInfo: {
    flex: 1,
    marginRight: 10,
  },
  trackTitle: {
    fontSize: 16,
    fontWeight: '500',
    color: '#fff',
    marginBottom: 2,
  },
  trackMeta: {
    fontSize: 13,
    color: '#8e8e93',
  },
  trackDuration: {
    fontSize: 14,
    color: '#8e8e93',
    marginRight: 8,
  },
  ellipsisBtn: {
    padding: 4,
  },
  albumsContainer: {
    gap: 8,
  },
  albumRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  albumCover: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: '#1c1c1e',
    marginRight: 12,
  },
  albumInfo: {
    flex: 1,
    marginRight: 8,
  },
  albumTitle: {
    fontSize: 16,
    fontWeight: '500',
    color: '#fff',
    marginBottom: 2,
  },
  albumYear: {
    fontSize: 13,
    color: '#8e8e93',
  },
  emptyContainer: {
    paddingVertical: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: '#8e8e93',
  },
  footerSpacer: {
    height: 100,
  },
});
