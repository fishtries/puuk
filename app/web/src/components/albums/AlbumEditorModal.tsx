import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Disc3,
  Check,
  AlertCircle,
  Loader2,
  Image as ImageIcon,
  Trash2,
  Info,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAlbumEditorStore } from '../../store/useAlbumEditorStore';
import { updateAlbum } from '../../api/tracks';
import { AlbumEditPayloadDTO } from '../../types/track';
import styles from '../tags/TagEditorModal.module.css';
import coverStyles from './AlbumEditorModal.module.css';

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function AlbumEditorForm({ onClose }: { onClose: () => void }) {
  const album = useAlbumEditorStore((state) => state.album);
  const queryClient = useQueryClient();

  const [title, setTitle] = useState(album?.title ?? '');
  const [albumArtist, setAlbumArtist] = useState(album?.album_artist ?? album?.artist ?? '');
  const [year, setYear] = useState(album?.year ? String(album.year) : '');
  const [coverAction, setCoverAction] = useState<'keep' | 'replace' | 'remove'>('keep');
  const [coverBase64, setCoverBase64] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!album) return;
    setTitle(album.title ?? '');
    setAlbumArtist(album.album_artist ?? album.artist ?? '');
    setYear(album.year ? String(album.year) : '');
    setCoverAction('keep');
    setCoverBase64(null);
    setErrorMessage(null);
  }, [album]);

  if (!album) return null;

  const handleCoverPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const base64 = await readFileAsBase64(file);
      setCoverBase64(base64);
      setCoverAction('replace');
    } catch {
      setErrorMessage('Не удалось прочитать изображение');
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setErrorMessage(null);

    const payload: AlbumEditPayloadDTO = {
      title: title.trim(),
      album_artist: albumArtist.trim(),
      year: year.trim() || null,
      cover_action: coverAction,
      cover_base64: coverAction === 'replace' ? coverBase64 : null,
    };

    try {
      const result = await updateAlbum(album.id, payload);

      void queryClient.invalidateQueries({ queryKey: ['albums'] });
      void queryClient.invalidateQueries({ queryKey: ['album', String(result.album.id)] });
      void queryClient.invalidateQueries({ queryKey: ['album-tracks', String(album.id)] });
      void queryClient.invalidateQueries({ queryKey: ['album-tracks', String(result.album.id)] });
      void queryClient.invalidateQueries({ queryKey: ['tracks'] });
      void queryClient.invalidateQueries({ queryKey: ['search'] });

      if (result.status === 'partial') {
        toast.warning(
          `Альбом обновлён частично: не удалось изменить ${result.failed_tracks.length} трек(ов)`
        );
      } else {
        toast.success(result.merged ? 'Альбомы объединены' : 'Альбом обновлён');
      }
      onClose();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Не удалось сохранить альбом');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <motion.div
      className={styles.modal}
      onClick={(e) => e.stopPropagation()}
      initial={{ opacity: 0, scale: 0.95, y: 15 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: 15 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      role="dialog"
      aria-label="Редактор альбома"
    >
      <div className={styles.header}>
        <div className={styles.headerInfo}>
          <div className={styles.headerIcon}>
            <Disc3 size={20} />
          </div>
          <div className={styles.titleGroup}>
            <h2 className={styles.title}>Редактор альбома</h2>
            <p className={styles.subtitle} title={album.title}>
              {album.title}
              {album.track_count ? ` — ${album.track_count} трек(ов)` : ''}
            </p>
          </div>
        </div>

        <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Закрыть редактор альбома">
          <X size={18} />
        </button>
      </div>

      <div className={styles.tabContent}>
        <div className={coverStyles.warning}>
          <Info size={15} />
          <span>Изменения будут записаны в теги ID3 всех треков этого альбома.</span>
        </div>

        <div className={styles.formGrid}>
          <div className={`${styles.fieldGroup} ${styles.fullWidth}`}>
            <label className={styles.label} htmlFor="album-editor-title">Название альбома</label>
            <input
              id="album-editor-title"
              className={styles.input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Название релиза"
            />
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="album-editor-artist">Исполнитель альбома</label>
            <input
              id="album-editor-artist"
              className={styles.input}
              value={albumArtist}
              onChange={(e) => setAlbumArtist(e.target.value)}
              placeholder="Daft Punk / Various Artists"
            />
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="album-editor-year">Год</label>
            <input
              id="album-editor-year"
              className={styles.input}
              value={year}
              onChange={(e) => setYear(e.target.value)}
              placeholder="1997"
            />
          </div>
        </div>

        <div className={coverStyles.coverRow}>
          <div className={coverStyles.coverInfo}>
            <ImageIcon size={15} />
            <span>
              {coverAction === 'replace'
                ? 'Новая обложка будет применена ко всем трекам'
                : coverAction === 'remove'
                ? 'Обложка будет удалена у всех треков'
                : 'Обложка не изменится'}
            </span>
          </div>

          <div className={coverStyles.coverBtns}>
            <label className={styles.coverBtn} htmlFor="album-editor-cover">
              <ImageIcon size={13} />
              <span>Выбрать</span>
              <input
                id="album-editor-cover"
                type="file"
                accept="image/*"
                onChange={handleCoverPick}
                hidden
              />
            </label>

            <button
              type="button"
              className={`${styles.coverBtn} ${styles.coverBtnDanger}`}
              onClick={() => {
                setCoverBase64(null);
                setCoverAction(coverAction === 'remove' ? 'keep' : 'remove');
              }}
            >
              <Trash2 size={13} />
              <span>Удалить</span>
            </button>
          </div>
        </div>
      </div>

      <div className={styles.footer}>
        {errorMessage && (
          <div className={styles.errorBanner} title={errorMessage}>
            <AlertCircle size={15} />
            <span>{errorMessage}</span>
          </div>
        )}

        <button type="button" className={styles.cancelBtn} onClick={onClose} disabled={isSaving}>
          Отмена
        </button>

        <button
          type="button"
          className={styles.saveBtn}
          onClick={handleSave}
          disabled={isSaving || !title.trim()}
        >
          {isSaving ? (
            <>
              <Loader2 size={15} className={styles.spinner} />
              <span>Сохранение...</span>
            </>
          ) : (
            <>
              <Check size={15} />
              <span>Сохранить альбом</span>
            </>
          )}
        </button>
      </div>
    </motion.div>
  );
}

export const AlbumEditorModal: React.FC = () => {
  const isOpen = useAlbumEditorStore((state) => state.isOpen);
  const album = useAlbumEditorStore((state) => state.album);
  const closeAlbumEditor = useAlbumEditorStore((state) => state.closeAlbumEditor);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAlbumEditor();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeAlbumEditor]);

  // Refresh the album DTO before editing so stale catalog data is not written back.
  useEffect(() => {
    if (!isOpen || !album) return;
    void queryClient.invalidateQueries({ queryKey: ['album', String(album.id)] });
  }, [isOpen, album, queryClient]);

  if (!isOpen || !album) return null;

  return (
    <AnimatePresence>
      <div className={styles.backdrop} onClick={closeAlbumEditor}>
        <AlbumEditorForm key={album.id} onClose={closeAlbumEditor} />
      </div>
    </AnimatePresence>
  );
};
