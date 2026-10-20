import * as SecureStore from 'expo-secure-store';

export const DEFAULT_SERVER_URL = process.env.EXPO_PUBLIC_API_URL || 'https://web.puuk.fun';
export let SERVER_URL = DEFAULT_SERVER_URL;

export const setServerUrl = (url) => {
  if (url && typeof url === 'string') {
    SERVER_URL = url.trim().replace(/\/+$/, '');
  }
};
const TOKEN_KEY = 'puuk_auth_token';
const USER_KEY = 'puuk_auth_user';

const SECURE_STORE_OPTIONS = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

let cachedToken = null;
let cachedUser = null;
const authListeners = new Set();

export const notifyAuthChange = (user) => {
  cachedUser = user;
  authListeners.forEach((cb) => {
    try {
      cb(user);
    } catch (e) {
      console.error('[AuthListener error]', e);
    }
  });
};

export const addAuthListener = (callback) => {
  authListeners.add(callback);
  return () => authListeners.delete(callback);
};

export const getCachedAuthToken = () => cachedToken;

export const getCachedAuthHeaders = () => {
  return cachedToken ? { Authorization: `Bearer ${cachedToken}` } : null;
};

export const getCachedUser = () => cachedUser;

export const getAuthToken = async () => {
  if (cachedToken) return cachedToken;
  try {
    const token = await SecureStore.getItemAsync(TOKEN_KEY, SECURE_STORE_OPTIONS);
    if (token) {
      cachedToken = token;
      return token;
    }
  } catch (e) {
    console.warn('[SecureStore read error]', e);
  }
  return null;
};

export const setAuthToken = async (token) => {
  cachedToken = token;
  try {
    if (token) {
      await SecureStore.setItemAsync(TOKEN_KEY, token, SECURE_STORE_OPTIONS);
    } else {
      await SecureStore.deleteItemAsync(TOKEN_KEY, SECURE_STORE_OPTIONS);
    }
  } catch (e) {
    console.warn('[SecureStore write error]', e);
  }
};

export const getSavedUser = async () => {
  if (cachedUser) return cachedUser;
  try {
    const raw = await SecureStore.getItemAsync(USER_KEY, SECURE_STORE_OPTIONS);
    if (raw) {
      cachedUser = JSON.parse(raw);
      return cachedUser;
    }
  } catch (e) {
    console.warn('[SecureStore user read error]', e);
  }
  return null;
};

export const setSavedUser = async (user) => {
  cachedUser = user;
  try {
    if (user) {
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user), SECURE_STORE_OPTIONS);
    } else {
      await SecureStore.deleteItemAsync(USER_KEY, SECURE_STORE_OPTIONS);
    }
  } catch (e) {
    console.warn('[SecureStore user write error]', e);
  }
  notifyAuthChange(user);
};

export const logout = async () => {
  await setAuthToken(null);
  await setSavedUser(null);
};

export const authHandlers = {
  logout: () => logout(),
};

const AUTH_EXEMPT_PATHS = ['/api/auth/login', '/api/auth/verify-code', '/api/auth/me'];
let unauthorizedPromise = null;

const handleUnauthorized = async (url) => {
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  const isAuthPath = AUTH_EXEMPT_PATHS.some((p) => path.startsWith(p));
  if (isAuthPath) return;

  if (unauthorizedPromise) {
    await unauthorizedPromise;
    return;
  }

  // If session is already cleared, do not repeat logout
  const token = cachedToken || (await getAuthToken());
  if (!token) return;

  console.warn('[Auth] 401 — сбрасываем авторизацию.');
  unauthorizedPromise = (async () => {
    try {
      await authHandlers.logout();
    } finally {
      unauthorizedPromise = null;
    }
  })();

  await unauthorizedPromise;
};

