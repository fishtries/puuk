import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  useShareNavigationStore,
  PENDING_SHARE_STORAGE_KEY,
  PENDING_SHARE_MAX_AGE_MS,
  readPendingDestination,
  writePendingDestination,
  deletePendingDestination,
  type ShareTarget,
} from '../useShareNavigationStore.ts';
import {
  fetchShareEntity,
  ShareApiError,
  type ShareEntityResponse,
} from '../../api/share.ts';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

describe('useShareNavigationStore and Pending Destination State', () => {
  const validTrackId = '550e8400-e29b-41d4-a716-446655440000';
  const validAlbumId = '12345';
  const validArtistId = 'art_0123456789abcdef0123456789abcdef';

  let originalWindow: PropertyDescriptor | undefined;
  let originalFetch: PropertyDescriptor | undefined;
  let originalLocalStorage: PropertyDescriptor | undefined;

  let memorySessionStorage: MemoryStorage;
  let memoryLocalStorage: MemoryStorage;
  let historyLog: Array<{ action: 'push' | 'replace'; state: unknown; url: string }>;
  let currentPath: string;

  beforeEach(() => {
    useShareNavigationStore.getState().reset();

    memorySessionStorage = new MemoryStorage();
    memoryLocalStorage = new MemoryStorage();
    memoryLocalStorage.setItem('puuk_token', 'test-valid-bearer-token');
    historyLog = [];
    currentPath = '/';

    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

    const mockWindow = {
      sessionStorage: memorySessionStorage,
      localStorage: memoryLocalStorage,
      location: {
        get pathname() {
          return currentPath;
        },
        set pathname(val: string) {
          currentPath = val;
        },
        href: 'https://web.puuk.fun/',
        origin: 'https://web.puuk.fun',
      },
      history: {
        pushState: (state: unknown, _title: string, url: string) => {
          historyLog.push({ action: 'push', state, url });
          currentPath = url;
        },
        replaceState: (state: unknown, _title: string, url: string) => {
          historyLog.push({ action: 'replace', state, url });
          currentPath = url;
        },
      },
    };

    Object.defineProperty(globalThis, 'window', {
      value: mockWindow,
      configurable: true,
      writable: true,
    });

    Object.defineProperty(globalThis, 'localStorage', {
      value: memoryLocalStorage,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      delete (globalThis as Record<string, unknown>).window;
    }

    if (originalFetch) {
      Object.defineProperty(globalThis, 'fetch', originalFetch);
    }

    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    }
  });

  describe('Pending destination storage policy', () => {
    it('writes and reads valid pending destination with 24-hour TTL', () => {
      const now = 1_700_000_000_000;
      const target: ShareTarget = { type: 'track', id: validTrackId };

      const saved = writePendingDestination(target, memorySessionStorage, now);
      assert.equal(saved, true);

      const entry = readPendingDestination(memorySessionStorage, now + 1000);
      assert.deepEqual(entry, {
        type: 'track',
        id: validTrackId,
        savedAt: now,
      });

      // Exactly at 24h: valid
      const at24h = readPendingDestination(memorySessionStorage, now + PENDING_SHARE_MAX_AGE_MS);
      assert.ok(at24h);

      // Beyond 24h: expired and purged
      const expired = readPendingDestination(memorySessionStorage, now + PENDING_SHARE_MAX_AGE_MS + 1);
      assert.equal(expired, null);
      assert.equal(memorySessionStorage.getItem(PENDING_SHARE_STORAGE_KEY), null, 'expired entry must be cleared');
    });

    it('rejects future timestamps and purges corrupt entry', () => {
      const now = 1_700_000_000_000;
      // Clock skew beyond 60s tolerance (e.g. 5 minutes in future)
      const futureTime = now + 5 * 60 * 1000;
      memorySessionStorage.setItem(
        PENDING_SHARE_STORAGE_KEY,
        JSON.stringify({ type: 'album', id: validAlbumId, savedAt: futureTime })
      );

      const res = readPendingDestination(memorySessionStorage, now);
      assert.equal(res, null);
      assert.equal(memorySessionStorage.getItem(PENDING_SHARE_STORAGE_KEY), null, 'future corrupt entry must be purged');
    });

    it('rejects negative or non-finite timestamps and purges corrupt entry', () => {
      const now = 1_700_000_000_000;
      memorySessionStorage.setItem(
        PENDING_SHARE_STORAGE_KEY,
        JSON.stringify({ type: 'artist', id: validArtistId, savedAt: -100 })
      );

      const res = readPendingDestination(memorySessionStorage, now);
      assert.equal(res, null);
      assert.equal(memorySessionStorage.getItem(PENDING_SHARE_STORAGE_KEY), null);
    });

    it('rejects corrupt JSON and invalid entity IDs in storage', () => {
      const now = 1_700_000_000_000;
      // Corrupt JSON
      memorySessionStorage.setItem(PENDING_SHARE_STORAGE_KEY, '{invalid-json');
      assert.equal(readPendingDestination(memorySessionStorage, now), null);
      assert.equal(memorySessionStorage.getItem(PENDING_SHARE_STORAGE_KEY), null);

      // Malformed entity ID (e.g. uppercase UUID)
      memorySessionStorage.setItem(
        PENDING_SHARE_STORAGE_KEY,
        JSON.stringify({ type: 'track', id: validTrackId.toUpperCase(), savedAt: now })
      );
      assert.equal(readPendingDestination(memorySessionStorage, now), null);
      assert.equal(memorySessionStorage.getItem(PENDING_SHARE_STORAGE_KEY), null);

      // Album ID zero
      memorySessionStorage.setItem(
        PENDING_SHARE_STORAGE_KEY,
        JSON.stringify({ type: 'album', id: '0', savedAt: now })
      );
      assert.equal(readPendingDestination(memorySessionStorage, now), null);
      assert.equal(memorySessionStorage.getItem(PENDING_SHARE_STORAGE_KEY), null);
    });

    it('safely handles unavailable or throwing sessionStorage', () => {
      const throwingStorage = {
        getItem: () => {
          throw new Error('SecurityError: Access denied');
        },
        setItem: () => {
          throw new Error('SecurityError: Access denied');
        },
        removeItem: () => {
          throw new Error('SecurityError: Access denied');
        },
      } as unknown as Storage;

      assert.doesNotThrow(() => {
        const read = readPendingDestination(throwingStorage);
        assert.equal(read, null);

        const write = writePendingDestination({ type: 'track', id: validTrackId }, throwingStorage);
        assert.equal(write, false);

        deletePendingDestination(throwingStorage);
      });
    });
  });

  describe('Navigation store and history actions', () => {
    it('initFromLocation sets currentTarget, saves pending destination, and normalizes trailing slash', () => {
      currentPath = `/track/${validTrackId}/`;
      const store = useShareNavigationStore.getState();

      const target = store.initFromLocation();
      assert.deepEqual(target, { type: 'track', id: validTrackId });

      const state = useShareNavigationStore.getState();
      assert.deepEqual(state.currentTarget, { type: 'track', id: validTrackId });
      assert.ok(state.pendingDestination);
      assert.equal(state.pendingDestination.id, validTrackId);

      // Verify replaceState was called to clean up trailing slash
      const replaceEntries = historyLog.filter((h) => h.action === 'replace');
      assert.ok(replaceEntries.length > 0);
      assert.equal(replaceEntries[replaceEntries.length - 1].url, `/track/${validTrackId}`);
    });

    it('initFromLocation on home page restores unexpired pending destination from prior tab session', () => {
      currentPath = '/';
      writePendingDestination({ type: 'album', id: validAlbumId }, memorySessionStorage);

      const store = useShareNavigationStore.getState();
      const target = store.initFromLocation();

      assert.equal(target, null, 'home page is not an active share URL in address bar');
      const state = useShareNavigationStore.getState();
      assert.equal(state.currentTarget, null);
      assert.ok(state.pendingDestination);
      assert.equal(state.pendingDestination.type, 'album');
      assert.equal(state.pendingDestination.id, validAlbumId);
    });

    it('navigateToTarget updates state, pushes history, and avoids history loops', () => {
      const store = useShareNavigationStore.getState();
      store.navigateToTarget({ type: 'artist', id: validArtistId });

      let state = useShareNavigationStore.getState();
      assert.deepEqual(state.currentTarget, { type: 'artist', id: validArtistId });
      assert.ok(state.pendingDestination);
      assert.equal(state.pendingDestination.id, validArtistId);

      assert.equal(historyLog.length, 1);
      assert.equal(historyLog[0].action, 'push');
      assert.equal(historyLog[0].url, `/artist/${validArtistId}`);

      // Calling navigateToTarget with identical target avoids redundant history push
      store.navigateToTarget({ type: 'artist', id: validArtistId });
      assert.equal(historyLog.length, 1, 'redundant navigation must not push duplicate history entry');
    });

    it('cancelNavigation clears pending destination and replaces history with root', () => {
      const store = useShareNavigationStore.getState();
      store.navigateToTarget({ type: 'album', id: validAlbumId });
      assert.ok(memorySessionStorage.getItem(PENDING_SHARE_STORAGE_KEY));

      store.cancelNavigation();

      const state = useShareNavigationStore.getState();
      assert.equal(state.currentTarget, null);
      assert.equal(state.pendingDestination, null);
      assert.equal(memorySessionStorage.getItem(PENDING_SHARE_STORAGE_KEY), null, 'storage must be cleared');

      const lastHistory = historyLog[historyLog.length - 1];
      assert.equal(lastHistory.action, 'replace');
      assert.equal(lastHistory.url, '/');
    });

    it('handlePopState re-parses path, cancels stale request, and NEVER calls pushState', () => {
      const store = useShareNavigationStore.getState();
      const initialGen = store.generation;

      const pushCountBefore = historyLog.filter((h) => h.action === 'push').length;
      store.handlePopState(`/track/${validTrackId}`);

      const state = useShareNavigationStore.getState();
      assert.deepEqual(state.currentTarget, { type: 'track', id: validTrackId });
      assert.ok(state.generation > initialGen, 'popstate must increment generation to cancel stale requests');

      const pushCountAfter = historyLog.filter((h) => h.action === 'push').length;
      assert.equal(pushCountAfter, pushCountBefore, 'CONTRACT §8: never push from popstate');
    });
  });

  describe('Authenticated Resolver Client and Error Bounds', () => {
    it('successfully resolves share entity, clears pending state, and does NOT auto-play', async () => {
      const mockResponse: ShareEntityResponse = {
        type: 'track',
        requested_id: validTrackId,
        canonical_id: validTrackId,
        canonical_path: `/track/${validTrackId}`,
        entity: {
          id: validTrackId, share_id: validTrackId, content_version: null, album_share_id: null,
          title: 'Track Title',
          artist: 'Track Artist',
          duration: 210,
          coverArt: '/cover.jpg',
        },
        tracks: [
          {
            id: validTrackId, share_id: validTrackId, content_version: null, album_share_id: null,
            title: 'Track Title',
            artist: 'Track Artist',
            duration: 210,
          },
        ],
        albums: [],
      };

      Object.defineProperty(globalThis, 'fetch', {
        value: async (url: string, init: RequestInit) => {
          assert.ok(url.includes(`/api/share/track/${validTrackId}`));
          const headers = new Headers(init.headers);
          assert.equal(headers.get('Cache-Control'), 'no-store');
          assert.ok(headers.get('Authorization')?.startsWith('Bearer '));
          return new Response(JSON.stringify(mockResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
        configurable: true,
      });

      const store = useShareNavigationStore.getState();
      store.navigateToTarget({ type: 'track', id: validTrackId });
      assert.ok(useShareNavigationStore.getState().pendingDestination);

      const resolved = await store.resolveCurrentTarget();
      assert.deepEqual(resolved, mockResponse);

      const state = useShareNavigationStore.getState();
      assert.equal(state.isResolving, false);
      assert.equal(state.error, null);
      assert.deepEqual(state.resolvedEntity, mockResponse);
      assert.equal(state.pendingDestination, null, 'pending destination cleared on successful display');

      // CONTRACT §8: Invariant - No auto-play, no queue mutation
      // The store has no player integration or auto-play side effects
      assert.equal((state as unknown as Record<string, unknown>).isPlaying, undefined);
    });

    it('canonicalizes alias URL when canonical_path differs from requested', async () => {
      const originalAlbumId = '100';
      const mergedAlbumId = '200';

      const mockResponse: ShareEntityResponse = {
        type: 'album',
        requested_id: originalAlbumId,
        canonical_id: mergedAlbumId,
        canonical_path: `/album/${mergedAlbumId}`,
        entity: {
          id: mergedAlbumId, share_id: mergedAlbumId,
          title: 'Canonical Merged Album',
          artist: 'Various',
        },
        tracks: [],
        albums: [],
      };

      Object.defineProperty(globalThis, 'fetch', {
        value: async () => {
          return new Response(JSON.stringify(mockResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
        configurable: true,
      });

      const store = useShareNavigationStore.getState();
      store.navigateToTarget({ type: 'album', id: originalAlbumId });

      await store.resolveCurrentTarget();

      const state = useShareNavigationStore.getState();
      assert.deepEqual(state.currentTarget, { type: 'album', id: mergedAlbumId });

      // Verify replaceState was called with canonical path (no extra history push)
      const lastHistory = historyLog[historyLog.length - 1];
      assert.equal(lastHistory.action, 'replace');
      assert.equal(lastHistory.url, `/album/${mergedAlbumId}`);
    });

    it('handles 401 Unauthorized by setting auth error and KEEPING pending destination', async () => {
      Object.defineProperty(globalThis, 'fetch', {
        value: async () => {
          return new Response(JSON.stringify({ detail: 'Token required' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        },
        configurable: true,
      });

      const store = useShareNavigationStore.getState();
      store.navigateToTarget({ type: 'track', id: validTrackId });

      await store.resolveCurrentTarget();

      const state = useShareNavigationStore.getState();
      assert.equal(state.isResolving, false);
      assert.ok(state.error);
      assert.equal(state.error.kind, 'auth');
      assert.equal(state.error.status, 401);

      // CONTRACT §8: "401 keeps the target pending for another login."
      assert.ok(state.pendingDestination, 'pending destination must be retained for login completion');
      assert.ok(memorySessionStorage.getItem(PENDING_SHARE_STORAGE_KEY), 'storage entry preserved across 401');
    });

    it('handles 403 Forbidden as terminal error and clears pending destination', async () => {
      Object.defineProperty(globalThis, 'fetch', {
        value: async () => {
          return new Response(JSON.stringify({ detail: 'Access denied' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          });
        },
        configurable: true,
      });

      const store = useShareNavigationStore.getState();
      store.navigateToTarget({ type: 'track', id: validTrackId });

      await store.resolveCurrentTarget();

      const state = useShareNavigationStore.getState();
      assert.equal(state.isResolving, false);
      assert.ok(state.error);
      assert.equal(state.error.kind, 'terminal');
      assert.equal(state.error.status, 403);
      assert.equal(state.pendingDestination, null, 'terminal error must clear pending destination');
      assert.equal(memorySessionStorage.getItem(PENDING_SHARE_STORAGE_KEY), null);
    });

    it('handles 404 / 410 as terminal error with message "Недоступно" and clears pending destination', async () => {
      for (const status of [404, 410]) {
        useShareNavigationStore.getState().reset();
        Object.defineProperty(globalThis, 'fetch', {
          value: async () => {
            return new Response(JSON.stringify({ detail: 'Not found' }), {
              status,
              headers: { 'Content-Type': 'application/json' },
            });
          },
          configurable: true,
        });

        const store = useShareNavigationStore.getState();
        store.navigateToTarget({ type: 'track', id: validTrackId });

        await store.resolveCurrentTarget();

        const state = useShareNavigationStore.getState();
        assert.equal(state.isResolving, false);
        assert.ok(state.error);
        assert.equal(state.error.kind, 'terminal');
        assert.equal(state.error.status, status);
        assert.equal(state.error.message, 'Недоступно', 'CONTRACT §7.2: 404/410 shows "Недоступно"');
        assert.equal(state.pendingDestination, null);
      }
    });

    it('handles 5xx / Network errors as retryable and KEEPS pending destination', async () => {
      Object.defineProperty(globalThis, 'fetch', {
        value: async () => {
          return new Response(JSON.stringify({ detail: 'Internal server error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        },
        configurable: true,
      });

      const store = useShareNavigationStore.getState();
      store.navigateToTarget({ type: 'track', id: validTrackId });

      await store.resolveCurrentTarget();

      const state = useShareNavigationStore.getState();
      assert.equal(state.isResolving, false);
      assert.ok(state.error);
      assert.equal(state.error.kind, 'retryable');
      assert.equal(state.error.status, 500);

      // CONTRACT §8: "retaining Retry for network failures"
      assert.ok(state.pendingDestination, 'pending destination retained on retryable error');
      assert.ok(memorySessionStorage.getItem(PENDING_SHARE_STORAGE_KEY));
    });

    it('enforces client-side 5-second timeout on stalled resolver requests', async () => {
      // Mock fetch that hangs or checks signal timeout
      Object.defineProperty(globalThis, 'fetch', {
        value: (url: string, init: RequestInit) => {
          return new Promise((resolve, reject) => {
            if (init?.signal) {
              init.signal.addEventListener('abort', () => {
                const err = new Error('The operation was aborted');
                err.name = 'AbortError';
                reject(err);
              });
            }
          });
        },
        configurable: true,
      });

      // Pass timeoutMs: 50ms for test efficiency
      await assert.rejects(
        async () => {
          await fetchShareEntity('track', validTrackId, { timeoutMs: 50 });
        },
        (err: unknown) => {
          assert.ok(err instanceof ShareApiError);
          assert.equal(err.code, 'timeout');
          assert.equal(err.isRetryable, true);
          return true;
        }
      );
    });

    it('fences against stale responses when navigation target changes while request is in-flight', async () => {
      let resolveFirstFetch!: (val: Response) => void;
      const firstFetchPromise = new Promise<Response>((resolve) => {
        resolveFirstFetch = resolve;
      });

      let callCount = 0;
      Object.defineProperty(globalThis, 'fetch', {
        value: async (_url: string) => {
          callCount++;
          if (callCount === 1) {
            // First fetch (Target A) hangs until manually resolved
            return firstFetchPromise;
          }
          // Second fetch (Target B) responds immediately
          return new Response(
            JSON.stringify({
              type: 'album',
              requested_id: validAlbumId,
              canonical_id: validAlbumId,
              canonical_path: `/album/${validAlbumId}`,
              entity: { id: validAlbumId, share_id: validAlbumId, title: 'Album B', artist: 'Artist B' },
              tracks: [],
              albums: [],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        },
        configurable: true,
      });

      const store = useShareNavigationStore.getState();

      // 1. Start navigating to Target A
      store.navigateToTarget({ type: 'track', id: validTrackId });
      const firstResolution = store.resolveCurrentTarget();

      // 2. While Target A is in-flight, user navigates to Target B
      store.navigateToTarget({ type: 'album', id: validAlbumId });
      const secondResolution = store.resolveCurrentTarget();
      await secondResolution;

      const stateAfterB = useShareNavigationStore.getState();
      assert.deepEqual(stateAfterB.currentTarget, { type: 'album', id: validAlbumId });
      assert.equal(stateAfterB.resolvedEntity?.canonical_id, validAlbumId);

      // 3. Late response for Target A arrives
      resolveFirstFetch(
        new Response(
          JSON.stringify({
            type: 'track',
            requested_id: validTrackId,
            canonical_id: validTrackId,
            canonical_path: `/track/${validTrackId}`,
            entity: { id: validTrackId, share_id: validTrackId, content_version: null, album_share_id: null, title: 'Track A', artist: 'Artist A' },
            tracks: [],
            albums: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const lateResult = await firstResolution;
      assert.equal(lateResult, null, 'late resolution must return null due to generation mismatch');

      // Target B must NOT have been overwritten by late Target A response!
      const finalState = useShareNavigationStore.getState();
      assert.deepEqual(finalState.currentTarget, { type: 'album', id: validAlbumId });
      assert.equal(finalState.resolvedEntity?.canonical_id, validAlbumId);
    });
  });
});
