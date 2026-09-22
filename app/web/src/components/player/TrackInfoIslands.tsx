import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { ClearQueueButton, QueueList } from '../queue/QueueList';
import { TrackInfoSummary } from './TrackInfoSummary';
import styles from './TrackInfoIslands.module.css';

function formatTime(seconds: number): string {
  if (!seconds || Number.isNaN(seconds)) return '0:00';
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}

const IslandMotion = {
  type: 'spring' as const,
  duration: 0.42,
  bounce: 0.12,
};

export const WideTrackInfoIsland: React.FC = () => {
  const isOpen = usePlayerStore((state) => state.isTrackInfoOpen);
  const reducedMotion = useReducedMotion();

  return (
    <aside className={`${styles.wideSlot} ${isOpen ? styles.wideSlotOpen : ''}`} aria-label="Информация о текущем треке">
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.aside
            className={styles.wideIsland}
            initial={{ opacity: 0, transform: 'translateX(24px)' }}
            animate={{ opacity: 1, transform: 'translateX(0)' }}
            exit={{ opacity: 0, transform: 'translateX(24px)' }}
            transition={reducedMotion ? { duration: 0 } : IslandMotion}
          >
            <TrackInfoSummary />
            <div className={styles.queueSection}>
              <div className={styles.sectionHeader}>
                <span className={styles.sectionLabel}>Очередь</span>
                <ClearQueueButton />
              </div>
              <QueueList />
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </aside>
  );
};

export const CompactTrackInfoIsland: React.FC = () => {
  const isOpen = usePlayerStore((state) => state.isTrackInfoOpen);
  const currentTime = usePlayerStore((state) => state.currentTime);
  const duration = usePlayerStore((state) => state.duration);
  const status = usePlayerStore((state) => state.status);
  const togglePlay = usePlayerStore((state) => state.togglePlay);
  const previousTrack = usePlayerStore((state) => state.previousTrack);
  const nextTrack = usePlayerStore((state) => state.nextTrack);
  const seek = usePlayerStore((state) => state.seek);
  const setIsTrackInfoOpen = usePlayerStore((state) => state.setIsTrackInfoOpen);
  const reducedMotion = useReducedMotion();
  const isPlaying = status === 'playing';

  return (
    <AnimatePresence initial={false}>
      {isOpen && (
        <motion.aside
          className={styles.compactIsland}
          initial={{ opacity: 0, transform: 'translateX(-50%) translateY(18px) scaleX(0.82)' }}
          animate={{ opacity: 1, transform: 'translateX(-50%) translateY(0) scaleX(1)' }}
          exit={{ opacity: 0, transform: 'translateX(-50%) translateY(18px) scaleX(0.82)' }}
          transition={reducedMotion ? { duration: 0 } : {
            ...IslandMotion,
            delay: isOpen ? 0.27 : 0,
          }}
          aria-label="Расширенный плеер"
        >
          <div className={styles.compactMain}>
            <TrackInfoSummary compact />
            <div className={styles.progressRow}>
              <span>{formatTime(currentTime)}</span>
              <input
                type="range"
                min={0}
                max={duration || 100}
                step={0.1}
                value={currentTime}
                onChange={(event) => seek(Number(event.target.value))}
                aria-label="Перемотка трека"
              />
              <span>{formatTime(duration)}</span>
            </div>
            <div className={styles.transport}>
              <button type="button" onClick={previousTrack} aria-label="Предыдущий трек" title="Предыдущий трек">
                <SkipBack size={18} />
              </button>
              <button type="button" className={styles.playButton} onClick={togglePlay} aria-label={isPlaying ? 'Пауза' : 'Воспроизведение'}>
                {isPlaying ? <Pause size={18} /> : <Play size={18} fill="currentColor" />}
              </button>
              <button type="button" onClick={nextTrack} aria-label="Следующий трек" title="Следующий трек">
                <SkipForward size={18} />
              </button>
            </div>
          </div>
          <div className={styles.compactQueue}>
            <div className={styles.queueHeader}>
              <span>Очередь</span>
              <div className={styles.queueActions}>
                <ClearQueueButton />
                <button type="button" onClick={() => setIsTrackInfoOpen(false)} aria-label="Закрыть расширенный плеер" title="Закрыть">
                  ×
                </button>
              </div>
            </div>
            <QueueList />
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
};
