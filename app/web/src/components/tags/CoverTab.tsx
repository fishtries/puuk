import React from 'react';
import { Upload, Trash2, RotateCcw, Music2 } from 'lucide-react';
import { getCoverUrl } from '../../api/tracks';
import { AuthorizedImage } from '../common/AuthorizedImage';
import type { TagEditorFormApi } from './useTagEditorForm';
import styles from './TagEditorModal.module.css';

export const CoverTab: React.FC<{ form: TagEditorFormApi }> = ({ form }) => (
  <div className={styles.coverTabContainer}>
    <div className={styles.coverPreviewCard}>
      <div className={styles.coverImageWrapper}>
        {form.coverAction === 'remove' ? (
          <div className={styles.coverRemovedBadge}>Будет удалена</div>
        ) : form.coverPreviewUrl ? (
          <AuthorizedImage src={form.coverPreviewUrl} alt="Cover Preview" className={styles.coverImagePreview} />
        ) : (
          <div className={styles.coverPlaceholder}>
            <Music2 size={40} />
            <span>Нет обложки</span>
          </div>
        )}
      </div>

      <div className={styles.coverStatusBadge}>
        {form.coverAction === 'remove'
          ? 'Удаление при сохранении'
          : form.coverAction === 'replace'
            ? 'Новая обложка выбрана'
            : 'Текущая обложка трека'}
      </div>
    </div>

    <div className={styles.coverActionCol}>
      <div
        className={`${styles.dropzone} ${form.isDraggingOver ? styles.dropzoneActive : ''}`}
        onClick={() => form.fileInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          form.setIsDraggingOver(true);
        }}
        onDragLeave={() => form.setIsDraggingOver(false)}
        onDrop={form.handleDrop}
      >
        <Upload size={28} color="var(--accent-color)" />
        <span className={styles.dropzoneTitle}>Перетащите обложку сюда или нажмите для выбора</span>
        <span className={styles.dropzoneHint}>Поддерживаются JPG, PNG, WebP (разрешение до 3000x3000px)</span>
        <input
          ref={form.fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={{ display: 'none' }}
          onChange={form.handleFileInputChange}
        />
      </div>

      <div className={styles.coverBtnsRow}>
        <button type="button" className={styles.coverBtn} onClick={() => form.fileInputRef.current?.click()}>
          <Upload size={14} />
          <span>Выбрать файл</span>
        </button>

        {form.coverAction !== 'remove' && (
          <button
            type="button"
            className={`${styles.coverBtn} ${styles.coverBtnDanger}`}
            onClick={() => {
              form.setCoverAction('remove');
              form.setCoverBase64(null);
              form.setCoverMime(null);
            }}
          >
            <Trash2 size={14} />
            <span>Удалить обложку</span>
          </button>
        )}

        {form.coverAction !== 'keep' && (
          <button
            type="button"
            className={styles.coverBtn}
            onClick={() => {
              form.setCoverAction('keep');
              form.setCoverPreviewUrl(getCoverUrl(form.currentTrackData));
              form.setCoverBase64(null);
              form.setCoverMime(null);
            }}
          >
            <RotateCcw size={14} />
            <span>Сбросить</span>
          </button>
        )}
      </div>
    </div>
  </div>
);
