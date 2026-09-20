import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import { LyricsLine } from '../../types/track';
import { getProgressiveValues, SCROLL_CLARITY, getWaveSpring } from './lyricsDepth';
import { WordTimedLine } from './WordTimedLine';
import styles from './AppleLyricsStream.module.css';

interface LyricLineRowProps {
  line: LyricsLine;
  index: number;
  activeIndex: number;
  targetY: number;
  isActive: boolean;
  isInitial: boolean;
  isManualScrolling: boolean;
  onLineClick: (time: number) => void;
}

/**
 * LyricLineRow: Individual lyric line with staggered traffic-jam spring wave propagation.
 * Lines follow one after another like cars in a traffic jam ("как машины в пробке").
 *
 * When manual scrolling occurs (isManualScrolling = true), wave delay is disabled (0ms)
 * and all lines scroll synchronously as a single solid unit with zero rubber-banding.
 */
export const LyricLineRow: React.FC<LyricLineRowProps> = React.memo(
  ({ line, index, activeIndex, targetY, isActive, isInitial, isManualScrolling, onLineClick }) => {
    // While the user scrolls by hand the whole field returns to full clarity —
    // no dimming, no text blur — so they can read ahead freely. The active line
    // keeps its slight lift so the current position stays legible.
    const progressive = isManualScrolling
      ? isActive
        ? { ...SCROLL_CLARITY, scale: 1.03 }
        : SCROLL_CLARITY
      : getProgressiveValues(index, activeIndex);

    // Staggered wave delay: "как машины в пробке"
    const spring = getWaveSpring(index, activeIndex, isInitial, isManualScrolling);
    const waveDelay = spring.delay;
    const springStiffness = spring.stiffness;
    const springDamping = spring.damping;
    const springMass = spring.mass;

    const animateProps = useMemo(
      () => ({
        y: targetY,
        scale: progressive.scale,
        opacity: progressive.opacity,
        // Always express the focus as a numeric blur so Framer can interpolate
        // the depth-of-field pull smoothly in both directions (`none` would snap).
        filter: `blur(${progressive.blur}px)`,
      }),
      [targetY, progressive.scale, progressive.opacity, progressive.blur]
    );

    const transitionProps = useMemo(
      () => ({
        y: isInitial
          ? { duration: 0 }
          : isManualScrolling
          ? {
              type: 'spring' as const,
              stiffness: 260,
              damping: 28,
              mass: 0.55,
              delay: 0,
            }
          : {
              type: 'spring' as const,
              stiffness: springStiffness,
              damping: springDamping,
              mass: springMass,
              delay: waveDelay,
            },
        scale: {
          duration: 0.45,
          ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
          delay: isManualScrolling ? 0 : waveDelay * 0.6,
        },
        opacity: {
          duration: 0.45,
          ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
          delay: isManualScrolling ? 0 : waveDelay * 0.6,
        },
        filter: {
          duration: isActive ? 0.2 : 0.35,
          ease: 'easeOut' as const,
          delay: isActive || isManualScrolling ? 0 : waveDelay * 0.4,
        },
      }),
      [isInitial, isManualScrolling, springStiffness, springDamping, springMass, waveDelay, isActive]
    );

    const handleClick = React.useCallback(() => {
      onLineClick(line.time);
    }, [onLineClick, line.time]);

    const isWordMode = line.displayMode === 'word' && Boolean(line.words && line.words.length > 0);

    return (
      <motion.p
        className={`${styles.lyricLine} ${isActive ? styles.activeLine : styles.inactiveLine}`}
        onClick={handleClick}
        title={`Перейти на ${Math.floor(line.time)}с`}
        animate={animateProps}
        whileHover={
          !isActive && !isManualScrolling
            ? {
                scale: 1.015,
                opacity: 0.95,
                filter: 'blur(0px)',
                transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
              }
            : undefined
        }
        transition={transitionProps}
      >
        {isWordMode ? (
          <WordTimedLine
            words={line.words!}
            isActive={isActive}
            isPast={index < activeIndex}
            lineTime={line.time}
            onWordClick={onLineClick}
            onLineClick={onLineClick}
          />
        ) : (
          <span className={styles.lineLevelText}>{line.text}</span>
        )}
      </motion.p>
    );
  }
);
