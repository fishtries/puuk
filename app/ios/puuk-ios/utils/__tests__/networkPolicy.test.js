jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn(),
  addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
}));

import { getNetworkStateAsync } from 'expo-network';
import {
  NETWORK_POLICY,
  classifyNetworkPolicy,
  getCurrentNetworkPolicy,
  getNetworkPolicy,
  subscribeNetworkPolicy,
} from '../networkPolicy';

describe('networkPolicy', () => {
  beforeEach(() => {
    getNetworkStateAsync.mockReset();
  });

  test.each([
    [{ type: 'WIFI', isConnected: true }, NETWORK_POLICY.WIFI],
    [{ type: 'ETHERNET', isConnected: true }, NETWORK_POLICY.WIFI],
    [{ type: 'CELLULAR', isConnected: true, isInternetReachable: true }, NETWORK_POLICY.CELLULAR],
    [{ type: 'UNKNOWN', isConnected: true }, NETWORK_POLICY.UNKNOWN],
    [{ type: 'NONE', isConnected: false }, NETWORK_POLICY.UNKNOWN],
    [null, NETWORK_POLICY.UNKNOWN],
  ])('classifies %j', (state, expected) => {
    expect(classifyNetworkPolicy(state)).toBe(expected);
  });

  test('refreshes the current policy and notifies only on tier changes', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeNetworkPolicy(listener);

    getNetworkStateAsync.mockResolvedValue({ type: 'WIFI', isConnected: true });
    await getNetworkPolicy();
    expect(getCurrentNetworkPolicy()).toBe(NETWORK_POLICY.WIFI);
    expect(listener).toHaveBeenCalledWith(NETWORK_POLICY.WIFI);

    listener.mockClear();
    await getNetworkPolicy();
    expect(listener).not.toHaveBeenCalled();

    getNetworkStateAsync.mockResolvedValue({ type: 'CELLULAR', isConnected: true });
    await getNetworkPolicy();
    expect(getCurrentNetworkPolicy()).toBe(NETWORK_POLICY.CELLULAR);
    expect(listener).toHaveBeenCalledWith(NETWORK_POLICY.CELLULAR);

    unsubscribe();
  });

  test('returns SAFE_NETWORK_POLICY immediately upon module import before any async query', () => {
    jest.isolateModules(() => {
      const {
        getCurrentNetworkPolicy: getInitialPolicy,
        SAFE_NETWORK_POLICY: safeBaseline,
      } = require('../networkPolicy');
      expect(getInitialPolicy()).toBe(safeBaseline);
      expect(getInitialPolicy().type).toBe('unknown');
      expect(getInitialPolicy().maxConcurrent).toBe(1);
      expect(getInitialPolicy().lookahead).toBe(1);
    });
  });

  test('falls back to the safe policy when the native query fails', async () => {
    getNetworkStateAsync.mockRejectedValue(new Error('native unavailable'));
    await getNetworkPolicy();
    expect(getCurrentNetworkPolicy()).toBe(NETWORK_POLICY.UNKNOWN);
  });

  test('returns safe baseline (maxConcurrent: 1, lookahead: 1) on unknown/safe policy', () => {
    expect(getCurrentNetworkPolicy().maxConcurrent).toBe(1);
    expect(getCurrentNetworkPolicy().lookahead).toBe(1);
  });
});
