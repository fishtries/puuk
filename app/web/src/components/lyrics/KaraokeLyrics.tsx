import React, { useEffect, useRef } from 'react';
import { Music, RefreshCw } from 'lucide-react';
import { useLyrics } from '../../hooks/useLyrics';
import { usePlayerStore } from '../../store/usePlayerStore';
import { LyricsLine } from '../../types/track';
import styles from './KaraokeLyrics.module.css';

interface KaraokeLineRowProps {
  line: LyricsLine;
  index: number;
  isActive: boolean;
  isPassed: boolean;
  activeLineRef: React.RefObject<HTMLParagraphElement | null> | null;
  onSeek: (time: number) => void;
}

const KaraokeLineRow: React.FC<KaraokeLineRowProps> = React.memo(
  ({ line, isActive, isPassed, activeLineRef, onSeek }) => {
    return (
      <p
        ref={isActive && activeLineRef ? activeLineRef : null}
        className={`${styles.lyricLine} ${isActive ? styles.activeLine : ''} ${
          isPassed ? styles.passedLine : ''
        }`}
        onClick={() => onSeek(line.time)}
        title={`Перемотать на ${Math.floor(line.time)}с`}
      >
        <span className={styles.lineLevelText}>{line.text}</span>
      </p>
    );
  }
);

export const KaraokeLyrics: React.FC = () => {
  const { lyrics, activeIndex, isLyricsLoading, seek } = useLyrics();
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const fetchLyrics = usePlayerStore((state) => state.fetchLyrics);
  const activeLineRef = useRef<HTMLParagraphElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const handleRefetch = () => {
    if (currentTrack) {
      fetchLyrics(currentTrack.id, true);
    }
  };

  useEffect(() => {
    if (activeLineRef.current && containerRef.current) {
      activeLineRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [activeIndex]);

  if (!currentTrack) {
    return (
      <div className={styles.emptyContainer}>
        <Music size={28} className={styles.emptyIcon} />
        <span className={styles.emptyTitle}>Текст песни не активен</span>
        <span className={styles.emptySubtitle}>Включите трек для отображения синхронизированных строк</span>
      </div>
    );
  }

  if (isLyricsLoading) {
    return (
      <div className={styles.loadingContainer}>
        <RefreshCw size={22} className={styles.spinner} />
        <span>Загрузка синхронизированного текста...</span>
      </div>
    );
  }

  if (lyrics.length === 0) {
    return (
      <div className={styles.emptyContainer}>
        <Music size={24} className={styles.emptyIcon} />
        <span className={styles.emptyTitle}>Текст песни не найден</span>
        <span className={styles.emptySubtitle}>Для этого трека пока нет разметки LRC</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <button
            type="button"
            className={styles.retryBtn}
            onClick={handleRefetch}
            title="Заново запросить текст из LRCLIB"
          >
            <RefreshCw size={12} style={{ marginRight: 6 }} />
            <span>Повторить поиск текста</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.lyricsContainer} ref={containerRef}>
      <div className={styles.karaokeToolbar} style={{ gap: 6, alignItems: 'center' }}>
        <button
          type="button"
          className={styles.refreshBtn}
          onClick={handleRefetch}
          title="Заново обновить текст из LRCLIB"
        >
          <RefreshCw size={11} />
        </button>
      </div>
      <div className={styles.lyricsList}>
        {lyrics.map((line, index) => {
          const isActive = index === activeIndex;
          const isPassed = index < activeIndex;

          return (
            <KaraokeLineRow
              key={`${line.time}-${index}`}
              line={line}
              index={index}
              isActive={isActive}
              isPassed={isPassed}
              activeLineRef={activeLineRef}
              onSeek={seek}
            />
          );
        })}
      </div>
    </div>
  );
};
