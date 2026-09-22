import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pluralTracksCount,
  resolveSectionCover,
  toCarouselItems,
} from '../genrePlaylistUtils.ts';
import type { Track } from '../../../../types/track.ts';
import type { PersonalizedPlaylistSection } from '../../../../types/recommendations.ts';

const track = (id: string, coverArt?: string): Track => ({
  id,
  title: `Title ${id}`,
  artist: `Artist ${id}`,
  duration: 180,
  coverArt,
});

const section = (id: string, trackCount: number): PersonalizedPlaylistSection => ({
  id: `genre-${id}`,
  type: 'genre',
  title: `${id} for you`,
  description: `Персональная подборка из жанра ${id}`,
  genre: id,
  tracks: Array.from({ length: trackCount }, (_, i) => track(`${id}-${i}`)),
});

const stubGetCoverUrl = (t: Track): string => (t.coverArt ? `/api/cover/${t.coverArt}` : '');

describe('toCarouselItems', () => {
  it('0 секций → пустой массив карточек', () => {
    assert.deepEqual(toCarouselItems([]), []);
  });

  it('1–3 секции → карточки с title = section.title и стабильным id', () => {
    const sections = [section('electronic', 5), section('jazz', 8), section('rock', 3)];
    const cards = toCarouselItems(sections);

    assert.equal(cards.length, 3);
    cards.forEach((card, i) => {
      assert.equal(card.id, sections[i].id);
      assert.equal(card.title, sections[i].title);
      assert.equal(card.section, sections[i]);
    });
  });

  it('открытие секции возвращает ровно те же 20 треков (identity, без пересоздания/срезки)', () => {
    const s = section('electronic', 20);
    const cards = toCarouselItems([s]);

    assert.equal(cards.length, 1);
    assert.equal(cards[0].section.tracks, s.tracks);
    assert.equal(cards[0].section.tracks.length, 20);
  });
});

describe('pluralTracksCount', () => {
  it('1 → 1 трек', () => {
    assert.equal(pluralTracksCount(1), '1 трек');
  });

  it('3 → 3 трека', () => {
    assert.equal(pluralTracksCount(3), '3 трека');
  });

  it('20 → 20 треков', () => {
    assert.equal(pluralTracksCount(20), '20 треков');
  });

  it('граничные формы русской плюрализации', () => {
    assert.equal(pluralTracksCount(2), '2 трека');
    assert.equal(pluralTracksCount(5), '5 треков');
    assert.equal(pluralTracksCount(11), '11 треков');
    assert.equal(pluralTracksCount(21), '21 трек');
    assert.equal(pluralTracksCount(22), '22 трека');
  });
});

describe('resolveSectionCover', () => {
  it('без треков → undefined', () => {
    assert.equal(resolveSectionCover(section('electronic', 0), stubGetCoverUrl), undefined);
  });

  it('без coverArt у первого трека → undefined', () => {
    assert.equal(resolveSectionCover(section('electronic', 2), stubGetCoverUrl), undefined);
  });

  it('с coverArt → url первого трека', () => {
    const s = section('electronic', 2);
    s.tracks[0] = track('electronic-0', 'abc');
    assert.equal(resolveSectionCover(s, stubGetCoverUrl), '/api/cover/abc');
  });
});
