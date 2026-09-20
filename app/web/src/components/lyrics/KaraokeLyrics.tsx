import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Music, RefreshCw, RotateCcw, Sparkles } from 'lucide-react';
import { useLyrics } from '../../hooks/useLyrics';
import { usePlayerStore } from '../../store/usePlayerStore';
import { LyricsLine, LyricsWord } from '../../types/track';
import {
  triggerWordLyricsGeneration,
  fetchLyricsGenerationStatus,
} from '../../api/tracks';
import styles from './KaraokeLyrics.module.css';

import { canAnimateWord, canSeekToWord } from '../../engine/lyricsMapper';

interface KaraokeLineRowProps {
  line: LyricsLine;
  index: number;
  isActive: boolean;
  isPassed: boolean;
  activeLineRef: React.RefObject<HTMLParagraphElement | null> | null;
  onSeek: (time: number) => void;
}

interface SideWordTimedLineProps {
  words: LyricsWord[];
  isActive: boolean;
  isPast: boolean;
  lineTime: number;
  onSeek: (time: number) => void;
}

const SideWordTimedLine: React.FC<SideWordTimedLineProps> = React.memo(
  ({ words, isActive, isPast, lineTime, onSeek }) => {
    const containerRef = useRef<HTMLSpanElement | null>(null);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const wordElements = Array.from(
        container.querySelectorAll<HTMLElement>('[data-side-word-idx]')
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

      applyFrame();

      if (usePlayerStore.getState().status === 'playing' && !isReduced) {
        animId = requestAnimationFrame(updateFrame);
      }

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
      <span ref={containerRef}>
        {words.map((word, wIdx) => {
          const seekable = canSeekToWord(word);
          const title = seekable && typeof word.startTime === 'number'
            ? `Перейти к "${word.text}" (${word.startTime.toFixed(2)}с)`
            : `Перейти к строке (${Math.floor(lineTime)}с)`;

          return (
            <React.Fragment key={`side-w-${wIdx}-${word.startTime ?? wIdx}`}>
              {word.prefix ? <span className={styles.punctSpan}>{word.prefix}</span> : null}
              <span
                data-side-word-idx={wIdx}
                data-alignment={word.alignment}
                className={styles.karaokeWord}
                onClick={(e) => {
                  e.stopPropagation();
                  if (seekable && typeof word.startTime === 'number') {
                    onSeek(word.startTime);
                  } else {
                    onSeek(lineTime);
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

const KaraokeLineRow: React.FC<KaraokeLineRowProps> = React.memo(
  ({ line, isActive, isPassed, activeLineRef, onSeek }) => {
    const isWordMode = line.displayMode === 'word' && Boolean(line.words && line.words.length > 0);

    return (
      <p
        ref={isActive && activeLineRef ? activeLineRef : null}
        className={`${styles.lyricLine} ${isActive ? styles.activeLine : ''} ${
          isPassed ? styles.passedLine : ''
        }`}
        onClick={() => onSeek(line.time)}
        title={`Перемотать на ${Math.floor(line.time)}с`}
      >
        {isWordMode ? (
          <SideWordTimedLine
            words={line.words!}
            isActive={isActive}
            isPast={isPassed}
            lineTime={line.time}
            onSeek={onSeek}
          />
        ) : (
          <span className={styles.lineLevelText}>{line.text}</span>
        )}
      </p>
    );
  }
);

export const KaraokeLyrics: React.FC = () => {
  const { lyrics, activeIndex, isLyricsLoading, seek } = useLyrics();
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const fetchLyrics = usePlayerStore((state) => state.fetchLyrics);
  const activeLineRef = useRef<HTMLParagraphElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [isGenerating, setIsGenerating] = useState(false);

  const hasWordLevel = useMemo(
    () => lyrics.some((l) => l.wordTimingAvailable && l.words && l.words.length > 0),
    [lyrics]
  );

  const handleGenerate = async (force = false, refetch = false) => {
    if (!currentTrack || isGenerating) return;
    setIsGenerating(true);
    try {
      await triggerWordLyricsGeneration(currentTrack.id, undefined, force, refetch);
      const poll = window.setInterval(async () => {
        try {
          const s = await fetchLyricsGenerationStatus(currentTrack.id);
          if (s.status === 'completed') {
            window.clearInterval(poll);
            setIsGenerating(false);
            fetchLyrics(currentTrack.id, true);
          } else if (s.status === 'failed') {
            window.clearInterval(poll);
            setIsGenerating(false);
          }
        } catch {
          // ignore transient poll error
        }
      }, 1500);
    } catch {
      setIsGenerating(false);
    }
  };

  const handleRefetch = () => {
    if (currentTrack) {
      fetchLyrics(currentTrack.id, true);
    }
  };

  useEffect(() => {
    if (activeLineRef.current && containerRef.current) {
      activeLineRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [activeIndex]);

  if (!currentTrack) {
    return (
      <div className={styles.emptyContainer}>
        <Music size={28} className={styles.emptyIcon} />
        <span className={styles.emptyTitle}>Текст песни не активен</span>
        <span className={styles.emptySubtitle}>Включите трек для отображения синхронизированных строк</span>
      </div>
    );
  }

  if (isLyricsLoading) {
    return (
      <div className={styles.loadingContainer}>
        <RefreshCw size={22} className={styles.spinner} />
        <span>Загрузка синхронизированного текста...</span>
      </div>
    );
  }

  if (lyrics.length === 0) {
    return (
      <div className={styles.emptyContainer}>
        <Music size={24} className={styles.emptyIcon} />
        <span className={styles.emptyTitle}>Текст песни не найден</span>
        <span className={styles.emptySubtitle}>Для этого трека пока нет разметки LRC</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <button
            type="button"
            className={styles.retryBtn}
            onClick={handleRefetch}
            title="Заново запросить текст из LRCLIB"
          >
            <RefreshCw size={12} style={{ marginRight: 6 }} />
            <span>Повторить поиск текста</span>
          </button>
          <button
            type="button"
            className={styles.generateBtn}
            onClick={() => handleGenerate(true, true)}
            disabled={isGenerating}
            title="Сгенерировать текст и разметку через Whisper на GPU"
          >
            {isGenerating ? (
              <>
                <RefreshCw size={13} className={styles.spinner} />
                <span>Распознавание на GPU...</span>
              </>
            ) : (
              <>
                <Sparkles size={13} />
                <span>✨ Сгенерировать караоке</span>
              </>
            )}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.lyricsContainer} ref={containerRef}>
      <div className={styles.karaokeToolbar} style={{ gap: 6, alignItems: 'center' }}>
        {hasWordLevel ? (
          <button
            type="button"
            className={styles.regenerateBtn}
            onClick={() => handleGenerate(true, false)}
            disabled={isGenerating}
            title="Пересоздать пословную караоке-разметку на GPU (RTX 4070)"
          >
            <RotateCcw size={12} className={isGenerating ? styles.spinner : undefined} />
            <span>{isGenerating ? 'Обработка GPU...' : 'Пересоздать караоке'}</span>
          </button>
        ) : (
          <button
            type="button"
            className={styles.generateBtn}
            onClick={() => handleGenerate(false, false)}
            disabled={isGenerating}
            title="Запустить Whisper AI для пословной караоке-разметки"
          >
            {isGenerating ? (
              <>
                <RefreshCw size={13} className={styles.spinner} />
                <span>Генерация разметки...</span>
              </>
            ) : (
              <>
                <Sparkles size={13} />
                <span>✨ Караоке-разметка</span>
              </>
            )}
          </button>
        )}
        <button
          type="button"
          className={styles.refreshBtn}
          onClick={handleRefetch}
          title="Заново обновить текст из LRCLIB"
        >
          <RefreshCw size={11} />
        </button>
      </div>
      <div className={styles.lyricsList}>
        {lyrics.map((line, index) => {
          const isActive = index === activeIndex;
          const isPassed = index < activeIndex;

          return (
            <KaraokeLineRow
              key={`${line.time}-${index}`}
              line={line}
              index={index}
              isActive={isActive}
              isPassed={isPassed}
              activeLineRef={activeLineRef}
              onSeek={seek}
            />
          );
        })}
      </div>
    </div>
  );
};
