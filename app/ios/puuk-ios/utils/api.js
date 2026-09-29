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

const AUTH_EXEMPT_PATHS = ['/api/auth/login', '/api/auth/verify-code', '/api/auth/me'];
let isHandlingUnauthorized = false;

// Заголовки для медиа-запросов (обложки/аудио) — без токена в URL.
export const getAuthHeaders = async () => {
  const token = await getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const authFetch = async (endpoint, options = {}) => {
  const url = endpoint.startsWith('http') ? endpoint : `${SERVER_URL}${endpoint}`;
  const token = await getAuthToken();

  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    // Закрытый режим: сессия невалидна — сбрасываем авторизацию всегда.
    // Исключение — сами auth-эндпоинты (401 там означает неверные креды).
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const isAuthPath = AUTH_EXEMPT_PATHS.some((p) => path.startsWith(p));
    if (!isAuthPath && !isHandlingUnauthorized) {
      isHandlingUnauthorized = true;
      console.warn('[Auth] 401 — сбрасываем авторизацию.');
      try {
        await logout();
      } finally {
        isHandlingUnauthorized = false;
      }
    }
  }

  return response;
};

export const loginWithPassword = async (username, password) => {
  const res = await fetch(`${SERVER_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.detail || 'Authentication error');
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
    throw new Error(errData.detail || 'Invalid or expired code');
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

export const logout = async () => {
  await setAuthToken(null);
  await setSavedUser(null);
};
