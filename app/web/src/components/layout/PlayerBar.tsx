import React from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Repeat1,
  Volume2,
  VolumeX,
  Heart,
  ListMusic,
  AlignLeft,
  Maximize2,
  Disc3,
} from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { getCoverUrl } from '../../api/tracks';
import styles from './PlayerBar.module.css';

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export const PlayerBar: React.FC = () => {
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const status = usePlayerStore((state) => state.status);
  const currentTime = usePlayerStore((state) => state.currentTime);
  const duration = usePlayerStore((state) => state.duration);
  const volume = usePlayerStore((state) => state.volume);
  const isMuted = usePlayerStore((state) => state.isMuted);
  const repeatMode = usePlayerStore((state) => state.repeatMode);
  const isShuffled = usePlayerStore((state) => state.isShuffled);
  const isRightPanelOpen = usePlayerStore((state) => state.isRightPanelOpen);
  const rightPanelTab = usePlayerStore((state) => state.rightPanelTab);

  const togglePlay = usePlayerStore((state) => state.togglePlay);
  const seek = usePlayerStore((state) => state.seek);
  const setVolume = usePlayerStore((state) => state.setVolume);
  const toggleMute = usePlayerStore((state) => state.toggleMute);
  const nextTrack = usePlayerStore((state) => state.nextTrack);
  const previousTrack = usePlayerStore((state) => state.previousTrack);
  const setRepeatMode = usePlayerStore((state) => state.setRepeatMode);
  const toggleShuffle = usePlayerStore((state) => state.toggleShuffle);
  const toggleRightPanel = usePlayerStore((state) => state.toggleRightPanel);
  const setIsFullscreen = usePlayerStore((state) => state.setIsFullscreen);
  const toggleLike = usePlayerStore((state) => state.toggleLike);

  const isPlaying = status === 'playing';
  const coverUrl = getCoverUrl(currentTrack?.cover_id);
  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  const handleNextRepeat = () => {
    if (repeatMode === 'off') setRepeatMode('all');
    else if (repeatMode === 'all') setRepeatMode('one');
    else setRepeatMode('off');
  };

  return (
    <footer className={styles.playerBar} aria-label="Панель воспроизведения">
      {/* 1. Left: Track Details */}
      <div className={styles.leftCol}>
        <div
          className={styles.coverWrap}
          onClick={() => setIsFullscreen(true)}
          title="Развернуть полноэкранный плеер (F)"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && setIsFullscreen(true)}
        >
          {coverUrl ? (
            <img
              src={coverUrl}
              alt=""
              className={`${styles.coverImg} ${isPlaying ? styles.coverPlaying : ''}`}
            />
          ) : (
            <div className={styles.coverPlaceholder}>
              <Disc3 size={24} className={isPlaying ? styles.spinIcon : ''} />
            </div>
          )}
        </div>

        <div className={styles.trackMeta}>
          <span className={styles.trackTitle}>
            {currentTrack ? currentTrack.title : 'Трек не выбран'}
          </span>
          <span className={styles.trackArtist}>
            {currentTrack ? currentTrack.artist : 'Выберите трек из каталога'}
          </span>
        </div>

        {currentTrack && (
          <button
            type="button"
            className={`${styles.likeBtn} ${currentTrack.is_liked ? styles.liked : ''}`}
            onClick={() => toggleLike(currentTrack.id)}
            title={currentTrack.is_liked ? 'Удалить из избранного' : 'Добавить в избранное'}
            aria-label="Лайк"
          >
            <Heart
              size={18}
              fill={currentTrack.is_liked ? 'var(--accent-color)' : 'none'}
            />
          </button>
        )}
      </div>

      {/* 2. Center: Controls & Scrubber */}
      <div className={styles.centerCol}>
        <div className={styles.transportButtons}>
          <button
            type="button"
            className={`${styles.smallBtn} ${isShuffled ? styles.activeBtn : ''}`}
            onClick={toggleShuffle}
            title={isShuffled ? 'Случайный порядок: Вкл' : 'Случайный порядок: Выкл'}
            aria-label="Случайный порядок"
          >
            <Shuffle size={16} />
          </button>

          <button
            type="button"
            className={styles.navBtn}
            onClick={previousTrack}
            disabled={!currentTrack}
            title="Предыдущий трек (Shift + ←)"
            aria-label="Предыдущий трек"
          >
            <SkipBack size={20} />
          </button>

          {/* Master Play with Optical Centering (translateX: 1.5px) */}
          <button
            type="button"
            className={styles.masterPlayBtn}
            onClick={togglePlay}
            disabled={!currentTrack}
            title={isPlaying ? 'Пауза (Space)' : 'Воспроизведение (Space)'}
            aria-label={isPlaying ? 'Пауза' : 'Воспроизведение'}
          >
            {isPlaying ? (
              <Pause size={22} />
            ) : (
              <Play size={22} className={styles.playIcon} />
            )}
          </button>

          <button
            type="button"
            className={styles.navBtn}
            onClick={nextTrack}
            disabled={!currentTrack}
            title="Следующий трек (Shift + →)"
            aria-label="Следующий трек"
          >
            <SkipForward size={20} />
          </button>

          <button
            type="button"
            className={`${styles.smallBtn} ${repeatMode !== 'off' ? styles.activeBtn : ''}`}
            onClick={handleNextRepeat}
            title={`Повтор: ${repeatMode}`}
            aria-label="Режим повтора"
          >
            {repeatMode === 'one' ? <Repeat1 size={16} /> : <Repeat size={16} />}
          </button>
        </div>

        {/* Scrubber Progress Bar */}
        <div className={styles.scrubberRow}>
          <span className={styles.timeLabel}>{formatTime(currentTime)}</span>
          <div className={styles.sliderTrackWrap}>
            <div
              className={styles.sliderFilled}
              style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
            />
            <input
              type="range"
              min={0}
              max={duration || 100}
              step={0.1}
              value={currentTime}
              onChange={(e) => seek(parseFloat(e.target.value))}
              disabled={!currentTrack}
              className={styles.scrubberInput}
              aria-label="Полоса перемотки"
            />
          </div>
          <span className={styles.timeLabel}>{formatTime(duration)}</span>
        </div>
      </div>

      {/* 3. Right: Lyrics, Queue, Volume, Fullscreen */}
      <div className={styles.rightCol}>
        <button
          type="button"
          className={`${styles.actionIconBtn} ${
            isRightPanelOpen && rightPanelTab === 'lyrics' ? styles.activeBtn : ''
          }`}
          onClick={() => toggleRightPanel('lyrics')}
          title="Текст песни (L)"
          aria-label="Текст песни"
        >
          <AlignLeft size={18} />
        </button>

        <button
          type="button"
          className={`${styles.actionIconBtn} ${
            isRightPanelOpen && rightPanelTab === 'queue' ? styles.activeBtn : ''
          }`}
          onClick={() => toggleRightPanel('queue')}
          title="Очередь воспроизведения"
          aria-label="Очередь"
        >
          <ListMusic size={18} />
        </button>

        <div className={styles.volumeGroup}>
          <button
            type="button"
            className={styles.volumeBtn}
            onClick={toggleMute}
            title={isMuted ? 'Включить звук (M)' : 'Выключить звук (M)'}
            aria-label="Звук"
          >
            {isMuted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <div className={styles.volumeTrackWrap}>
            <div
              className={styles.volumeFilled}
              style={{ width: `${isMuted ? 0 : volume * 100}%` }}
            />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={isMuted ? 0 : volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              className={styles.volumeInput}
              aria-label="Громкость"
            />
          </div>
        </div>

        <button
          type="button"
          className={styles.actionIconBtn}
          onClick={() => setIsFullscreen(true)}
          title="Полноэкранный режим (F)"
          aria-label="Полноэкранный плеер"
        >
          <Maximize2 size={18} />
        </button>
      </div>
    </footer>
  );
};
