import React, { useState } from 'react';
import { Heart, Music2, Play, Loader2, MoreVertical, Pencil, Trash2, Plus } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../store/useAuthStore';
import { motion } from 'framer-motion';
import { deletePlaylist, fetchPlaylists, fetchFavorites, getCoverUrl } from '../api/tracks';
import { Playlist, Track } from '../types/track';
import { toast } from 'sonner';
import { PlaylistFormModal } from '../components/playlists/PlaylistFormModal';
import { ConfirmDeleteModal } from '../components/playlists/ConfirmDeleteModal';
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
  isPublic?: boolean;
  isOwner?: boolean;
  subtitle?: string;
  tracks?: Track[];
}

interface PlaylistsViewProps {
  onOpen: (item: PlaylistGridItem) => void;
  onDeleted?: (playlistId: string) => void;
  onCreated?: (playlist: Playlist) => void;
}

export const PlaylistsView: React.FC<PlaylistsViewProps> = ({ onOpen, onDeleted, onCreated }) => {
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const queryClient = useQueryClient();

  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Playlist | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Playlist | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const isAuthorized = Boolean(token && user);

  const { data: playlists = [], isFetching: isPlaylistsLoading } = useQuery({
    queryKey: ['playlists', user?.id ?? null],
    queryFn: () => fetchPlaylists(),
    enabled: Boolean(token && user),
    staleTime: 30000,
  });

  const { data: favorites = [] } = useQuery({
    queryKey: ['favorites', user?.id ?? null],
    queryFn: () => fetchFavorites(),
    enabled: Boolean(token && user),
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
        trackCount: p.track_count ?? 0,
        isPublic: p.is_public,
        isOwner: p.user_id === undefined || String(p.user_id) === String(user?.id ?? '') || user?.role === 'admin',
        subtitle: p.is_public ? 'Публичный' : 'Личный',
      })),
    ];
    return list;
  }, [playlists, favorites, user]);

  const closeMenu = () => setOpenMenuId(null);

  const findPlaylist = (gridId: string): Playlist | undefined =>
    playlists.find((p: Playlist) => String(p.id) === gridId);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await deletePlaylist(deleteTarget.id);
      void queryClient.invalidateQueries({ queryKey: ['playlists', user?.id ?? null] });
      toast.success('Плейлист удалён');
      onDeleted?.(String(deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      toast.error((err as Error).message || 'Не удалось удалить плейлист');
    } finally {
      setIsDeleting(false);
    }
  };

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
        <h1 className={styles.gridTitle}>playlists</h1>
        {isAuthorized && (
          <button
            type="button"
            className={styles.createPlaylistBtn}
            onClick={() => setIsCreateOpen(true)}
            title="Создать новый плейлист"
          >
            <Plus size={15} />
            <span>new playlist</span>
          </button>
        )}
      </header>

      <div className={styles.playlistsGrid}>
        {items.map((item) => {
          const isMenuOpen = openMenuId === item.id;

          return (
            <div key={item.id} className={styles.cardWrapper}>
              <motion.button
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

              {/* Card actions menu — sibling of the card button, not nested; owner/admin only */}
              {!item.isFavorites && item.isOwner && (
                <div className={styles.cardMenuRoot}>
                  <button
                    type="button"
                    className={`${styles.cardMenuBtn} ${isMenuOpen ? styles.cardMenuBtnActive : ''}`}
                    aria-label={`Действия с плейлистом «${item.name}»`}
                    title="Действия"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuId(isMenuOpen ? null : item.id);
                    }}
                  >
                    <MoreVertical size={15} />
                  </button>

                  {isMenuOpen && (
                    <>
                      <div className={styles.cardMenuOverlay} onClick={closeMenu} />
                      <div className={styles.cardMenuDropdown} role="menu">
                        <button
                          type="button"
                          className={styles.cardMenuItem}
                          role="menuitem"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeMenu();
                            const playlist = findPlaylist(item.id);
                            if (playlist) setEditTarget(playlist);
                          }}
                        >
                          <Pencil size={14} />
                          <span>Редактировать</span>
                        </button>
                        <button
                          type="button"
                          className={`${styles.cardMenuItem} ${styles.cardMenuItemDanger}`}
                          role="menuitem"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeMenu();
                            const playlist = findPlaylist(item.id);
                            if (playlist) setDeleteTarget(playlist);
                          }}
                        >
                          <Trash2 size={14} />
                          <span>Удалить</span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <PlaylistFormModal
        isOpen={editTarget !== null}
        mode="edit"
        playlist={editTarget}
        onClose={() => setEditTarget(null)}
        onSuccess={(playlist) => {
          setEditTarget(null);
          void queryClient.invalidateQueries({ queryKey: ['playlists', user?.id ?? null] });
          void queryClient.invalidateQueries({ queryKey: ['playlist', String(playlist.id)] });
        }}
      />

      <PlaylistFormModal
        isOpen={isCreateOpen}
        mode="create"
        onClose={() => setIsCreateOpen(false)}
        onSuccess={(playlist) => {
          setIsCreateOpen(false);
          void queryClient.invalidateQueries({ queryKey: ['playlists', user?.id ?? null] });
          onCreated?.(playlist);
        }}
      />

      <ConfirmDeleteModal
        isOpen={deleteTarget !== null}
        title="Удалить плейлист?"
        message={`Плейлист «${deleteTarget?.name ?? ''}» будет удалён навсегда. Треки останутся в библиотеке.`}
        confirmLabel="Удалить"
        isSubmitting={isDeleting}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
      />
    </motion.div>
  );
};
