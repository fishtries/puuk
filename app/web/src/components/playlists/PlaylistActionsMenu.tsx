import React, { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { deletePlaylist } from '../../api/tracks';
import { Playlist } from '../../types/track';
import { toast } from 'sonner';
import { PlaylistFormModal } from './PlaylistFormModal';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import styles from './PlaylistActionsMenu.module.css';

interface PlaylistActionsMenuProps {
  playlist: Playlist;
  onChanged?: (playlist: Playlist) => void;
  onDeleted?: (playlistId: string) => void;
}

export const PlaylistActionsMenu: React.FC<PlaylistActionsMenuProps> = ({
  playlist,
  onChanged,
  onDeleted,
}) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isMenuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isMenuOpen]);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deletePlaylist(playlist.id);
      toast.success('Плейлист удалён');
      setIsConfirmOpen(false);
      onDeleted?.(String(playlist.id));
    } catch (err) {
      toast.error((err as Error).message || 'Не удалось удалить плейлист');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className={styles.root} ref={menuRef}>
      <button
        type="button"
        className={`${styles.menuBtn} ${isMenuOpen ? styles.menuBtnActive : ''}`}
        aria-label={`Действия с плейлистом «${playlist.name || playlist.title || ''}»`}
        title="Действия"
        aria-expanded={isMenuOpen}
        onClick={() => setIsMenuOpen((v) => !v)}
      >
        <MoreHorizontal size={16} />
      </button>

      {isMenuOpen && (
        <div className={styles.dropdown} role="menu">
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            onClick={() => {
              setIsMenuOpen(false);
              setIsEditOpen(true);
            }}
          >
            <Pencil size={14} />
            <span>Редактировать</span>
          </button>
          <button
            type="button"
            className={`${styles.menuItem} ${styles.menuItemDanger}`}
            role="menuitem"
            onClick={() => {
              setIsMenuOpen(false);
              setIsConfirmOpen(true);
            }}
          >
            <Trash2 size={14} />
            <span>Удалить</span>
          </button>
        </div>
      )}

      <PlaylistFormModal
        isOpen={isEditOpen}
        mode="edit"
        playlist={playlist}
        onClose={() => setIsEditOpen(false)}
        onSuccess={(updated) => {
          setIsEditOpen(false);
          onChanged?.(updated);
        }}
      />

      <ConfirmDeleteModal
        isOpen={isConfirmOpen}
        title="Удалить плейлист?"
        message={`Плейлист «${playlist.name || playlist.title || ''}» будет удалён навсегда. Треки останутся в библиотеке.`}
        isSubmitting={isDeleting}
        onClose={() => setIsConfirmOpen(false)}
        onConfirm={handleDelete}
      />
    </div>
  );
};
