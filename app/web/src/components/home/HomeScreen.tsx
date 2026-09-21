import React, { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  ArrowLeft,
  Play,
  Pause,
  Music2,
  Disc3,
  X,
  Loader2,
  User,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useAuthStore } from '../../store/useAuthStore';
import { fetchTracks, fetchFavorites, getCoverUrl, searchTracks } from '../../api/tracks';
import { useDebounce } from '../../hooks/useDebounce';
import { Album, Artist, Track } from '../../types/track';
import { PlaylistsView, PlaylistGridItem } from '../../views/PlaylistsView';
import { PlaylistDetail } from '../../views/PlaylistDetail';
import { AlbumDetail } from '../../views/AlbumDetail';
import styles from './HomeScreen.module.css';

import { DEMO_MIX } from './demoMix';
import {
  FreshMixCard,
  RecentlyListenedCard,
  FavoritesCard,
  FreshTracksCard,
} from './islands/HomeIslands';
import { RecommendationShelf } from './islands/RecommendationShelf';

interface HomeScreenProps {
  onOpenAuth: () => void;
}

export const HomeScreen: React.FC<HomeScreenProps> = ({ onOpenAuth }) => {
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const status = usePlayerStore((state) => state.status);
  const playTrack = usePlayerStore((state) => state.playTrack);
  const togglePlay = usePlayerStore((state) => state.togglePlay);
  const toggleWave = usePlayerStore((state) => state.toggleWave);
  const isWaveActive = usePlayerStore((state) => state.isWaveActive);
  const history = usePlayerStore((state) => state.history);
  const recentlyPlayed = usePlayerStore((state) => state.recentlyPlayed);
  const loadHistory = usePlayerStore((state) => state.loadHistory);
  const user = useAuthStore((state) => state.user);

  // Load listening history from backend on mount / when user changes
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'home' | 'library' | 'search'>('home');
  const [selectedAlbum, setSelectedAlbum] = useState<Album | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<PlaylistGridItem | null>(null);

  // Username: "fish" as drawn in sketch, or auth user if logged in
  const displayName = user?.username || 'fish';

  // Fetch real tracks from backend
  const { data: serverTracks = [] } = useQuery({
    queryKey: ['tracks'],
    queryFn: () => fetchTracks({ limit: 40 }),
  });

  const { data: serverFavorites = [] } = useQuery({
    queryKey: ['favorites'],
    queryFn: () => fetchFavorites(),
  });

  // Effective track sources
  const allTracks = useMemo(() => {
    return serverTracks.length > 0 ? serverTracks : DEMO_MIX;
  }, [serverTracks]);

  const favorites = useMemo(() => {
    return serverFavorites.length > 0 ? serverFavorites : allTracks.slice(0, 5);
  }, [serverFavorites, allTracks]);

  const recentTracks = useMemo(() => {
    if (recentlyPlayed.length > 0) return recentlyPlayed.slice(0, 3);
    if (history.length > 0) return history.slice(0, 3);
    return allTracks.slice(0, 2);
  }, [recentlyPlayed, history, allTracks]);

  const freshTracks = useMemo(() => {
    return allTracks.slice(2, 6);
  }, [allTracks]);

  const recommendedTracks = useMemo(() => {
    return allTracks.slice(0, 8);
  }, [allTracks]);

  // Filtered search results if user types in top search pill
  const debouncedQuery = useDebounce(searchQuery, 280);

  const { data: searchData, isLoading: isSearchLoading } = useQuery({
    queryKey: ['search', debouncedQuery],
    queryFn: () => searchTracks(debouncedQuery, 20),
    enabled: debouncedQuery.trim().length > 0,
    staleTime: 15000,
  });

  const searchResults = useMemo(() => {
    if (!searchData) return { tracks: [], albums: [], artists: [] as Artist[] };
    return {
      tracks: searchData.tracks || [],
      albums: searchData.albums || [],
      artists: searchData.artists || [],
    };
  }, [searchData]);

  const hasSearchContent = searchResults.tracks.length > 0 ||
    searchResults.albums.length > 0 ||
    searchResults.artists.length > 0;

  const isCurrentPlaying = (trackId: string) => currentTrack?.id === trackId && status === 'playing';

  const handleTrackItemClick = (track: Track) => {
    if (currentTrack?.id === track.id) {
      togglePlay();
    } else {
      playTrack(track, allTracks);
    }
  };

  const handleAlbumClick = (album: Album) => {
    setSelectedAlbum(album);
  };

  const handleArtistClick = (artist: Artist) => {
    setSearchQuery(artist.name);
  };

  const handleClearSearch = () => {
    setSearchQuery('');
    setActiveTab('home');
  };

  const handleLaunchWave = () => {
    if (!isWaveActive && allTracks.length > 0 && !currentTrack) {
      playTrack(allTracks[0], allTracks);
    }
    toggleWave();
  };

  return (
    <div className={styles.screenWrapper}>
      {/* 1. Left Capsule (Sidebar Island) */}
      <aside className={styles.sidebarIsland} aria-label="Navigation">
        <div className={styles.brandGroup}>
          <h1 className={styles.brandTitle}>puuk</h1>
          <span className={styles.brandSub}>user</span>
        </div>

        <nav className={styles.navGroup}>
          <button
            type="button"
            className={`${styles.navItem} ${activeTab === 'home' ? styles.activeNavItem : ''}`}
            onClick={() => setActiveTab('home')}
          >
            home
          </button>

          <button
            type="button"
            className={`${styles.navItem} ${activeTab === 'library' ? styles.activeNavItem : ''}`}
            onClick={() => {
              setActiveTab('library');
              setSearchQuery('');
            }}
          >
            library
          </button>

          <button
            type="button"
            className={`${styles.navItem} ${activeTab === 'search' ? styles.activeNavItem : ''}`}
            onClick={() => {
              setActiveTab('search');
              const input = document.getElementById('sketch-search-input');
              input?.focus();
            }}
          >
            search
          </button>
        </nav>

        {/* Subtle decorative bottom space inside pill */}
        <div className={styles.sidebarFooter}>
          <div className={styles.capsuleGlowDot} />
        </div>
      </aside>

      {/* 2. Main Content Stage */}
      <main className={styles.mainContent}>
        {/* Top Header Bar: Search Capsule & fish User Pill */}
        <header className={styles.topHeaderBar}>
          <div className={styles.searchCapsule}>
            <input
              id="sketch-search-input"
              type="text"
              placeholder="search"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setActiveTab('search');
              }}
              className={styles.searchInput}
            />
            {searchQuery.length > 0 && (
              <button
                type="button"
                className={styles.searchClearBtn}
                onClick={handleClearSearch}
                aria-label="Очистить поиск"
              >
                <X size={15} />
              </button>
            )}
            <Search size={17} className={styles.searchIcon} />
          </div>

          <button
            type="button"
            className={styles.userProfilePill}
            onClick={onOpenAuth}
            title={user ? `Пользователь: ${displayName}` : 'Войти в аккаунт'}
          >
            <span className={styles.userName}>{displayName}</span>
            <div className={styles.userAvatar}>
              <User size={15} />
            </div>
          </button>
        </header>

        {/* Collection detail view — opened when an album or playlist is clicked */}
        {(selectedAlbum || selectedPlaylist) && (
          <motion.section
            className={styles.albumDetailStage}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
          >
            <button
              type="button"
              className={styles.albumBackBtn}
              onClick={() => {
                setSelectedAlbum(null);
                setSelectedPlaylist(null);
              }}
              title="Назад"
            >
              <ArrowLeft size={16} />
              <span>Назад</span>
            </button>

            {selectedAlbum && <AlbumDetail album={selectedAlbum} />}

            {selectedPlaylist && (
              <PlaylistDetail
                playlistId={selectedPlaylist.id}
                isFavorites={selectedPlaylist.isFavorites}
              />
            )}
          </motion.section>
        )}

        {/* Inline Search Results Overlay if search query is active */}
        {!selectedAlbum && !selectedPlaylist && (searchQuery.trim().length > 0 ? (<motion.section
          className={styles.searchResultsIsland}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
        >
          <div className={styles.searchHeaderRow}>
            <div className={styles.searchTitleGroup}>
              <span className={styles.searchEyebrow}>search</span>
              <span className={styles.handwrittenTitle}>
                {searchQuery.trim().length === 1 ? 'ещё пара букв…' : 'результаты'}
              </span>
            </div>

            {searchQuery.trim().length > 1 && !isSearchLoading && hasSearchContent && (
              <span className={styles.searchCountBadge}>
                {searchResults.tracks.length + searchResults.albums.length + searchResults.artists.length}
              </span>
            )}
          </div>

          {searchQuery.trim().length === 1 ? (
            <p className={styles.searchHint}>Введите минимум 2 символа, чтобы начать поиск.</p>
          ) : isSearchLoading ? (
            <div className={styles.searchState}>
              <Loader2 size={18} className={styles.searchSpinner} />
              <span>Ищем «{searchQuery.trim()}» в каталоге…</span>
            </div>
          ) : !hasSearchContent ? (
            <div className={styles.searchState}>
              <Music2 size={20} className={styles.searchStateIcon} />
              <span>По запросу «{searchQuery.trim()}» ничего не найдено.</span>
            </div>
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={debouncedQuery}
                className={styles.searchGroups}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
              >
                {searchResults.tracks.length > 0 && (
                  <div className={styles.searchGroup}>
                    <div className={styles.groupLabelRow}>
                      <span className={styles.groupLabel}>Треки</span>
                      <span className={styles.groupHairline} />
                      <span className={styles.groupCount}>{searchResults.tracks.length}</span>
                    </div>

                    <div className={styles.resultTracksList}>
                      {searchResults.tracks.map((track) => (
                        <div
                          key={track.id}
                          className={styles.resultTrackRow}
                          onClick={() => handleTrackItemClick(track)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => e.key === 'Enter' && handleTrackItemClick(track)}
                        >
                          {getCoverUrl(track) ? (
                            <img
                              src={getCoverUrl(track)}
                              alt=""
                              className={styles.resultCover}
                              loading="lazy"
                            />
                          ) : (
                            <div className={styles.resultCoverFallback}>
                              <Music2 size={14} />
                            </div>
                          )}

                          <div className={styles.trackPillMeta}>
                            <span className={styles.pillTrackTitle}>{track.title}</span>
                            <span className={styles.pillTrackArtist}>
                              {track.artist}
                              {track.album ? ` • ${track.album}` : ''}
                            </span>
                          </div>

                          <button
                            type="button"
                            className={styles.miniPlayBtn}
                            aria-label="Воспроизвести"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleTrackItemClick(track);
                            }}
                          >
                            {isCurrentPlaying(track.id) ? (
                              <Pause size={14} fill="currentColor" />
                            ) : (
                              <Play size={14} fill="currentColor" />
                            )}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {searchResults.albums.length > 0 && (
                  <div className={styles.searchGroup}>
                    <div className={styles.groupLabelRow}>
                      <span className={styles.groupLabel}>Альбомы</span>
                      <span className={styles.groupHairline} />
                      <span className={styles.groupCount}>{searchResults.albums.length}</span>
                    </div>

                    <div className={styles.resultShelf}>
                      {searchResults.albums.map((album) => (
                        <button
                          key={album.id}
                          type="button"
                          className={styles.resultShelfCard}
                          onClick={() => handleAlbumClick(album)}
                          title={`Показать треки альбома «${album.title}»`}
                        >
                          <div className={styles.resultShelfCover}>
                            {getCoverUrl(album) ? (
                              <img src={getCoverUrl(album)} alt="" className={styles.resultShelfImg} loading="lazy" />
                            ) : (
                              <div className={styles.resultShelfFallback}>
                                <Disc3 size={22} />
                              </div>
                            )}
                          </div>
                          <span className={styles.resultShelfTitle}>{album.title}</span>
                          <span className={styles.resultShelfMeta}>
                            {album.artist}
                            {album.track_count ? ` • ${album.track_count} трек.` : ''}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {searchResults.artists.length > 0 && (
                  <div className={styles.searchGroup}>
                    <div className={styles.groupLabelRow}>
                      <span className={styles.groupLabel}>Артисты</span>
                      <span className={styles.groupHairline} />
                      <span className={styles.groupCount}>{searchResults.artists.length}</span>
                    </div>

                    <div className={styles.resultShelf}>
                      {searchResults.artists.map((artist) => (
                        <button
                          key={artist.name}
                          type="button"
                          className={styles.resultShelfCard}
                          onClick={() => handleArtistClick(artist)}
                          title={`Показать треки ${artist.name}`}
                        >
                          <div className={`${styles.resultShelfCover} ${styles.resultArtistCover}`}>
                            {getCoverUrl(artist.coverArt || '') ? (
                              <img
                                src={getCoverUrl(artist.coverArt || '')}
                                alt=""
                                className={styles.resultShelfImg}
                                loading="lazy"
                              />
                            ) : (
                              <div className={styles.resultShelfFallback}>
                                <Music2 size={22} />
                              </div>
                            )}
                          </div>
                          <span className={styles.resultShelfTitle}>{artist.name}</span>
                          <span className={styles.resultShelfMeta}>
                            {artist.track_count} трек. • {artist.album_count} альб.
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          )}
        </motion.section>
        ) : activeTab === 'library' ? (
          /* Playlists grid — library page inside the main stage */
          <PlaylistsView onOpen={setSelectedPlaylist} />
        ) : (
          <>
            {/* Greeting */}
            <div className={styles.greetingSection}>
              <h2 className={styles.greetingTitle}>welcome, {displayName}</h2>
            </div>

            {/* 3. Hero Islands 2x2 Layout from Sketch */}
            <div className={styles.islandsGrid}>
              <FreshMixCard
                isWaveActive={isWaveActive}
                isPlaying={status === 'playing'}
                onLaunchWave={handleLaunchWave}
              />

              <RecentlyListenedCard
                tracks={recentTracks}
                isCurrentPlaying={isCurrentPlaying}
                onTrackClick={handleTrackItemClick}
              />

              <FavoritesCard
                favorites={favorites}
                onPlayFirst={() => favorites[0] && handleTrackItemClick(favorites[0])}
              />

              <FreshTracksCard
                tracks={freshTracks}
                isCurrentPlaying={isCurrentPlaying}
                onTrackClick={handleTrackItemClick}
              />
            </div>

            {/* 4. Recommendation Shelf */}
            <RecommendationShelf
              tracks={recommendedTracks}
              isCurrentPlaying={isCurrentPlaying}
              onTrackClick={handleTrackItemClick}
            />
          </>
        ))}
      </main>
    </div>
  );
};
