import React from 'react';
import { Heart, Music2 } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { getCoverUrl } from '../../api/tracks';
import styles from './TrackInfoSummary.module.css';

interface TrackInfoSummaryProps {
  compact?: boolean;
}

export const TrackInfoSummary: React.FC<TrackInfoSummaryProps> = ({ compact = false }) => {
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const toggleLike = usePlayerStore((state) => state.toggleLike);
  const coverUrl = getCoverUrl(currentTrack);

  return (
    <div className={`${styles.summary} ${compact ? styles.compact : ''}`}>
      <div className={styles.cover}>
        {coverUrl ? (
          <img src={coverUrl} alt={currentTrack?.title || 'Обложка трека'} />
        ) : (
          <Music2 size={compact ? 24 : 36} />
        )}
      </div>
      <div className={styles.meta}>
        <span className={styles.title}>{currentTrack?.title || 'Трек не выбран'}</span>
        <span className={styles.artist}>{currentTrack?.artist || 'Выберите трек из каталога'}</span>
        {currentTrack?.album && <span className={styles.album}>{currentTrack.album}</span>}
      </div>
      {currentTrack && (
        <button
          type="button"
          className={`${styles.likeButton} ${currentTrack.is_liked ? styles.liked : ''}`}
          onClick={() => toggleLike(currentTrack.id)}
          aria-label={currentTrack.is_liked ? 'Удалить из избранного' : 'Добавить в избранное'}
          title={currentTrack.is_liked ? 'Удалить из избранного' : 'Добавить в избранное'}
        >
          <Heart size={compact ? 19 : 21} fill={currentTrack.is_liked ? 'currentColor' : 'none'} />
        </button>
      )}
    </div>
  );
};
