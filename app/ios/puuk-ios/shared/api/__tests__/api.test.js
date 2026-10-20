import * as SecureStore from 'expo-secure-store';
import {
  authFetch,
  setAuthToken,
  setSavedUser,
  getCachedAuthToken,
  getSavedUser,
  logout,
  authHandlers,
  SERVER_URL,
  classifyError,
  isRetryableStatus,
  isNetworkError,
} from '../api';

const mockStore = new Map();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key) => mockStore.get(key) || null),
  setItemAsync: jest.fn(async (key, val) => {
    mockStore.set(key, String(val));
  }),
  deleteItemAsync: jest.fn(async (key) => {
    mockStore.delete(key);
  }),
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
}));

describe('utils/api - authFetch & transport reliability', () => {
  const originalFetch = global.fetch;
  const originalFormData = global.FormData;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockStore.clear();
    await logout();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.FormData = originalFormData;
  });

  describe('успешный GET', () => {
    it('executes successful GET request with authorization and accept headers', async () => {
      await setAuthToken('valid-jwt-token');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ message: 'success' }),
      });

      const response = await authFetch('/api/tracks');

      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      const [calledUrl, calledOptions] = global.fetch.mock.calls[0];
      expect(calledUrl).toBe(`${SERVER_URL}/api/tracks`);
      expect(calledOptions.method).toBe('GET');
      expect(calledOptions.headers).toMatchObject({
        Accept: 'application/json',
        Authorization: 'Bearer valid-jwt-token',
      });
    });
  });

  describe('timeout', () => {
    it('aborts and throws TimeoutError when request exceeds timeout', async () => {
      global.fetch = jest.fn().mockImplementation((url, { signal }) => {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            const err = new Error('The user aborted a request.');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      await expect(authFetch('/api/slow', { timeout: 25, retry: 0 })).rejects.toMatchObject({
        name: 'TimeoutError',
        isTimeout: true,
        type: 'timeout',
      });
    });
  });

  describe('отмену внешним AbortController', () => {
    it('aborts and throws AbortError when external signal aborts during request, with no retries', async () => {
      const controller = new AbortController();
      global.fetch = jest.fn().mockImplementation((url, { signal }) => {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
          setTimeout(() => controller.abort(), 10);
        });
      });

      await expect(
        authFetch('/api/tracks', { signal: controller.signal, retry: 2, retryDelay: 5 })
      ).rejects.toMatchObject({
        name: 'AbortError',
      });

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('rejects immediately without fetching if external signal was already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      global.fetch = jest.fn();

      await expect(authFetch('/api/tracks', { signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('aborts immediately and cancels retry delay when external signal aborts during backoff', async () => {
      const controller = new AbortController();
      global.fetch = jest.fn().mockRejectedValueOnce(new TypeError('Network request failed'));

      const fetchPromise = authFetch('/api/tracks', {
        signal: controller.signal,
        retry: 2,
        retryDelay: 200,
      });

      // Abort while waiting in retry delay
      setTimeout(() => {
        controller.abort();
      }, 20);

      await expect(fetchPromise).rejects.toMatchObject({
        name: 'AbortError',
      });

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry после сетевой ошибки', () => {
    it('retries after transient network error and succeeds on subsequent attempt', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValueOnce(new TypeError('Network request failed'))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ success: true }),
        });

      const response = await authFetch('/api/tracks', { retryDelay: 5 });

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('throws NetworkError when all retries fail with network errors', async () => {
      global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));

      await expect(authFetch('/api/tracks', { retry: 1, retryDelay: 5 })).rejects.toMatchObject({
        name: 'NetworkError',
        isNetwork: true,
        type: 'network',
      });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('does not retry arbitrary runtime errors that are not network or timeout', async () => {
      const arbitraryError = new Error('Arbitrary runtime crash');
      global.fetch = jest.fn().mockRejectedValue(arbitraryError);

      await expect(authFetch('/api/tracks', { retry: 2, retryDelay: 5 })).rejects.toThrow(
        'Arbitrary runtime crash'
      );
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry после 500', () => {
    it('retries after 500 Internal Server Error and returns successful response', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => ({ detail: 'Server Error' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: 'ok' }),
        });

      const response = await authFetch('/api/tracks', { retryDelay: 5 });

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('returns final 500 response when all retries are exhausted', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ detail: 'Permanent 500' }),
      });

      const response = await authFetch('/api/tracks', { retry: 2, retryDelay: 5 });

      expect(response.status).toBe(500);
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('retries on 408 and 429 status codes', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 429 })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const response = await authFetch('/api/tracks', { retryDelay: 5 });
      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('отсутствие retry после 401', () => {
    it('does not retry when receiving 401 Unauthorized', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ detail: 'Unauthorized' }),
      });

      const response = await authFetch('/api/tracks', { retry: 2, retryDelay: 5 });

      expect(response.status).toBe(401);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('отсутствие retry для POST по умолчанию', () => {
    it('does not retry POST mutations by default on 500 status', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ detail: 'Server Error' }),
      });

      const response = await authFetch('/api/playlists', {
        method: 'POST',
        body: { name: 'My Playlist' },
        retryDelay: 5,
      });

      expect(response.status).toBe(500);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry POST mutations by default on network failure', async () => {
      global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));

      await expect(
        authFetch('/api/playlists', { method: 'POST', body: { name: 'Test' }, retryDelay: 5 })
      ).rejects.toMatchObject({
        name: 'NetworkError',
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('allows explicit retry for background events on POST', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const response = await authFetch('/api/wave/feedback', {
        method: 'POST',
        retry: 1,
        background: true,
        retryDelay: 5,
      });

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('сериализацию JSON body', () => {
    it('serializes JSON body without mutating caller options object', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
      const rawBody = { name: 'Chill Vibes', is_public: true };
      const inputOptions = {
        method: 'POST',
        body: rawBody,
      };

      await authFetch('/api/playlists', inputOptions);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [, passedOptions] = global.fetch.mock.calls[0];
      expect(passedOptions.body).toBe(JSON.stringify(rawBody));
      expect(passedOptions.headers['Content-Type']).toBe('application/json');

      // Critical: input options object and input body must NOT be mutated!
      expect(inputOptions.body).toBe(rawBody);
      expect(typeof inputOptions.body).toBe('object');
      expect(inputOptions.headers).toBeUndefined();
    });

    it('preserves options and correctly resends JSON body on retry', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValueOnce(new TypeError('Network request failed'))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ success: true }),
        });

      const payload = { event: 'listen', track_id: 'abc-123', count: 1 };
      const requestOptions = {
        method: 'POST',
        body: payload,
        retry: 1,
        retryDelay: 5,
      };

      const response = await authFetch('/api/wave/feedback', requestOptions);

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledTimes(2);

      const expectedBodyString = JSON.stringify(payload);
      expect(global.fetch.mock.calls[0][1].body).toBe(expectedBodyString);
      expect(global.fetch.mock.calls[1][1].body).toBe(expectedBodyString);

      expect(requestOptions.body).toBe(payload);
      expect(typeof requestOptions.body).toBe('object');
    });
  });

  describe('сохранение FormData', () => {
    it('preserves FormData without serializing or setting Content-Type: application/json', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
      class MockFormData {}
      const formData = new MockFormData();
      global.FormData = MockFormData;

      const inputOptions = {
        method: 'POST',
        body: formData,
      };

      await authFetch('/api/upload', inputOptions);

      const [, passedOptions] = global.fetch.mock.calls[0];
      expect(passedOptions.body).toBe(formData);
      expect(passedOptions.headers['Content-Type']).toBeUndefined();
      expect(inputOptions.body).toBe(formData);
    });
  });

  describe('обработку 401 и logout', () => {
    it('handles 401 response by invoking logout and clearing session', async () => {
      await setAuthToken('expired-token');
      await setSavedUser({ id: 1, username: 'testuser' });
      expect(getCachedAuthToken()).toBe('expired-token');

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });

      const response = await authFetch('/api/tracks');
      expect(response.status).toBe(401);

      expect(getCachedAuthToken()).toBeNull();
      expect(await getSavedUser()).toBeNull();
      expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('puuk_auth_token', expect.any(Object));
      expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('puuk_auth_user', expect.any(Object));
    });

    it('does not retry when logout throws an error after 401 response', async () => {
      await setAuthToken('token-to-fail-logout');
      const logoutSpy = jest.spyOn(authHandlers, 'logout').mockRejectedValueOnce(
        new Error('SecureStore failure during logout')
      );

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });

      const response = await authFetch('/api/tracks', { retry: 2, retryDelay: 5 });

      expect(response.status).toBe(401);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(logoutSpy).toHaveBeenCalledTimes(1);
      logoutSpy.mockRestore();
    });

    it('does not trigger logout for auth-exempt endpoints on 401', async () => {
      await setAuthToken('existing-token');
      const logoutSpy = jest.spyOn(authHandlers, 'logout');

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });

      const response = await authFetch('/api/auth/login', { method: 'POST', body: {} });
      expect(response.status).toBe(401);

      expect(logoutSpy).not.toHaveBeenCalled();
      expect(getCachedAuthToken()).toBe('existing-token');
      logoutSpy.mockRestore();
    });
  });

  describe('отсутствие двойного вызова logout', () => {
    it('prevents duplicate concurrent logout calls on simultaneous 401 responses', async () => {
      await setAuthToken('expired-token');
      const logoutSpy = jest.spyOn(authHandlers, 'logout');

      global.fetch = jest.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { ok: false, status: 401 };
      });

      const [res1, res2, res3] = await Promise.all([
        authFetch('/api/tracks'),
        authFetch('/api/albums'),
        authFetch('/api/playlists'),
      ]);

      expect(res1.status).toBe(401);
      expect(res2.status).toBe(401);
      expect(res3.status).toBe(401);

      expect(logoutSpy).toHaveBeenCalledTimes(1);
      logoutSpy.mockRestore();
    });
  });

  describe('error classification and retryable status helper', () => {
    it('classifies errors correctly with classifyError', () => {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      expect(classifyError(abortErr)).toBe('abort');

      const timeoutErr = new Error('timed out');
      timeoutErr.name = 'TimeoutError';
      expect(classifyError(timeoutErr)).toBe('timeout');

      const netErr = new TypeError('Failed to fetch');
      expect(classifyError(netErr)).toBe('network');

      expect(classifyError(null, 401)).toBe('auth');
      expect(classifyError(null, 429)).toBe('transient_http');
      expect(classifyError(null, 503)).toBe('server');
      expect(classifyError(null, 404)).toBe('client');
      expect(classifyError(new Error('Unknown custom error'))).toBe('unknown');
    });

    it('accurately identifies network vs non-network errors with isNetworkError', () => {
      expect(isNetworkError(new TypeError('Network request failed'))).toBe(true);
      expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
      expect(isNetworkError(new TypeError('fetch failed'))).toBe(true);
      expect(isNetworkError(new Error('socket hang up'))).toBe(true);
      expect(isNetworkError({ code: 'ECONNRESET' })).toBe(true);

      expect(isNetworkError(new Error('Arbitrary error'))).toBe(false);
      expect(isNetworkError(new ReferenceError('x is not defined'))).toBe(false);
      expect(isNetworkError(new TypeError('Cannot read properties of undefined'))).toBe(false);
      expect(isNetworkError(null)).toBe(false);
    });

    it('correctly identifies retryable HTTP status codes', () => {
      expect(isRetryableStatus(408)).toBe(true);
      expect(isRetryableStatus(429)).toBe(true);
      expect(isRetryableStatus(500)).toBe(true);
      expect(isRetryableStatus(502)).toBe(true);
      expect(isRetryableStatus(503)).toBe(true);
      expect(isRetryableStatus(504)).toBe(true);

      expect(isRetryableStatus(200)).toBe(false);
      expect(isRetryableStatus(400)).toBe(false);
      expect(isRetryableStatus(401)).toBe(false);
      expect(isRetryableStatus(403)).toBe(false);
      expect(isRetryableStatus(404)).toBe(false);
    });
  });
});
