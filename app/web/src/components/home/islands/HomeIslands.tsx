import React from 'react';
import { Play, Pause, Music2, Clock, Heart, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Track } from '../../../types/track';
import styles from '../HomeScreen.module.css';
import { GenrePlaylistCarousel } from './GenrePlaylistCarousel';
import { fetchPersonalizedRecommendations } from '../../../api/recommendations';
import type { PersonalizedPlaylistSection } from '../../../types/recommendations';
import { useAuthStore } from '../../../store/useAuthStore';
import { usePlayerStore } from '../../../store/usePlayerStore';

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

/** Card 2: "you'll like this" — 3D Cover Flow Carousel персональных жанровых подборок. */
export const YoullLikeThisCard: React.FC<{
  onOpenPlaylist?: (section: PersonalizedPlaylistSection) => void;
}> = ({ onOpenPlaylist }) => {
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const isAuthLoading = useAuthStore((state) => state.isLoading);
  const setIsLoginOpen = usePlayerStore((state) => state.setIsLoginOpen);

  // Персональные жанровые подборки от бэкенда (пустой профиль → sections: [])
  const { data, isLoading, isError } = useQuery({
    queryKey: ['recommendations', 'youll-like-this', user?.id ?? null],
    queryFn: () => fetchPersonalizedRecommendations({ limit: 20, sections: 3 }),
    enabled: Boolean(!isAuthLoading && token && user),
    staleTime: 60000,
    retry: 1,
  });

  const sections = data?.sections ?? [];
  const hasSections = sections.length > 0;

  return (
    <div
      className={`${styles.glassCard} ${styles.youllLikeThisCard}`}
      role="region"
      aria-label="you'll like this"
    >
      {isAuthLoading ? (
        <div className={styles.youllLikeThisPlaceholder}>
          <Loader2 size={18} className={styles.youllLikeThisSpinner} />
        </div>
      ) : !token ? (
        <div className={styles.youllLikeThisPlaceholder}>
          <button type="button" className={styles.youllLikeThisPlaceholderText} onClick={() => setIsLoginOpen(true)}>
            Войдите, чтобы получить персональные подборки
          </button>
        </div>
      ) : isLoading ? (
        <div className={styles.youllLikeThisPlaceholder}>
          <Loader2 size={18} className={styles.youllLikeThisSpinner} />
        </div>
      ) : isError ? (
        <div className={styles.youllLikeThisPlaceholder}>
          <span className={styles.youllLikeThisPlaceholderText}>Не удалось загрузить подборки</span>
        </div>
      ) : hasSections ? (
        <GenrePlaylistCarousel
          sections={sections}
          onOpenPlaylist={(section) => onOpenPlaylist?.(section)}
        />
      ) : (
        <div className={styles.youllLikeThisPlaceholder}>
          <span className={styles.youllLikeThisPlaceholderText}>
            Пока недостаточно истории для персональных подборок
          </span>
        </div>
      )}
    </div>
  );
};

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
