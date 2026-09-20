import React, { useRef, useState } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Repeat1,
  ListMusic,
  Music2,
  Sparkles,
  Captions,
  Tag,
} from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useTagEditorStore } from '../../store/useTagEditorStore';
import { getCoverUrl } from '../../api/tracks';
import { LyricsQuickPeek } from './LyricsQuickPeek';
import { WaveProfileIndicator } from './WaveProfileIndicator';
import styles from './FloatingPlayerDock.module.css';

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

interface FloatingPlayerDockProps {
  onOpenLyrics?: () => void;
  isLyricsActive?: boolean;
}

export const FloatingPlayerDock: React.FC<FloatingPlayerDockProps> = ({
  onOpenLyrics,
  isLyricsActive = false,
}) => {
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const status = usePlayerStore((state) => state.status);
  const currentTime = usePlayerStore((state) => state.currentTime);
  const duration = usePlayerStore((state) => state.duration);
  const isShuffled = usePlayerStore((state) => state.isShuffled);
  const repeatMode = usePlayerStore((state) => state.repeatMode);
  const isWaveActive = usePlayerStore((state) => state.isWaveActive);

  const togglePlay = usePlayerStore((state) => state.togglePlay);
  const nextTrack = usePlayerStore((state) => state.nextTrack);
  const previousTrack = usePlayerStore((state) => state.previousTrack);
  const seek = usePlayerStore((state) => state.seek);
  const toggleShuffle = usePlayerStore((state) => state.toggleShuffle);
  const setRepeatMode = usePlayerStore((state) => state.setRepeatMode);
  const toggleRightPanel = usePlayerStore((state) => state.toggleRightPanel);
  const openTagEditor = useTagEditorStore((state) => state.openTagEditor);

  const [isLyricsPeekOpen, setIsLyricsPeekOpen] = useState(false);
  const lyricsBtnRef = useRef<HTMLButtonElement | null>(null);

  const handleToggleRepeat = () => {
    if (repeatMode === 'off') setRepeatMode('all');
    else if (repeatMode === 'all') setRepeatMode('one');
    else setRepeatMode('off');
  };

  const [isHoveringScrubber, setIsHoveringScrubber] = useState(false);
  const [hoverPositionPercent, setHoverPositionPercent] = useState(0);
  const scrubberRef = useRef<HTMLDivElement | null>(null);

  const isPlaying = status === 'playing';
  const progressPercent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const coverUrl = getCoverUrl(currentTrack);

  const handleScrubberClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!scrubberRef.current || duration <= 0) return;
    const rect = scrubberRef.current.getBoundingClientRect();
    const clickX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const targetSeconds = (clickX / rect.width) * duration;
    seek(targetSeconds);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!scrubberRef.current) return;
    const rect = scrubberRef.current.getBoundingClientRect();
    const hoverX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    setHoverPositionPercent((hoverX / rect.width) * 100);
  };

  return (
    <div className={styles.dockContainer} role="region" aria-label="Floating Player Dock">
      {/* 1. Left Pill: Shuffle & Repeat */}
      <div className={`${styles.glassCapsule} ${styles.modesCapsule}`}>
        <button
          type="button"
          onClick={toggleShuffle}
          className={`${styles.modeBtn} ${isShuffled ? styles.activeMode : ''}`}
          title={isShuffled ? 'Перемешивание включено' : 'Перемешать'}
          aria-label="Toggle shuffle"
        >
          <Shuffle size={16} />
          {isShuffled && <span className={styles.activeDot} />}
        </button>

        <button
          type="button"
          onClick={handleToggleRepeat}
          className={`${styles.modeBtn} ${repeatMode !== 'off' ? styles.activeMode : ''}`}
          title={
            repeatMode === 'one'
              ? 'Повторять один трек'
              : repeatMode === 'all'
                ? 'Повторять всю очередь'
                : 'Повтор выключен'
          }
          aria-label="Toggle repeat"
        >
          {repeatMode === 'one' ? <Repeat1 size={16} /> : <Repeat size={16} />}
          {repeatMode !== 'off' && <span className={styles.activeDot} />}
        </button>
      </div>

      {/* 2. Transport Controls Capsule (Prev, Play/Pause, Next) */}
      <div className={`${styles.glassCapsule} ${styles.transportCapsule}`}>
        <button
          type="button"
          onClick={previousTrack}
          className={styles.transportBtn}
          title="Предыдущий трек"
          aria-label="Previous track"
        >
          <SkipBack size={18} />
        </button>

        <button
          type="button"
          onClick={togglePlay}
          className={`${styles.transportBtn} ${styles.playPauseBtn}`}
          title={isPlaying ? 'Пауза' : 'Воспроизведение'}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
        </button>

        <button
          type="button"
          onClick={nextTrack}
          className={styles.transportBtn}
          title="Следующий трек"
          aria-label="Next track"
        >
          <SkipForward size={18} />
        </button>
      </div>

      {/* 3. Main Capsule: Artwork, Metadata, Scrubber, Badges */}
      <div className={`${styles.glassCapsule} ${styles.centerDeckCapsule}`}>
        {/* Cover thumbnail */}
        <div
          className={styles.coverWrapper}
          onClick={onOpenLyrics}
          title="Открыть полный плеер и текст"
        >
          {coverUrl ? (
            <img
              src={coverUrl}
              alt={currentTrack?.title || 'Cover'}
              className={styles.coverImg}
            />
          ) : (
            <div className={styles.fallbackCover}>
              <Music2 size={18} className={styles.fallbackIcon} />
            </div>
          )}
          {isWaveActive && (
            <div className={styles.waveBadge} title="Моя Волна">
              <Sparkles size={10} />
            </div>
          )}
        </div>

        {/* Track Title & Artist */}
        <div className={styles.trackInfo}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className={styles.trackTitle} title={currentTrack?.title || 'Не играет'}>
              {currentTrack?.title || 'Выберите трек для воспроизведения'}
            </span>
            {isWaveActive && <WaveProfileIndicator compact />}
          </div>
          <span className={styles.trackArtist} title={currentTrack?.artist || ''}>
            {currentTrack?.artist || 'Puuk Music'}
          </span>
        </div>

        {/* Scrubber Timeline */}
        <div className={styles.timelineArea}>
          <span className={styles.timeLabel}>{formatTime(currentTime)}</span>

          <div
            className={styles.scrubberTrack}
            ref={scrubberRef}
            onClick={handleScrubberClick}
            onMouseEnter={() => setIsHoveringScrubber(true)}
            onMouseLeave={() => setIsHoveringScrubber(false)}
            onMouseMove={handleMouseMove}
          >
            <div
              className={styles.progressBar}
              style={{ width: `${progressPercent}%` }}
            >
              <div className={styles.scrubberThumb} />
            </div>

            {isHoveringScrubber && (
              <div
                className={styles.hoverGuide}
                style={{ left: `${hoverPositionPercent}%` }}
              />
            )}
          </div>

          <span className={styles.timeLabel}>{formatTime(duration)}</span>
        </div>

        {/* Lyrics & Queue toggles */}
        <div className={styles.centerActions}>
          <LyricsQuickPeek
            expanded={isLyricsPeekOpen}
            onClose={() => setIsLyricsPeekOpen(false)}
            triggerRef={lyricsBtnRef}
          />

          <button
            ref={lyricsBtnRef}
            type="button"
            onClick={() => setIsLyricsPeekOpen((v) => !v)}
            className={`${styles.actionIconBtn} ${isLyricsPeekOpen || isLyricsActive ? styles.activeActionBtn : ''}`}
            title={isLyricsPeekOpen ? 'Скрыть текст' : 'Текст песни'}
            aria-label="Toggle lyrics peek"
            aria-expanded={isLyricsPeekOpen}
          >
            <Captions size={17} />
          </button>

          <button
            type="button"
            onClick={() => toggleRightPanel('queue')}
            className={styles.actionIconBtn}
            title="Очередь воспроизведения"
            aria-label="Open queue"
          >
            <ListMusic size={17} />
          </button>

          {currentTrack && (
            <button
              type="button"
              onClick={() => openTagEditor(currentTrack)}
              className={styles.actionIconBtn}
              title="Редактировать теги ID3"
              aria-label="Редактировать теги"
            >
              <Tag size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