// Заголовки для медиа-запросов (обложки/аудио) — без токена в URL.
export const getAuthHeaders = async () => {
  const token = await getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export class ApiError extends Error {
  constructor(message, { type = 'unknown', status = null, code = null, cause = null, endpoint = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.type = type;
    this.status = status;
    this.code = code;
    this.cause = cause;
    this.endpoint = endpoint;
    this.isTimeout = type === 'timeout';
    this.isNetwork = type === 'network';
    this.isAbort = type === 'abort';
    this.isAuth = type === 'auth' || status === 401;
  }
}

export const isRetryableStatus = (status) => {
  return status === 408 || status === 429 || (typeof status === 'number' && status >= 500 && status <= 599);
};

export const isNetworkError = (err) => {
  if (!err) return false;
  if (err.name === 'NetworkError' || err.isNetwork || err.type === 'network') return true;

  const msg = (err.message || '').toLowerCase();
  const code = (err.code || '').toUpperCase();

  // Standard fetch rejection messages across environments (RN, browsers, Node/undici)
  if (
    msg.includes('network request failed') ||
    msg.includes('failed to fetch') ||
    msg.includes('fetch failed') ||
    msg.includes('network error') ||
    msg.includes('network connection lost') ||
    msg.includes('the internet connection appears to be offline') ||
    msg.includes('load failed')
  ) {
    return true;
  }

  // Common socket / network codes
  const networkCodes = [
    'ECONNRESET',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
  ];
  if (networkCodes.includes(code)) {
    return true;
  }

  if (msg.includes('socket hang up') || msg.includes('econnreset') || msg.includes('econnrefused')) {
    return true;
  }

  return false;
};

export const classifyError = (error, status = null) => {
  if (error?.name === 'AbortError' || error?.type === 'abort') {
    return 'abort';
  }
  if (error?.name === 'TimeoutError' || error?.isTimeout || error?.type === 'timeout') {
    return 'timeout';
  }
  if (status === 401) {
    return 'auth';
  }
  if (status === 408 || status === 429) {
    return 'transient_http';
  }
  if (typeof status === 'number' && status >= 500 && status <= 599) {
    return 'server';
  }
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return 'client';
  }
  if (isNetworkError(error)) {
    return 'network';
  }
  return 'unknown';
};

const delayWithSignal = (ms, signal) => new Promise((resolve, reject) => {
  if (ms <= 0) {
    if (signal?.aborted) {
      const err = signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted');
      err.name = 'AbortError';
      return reject(err);
    }
    return resolve();
  }
  if (signal?.aborted) {
    const err = signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted');
    err.name = 'AbortError';
    return reject(err);
  }
  let timer = null;
  const onAbort = () => {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    const err = signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted');
    err.name = 'AbortError';
    reject(err);
  };
  timer = setTimeout(() => {
    if (signal) signal.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }
});

export const authFetch = async (endpoint, options = {}) => {
  const url = endpoint.startsWith('http') ? endpoint : `${SERVER_URL}${endpoint}`;
  const method = (options.method || 'GET').toUpperCase();
  const isMutation = ['POST', 'PATCH', 'DELETE', 'PUT'].includes(method);

  const defaultTimeout = isMutation ? 10000 : 10000;
  const timeoutMs = typeof options.timeout === 'number' ? Math.max(0, options.timeout) : defaultTimeout;

  let maxRetries;
  if (typeof options.retry === 'number') {
    maxRetries = Math.max(0, options.retry);
  } else if (typeof options.retries === 'number') {
    maxRetries = Math.max(0, options.retries);
  } else {
    maxRetries = (method === 'GET' || method === 'HEAD') ? 2 : 0;
  }

  const retryDelayMs = typeof options.retryDelay === 'number' ? Math.max(0, options.retryDelay) : 100;

  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const isObjectBody = options.body && typeof options.body === 'object' && !isFormData;
  const body = isObjectBody ? JSON.stringify(options.body) : options.body;

  const token = await getAuthToken();

  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };

  if (isObjectBody && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  if (token && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const {
    retry: _retry,
    retries: _retries,
    retryDelay: _retryDelay,
    timeout: _timeout,
    background: _background,
    headers: _h,
    body: _b,
    signal: externalSignal,
    ...fetchRest
  } = options;

  let lastError = null;
  let lastResponse = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (externalSignal?.aborted) {
      const abortErr = (externalSignal.reason instanceof Error)
        ? externalSignal.reason
        : new ApiError(externalSignal.reason ? String(externalSignal.reason) : 'The operation was aborted', {
            type: 'abort',
            endpoint: url,
          });
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    const attemptController = new AbortController();
    let isTimedOut = false;
    let timeoutId = null;

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        isTimedOut = true;
        attemptController.abort(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    let onExternalAbort = null;
    if (externalSignal) {
      onExternalAbort = () => {
        attemptController.abort(externalSignal.reason);
      };
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let response = null;
    let fetchError = null;

    try {
      response = await fetch(url, {
        ...fetchRest,
        method,
        headers,
        body,
        signal: attemptController.signal,
      });
    } catch (err) {
      fetchError = err;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }

    if (externalSignal?.aborted) {
      const abortErr = (externalSignal.reason instanceof Error)
        ? externalSignal.reason
        : new ApiError(externalSignal.reason ? String(externalSignal.reason) : 'The operation was aborted', {
            type: 'abort',
            cause: fetchError,
            endpoint: url,
          });
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    if (fetchError) {
      if (isTimedOut) {
        lastError = new ApiError(`Request timed out after ${timeoutMs}ms`, {
          type: 'timeout',
          cause: fetchError,
          endpoint: url,
        });
        lastError.name = 'TimeoutError';
      } else if (isNetworkError(fetchError)) {
        lastError = new ApiError(fetchError?.message || 'Network request failed', {
          type: 'network',
          cause: fetchError,
          endpoint: url,
        });
        lastError.name = 'NetworkError';
      } else {
        // Arbitrary / runtime error (not network or timeout): DO NOT RETRY!
        throw fetchError;
      }

      if (attempt < maxRetries) {
        await delayWithSignal(retryDelayMs, externalSignal);
        continue;
      }

      throw lastError;
    }

    if (isRetryableStatus(response.status)) {
      lastResponse = response;
      if (attempt < maxRetries) {
        await delayWithSignal(retryDelayMs, externalSignal);
        continue;
      }
      return response;
    }

    if (response.status === 401) {
      try {
        await handleUnauthorized(url);
      } catch (authErr) {
        console.error('[Auth] Error during unauthorized handling/logout:', authErr);
      }
      return response;
    }

    return response;
  }

  if (lastResponse) {
    return lastResponse;
  }
  if (lastError) {
    throw lastError;
  }
};

export const parseApiErrorMessage = (errData, fallback = 'An error occurred') => {
  if (!errData) return fallback;
  if (typeof errData === 'string') return errData;
  if (typeof errData.detail === 'string') return errData.detail;
  if (Array.isArray(errData.detail)) {
    const msgs = errData.detail
      .map((d) => {
        if (!d) return '';
        if (typeof d === 'string') return d;
        if (typeof d === 'object') return d.msg || d.message || JSON.stringify(d);
        return String(d);
      })
      .filter(Boolean);
    if (msgs.length > 0) return msgs.join('\n');
  }
  if (errData.detail && typeof errData.detail === 'object') {
    return errData.detail.msg || errData.detail.message || JSON.stringify(errData.detail);
  }
  if (typeof errData.message === 'string') return errData.message;
  return fallback;
};

export const loginWithPassword = async (username, password) => {
  const res = await fetch(`${SERVER_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(parseApiErrorMessage(errData, 'Authentication error'));
  }

  const data = await res.json();
  await setAuthToken(data.access_token);
  await setSavedUser(data.user);
  return data.user;
};

export const loginWithCode = async (code) => {
  const res = await fetch(`${SERVER_URL}/api/auth/verify-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code.trim() }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(parseApiErrorMessage(errData, 'Invalid or expired code'));
  }

  const data = await res.json();
  await setAuthToken(data.access_token);
  await setSavedUser(data.user);
  return data.user;
};

export const checkAuth = async () => {
  try {
    const token = await getAuthToken();
    if (!token) {
      return null;
    }

    const savedUser = await getSavedUser();
    if (savedUser) {
      notifyAuthChange(savedUser);
    }

    const res = await authFetch('/api/auth/me');
    if (res.ok) {
      const freshUser = await res.json();
      await setSavedUser(freshUser);
      return freshUser;
    }

    if (res.status === 401) {
      console.warn('[checkAuth] Сессия отклонена сервером (401), сбрасываем авторизацию.');
      await logout();
      return null;
    }

    console.warn(`[checkAuth] Сервер ответил статусом ${res.status}, сохраняем существующую сессию.`);
    return savedUser || null;
  } catch (e) {
    console.warn('[checkAuth network error, preserving session]', e);
    const savedUser = await getSavedUser();
    return savedUser || null;
  }
};
