import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, AlignLeft, ListMusic } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { KaraokeLyrics } from '../lyrics/KaraokeLyrics';
import { QueueList } from '../queue/QueueList';
import styles from './RightPanel.module.css';

export const RightPanel: React.FC = () => {
  const isRightPanelOpen = usePlayerStore((state) => state.isRightPanelOpen);
  const setIsRightPanelOpen = usePlayerStore((state) => state.setIsRightPanelOpen);
  const rightPanelTab = usePlayerStore((state) => state.rightPanelTab);
  const setRightPanelTab = usePlayerStore((state) => state.setRightPanelTab);

  return (
    <AnimatePresence>
      {isRightPanelOpen && (
        <motion.aside
          className={styles.panel}
          initial={{ x: 340, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 340, opacity: 0 }}
          transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
          aria-label="Боковая панель текстов и очереди"
        >
          {/* Tabs & Close Header */}
          <header className={styles.header}>
            <div className={styles.tabsRow}>
              <button
                type="button"
                className={`${styles.tabBtn} ${rightPanelTab === 'lyrics' ? styles.activeTab : ''}`}
                onClick={() => setRightPanelTab('lyrics')}
              >
                <AlignLeft size={14} />
                <span>Текст песни</span>
              </button>
              <button
                type="button"
                className={`${styles.tabBtn} ${rightPanelTab === 'queue' ? styles.activeTab : ''}`}
                onClick={() => setRightPanelTab('queue')}
              >
                <ListMusic size={14} />
                <span>Очередь</span>
              </button>
            </div>

            <button
              type="button"
              className={styles.closeBtn}
              onClick={() => setIsRightPanelOpen(false)}
              aria-label="Закрыть панель"
              title="Закрыть (L)"
            >
              <X size={16} />
            </button>
          </header>

          {/* Panel Content */}
          <div className={styles.content}>
            {rightPanelTab === 'lyrics' ? <KaraokeLyrics /> : <QueueList />}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
};
