import React, { useState, useMemo, useEffect, useRef } from 'react';
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
  ListPlus,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useAlbumNavigationStore } from '../../store/useAlbumNavigationStore';
import { fetchTracks, fetchFavorites, getCoverUrl, searchTracks } from '../../api/tracks';
import { AuthorizedImage } from '../common/AuthorizedImage';
import { useDebounce } from '../../hooks/useDebounce';
import { Album, Artist, Track } from '../../types/track';
import { PlaylistsView, PlaylistGridItem } from '../../views/PlaylistsView';
import { PlaylistDetail } from '../../views/PlaylistDetail';
import { AlbumDetail } from '../../views/AlbumDetail';
import type { PersonalizedPlaylistSection } from '../../types/recommendations';
import { PlaylistFormModal } from '../playlists/PlaylistFormModal';
import { UploadMusicModal } from '../playlists/UploadMusicModal';
import { ProfileCapsuleMenu } from '../profile/ProfileCapsuleMenu';
import styles from './HomeScreen.module.css';

import { DEMO_MIX } from './demoMix';
import {
  FreshMixCard,
  YoullLikeThisCard,
  FavoritesCard,
  FreshTracksCard,
} from './islands/HomeIslands';
import { RecommendationShelf } from './islands/RecommendationShelf';
import { WideTrackInfoIsland } from '../player/TrackInfoIslands';

interface HomeScreenProps {
  onOpenAuth: () => void;
  onAddToPlaylist: (track: Track) => void;
}

