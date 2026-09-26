import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Minimize2, Play, Pause, SkipBack, SkipForward, Disc3, ListPlus } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useLyrics } from '../../hooks/useLyrics';
import { getCoverUrl } from '../../api/tracks';
import { Track } from '../../types/track';
import styles from './FullPlayerModal.module.css';

interface FullPlayerModalProps {
  onAddToPlaylist?: (track: Track) => void;
}

export const FullPlayerModal: React.FC<FullPlayerModalProps> = ({ onAddToPlaylist }) => {
  const isFullscreen = usePlayerStore((state) => state.isFullscreen);
  const setIsFullscreen = usePlayerStore((state) => state.setIsFullscreen);
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const status = usePlayerStore((state) => state.status);
  const togglePlay = usePlayerStore((state) => state.togglePlay);
  const nextTrack = usePlayerStore((state) => state.nextTrack);
  const previousTrack = usePlayerStore((state) => state.previousTrack);
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const isAuthorized = Boolean(token && user);

  const { lyrics, activeIndex, seek } = useLyrics();
  const activeLineRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    if (activeLineRef.current) {
      activeLineRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [activeIndex]);

  const coverUrl = getCoverUrl(currentTrack?.cover_id);
  const isPlaying = status === 'playing';

  return (
    <AnimatePresence>
      {isFullscreen && (
        <motion.div
          className={styles.overlay}
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.98 }}
          transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
          role="dialog"
          aria-modal="true"
          aria-label="Полноэкранный плеер"
        >
          {/* Ambient Glow Background */}
          <div className={styles.ambientGlow} />

          {/* Top Bar */}
          <header className={styles.header}>
            <div className={styles.headerMeta}>
              <span className={styles.brandTitle}>puuk</span>
              <span className={styles.subMeta}>ПОЛНОЭКРАННЫЙ РЕЖИМ</span>
            </div>

            <button
              type="button"
              className={styles.closeBtn}
              onClick={() => setIsFullscreen(false)}
              title="Закрыть полноэкранный режим (Esc / F)"
              aria-label="Закрыть"
            >
              <Minimize2 size={20} />
            </button>
          </header>

          {/* Center Stage: Artwork Left, Giant Lyrics Right */}
          <div className={styles.stageGrid}>
            <div className={styles.artworkCol}>
              <div className={styles.coverWrapper}>
                {coverUrl ? (
                  <img src={coverUrl} alt="" className={styles.coverImg} />
                ) : (
                  <div className={styles.placeholderCover}>
                    <Disc3 size={84} />
                  </div>
                )}
              </div>

              <div className={styles.trackDetails}>
                <h1 className={styles.title}>{currentTrack?.title || 'Нет трека'}</h1>
                <p className={styles.artist}>{currentTrack?.artist || '—'}</p>
                {currentTrack?.album && <span className={styles.album}>{currentTrack.album}</span>}
                {currentTrack && isAuthorized && onAddToPlaylist && (
                  <button
                    type="button"
                    className={styles.addToPlaylistBtn}
                    onClick={() => onAddToPlaylist(currentTrack)}
                    title="Добавить в плейлист"
                    aria-label="Добавить в плейлист"
                  >
                    <ListPlus size={16} />
                    <span>В плейлист</span>
                  </button>
                )}
              </div>

              {/* Minimal transport */}
              <div className={styles.transport}>
                <button
                  type="button"
                  className={styles.navBtn}
                  onClick={previousTrack}
                  aria-label="Предыдущий трек"
                >
                  <SkipBack size={24} />
                </button>
                <button
                  type="button"
                  className={styles.playBtn}
                  onClick={togglePlay}
                  aria-label={isPlaying ? 'Пауза' : 'Воспроизведение'}
                >
                  {isPlaying ? <Pause size={28} /> : <Play size={28} className={styles.playIcon} />}
                </button>
                <button
                  type="button"
                  className={styles.navBtn}
                  onClick={nextTrack}
                  aria-label="Следующий трек"
                >
                  <SkipForward size={24} />
                </button>
              </div>
            </div>

            {/* Giant Karaoke Stream */}
            <div className={styles.lyricsCol}>
              <div className={styles.lyricsScroll}>
                {lyrics.length > 0 ? (
                  lyrics.map((line, index) => {
                    const isActive = index === activeIndex;
                    const isPassed = index < activeIndex;

                    return (
                      <p
                        key={`${line.time}-${index}`}
                        ref={isActive ? activeLineRef : null}
                        className={`${styles.lyricLine} ${isActive ? styles.activeLine : ''} ${
                          isPassed ? styles.passedLine : ''
                        }`}
                        onClick={() => seek(line.time)}
                      >
                        {line.text}
                      </p>
                    );
                  })
                ) : (
                  <div className={styles.emptyLyrics}>
                    <p>Текст для этого трека отсутствует</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
