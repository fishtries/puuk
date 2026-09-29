import React, { useEffect, useState } from 'react';
import { Play, Pause, Heart, Music2, Sparkles, FolderOpen } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { usePlayerStore } from '../store/usePlayerStore';
import { fetchTracks, fetchAlbums, getCoverUrl } from '../api/tracks';
import { Track, Album } from '../types/track';
import { audioEngine } from '../engine/AudioEngine';
import styles from './HomeView.module.css';
import { AuthorizedImage } from '../components/common/AuthorizedImage';

function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const DEMO_TRACKS: Track[] = [
  {
    id: 'demo-1',
    title: 'Solar Echoes',
    artist: 'Antigravity Studio',
    album: 'Deep Space Horizon',
    duration: 218,
    bpm: 124,
    format: 'flac',
    is_liked: true,
  },
  {
    id: 'demo-2',
    title: 'Neon Velocity',
    artist: 'Cybernetic Drift',
    album: 'Subsurface 2088',
    duration: 185,
    bpm: 130,
    format: 'mp3',
    is_liked: false,
  },
  {
    id: 'demo-3',
    title: 'Midnight Resonance',
    artist: 'Puuk Synthetics',
    album: 'Zero Gravity',
    duration: 242,
    bpm: 118,
    format: 'flac',
    is_liked: true,
  },
];

