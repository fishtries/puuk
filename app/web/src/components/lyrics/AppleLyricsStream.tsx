import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Music, RefreshCw, RotateCcw, Sparkles } from 'lucide-react';
import { useLyrics } from '../../hooks/useLyrics';
import { usePlayerStore } from '../../store/usePlayerStore';
import styles from './AppleLyricsStream.module.css';
import { LyricLineRow } from './LyricLineRow';
import { useKaraokeGeneration } from './useKaraokeGeneration';

export interface AppleLyricsStreamProps {
  variant?: 'fullscreen' | 'peek';
}

export const AppleLyricsStream: React.FC<AppleLyricsStreamProps> = ({
  variant = 'fullscreen',
}) => {
  const { lyrics, activeIndex, isLyricsLoading, seek } = useLyrics();
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const fetchLyrics = usePlayerStore((state) => state.fetchLyrics);
  const {
    generationStatus,
    generationNotice,
    generationError,
    handleGenerateWordLyrics,
  } = useKaraokeGeneration(currentTrack);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const isInitialMountRef = useRef(true);
  const [isManualScrolling, setIsManualScrolling] = useState(false);
  const userInteractionTimeoutRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);

  const [baseTargetY, setBaseTargetY] = useState(0);
  const [userScrollOffset, setUserScrollOffset] = useState(0);

  // Reset initial flag on track switch so new lyrics snap cleanly to start
  useEffect(() => {
    if (userInteractionTimeoutRef.current) {
      window.clearTimeout(userInteractionTimeoutRef.current);
    }
    setIsManualScrolling(false);
    isInitialMountRef.current = true;
    setUserScrollOffset(0);
    setBaseTargetY(0);
  }, [currentTrack?.id]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (userInteractionTimeoutRef.current) {
        window.clearTimeout(userInteractionTimeoutRef.current);
      }
    };
  }, []);

  // Robust optical focal position calculation directly querying lyricsList children
  useEffect(() => {
    if (activeIndex < 0 || !containerRef.current) {
      return;
    }

    // Freeze autoscroll while user is manually scrolling
    if (isManualScrolling) {
      return;
    }

    const updateFocalPosition = () => {
      const container = containerRef.current;
      if (!container) return;

      const list = container.querySelector<HTMLElement>(`.${styles.lyricsList}`);
      if (!list || !list.children) return;

      const activeEl = list.children[activeIndex] as HTMLElement | undefined;
      if (!activeEl) return;

      const containerHeight = container.clientHeight || (variant === 'peek' ? 500 : 580);
      const focalY =
        variant === 'peek'
          ? Math.max(100, containerHeight * 0.36)
          : Math.max(160, containerHeight * 0.40);
      const lineTop = activeEl.offsetTop;
      const lineHeight = activeEl.offsetHeight || 44;

      const newTarget = -(lineTop - focalY + lineHeight / 2);
      setBaseTargetY((prev) => (Math.abs(prev - newTarget) > 0.5 ? newTarget : prev));

      if (isInitialMountRef.current) {
        const t = window.setTimeout(() => {
          isInitialMountRef.current = false;
        }, 250);
        return () => window.clearTimeout(t);
      }
    };

    updateFocalPosition();
    const rafId = requestAnimationFrame(updateFocalPosition);

    const handleResize = () => updateFocalPosition();
    window.addEventListener('resize', handleResize);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      ro = new ResizeObserver(() => {
        updateFocalPosition();
      });
      ro.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      ro?.disconnect();
      cancelAnimationFrame(rafId);
    };
  }, [activeIndex, lyrics, isManualScrolling, variant]);

  const scheduleManualScrollResume = () => {
    if (userInteractionTimeoutRef.current) {
      window.clearTimeout(userInteractionTimeoutRef.current);
    }
    // Exactly 3.0s of inactivity: resume autoscroll & smoothly return to active line
    userInteractionTimeoutRef.current = window.setTimeout(() => {
      setIsManualScrolling(false);
      setUserScrollOffset(0);
    }, 3000);
  };

  // Handle user manual scroll: disable wave & pause autoscroll for 3.0 seconds
  const handleWheel = (e: React.WheelEvent) => {
    setIsManualScrolling(true);
    setUserScrollOffset((prev) => {
      const next = prev - e.deltaY;
      return Math.max(-4000, Math.min(4000, next));
    });
    scheduleManualScrollResume();
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartYRef.current = e.touches[0].clientY;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartYRef.current === null) return;
    const currentY = e.touches[0].clientY;
    const deltaY = touchStartYRef.current - currentY;
    touchStartYRef.current = currentY;

    setIsManualScrolling(true);
    setUserScrollOffset((prev) => {
      const next = prev - deltaY * 1.5;
      return Math.max(-4000, Math.min(4000, next));
    });
    scheduleManualScrollResume();
  };

  const handleTouchEnd = () => {
    touchStartYRef.current = null;
  };

  const handleLineClick = useCallback((time: number) => {
    if (userInteractionTimeoutRef.current) {
      window.clearTimeout(userInteractionTimeoutRef.current);
    }
    setIsManualScrolling(false);
    setUserScrollOffset(0);
    seek(time);
  }, [seek]);

  const handleRefetchLyrics = useCallback(() => {
    if (!currentTrack) return;
    fetchLyrics(currentTrack.id, true);
  }, [currentTrack, fetchLyrics]);

  const hasWordLevel = useMemo(
    () => lyrics.some((l) => l.wordTimingAvailable && l.words && l.words.length > 0),
    [lyrics]
  );

  const computedTargetY = baseTargetY + userScrollOffset;

  return (
    <div
      className={`${styles.stageContainer} ${
        variant === 'peek' ? styles.peekStage : ''
      } ${isManualScrolling ? styles.isScrollBrowsing : ''}`}
    >
      {/* Top Progressive Blur Vignette */}
      <div className={styles.topProgressiveBlur} aria-hidden="true">
        <div className={styles.blurLayer1} />
        <div className={styles.blurLayer2} />
        <div className={styles.blurLayer3} />
      </div>

      {/* Karaoke Word-Level Actions / Generation Bar */}
      {currentTrack && (
        <div className={styles.karaokeHeaderBar}>
          {generationNotice && (
            <div className={styles.generationNotice}>
              <RefreshCw size={12} className={styles.spinIcon} />
              <span>{generationNotice}</span>
            </div>
          )}
          {generationError && (
            <div className={styles.generationError}>
              <span>{generationError}</span>
            </div>
          )}
          {generationStatus !== 'processing' && (
            <>
              {hasWordLevel ? (
                <button
                  type="button"
                  className={styles.regenerateBtn}
                  onClick={() => handleGenerateWordLyrics(true, false)}
                  title="Заново сопоставить слова песни на GPU (RTX 4070)"
                >
                  <RotateCcw size={13} />
                  <span>Пересоздать караоке</span>
                </button>
              ) : lyrics.length > 0 ? (
                <button
                  type="button"
                  className={styles.generateBtn}
                  onClick={() => handleGenerateWordLyrics(false, false)}
                  title="Запустить Whisper AI для пословной караоке-разметки"
                >
                  <Sparkles size={14} />
                  <span>✨ Создать караоке-разметку</span>
                </button>
              ) : null}

              <button
                type="button"
                className={styles.refetchLyricsBtn}
                onClick={handleRefetchLyrics}
                title="Принудительно запросить текст из LRCLIB заново"
              >
                <RefreshCw size={12} />
                <span>Обновить текст</span>
              </button>
            </>
          )}
        </div>
      )}

      {/* Main content: lyrics stream with manual-scroll listeners */}
      <div
        className={styles.scrollArea}
        ref={containerRef}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {lyrics.length > 0 ? (
          <div className={styles.lyricsList}>
            {lyrics.map((line, index) => (
              <LyricLineRow
                key={`${line.time}-${index}`}
                line={line}
                index={index}
                activeIndex={activeIndex}
                targetY={computedTargetY}
                isActive={index === activeIndex}
                isInitial={isInitialMountRef.current}
                isManualScrolling={isManualScrolling}
                onLineClick={handleLineClick}
              />
            ))}
          </div>
        ) : isLyricsLoading ? (
          <div className={styles.stateContainer}>
            <RefreshCw size={28} className={styles.spinIcon} />
            <span>Загрузка синхронизированного текста...</span>
          </div>
        ) : (
          <div className={styles.stateContainer}>
            <Music size={36} className={styles.stateIcon} />
            <h2 className={styles.stateTitle}>Текст песни отсутствует</h2>
            <p className={styles.stateSubtitle}>
              Для этого трека нет синхронизированных строк караоке.
            </p>
            {currentTrack && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                <button
                  type="button"
                  className={styles.retryBtn}
                  onClick={handleRefetchLyrics}
                  title="Заново запросить текст песни из внешнего источника LRCLIB"
                >
                  <RefreshCw size={14} />
                  <span>Повторить поиск текста (LRCLIB)</span>
                </button>
                <button
                  type="button"
                  className={styles.aiGenerateBtn}
                  onClick={() => handleGenerateWordLyrics(true, true)}
                  disabled={generationStatus === 'processing'}
                  title="Сгенерировать текст и разметку караоке через Whisper на GPU"
                >
                  {generationStatus === 'processing' ? (
                    <>
                      <RefreshCw size={14} className={styles.spinIcon} />
                      <span>Whisper AI распознаёт слова на GPU...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles size={14} />
                      <span>✨ Распознать караоке через Whisper AI</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Progressive Blur Vignette */}
      <div className={styles.bottomProgressiveBlur} aria-hidden="true">
        <div className={styles.blurLayer1} />
        <div className={styles.blurLayer2} />
        <div className={styles.blurLayer3} />
      </div>
    </div>
  );
};
