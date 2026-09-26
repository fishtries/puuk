import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Music2, Loader2 } from 'lucide-react';
import { createPlaylist, updatePlaylist } from '../../api/tracks';
import { Playlist } from '../../types/track';
import { toast } from 'sonner';
import styles from './PlaylistFormModal.module.css';

const NAME_MAX_LENGTH = 100;

interface PlaylistFormModalProps {
  isOpen: boolean;
  mode: 'create' | 'edit';
  playlist?: Playlist | null;
  onClose: () => void;
  onSuccess: (playlist: Playlist) => void;
  elevated?: boolean;
}

export const PlaylistFormModal: React.FC<PlaylistFormModalProps> = ({
  isOpen,
  mode,
  playlist,
  onClose,
  onSuccess,
  elevated = false,
}) => {
  const [name, setName] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setName(mode === 'edit' ? playlist?.name || playlist?.title || '' : '');
    setIsPublic(mode === 'edit' ? Boolean(playlist?.is_public) : false);
    setIsSubmitting(false);
  }, [isOpen, mode, playlist]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const trimmedName = name.trim();
  const isNameChanged = mode === 'create' || trimmedName !== (playlist?.name || playlist?.title || '');
  const isPublicChanged = mode === 'create' || isPublic !== Boolean(playlist?.is_public);
  const canSubmit = trimmedName.length > 0 &&
    trimmedName.length <= NAME_MAX_LENGTH &&
    !isSubmitting &&
    (isNameChanged || isPublicChanged);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setIsSubmitting(true);
    try {
      let result: Playlist;
      if (mode === 'create') {
        result = await createPlaylist({ name: trimmedName, is_public: isPublic });
        toast.success('Плейлист создан');
      } else {
        await updatePlaylist(playlist!.id, { name: trimmedName, is_public: isPublic });
        result = {
          ...(playlist as Playlist),
          name: trimmedName,
          is_public: isPublic,
        };
        toast.success('Плейлист обновлён');
      }
      onSuccess(result);
    } catch (err) {
      toast.error((err as Error).message || 'Не удалось сохранить плейлист');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div
          className={`${styles.backdrop} ${elevated ? styles.backdropElevated : ''}`}
          onClick={onClose}
        >
          <motion.div
            className={styles.modal}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 16 }}
            transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
            role="dialog"
            aria-modal="true"
            aria-label={mode === 'create' ? 'Новый плейлист' : 'Редактировать плейлист'}
          >
            <header className={styles.header}>
              <div className={styles.headerInfo}>
                <div className={styles.headerIcon}>
                  <Music2 size={18} />
                </div>
                <h2 className={styles.title}>
                  {mode === 'create' ? 'Новый плейлист' : 'Редактировать плейлист'}
                </h2>
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

            <form onSubmit={handleSubmit} className={styles.form}>
              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="playlist-name-input">
                  Название
                </label>
                <input
                  id="playlist-name-input"
                  type="text"
                  placeholder="Например: Дорожный плейлист"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={styles.input}
                  autoFocus
                  maxLength={NAME_MAX_LENGTH}
                  disabled={isSubmitting}
                />
                <span className={styles.hint}>
                  {trimmedName.length}/{NAME_MAX_LENGTH}
                </span>
              </div>

              <label className={styles.toggleRow}>
                <span className={styles.toggleText}>
                  <span className={styles.toggleTitle}>Публичный плейлист</span>
                  <span className={styles.toggleHint}>Виден другим пользователям Puuk</span>
                </span>
                <input
                  type="checkbox"
                  className={styles.toggleCheckbox}
                  checked={isPublic}
                  onChange={(e) => setIsPublic(e.target.checked)}
                  disabled={isSubmitting}
                />
                <span className={styles.toggleSwitch} aria-hidden="true" />
              </label>

              <div className={styles.actionsRow}>
                <button
                  type="button"
                  className={styles.cancelBtn}
                  onClick={onClose}
                  disabled={isSubmitting}
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  className={styles.submitBtn}
                  disabled={!canSubmit}
                >
                  {isSubmitting && <Loader2 size={15} className={styles.spinner} />}
                  <span>{mode === 'create' ? 'Создать' : 'Сохранить'}</span>
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