export const HomeView: React.FC = () => {
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const status = usePlayerStore((state) => state.status);
  const playTrack = usePlayerStore((state) => state.playTrack);
  const togglePlay = usePlayerStore((state) => state.togglePlay);
  const toggleLike = usePlayerStore((state) => state.toggleLike);
  const isWaveActive = usePlayerStore((state) => state.isWaveActive);
  const toggleWave = usePlayerStore((state) => state.toggleWave);

  // Equalizer animation
  const [frequencies, setFrequencies] = useState<number[]>(new Array(16).fill(12));

  useEffect(() => {
    const unsub = audioEngine.on('analyserdata', ({ frequencyData }) => {
      if (status !== 'playing') {
        setFrequencies(new Array(16).fill(10));
        return;
      }
      const step = Math.floor(frequencyData.length / 16);
      const bars: number[] = [];
      for (let i = 0; i < 16; i++) {
        const val = frequencyData[i * step] || 0;
        bars.push(Math.max(8, (val / 255) * 44));
      }
      setFrequencies(bars);
    });

    return () => {
      unsub();
    };
  }, [status]);

  const { data: serverTracks = [] } = useQuery({
    queryKey: ['tracks'],
    queryFn: () => fetchTracks(),
    staleTime: 30000,
  });

  const { data: albums = [] } = useQuery({
    queryKey: ['albums'],
    queryFn: () => fetchAlbums(),
    staleTime: 60000,
  });

  const tracks = serverTracks.length > 0 ? serverTracks : DEMO_TRACKS;
  const isPlaying = status === 'playing';

  const handleTrackClick = (track: Track) => {
    if (currentTrack?.id === track.id) {
      togglePlay();
    } else {
      playTrack(track, tracks);
    }
  };

  return (
    <div className={styles.homeContainer}>
      {/* 1. Neural «Моя Волна» Banner with Parametric Equalizer */}
      <section className={`${styles.waveBanner} ${isWaveActive ? styles.waveBannerActive : ''}`}>
        <div className={styles.waveTextCol}>
          <div className={styles.tag}>
            <Sparkles size={14} />
            <span>НЕЙРОСЕТЕВОЙ ПОТОК</span>
          </div>
          <h2 className={styles.waveTitle}>Моя Волна</h2>
          <p className={styles.waveDesc}>
            Персональный бесконечный аудиопоток, обучающийся на ваших предпочтениях через векторный поиск Qdrant.
          </p>
          <button
            type="button"
            className={styles.waveActionBtn}
            onClick={toggleWave}
          >
            {isWaveActive && isPlaying ? (
              <>
                <Pause size={16} />
                <span>Пауза</span>
              </>
            ) : (
              <>
                <Play size={16} className={styles.wavePlayIcon} />
                <span>Запустить Волну</span>
              </>
            )}
          </button>
        </div>

        {/* Parametric frequency bars */}
        <div className={styles.eqWrap} aria-hidden="true">
          <div className={styles.eqGrid}>
            {frequencies.map((height, i) => (
              <div
                key={i}
                className={styles.eqBar}
                style={{
                  height: `${height}px`,
                  opacity: isWaveActive ? 1 : 0.45,
                }}
              />
            ))}
          </div>
        </div>
      </section>

      {/* 2. Tracks Table Section */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>Треки студии</h3>
          <span className={styles.countBadge}>{tracks.length} треков</span>
        </div>

        <div className={styles.trackTable}>
          <div className={styles.tableHeaderRow}>
            <div className={styles.colIndex}>#</div>
            <div className={styles.colTitle}>НАЗВАНИЕ</div>
            <div className={styles.colAlbum}>АЛЬБОМ</div>
            <div className={styles.colBpm}>BPM</div>
            <div className={styles.colDuration}>ВРЕМЯ</div>
            <div className={styles.colActions}></div>
          </div>

          {tracks.map((track, index) => {
            const isCurrent = currentTrack?.id === track.id;
            const isCurrentPlaying = isCurrent && isPlaying;
            const cover = getCoverUrl(track.cover_id);

            return (
              <div
                key={track.id}
                className={`${styles.tableRow} ${isCurrent ? styles.activeRow : ''}`}
                onClick={() => handleTrackClick(track)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && handleTrackClick(track)}
              >
                <div className={styles.colIndex}>
                  {isCurrentPlaying ? (
                    <Pause size={14} className={styles.activePlayIcon} />
                  ) : (
                    <span className={styles.indexNum}>{index + 1}</span>
                  )}
                  <Play size={14} className={styles.hoverPlayIcon} />
                </div>

                <div className={styles.colTitle}>
                  {cover ? (
                    <AuthorizedImage src={cover} alt="" className={styles.rowCover} loading="lazy" />
                  ) : (
                    <div className={styles.rowCoverPlaceholder}>
                      <Music2 size={14} />
                    </div>
                  )}
                  <div className={styles.rowMeta}>
                    <span className={styles.titleText}>{track.title}</span>
                    <span className={styles.artistText}>{track.artist}</span>
                  </div>
                </div>

                <div className={styles.colAlbum}>
                  <span>{track.album || '—'}</span>
                </div>

                <div className={styles.colBpm}>
                  {track.bpm ? (
                    <span className={styles.bpmBadge}>{track.bpm}</span>
                  ) : (
                    <span className={styles.dimText}>—</span>
                  )}
                </div>

                <div className={styles.colDuration}>
                  <span className="tabular-nums">{formatDuration(track.duration)}</span>
                </div>

                <div className={styles.colActions}>
                  <button
                    type="button"
                    className={`${styles.likeBtn} ${track.is_liked ? styles.liked : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleLike(track.id);
                    }}
                    title={track.is_liked ? 'Удалить из избранного' : 'В избранное'}
                  >
                    <Heart
                      size={15}
                      fill={track.is_liked ? 'var(--accent-color)' : 'none'}
                    />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 3. Albums Shelf */}
      {albums.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Альбомы</h3>
            <span className={styles.countBadge}>{albums.length} альбомов</span>
          </div>

          <div className={styles.albumGrid}>
            {albums.map((album: Album) => {
              const cover = getCoverUrl(album.cover_id);
              return (
                <div key={album.id} className={styles.albumCard}>
                  <div className={styles.albumCoverWrap}>
                    {cover ? (
                      <AuthorizedImage src={cover} alt={album.title} className={styles.albumImg} />
                    ) : (
                      <div className={styles.albumPlaceholder}>
                        <FolderOpen size={32} />
                      </div>
                    )}
                  </div>
                  <span className={styles.albumTitle}>{album.title}</span>
                  <span className={styles.albumArtist}>{album.artist}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
};
