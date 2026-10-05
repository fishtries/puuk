/**
 * Persistent API & Catalog cache using expo-file-system and in-memory cache.
 * Implements stale-while-revalidate, per-user and per-server isolation,
 * concurrency deduplication, and atomic file persistence.
 */

import { File, Directory, Paths } from 'expo-file-system';
import { authFetch, SERVER_URL, getSavedUser, addAuthListener } from './api';

if (typeof addAuthListener === 'function') {
  addAuthListener((user) => {
    if (!user) {
      clearCatalogCache().catch(() => {});
    }
  });
}

export const CATALOG_CACHE_DIR_NAME = 'catalog-cache';
export const CATALOG_CACHE_VERSION = 1;

export const DEFAULT_TTL_MS = {
  tracks: 60 * 1000, // 60 seconds
  albums: 5 * 60 * 1000, // 5 minutes
  playlists: 60 * 1000, // 60 seconds
  favorites: 30 * 1000, // 30 seconds
  history: 30 * 1000, // 30 seconds
  search: 15 * 1000, // 15 seconds
  lyrics: 10 * 60 * 1000, // 10 minutes
};

// In-memory hot storage and synchronization primitives
const memoryCache = new Map(); // cacheKey => { version, savedAt, serverUrl, userId, data }
const inFlightRequests = new Map(); // cacheKey => Promise
const inFlightAbortControllers = new Map(); // cacheKey => AbortController
const requestEpochs = new Map(); // cacheKey => number
const userClearGenerations = new Map(); // userId => number
let globalEpochCounter = 0;
let cacheClearGeneration = 0;

/**
 * Нормализует serverUrl: убирает пробелы, trailing slashes, приводит к lower-case.
 * @param {string} url
 * @returns {string}
 */
export const normalizeServerUrl = (url) => {
  if (!url || typeof url !== 'string') return '';
  return url.trim().toLowerCase().replace(/\/+$/, '');
};

/**
 * Детерминированный 53-битный хэш (cyrb53) строки без внешних зависимостей.
 * @param {string} str
 * @param {number} seed
 * @returns {string} Hex-строка фиксированной длины
 */
export const hashString = (str, seed = 0) => {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return combined.toString(16).padStart(14, '0');
};

const sanitizeForFilename = (str) => {
  return String(str || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 100);
};

export const getCacheKey = (key, serverUrl, userId) => {
  const normServer = normalizeServerUrl(serverUrl || SERVER_URL || 'default_server');
  const serverHash = hashString(normServer);
  const serverHash2 = hashString(normServer, 1337);
  const safeServerPrefix = sanitizeForFilename(normServer).slice(0, 30);
  const safeServer = `${safeServerPrefix}_${serverHash}_${serverHash2}`;
  const safeUser = userId !== undefined && userId !== null ? `user_${String(userId).trim()}` : 'anon';
  const safeKey = sanitizeForFilename(key);
  return `puuk_cache__${safeServer}__${safeUser}__${safeKey}`;
};

let cacheDirectoryInstance = null;

export const getCacheDirectory = () => {
  if (!cacheDirectoryInstance) {
    const baseDir = (Paths && (Paths.document || Paths.cache)) || 'file://documents';
    cacheDirectoryInstance = new Directory(baseDir, CATALOG_CACHE_DIR_NAME);
  }
  return cacheDirectoryInstance;
};

const ensureCacheDir = () => {
  const dir = getCacheDirectory();
  try {
    if (!dir.exists) {
      dir.create({ intermediates: true });
    }
  } catch (err) {
    if (!(err instanceof Error && err.message.includes('already exists'))) {
      console.warn('[apiCache] Failed to create cache directory:', err);
    }
  }
  return dir;
};

export const getCacheFile = (cacheKey) => {
  const dir = ensureCacheDir();
  return new File(dir, `${cacheKey}.json`);
};

