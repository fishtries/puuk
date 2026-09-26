import React, { useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Repeat1,
  Music2,
  Captions,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useTagEditorStore } from '../../store/useTagEditorStore';
import { useAuthStore } from '../../store/useAuthStore';
import { getCoverUrl, fetchPlaylists, addTrackToPlaylist } from '../../api/tracks';
import { Track } from '../../types/track';
import { LyricsQuickPeek } from './LyricsQuickPeek';
import { DockActionsMenu } from './DockActionsMenu';
import { DockLikeMenu } from './DockLikeMenu';
import styles from './FloatingPlayerDock.module.css';

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const MARQUEE_SPEED_PX_PER_SEC = 24;
const MARQUEE_MIN_DURATION_S = 4;

interface MarqueeLabelProps {
  text: string;
  className: string;
}

const MarqueeLabel: React.FC<MarqueeLabelProps> = ({ text, className }) => {
  const viewportRef = useRef<HTMLSpanElement | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [overflowDistance, setOverflowDistance] = useState(0);

  useEffect(() => {
    const measure = () => {
      const viewport = viewportRef.current;
      const textMeasure = measureRef.current;
      if (!viewport || !textMeasure) return;
      const distance = textMeasure.getBoundingClientRect().width - viewport.clientWidth;
      setOverflowDistance(distance > 1 ? distance : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (viewportRef.current) observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [text]);

  const duration = overflowDistance > 0
    ? Math.max(overflowDistance / MARQUEE_SPEED_PX_PER_SEC, MARQUEE_MIN_DURATION_S)
    : 0;

  return (
    <span ref={viewportRef} className={className}>
      <span ref={measureRef} className={styles.marqueeMeasure} aria-hidden="true">
        {text}
      </span>
      {overflowDistance > 0 ? (
        <span
          className={styles.marqueeTrack}
          style={{ animationDuration: `${duration.toFixed(2)}s` }}
        >
          <span className={styles.marqueeCopy}>{text}</span>
          <span aria-hidden className={styles.marqueeCopy}>{text}</span>
        </span>
      ) : (
        text
      )}
    </span>
  );
};

interface FloatingPlayerDockProps {
  onOpenLyrics?: () => void;
  isLyricsActive?: boolean;
  onAddToPlaylist?: (track: Track) => void;
}

export const FloatingPlayerDock: React.FC<FloatingPlayerDockProps> = ({
  onOpenLyrics,
  isLyricsActive = false,
  onAddToPlaylist,
}) => {
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const status = usePlayerStore((state) => state.status);
  const currentTime = usePlayerStore((state) => state.currentTime);
  const duration = usePlayerStore((state) => state.duration);
  const isShuffled = usePlayerStore((state) => state.isShuffled);
  const repeatMode = usePlayerStore((state) => state.repeatMode);

  const togglePlay = usePlayerStore((state) => state.togglePlay);
  const nextTrack = usePlayerStore((state) => state.nextTrack);
  const previousTrack = usePlayerStore((state) => state.previousTrack);
  const seek = usePlayerStore((state) => state.seek);
  const toggleShuffle = usePlayerStore((state) => state.toggleShuffle);
  const setRepeatMode = usePlayerStore((state) => state.setRepeatMode);
  const isTrackInfoOpen = usePlayerStore((state) => state.isTrackInfoOpen);
  const toggleTrackInfo = usePlayerStore((state) => state.toggleTrackInfo);
  const toggleLike = usePlayerStore((state) => state.toggleLike);
  const openTagEditor = useTagEditorStore((state) => state.openTagEditor);
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const userId = user?.id ?? null;
  const isAuthorized = Boolean(token && user);

  const [isLyricsPeekOpen, setIsLyricsPeekOpen] = useState(false);
  const lyricsBtnRef = useRef<HTMLButtonElement | null>(null);

  const { data: playlists = [], isPending: isPlaylistsPending } = useQuery({
    queryKey: ['playlists', userId],
    queryFn: () => fetchPlaylists(),
    enabled: isAuthorized,
    staleTime: 30000,
  });

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
    <div
      className={`${styles.dockContainer} ${isTrackInfoOpen ? styles.dockHiddenOnCompact : ''}`}
      data-track-info-open={isTrackInfoOpen}
      role="region"
      aria-label="Floating Player Dock"
    >
      {/* 1. Left Pill: Shuffle & Repeat */}
      <div className={`${styles.glassCapsule} ${styles.modesCapsule}`}>
        <button
          type="button"
          onClick={toggleShuffle}
          className={`${styles.modeBtn} ${isShuffled ? styles.activeMode : ''}`}
          title={isShuffled ? 'Перемешивание включено' : 'Перемешать'}
          aria-label="Toggle shuffle"
        >
          <Shuffle size={18} />
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
          {repeatMode === 'one' ? <Repeat1 size={18} /> : <Repeat size={18} />}
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
          <SkipBack size={20} />
        </button>

        <button
          type="button"
          onClick={togglePlay}
          className={`${styles.transportBtn} ${styles.playPauseBtn}`}
          title={isPlaying ? 'Пауза' : 'Воспроизведение'}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
        </button>

        <button
          type="button"
          onClick={nextTrack}
          className={styles.transportBtn}
          title="Следующий трек"
          aria-label="Next track"
        >
          <SkipForward size={20} />
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
              <Music2 size={20} className={styles.fallbackIcon} />
            </div>
          )}
        </div>

        {/* Track Title & Artist */}
        <div className={styles.trackInfo}>
          <MarqueeLabel
            text={currentTrack?.title || 'Выберите трек для воспроизведения'}
            className={styles.trackTitle}
          />
          <MarqueeLabel
            text={currentTrack?.artist || 'Puuk Music'}
            className={styles.trackArtist}
          />
        </div>

        {/* Like Button (left side, right after metadata) */}
        {currentTrack && isAuthorized && (
          <DockLikeMenu
            isLiked={Boolean(currentTrack.is_liked)}
            onLike={() => toggleLike(currentTrack.id)}
            onRemoveFromFavorites={() => toggleLike(currentTrack.id)}
            playlists={playlists}
            isPlaylistsLoading={isPlaylistsPending}
            onAddToPlaylist={(playlist) => addTrackToPlaylist(playlist.id, currentTrack.id)}
          />
        )}

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
            <Captions size={19} />
          </button>

          <DockActionsMenu
            isQueueInfoActive={isTrackInfoOpen}
            onToggleQueueInfo={toggleTrackInfo}
            onEditTags={currentTrack ? () => openTagEditor(currentTrack) : undefined}
            onAddToPlaylist={
              currentTrack && isAuthorized && onAddToPlaylist
                ? () => onAddToPlaylist(currentTrack)
                : undefined
            }
          />
        </div>
      </div>
    </div>
  );
};
