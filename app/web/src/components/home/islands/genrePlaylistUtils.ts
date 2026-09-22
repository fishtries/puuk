import type { Track } from '../../../types/track';
import type { PersonalizedPlaylistSection } from '../../../types/recommendations';

export interface GenrePlaylistCard {
  id: string;
  title: string;
  section: PersonalizedPlaylistSection;
}

/**
 * Русская плюрализация счётчика треков: 1 трек, 2–4 трека, 5–20 треков.
 */
export function pluralTracksCount(n: number): string {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;

  let word: string;
  if (mod10 === 1 && mod100 !== 11) {
    word = 'трек';
  } else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    word = 'трека';
  } else {
    word = 'треков';
  }

  return `${n} ${word}`;
}

/**
 * Маппер секций в карточки карусели. Ссылка на секцию сохраняется как есть —
 * открытие карточки возвращает ровно тот же массив треков (identity, без срезки).
 */
export function toCarouselItems(sections: PersonalizedPlaylistSection[]): GenrePlaylistCard[] {
  return sections.map((section) => ({
    id: section.id,
    title: section.title,
    section,
  }));
}

/**
 * Обложка секции по первому треку. Пустая секция или трек без обложки → undefined
 * (карточка рисует нейтральный fallback).
 */
export function resolveSectionCover(
  section: PersonalizedPlaylistSection,
  getCoverUrl: (track: Track) => string
): string | undefined {
  if (section.tracks.length === 0) return undefined;
  return getCoverUrl(section.tracks[0]) || undefined;
}
