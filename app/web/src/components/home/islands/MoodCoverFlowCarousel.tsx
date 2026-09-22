import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronLeft, ChevronRight, Music2 } from 'lucide-react';
import type { MoodItem } from '../../../types/recommendations';
import styles from './MoodCoverFlowCarousel.module.css';

interface MoodCoverFlowCarouselProps {
  moods: MoodItem[];
  onOpenPlaylist: (mood: MoodItem) => void;
}

/** Отдельный компонент обложки с гарантированным fallback при ошибке загрузки изображения */
const CoverArtwork: React.FC<{ mood: MoodItem; isCenter: boolean }> = ({ mood, isCenter }) => {
  const [hasError, setHasError] = useState(false);

  // Сброс ошибки при смене URL
  useEffect(() => {
    setHasError(false);
  }, [mood.coverUrl]);

  if (!mood.coverUrl || hasError) {
    return (
      <div className={styles.coverGradientFallback} style={{ background: mood.gradient }}>
        <div className={styles.fallbackIconBadge}>
          <Music2 size={isCenter ? 22 : 18} />
        </div>
        <span className={styles.fallbackMoodTitle}>{mood.title}</span>
        <span className={styles.fallbackTracksCount}>
          {mood.tracks.length > 0 ? `${mood.tracks.length} треков` : 'AI Mix'}
        </span>
      </div>
    );
  }

  return (
    <img
      src={mood.coverUrl}
      alt={mood.title}
      className={styles.coverImg}
      loading="lazy"
      draggable={false}
      onError={() => setHasError(true)}
    />
  );
};

export const MoodCoverFlowCarousel: React.FC<MoodCoverFlowCarouselProps> = ({
  moods,
  onOpenPlaylist,
}) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Normalize index within bounds
  useEffect(() => {
    if (activeIndex >= moods.length && moods.length > 0) {
      setActiveIndex(moods.length - 1);
    }
  }, [moods.length, activeIndex]);

  const activeMood = moods[activeIndex];

  const handlePrev = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      setActiveIndex((prev) => Math.max(0, prev - 1));
    },
    []
  );

  const handleNext = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      setActiveIndex((prev) => Math.min(moods.length - 1, prev + 1));
    },
    [moods.length]
  );

  // Keyboard navigation when focused or hovering
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handlePrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleNext();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (activeMood) onOpenPlaylist(activeMood);
      }
    },
    [handlePrev, handleNext, activeMood, onOpenPlaylist]
  );

  const handleItemClick = (index: number, mood: MoodItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (index === activeIndex) {
      // Клик по центральному плейлисту — открывает страницу с плейлистом
      onOpenPlaylist(mood);
    } else {
      // Клик по любому другому плейлисту — перемещает его в центр
      setActiveIndex(index);
    }
  };

  return (
    <div
      ref={containerRef}
      className={styles.carouselRoot}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      role="region"
      aria-label="AI Mood Playlists Carousel"
    >
      {/* Top Controls Bar */}
      <div className={styles.topBar}>
        <div className={styles.navControls}>
          <button
            type="button"
            className={styles.navBtn}
            onClick={handlePrev}
            disabled={activeIndex === 0}
            aria-label="Предыдущий плейлист"
            title="Предыдущий плейлист"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            className={styles.navBtn}
            onClick={handleNext}
            disabled={activeIndex === moods.length - 1}
            aria-label="Следующий плейлист"
            title="Следующий плейлист"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* 3D Cover Flow Stage */}
      <div className={styles.stage}>
        {moods.map((mood, idx) => {
          const offset = idx - activeIndex;
          const isCenter = offset === 0;
          const distance = Math.abs(offset);

          let transform = '';
          let zIndex = 20 - distance;
          let opacity = 1;
          let filter = 'brightness(1)';

          if (isCenter) {
            transform = 'translateX(0px) translateZ(50px) rotateY(0deg) scale(1.1)';
            zIndex = 30;
            opacity = 1;
            filter = 'brightness(1)';
          } else if (offset < 0) {
            // Левая сторона: повернута вправо с наложением
            const x = offset * 86 - 55;
            const z = distance * -45;
            transform = `translateX(${x}px) translateZ(${z}px) rotateY(54deg) scale(0.92)`;
            opacity = Math.max(0.38, 1 - distance * 0.2);
            filter = `brightness(${Math.max(0.6, 1 - distance * 0.14)})`;
          } else {
            // Правая сторона: повернута влево с наложением
            const x = offset * 86 + 55;
            const z = distance * -45;
            transform = `translateX(${x}px) translateZ(${z}px) rotateY(-54deg) scale(0.92)`;
            opacity = Math.max(0.38, 1 - distance * 0.2);
            filter = `brightness(${Math.max(0.6, 1 - distance * 0.14)})`;
          }

          return (
            <div
              key={mood.id}
              className={`${styles.coverItem} ${isCenter ? styles.centerItem : ''}`}
              style={{
                transform,
                zIndex,
                opacity,
                filter,
              }}
              onClick={(e) => handleItemClick(idx, mood, e)}
              title={isCenter ? `Открыть «${mood.title}»` : `Выбрать «${mood.title}»`}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleItemClick(idx, mood, e as any);
              }}
            >
              <div
                className={styles.coverInner}
                style={{
                  boxShadow: isCenter
                    ? `0 16px 36px rgba(0, 0, 0, 0.7), 0 0 22px ${mood.color}44, inset 0 1px 1px rgba(255, 255, 255, 0.4)`
                    : undefined,
                }}
              >
                <CoverArtwork mood={mood} isCenter={isCenter} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Bottom Bar: Centered "you'll like this" Plaque */}
      <div className={styles.bottomBar}>
        <span className={styles.centeredPlaque}>you'll like this</span>
      </div>
    </div>
  );
};
