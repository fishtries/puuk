import React, { useState, useEffect } from 'react';
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
  Disc3,
  Tag,
} from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useTagEditorStore } from '../../store/useTagEditorStore';
import { getCoverUrl } from '../../api/tracks';
import styles from './ApplePlayerDeck.module.css';

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatRemainingTime(current: number, total: number): string {
  if (isNaN(total) || total <= 0) return '-0:00';
  const remaining = Math.max(0, total - current);
  const mins = Math.floor(remaining / 60);
  const secs = Math.floor(remaining % 60);
  return `-${mins}:${secs.toString().padStart(2, '0')}`;
}

export const ApplePlayerDeck: React.FC = () => {
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const status = usePlayerStore((state) => state.status);
  const currentTime = usePlayerStore((state) => state.currentTime);
  const duration = usePlayerStore((state) => state.duration);
  const volume = usePlayerStore((state) => state.volume);
  const isMuted = usePlayerStore((state) => state.isMuted);
  const repeatMode = usePlayerStore((state) => state.repeatMode);
  const isShuffled = usePlayerStore((state) => state.isShuffled);

  const togglePlay = usePlayerStore((state) => state.togglePlay);
  const seek = usePlayerStore((state) => state.seek);
  const setVolume = usePlayerStore((state) => state.setVolume);
  const toggleMute = usePlayerStore((state) => state.toggleMute);
  const nextTrack = usePlayerStore((state) => state.nextTrack);
  const previousTrack = usePlayerStore((state) => state.previousTrack);
  const setRepeatMode = usePlayerStore((state) => state.setRepeatMode);
  const toggleShuffle = usePlayerStore((state) => state.toggleShuffle);
  const toggleLike = usePlayerStore((state) => state.toggleLike);
  const openTagEditor = useTagEditorStore((state) => state.openTagEditor);

  const isPlaying = status === 'playing';
  const coverUrl = currentTrack ? getCoverUrl(currentTrack) : '';
  const [coverHasError, setCoverHasError] = useState(false);

  useEffect(() => {
    setCoverHasError(false);
  }, [currentTrack?.id]);

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  const handleNextRepeat = () => {
    if (repeatMode === 'off') setRepeatMode('all');
    else if (repeatMode === 'all') setRepeatMode('one');
    else setRepeatMode('off');
  };

  return (
    <div className={styles.deckContainer}>
      {/* Album Cover Section matching video */}
      <div className={styles.coverSection}>
        <div className={styles.coverWrapper}>
          {coverUrl && !coverHasError ? (
            <img
              src={coverUrl}
              alt={currentTrack?.title || 'Обложка трека'}
              className={`${styles.coverImage} ${isPlaying ? styles.playingCover : ''}`}
              onError={() => setCoverHasError(true)}
            />
          ) : (
            <div className={styles.placeholderCover}>
              <Disc3 size={80} className={isPlaying ? styles.spinning : ''} />
            </div>
          )}
          {currentTrack?.bpm && (
            <div className={styles.explicitBadge}>
              <span>{currentTrack.bpm} BPM</span>
            </div>
          )}
        </div>
      </div>

      {/* Track Metadata matching video layout */}
      <div className={styles.metadataSection}>
        <div className={styles.titleRow}>
          <h1 className={styles.trackTitle}>
            {currentTrack ? currentTrack.title : 'Выберите трек'}
          </h1>
          {currentTrack && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                type="button"
                className={`${styles.likeBtn} ${currentTrack.is_liked ? styles.liked : ''}`}
                onClick={() => toggleLike(currentTrack.id)}
                title={currentTrack.is_liked ? 'Удалить из избранного' : 'Добавить в избранное'}
              >
                <Heart
                  size={20}
                  fill={currentTrack.is_liked ? 'var(--accent-color)' : 'none'}
                />
              </button>
              <button
                type="button"
                className={styles.likeBtn}
                onClick={() => openTagEditor(currentTrack)}
                title="Редактировать теги ID3"
                aria-label="Редактировать теги ID3"
              >
                <Tag size={19} />
              </button>
            </div>
          )}
        </div>
        <p className={styles.trackArtist}>
          {currentTrack ? currentTrack.artist : 'Каталог доступен по кнопке выше'}
        </p>
      </div>

      {/* Scrubber Progress Bar with -M:SS matching video */}
      <div className={styles.scrubberSection}>
        <div className={styles.sliderTrackWrapper}>
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
            aria-label="Перемотка"
          />
        </div>
        <div className={styles.timeLabelsRow}>
          <span className="tabular-nums">{formatTime(currentTime)}</span>
          <span className="tabular-nums">{formatRemainingTime(currentTime, duration)}</span>
        </div>
      </div>

      {/* Main Transport Controls matching video */}
      <div className={styles.transportSection}>
        <div className={styles.controlsRow}>
          <button
            type="button"
            className={`${styles.modeBtn} ${isShuffled ? styles.modeActive : ''}`}
            onClick={toggleShuffle}
            title="Случайный порядок"
          >
            <Shuffle size={18} />
          </button>

          <button
            type="button"
            className={styles.navBtn}
            onClick={previousTrack}
            disabled={!currentTrack}
            title="Предыдущий трек"
          >
            <SkipBack size={26} />
          </button>

          {/* Master Play / Pause with optical centering */}
          <button
            type="button"
            className={styles.masterPlayBtn}
            onClick={togglePlay}
            disabled={!currentTrack}
            title={isPlaying ? 'Пауза (Space)' : 'Воспроизведение (Space)'}
          >
            {isPlaying ? (
              <Pause size={30} />
            ) : (
              <Play size={30} className={styles.playIcon} />
            )}
          </button>

          <button
            type="button"
            className={styles.navBtn}
            onClick={nextTrack}
            disabled={!currentTrack}
            title="Следующий трек"
          >
            <SkipForward size={26} />
          </button>

          <button
            type="button"
            className={`${styles.modeBtn} ${repeatMode !== 'off' ? styles.modeActive : ''}`}
            onClick={handleNextRepeat}
            title={`Повтор: ${repeatMode}`}
          >
            {repeatMode === 'one' ? <Repeat1 size={18} /> : <Repeat size={18} />}
          </button>
        </div>

        {/* Volume Sub-Bar */}
        <div className={styles.volumeRow}>
          <button
            type="button"
            className={styles.volumeIconBtn}
            onClick={toggleMute}
            title={isMuted ? 'Включить звук' : 'Выключить звук'}
          >
            {isMuted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <div className={styles.volumeTrack}>
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
      </div>
    </div>
  );
};
