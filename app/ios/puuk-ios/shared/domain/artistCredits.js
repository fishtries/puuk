// Server arrays are authoritative, including an explicitly empty array.
export function normalizeCredits(value, legacyId, legacyName) {
  if (Array.isArray(value)) return value.map((credit) => ({ ...credit }));
  if (typeof legacyId === 'string' && legacyId.trim() && typeof legacyName === 'string' && legacyName.trim()) {
    return [{ id: legacyId, name: legacyName }];
  }
  return [];
}

export function normalizeAlbum(album) {
  if (!album || typeof album !== 'object') return null;
  return {
    ...album,
    artists: normalizeCredits(album.artists, album.artist_id, album.album_artist || album.artist),
    artists_revision: Number.isInteger(album.artists_revision) && album.artists_revision >= 0 ? album.artists_revision : 0,
  };
}

export function getSelectableArtists(entity) {
  return Array.isArray(entity?.artists) ? entity.artists.filter((item) => item && typeof item.id === 'string' && item.id.trim() && typeof item.name === 'string' && item.name.trim()) : [];
}
