import { useState, useEffect, useRef, useCallback } from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import {
  fetchRecentlyListened,
  normalizeHistoryTracks,
  RECENTLY_LISTENED_CACHE_KEY,
  RECENTLY_LISTENED_TTL_MS,
} from '../../shared/api/history';
import { getCachedCatalog } from '../../shared/api/apiCache';
import {
  SERVER_URL,
  addAuthListener,
  getCachedUser,
  isNetworkError,
} from '../../shared/api/api';
import { syncStateManager } from '../../shared/sync/syncState';
import { selectRecentlyListened } from './recentlyListenedSelection';

export const ERROR_COOLDOWN_MS = 60 * 1000; // 60 seconds
export const errorCooldowns = new Map(); // namespaceKey => timestamp

export function clearErrorCooldowns() {
  errorCooldowns.clear();
}

/**
 * Hook for managing recently listened tracks on the Home screen.
 * Handles:
 * - 1-hour cache TTL (no polling/timers)
 * - Focus and foreground revalidation
 * - Stale-while-revalidate without skeleton flashes
 * - 60-second error cooldown per user/server namespace
 * - Immediate data isolation on account switch/logout
 *
 * @param {Object} [options]
 * @param {Object|null} [options.currentUser]
 * @param {string} [options.serverUrl]
 * @param {boolean} [options.isFocused]
 * @returns {{ tracks: Array<Object>, isLoading: boolean, refresh: Function }}
 */
