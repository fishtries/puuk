import React, { useMemo } from 'react';
import { Play, Pause, Music2, Clock, Heart, ArrowUpRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Track } from '../../../types/track';
import { getCoverUrl } from '../../../api/tracks';
import styles from '../HomeScreen.module.css';
import { MoodCoverFlowCarousel } from './MoodCoverFlowCarousel';
import {
  fetchYoullLikeThis,
  buildFallbackMoodItems,
  DEFAULT_MOOD_ORDER,
  MOOD_DEFINITIONS,
} from '../../../api/recommendations';
import type { MoodItem } from '../../../types/recommendations';

export interface TrackRowHandlers {
  isCurrentPlaying: (trackId: string) => boolean;
  onTrackClick: (track: Track) => void;
}

/** Card 1: "your mix" — Моя Волна launcher. */
export const FreshMixCard: React.FC<{
  isWaveActive: boolean;
  isPlaying: boolean;
  onLaunchWave: () => void;
}> = ({ onLaunchWave }) => (
  <div
    className={`${styles.glassCard} ${styles.freshMixCard}`}
    onClick={onLaunchWave}
    role="button"
    tabIndex={0}
    onKeyDown={(e) => e.key === 'Enter' && onLaunchWave()}
    title="Запустить Мою Волну"
    aria-label="your mix"
  >
    <img
      src="/your_mix_bg.png"
      alt="your mix"
      className={styles.freshMixBg}
      draggable={false}
    />
    <span className={styles.yourMixTitle}>your mix</span>
  </div>
);

/** Card 2: "you'll like this" — 3D Cover Flow Carousel сгенерированных AI плейлистов. */
export const YoullLikeThisCard: React.FC<{
  allTracks?: Track[];
  onOpenPlaylist?: (mood: MoodItem) => void;
}> = ({ allTracks = [], onOpenPlaylist }) => {
  // Запрос рекомендаций от бэкенда
  const { data: moodData } = useQuery({
    queryKey: ['recommendations', 'youll-like-this'],
    queryFn: () => fetchYoullLikeThis(),
    staleTime: 60000,
    retry: 1,
  });

  // Построение 6 mood-плейлистов с надёжным fallback на базе библиотеки треков
  const moodItems: MoodItem[] = useMemo(() => {
    const fallback = buildFallbackMoodItems(allTracks);
    if (!moodData?.sections || moodData.sections.length === 0) {
      return fallback;
    }

    return DEFAULT_MOOD_ORDER.map((moodId) => {
      const section = moodData.sections.find((s) => s.mood === moodId);
      const def = MOOD_DEFINITIONS[moodId];
      const fallbackItem = fallback.find((f) => f.id === moodId);
      const tracks =
        section?.tracks && section.tracks.length > 0
          ? section.tracks
          : fallbackItem?.tracks || [];
      const coverUrl =
        (tracks[0] ? getCoverUrl(tracks[0]) : undefined) || fallbackItem?.coverUrl;

      return {
        id: moodId,
        title: def?.title || section?.title || `${moodId} mix`,
        description: def?.description || 'Персональный AI плейлист',
        color: def?.color || '#ff7a00',
        gradient: def?.gradient || 'linear-gradient(135deg, #ff7a00 0%, #ff0055 100%)',
        tracks,
        coverUrl,
      };
    });
  }, [moodData, allTracks]);

  return (
    <div
      className={`${styles.glassCard} ${styles.youllLikeThisCard}`}
      role="region"
      aria-label="you'll like this"
    >
      <MoodCoverFlowCarousel
        moods={moodItems}
        onOpenPlaylist={(mood) => onOpenPlaylist?.(mood)}
      />
    </div>
  );
};

/** @deprecated Сохранено для обратной совместимости */
export const RecentlyListenedCard: React.FC<any> = YoullLikeThisCard;

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
