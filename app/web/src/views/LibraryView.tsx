import React from 'react';
import { Heart, Play, Pause, Music2, ListPlus } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { usePlayerStore } from '../store/usePlayerStore';
import { fetchFavorites, getCoverUrl } from '../api/tracks';
import { Track } from '../types/track';
import styles from './LibraryView.module.css';
import { useAuthStore } from '../store/useAuthStore';

function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

interface LibraryViewProps {
  onAddToPlaylist?: (track: Track) => void;
}

export const LibraryView: React.FC<LibraryViewProps> = ({ onAddToPlaylist }) => {
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const status = usePlayerStore((state) => state.status);
  const playTrack = usePlayerStore((state) => state.playTrack);
  const togglePlay = usePlayerStore((state) => state.togglePlay);
  const toggleLike = usePlayerStore((state) => state.toggleLike);
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const isAuthorized = Boolean(token && user);

  const { data: favorites = [], isLoading } = useQuery({
    queryKey: ['favorites', userId],
    queryFn: () => fetchFavorites(),
    staleTime: 10000,
    enabled: Boolean(token && user),
  });

  const isPlaying = status === 'playing';

  const handleTrackClick = (track: Track) => {
    if (currentTrack?.id === track.id) {
      togglePlay();
    } else {
      playTrack(track, favorites);
    }
  };

  return (
    <div className={styles.libraryContainer}>
      <header className={styles.headerBanner}>
        <div className={styles.bannerIcon}>
          <Heart size={36} fill="#ffffff" />
        </div>
        <div className={styles.bannerMeta}>
          <span className={styles.bannerSubtitle}>ПЛЕЙЛИСТ</span>
          <h1 className={styles.bannerTitle}>Любимые треки</h1>
          <span className={styles.bannerStats}>
            {favorites.length} {favorites.length === 1 ? 'трек' : 'треков'}
          </span>
        </div>
      </header>

      {isLoading ? (
        <div className={styles.loadingWrap}>
          <span>Загрузка медиатеки...</span>
        </div>
      ) : favorites.length === 0 ? (
        <div className={styles.emptyWrap}>
          <Music2 size={36} className={styles.emptyIcon} />
          <h2 className={styles.emptyTitle}>В избранном пока пусто</h2>
          <p className={styles.emptySubtitle}>
            Нажимайте на сердечко у любых понравившихся треков, чтобы собрать свою коллекцию.
          </p>
        </div>
      ) : (
        <div className={styles.trackTable}>
          <div className={styles.tableHeaderRow}>
            <div className={styles.colIndex}>#</div>
            <div className={styles.colTitle}>НАЗВАНИЕ</div>
            <div className={styles.colAlbum}>АЛЬБОМ</div>
            <div className={styles.colDuration}>ВРЕМЯ</div>
            <div className={styles.colActions}></div>
          </div>

          {favorites.map((track, index) => {
            const isCurrent = currentTrack?.id === track.id;
            const isCurrentPlaying = isCurrent && isPlaying;
            const cover = getCoverUrl(track.cover_id);

            return (
              <div
                key={track.id}
                className={`${styles.tableRow} ${isCurrent ? styles.activeRow : ''}`}
                onClick={() => handleTrackClick(track)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && handleTrackClick(track)}
              >
                <div className={styles.colIndex}>
                  {isCurrentPlaying ? (
                    <Pause size={14} className={styles.activePlayIcon} />
                  ) : (
                    <span className={styles.indexNum}>{index + 1}</span>
                  )}
                  <Play size={14} className={styles.hoverPlayIcon} />
                </div>

                <div className={styles.colTitle}>
                  {cover ? (
                    <img src={cover} alt="" className={styles.rowCover} loading="lazy" />
                  ) : (
                    <div className={styles.rowCoverPlaceholder}>
                      <Music2 size={14} />
                    </div>
                  )}
                  <div className={styles.rowMeta}>
                    <span className={styles.titleText}>{track.title}</span>
                    <span className={styles.artistText}>{track.artist}</span>
                  </div>
                </div>

                <div className={styles.colAlbum}>
                  <span>{track.album || '—'}</span>
                </div>

                <div className={styles.colDuration}>
                  <span className="tabular-nums">{formatDuration(track.duration)}</span>
                </div>

                <div className={styles.colActions}>
                  <button
                    type="button"
                    className={`${styles.likeBtn} ${styles.liked}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleLike(track.id);
                    }}
                    title="Удалить из избранного"
                  >
                    <Heart size={15} fill="var(--accent-color)" />
                  </button>

                  {isAuthorized && onAddToPlaylist && (
                    <button
                      type="button"
                      className={styles.likeBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        onAddToPlaylist(track);
                      }}
                      title="Добавить в плейлист"
                      aria-label="Добавить в плейлист"
                    >
                      <ListPlus size={15} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