export const resetMemoryCache = () => {
  for (const controller of Array.from(inFlightAbortControllers.values())) {
    try {
      controller.abort();
    } catch {}
  }
  inFlightAbortControllers.clear();
  memoryCache.clear();
  inFlightRequests.clear();
  requestEpochs.clear();
  userClearGenerations.clear();
  cacheClearGeneration = 0;
  globalEpochCounter = 0;
};

/**
 * Читает кэшированную запись каталога.
 * @param {string} key
 * @param {object} options
 * @returns {Promise<{ version: number, savedAt: number, serverUrl: string, userId: any, data: any, isStale: boolean } | null>}
 */
export const getCachedCatalog = async (key, options = {}) => {
  const serverUrl = normalizeServerUrl(options.serverUrl || SERVER_URL || '');
  let userId = options.userId;
  if (userId === undefined) {
    const saved = await getSavedUser().catch(() => null);
    userId = saved?.id ?? null;
  }

  const cacheKey = getCacheKey(key, serverUrl, userId);
  const ttlMs =
    typeof options.ttlMs === 'number'
      ? options.ttlMs
      : DEFAULT_TTL_MS[key] || 60 * 1000;

  // 1. Hot lookup in memory cache
  const memEntry = memoryCache.get(cacheKey);
  if (memEntry) {
    const isStale = Date.now() - memEntry.savedAt > ttlMs;
    return {
      ...memEntry,
      isStale,
    };
  }

  // 2. Persistent lookup from filesystem
  try {
    const file = getCacheFile(cacheKey);
    let exists = false;
    try {
      exists = Boolean(file.exists);
    } catch {
      exists = false;
    }

    if (!exists) {
      return null;
    }

    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseErr) {
      console.warn(`[apiCache] Corrupted JSON in cache file for ${key}, deleting:`, parseErr?.message);
      try {
        file.delete();
      } catch {}
      return null;
    }

    // Validate structure and namespace isolation
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== CATALOG_CACHE_VERSION ||
      typeof parsed.savedAt !== 'number' ||
      normalizeServerUrl(parsed.serverUrl) !== serverUrl ||
      String(parsed.userId) !== String(userId) ||
      parsed.data === undefined
    ) {
      try {
        file.delete();
      } catch {}
      return null;
    }

    memoryCache.set(cacheKey, parsed);
    const isStale = Date.now() - parsed.savedAt > ttlMs;
    return {
      ...parsed,
      isStale,
    };
  } catch (err) {
    console.warn(`[apiCache] Error reading cache for ${key}:`, err?.message);
    return null;
  }
};

/**
 * Сохраняет данные каталога в кэш.
 * @param {string} key
 * @param {any} data
 * @param {object} options
 */
