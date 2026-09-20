import React from 'react';
import {
  Home,
  Search,
  Library,
  Radio,
  Heart,
  Terminal,
  User as UserIcon,
  LogIn,
  Disc3,
} from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useAuthStore } from '../../store/useAuthStore';
import styles from './Sidebar.module.css';

export const Sidebar: React.FC = () => {
  const activeView = usePlayerStore((state) => state.activeView);
  const setActiveView = usePlayerStore((state) => state.setActiveView);
  const isWaveActive = usePlayerStore((state) => state.isWaveActive);
  const toggleWave = usePlayerStore((state) => state.toggleWave);
  const isDebugOpen = usePlayerStore((state) => state.isDebugOpen);
  const setIsDebugOpen = usePlayerStore((state) => state.setIsDebugOpen);
  const setIsLoginOpen = usePlayerStore((state) => state.setIsLoginOpen);

  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);

  return (
    <aside className={styles.sidebar} aria-label="Основная навигация">
      {/* Brand Header */}
      <div className={styles.brandRow}>
        <div className={styles.logoGroup}>
          <Disc3 size={24} className={styles.logoIcon} />
          <span className={styles.brandName}>puuk</span>
        </div>
        <button
          type="button"
          className={`${styles.debugPill} ${isDebugOpen ? styles.debugPillActive : ''}`}
          onClick={() => setIsDebugOpen(!isDebugOpen)}
          title="Панель диагностики движка (~)"
          aria-label="Диагностика"
        >
          <Terminal size={13} />
          <span>~</span>
        </button>
      </div>

      {/* Main Navigation */}
      <nav className={styles.navGroup} aria-label="Меню">
        <button
          type="button"
          className={`${styles.navItem} ${activeView === 'home' ? styles.activeNavItem : ''}`}
          onClick={() => setActiveView('home')}
        >
          <Home size={18} />
          <span>Главная</span>
        </button>

        <button
          type="button"
          className={`${styles.navItem} ${activeView === 'search' ? styles.activeNavItem : ''}`}
          onClick={() => setActiveView('search')}
        >
          <Search size={18} />
          <span>Поиск</span>
        </button>

        <button
          type="button"
          className={`${styles.navItem} ${activeView === 'library' ? styles.activeNavItem : ''}`}
          onClick={() => setActiveView('library')}
        >
          <Library size={18} />
          <span>Медиатека</span>
        </button>

        <button
          type="button"
          className={`${styles.waveItem} ${isWaveActive ? styles.waveItemActive : ''}`}
          onClick={toggleWave}
          title="Запустить персональный поток нейросетевых рекомендаций"
        >
          <Radio size={18} className={styles.waveIcon} />
          <span className={styles.waveText}>Моя Волна</span>
          {isWaveActive && <span className={styles.liveBadge}>LIVE</span>}
        </button>
      </nav>

      <div className={styles.divider} />

      {/* Quick Playlists / Library section */}
      <div className={styles.librarySection}>
        <span className={styles.sectionHeading}>КОЛЛЕКЦИЯ</span>
        <button
          type="button"
          className={styles.playlistItem}
          onClick={() => setActiveView('library')}
        >
          <div className={styles.heartIconWrap}>
            <Heart size={14} fill="currentColor" />
          </div>
          <span>Любимые треки</span>
        </button>
      </div>

      {/* Footer Profile / Login */}
      <div className={styles.footerSection}>
        {user ? (
          <button
            type="button"
            className={styles.userButton}
            onClick={logout}
            title="Нажмите для выхода из аккаунта"
          >
            <div className={styles.avatarPlaceholder}>
              <UserIcon size={14} />
            </div>
            <span className={styles.username}>{user.username}</span>
          </button>
        ) : (
          <button
            type="button"
            className={styles.loginButton}
            onClick={() => setIsLoginOpen(true)}
          >
            <LogIn size={16} />
            <span>Войти</span>
          </button>
        )}
      </div>
    </aside>
  );
};
