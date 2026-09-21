import React from 'react';
import { Play, Pause, Music2, Clock, Heart, ArrowUpRight } from 'lucide-react';
import { Track } from '../../../types/track';
import { WaveProfileIndicator } from '../../player/WaveProfileIndicator';
import styles from '../HomeScreen.module.css';

export interface TrackRowHandlers {
  isCurrentPlaying: (trackId: string) => boolean;
  onTrackClick: (track: Track) => void;
}

/** Card 1: "you're fresh mix" — Моя Волна launcher. */
export const FreshMixCard: React.FC<{
  isWaveActive: boolean;
  isPlaying: boolean;
  onLaunchWave: () => void;
}> = ({ isWaveActive, isPlaying, onLaunchWave }) => (
  <div
    className={`${styles.glassCard} ${styles.freshMixCard}`}
    onClick={onLaunchWave}
    title="Запустить персональную волну"
  >
    <div className={styles.cardHeaderWithIcon}>
      {/* 8-point geometric starburst icon */}
      <div className={styles.starburstIconWrapper}>
        <svg viewBox="0 0 24 24" className={styles.starburstSvg} fill="currentColor">
          <path d="M12 0L14.4 7.6L22 4.4L18.8 12L24 14.4L16.4 16.8L19.6 24L12 20.8L8.4 24L10.8 16.4L0 14.4L5.2 12L2 4.4L9.6 7.6L12 0Z" />
        </svg>
      </div>

      <div className={styles.freshMixMeta}>
        <span className={styles.handwrittenTitle}>you're fresh mix</span>
        <span className={styles.cardSubtitle}>
          {isWaveActive ? 'Моя Волна играет' : 'Моя Волна • Запустить'}
        </span>
        <div style={{ marginTop: '5px' }}>
          <WaveProfileIndicator />
        </div>
      </div>
    </div>

    <div className={styles.cardActionRow}>
      <button
        type="button"
        className={styles.cardActionPlayBtn}
        onClick={(e) => {
          e.stopPropagation();
          onLaunchWave();
        }}
        aria-label={isWaveActive ? 'Пауза Волны' : 'Запустить Волну'}
      >
        {isWaveActive && isPlaying ? (
          <Pause size={18} fill="currentColor" />
        ) : (
          <Play size={18} fill="currentColor" />
        )}
      </button>
    </div>
  </div>
);

/** Card 2: "recently listened" — track pills with waveform doodle. */
export const RecentlyListenedCard: React.FC<{ tracks: Track[] } & TrackRowHandlers> = ({
  tracks,
  isCurrentPlaying,
  onTrackClick,
}) => (
  <div className={`${styles.glassCard} ${styles.recentlyListenedCard}`}>
    <div className={styles.cardTitleBar}>
      <span className={styles.handwrittenTitle}>recently listened</span>
      <ArrowUpRight size={18} className={styles.cardLinkArrow} />
    </div>

    <div className={styles.pillsList}>
      {tracks.length === 0 ? (
        <p className={styles.recentEmpty}>Пока ничего не слушали</p>
      ) : (
        tracks.map((track) => (
          <div
            key={track.id}
            className={styles.trackPillRow}
            onClick={() => onTrackClick(track)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && onTrackClick(track)}
            title={`Играть «${track.title}»`}
          >
            <MiniWaveform isPlaying={isCurrentPlaying(track.id)} />

            <div className={styles.trackPillMeta}>
              <span className={styles.pillTrackTitle}>{track.title}</span>
              <span className={styles.pillTrackArtist}>{track.artist}</span>
            </div>

            <button
              type="button"
              className={styles.miniPlayBtn}
              aria-label={`Воспроизвести ${track.title}`}
              onClick={(e) => {
                e.stopPropagation();
                onTrackClick(track);
              }}
            >
              {isCurrentPlaying(track.id) ? (
                <Pause size={13} fill="currentColor" />
              ) : (
                <Play size={13} fill="currentColor" />
              )}
            </button>
          </div>
        ))
      )}
    </div>
  </div>
);

/** Card 3: "you're favorites". */
export const FavoritesCard: React.FC<{ favorites: Track[]; onPlayFirst: () => void }> = ({
  favorites,
  onPlayFirst,
}) => (
  <div
    className={`${styles.glassCard} ${styles.favoritesCard}`}
    onClick={onPlayFirst}
    title="Слушать избранные треки"
  >
    <div className={styles.cardHeaderWithIcon}>
      <div className={styles.heartIconWrapper}>
        <Heart size={28} className={styles.heartIcon} fill="rgba(255, 255, 255, 0.15)" />
      </div>

      <div className={styles.favoritesMeta}>
        <span className={styles.handwrittenTitle}>you're favorites</span>
        <span className={styles.cardSubtitle}>
          {favorites.length} {favorites.length === 1 ? 'трек' : 'треков'}
        </span>
      </div>
    </div>

    <div className={styles.cardActionRow}>
      <button
        type="button"
        className={styles.cardActionPlayBtn}
        onClick={(e) => {
          e.stopPropagation();
          onPlayFirst();
        }}
        aria-label="Слушать избранное"
      >
        <Play size={18} fill="currentColor" />
      </button>
    </div>
  </div>
);

/** Card 4: "fresh tracks". */
export const FreshTracksCard: React.FC<{ tracks: Track[] } & TrackRowHandlers> = ({
  tracks,
  isCurrentPlaying,
  onTrackClick,
}) => (
  <div className={`${styles.glassCard} ${styles.freshTracksCard}`}>
    <div className={styles.cardHeaderWithIcon}>
      <div className={styles.clockIconWrapper}>
        <Clock size={24} className={styles.clockIcon} />
      </div>

      <div className={styles.freshTracksMeta}>
        <span className={styles.handwrittenTitle}>fresh tracks</span>
        <span className={styles.cardSubtitle}>Недавние новинки</span>
      </div>
    </div>

    <div className={styles.pillsList}>
      {tracks.slice(0, 2).map((track) => (
        <div key={track.id} className={styles.trackPillRow} onClick={() => onTrackClick(track)}>
          <MiniWaveform isPlaying={isCurrentPlaying(track.id)} />

          <div className={styles.trackPillMeta}>
            <span className={styles.pillTrackTitle}>{track.title}</span>
            <span className={styles.pillTrackArtist}>{track.artist}</span>
          </div>

          <button
            type="button"
            className={styles.miniPlayBtn}
            aria-label={`Воспроизвести ${track.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onTrackClick(track);
            }}
          >
            {isCurrentPlaying(track.id) ? (
              <Pause size={13} fill="currentColor" />
            ) : (
              <Play size={13} fill="currentColor" />
            )}
          </button>
        </div>
      ))}
    </div>
  </div>
);

/** Mini animated waveform doodle used in track pills. */
export const MiniWaveform: React.FC<{ isPlaying: boolean }> = ({ isPlaying }) => (
  <div className={styles.waveformDoodle}>
    <span className={isPlaying ? styles.barAnim1 : ''} />
    <span className={isPlaying ? styles.barAnim2 : ''} />
    <span className={isPlaying ? styles.barAnim3 : ''} />
  </div>
);

/** Fallback cover block. */
export const FallbackCover: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <div className={styles.resultCoverFallback}>
    <Music2 size={size} />
  </div>
);
