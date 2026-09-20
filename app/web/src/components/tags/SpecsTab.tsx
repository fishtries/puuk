import React from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { formatFileSize, formatSampleRate, formatChannels } from './tagFormatters';
import type { TagEditorFormApi } from './useTagEditorForm';
import styles from './TagEditorModal.module.css';

export const SpecsTab: React.FC<{ form: TagEditorFormApi }> = ({ form }) => {
  const t = form.currentTrackData;
  return (
    <>
      <div className={styles.specsGrid}>
        <div className={styles.specTile}>
          <span className={styles.specLabel}>Аудиоформат</span>
          <span className={styles.specValue}>{t.format ? t.format.toUpperCase() : '—'}</span>
        </div>

        <div className={styles.specTile}>
          <span className={styles.specLabel}>Битрейт</span>
          <span className={styles.specValue}>{t.bitrate ? `${t.bitrate} kbps` : '—'}</span>
        </div>

        <div className={styles.specTile}>
          <span className={styles.specLabel}>Частота дискретизации</span>
          <span className={styles.specValue}>{formatSampleRate(t.sample_rate)}</span>
        </div>

        <div className={styles.specTile}>
          <span className={styles.specLabel}>Каналы</span>
          <span className={styles.specValue}>{formatChannels(t.channels)}</span>
        </div>

        <div className={styles.specTile}>
          <span className={styles.specLabel}>Размер файла</span>
          <span className={styles.specValue}>{formatFileSize(t.file_size)}</span>
        </div>

        <div className={styles.specTile}>
          <span className={styles.specLabel}>Версия обложки</span>
          <span className={styles.specValue}>v{t.cover_version ?? 1}</span>
        </div>

        <div className={`${styles.specTile} ${styles.specTileFull}`}>
          <span className={styles.specLabel}>Файл на диске</span>
          <span className={styles.specValue}>{t.file_path || 'Локальный файл в хранилище'}</span>
        </div>
      </div>

      <div className={styles.resyncSection}>
        <div className={styles.resyncTexts}>
          <span className={styles.resyncTitle}>Пересканировать метаданные с диска</span>
          <span className={styles.resyncDesc}>
            Принудительно перечитать ID3 теги, обложку и технические свойства аудиофайла с диска.
          </span>
        </div>

        <button type="button" className={styles.searchBtn} onClick={form.handleResync} disabled={form.isResyncing}>
          {form.isResyncing ? (
            <Loader2 size={14} className={styles.spinner} />
          ) : (
            <RefreshCw size={14} />
          )}
          <span>Пересканировать</span>
        </button>
      </div>
    </>
  );
};
