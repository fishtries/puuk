import React from 'react';
import { Search, Loader2 } from 'lucide-react';
import type { TagEditorFormApi } from './useTagEditorForm';
import styles from './TagEditorModal.module.css';

export const LyricsTab: React.FC<{ form: TagEditorFormApi }> = ({ form }) => {
  const isLrcSynced = /\[\d{2}:\d{2}/.test(form.lyrics);
  const lyricsLinesCount = form.lyrics.split(/\r?\n/).filter(Boolean).length;

  return (
    <div className={styles.lyricsAreaWrapper}>
      {/* LRCLIB Search Box */}
      <div className={styles.searchCard}>
        <div className={styles.searchBar}>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Поиск текстов в LRCLIB..."
            value={form.lyricsQuery}
            onChange={(e) => form.setLyricsQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && form.handleSearchLyrics()}
          />
          <button type="button" className={styles.searchBtn} onClick={form.handleSearchLyrics} disabled={form.isSearchingLyrics}>
            {form.isSearchingLyrics ? (
              <Loader2 size={14} className={styles.spinner} />
            ) : (
              <Search size={14} />
            )}
            <span>Найти в LRCLIB</span>
          </button>
        </div>

        {form.lyricsResults.length > 0 && (
          <div className={styles.searchResultsList}>
            {form.lyricsResults.map((item) => {
              const title = item.track_name || item.trackName || 'Без названия';
              const artist = item.artist_name || item.artistName || '';
              const album = item.album_name || item.albumName || '';
              const hasSynced = Boolean(item.synced_lyrics || item.syncedLyrics);
              return (
                <div key={item.id} className={styles.searchResultItem}>
                  <div className={styles.searchResultTexts}>
                    <span className={styles.searchResultTitle}>{title}</span>
                    <span className={styles.searchResultDetails}>
                      {artist} {album ? `• ${album}` : ''} {hasSynced ? '(Синхронизированные LRC)' : '(Обычный текст)'}
                    </span>
                  </div>
                  <button type="button" className={styles.applyResultBtn} onClick={() => form.applyLyricsResult(item)}>
                    Использовать
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <textarea
        className={styles.lyricsTextarea}
        value={form.lyrics}
        onChange={(e) => form.setLyrics(e.target.value)}
        placeholder="[00:12.34] Пример синхронизированной строки..."
      />

      <div className={styles.lyricsStatusRow}>
        <div>
          {isLrcSynced ? (
            <span className={styles.lyricsSyncedBadge}>✓ Синхронизированный LRC</span>
          ) : (
            <span>Обычный текст без таймингов</span>
          )}
        </div>
        <div>
          Строк: {lyricsLinesCount} • Символов: {form.lyrics.length}
        </div>
        {form.lyrics && (
          <button
            type="button"
            className={styles.applyResultBtn}
            style={{ background: 'rgba(239, 68, 68, 0.2)', color: '#fca5a5' }}
            onClick={() => form.setLyrics('')}
          >
            Очистить текст
          </button>
        )}
      </div>
    </div>
  );
};