export function useRecentlyListened(options = {}) {
  const { currentUser: propUser, serverUrl: propServerUrl } = options;
  const serverUrl = propServerUrl || SERVER_URL || '';

  let navFocused = true;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    navFocused = useIsFocused();
  } catch {
    navFocused = true;
  }
  const isFocused =
    options.isFocused !== undefined
      ? Boolean(options.isFocused)
      : Boolean(navFocused);

  const [authUser, setAuthUser] = useState(() =>
    propUser !== undefined ? propUser : getCachedUser(),
  );
  useEffect(() => {
    if (propUser !== undefined) {
      setAuthUser(propUser);
    }
  }, [propUser]);

  useEffect(() => {
    const unsub = addAuthListener((user) => {
      setAuthUser(user);
    });
    return unsub;
  }, []);

  const userId = authUser
    ? (authUser.id ?? authUser.user_id ?? authUser)
    : null;

  const [tracks, setTracks] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  const activeAbortRef = useRef(null);
  const prevUserNamespaceRef = useRef(null);
  const prevFocusedRef = useRef(isFocused);

  const loadData = useCallback(
    async (isForced = false) => {
      if (!userId) {
        setTracks([]);
        setIsLoading(false);
        return;
      }

      const namespaceKey = `${serverUrl}__${userId}`;
      const lastErrorTime = errorCooldowns.get(namespaceKey) || 0;
      const inCooldown =
        !isForced && Date.now() - lastErrorTime < ERROR_COOLDOWN_MS;

      // Cancel previous in-flight request
      if (activeAbortRef.current) {
        activeAbortRef.current.abort();
      }
      const abortController = new AbortController();
      activeAbortRef.current = abortController;

      // If currently displaying 0 tracks, show skeleton loading
      if (tracksRef.current.length === 0) {
        setIsLoading(true);
      }

      if (inCooldown) {
        try {
          const cached = await getCachedCatalog(RECENTLY_LISTENED_CACHE_KEY, {
            serverUrl,
            userId,
            ttlMs: RECENTLY_LISTENED_TTL_MS,
          });
          if (abortController.signal.aborted) return;
          if (cached && Array.isArray(cached.data)) {
            const normalized = normalizeHistoryTracks(cached.data, serverUrl);
            setTracks(selectRecentlyListened(normalized, 20));
          }
        } catch {
          // ignore in cooldown
        } finally {
          if (!abortController.signal.aborted) {
            setIsLoading(false);
          }
        }
        return;
      }

      try {
        const res = await fetchRecentlyListened({
          serverUrl,
          userId,
          signal: abortController.signal,
          forceRefresh: isForced,
          onNetworkStart: () => {
            syncStateManager.startOperation('recently_listened', {
              retryFn: () => loadData(true),
            });
          },
          onNetworkSuccess: () => {
            syncStateManager.finishOperation('recently_listened', {
              success: true,
            });
          },
          onNetworkError: (err) => {
            if (err?.name === 'AbortError') {
              syncStateManager.cancelOperation('recently_listened');
            } else {
              syncStateManager.finishOperation('recently_listened', {
                success: false,
                status: err?.status,
                isServer: err?.status >= 500,
                isNetwork: isNetworkError(err),
                message:
                  err?.status >= 500
                    ? 'Сервер временно недоступен'
                    : 'Ошибка загрузки истории',
              });
            }
          },
          onCachedData: (cachedList) => {
            if (abortController.signal.aborted) return;
            if (Array.isArray(cachedList) && cachedList.length > 0) {
              setTracks(selectRecentlyListened(cachedList, 20));
              setIsLoading(false);
            }
          },
          onFreshData: (freshList) => {
            if (abortController.signal.aborted) return;
            errorCooldowns.delete(namespaceKey);
            setTracks(selectRecentlyListened(freshList, 20));
            setIsLoading(false);
          },
        });

        if (abortController.signal.aborted) return;

        if (res.error) {
          errorCooldowns.set(namespaceKey, Date.now());
          syncStateManager.finishOperation('recently_listened', {
            success: false,
            status: res.error?.status,
            isServer: res.error?.status >= 500,
            isNetwork: isNetworkError(res.error),
            message:
              res.error?.status >= 500
                ? 'Сервер временно недоступен'
                : 'Ошибка загрузки истории',
          });
        } else {
          errorCooldowns.delete(namespaceKey);
        }

        if (Array.isArray(res.data)) {
          setTracks(selectRecentlyListened(res.data, 20));
        }
      } catch (err) {
        if (err?.name === 'AbortError') {
          syncStateManager.cancelOperation('recently_listened');
          return;
        }
        errorCooldowns.set(namespaceKey, Date.now());
        syncStateManager.finishOperation('recently_listened', {
          success: false,
          status: err?.status,
          isServer: err?.status >= 500,
          isNetwork: isNetworkError(err),
          message:
            err?.status >= 500
              ? 'Сервер временно недоступен'
              : 'Ошибка загрузки истории',
        });
      } finally {
        if (!abortController.signal.aborted) {
          setIsLoading(false);
        }
      }
    },
    [userId, serverUrl],
  );

  // Account switch / logout effect
  useEffect(() => {
    const userNamespace = userId ? `${serverUrl}__${userId}` : null;
    if (prevUserNamespaceRef.current !== userNamespace) {
      if (activeAbortRef.current) {
        activeAbortRef.current.abort();
      }
      setTracks([]);
      tracksRef.current = [];
      prevUserNamespaceRef.current = userNamespace;

      if (!userId) {
        setIsLoading(false);
        return;
      }

      if (isFocused) {
        loadData();
      }
    }
  }, [userId, serverUrl, isFocused, loadData]);

  // Focus effect: check TTL when screen becomes focused
  useEffect(() => {
    const wasFocused = prevFocusedRef.current;
    prevFocusedRef.current = isFocused;

    if (isFocused && !wasFocused && userId) {
      loadData();
    }
  }, [isFocused, userId, loadData]);

  // AppState change: check TTL when foregrounded while focused
  useEffect(() => {
    const handleAppStateChange = (nextState) => {
      if (nextState === 'active' && isFocused && userId) {
        loadData();
      }
    };

    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => {
      if (sub && typeof sub.remove === 'function') {
        sub.remove();
      }
    };
  }, [isFocused, userId, loadData]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (activeAbortRef.current) {
        activeAbortRef.current.abort();
      }
    };
  }, []);

  const refresh = useCallback(() => {
    return loadData(true);
  }, [loadData]);

  return {
    tracks,
    isLoading,
    refresh,
  };
}
