import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLyrics } from '../../hooks/useLyrics';
import styles from './LyricsQuickPeek.module.css';

interface LyricsQuickPeekProps {
  expanded: boolean;
  onClose: () => void;
  triggerRef?: React.RefObject<HTMLElement | null>;
}

// Motion tokens: WWDC25-2 fluid morphing physics
const SHELL_OPEN = {
  type: 'spring' as const,
  stiffness: 340,
  damping: 25,
  mass: 0.9,
};

const SHELL_CLOSE = {
  duration: 0.2,
  ease: [0.4, 0, 1, 1] as [number, number, number, number],
};

const CONTENT_CLOSE = {
  duration: 0.07,
  ease: [0.4, 0, 1, 1] as [number, number, number, number],
};

const LINE_HEIGHT = 28;

// Lightweight, simple 3-line lyrics stream
const Simple3LineLyrics: React.FC = () => {
  const { lyrics, activeIndex, isLyricsLoading, seek } = useLyrics();

  if (isLyricsLoading) {
    return (
      <div className={styles.emptyNotice}>
        <span>Загрузка текста…</span>
      </div>
    );
  }

  if (lyrics.length === 0) {
    return (
      <div className={styles.emptyNotice}>
        <span>Текст песни недоступен</span>
      </div>
    );
  }

  const currentIdx = Math.max(0, activeIndex);
  const targetY = (1 - currentIdx) * LINE_HEIGHT;

  return (
    <div className={styles.viewport}>
      <div
        className={styles.linesTrack}
        style={{ transform: `translate3d(0, ${targetY}px, 0)` }}
      >
        {lyrics.map((line, idx) => {
          const isActive = idx === activeIndex;

          return (
            <div
              key={`${line.time}-${idx}`}
              className={`${styles.lineSlot} ${isActive ? styles.activeLine : styles.inactiveLine
                }`}
              onClick={() => seek(line.time)}
              title={line.text}
            >
              {line.text || '…'}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const LyricsQuickPeek: React.FC<LyricsQuickPeekProps> = ({
  expanded,
  onClose,
  triggerRef,
}) => {
  const peekRef = useRef<HTMLDivElement | null>(null);

  // Dismiss on click outside or Escape.
  // Ignores clicks on triggerRef so the toggle button can handle toggling!
  useEffect(() => {
    if (!expanded) return;

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;

      // Inside peek -> do nothing
      if (peekRef.current && peekRef.current.contains(target)) {
        return;
      }

      // Inside trigger button -> do nothing (let button onClick toggle)
      if (triggerRef?.current && triggerRef.current.contains(target)) {
        return;
      }

      onClose();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    const frameId = requestAnimationFrame(() => {
      document.addEventListener('mousedown', handlePointerDown);
      document.addEventListener('keydown', handleKeyDown);
    });

    return () => {
      cancelAnimationFrame(frameId);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [expanded, onClose, triggerRef]);

  return (
    <AnimatePresence>
      {expanded && (
        <motion.div
          ref={peekRef}
          className={styles.peek}
          initial={{ width: 34, height: 34, borderRadius: 17, opacity: 0 }}
          animate={{ width: 580, height: 116, borderRadius: 24, opacity: 1 }}
          exit={{
            width: 34,
            height: 34,
            borderRadius: 17,
            opacity: 0,
            transition: SHELL_CLOSE,
          }}
          transition={{
            width: SHELL_OPEN,
            height: SHELL_OPEN,
            borderRadius: { duration: 0.24, ease: [0.22, 1, 0.36, 1] },
            opacity: { duration: 0.15 },
          }}
          style={{ transformOrigin: 'bottom right' }}
          role="region"
          aria-label="Текст песни"
        >
          <motion.div
            className={styles.content}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: CONTENT_CLOSE }}
            transition={{ delay: 0.08, duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          >
            <Simple3LineLyrics />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
