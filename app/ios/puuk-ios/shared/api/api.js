import * as SecureStore from 'expo-secure-store';
import {
  closeOfflineSession, createOfflineId, getOfflineSession, jwtExpiry,
  openOfflineSession, persistOfflineActivation, revokeOfflineActivation,
} from '../../offline/session';
import { reconcileTransfers } from '../../offline';

export const DEFAULT_SERVER_URL =
  process.env.EXPO_PUBLIC_API_URL || 'https://web.puuk.fun';
export let SERVER_URL = DEFAULT_SERVER_URL;

let authSessionGeneration = 0;
const sessionListeners = new Set();
export const addSessionListener = (listener) => {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
};
const advanceSession = (reason) => {
  authSessionGeneration += 1;
  closeOfflineSession();
  // Revoke byte access synchronously, before any SecureStore await/auth gate.
  for (const listener of sessionListeners) {
    try { listener(reason); } catch { /* one listener cannot defer revocation */ }
  }
};
export const getAuthSessionGeneration = () => authSessionGeneration;

export const setServerUrl = (url, { bootstrap = false } = {}) => {
  if (typeof url !== 'string' || !url) return;
  const trimmed = url.trim().replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(trimmed); } catch { return; }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== trimmed || parsed.username || parsed.password || /[\\\x00-\x20?#]/.test(trimmed)) return;
  if (trimmed !== SERVER_URL) {
    SERVER_URL = trimmed;
    if (!bootstrap || cachedToken || cachedUser) {
      clearAuth('server').catch(() => console.warn('[Auth] Failed to persist server change'));
    } else {
      advanceSession('server');
    }
  }
};
const TOKEN_KEY = 'puuk_auth_token';
const USER_KEY = 'puuk_auth_user';
const SESSION_KEY = 'puuk_auth_session_v1';
const REVOKED = '{"revoked":true}';
let authWrites = Promise.resolve();
let envelope;

function writeAuth(action) {
  const pending = authWrites.then(action);
  authWrites = pending.catch(() => {});
  return pending;
}

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

export const getAuthToken = async () => cachedToken;

export const setAuthToken = async (token) => {
  if (token !== cachedToken) {
    advanceSession('token');
  }
  cachedToken = token;
  try {
    if (token) {
      await SecureStore.setItemAsync(TOKEN_KEY, token, SECURE_STORE_OPTIONS);
    } else {
      await SecureStore.deleteItemAsync(TOKEN_KEY, SECURE_STORE_OPTIONS);
    }
  } catch (e) {
    console.warn('[SecureStore write error]');
  }
};

export const getSavedUser = async () => cachedUser;

export const setSavedUser = async (user) => {
  if (cachedUser?.id != null && String(cachedUser.id) !== String(user?.id)) advanceSession('account');
  cachedUser = user;
  try {
    if (user) {
      await SecureStore.setItemAsync(
        USER_KEY,
        JSON.stringify(user),
        SECURE_STORE_OPTIONS,
      );
    } else {
      await SecureStore.deleteItemAsync(USER_KEY, SECURE_STORE_OPTIONS);
    }
  } catch (e) {
    console.warn('[SecureStore user write error]');
  }
  notifyAuthChange(user);
};

