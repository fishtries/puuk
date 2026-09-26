import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Upload } from 'lucide-react';
import styles from './UploadMusicModal.module.css';

interface UploadMusicModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const UploadMusicModal: React.FC<UploadMusicModalProps> = ({ isOpen, onClose }) => {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <div className={styles.backdrop} onClick={onClose}>
          <motion.div
            className={styles.modal}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 16 }}
            transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
            role="dialog"
            aria-modal="true"
            aria-label="Upload music"
          >
            <header className={styles.header}>
              <h2 className={styles.title}>Upload music</h2>
              <button
                type="button"
                className={styles.closeBtn}
                onClick={onClose}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </header>

            <div className={styles.body}>
              <div className={styles.iconWrap}>
                <Upload size={26} />
              </div>
              <p className={styles.message}>Music uploads are coming later</p>
            </div>

            <div className={styles.actionsRow}>
              <button type="button" className={styles.closeActionBtn} onClick={onClose}>
                Close
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
