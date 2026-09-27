import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { User as UserIcon, Volume2, LogOut } from 'lucide-react';
import { User } from '../../types/user';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useAuthStore } from '../../store/useAuthStore';
import styles from './ProfileCapsuleMenu.module.css';

interface ProfileCapsuleMenuProps {
  isOpen: boolean;
  onClose: () => void;
  user: User | null;
  anchorRef?: React.RefObject<HTMLElement | null>;
}

export const ProfileCapsuleMenu: React.FC<ProfileCapsuleMenuProps> = ({
  isOpen,
  onClose,
  user,
  anchorRef,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const isLoudnessEnabled = usePlayerStore((state) => state.isLoudnessNormalizationEnabled);
  const toggleLoudnessNormalization = usePlayerStore((state) => state.toggleLoudnessNormalization);
  const logout = useAuthStore((state) => state.logout);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (menuRef.current && menuRef.current.contains(target)) return;
      if (anchorRef?.current && anchorRef.current.contains(target)) return;
      onClose();
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [isOpen, onClose, anchorRef]);

  const handleLogout = () => {
    logout();
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={menuRef}
          className={styles.menuContainer}
          role="dialog"
          aria-label="Меню профиля"
          initial={{ opacity: 0, scale: 0.95, y: -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -6 }}
          transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
        >
          {user && (
            <div className={styles.userInfoSection}>
              <div className={styles.userAvatar}>
                <UserIcon size={18} />
              </div>
              <div className={styles.userDetails}>
                <span className={styles.userName} title={user.username}>
                  {user.username}
                </span>
                <span className={styles.userRole}>
                  {user.role === 'admin' ? 'Администратор' : 'Пользователь'}
                </span>
              </div>
            </div>
          )}

          {user && <div className={styles.divider} />}

          <div className={styles.menuSection}>
            <div className={styles.settingRow}>
              <div className={styles.settingInfo}>
                <span className={styles.settingTitle}>
                  <Volume2 size={15} />
                  Нормализация громкости
                </span>
                <span className={styles.settingSubtitle}>EBU R128 (-14 LUFS)</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={isLoudnessEnabled}
                aria-label="Включить нормализацию громкости"
                className={`${styles.switchButton} ${isLoudnessEnabled ? styles.switchActive : ''}`}
                onClick={toggleLoudnessNormalization}
              >
                <span className={styles.switchKnob} />
              </button>
            </div>
          </div>

          {user && (
            <>
              <div className={styles.divider} />
              <button
                type="button"
                className={`${styles.actionButton} ${styles.actionButtonDanger}`}
                onClick={handleLogout}
              >
                <LogOut size={15} />
                <span>Выйти из аккаунта</span>
              </button>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
