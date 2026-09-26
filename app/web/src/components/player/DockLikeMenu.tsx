import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Heart, Loader2, Plus, HeartCrack } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Playlist } from '../../types/track';
import { toast } from 'sonner';
import styles from './DockLikeMenu.module.css';

const MENU_SPRING = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 30,
  mass: 0.7,
};

const MENU_EXIT = {
  duration: 0.12,
  ease: [0.4, 0, 1, 1] as [number, number, number, number],
};

interface DockLikeMenuProps {
  isLiked: boolean;
  onLike: () => void;
  playlists: Playlist[];
  isPlaylistsLoading: boolean;
  onAddToPlaylist: (playlist: Playlist) => Promise<'added' | 'already_exists'>;
  onCreatePlaylist?: () => void;
  onRemoveFromFavorites?: () => void;
}

export const DockLikeMenu: React.FC<DockLikeMenuProps> = ({
  isLiked,
  onLike,
  playlists,
  isPlaylistsLoading,
  onAddToPlaylist,
  onCreatePlaylist,
  onRemoveFromFavorites,
}) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isMenuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMenuOpen]);

  const handleLikeClick = () => {
    if (isLiked) {
      setIsMenuOpen((v) => !v);
    } else {
      onLike();
    }
  };

  const handleSelectPlaylist = async (playlist: Playlist) => {
    if (pendingId) return;
    setPendingId(playlist.id);
    try {
      const status = await onAddToPlaylist(playlist);
      if (status === 'already_exists') {
        toast.info('Трек уже есть в этом плейлисте');
      } else {
        toast.success(`Добавлено в «${playlist.name || playlist.title}»`);
      }
      void queryClient.invalidateQueries({ queryKey: ['playlist', String(playlist.id)] });
      void queryClient.invalidateQueries({ queryKey: ['playlists'] });
      setIsMenuOpen(false);
    } catch (err) {
      toast.error((err as Error).message || 'Не удалось добавить трек в плейлист');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        onClick={handleLikeClick}
        className={`${styles.likeBtn} ${isLiked ? styles.likedBtn : ''}`}
        title={isLiked ? 'В избранном — плейлисты' : 'В избранное'}
        aria-label={isLiked ? 'Добавить в плейлист' : 'В избранное'}
        aria-haspopup="menu"
        aria-expanded={isLiked ? isMenuOpen : undefined}
      >
        <Heart size={18} fill={isLiked ? 'currentColor' : 'none'} />
      </button>

      <AnimatePresence>
        {isMenuOpen && (
          <motion.div
            className={styles.menu}
            role="menu"
            aria-label="Добавить в плейлист"
            initial={{ opacity: 0, scale: 0.92, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 8, transition: MENU_EXIT }}
            transition={reduceMotion ? { duration: 0 } : MENU_SPRING}
            style={{ transformOrigin: 'bottom left' }}
          >
            {onRemoveFromFavorites && (
              <button
                type="button"
                role="menuitem"
                className={`${styles.menuItem} ${styles.menuItemDanger}`}
                onClick={() => {
                  onRemoveFromFavorites();
                  setIsMenuOpen(false);
                }}
              >
                <span className={styles.menuItemIcon}>
                  <HeartCrack size={15} />
                </span>
                <span>Убрать из избранного</span>
              </button>
            )}

            <div className={styles.menuHeader}>Добавить в плейлист</div>

            <div className={styles.playlistScroll}>
              {isPlaylistsLoading ? (
                <div className={styles.listState}>
                  <Loader2 size={14} className={styles.spinner} />
                  <span>Загрузка…</span>
                </div>
              ) : playlists.length === 0 ? (
                <div className={styles.listState}>
                  <span>Нет плейлистов</span>
                </div>
              ) : (
                playlists.map((playlist) => (
                  <button
                    key={playlist.id}
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    disabled={pendingId !== null}
                    onClick={() => handleSelectPlaylist(playlist)}
                  >
                    <span className={styles.menuItemIcon}>
                      <Heart size={13} />
                    </span>
                    <span className={styles.playlistName}>
                      {playlist.name || playlist.title || 'Плейлист'}
                    </span>
                    {pendingId === playlist.id && (
                      <Loader2 size={13} className={styles.spinner} />
                    )}
                  </button>
                ))
              )}
            </div>

            {onCreatePlaylist && (
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                disabled={pendingId !== null}
                onClick={onCreatePlaylist}
              >
                <span className={styles.menuItemIcon}>
                  <Plus size={15} />
                </span>
                <span>Создать плейлист</span>
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
