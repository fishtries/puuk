import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Music2, ListPlus, Plus, Loader2 } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { addTrackToPlaylist, fetchPlaylists } from '../../api/tracks';
import { Playlist, Track } from '../../types/track';
import { useAuthStore } from '../../store/useAuthStore';
import { toast } from 'sonner';
import { PlaylistFormModal } from './PlaylistFormModal';
import styles from './AddToPlaylistModal.module.css';

interface AddToPlaylistModalProps {
  track: Track | null;
  onClose: () => void;
}

export const AddToPlaylistModal: React.FC<AddToPlaylistModalProps> = ({ track, onClose }) => {
  const isOpen = track !== null;
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const userId = user?.id ?? null;
  const queryClient = useQueryClient();

  const [pendingPlaylistId, setPendingPlaylistId] = useState<string | number | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setPendingPlaylistId(null);
    setIsCreateOpen(false);
  }, [isOpen, track?.id]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isCreateOpen) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isCreateOpen, onClose]);

  const { data: fetchedPlaylists = [], isFetching: isPlaylistsLoading } = useQuery({
    queryKey: ['playlists', userId],
    queryFn: () => fetchPlaylists(),
    enabled: isOpen && Boolean(token && user),
    staleTime: 30000,
  });

  // Backend разрешает менять состав только владелец/админ —
  // чужие публичные плейлисты не предлагаем как цель добавления
  const playlists = React.useMemo(
    () =>
      fetchedPlaylists.filter(
        (p: Playlist) =>
          p.user_id === undefined || String(p.user_id) === String(userId) || user?.role === 'admin'
      ),
    [fetchedPlaylists, userId, user]
  );

  const handleSelect = async (playlist: Playlist) => {
    if (!track) return;
    setPendingPlaylistId(playlist.id);
    try {
      const status = await addTrackToPlaylist(playlist.id, track.id);
      if (status === 'already_exists') {
        toast.info('Трек уже есть в этом плейлисте');
      } else {
        toast.success('Трек добавлен в плейлист');
      }
      void queryClient.invalidateQueries({ queryKey: ['playlist', String(playlist.id)] });
      void queryClient.invalidateQueries({ queryKey: ['playlists', userId] });
      onClose();
    } catch (err) {
      toast.error((err as Error).message || 'Не удалось добавить трек в плейлист');
    } finally {
      setPendingPlaylistId(null);
    }
  };

  const handlePlaylistCreated = () => {
    setIsCreateOpen(false);
    void queryClient.invalidateQueries({ queryKey: ['playlists'] });
  };

  return (
    <>
      <AnimatePresence>
        {isOpen && track && (
          <div className={styles.backdrop} onClick={onClose}>
            <motion.div
              className={styles.modal}
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.95, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 16 }}
              transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
              role="dialog"
              aria-modal="true"
              aria-label="Добавить в плейлист"
            >
              <header className={styles.header}>
                <div className={styles.headerInfo}>
                  <div className={styles.headerIcon}>
                    <ListPlus size={18} />
                  </div>
                  <div className={styles.titleGroup}>
                    <h2 className={styles.title}>Добавить в плейлист</h2>
                    <p className={styles.subtitle} title={track.title}>
                      {track.title} — {track.artist}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className={styles.closeBtn}
                  onClick={onClose}
                  aria-label="Закрыть окно"
                >
                  <X size={18} />
                </button>
              </header>

              <div className={styles.playlistList} role="listbox" aria-label="Плейлисты">
                {isPlaylistsLoading ? (
                  <div className={styles.listState}>
                    <Loader2 size={15} className={styles.spinner} />
                    <span>Загрузка плейлистов…</span>
                  </div>
                ) : playlists.length === 0 ? (
                  <div className={styles.listState}>
                    <Music2 size={16} />
                    <span>У вас пока нет плейлистов</span>
                  </div>
                ) : (
                  playlists.map((playlist: Playlist) => {
                    const isPending = pendingPlaylistId === playlist.id;
                    return (
                      <button
                        key={playlist.id}
                        type="button"
                        className={styles.playlistRow}
                        role="option"
                        aria-selected={false}
                        disabled={pendingPlaylistId !== null}
                        onClick={() => handleSelect(playlist)}
                      >
                        <div className={styles.playlistCover}>
                          <Music2 size={14} />
                        </div>
                        <span className={styles.playlistName} title={playlist.name || playlist.title}>
                          {playlist.name || playlist.title || 'Плейлист'}
                        </span>
                        <span className={styles.playlistCount}>
                          {playlist.track_count ?? 0}
                        </span>
                        {isPending && <Loader2 size={14} className={styles.spinner} />}
                      </button>
                    );
                  })
                )}
              </div>

              <button
                type="button"
                className={styles.createNewBtn}
                onClick={() => setIsCreateOpen(true)}
                disabled={pendingPlaylistId !== null}
              >
                <Plus size={15} />
                <span>Создать новый плейлист</span>
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <PlaylistFormModal
        isOpen={isCreateOpen}
        mode="create"
        elevated
        onClose={() => setIsCreateOpen(false)}
        onSuccess={handlePlaylistCreated}
      />
    </>
  );
};
