import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Music2 } from 'lucide-react';
import type { PersonalizedPlaylistSection } from '../../../types/recommendations';
import { getCoverUrl } from '../../../api/tracks';
import { AuthorizedImage } from '../../common/AuthorizedImage';
import { pluralTracksCount, resolveSectionCover, toCarouselItems } from './genrePlaylistUtils';
import styles from './GenrePlaylistCarousel.module.css';

interface GenrePlaylistCarouselProps {
  sections: PersonalizedPlaylistSection[];
  onOpenPlaylist: (section: PersonalizedPlaylistSection) => void;
}

/** Обложка карточки с нейтральным fallback при отсутствии/ошибке загрузки изображения. */
const CoverArtwork: React.FC<{
  section: PersonalizedPlaylistSection;
  coverUrl?: string;
  isCenter: boolean;
}> = ({ section, coverUrl, isCenter }) => {
  const [hasError, setHasError] = useState(false);

  // Сброс ошибки при смене URL
  useEffect(() => {
    setHasError(false);
  }, [coverUrl]);

  if (!coverUrl || hasError) {
    return (
      <div className={styles.coverFallback}>
        <div className={styles.fallbackIconBadge}>
          <Music2 size={isCenter ? 22 : 18} />
        </div>
        <span className={styles.fallbackGenreTitle}>{section.genre}</span>
        <span className={styles.fallbackTracksCount}>
          {pluralTracksCount(section.tracks.length)}
        </span>
      </div>
    );
  }

  return (
    <>
      <AuthorizedImage
        src={coverUrl}
        alt={section.title}
        className={styles.coverImg}
        loading="lazy"
        draggable={false}
        onError={() => setHasError(true)}
      />
      <span className={styles.coverTracksBadge}>
        {pluralTracksCount(section.tracks.length)}
      </span>
    </>
  );
};

export const GenrePlaylistCarousel: React.FC<GenrePlaylistCarouselProps> = ({
  sections,
  onOpenPlaylist,
}) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const items = useMemo(() => toCarouselItems(sections), [sections]);

  // Normalize index within bounds
  useEffect(() => {
    if (activeIndex >= items.length && items.length > 0) {
      setActiveIndex(items.length - 1);
    }
  }, [items.length, activeIndex]);

  const activeItem = items[activeIndex];

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
      setActiveIndex((prev) => Math.min(items.length - 1, prev + 1));
    },
    [items.length]
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
        if (activeItem) onOpenPlaylist(activeItem.section);
      }
    },
    [handlePrev, handleNext, activeItem, onOpenPlaylist]
  );

  const handleItemClick = (index: number, section: PersonalizedPlaylistSection, e: React.MouseEvent) => {
    e.stopPropagation();
    if (index === activeIndex) {
      // Клик по центральной подборке — открывает её страницу
      onOpenPlaylist(section);
    } else {
      // Клик по любой другой подборке — перемещает её в центр
      setActiveIndex(index);
    }
  };

  return (
    <div
      className={styles.carouselRoot}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      role="region"
      aria-label="Personalized Genre Playlists Carousel"
    >
      {/* Top Controls Bar */}
      <div className={styles.topBar}>
        <div className={styles.navControls}>
          <button
            type="button"
            className={styles.navBtn}
            onClick={handlePrev}
            disabled={activeIndex === 0}
            aria-label="Предыдущая подборка"
            title="Предыдущая подборка"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            className={styles.navBtn}
            onClick={handleNext}
            disabled={activeIndex === items.length - 1}
            aria-label="Следующая подборка"
            title="Следующая подборка"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* 3D Cover Flow Stage */}
      <div className={styles.stage}>
        {items.map((item, idx) => {
          const offset = idx - activeIndex;
          const isCenter = offset === 0;
          const distance = Math.abs(offset);
          const coverUrl = resolveSectionCover(item.section, getCoverUrl);

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
              key={item.id}
              className={`${styles.coverItem} ${isCenter ? styles.centerItem : ''}`}
              style={{
                transform,
                zIndex,
                opacity,
                filter,
              }}
              onClick={(e) => handleItemClick(idx, item.section, e)}
              title={isCenter ? `Открыть «${item.title}»` : `Выбрать «${item.title}»`}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleItemClick(idx, item.section, e as any);
              }}
            >
              <div
                className={styles.coverInner}
                style={{
                  boxShadow: isCenter
                    ? '0 16px 36px rgba(0, 0, 0, 0.7), inset 0 1px 1px rgba(255, 255, 255, 0.4)'
                    : undefined,
                }}
              >
                <CoverArtwork section={item.section} coverUrl={coverUrl} isCenter={isCenter} />
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
