import React, { useEffect, useRef } from 'react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { LyricsWord } from '../../types/track';
import { canAnimateWord, canSeekToWord } from '../../engine/lyricsMapper';
import styles from './AppleLyricsStream.module.css';

interface WordTimedLineProps {
  words: LyricsWord[];
  isActive: boolean;
  isPast: boolean;
  lineTime: number;
  onWordClick: (time: number) => void;
  onLineClick: (time: number) => void;
}

/**
 * WordTimedLine: High-performance active line renderer for word-level karaoke.
 * Subscribes to time updates via requestAnimationFrame ONLY when isActive === true.
 *
 * DOM structure and word spans are kept strictly stable between active and inactive states
 * to prevent layout shifts and keep focal scrolling calculations rock-solid.
 */
export const WordTimedLine: React.FC<WordTimedLineProps> = React.memo(
  ({ words, isActive, isPast, lineTime, onWordClick, onLineClick }) => {
    const containerRef = useRef<HTMLSpanElement | null>(null);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const wordElements = Array.from(
        container.querySelectorAll<HTMLElement>('[data-word-idx]')
      );

      // 1. Inactive line: do NOT launch RAF. Apply static state and exit.
      if (!isActive) {
        for (let idx = 0; idx < wordElements.length; idx++) {
          const el = wordElements[idx];
          const w = words[idx];
          if (!w || !el) continue;

          el.setAttribute('data-alignment', w.alignment);
          if (!canAnimateWord(w)) {
            el.style.setProperty('--word-progress', '0%');
            el.setAttribute('data-state', 'unresolved');
          } else if (isPast) {
            el.style.setProperty('--word-progress', '100%');
            el.setAttribute('data-state', 'past');
          } else {
            el.style.setProperty('--word-progress', '0%');
            el.setAttribute('data-state', 'future');
          }
        }
        return;
      }

      // 2. Active line: check prefers-reduced-motion via dynamic listener
      const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
      let isReduced = mql.matches;
      let animId: number | null = null;

      const applyFrame = () => {
        const state = usePlayerStore.getState();
        const currentTime = state.currentTime;

        for (let idx = 0; idx < wordElements.length; idx++) {
          const el = wordElements[idx];
          const w = words[idx];
          if (!w || !el) continue;

          el.setAttribute('data-alignment', w.alignment);

          if (!canAnimateWord(w)) {
            el.style.setProperty('--word-progress', '0%');
            el.setAttribute('data-state', 'unresolved');
            continue;
          }

          if (isReduced) {
            // Discrete state without continuous gradient wipe
            if (currentTime < w.startTime) {
              el.style.setProperty('--word-progress', '0%');
              el.setAttribute('data-state', 'future');
            } else {
              el.style.setProperty('--word-progress', '100%');
              el.setAttribute('data-state', currentTime >= w.endTime ? 'past' : 'active');
            }
          } else {
            // Continuous gradient wipe
            if (currentTime < w.startTime) {
              el.style.setProperty('--word-progress', '0%');
              el.setAttribute('data-state', 'future');
            } else if (currentTime >= w.endTime) {
              el.style.setProperty('--word-progress', '100%');
              el.setAttribute('data-state', 'past');
            } else {
              const dur = Math.max(0.06, w.endTime - w.startTime);
              const ratio = Math.min(1, Math.max(0, (currentTime - w.startTime) / dur));
              el.style.setProperty('--word-progress', `${(ratio * 100).toFixed(1)}%`);
              el.setAttribute('data-state', 'active');
            }
          }
        }
      };

      const updateFrame = () => {
        applyFrame();
        if (usePlayerStore.getState().status === 'playing' && !isReduced) {
          animId = requestAnimationFrame(updateFrame);
        }
      };

      // Draw initial frame
      applyFrame();

      if (usePlayerStore.getState().status === 'playing' && !isReduced) {
        animId = requestAnimationFrame(updateFrame);
      }

      // Dynamic motion listener
      const handleMotionChange = (e: MediaQueryListEvent) => {
        isReduced = e.matches;
        if (isReduced && animId) {
          cancelAnimationFrame(animId);
          animId = null;
        } else if (!isReduced && usePlayerStore.getState().status === 'playing' && !animId) {
          animId = requestAnimationFrame(updateFrame);
        }
        applyFrame();
      };
      mql.addEventListener('change', handleMotionChange);

      // Narrow Zustand subscription only on status transition and paused scrubs or reduced motion
      const unsub = usePlayerStore.subscribe((state, prevState) => {
        if (state.status !== prevState.status) {
          if (state.status === 'playing' && !isReduced) {
            if (!animId) animId = requestAnimationFrame(updateFrame);
          } else if (state.status !== 'playing') {
            if (animId) {
              cancelAnimationFrame(animId);
              animId = null;
            }
            applyFrame();
          }
        } else if (
          state.currentTime !== prevState.currentTime &&
          (isReduced || state.status !== 'playing')
        ) {
          applyFrame();
        }
      });

      return () => {
        unsub();
        mql.removeEventListener('change', handleMotionChange);
        if (animId) {
          cancelAnimationFrame(animId);
          animId = null;
        }
      };
    }, [words, isActive, isPast]);

    return (
      <span ref={containerRef} className={styles.wordLineContainer}>
        {words.map((word, wordIdx) => {
          const seekable = canSeekToWord(word);
          const title =
            seekable && typeof word.startTime === 'number'
              ? `Перейти к "${word.text}" (${word.startTime.toFixed(2)}с)`
              : `Перейти к строке (${Math.floor(lineTime)}с)`;

          return (
            <React.Fragment key={`w-${wordIdx}-${word.startTime ?? wordIdx}`}>
              {word.prefix ? <span className={styles.punctSpan}>{word.prefix}</span> : null}
              <span
                data-word-idx={wordIdx}
                data-alignment={word.alignment}
                className={styles.karaokeWord}
                onClick={(e) => {
                  e.stopPropagation();
                  if (seekable && typeof word.startTime === 'number') {
                    onWordClick(word.startTime);
                  } else {
                    onLineClick(lineTime);
                  }
                }}
                title={title}
              >
                {word.text}
              </span>
              {word.suffix ? <span className={styles.punctSpan}>{word.suffix}</span> : null}
            </React.Fragment>
          );
        })}
      </span>
    );
  }
);
