import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Tag,
  Image as ImageIcon,
  FileText,
  SlidersHorizontal,
  Check,
  AlertCircle,
  Loader2,
  Trash2,
} from 'lucide-react';
import { useTagEditorStore } from '../../store/useTagEditorStore';
import { ConfirmDeleteModal } from '../playlists/ConfirmDeleteModal';
import styles from './TagEditorModal.module.css';
import { useTagEditorForm } from './useTagEditorForm';
import { TagsTab } from './TagsTab';
import { CoverTab } from './CoverTab';
import { LyricsTab } from './LyricsTab';
import { SpecsTab } from './SpecsTab';

function TagEditorForm({ initialTrack, onClose }: { initialTrack: import('../../types/track').Track; onClose: () => void }) {
  const form = useTagEditorForm(initialTrack, onClose);
  const { activeTab, setActiveTab, currentTrackData } = form;

  return (
    <motion.div
      className={styles.modal}
      onClick={(e) => e.stopPropagation()}
      initial={{ opacity: 0, scale: 0.95, y: 15 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: 15 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      role="dialog"
      aria-label="Редактор тегов ID3"
    >
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerInfo}>
          <div className={styles.headerIcon}>
            <Tag size={20} />
          </div>
          <div className={styles.titleGroup}>
            <h2 className={styles.title}>Редактор тегов</h2>
            <p className={styles.subtitle} title={currentTrackData.title}>
              {currentTrackData.title} — {currentTrackData.artist}
            </p>
          </div>
        </div>

        <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Закрыть редактор тегов">
          <X size={18} />
        </button>
      </div>

      {/* Tab Navigation */}
      <div className={styles.tabNav}>
        <button
          type="button"
          className={`${styles.tabBtn} ${activeTab === 'tags' ? styles.activeTabBtn : ''}`}
          onClick={() => setActiveTab('tags')}
        >
          <Tag size={15} />
          <span>Теги</span>
        </button>

        <button
          type="button"
          className={`${styles.tabBtn} ${activeTab === 'cover' ? styles.activeTabBtn : ''}`}
          onClick={() => setActiveTab('cover')}
        >
          <ImageIcon size={15} />
          <span>Обложка</span>
        </button>

        <button
          type="button"
          className={`${styles.tabBtn} ${activeTab === 'lyrics' ? styles.activeTabBtn : ''}`}
          onClick={() => setActiveTab('lyrics')}
        >
          <FileText size={15} />
          <span>Текст</span>
        </button>

        <button
          type="button"
          className={`${styles.tabBtn} ${activeTab === 'specs' ? styles.activeTabBtn : ''}`}
          onClick={() => setActiveTab('specs')}
        >
          <SlidersHorizontal size={15} />
          <span>Свойства</span>
        </button>
      </div>

      {/* Tab Content */}
      <div className={styles.tabContent}>
        {activeTab === 'tags' && <TagsTab form={form} />}
        {activeTab === 'cover' && <CoverTab form={form} />}
        {activeTab === 'lyrics' && <LyricsTab form={form} />}
        {activeTab === 'specs' && <SpecsTab form={form} />}
      </div>

      {/* Footer */}
      <div className={styles.footer}>
        {form.errorMessage && (
          <div className={styles.errorBanner} title={form.errorMessage}>
            <AlertCircle size={15} />
            <span>{form.errorMessage}</span>
          </div>
        )}

        <div className={styles.footerActions}>
          <button
            type="button"
            className={styles.deleteBtn}
            onClick={() => form.setIsDeleteConfirmOpen(true)}
            disabled={form.isSaving || form.isResyncing || form.isDeleting}
            aria-label="Удалить трек из библиотеки"
          >
            <Trash2 size={15} />
            <span>Удалить трек</span>
          </button>

          <div className={styles.footerSpacer} />

          <button type="button" className={styles.cancelBtn} onClick={onClose} disabled={form.isSaving}>
            Отмена
          </button>

          <button type="button" className={styles.saveBtn} onClick={form.handleSave} disabled={form.isSaving}>
            {form.isSaving ? (
              <>
                <Loader2 size={15} className={styles.spinner} />
                <span>Сохранение...</span>
              </>
            ) : (
              <>
                <Check size={15} />
                <span>Сохранить изменения</span>
              </>
            )}
          </button>
        </div>
      </div>

      <ConfirmDeleteModal
        isOpen={form.isDeleteConfirmOpen}
        title="Удалить трек?"
        message={`«${currentTrackData.title} — ${currentTrackData.artist}» будет удалён из библиотеки вместе с аудиофайлом на диске. Действие необратимо.`}
        confirmLabel={form.isDeleting ? 'Удаление...' : 'Удалить безвозвратно'}
        isSubmitting={form.isDeleting}
        onClose={() => form.setIsDeleteConfirmOpen(false)}
        onConfirm={form.handleDelete}
      />
    </motion.div>
  );
}

export const TagEditorModal: React.FC = () => {
  const isOpen = useTagEditorStore((state) => state.isOpen);
  const track = useTagEditorStore((state) => state.track);
  const closeTagEditor = useTagEditorStore((state) => state.closeTagEditor);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeTagEditor();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeTagEditor]);

  if (!isOpen || !track) return null;

  return (
    <AnimatePresence>
      <div className={styles.backdrop} onClick={closeTagEditor}>
        <TagEditorForm key={track.id} initialTrack={track} onClose={closeTagEditor} />
      </div>
    </AnimatePresence>
  );
};
