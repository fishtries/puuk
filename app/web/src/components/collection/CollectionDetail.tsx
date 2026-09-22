import React, { useMemo } from 'react';
import { Heart, Play, Shuffle, Music2, Loader2, Tag } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useTagEditorStore } from '../../store/useTagEditorStore';
import { Track } from '../../types/track';
import styles from './CollectionDetail.module.css';

function formatDuration(seconds?: number): string {
  if (!seconds || isNaN(seconds)) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function pluralTracks(count: number): string {
  if (count % 10 === 1 && count % 100 !== 11) return `${count} трек`;
  if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) {
    return `${count} трека`;
  }
  return `${count} треков`;
}

/* ============================================================
   Tracklist — right-hand column, numbered rows like the mockup
   ============================================================ */

interface TracklistProps {
  tracks: Track[];
  isLoading?: boolean;
  emptyLabel?: string;
}

export const Tracklist: React.FC<TracklistProps> = ({ tracks, isLoading, emptyLabel = 'Пусто' }) => {
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const status = usePlayerStore((state) => state.status);
  const playTrack = usePlayerStore((state) => state.playTrack);
  const togglePlay = usePlayerStore((state) => state.togglePlay);
  const toggleLike = usePlayerStore((state) => state.toggleLike);
  const openTagEditor = useTagEditorStore((state) => state.openTagEditor);

  const handleRowClick = (track: Track) => {
    if (currentTrack?.id === track.id) {
      togglePlay();
    } else {
      playTrack(track, tracks);
    }
  };

  if (isLoading) {
    return (
      <div className={styles.tracklistState}>
        <Loader2 size={16} className={styles.spinner} />
        <span>Загрузка треков…</span>
      </div>
    );
  }

  if (tracks.length === 0) {
    return (
      <div className={styles.tracklistState}>
        <Music2 size={18} />
        <span>{emptyLabel}</span>
      </div>
    );
  }

  return (
    <ol className={styles.tracklist}>
      {tracks.map((track, index) => {
        const isCurrent = currentTrack?.id === track.id;
        const isRowPlaying = isCurrent && status === 'playing';

        return (
          <li
            key={`${track.id}-${index}`}
            className={`${styles.trackRow} ${isCurrent ? styles.trackRowActive : ''}`}
            onClick={() => handleRowClick(track)}
            onKeyDown={(e) => e.key === 'Enter' && handleRowClick(track)}
            role="button"
            tabIndex={0}
          >
            <span className={styles.trackIndex}>
              {isRowPlaying ? (
                <span className={styles.playingDots}>
                  <span />
                  <span />
                  <span />
                </span>
              ) : (
                String(index + 1).padStart(2, '0')
              )}
            </span>

            <div className={styles.trackMeta}>
              <span className={styles.trackTitle} title={track.title}>
                {track.title}
              </span>
              <span className={styles.trackArtist} title={track.artist}>
                {track.artist}
                {track.album ? `, ${track.album}` : ''}
              </span>
            </div>

            <div className={styles.trackActions}>
              <button
                type="button"
                className={`${styles.heartBtn} ${track.is_liked ? styles.heartBtnActive : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleLike(track.id);
                }}
                aria-label={track.is_liked ? 'Убрать из избранного' : 'В избранное'}
                title={track.is_liked ? 'Убрать из избранного' : 'В избранное'}
              >
                <Heart size={14} fill={track.is_liked ? 'var(--accent-color, #ff7a00)' : 'none'} />
              </button>

              <span className={`${styles.trackDuration} tabular-nums`}>
                {formatDuration(track.duration)}
              </span>

              <button
                type="button"
                className={styles.actionBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  openTagEditor(track);
                }}
                title="Редактировать теги ID3"
                aria-label="Редактировать теги ID3"
              >
                <Tag size={13} />
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
};

/* ============================================================
   Cover — CD jewel case visual, fed by the collection artwork
   ============================================================ */

interface CoverProps {
  coverUrl?: string;
}

const Cover: React.FC<CoverProps> = ({ coverUrl }) => {
  return (
    <div className={`${styles.coverBase} ${styles.coverHero}`}>
      {coverUrl ? (
        <img src={coverUrl} alt="" className={styles.coverImg} />
      ) : (
        <div className={styles.coverFallback}>
          <Music2 size={44} />
        </div>
      )}
    </div>
  );
};

/* ============================================================
   CollectionDetail — the two-column stage from the reference
   ============================================================ */

export interface CollectionDetailProps {
  name: string;
  subtitle?: string;
  coverUrl?: string;
  tracks: Track[];
  isLoading?: boolean;
  emptyLabel?: string;
}

export const CollectionDetail: React.FC<CollectionDetailProps> = ({
  name,
  subtitle,
  coverUrl,
  tracks,
  isLoading,
  emptyLabel,
}) => {
  const playTrack = usePlayerStore((state) => state.playTrack);
  const toggleShuffle = usePlayerStore((state) => state.toggleShuffle);
  const isShuffled = usePlayerStore((state) => state.isShuffled);

  const totalDuration = useMemo(() => {
    const sum = tracks.reduce((acc, t) => acc + (t.duration || 0), 0);
    if (!sum) return null;
    const hours = Math.floor(sum / 3600);
    const mins = Math.round((sum % 3600) / 60);
    return hours > 0 ? `${hours} ч ${mins} мин` : `${mins} мин`;
  }, [tracks]);

  const handlePlay = () => {
    if (tracks.length === 0) return;
    const startIndex = isShuffled ? Math.floor(Math.random() * tracks.length) : 0;
    playTrack(tracks[startIndex], tracks);
  };

  const handleShuffle = () => {
    if (tracks.length === 0) return;
    toggleShuffle();
    const randomIndex = Math.floor(Math.random() * tracks.length);
    playTrack(tracks[randomIndex], tracks);
  };

  return (
    <div className={styles.detailStage}>
      <aside className={styles.detailRail}>
        <Cover coverUrl={coverUrl} />

        <h2 className={styles.detailTitle} title={name}>
          {name}
        </h2>

        <p className={styles.detailSubtitle}>
          <span>{pluralTracks(tracks.length)}</span>
          {totalDuration && (
            <>
              <span className={styles.detailDot}>·</span>
              <span>{totalDuration}</span>
            </>
          )}
          {subtitle && (
            <>
              <span className={styles.detailDot}>·</span>
              <span>{subtitle}</span>
            </>
          )}
        </p>

        <div className={styles.transportRow}>
          <button
            type="button"
            className={styles.playBtn}
            onClick={handlePlay}
            disabled={tracks.length === 0}
          >
            <Play size={15} fill="currentColor" />
            <span>Play</span>
          </button>

          <button
            type="button"
            className={`${styles.shuffleBtn} ${isShuffled ? styles.shuffleBtnActive : ''}`}
            onClick={handleShuffle}
            disabled={tracks.length === 0}
          >
            <Shuffle size={15} />
            <span>Shuffle</span>
          </button>
        </div>
      </aside>

      <section className={styles.detailTracklistCol}>
        <Tracklist tracks={tracks} isLoading={isLoading} emptyLabel={emptyLabel} />
      </section>
    </div>
  );
};

