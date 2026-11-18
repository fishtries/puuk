import { probeReadyVersions } from '../versionProbe';
import { authFetch } from '../../../shared/api/api';
import {
  captureDesiredVersion,
  confirmDesiredVersion,
  readMediaKey,
} from '../..';
import { reconcileRetention } from '..';

jest.mock('../../../shared/api/api', () => ({ authFetch: jest.fn() }));
jest.mock('../..', () => ({
  isOfflineSessionCurrent: jest.fn(() => true),
  readMediaKey: jest.fn(async () => ({ contentVersion: 'a'.repeat(64) })),
  captureDesiredVersion: jest.fn(async () => ({
    version: 'a'.repeat(64),
    revision: 1,
  })),
  confirmDesiredVersion: jest.fn(async () => true),
}));
jest.mock('..', () => ({ reconcileRetention: jest.fn(async () => {}) }));
const session = { activationId: 'probe', generation: 1 };
const tick = () => new Promise((resolve) => setImmediate(resolve));
beforeEach(() => jest.clearAllMocks());
test('deduplicates ready files, validates new version and requests requeue', async () => {
  authFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ content_version: 'b'.repeat(64) }),
  });
  probeReadyVersions(session, [{ id: '1' }, { id: '1' }]);
  await tick();
  await tick();
  expect(authFetch).toHaveBeenCalledTimes(1);
  expect(confirmDesiredVersion).toHaveBeenCalledWith(
    session,
    '1',
    { version: 'a'.repeat(64), revision: 1 },
    'b'.repeat(64),
  );
  expect(reconcileRetention).toHaveBeenCalledWith(session);
});
test('network failure leaves readiness alone', async () => {
  authFetch.mockRejectedValueOnce(Error('timeout'));
  probeReadyVersions(session, [{ id: '2' }]);
  await tick();
  await tick();
  expect(readMediaKey).toHaveBeenCalled();
  expect(captureDesiredVersion).toHaveBeenCalled();
  expect(confirmDesiredVersion).not.toHaveBeenCalled();
});
