import defaultAudioCache from '../../utils/audioCache';
import { clearOrdinaryAudioCache } from '../availability';
import { getOfflineSession, isOfflineSessionCurrent, notifyOfflineIndex } from '../session';

jest.mock('../../utils/audioCache', () => ({ clear: jest.fn() }));
jest.mock('../session', () => ({
  getOfflineSession: jest.fn(),
  isOfflineSessionCurrent: jest.fn(),
  notifyOfflineIndex: jest.fn(),
}));
jest.mock('../wave', () => ({}));

const session = { activationId: 'login' };

beforeEach(() => {
  jest.resetAllMocks();
  getOfflineSession.mockReturnValue(session);
  isOfflineSessionCurrent.mockImplementation(value => value === session);
});

test.each([0, 1])('notifies the scheduler of reclaimed space with %i failed files', async failedFiles => {
  const result = { freedBytes: 5000, failedFiles };
  defaultAudioCache.clear.mockResolvedValueOnce(result);

  await expect(clearOrdinaryAudioCache()).resolves.toEqual(result);
  expect(notifyOfflineIndex).toHaveBeenCalledTimes(1);
  expect(notifyOfflineIndex).toHaveBeenCalledWith({ type: 'cache-cleared', session });
});

test.each([0, 1])('does not notify the scheduler without reclaimed space with %i failed files', async failedFiles => {
  const result = { freedBytes: 0, failedFiles };
  defaultAudioCache.clear.mockResolvedValueOnce(result);

  await expect(clearOrdinaryAudioCache()).resolves.toEqual(result);
  expect(notifyOfflineIndex).not.toHaveBeenCalled();
});

test('checks the captured session after the cache finishes clearing', async () => {
  const result = { freedBytes: 5000, failedFiles: 1 };
  defaultAudioCache.clear.mockImplementationOnce(async () => {
    getOfflineSession.mockReturnValue({ activationId: 'other-login' });
    isOfflineSessionCurrent.mockReturnValue(false);
    return result;
  });

  await expect(clearOrdinaryAudioCache()).resolves.toEqual(result);
  expect(isOfflineSessionCurrent).toHaveBeenCalledWith(session);
  expect(notifyOfflineIndex).not.toHaveBeenCalled();
});

test('propagates an unexpected clear failure to the caller', async () => {
  const error = new Error('could not read the cache directory');
  defaultAudioCache.clear.mockRejectedValueOnce(error);

  await expect(clearOrdinaryAudioCache()).rejects.toBe(error);
  expect(notifyOfflineIndex).not.toHaveBeenCalled();
});
