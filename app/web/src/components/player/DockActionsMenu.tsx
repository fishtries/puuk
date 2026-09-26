import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { ListMusic, Tag, ListPlus, MoreHorizontal } from 'lucide-react';
import styles from './DockActionsMenu.module.css';

const MENU_SPRING = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 30,
  mass: 0.7,
};

const MENU_EXIT = {
  duration: 0.12,
  ease: [0.4, 0, 1, 1] as [number, number, number, number],
};

interface DockActionsMenuProps {
  isQueueInfoActive: boolean;
  onToggleQueueInfo: () => void;
  onEditTags?: () => void;
  onAddToPlaylist?: () => void;
  onOpen?: () => void;
}

export const DockActionsMenu: React.FC<DockActionsMenuProps> = ({
  isQueueInfoActive,
  onToggleQueueInfo,
  onEditTags,
  onAddToPlaylist,
  onOpen,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const close = () => setIsOpen(false);

  const handleToggle = () => {
    setIsOpen((v) => {
      const next = !v;
      if (next) onOpen?.();
      return next;
    });
  };

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        onClick={handleToggle}
        className={`${styles.menuBtn} ${isOpen ? styles.menuBtnActive : ''}`}
        title="Ещё действия"
        aria-label="Дополнительные действия с треком"
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <MoreHorizontal size={19} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            className={styles.menu}
            role="menu"
            aria-label="Действия с треком"
            initial={{ opacity: 0, scale: 0.92, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 8, transition: MENU_EXIT }}
            transition={reduceMotion ? { duration: 0 } : MENU_SPRING}
            style={{ transformOrigin: 'bottom right' }}
          >
            <button
              type="button"
              role="menuitem"
              className={`${styles.menuItem} ${isQueueInfoActive ? styles.menuItemActive : ''}`}
              onClick={() => {
                close();
                onToggleQueueInfo();
              }}
            >
              <span className={styles.menuItemIcon}>
                <ListMusic size={16} />
              </span>
              <span>Очередь и информация</span>
            </button>

            {onEditTags && (
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => {
                  close();
                  onEditTags();
                }}
              >
                <span className={styles.menuItemIcon}>
                  <Tag size={16} />
                </span>
                <span>Редактировать теги</span>
              </button>
            )}

            {onAddToPlaylist && (
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => {
                  close();
                  onAddToPlaylist();
                }}
              >
                <span className={styles.menuItemIcon}>
                  <ListPlus size={16} />
                </span>
                <span>Добавить в плейлист</span>
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
