import { DeviceEventEmitter } from 'react-native';
import { authFetch } from '../api';
import { invalidateArtistCreditsCache } from '../apiCache';
import { setTrackArtists, applyArtistReplacement } from '../artistCredits';

jest.mock('../api', () => ({
  authFetch: jest.fn(),
  ApiError: class ApiError extends Error { constructor(message, fields) { super(message); Object.assign(this, fields); } },
  classifyError: () => 'client',
  parseApiErrorMessage: (data) => data.detail?.message || 'error',
}));
jest.mock('../apiCache', () => ({ invalidateArtistCreditsCache: jest.fn() }));
const response = (status, data) => ({ ok: status === 200, status, json: async () => data });
beforeEach(() => { jest.clearAllMocks(); });
it('propagates a conflict without success events or retries', async () => {
  const emit = jest.spyOn(DeviceEventEmitter, 'emit');
  authFetch.mockResolvedValue(response(409, { detail: { code: 'artists_revision_conflict', message: 'stale', current_revision: 4, artists: [] } }));
  await expect(setTrackArtists('t', [], 3)).rejects.toMatchObject({ code: 'artists_revision_conflict', current_revision: 4, message: 'stale', artists: [] });
  expect(authFetch).toHaveBeenCalledTimes(1);
  expect(invalidateArtistCreditsCache).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
  emit.mockRestore();
});
it('retries 503 once with the same operation and emits server result', async () => {
  const emit = jest.spyOn(DeviceEventEmitter, 'emit');
  const data = { operation_id: 'op', affected: { track_ids: ['t'] }, catalog_version: 9 };
  authFetch.mockResolvedValueOnce(response(503, {})).mockResolvedValueOnce(response(200, data));
  await expect(applyArtistReplacement('a', 'op')).resolves.toEqual(data);
  expect(authFetch).toHaveBeenCalledTimes(2);
  expect(authFetch.mock.calls[0]).toEqual(authFetch.mock.calls[1]);
  expect(emit).toHaveBeenCalledWith('PUUK_ARTIST_CREDITS_UPDATED', { scope: 'bulk', operationId: 'op', affected: data.affected, catalogVersion: 9 });
  emit.mockRestore();
});
it('rejects malformed selectors before sending', async () => {
  await expect(setTrackArtists('t', [{ id: 'a', name: 'A' }], 1)).rejects.toMatchObject({ status: 422 });
  expect(authFetch).not.toHaveBeenCalled();
});