function clearAuth(reason) {
  const previous = closeOfflineSession();
  const needsDurableRevoke = Boolean(envelope || previous);
  envelope = null;
  cachedToken = null;
  advanceSession(reason);
  notifyAuthChange(null);
  return writeAuth(async () => {
    const results = await Promise.allSettled([
      SecureStore.setItemAsync(SESSION_KEY, REVOKED, SECURE_STORE_OPTIONS),
      needsDurableRevoke ? revokeOfflineActivation(previous) : Promise.resolve(),
    ]);
    await Promise.all([
      SecureStore.deleteItemAsync(TOKEN_KEY, SECURE_STORE_OPTIONS),
      SecureStore.deleteItemAsync(USER_KEY, SECURE_STORE_OPTIONS),
    ]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
}

export const logout = () => clearAuth('logout');

const authChanged = () => new ApiError('Session changed', { type: 'abort' });

function activateEnvelope(saved, generation) {
  const session = { owner: saved.owner, activationId: saved.activationId, generation };
  const current = () => generation === authSessionGeneration && saved.owner.origin === SERVER_URL;
  return openOfflineSession(session, jwtExpiry(saved.token, saved.owner.userId), current, () => {
    if (current()) clearAuth('expired').catch(() => console.warn('[Auth] Failed to persist expiration'));
  });
}

function confirmSession(token, user, generation, origin, newLogin = false) {
  if (generation !== authSessionGeneration || origin !== SERVER_URL) throw authChanged();
  const userId = user?.id == null ? null : String(user.id);
  if (jwtExpiry(token, userId) <= Date.now()) throw new ApiError('Invalid session', { type: 'auth' });
  const active = getOfflineSession();
  const reuse = !newLogin && active?.owner.userId === userId && active.owner.origin === origin;
  if (!reuse) {
    cachedToken = null;
    advanceSession(newLogin ? 'login' : 'account');
    generation = authSessionGeneration;
    notifyAuthChange(null);
  }
  const saved = {
    owner: { origin, userId }, token, user,
    activationId: reuse ? active.activationId : createOfflineId(),
    confirmedAt: Date.now(),
  };
  return writeAuth(async () => {
    const check = () => {
      if (generation !== authSessionGeneration || origin !== SERVER_URL) throw authChanged();
    };
    check();
    if (!reuse) await persistOfflineActivation(saved);
    check();
    await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(saved), SECURE_STORE_OPTIONS);
    check();
    if (!reuse && !await activateEnvelope(saved, generation)) throw authChanged();
    check();
    envelope = saved;
    cachedToken = token;
    notifyAuthChange(user);
    check();
    return user;
  });
}

export const authHandlers = {
  logout: () => logout(),
};

const AUTH_EXEMPT_PATHS = [
  '/api/auth/login',
  '/api/auth/verify-code',
  '/api/auth/me',
];
let unauthorizedPromise = null;

const handleUnauthorized = async (url, generation, token) => {
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  const isAuthPath = AUTH_EXEMPT_PATHS.some((p) => path.startsWith(p));
  if (isAuthPath) return;

  if (unauthorizedPromise) {
    await unauthorizedPromise;
    return;
  }

  if (!token || token !== cachedToken || generation !== authSessionGeneration) return;

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
  constructor(
    message,
    {
      type = 'unknown',
      status = null,
      code = null,
      cause = null,
      endpoint = null,
    } = {},
  ) {
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
  return (
    status === 408 ||
    status === 429 ||
    (typeof status === 'number' && status >= 500 && status <= 599)
  );
};

export const isNetworkError = (err) => {
  if (!err) return false;
  if (err.name === 'NetworkError' || err.isNetwork || err.type === 'network')
    return true;

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

  if (
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused')
  ) {
    return true;
  }

  return false;
};

export const classifyError = (error, status = null) => {
  if (error?.name === 'AbortError' || error?.type === 'abort') {
    return 'abort';
  }
  if (
    error?.name === 'TimeoutError' ||
    error?.isTimeout ||
    error?.type === 'timeout'
  ) {
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

const delayWithSignal = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (ms <= 0) {
      if (signal?.aborted) {
        const err =
          signal.reason instanceof Error
            ? signal.reason
            : new Error('The operation was aborted');
        err.name = 'AbortError';
        return reject(err);
      }
      return resolve();
    }
    if (signal?.aborted) {
      const err =
        signal.reason instanceof Error
          ? signal.reason
          : new Error('The operation was aborted');
      err.name = 'AbortError';
      return reject(err);
    }
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const err =
        signal.reason instanceof Error
          ? signal.reason
          : new Error('The operation was aborted');
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
  const url = endpoint.startsWith('http')
    ? endpoint
    : `${SERVER_URL}${endpoint}`;
  const generation = authSessionGeneration;
  const server = SERVER_URL;
  const parsed = new URL(url);
  if (parsed.origin !== new URL(server).origin || parsed.username || parsed.password || /[\\\x00-\x20]/.test(url)) {
    throw new ApiError('Invalid API destination', { type: 'client' });
  }
  const assertSession = () => {
    if (generation !== authSessionGeneration || server !== SERVER_URL) {
      throw new ApiError('Session changed', { type: 'abort' });
    }
  };
  const method = (options.method || 'GET').toUpperCase();
  const isMutation = ['POST', 'PATCH', 'DELETE', 'PUT'].includes(method);

  const defaultTimeout = isMutation ? 10000 : 10000;
  const timeoutMs =
    typeof options.timeout === 'number'
      ? Math.max(0, options.timeout)
      : defaultTimeout;

  let maxRetries;
  if (typeof options.retry === 'number') {
    maxRetries = Math.max(0, options.retry);
  } else if (typeof options.retries === 'number') {
    maxRetries = Math.max(0, options.retries);
  } else {
    maxRetries = method === 'GET' || method === 'HEAD' ? 2 : 0;
  }

  const retryDelayMs =
    typeof options.retryDelay === 'number'
      ? Math.max(0, options.retryDelay)
      : 100;

  const isFormData =
    typeof FormData !== 'undefined' && options.body instanceof FormData;
  const isObjectBody =
    options.body && typeof options.body === 'object' && !isFormData;
  const body = isObjectBody ? JSON.stringify(options.body) : options.body;

  const token = await getAuthToken();
  assertSession();

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
    assertSession();
    if (externalSignal?.aborted) {
      const abortErr =
        externalSignal.reason instanceof Error
          ? externalSignal.reason
          : new ApiError(
              externalSignal.reason
                ? String(externalSignal.reason)
                : 'The operation was aborted',
              {
                type: 'abort',
                endpoint: url,
              },
            );
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    const attemptController = new AbortController();
    let isTimedOut = false;
    let timeoutId = null;

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        isTimedOut = true;
        attemptController.abort(
          new Error(`Request timed out after ${timeoutMs}ms`),
        );
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
        redirect: 'error',
        credentials: 'omit',
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

    assertSession();
    if (externalSignal?.aborted) {
      const abortErr =
        externalSignal.reason instanceof Error
          ? externalSignal.reason
          : new ApiError(
              externalSignal.reason
                ? String(externalSignal.reason)
                : 'The operation was aborted',
              {
                type: 'abort',
                cause: fetchError,
                endpoint: url,
              },
            );
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
        lastError = new ApiError(
          fetchError?.message || 'Network request failed',
          {
            type: 'network',
            cause: fetchError,
            endpoint: url,
          },
        );
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
        await handleUnauthorized(url, generation, token);
      } catch (authErr) {
        console.error(
          '[Auth] Error during unauthorized handling/logout:',
          authErr,
        );
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

export const parseApiErrorMessage = (
  errData,
  fallback = 'An error occurred',
) => {
  if (!errData) return fallback;
  if (typeof errData === 'string') return errData;
  if (typeof errData.detail === 'string') return errData.detail;
  if (Array.isArray(errData.detail)) {
    const msgs = errData.detail
      .map((d) => {
        if (!d) return '';
        if (typeof d === 'string') return d;
        if (typeof d === 'object')
          return d.msg || d.message || JSON.stringify(d);
        return String(d);
      })
      .filter(Boolean);
    if (msgs.length > 0) return msgs.join('\n');
  }
  if (errData.detail && typeof errData.detail === 'object') {
    return (
      errData.detail.msg ||
      errData.detail.message ||
      JSON.stringify(errData.detail)
    );
  }
  if (typeof errData.message === 'string') return errData.message;
  return fallback;
};

async function login(endpoint, body, fallbackMessage) {
  const generation = authSessionGeneration;
  const origin = SERVER_URL;
  const res = await fetch(`${origin}${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), redirect: 'error', credentials: 'omit',
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(parseApiErrorMessage(errData, fallbackMessage));
  }
  const data = await res.json();
  return confirmSession(data.access_token, data.user, generation, origin, true);
}

export const loginWithPassword = (username, password) =>
  login('/api/auth/login', { username, password }, 'Authentication error');

export const loginWithCode = (code) =>
  login('/api/auth/verify-code', { code: code.trim() }, 'Invalid or expired code');

export const restoreLocalSession = async () => {
  const generation = authSessionGeneration;
  const origin = SERVER_URL;
  const empty = { token: null, user: null, hasToken: false, hasUser: false };
  await authWrites;
  if (generation !== authSessionGeneration || origin !== SERVER_URL) return empty;
  const raw = await SecureStore.getItemAsync(SESSION_KEY, SECURE_STORE_OPTIONS);
  if (generation !== authSessionGeneration || origin !== SERVER_URL) return empty;
  if (!raw) {
    // Upgrade: the legacy token can verify online, but its saved profile has no owner binding.
    const token = await SecureStore.getItemAsync(TOKEN_KEY, SECURE_STORE_OPTIONS);
    if (!token || generation !== authSessionGeneration) return empty;
    cachedToken = token;
    return { token, user: null, hasToken: true, hasUser: false };
  }

  const saved = JSON.parse(raw);
  if (saved.owner?.origin !== origin || String(saved.user?.id) !== saved.owner.userId) return empty;
  if (jwtExpiry(saved.token, saved.owner.userId) <= Date.now()) {
    envelope = saved;
    await clearAuth('expired');
    return empty;
  }
  if (!await activateEnvelope(saved, generation)) return empty;
  if (generation !== authSessionGeneration) return empty;
  envelope = saved;
  cachedToken = saved.token;
  notifyAuthChange(saved.user);
  const session = getOfflineSession();
  await reconcileTransfers(session, { foregroundOnly: true }).catch(() => {});
  return generation === authSessionGeneration
    ? { token: saved.token, user: saved.user, hasToken: true, hasUser: true } : empty;
};

export const verifySession = async (options = {}) => {
  const currentGen = authSessionGeneration;
  const origin = SERVER_URL;
  const token = cachedToken || (await getAuthToken());
  if (!token) {
    return {
      success: false,
      status: null,
      isAuth: false,
      error: new Error('No auth token'),
    };
  }

  try {
    const res = await authFetch('/api/auth/me', {
      signal: options.signal,
      timeout: options.timeout || 10000,
      retry: 0,
    });

    if (authSessionGeneration !== currentGen || cachedToken !== token) {
      return { success: false, aborted: true };
    }

    if (res.ok) {
      const freshUser = await res.json();
      if (authSessionGeneration !== currentGen || cachedToken !== token) {
        return { success: false, aborted: true };
      }
      await confirmSession(token, freshUser, currentGen, origin);
      return { success: true, user: freshUser, status: res.status };
    }

    if (res.status === 401) {
      console.warn(
        '[verifySession] Сессия отклонена сервером (401), сбрасываем авторизацию.',
      );
      await logout();
      return {
        success: false,
        status: 401,
        isAuth: true,
        error: new Error('Unauthorized'),
      };
    }

    const isServer = res.status >= 500 && res.status <= 599;
    return {
      success: false,
      status: res.status,
      isServer,
      isNetwork: false,
      error: new Error(`HTTP ${res.status}`),
    };
  } catch (err) {
    if (authSessionGeneration !== currentGen || cachedToken !== token) {
      return { success: false, aborted: true };
    }
    if (err?.name === 'AbortError') {
      return { success: false, aborted: true, error: err };
    }
    const isNet = isNetworkError(err);
    const isTime = err?.name === 'TimeoutError' || err?.isTimeout;
    return {
      success: false,
      status: err?.status || null,
      isNetwork: isNet || isTime,
      isTimeout: isTime,
      isServer: Boolean(err?.status >= 500 && err?.status <= 599),
      error: err,
    };
  }
};

export const checkAuth = async () => {
  try {
    const local = await restoreLocalSession();
    if (!local.hasToken) {
      return null;
    }

    if (local.hasUser) {
      notifyAuthChange(local.user);
    }

    const verified = await verifySession();
    if (verified.success) {
      return verified.user;
    }

    if (verified.status === 401) {
      return null;
    }

    return local.user || null;
  } catch (e) {
    console.warn('[checkAuth network error, preserving session]', e);
    return getOfflineSession() ? cachedUser : null;
  }
};
