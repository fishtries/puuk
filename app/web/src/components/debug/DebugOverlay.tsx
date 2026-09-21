import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Activity, Cpu, Disc, Volume2, AlignLeft, RefreshCw, Waves } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { WAVE_MAX_BUFFER_SIZE } from '../../store/waveQueue';
import { audioEngine } from '../../engine/AudioEngine';
import styles from './DebugOverlay.module.css';

export const DebugOverlay: React.FC = () => {
  const isDebugOpen = usePlayerStore((state) => state.isDebugOpen);
  const setIsDebugOpen = usePlayerStore((state) => state.setIsDebugOpen);
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const status = usePlayerStore((state) => state.status);
  const currentTime = usePlayerStore((state) => state.currentTime);
  const duration = usePlayerStore((state) => state.duration);
  const volume = usePlayerStore((state) => state.volume);
  const queue = usePlayerStore((state) => state.queue);
  const currentTrackIndex = usePlayerStore((state) => state.currentTrackIndex);
  const isWaveActive = usePlayerStore((state) => state.isWaveActive);
  const isWaveLoading = usePlayerStore((state) => state.isWaveLoading);
  const wavePlayedIds = usePlayerStore((state) => state.wavePlayedIds);
  const lyrics = usePlayerStore((state) => state.lyrics);

  const [audioContextState, setAudioContextState] = useState('unknown');

  const playedSet = new Set(wavePlayedIds);
  const upcomingBufferCount = queue
    .slice(currentTrackIndex + 1)
    .filter((track) => track?.id && !playedSet.has(track.id)).length;

  useEffect(() => {
    if (isDebugOpen) {
      const interval = setInterval(() => {
        setAudioContextState(audioEngine.getAudioContextState());
      }, 500);
      return () => clearInterval(interval);
    }
  }, [isDebugOpen]);

  return (
    <AnimatePresence>
      {isDebugOpen && (
        <motion.aside
          className={styles.debugPanel}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 20 }}
          transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
          role="dialog"
          aria-label="Audio Engine Diagnostics"
        >
          <header className={styles.header}>
            <div className={styles.titleRow}>
              <Activity size={16} className={styles.headerIcon} />
              <span className={styles.title}>AudioEngine Telemetry</span>
            </div>
            <button
              type="button"
              className={styles.closeBtn}
              onClick={() => setIsDebugOpen(false)}
              aria-label="Закрыть панель отладки"
            >
              <X size={16} />
            </button>
          </header>

          <div className={styles.contentGrid}>
            <div className={styles.section}>
              <div className={styles.sectionTitle}>
                <Cpu size={14} />
                <span>Web Audio Graph</span>
              </div>
              <div className={styles.statsRow}>
                <span className={styles.statLabel}>Context State:</span>
                <span className={`${styles.statValue} ${styles.highlight}`}>
                  {audioContextState}
                </span>
              </div>
              <div className={styles.statsRow}>
                <span className={styles.statLabel}>Analyser FFT:</span>
                <span className={styles.statValue}>128 bins</span>
              </div>
              <div className={styles.statsRow}>
                <span className={styles.statLabel}>Pipeline:</span>
                <span className={styles.statValue}>Source → Gain → Analyser → Dest</span>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.sectionTitle}>
                <Disc size={14} />
                <span>Playback Telemetry</span>
              </div>
              <div className={styles.statsRow}>
                <span className={styles.statLabel}>Engine Status:</span>
                <span className={`${styles.statValue} ${styles.statusBadge}`}>
                  {status.toUpperCase()}
                </span>
              </div>
              <div className={styles.statsRow}>
                <span className={styles.statLabel}>Track ID:</span>
                <span className={styles.statValue}>{currentTrack?.id || 'none'}</span>
              </div>
              <div className={styles.statsRow}>
                <span className={styles.statLabel}>Format:</span>
                <span className={styles.statValue}>
                  {currentTrack?.format?.toUpperCase() || 'PCM / MP3'}
                </span>
              </div>
              <div className={styles.statsRow}>
                <span className={styles.statLabel}>Position:</span>
                <span className={`${styles.statValue} tabular-nums`}>
                  {currentTime.toFixed(2)}s / {duration.toFixed(2)}s
                </span>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.sectionTitle}>
                <Volume2 size={14} />
                <span>Gain & Queue</span>
              </div>
              <div className={styles.statsRow}>
                <span className={styles.statLabel}>Gain Level:</span>
                <span className={`${styles.statValue} tabular-nums`}>
                  {(volume * 100).toFixed(0)}%
                </span>
              </div>
              <div className={styles.statsRow}>
                <span className={styles.statLabel}>Queue Items:</span>
                <span className={`${styles.statValue} tabular-nums`}>
                  {queue.length}
                </span>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.sectionTitle}>
                <AlignLeft size={14} />
                <span>LRC Parser Cache</span>
              </div>
              <div className={styles.statsRow}>
                <span className={styles.statLabel}>Parsed Lines:</span>
                <span className={`${styles.statValue} tabular-nums`}>
                  {lyrics.length}
                </span>
              </div>
              <div className={styles.statsRow}>
                <span className={styles.statLabel}>Sync Mode:</span>
                <span className={styles.statValue}>
                  {lyrics.length > 0 ? 'Millisecond Timestamped' : 'Unparsed / Idle'}
                </span>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.sectionTitle}>
                <Waves size={14} />
                <span>Wave Telemetry</span>
              </div>
              <div className={styles.statsRow}>
                <span className={styles.statLabel}>Wave:</span>
                <span className={`${styles.statValue} ${styles.statusBadge}`}>
                  {isWaveActive ? 'ACTIVE' : 'OFF'}
                </span>
              </div>
              <div className={styles.statsRow}>
                <span className={styles.statLabel}>Loading:</span>
                <span className={`${styles.statValue} ${styles.statusBadge}`}>
                  {isWaveLoading ? 'FETCHING' : 'IDLE'}
                </span>
              </div>
              <div className={styles.statsRow}>
                <span className={styles.statLabel}>Played Count:</span>
                <span className={`${styles.statValue} tabular-nums`}>
                  {wavePlayedIds.length}
                </span>
              </div>
              <div className={styles.statsRow}>
                <span className={styles.statLabel}>Upcoming Buffer:</span>
                <span className={`${styles.statValue} tabular-nums`}>
                  {upcomingBufferCount}
                </span>
              </div>
              <div className={styles.statsRow}>
                <span className={styles.statLabel}>Buffer Cap:</span>
                <span className={`${styles.statValue} tabular-nums`}>
                  {WAVE_MAX_BUFFER_SIZE}
                </span>
              </div>
            </div>
          </div>

          <footer className={styles.footer}>
            <button
              type="button"
              className={styles.actionBtn}
              onClick={() => audioEngine.play()}
            >
              <RefreshCw size={12} />
              <span>Resume Context</span>
            </button>
            <span className={styles.footerHint}>Клавиша [ ~ ]</span>
          </footer>
        </motion.aside>
      )}
    </AnimatePresence>
  );
};
