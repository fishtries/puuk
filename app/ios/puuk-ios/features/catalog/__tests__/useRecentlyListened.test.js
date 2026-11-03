import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AppState } from 'react-native';
import {
  useRecentlyListened,
  errorCooldowns,
  clearErrorCooldowns,
  ERROR_COOLDOWN_MS,
} from '../useRecentlyListened';
import * as historyApi from '../../../shared/api/history';
import * as apiCache from '../../../shared/api/apiCache';

jest.mock('@react-navigation/native', () => ({
  useIsFocused: jest.fn(() => true),
}));

jest.mock('../../../shared/api/history', () => {
  const actual = jest.requireActual('../../../shared/api/history');
  return {
    ...actual,
    fetchRecentlyListened: jest.fn(),
  };
});

jest.mock('../../../shared/api/apiCache', () => {
  const actual = jest.requireActual('../../../shared/api/apiCache');
  return {
    ...actual,
    getCachedCatalog: jest.fn(),
  };
});

describe('useRecentlyListened', () => {
  let appStateListener;
  let hookResult;

  function TestHarness({ currentUser = { id: 1 }, isFocused = true, serverUrl = 'https://puuk.test' }) {
    hookResult = useRecentlyListened({ currentUser, isFocused, serverUrl });
    return null;
  }

  beforeEach(() => {
    jest.resetAllMocks();
    clearErrorCooldowns();
    hookResult = null;

    jest.spyOn(AppState, 'addEventListener').mockImplementation((event, callback) => {
      if (event === 'change') {
        appStateListener = callback;
      }
      return { remove: jest.fn() };
    });
  });

  afterEach(() => {
    AppState.addEventListener.mockRestore?.();
  });

  test('cold start: triggers fetchRecentlyListened for authenticated user', async () => {
    const mockTracks = [
      { id: 1, title: 'Track 1', artist: 'Artist 1' },
      { id: 2, title: 'Track 2', artist: 'Artist 2' },
    ];
    historyApi.fetchRecentlyListened.mockResolvedValueOnce({
      data: mockTracks,
      fromCache: false,
      isStale: false,
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<TestHarness currentUser={{ id: 1 }} isFocused={true} />);
    });

    expect(historyApi.fetchRecentlyListened).toHaveBeenCalledTimes(1);
    expect(hookResult.tracks).toHaveLength(2);
    expect(hookResult.isLoading).toBe(false);
  });

  test('when isFocused is false on mount, does not trigger fetch', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<TestHarness currentUser={{ id: 1 }} isFocused={false} />);
    });

    expect(historyApi.fetchRecentlyListened).not.toHaveBeenCalled();
    expect(hookResult.tracks).toEqual([]);
    expect(hookResult.isLoading).toBe(false);
  });

  test('becoming focused triggers fetch', async () => {
    historyApi.fetchRecentlyListened.mockResolvedValueOnce({
      data: [{ id: 10, title: 'Song 10' }],
      fromCache: true,
      isStale: false,
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<TestHarness currentUser={{ id: 1 }} isFocused={false} />);
    });
    expect(historyApi.fetchRecentlyListened).not.toHaveBeenCalled();

    await act(async () => {
      renderer.update(<TestHarness currentUser={{ id: 1 }} isFocused={true} />);
    });

    expect(historyApi.fetchRecentlyListened).toHaveBeenCalledTimes(1);
    expect(hookResult.tracks[0].id).toBe(10);
  });

  test('AppState change to active triggers fetch only when focused', async () => {
    historyApi.fetchRecentlyListened.mockResolvedValue({
      data: [{ id: 1, title: 'Active Song' }],
      fromCache: false,
      isStale: false,
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<TestHarness currentUser={{ id: 1 }} isFocused={false} />);
    });

    // Foreground while unfocused
    await act(async () => {
      appStateListener?.('active');
    });
    expect(historyApi.fetchRecentlyListened).not.toHaveBeenCalled();

    // Now focus
    await act(async () => {
      renderer.update(<TestHarness currentUser={{ id: 1 }} isFocused={true} />);
    });
    expect(historyApi.fetchRecentlyListened).toHaveBeenCalledTimes(1);

    // Foreground while focused
    await act(async () => {
      appStateListener?.('active');
    });
    expect(historyApi.fetchRecentlyListened).toHaveBeenCalledTimes(2);
  });

  test('error puts namespace into 60s cooldown; skips network fetch during cooldown', async () => {
    historyApi.fetchRecentlyListened.mockRejectedValueOnce(new Error('Network failure'));

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<TestHarness currentUser={{ id: 42 }} isFocused={true} />);
    });

    expect(historyApi.fetchRecentlyListened).toHaveBeenCalledTimes(1);
    expect(hookResult.isLoading).toBe(false);
    expect(hookResult.tracks).toEqual([]);

    // Check cooldown recorded
    const cooldown = errorCooldowns.get('https://puuk.test__42');
    expect(cooldown).toBeDefined();

    // Another event within 60s (e.g. app foreground)
    apiCache.getCachedCatalog.mockResolvedValueOnce(null);
    await act(async () => {
      appStateListener?.('active');
    });

    // fetchRecentlyListened must NOT be called again
    expect(historyApi.fetchRecentlyListened).toHaveBeenCalledTimes(1);
    // Instead only getCachedCatalog was checked
    expect(apiCache.getCachedCatalog).toHaveBeenCalledWith(
      historyApi.RECENTLY_LISTENED_CACHE_KEY,
      expect.objectContaining({ userId: 42 }),
    );
  });

  test('stale cache error preserves stale cache and records cooldown', async () => {
    historyApi.fetchRecentlyListened.mockResolvedValueOnce({
      data: [{ id: 50, title: 'Stale Song' }],
      fromCache: true,
      isStale: true,
      error: new Error('Revalidation failed'),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<TestHarness currentUser={{ id: 1 }} isFocused={true} />);
    });

    expect(hookResult.tracks).toHaveLength(1);
    expect(hookResult.tracks[0].id).toBe(50);
    expect(errorCooldowns.get('https://puuk.test__1')).toBeDefined();
  });

  test('immediate data clearing on account switch and logout', async () => {
    historyApi.fetchRecentlyListened.mockImplementationOnce(() =>
      Promise.resolve({
        data: [{ id: 1, title: 'User 1 Song' }],
        fromCache: false,
        isStale: false,
      }),
    );

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<TestHarness currentUser={{ id: 1 }} isFocused={true} />);
    });
    expect(hookResult.tracks[0].id).toBe(1);

    // Switch to User 2
    historyApi.fetchRecentlyListened.mockImplementationOnce(() =>
      Promise.resolve({
        data: [{ id: 2, title: 'User 2 Song' }],
        fromCache: false,
        isStale: false,
      }),
    );

    await act(async () => {
      renderer.update(<TestHarness currentUser={{ id: 2 }} isFocused={true} />);
    });

    expect(hookResult.tracks[0].id).toBe(2);

    // Logout (currentUser = null)
    await act(async () => {
      renderer.update(<TestHarness currentUser={null} isFocused={true} />);
    });

    expect(hookResult.tracks).toEqual([]);
    expect(hookResult.isLoading).toBe(false);
  });
});
