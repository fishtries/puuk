jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn(),
  addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
}));

import { getNetworkStateAsync } from 'expo-network';
import {
  NETWORK_POLICY,
  classifyNetworkPolicy,
  buildNetworkPolicy,
  getCurrentNetworkPolicy,
  getNetworkPolicy,
  isPolicyOnline,
  subscribeNetworkPolicy,
} from '../networkPolicy';

describe('networkPolicy', () => {
  beforeEach(() => {
    getNetworkStateAsync.mockReset();
  });

  test.each([
    [{ type: 'WIFI', isConnected: true }, NETWORK_POLICY.WIFI],
    [{ type: 'ETHERNET', isConnected: true }, NETWORK_POLICY.WIFI],
    [
      { type: 'CELLULAR', isConnected: true, isInternetReachable: true },
      NETWORK_POLICY.CELLULAR,
    ],
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

    getNetworkStateAsync.mockResolvedValue({
      type: 'CELLULAR',
      isConnected: true,
    });
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

  test('offline policy keeps the safe limits and reports isConnected:false', async () => {
    const policy = buildNetworkPolicy({ type: 'WIFI', isConnected: false });
    expect(policy).toEqual({
      ...NETWORK_POLICY.UNKNOWN,
      isConnected: false,
    });
    expect(policy.maxConcurrent).toBe(1);
    expect(policy.lookahead).toBe(1);
    expect(isPolicyOnline(policy)).toBe(false);
  });

  test('connected policy keeps the tier limits and object identity', () => {
    const policy = buildNetworkPolicy({ type: 'WIFI', isConnected: true });
    expect(policy).toBe(NETWORK_POLICY.WIFI);
    expect(isPolicyOnline(policy)).toBe(true);
    expect(isPolicyOnline(NETWORK_POLICY.CELLULAR)).toBe(true);
    expect(isPolicyOnline(null)).toBe(true);
  });

  test('unknown network type never expands limits even when connected', () => {
    const policy = buildNetworkPolicy({ type: 'UNKNOWN', isConnected: true });
    expect(policy.maxConcurrent).toBe(1);
    expect(policy.lookahead).toBe(1);
    expect(isPolicyOnline(policy)).toBe(true);
  });

  test('offline transition notifies listeners with isConnected metadata', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeNetworkPolicy(listener);

    getNetworkStateAsync.mockResolvedValue({
      type: 'CELLULAR',
      isConnected: true,
    });
    await getNetworkPolicy();
    listener.mockClear();

    getNetworkStateAsync.mockResolvedValue({
      type: 'CELLULAR',
      isConnected: false,
    });
    await getNetworkPolicy();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getCurrentNetworkPolicy().isConnected).toBe(false);
    expect(getCurrentNetworkPolicy().maxConcurrent).toBe(1);
    unsubscribe();

    // Restore online state for other tests.
    getNetworkStateAsync.mockResolvedValue({ type: 'WIFI', isConnected: true });
    await getNetworkPolicy();
  });

  test.each([
    [
      { type: 'WIFI', isConnected: true, isInternetReachable: false },
      false,
      'unknown',
    ],
    [
      { type: 'WIFI', isConnected: false, isInternetReachable: true },
      false,
      'unknown',
    ],
    [
      { type: 'WIFI', isConnected: true, isInternetReachable: true },
      true,
      'wifi',
    ],
    [
      { type: 'WIFI', isConnected: true, isInternetReachable: undefined },
      true,
      'wifi',
    ],
    [{ type: 'UNKNOWN', isInternetReachable: null }, true, 'unknown'],
  ])(
    'public policy preserves explicit reachability veto for %j',
    (state, online, tier) => {
      const policy = buildNetworkPolicy(state);
      expect(isPolicyOnline(policy)).toBe(online);
      expect(policy.type).toBe(tier);
      if (!online) expect(policy.isConnected).toBe(false);
    },
  );

  test('same unknown tier notifies once on reachability loss and once on reconnect', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeNetworkPolicy(listener);
    getNetworkStateAsync.mockResolvedValue({
      type: 'UNKNOWN',
      isConnected: true,
    });
    await getNetworkPolicy();
    listener.mockClear();
    getNetworkStateAsync.mockResolvedValue({
      type: 'UNKNOWN',
      isConnected: true,
      isInternetReachable: false,
    });
    await getNetworkPolicy();
    await getNetworkPolicy();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(isPolicyOnline(getCurrentNetworkPolicy())).toBe(false);
    getNetworkStateAsync.mockResolvedValue({
      type: 'UNKNOWN',
      isConnected: true,
      isInternetReachable: true,
    });
    await getNetworkPolicy();
    await getNetworkPolicy();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(isPolicyOnline(getCurrentNetworkPolicy())).toBe(true);
    unsubscribe();
  });
});
