import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Search,
  Music2,
  Play,
  Pause,
  Heart,
  Radio,
  FolderOpen,
  Sparkles,
  Tag,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useTagEditorStore } from '../../store/useTagEditorStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useAlbumNavigationStore } from '../../store/useAlbumNavigationStore';
import { fetchTracks, fetchAlbums, getCoverUrl } from '../../api/tracks';
import { AuthorizedImage } from '../common/AuthorizedImage';
import { Track, Album } from '../../types/track';
import styles from './LibraryDrawer.module.css';

function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

interface LibraryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export const LibraryDrawer: React.FC<LibraryDrawerProps> = ({ isOpen, onClose }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'wave' | 'albums' | 'favorites'>('all');

  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const status = usePlayerStore((state) => state.status);
  const playTrack = usePlayerStore((state) => state.playTrack);
  const togglePlay = usePlayerStore((state) => state.togglePlay);
  const toggleLike = usePlayerStore((state) => state.toggleLike);
  const isWaveActive = usePlayerStore((state) => state.isWaveActive);
  const toggleWave = usePlayerStore((state) => state.toggleWave);
  const setIsLoginOpen = usePlayerStore((state) => state.setIsLoginOpen);
  const openTagEditor = useTagEditorStore((state) => state.openTagEditor);
  const requestOpenAlbum = useAlbumNavigationStore((state) => state.requestOpenAlbum);
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
    }
  }, [isOpen]);

  const { data: serverTracks = [] } = useQuery({
    queryKey: ['tracks', searchQuery, user?.id ?? null],
    queryFn: () => fetchTracks({ search: searchQuery }),
    staleTime: 30000,
  });

  const { data: albums = [] } = useQuery({
    queryKey: ['albums'],
    queryFn: () => fetchAlbums(),
    staleTime: 60000,
  });

  const tracks = serverTracks;
  const isPlaying = status === 'playing';

  const displayedTracks =
    activeTab === 'favorites' ? tracks.filter((t) => t.is_liked) : tracks;

  const handleTrackClick = (track: Track) => {
    if (currentTrack?.id === track.id) {
      togglePlay();
    } else {
      playTrack(track, tracks);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className={styles.backdrop} onClick={onClose}>
          <motion.div
            className={styles.drawer}
            onClick={(e) => e.stopPropagation()}
            initial={{ x: '-100%', opacity: 0.8 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '-100%', opacity: 0.8 }}
            transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
            role="dialog"
            aria-label="Музыкальная библиотека"
          >
            {/* Header with Search and Close */}
            <header className={styles.header}>
              <div className={styles.searchWrap}>
                <Search size={16} className={styles.searchIcon} />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="Поиск по библиотеке..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={styles.searchInput}
                />
                {searchQuery && (
                  <button
                    type="button"
                    className={styles.clearBtn}
                    onClick={() => setSearchQuery('')}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              <button
                type="button"
                className={styles.closeBtn}
                onClick={onClose}
                aria-label="Закрыть библиотеку"
              >
                <X size={20} />
              </button>
            </header>

            {/* Segmented Filter Tabs */}
            <div className={styles.tabsRow}>
              <button
                type="button"
                className={`${styles.tabBtn} ${activeTab === 'all' ? styles.tabActive : ''}`}
                onClick={() => setActiveTab('all')}
              >
                <Music2 size={14} />
                <span>Все треки</span>
              </button>

              <button
                type="button"
                className={`${styles.tabBtn} ${activeTab === 'wave' ? styles.tabActive : ''}`}
                onClick={() => setActiveTab('wave')}
              >
                <Radio size={14} />
                <span>Моя Волна</span>
              </button>

              <button
                type="button"
                className={`${styles.tabBtn} ${activeTab === 'albums' ? styles.tabActive : ''}`}
                onClick={() => setActiveTab('albums')}
              >
                <FolderOpen size={14} />
                <span>Альбомы</span>
              </button>

              <button
                type="button"
                className={`${styles.tabBtn} ${activeTab === 'favorites' ? styles.tabActive : ''}`}
                onClick={() => setActiveTab('favorites')}
              >
                <Heart size={14} />
                <span>Избранное</span>
              </button>
            </div>

            {/* Content Body */}
            <div className={styles.scrollArea}>
              {/* Wave Banner */}
              {activeTab === 'wave' && (
                <div className={styles.waveBanner}>
                  <div className={styles.waveMeta}>
                    <div className={styles.waveTag}>
                      <Sparkles size={12} />
                      <span>НЕЙРОСЕТЕВОЙ ПОТОК</span>
                    </div>
                    <h3 className={styles.waveTitle}>Моя Волна</h3>
                    <p className={styles.waveDesc}>
                      Бесконечный радиопоток на основе Qdrant векторов и ваших реакций.
                    </p>
                  </div>
                  <button
                    type="button"
                    className={styles.waveBtn}
                    onClick={toggleWave}
                  >
                    {isWaveActive && isPlaying ? <Pause size={16} /> : <Play size={16} />}
                    <span>{isWaveActive && isPlaying ? 'Пауза' : 'Включить'}</span>
                  </button>
                </div>
              )}

              {/* Albums View */}
              {activeTab === 'albums' ? (
                <div className={styles.albumGrid}>
                  {albums.map((album: Album) => {
                    const cover = getCoverUrl(album);
                    return (
                      <button
                        key={album.id}
                        type="button"
                        className={`${styles.albumCard} ${styles.albumCardBtn}`}
                        onClick={() => {
                          requestOpenAlbum(album);
                          onClose();
                        }}
                        title={`Открыть альбом «${album.title}»`}
                      >
                        <div className={styles.albumCoverWrap}>
                          {cover ? (
                            <AuthorizedImage src={cover} alt={album.title} className={styles.albumImg} />
                          ) : (
                            <div className={styles.albumPlaceholder}>
                              <FolderOpen size={28} />
                            </div>
                          )}
                        </div>
                        <span className={styles.albumName}>{album.title}</span>
                        <span className={styles.albumArtist}>
                          {album.album_artist || album.artist}
                          {album.year ? ` · ${album.year}` : ''}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                /* Tracks Table */
                <div className={styles.trackList}>
                  {displayedTracks.map((track) => {
                    const isCurrent = currentTrack?.id === track.id;
                    const isCurrentPlaying = isCurrent && isPlaying;
                    const cover = getCoverUrl(track);

                    return (
                      <div
                        key={track.id}
                        className={`${styles.trackRow} ${isCurrent ? styles.activeTrackRow : ''}`}
                        onClick={() => handleTrackClick(track)}
                      >
                        <div className={styles.rowCoverWrap}>
                          {cover ? (
                            <AuthorizedImage src={cover} alt="" className={styles.rowCover} />
                          ) : (
                            <div className={styles.placeholderIcon}>
                              <Music2 size={16} />
                            </div>
                          )}
                          <div className={styles.rowPlayOverlay}>
                            {isCurrentPlaying ? <Pause size={14} /> : <Play size={14} />}
                          </div>
                        </div>

                        <div className={styles.rowMeta}>
                          <span className={styles.rowTitle}>{track.title}</span>
                          <span className={styles.rowArtist}>{track.artist}</span>
                        </div>

                        <span className={styles.rowDuration}>
                          {formatDuration(track.duration)}
                        </span>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <button
                            type="button"
                            className={styles.rowLikeBtn}
                            title="Редактировать теги ID3"
                            aria-label="Редактировать теги ID3"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!token) {
                                setIsLoginOpen(true);
                                return;
                              }
                              openTagEditor(track);
                            }}
                          >
                            <Tag size={15} />
                          </button>

                          <button
                            type="button"
                            className={`${styles.rowLikeBtn} ${track.is_liked ? styles.liked : ''}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleLike(track.id);
                            }}
                          >
                            <Heart
                              size={16}
                              fill={track.is_liked ? 'var(--accent-color)' : 'none'}
                            />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
