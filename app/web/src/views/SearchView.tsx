import React from 'react';
import { Search, Play, Pause, Heart, Music2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { usePlayerStore } from '../store/usePlayerStore';
import { fetchTracks, getCoverUrl } from '../api/tracks';
import { Track } from '../types/track';
import styles from './SearchView.module.css';

function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

interface SearchViewProps {
  searchQuery: string;
}

export const SearchView: React.FC<SearchViewProps> = ({ searchQuery }) => {
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const status = usePlayerStore((state) => state.status);
  const playTrack = usePlayerStore((state) => state.playTrack);
  const togglePlay = usePlayerStore((state) => state.togglePlay);
  const toggleLike = usePlayerStore((state) => state.toggleLike);

  const { data: tracks = [], isLoading } = useQuery({
    queryKey: ['search', searchQuery],
    queryFn: () => fetchTracks({ search: searchQuery }),
    enabled: searchQuery.trim().length > 0,
    staleTime: 15000,
  });

  const isPlaying = status === 'playing';

  const handleTrackClick = (track: Track) => {
    if (currentTrack?.id === track.id) {
      togglePlay();
    } else {
      playTrack(track, tracks);
    }
  };

  if (!searchQuery.trim()) {
    return (
      <div className={styles.emptyWrap}>
        <Search size={36} className={styles.emptyIcon} />
        <h2 className={styles.emptyTitle}>Поиск музыки в Puuk</h2>
        <p className={styles.emptySubtitle}>
          Введите название песни, имя исполнителя или название альбома в строке выше (или нажмите клавишу /)
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={styles.loadingWrap}>
        <span>Поиск по каталогу...</span>
      </div>
    );
  }

  if (tracks.length === 0) {
    return (
      <div className={styles.emptyWrap}>
        <Music2 size={36} className={styles.emptyIcon} />
        <h2 className={styles.emptyTitle}>Ничего не найдено</h2>
        <p className={styles.emptySubtitle}>
          По запросу «{searchQuery}» ничего не найдено. Попробуйте изменить ключевые слова.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.searchContainer}>
      <div className={styles.header}>
        <h2 className={styles.title}>Результаты поиска</h2>
        <span className={styles.countBadge}>{tracks.length} найдено</span>
      </div>

      <div className={styles.trackTable}>
        <div className={styles.tableHeaderRow}>
          <div className={styles.colIndex}>#</div>
          <div className={styles.colTitle}>НАЗВАНИЕ</div>
          <div className={styles.colAlbum}>АЛЬБОМ</div>
          <div className={styles.colDuration}>ВРЕМЯ</div>
          <div className={styles.colActions}></div>
        </div>

        {tracks.map((track, index) => {
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
                  className={`${styles.likeBtn} ${track.is_liked ? styles.liked : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleLike(track.id);
                  }}
                  title={track.is_liked ? 'Удалить из избранного' : 'В избранное'}
                >
                  <Heart
                    size={15}
                    fill={track.is_liked ? 'var(--accent-color)' : 'none'}
                  />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