export const HomeScreen: React.FC<HomeScreenProps> = ({ onOpenAuth, onAddToPlaylist }) => {
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const status = usePlayerStore((state) => state.status);
  const playTrack = usePlayerStore((state) => state.playTrack);
  const togglePlay = usePlayerStore((state) => state.togglePlay);
  const toggleWave = usePlayerStore((state) => state.toggleWave);
  const isWaveActive = usePlayerStore((state) => state.isWaveActive);
  const loadHistory = usePlayerStore((state) => state.loadHistory);
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const isAuthLoading = useAuthStore((state) => state.isLoading);

  // Load listening history from backend on mount / when user changes
  useEffect(() => {
    if (token && user) loadHistory();
    else usePlayerStore.getState().resetUserData();
  }, [loadHistory, token, user]);

  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'home' | 'library' | 'search'>('home');
  const [selectedAlbum, setSelectedAlbum] = useState<Album | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<PlaylistGridItem | null>(null);
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false);
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const profilePillRef = useRef<HTMLButtonElement>(null);
  const mainContentRef = useRef<HTMLElement | null>(null);

  const handleProfileClick = () => {
    if (!user) {
      onOpenAuth();
    } else {
      setIsProfileMenuOpen((prev) => !prev);
    }
  };
  const [isPlaylistFormOpen, setIsPlaylistFormOpen] = useState(false);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const createMenuRef = useRef<HTMLDivElement | null>(null);
  const queryClient = useQueryClient();
  const pendingAlbum = useAlbumNavigationStore((state) => state.pendingAlbum);
  const consumePendingAlbum = useAlbumNavigationStore((state) => state.consumePendingAlbum);

  // Album requested from another surface (e.g. the Library drawer): open its detail.
  useEffect(() => {
    if (!pendingAlbum) return;
    const album = consumePendingAlbum();
    if (!album) return;
    setSelectedPlaylist(null);
    setSelectedAlbum(album);
    setActiveTab('home');
  }, [pendingAlbum, consumePendingAlbum]);

  const isAuthorized = Boolean(!isAuthLoading && token && user);

  // Close the "+" create menu on outside click
  useEffect(() => {
    if (!isCreateMenuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (createMenuRef.current && !createMenuRef.current.contains(e.target as Node)) {
        setIsCreateMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isCreateMenuOpen]);

  // Username: "fish" as drawn in sketch, or auth user if logged in
  const displayName = user?.username || 'fish';

  // Fetch real tracks from backend
  const { data: serverTracks = [] } = useQuery({
    queryKey: ['tracks'],
    queryFn: () => fetchTracks({ limit: 40 }),
  });

  const { data: serverFavorites = [] } = useQuery({
    queryKey: ['favorites', user?.id ?? null],
    queryFn: () => fetchFavorites(),
    enabled: Boolean(!isAuthLoading && token && user),
  });

  // Effective track sources
  const allTracks = useMemo(() => {
    return serverTracks.length > 0 ? serverTracks : DEMO_MIX;
  }, [serverTracks]);

  const favorites = useMemo(() => {
    return serverFavorites;
  }, [serverFavorites]);

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

  const handleGoHome = () => {
    setActiveTab('home');
    setSelectedAlbum(null);
    setSelectedPlaylist(null);
    setSearchQuery('');
    setIsCreateMenuOpen(false);
    setIsProfileMenuOpen(false);
    if (mainContentRef.current) {
      mainContentRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleClearSearch = () => {
    handleGoHome();
  };

  const handleNavChange = (tab: 'home' | 'library' | 'search') => {
    if (tab === 'home') {
      handleGoHome();
      return;
    }
    setActiveTab(tab);
    setSelectedAlbum(null);
    setSelectedPlaylist(null);
  };

  const handleLaunchWave = async () => {
    await toggleWave();
  };

  const handleOpenPersonalizedPlaylist = (section: PersonalizedPlaylistSection) => {
    setSelectedPlaylist({
      id: `personalized-${section.id}`,
      name: section.title,
      coverUrl: getCoverUrl(section.tracks[0]),
      trackCount: section.tracks.length,
      subtitle: section.description,
      tracks: section.tracks,
    });
  };

  const handlePlaylistCreated = (playlist: { id: string | number; name: string; is_public?: boolean }) => {
    void queryClient.invalidateQueries({ queryKey: ['playlists', user?.id ?? null] });
    setIsPlaylistFormOpen(false);
    setSelectedPlaylist({
      id: String(playlist.id),
      name: playlist.name,
      trackCount: 0,
      subtitle: playlist.is_public ? 'Публичный' : 'Личный',
    });
  };

  const handlePlaylistDeleted = (playlistId: string) => {
    setSelectedPlaylist((current) => (current && current.id === playlistId ? null : current));
  };

  return (
    <div className={styles.screenWrapper}>
      {/* 1. Left Capsule (Sidebar Island) */}
      <aside className={styles.sidebarIsland} aria-label="Navigation">
        <div className={styles.brandGroup}>
          <h1
            className={styles.brandTitle}
            onClick={handleGoHome}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleGoHome();
              }
            }}
            title="Перейти на главную"
            aria-label="puuk — перейти на главную"
          >
            puuk
          </h1>
        </div>

        <nav className={styles.navGroup}>
          <button
            type="button"
            className={`${styles.navItem} ${activeTab === 'home' ? styles.activeNavItem : ''}`}
            onClick={() => handleNavChange('home')}
          >
            home
          </button>

          <button
            type="button"
            className={`${styles.navItem} ${activeTab === 'library' ? styles.activeNavItem : ''}`}
            onClick={() => {
              handleNavChange('library');
              setSearchQuery('');
            }}
          >
            library
          </button>

          <button
            type="button"
            className={`${styles.navItem} ${activeTab === 'search' ? styles.activeNavItem : ''}`}
            onClick={() => {
              handleNavChange('search');
              const input = document.getElementById('sketch-search-input');
              input?.focus();
            }}
          >
            search
          </button>
        </nav>

        {/* Create section: playlists / uploads (authorized only) */}
        {isAuthorized && (
          <div className={styles.createGroup} ref={createMenuRef}>
            <button
              type="button"
              className={`${styles.createBtn} ${isCreateMenuOpen ? styles.createBtnActive : ''}`}
              onClick={() => setIsCreateMenuOpen((v) => !v)}
              aria-expanded={isCreateMenuOpen}
              title="Создать плейлист или загрузить музыку"
            >
              create
            </button>

            <AnimatePresence initial={false}>
              {isCreateMenuOpen && (
                <motion.div
                  className={styles.createMenu}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
                  role="menu"
                  aria-label="Создать"
                >
                  <button
                    type="button"
                    className={styles.createMenuItem}
                    role="menuitem"
                    onClick={() => {
                      setIsCreateMenuOpen(false);
                      setIsPlaylistFormOpen(true);
                    }}
                  >
                    <span>Playlist</span>
                  </button>
                  <button
                    type="button"
                    className={styles.createMenuItem}
                    role="menuitem"
                    onClick={() => {
                      setIsCreateMenuOpen(false);
                      setIsUploadOpen(true);
                    }}
                  >
                    <span>Upload music</span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* Subtle decorative bottom space inside pill */}
        <div className={styles.sidebarFooter}>
          <div className={styles.capsuleGlowDot} />
        </div>
      </aside>

      {/* 2. Main Content Stage */}
      <main ref={mainContentRef} className={styles.mainContent}>
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

          <div className={styles.userProfileAnchor}>
            <button
              ref={profilePillRef}
              type="button"
              className={styles.userProfilePill}
              onClick={handleProfileClick}
              title={user ? `Пользователь: ${displayName}` : 'Войти в аккаунт'}
              aria-expanded={isProfileMenuOpen}
              aria-haspopup="dialog"
            >
              <span className={styles.userName}>{displayName}</span>
              <div className={styles.userAvatar}>
                <User size={15} />
              </div>
            </button>
            <ProfileCapsuleMenu
              isOpen={isProfileMenuOpen}
              onClose={() => setIsProfileMenuOpen(false)}
              user={user}
              anchorRef={profilePillRef}
            />
          </div>
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
                name={selectedPlaylist.name}
                subtitle={selectedPlaylist.subtitle}
                coverUrl={selectedPlaylist.coverUrl}
                tracks={selectedPlaylist.tracks}
                onAddToPlaylist={onAddToPlaylist}
                onDeletedDetail={handlePlaylistDeleted}
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
                            <AuthorizedImage
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

                          {isAuthorized && (
                            <button
                              type="button"
                              className={styles.miniPlayBtn}
                              aria-label="Добавить в плейлист"
                              title="Добавить в плейлист"
                              onClick={(e) => {
                                e.stopPropagation();
                                onAddToPlaylist(track);
                              }}
                            >
                              <ListPlus size={14} />
                            </button>
                          )}
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
                              <AuthorizedImage src={getCoverUrl(album)} alt="" className={styles.resultShelfImg} loading="lazy" />
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
                              <AuthorizedImage
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
          <PlaylistsView
            onOpen={setSelectedPlaylist}
            onDeleted={handlePlaylistDeleted}
            onCreated={handlePlaylistCreated}
          />
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

              <YoullLikeThisCard
                onOpenPlaylist={handleOpenPersonalizedPlaylist}
              />

              <FavoritesCard
                favorites={favorites}
                onPlayFirst={() => favorites[0] && handleTrackItemClick(favorites[0])}
              />

              <FreshTracksCard
                tracks={freshTracks}
                isCurrentPlaying={isCurrentPlaying}
                onTrackClick={handleTrackItemClick}
                onAddToPlaylist={isAuthorized ? onAddToPlaylist : undefined}
              />
            </div>

            {/* 4. Recommendation Shelf */}
            <RecommendationShelf
              tracks={recommendedTracks}
              isCurrentPlaying={isCurrentPlaying}
              onTrackClick={handleTrackItemClick}
              onAddToPlaylist={onAddToPlaylist}
            />
          </>
        ))}
        </main>

        {/* Create playlist / upload music modals */}
        <PlaylistFormModal
          isOpen={isPlaylistFormOpen}
          mode="create"
          onClose={() => setIsPlaylistFormOpen(false)}
          onSuccess={handlePlaylistCreated}
        />
        <UploadMusicModal isOpen={isUploadOpen} onClose={() => setIsUploadOpen(false)} />

        <WideTrackInfoIsland />
      </div>
  );
};
