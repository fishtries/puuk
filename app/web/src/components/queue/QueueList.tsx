import React from 'react';
import { Trash2, Music, X } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import styles from './QueueList.module.css';

function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export const QueueList: React.FC = () => {
  const queue = usePlayerStore((state) => state.queue);
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const playTrack = usePlayerStore((state) => state.playTrack);
  const removeFromQueue = usePlayerStore((state) => state.removeFromQueue);
  const clearQueue = usePlayerStore((state) => state.clearQueue);

  if (queue.length === 0) {
    return (
      <div className={styles.emptyWrap}>
        <Music size={28} className={styles.emptyIcon} />
        <span className={styles.emptyTitle}>Очередь воспроизведения пуста</span>
        <span className={styles.emptySubtitle}>Добавьте треки из каталога или альбома</span>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <span className={styles.count}>{queue.length} треков в очереди</span>
        <button
          type="button"
          className={styles.clearBtn}
          onClick={clearQueue}
          title="Очистить очередь"
        >
          <Trash2 size={13} />
          <span>Очистить</span>
        </button>
      </header>

      <div className={styles.trackList}>
        {queue.map((track, index) => {
          const isCurrent = currentTrack?.id === track.id;
          return (
            <div
              key={`${track.id}-${index}`}
              className={`${styles.trackRow} ${isCurrent ? styles.activeTrackRow : ''}`}
              onClick={() => playTrack(track)}
            >
              <span className={styles.indexCol}>{index + 1}</span>
              <div className={styles.metaCol}>
                <span className={styles.title}>{track.title}</span>
                <span className={styles.artist}>{track.artist}</span>
              </div>
              <span className={styles.durationCol}>
                {formatDuration(track.duration)}
              </span>
              <button
                type="button"
                className={styles.removeBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  removeFromQueue(index);
                }}
                title="Удалить из очереди"
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};
