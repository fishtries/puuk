import React from 'react';
import { Search, Loader2 } from 'lucide-react';
import { MetadataSearchResultDTO } from '../../types/track';
import styles from './TagEditorModal.module.css';

interface MetadataSearchCardProps {
  query: string;
  onQueryChange: (value: string) => void;
  isSearching: boolean;
  results: MetadataSearchResultDTO[];
  onSearch: () => void;
  onApply: (item: MetadataSearchResultDTO) => void;
}

export const MetadataSearchCard: React.FC<MetadataSearchCardProps> = ({
  query,
  onQueryChange,
  isSearching,
  results,
  onSearch,
  onApply,
}) => (
  <div className={styles.searchCard}>
    <div className={styles.searchBar}>
      <input
        type="text"
        className={styles.searchInput}
        placeholder="Поиск по базе iTunes / Deezer..."
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onSearch()}
      />
      <button type="button" className={styles.searchBtn} onClick={onSearch} disabled={isSearching}>
        {isSearching ? (
          <Loader2 size={14} className={styles.spinner} />
        ) : (
          <Search size={14} />
        )}
        <span>Найти онлайн</span>
      </button>
    </div>

    {results.length > 0 && (
      <div className={styles.searchResultsList}>
        {results.map((res, idx) => (
          <div key={`${res.source}-${idx}`} className={styles.searchResultItem}>
            <div className={styles.searchResultMeta}>
              {res.cover_url && <img src={res.cover_url} alt="" className={styles.searchResultCover} />}
              <div className={styles.searchResultTexts}>
                <span className={styles.searchResultTitle}>{res.title}</span>
                <span className={styles.searchResultDetails}>
                  {res.artist} • {res.album} {res.year ? `(${res.year})` : ''} [{res.source}]
                </span>
              </div>
            </div>
            <button type="button" className={styles.applyResultBtn} onClick={() => onApply(res)}>
              Заполнить
            </button>
          </div>
        ))}
      </div>
    )}
  </div>
);