export const setCachedCatalog = async (key, data, options = {}) => {
  const serverUrl = normalizeServerUrl(options.serverUrl || SERVER_URL || '');
  let userId = options.userId;
  if (userId === undefined) {
    const saved = await getSavedUser().catch(() => null);
    userId = saved?.id ?? null;
  }

  const userKeyStr = userId !== undefined && userId !== null ? String(userId).trim() : null;
  const startGlobalGen = typeof options.expectedClearGeneration === 'number'
    ? options.expectedClearGeneration
    : cacheClearGeneration;
  const startUserGen = typeof options.expectedUserClearGeneration === 'number'
    ? options.expectedUserClearGeneration
    : (userKeyStr ? (userClearGenerations.get(userKeyStr) || 0) : 0);

  const isInvalidated = () => {
    if (options.signal?.aborted) return true;
    if (cacheClearGeneration !== startGlobalGen) return true;
    if (userKeyStr && (userClearGenerations.get(userKeyStr) || 0) !== startUserGen) return true;
    return false;
  };

  if (isInvalidated()) {
    return null;
  }

  const cacheKey = getCacheKey(key, serverUrl, userId);
  const entry = {
    version: CATALOG_CACHE_VERSION,
    savedAt: typeof options.savedAt === 'number' ? options.savedAt : Date.now(),
    serverUrl,
    userId,
    data,
  };

  try {
    ensureCacheDir();
    const targetFile = getCacheFile(cacheKey);
    const tempFileName = `${cacheKey}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    const tempFile = new File(getCacheDirectory(), tempFileName);

    const jsonStr = JSON.stringify(entry);
    tempFile.write(jsonStr);

    // Проверяем актуальность перед перемещением файла в целевой
    if (isInvalidated()) {
      try {
        tempFile.delete();
      } catch {}
      return null;
    }

    try {
      if (typeof tempFile.move === 'function') {
        await tempFile.move(targetFile);
      } else {
        targetFile.write(jsonStr);
        try {
          tempFile.delete();
        } catch {}
      }
    } catch {
      targetFile.write(jsonStr);
      try {
        tempFile.delete();
      } catch {}
    }

    // Повторно проверяем актуальность ПОСЛЕ завершения асинхронного перемещения файла
    if (isInvalidated()) {
      try {
        targetFile.delete();
      } catch {}
      memoryCache.delete(cacheKey);
      return null;
    }

    // Сохраняем в память только если запись не была инвалидирована во время дискового I/O
    memoryCache.set(cacheKey, entry);
  } catch (err) {
    console.warn(`[apiCache] Error writing cache for ${key}:`, err?.message);
    return null;
  }

  return entry;
};

/**
 * Удаляет один ключ каталога.
 * @param {string} key
 * @param {object} options
 */
export const removeCachedCatalog = async (key, options = {}) => {
  const serverUrl = normalizeServerUrl(options.serverUrl || SERVER_URL || '');
  let userId = options.userId;
  if (userId === undefined) {
    const saved = await getSavedUser().catch(() => null);
    userId = saved?.id ?? null;
  }

  const cacheKey = getCacheKey(key, serverUrl, userId);
  const controller = inFlightAbortControllers.get(cacheKey);
  if (controller) {
    try {
      controller.abort();
    } catch {}
    inFlightAbortControllers.delete(cacheKey);
  }
  memoryCache.delete(cacheKey);
  inFlightRequests.delete(cacheKey);
  requestEpochs.delete(cacheKey);

  try {
    const file = getCacheFile(cacheKey);
    if (file.exists) {
      file.delete();
    }
  } catch (err) {
    console.warn(`[apiCache] Error deleting cache file for ${key}:`, err?.message);
  }
};

/**
 * Очищает кэш каталога. При передаче userId очищает только данные указанного пользователя.
 * Гарантированно отменяет активные in-flight запросы, чтобы предотвратить запись устаревших snapshot.
 * @param {object} options
 */
export const clearCatalogCache = async (options = {}) => {
  const targetUserId = options.userId;

  if (targetUserId !== undefined && targetUserId !== null) {
    const userStr = String(targetUserId).trim();
    userClearGenerations.set(userStr, (userClearGenerations.get(userStr) || 0) + 1);

    // Delete in-memory keys for this user and abort active in-flight network requests
    const userPattern = `__user_${userStr}__`;
    for (const k of Array.from(memoryCache.keys())) {
      if (k.includes(userPattern)) memoryCache.delete(k);
    }
    for (const [k, controller] of Array.from(inFlightAbortControllers.entries())) {
      if (k.includes(userPattern)) {
        try {
          controller.abort();
        } catch {}
        inFlightAbortControllers.delete(k);
      }
    }
    for (const k of Array.from(inFlightRequests.keys())) {
      if (k.includes(userPattern)) inFlightRequests.delete(k);
    }
    for (const k of Array.from(requestEpochs.keys())) {
      if (k.includes(userPattern)) requestEpochs.delete(k);
    }

    try {
      const dir = getCacheDirectory();
      if (dir.exists && typeof dir.list === 'function') {
        const files = dir.list();
        for (const f of files) {
          if (f.name && f.name.includes(userPattern)) {
            try {
              f.delete();
            } catch {}
          }
        }
      }
    } catch (err) {
      console.warn('[apiCache] Error clearing user cache:', err?.message);
    }
    return;
  }

  // Full clear: bump generation, abort all in-flight requests and wipe everything
  cacheClearGeneration += 1;
  userClearGenerations.clear();
  for (const controller of Array.from(inFlightAbortControllers.values())) {
    try {
      controller.abort();
    } catch {}
  }
  inFlightAbortControllers.clear();
  memoryCache.clear();
  inFlightRequests.clear();
  requestEpochs.clear();

  try {
    const dir = getCacheDirectory();
    if (dir.exists) {
      if (typeof dir.list === 'function') {
        const files = dir.list();
        for (const f of files) {
          try {
            f.delete();
          } catch {}
        }
      } else {
        dir.delete();
      }
    }
  } catch (err) {
    console.warn('[apiCache] Error clearing entire cache directory:', err?.message);
  }
};

/**
 * Вычисляет безопасный ключ кэша на основе эндпоинта (сохраняя query-параметры).
 * @param {string} endpoint
 * @returns {string}
 */
export const deriveCacheKeyFromEndpoint = (endpoint) => {
  if (!endpoint) return 'default';
  const clean = endpoint.replace(/^\/api\//, '').replace(/^\//, '');
  return clean.replace(/[^a-zA-Z0-9_-]/g, '_');
};

/**
 * Размер страницы треков по умолчанию.
 */
export const TRACKS_PAGE_SIZE = 30;

/**
 * Объединяет текущий список треков с новым, устраняя дубликаты по track.id.
 * Сохраняет исходный порядок существующих треков и добавляет новые в конец.
 * @param {Array} current
 * @param {Array} incoming
 * @returns {Array}
 */
export const mergeTracks = (current = [], incoming = []) => {
  const currentList = Array.isArray(current) ? current : [];
  const incomingList = Array.isArray(incoming) ? incoming : [];

  const byId = new Map(currentList.map((track) => [track.id, track]));

  for (const track of incomingList) {
    if (track?.id != null) {
      byId.set(track.id, track);
    }
  }

  return [...byId.values()];
};

/**
 * Stale-while-revalidate загрузчик ресурсов каталога с дедупликацией.
 * @param {string} endpoint
 * @param {object} options
 * @returns {Promise<{ data: any, fromCache: boolean, isStale: boolean, error?: Error }>}
 */
export const fetchCatalogWithCache = async (endpoint, options = {}) => {
  const key = options.key || deriveCacheKeyFromEndpoint(endpoint);
  const serverUrl = normalizeServerUrl(options.serverUrl || SERVER_URL || '');
  let userId = options.userId;
  if (userId === undefined) {
    const saved = await getSavedUser().catch(() => null);
    userId = saved?.id ?? null;
  }

  const baseKey = key.split('_')[0];
  const ttlMs =
    typeof options.ttlMs === 'number'
      ? options.ttlMs
      : DEFAULT_TTL_MS[key] || DEFAULT_TTL_MS[baseKey] || 60 * 1000;
  const forceRefresh = Boolean(options.forceRefresh);
  const cacheKey = getCacheKey(key, serverUrl, userId);

  const userKeyStr = userId !== undefined && userId !== null ? String(userId).trim() : null;
  const startUserGen = userKeyStr ? (userClearGenerations.get(userKeyStr) || 0) : 0;
  const startGlobalGen = cacheClearGeneration;

  const isCacheCleared = () => {
    if (cacheClearGeneration !== startGlobalGen) return true;
    if (userKeyStr && (userClearGenerations.get(userKeyStr) || 0) !== startUserGen) return true;
    return false;
  };

  // 1. Читаем локальный кэш
  const cached = await getCachedCatalog(key, { serverUrl, userId, ttlMs });

  if (isCacheCleared()) {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    throw abortError;
  }

  if (cached && cached.data !== undefined) {
    if (typeof options.onData === 'function') {
      options.onData(cached.data, { fromCache: true, isStale: cached.isStale });
    }
    if (typeof options.onCachedData === 'function') {
      options.onCachedData(cached.data);
    }
  }

  // 2. Если данные свежие и не запрошен принудительный refresh, сеть не вызываем
  if (!forceRefresh && cached && !cached.isStale) {
    return {
      data: cached.data,
      fromCache: true,
      isStale: false,
    };
  }

  // 3. Дедупликация параллельных запросов (если не forceRefresh)
  // Проверяем ДО инкремента epoch, чтобы второй запрос не аннулировал epoch первого!
  if (!forceRefresh && inFlightRequests.has(cacheKey)) {
    try {
      const pendingPromise = inFlightRequests.get(cacheKey);
      let sharedResult;

      if (options.signal) {
        if (options.signal.aborted) {
          const abortError = new Error('Aborted');
          abortError.name = 'AbortError';
          throw abortError;
        }
        let onAbort;
        const abortPromise = new Promise((_, reject) => {
          onAbort = () => {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          };
          options.signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
          sharedResult = await Promise.race([pendingPromise, abortPromise]);
        } finally {
          if (onAbort && typeof options.signal.removeEventListener === 'function') {
            options.signal.removeEventListener('abort', onAbort);
          }
        }
      } else {
        sharedResult = await pendingPromise;
      }

      // Вызываем onData / onFreshData для второго/последующих подписчиков свежего результата
      if (!options.signal?.aborted && !sharedResult?.fromCache && sharedResult?.data !== undefined) {
        if (typeof options.onData === 'function') {
          options.onData(sharedResult.data, { fromCache: false, isStale: false });
        }
        if (typeof options.onFreshData === 'function') {
          options.onFreshData(sharedResult.data);
        }
      }

      return sharedResult;
    } catch (e) {
      if (e?.name === 'AbortError') {
        throw e;
      }
      if (typeof options.onError === 'function') {
        options.onError(e);
      }
      if (e?.message?.includes('401') || e?.status === 401) {
        throw e;
      }
      if (cached && cached.data !== undefined) {
        return { data: cached.data, fromCache: true, isStale: true, error: e };
      }
      throw e;
    }
  }

  // 4. Защита от race conditions: глобальный монотонный epoch + регистрация AbortController
  const requestStartTime = Date.now();
  globalEpochCounter += 1;
  const currentEpoch = globalEpochCounter;
  requestEpochs.set(cacheKey, currentEpoch);

  const internalAbortController = new AbortController();
  let onExternalAbort;
  if (options.signal) {
    if (options.signal.aborted) {
      internalAbortController.abort();
    } else {
      onExternalAbort = () => internalAbortController.abort();
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  inFlightAbortControllers.set(cacheKey, internalAbortController);

  let networkPromise;
  networkPromise = (async () => {
    try {
      const response = await authFetch(endpoint, {
        signal: internalAbortController.signal,
      });

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }

      const raw = await response.json();
      const freshData = options.transform ? options.transform(raw) : raw;

      // Если запрос был отменен (внутренне при clearCatalogCache или внешне) или устарел
      if (
        isCacheCleared() ||
        internalAbortController.signal.aborted ||
        options.signal?.aborted ||
        requestEpochs.get(cacheKey) !== currentEpoch
      ) {
        return {
          data: freshData,
          fromCache: false,
          isStale: false,
        };
      }

      // Сохраняем в кэш с передачей поколения и сигнала отмены
      await setCachedCatalog(key, freshData, {
        serverUrl,
        userId,
        savedAt: requestStartTime,
        expectedClearGeneration: startGlobalGen,
        expectedUserClearGeneration: startUserGen,
        signal: internalAbortController.signal,
      });

      // Повторно проверяем актуальность ПОСЛЕ завершения асинхронного сохранения в кэш
      if (
        isCacheCleared() ||
        internalAbortController.signal.aborted ||
        options.signal?.aborted ||
        requestEpochs.get(cacheKey) !== currentEpoch
      ) {
        await removeCachedCatalog(key, { serverUrl, userId });
        return {
          data: freshData,
          fromCache: false,
          isStale: false,
        };
      }

      if (typeof options.onData === 'function') {
        options.onData(freshData, { fromCache: false, isStale: false });
      }
      if (typeof options.onFreshData === 'function') {
        options.onFreshData(freshData);
      }

      return {
        data: freshData,
        fromCache: false,
        isStale: false,
      };
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw err;
      }
      if (typeof options.onError === 'function') {
        options.onError(err);
      }
      // При 401 сессия невалидна — не глушим ошибку кешем, пробрасываем дальше
      if (err?.message?.includes('401') || err?.status === 401) {
        throw err;
      }
      if (cached && cached.data !== undefined) {
        return {
          data: cached.data,
          fromCache: true,
          isStale: true,
          error: err,
        };
      }
      throw err;
    } finally {
      if (onExternalAbort && typeof options.signal?.removeEventListener === 'function') {
        options.signal.removeEventListener('abort', onExternalAbort);
      }
      // Удаляем только если запись всё ещё указывает на текущий promise
      if (inFlightRequests.get(cacheKey) === networkPromise) {
        inFlightRequests.delete(cacheKey);
      }
      if (inFlightAbortControllers.get(cacheKey) === internalAbortController) {
        inFlightAbortControllers.delete(cacheKey);
      }
    }
  })();

  inFlightRequests.set(cacheKey, networkPromise);
  return networkPromise;
};

/**
 * Загружает страницу треков с кэшированием каждой страницы.
 * @param {number} offset
 * @param {number} limit
 * @param {object} options
 */
export const fetchTracksPage = async (offset = 0, limit = TRACKS_PAGE_SIZE, options = {}) => {
  const pageIndex = Math.floor(offset / limit);
  const endpoint = `/api/tracks?limit=${limit}&offset=${offset}`;
  const key = options.key || `tracks_page_${offset}`;
  const serverUrl = normalizeServerUrl(options.serverUrl || SERVER_URL || '');

  const transformPage = (raw) => {
    let rawItems = [];
    if (Array.isArray(raw)) {
      rawItems = raw;
    } else if (raw && Array.isArray(raw.items)) {
      rawItems = raw.items;
    }

    const normalizedItems = rawItems.map((t) => ({
      ...t,
      coverArt: t.coverArt || `${serverUrl}/api/cover/${t.id}`,
    }));

    return {
      page: pageIndex,
      limit,
      offset,
      items: normalizedItems,
      hasMore: normalizedItems.length === limit,
    };
  };

  const result = await fetchCatalogWithCache(endpoint, {
    ...options,
    serverUrl,
    key,
    ttlMs: options.ttlMs || DEFAULT_TTL_MS.tracks,
    transform: transformPage,
    onData: (data, meta) => {
      let pageData = data;
      if (Array.isArray(data)) {
        pageData = transformPage(data);
      }
      if (typeof options.onData === 'function') {
        options.onData(pageData, meta);
      }
    },
    onFreshData: (data) => {
      let pageData = data;
      if (Array.isArray(data)) {
        pageData = transformPage(data);
      }
      if (typeof options.onFreshData === 'function') {
        options.onFreshData(pageData);
      }
    },
    onCachedData: (data) => {
      let pageData = data;
      if (Array.isArray(data)) {
        pageData = transformPage(data);
      }
      if (typeof options.onCachedData === 'function') {
        options.onCachedData(pageData);
      }
    },
  });

  let finalData = result?.data;
  if (Array.isArray(finalData)) {
    finalData = transformPage(finalData);
  }

  return {
    ...result,
    data: finalData,
  };
};
