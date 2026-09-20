import React from 'react';
import { Heart, Music2, Play, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { fetchPlaylists, fetchFavorites, getCoverUrl } from '../api/tracks';
import { Playlist } from '../types/track';
import styles from './PlaylistsView.module.css';

export const FAVORITES_ID = '__favorites__';

function pluralTracks(count: number): string {
  if (count % 10 === 1 && count % 100 !== 11) return `${count} трек`;
  if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) {
    return `${count} трека`;
  }
  return `${count} треков`;
}

export interface PlaylistGridItem {
  id: string;
  name: string;
  coverUrl?: string;
  trackCount: number;
  isFavorites?: boolean;
  subtitle?: string;
}

interface PlaylistsViewProps {
  onOpen: (item: PlaylistGridItem) => void;
}

export const PlaylistsView: React.FC<PlaylistsViewProps> = ({ onOpen }) => {
  const { data: playlists = [], isFetching: isPlaylistsLoading } = useQuery({
    queryKey: ['playlists'],
    queryFn: () => fetchPlaylists(),
    staleTime: 30000,
  });

  const { data: favorites = [] } = useQuery({
    queryKey: ['favorites'],
    queryFn: () => fetchFavorites(),
    staleTime: 15000,
  });

  const items: PlaylistGridItem[] = React.useMemo(() => {
    const list: PlaylistGridItem[] = [
      {
        id: FAVORITES_ID,
        name: 'Избранное',
        coverUrl: getCoverUrl(favorites[0]),
        trackCount: favorites.length,
        isFavorites: true,
        subtitle: 'Личная коллекция',
      },
      ...playlists.map((p: Playlist) => ({
        id: String(p.id),
        name: p.name || p.title || 'Плейлист',
        coverUrl: getCoverUrl(p),
        trackCount: p.track_count ?? 0,
        subtitle: p.is_public ? 'Публичный' : 'Личный',
      })),
    ];
    return list;
  }, [playlists, favorites]);

  if (isPlaylistsLoading) {
    return (
      <div className={styles.loadingState}>
        <Loader2 size={16} className={styles.shelfSpinner} />
        <span>Загрузка библиотеки…</span>
      </div>
    );
  }

  return (
    <motion.div
      className={styles.pageContainer}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.23, 1, 0.32, 1] }}
    >
      <header className={styles.gridHeader}>
        <span className={styles.gridEyebrow}>библиотека</span>
        <h1 className={styles.gridTitle}>playlists</h1>
        <span className={styles.gridCount}>
          {items.length} {items.length === 1 ? 'коллекция' : 'коллекций'}
        </span>
      </header>

      <div className={styles.playlistsGrid}>
        {items.map((item) => (
          <motion.button
            key={item.id}
            type="button"
            className={styles.playlistCard}
            onClick={() => onOpen(item)}
            whileHover={{ y: -3 }}
            transition={{ type: 'spring', stiffness: 320, damping: 26 }}
          >
            <div className={styles.cardCoverWrap}>
              {item.isFavorites ? (
                <div className={styles.favoritesCover}>
                  <Heart size={30} fill="currentColor" />
                </div>
              ) : item.coverUrl ? (
                <img src={item.coverUrl} alt={item.name} className={styles.cardCoverImg} />
              ) : (
                <div className={styles.cardCoverFallback}>
                  <Music2 size={26} />
                </div>
              )}
              <div className={styles.cardPlayHint}>
                <Play size={16} fill="currentColor" />
              </div>
            </div>

            <div className={styles.cardMeta}>
              <span className={styles.cardTitle} title={item.name}>
                {item.name}
              </span>
              <span className={styles.cardSubtitle}>
                {item.subtitle ? `${item.subtitle} · ` : ''}
                {pluralTracks(item.trackCount)}
              </span>
            </div>
          </motion.button>
        ))}
      </div>
    </motion.div>
  );
};
