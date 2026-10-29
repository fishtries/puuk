import { DeviceEventEmitter } from 'react-native';
import { authFetch, ApiError, classifyError, parseApiErrorMessage } from './api';
import { invalidateArtistCreditsCache } from './apiCache';
import { emitArtistCreditsUpdated } from '../domain/artistCreditEvents';

function validId(id) {
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()) throw new ApiError('ID is required', { type: 'client', status: 400 });
  return encodeURIComponent(String(id).trim());
}
function validateArtists(artists) {
  if (!Array.isArray(artists) || artists.length > 100 || artists.some((item) => !item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 1 || !['id', 'name'].includes(Object.keys(item)[0]) || typeof Object.values(item)[0] !== 'string' || !Object.values(item)[0].trim())) {
    throw new ApiError('Invalid artists', { type: 'client', status: 422, code: 'invalid_artists' });
  }
}
async function request(endpoint, method, body, options) {
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await authFetch(endpoint, { ...options, method, body, retry: 0, retries: 0 });
      if (response.status === 503 && attempt === 0) continue;
      break;
    } catch (error) {
      if (attempt === 0 && error?.isNetwork && !options.signal?.aborted) continue;
      throw error;
    }
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.detail;
    const error = new ApiError(parseApiErrorMessage(data, 'Failed to update artist credits'), { status: response.status, type: classifyError(null, response.status), code: detail?.code, endpoint });
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) Object.assign(error, detail);
    throw error;
  }
  return data;
}
async function changed(payload) {
  await invalidateArtistCreditsCache();
  emitArtistCreditsUpdated(payload);
}
export async function setTrackArtists(id, artists, expectedRevision, options = {}) {
  validateArtists(artists);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new ApiError('Invalid revision', { type: 'client', status: 422 });
  const track = await request(`/api/tracks/${validId(id)}/artists`, 'PUT', { artists, expected_revision: expectedRevision }, options);
  await changed({ scope: 'track', track, catalogVersion: null });
  DeviceEventEmitter.emit('PUUK_TRACK_UPDATED', track);
  return track;
}
export async function setAlbumArtists(id, artists, expectedRevision, options = {}) {
  validateArtists(artists);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new ApiError('Invalid revision', { type: 'client', status: 422 });
  const result = await request(`/api/albums/${validId(id)}/artists`, 'PUT', { artists, expected_revision: expectedRevision }, options);
  await changed({ scope: 'album', album: result.album, tracks: result.tracks, catalogVersion: null });
  DeviceEventEmitter.emit('PUUK_ALBUM_UPDATED', { previousAlbumId: id, album: result.album });
  return result;
}
export async function previewArtistReplacement(id, scope, artists, options = {}) {
  validateArtists(artists);
  if (!['tracks', 'albums'].includes(scope)) throw new ApiError('Invalid scope', { type: 'client', status: 422 });
  return request(`/api/artists/${validId(id)}/credits/preview`, 'POST', { scope, artists }, options);
}
async function bulk(id, operationId, action, options) {
  validId(operationId);
  const result = await request(`/api/artists/${validId(id)}/credits/${action}`, 'POST', { operation_id: operationId }, options);
  await changed({ scope: 'bulk', operationId: result.operation_id, affected: result.affected, catalogVersion: result.catalog_version });
  return result;
}
export const applyArtistReplacement = (id, operationId, options = {}) => bulk(id, operationId, 'apply', options);
export const undoArtistReplacement = (id, operationId, options = {}) => bulk(id, operationId, 'undo', options);
