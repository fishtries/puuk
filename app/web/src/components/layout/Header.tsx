import React from 'react';
import { Search, X } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import styles from './Header.module.css';

interface HeaderProps {
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
}

export const Header: React.FC<HeaderProps> = ({
  searchInputRef,
  searchQuery,
  setSearchQuery,
}) => {
  const activeView = usePlayerStore((state) => state.activeView);
  const setActiveView = usePlayerStore((state) => state.setActiveView);

  const getTitle = () => {
    switch (activeView) {
      case 'home':
        return 'Главная';
      case 'search':
        return 'Поиск по каталогу';
      case 'library':
        return 'Медиатека';
      default:
        return 'Puuk Music';
    }
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    if (activeView !== 'search' && e.target.value.trim().length > 0) {
      setActiveView('search');
    }
  };

  return (
    <header className={styles.header}>
      <h1 className={styles.viewTitle}>{getTitle()}</h1>

      <div className={styles.searchWrapper}>
        <Search size={16} className={styles.searchIcon} />
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Треки, альбомы, исполнители..."
          value={searchQuery}
          onChange={handleSearchChange}
          className={styles.searchInput}
          onFocus={() => {
            if (activeView !== 'search' && searchQuery) {
              setActiveView('search');
            }
          }}
        />
        {searchQuery ? (
          <button
            type="button"
            className={styles.clearBtn}
            onClick={() => setSearchQuery('')}
            aria-label="Очистить поиск"
          >
            <X size={14} />
          </button>
        ) : (
          <kbd className={styles.kbdShortcut}>/</kbd>
        )}
      </div>
    </header>
  );
};
