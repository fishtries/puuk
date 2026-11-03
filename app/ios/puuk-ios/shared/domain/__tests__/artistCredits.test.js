import { normalizeTrack } from '../trackAdapter';
import { normalizeAlbum, getSelectableArtists } from '../artistCredits';

it('preserves ordered server credits and authoritative empties', () => {
  const artists = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  const track = normalizeTrack({ id: 't', artist: 'A/B', artist_id: 'old', artists, artists_revision: 3, album_artists: [], album_artists_revision: 1 });
  expect(track.artists).toEqual(artists);
  expect(track.album_artists).toEqual([]);
  expect(track.artists_revision).toBe(3);
  expect(normalizeAlbum({ artists: [], artist_id: 'old', album_artist: 'A/B' }).artists).toEqual([]);
  expect(getSelectableArtists(track)).toEqual(artists);
});
it('uses a whole legacy name only with its ID', () => {
  expect(normalizeTrack({ id: 't', artist: 'A/B', artist_id: 'a' }).artists).toEqual([{ id: 'a', name: 'A/B' }]);
  expect(normalizeTrack({ id: 't', artist: 'A/B' }).artists).toEqual([]);
  expect(normalizeAlbum({ artist_id: 'a', album_artist: 'A, B' }).artists).toEqual([{ id: 'a', name: 'A, B' }]);
});
