/**
 * Persistent audio cache using expo-file-system.
 * Stores audio files locally to avoid repeated downloads.
 * Implements deduplication, LRU cleanup by lastAccessed/mtime,
 * atomic download via temp file + rename/move, manifest tracking, and task cancellation.
 *
 * Reliability (Gate A, plan section 4.3):
 * - Bounded retry with inactivity/total budgets; only transient failures retry.
 * - Structured error classification (numeric HTTP status), never localized text parsing.
 * - Source-URI conditional invalidation; never deletes a newer replacement copy.
 * - Finitely bounded episode even when useful progress keeps arriving.
 * - Single in-flight init that is reset after failure.
 */

import { File, Directory, Paths } from 'expo-file-system';

export const CACHE_DIR_NAME = 'audio-cache';
export const MANIFEST_FILE_NAME = 'manifest.json';
export const TEMP_DIR_NAME = '.temp';
export const DEFAULT_MAX_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
export const DOWNLOAD_TIMEOUT_MS = 45000; // deprecated inactivity override
export const INACTIVITY_TIMEOUT_MS = 20000;
export const TOTAL_TIMEOUT_MS = 180000;
export const RETRY_DELAYS_MS = [800, 2000]; // 2 retries (total 3 attempts)
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
export const SAFETY_MARGIN_BYTES = 50 * 1024 * 1024; // 50 MB safety margin

const CANCELLED_MESSAGE = 'Download cancelled';

function createCancelledError(reason) {
  const err = new Error(CANCELLED_MESSAGE);
  err.name = 'AbortError';
  err.cacheErrorKind = 'cancelled';
  if (reason) err.reason = reason;
  return err;
}

function isCancelledError(err) {
  return Boolean(
    err && (err.cacheErrorKind === 'cancelled' || err.name === 'AbortError'),
  );
}

/**
 * Извлекает числовой структурированный HTTP-статус из ошибки, если он есть.
 * SDK 58.0.11 FileSystem кладёт статус только в текст исключения; текст не парсим.
 * @param {*} error
 * @returns {number|null}
 */
function extractStatusCode(error) {
  if (!error || typeof error !== 'object') return null;
  const candidates = [error.status, error.statusCode, error.response?.status];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isOwnedTimeout(error) {
  return Boolean(error && error.cacheOwnedTimeout === true);
}

function isOwnIntransientCode(error) {
  const code = error && typeof error === 'object' ? error.code : null;
  if (typeof code !== 'string') return false;
  return TRANSIENT_STRUCTURED_CODES.has(code);
}

// Небольшой документированный allowlist известных transport-кодов SDK.
const TRANSIENT_STRUCTURED_CODES = new Set([
  'ERR_NETWORK',
  'NETWORK_ERROR',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

/**
 * Классифицирует ошибку загрузки по структурированным данным.
 * Порядок: cancellation > numeric HTTP status > 408/429/5xx transient >
 * owned inactivity timeout > structured transport code > unknown.
 * @param {*} error
 * @returns {{kind: 'cancelled'|'auth'|'not_found'|'permanent'|'transient'|'unknown', statusCode: number|null, retryable: boolean}}
 */
export function classifyDownloadError(error) {
  if (isCancelledError(error)) {
    return { kind: 'cancelled', statusCode: null, retryable: false };
  }

  const statusCode = extractStatusCode(error);
  if (statusCode !== null) {
    if (statusCode === 401 || statusCode === 403) {
      return { kind: 'auth', statusCode, retryable: false };
    }
    if (statusCode === 404) {
      return { kind: 'not_found', statusCode, retryable: false };
    }
    if (statusCode === 408 || statusCode === 429 || statusCode >= 500) {
      return { kind: 'transient', statusCode, retryable: true };
    }
    if (statusCode >= 400) {
      return { kind: 'permanent', statusCode, retryable: false };
    }
    // Прочие числовые не-4xx/5xx статусы не трактуем как HTTP-сбой загрузки.
  }

  if (isOwnedTimeout(error) || isOwnIntransientCode(error)) {
    return { kind: 'transient', statusCode: null, retryable: true };
  }

  return { kind: 'unknown', statusCode: null, retryable: false };
}

export class AudioCache {
  constructor(options = {}) {
    const baseDir = options.baseDir || Paths.document;
    this.cacheDir = new Directory(
      baseDir,
      options.cacheDirName || CACHE_DIR_NAME,
    );
    this.tempDir = new Directory(
      this.cacheDir,
      options.tempDirName || TEMP_DIR_NAME,
    );
    this.manifestFile = new File(
      this.cacheDir,
      options.manifestFileName || MANIFEST_FILE_NAME,
    );
    this.manifest = {}; // [trackId]: { uri, size, mtime, lastAccessed }
    this.ongoingDownloads = new Map(); // trackId => { promise, task, tempFile, cancelled, generation }
    this.downloadGenerations = new Map(); // trackId => number
    this.maxSizeBytes = options.maxSizeBytes || DEFAULT_MAX_SIZE_BYTES;
    this.inactivityTimeoutMs = resolveInactivityTimeout(options);
    // Deprecated alias, kept readable for callers/tests; the effective value is inactivityTimeoutMs.
    this.downloadTimeoutMs = this.inactivityTimeoutMs;
    this.totalTimeoutMs =
      Number.isFinite(options.totalTimeoutMs) && options.totalTimeoutMs > 0
        ? options.totalTimeoutMs
        : TOTAL_TIMEOUT_MS;
    // Не больше MAX_ATTEMPTS(3) попыток, даже если вызывающий передал больше задержек.
    this.retryDelaysMs = Array.isArray(options.retryDelaysMs)
      ? options.retryDelaysMs
          .filter((d) => Number.isFinite(d) && d >= 0)
          .slice(0, MAX_ATTEMPTS - 1)
      : RETRY_DELAYS_MS.slice();
    this.maxAttempts = this.retryDelaysMs.length + 1;
    // Инъектируемые монотонные часы для дедлайнов (Gate A / monotonic clock).
    // По умолчанию используется performance.now() (RN/Hermes/Node), чтобы
    // обратный перевод настенных часов (Date.now) не срывал общий дедлайн.
    this.now =
      typeof options.now === 'function' ? options.now : getMonotonicNow;
    this.safetyMarginBytes = options.safetyMarginBytes || SAFETY_MARGIN_BYTES;
    this.isInitialized = false;
    this._initPromise = null;
    this._saveManifestTimeout = null;
    this.protectedTrackIds = new Set();
    // Защита от cross-instance/restart коллизий финальных имён.
    this._publicationNonce = generatePublicationNonce();
    this._publicationCounter = 0;
  }

  /**
   * Устанавливает ID треков, защищённых от LRU вытеснения (текущий трек, очередь).
   * @param {Array<string|number>} ids
   */
  setProtectedTrackIds(ids) {
    this.protectedTrackIds = new Set(
      (ids || []).map((id) => String(id).trim()),
    );
  }

  /**
   * Инициализирует кеш: создаёт директории, загружает manifest,
   * валидирует наличие файлов на диске и очищает временную директорию.
   * Единственный in-flight init: при ошибке сохраняется rejected promise
   * (без unhandled rejection) и следующий вызов пробует снова.
   */
  init() {
    if (this.isInitialized) {
      return Promise.resolve(this);
    }
    if (this._initPromise) {
      return this._initPromise;
    }

    const promise = this._runInit();
    this._initPromise = promise;
    // Не допускаем unhandled rejection от фонового init(): потребители
    // получают ошибку через собственный вызов getOrFetch()/init().
    promise.catch(() => {});

    const resetOnFailure = () => {
      if (this._initPromise === promise) {
        this._initPromise = null;
      }
    };
    promise.then(resetOnFailure, resetOnFailure);
    return promise;
  }

  async _runInit() {
    try {
      if (!this.cacheDir.exists) {
        this.cacheDir.create({ intermediates: true });
      }
    } catch (e) {
      if (!(e instanceof Error && e.message.includes('already exists'))) {
        console.warn('[AudioCache] cacheDir create warning:', e);
      }
    }

    try {
      if (!this.tempDir.exists) {
        this.tempDir.create({ intermediates: true });
      }
    } catch (e) {
      if (!(e instanceof Error && e.message.includes('already exists'))) {
        console.warn('[AudioCache] tempDir create warning:', e);
      }
    }

    // Очищаем старые временные файлы от прошлых незавершённых сессий
    await this._clearTempDir();

    // Загружаем и валидируем manifest
    await this._loadManifest();

    this.isInitialized = true;
    return this;
  }

  /**
   * Проверяет, закеширован ли трек и существует ли файл на диске.
   * @param {string|number} trackId
   * @returns {string|null} file:// URI или null
   */
  getCachedUri(trackId) {
    if (!this.isInitialized) return null;
    if (!trackId && trackId !== 0) return null;
    const trackIdStr = String(trackId).trim();
    const entry = this.manifest[trackIdStr];
    if (!entry || typeof entry !== 'object' || typeof entry.uri !== 'string')
      return null;

    const uri = entry.uri.trim();

    // 1. Проверяем валидность file:// схемы
    if (!uri.startsWith('file://')) {
      console.warn(
        `[AudioCache] Invalid non-file URI in manifest for track ${trackIdStr}: ${uri}`,
      );
      delete this.manifest[trackIdStr];
      this._scheduleSaveManifest();
      return null;
    }

    // 2. Исключаем устаревший .audio формат и временные файлы
    if (
      uri.endsWith('.audio') ||
      uri.includes('.part') ||
      uri.includes('/.temp/')
    ) {
      console.warn(
        `[AudioCache] Cleaning up invalid/legacy format file in manifest: ${uri}`,
      );
      try {
        const legacyFile = new File(uri);
        if (legacyFile.exists) legacyFile.delete();
      } catch {}
      delete this.manifest[trackIdStr];
      this._scheduleSaveManifest();
      return null;
    }

    try {
      const file = new File(uri);

      // Безопасная проверка существования
      let exists = false;
      try {
        exists = Boolean(file.exists);
      } catch (err) {
        console.warn(
          `[AudioCache] file.exists check failed for ${uri}:`,
          err?.message,
        );
        exists = false;
      }

      if (!exists) {
        delete this.manifest[trackIdStr];
        this._scheduleSaveManifest();
        return null;
      }

      // Безопасная проверка размера
      let size = 0;
      try {
        size = file.size ?? 0;
      } catch (err) {
        console.warn(
          `[AudioCache] file.size check failed for ${uri}:`,
          err?.message,
        );
        size = 0;
      }

      if (size > 0) {
        entry.lastAccessed = Date.now();
        this._scheduleSaveManifest();
        return file.uri;
      }

      // Файл пустой (0 байт) — удаляем
      console.warn(
        `[AudioCache] Cached file for track ${trackIdStr} has 0 bytes, removing: ${uri}`,
      );
      try {
        file.delete();
      } catch {}
      delete this.manifest[trackIdStr];
      this._scheduleSaveManifest();
      return null;
    } catch (err) {
      console.error(
        `[AudioCache] getCachedUri unexpected error for track ${trackIdStr}:`,
        err,
      );
      return null;
    }
  }

  /**
   * @param {string|number} trackId
   * @returns {boolean}
   */
  isCached(trackId) {
    return Boolean(this.getCachedUri(trackId));
  }

  /**
   * Адресная инвалидация конкретной опубликованной копии.
   * Удаляет запись manifest только если её uri строго равен expectedUri
   * (синхронное compare-and-remove до первого await) и удаляет только
   * захваченный файл. Не отменяет загрузки трека и не трогает более новую копию.
   *
   * @param {string|number} trackId
   * @param {string} expectedUri file:// URI, использованный при воспроизведении
   * @returns {Promise<boolean>} true только если запись была удалена этим вызовом
   */
  async invalidate(trackId, expectedUri) {
    if ((!trackId && trackId !== 0) || typeof expectedUri !== 'string') {
      return false;
    }
    const trackIdStr = String(trackId).trim();
    const entry = this.manifest[trackIdStr];
    if (!entry || typeof entry !== 'object' || entry.uri !== expectedUri) {
      return false;
    }

    // Compare-and-remove синхронно, до первого await.
    delete this.manifest[trackIdStr];
    this._scheduleSaveManifest();

    let deletionFailed = false;
    try {
      const file = new File(expectedUri);
      if (file.exists) {
        file.delete();
      }
    } catch (e) {
      deletionFailed = true;
      console.warn(
        '[AudioCache] invalidate failed to delete captured file',
        e?.message,
      );
    }

    if (deletionFailed) {
      // Не восстанавливаем удалённую запись и не трогаем другие копии,
      // но фиксируем manifest без этой записи.
      await this._saveManifest();
    }
    return true;
  }

  /**
   * Возвращает текущее состояние загрузки трека:
   * 'cached' | 'downloading' | 'idle'
   * Предоставляет планировщику и координатору единый публичный контракт статуса без прямого доступа к ongoingDownloads.
   *
   * @param {string|number} trackId
   * @returns {{ status: 'cached'|'downloading'|'idle', uri?: string, promise?: Promise<string> }}
   */
  getDownloadState(trackId) {
    if (!trackId && trackId !== 0) return { status: 'idle' };
    const trackIdStr = String(trackId).trim();

    const cachedUri = this.getCachedUri(trackIdStr);
    if (cachedUri) {
      return { status: 'cached', uri: cachedUri };
    }

    const record = this.ongoingDownloads.get(trackIdStr);
    if (record && record.promise && !record.cancelled) {
      return { status: 'downloading', promise: record.promise };
    }

    return { status: 'idle' };
  }

  /**
   * Проверяет, выполняется ли в данный момент фоновая загрузка трека.
   * @param {string|number} trackId
   * @returns {boolean}
   */
  isDownloading(trackId) {
    if (!trackId && trackId !== 0) return false;
    const trackIdStr = String(trackId).trim();
    const record = this.ongoingDownloads.get(trackIdStr);
    return Boolean(record && record.promise && !record.cancelled);
  }

  /**
   * Возвращает Promise текущей активной загрузки или null.
   * @param {string|number} trackId
   * @returns {Promise<string>|null}
   */
  getOngoingPromise(trackId) {
    if (!trackId && trackId !== 0) return null;
    const trackIdStr = String(trackId).trim();
    const record = this.ongoingDownloads.get(trackIdStr);
    return record && record.promise && !record.cancelled
      ? record.promise
      : null;
  }

  /**
   * Возвращает file:// URI для трека:
   * 1. Если уже в кеше — возвращает готовый URI.
   * 2. Если загрузка уже идёт — возвращает существующий Promise (deduplication).
   * 3. Иначе запускает атомарную загрузку с таймаутами и повторными попытками.
   *
   * @param {string|number} trackId
   * @param {string} remoteUri
   * @param {Object} [options]
   * @param {Record<string, string>} [options.headers]
   * @param {AbortSignal} [options.signal]
   * @param {(progress: {bytesWritten:number,totalBytes:number}) => void} [options.onProgress]
   * @returns {Promise<string>} file:// URI готового аудиофайла
   */
  getOrFetch(trackId, remoteUri, options = {}) {
    const trackIdStr = String(trackId);

    // 1. Если уже закеширован — возвращаем resolved promise с cached URI
    const cachedUri = this.getCachedUri(trackIdStr);
    if (cachedUri) {
      return Promise.resolve(cachedUri);
    }

    // 2. Если загрузка уже идёт — возвращаем существующий Promise синхронно (deduplication)
    if (this.ongoingDownloads.has(trackIdStr)) {
      const ongoing = this.ongoingDownloads.get(trackIdStr);
      if (ongoing.cancelled) {
        // Запись уже отменена: не присоединяемся к мёртвой загрузке.
        this.ongoingDownloads.delete(trackIdStr);
      } else {
        if (options.signal) {
          if (options.signal.aborted) {
            return Promise.reject(createCancelledError());
          }
          return new Promise((resolve, reject) => {
            const onAbort = () => {
              reject(createCancelledError());
            };
            options.signal.addEventListener('abort', onAbort, { once: true });
            ongoing.promise
              .then(resolve)
              .catch(reject)
              .finally(() => {
                if (typeof options.signal?.removeEventListener === 'function') {
                  options.signal.removeEventListener('abort', onAbort);
                }
              });
          });
        }
        return ongoing.promise;
      }
    }

    // 3. Создаём запись и регистрируем промис сразу
    const generation = (this.downloadGenerations.get(trackIdStr) || 0) + 1;
    this.downloadGenerations.set(trackIdStr, generation);

    const admissionTime = this.now();
    const totalDeadline = admissionTime + this.totalTimeoutMs;

    const downloadRecord = {
      promise: null,
      trackIdStr,
      cancelled: false,
      cancelReason: null,
      admissionTime,
      totalDeadline,
      generation,
      // Общий срок эпизода: стартует при admission, включает init/backoff/все попытки.
      totalTimeoutId: null,
      abortListener: null,
      userSignal: options.signal || null,
      // Текущая попытка (см. _downloadAttempt). Очищается после каждой попытки.
      attempt: null,
    };

    // Внешний race: ожидающий промис всегда сеттлится по отмене/бюджету,
    // независимо от того, что init()/нативный download promise продолжают висеть.
    let episodeSettled = false;
    const episodePromise = new Promise((resolve, reject) => {
      const settle = (outcome, value) => {
        if (episodeSettled) return;
        episodeSettled = true;
        if (outcome === 'resolve') resolve(value);
        else reject(value);
      };
      downloadRecord.settleEpisode = settle;
    });

    const markCancelled = (reason, error) => {
      if (downloadRecord.cancelled) return;
      downloadRecord.cancelled = true;
      downloadRecord.cancelReason = reason;
      this._abortRecord(downloadRecord, error);
    };
    downloadRecord.markCancelled = markCancelled;

    const run = (async () => {
      if (!this.isInitialized) {
        await this.init();
      }
      this._throwIfStale(trackIdStr, downloadRecord);

      // Повторная проверка кеша после init()
      const cachedAfterInit = this.getCachedUri(trackIdStr);
      if (cachedAfterInit) return cachedAfterInit;

      this._checkDiskSpace();

      return await this._downloadWithRetry(
        trackIdStr,
        remoteUri,
        options,
        downloadRecord,
      );
    })();

    run.then(
      (uri) => {
        this._clearTotalTimer(downloadRecord);
        this._detachUserSignal(downloadRecord);
        if (downloadRecord.cancelled) {
          downloadRecord.settleEpisode(
            'reject',
            downloadRecord.cancelError ||
              createCancelledError(downloadRecord.cancelReason),
          );
        } else {
          downloadRecord.settleEpisode('resolve', uri);
        }
        this._cleanupRecord(trackIdStr, downloadRecord);
      },
      (err) => {
        this._clearTotalTimer(downloadRecord);
        this._detachUserSignal(downloadRecord);
        let finalError = err;
        if (
          downloadRecord.cancelled ||
          isCancelledError(err) ||
          (downloadRecord.userSignal && downloadRecord.userSignal.aborted)
        ) {
          finalError = createCancelledError(downloadRecord.cancelReason);
        } else if (this.now() >= totalDeadline) {
          finalError = this._makeError(
            'Download total budget exceeded',
            'transient',
          );
        }
        downloadRecord.settleEpisode('reject', finalError);
        this._cleanupRecord(trackIdStr, downloadRecord);
      },
    );

    downloadRecord.promise = episodePromise;
    this.ongoingDownloads.set(trackIdStr, downloadRecord);
    // Гасим возможный unhandled rejection синхронной отмены (caller может
    // присоединить обработчик позже). Промис возвращается как есть для dedup.
    episodePromise.catch(() => {});

    // Таймер общего бюджета: снимаем всю сеть эпизода по достижении 180с.
    downloadRecord.totalTimeoutId = setTimeout(
      () => {
        downloadRecord.totalTimeoutId = null;
        const current = this.ongoingDownloads.get(trackIdStr);
        if (current !== downloadRecord || downloadRecord.cancelled) return;
        if (this.now() < totalDeadline) {
          // Таймер сработал раньше монотонного дедлайна (например, injected clock):
          // перевзводим на остаток.
          this._armTotalTimer(trackIdStr, downloadRecord);
          return;
        }
        markCancelled(
          'total-timeout',
          this._makeError('Download total budget exceeded', 'transient'),
        );
      },
      Math.max(0, totalDeadline - admissionTime),
    );
    if (typeof downloadRecord.totalTimeoutId?.unref === 'function') {
      downloadRecord.totalTimeoutId.unref();
    }

    // Внешняя отмена эпизода (options.signal).
    if (options.signal) {
      if (options.signal.aborted) {
        markCancelled('abort', createCancelledError('abort'));
      } else {
        downloadRecord.abortListener = () => {
          markCancelled('abort', createCancelledError('abort'));
        };
        options.signal.addEventListener('abort', downloadRecord.abortListener, {
          once: true,
        });
      }
    }

    return episodePromise;
  }

  _armTotalTimer(trackIdStr, record) {
    const remaining = Math.max(0, record.totalDeadline - this.now());
    record.totalTimeoutId = setTimeout(() => {
      record.totalTimeoutId = null;
      const current = this.ongoingDownloads.get(trackIdStr);
      if (current !== record || record.cancelled) return;
      record.markCancelled(
        'total-timeout',
        this._makeError('Download total budget exceeded', 'transient'),
      );
    }, remaining);
    if (typeof record.totalTimeoutId?.unref === 'function') {
      record.totalTimeoutId.unref();
    }
  }

  _clearTotalTimer(record) {
    if (record.totalTimeoutId) {
      clearTimeout(record.totalTimeoutId);
      record.totalTimeoutId = null;
    }
  }

  _cleanupRecord(trackIdStr, record) {
    this._clearTotalTimer(record);
    this._detachUserSignal(record);
    const current = this.ongoingDownloads.get(trackIdStr);
    if (current === record) {
      this.ongoingDownloads.delete(trackIdStr);
    }
  }

  /**
   * Отменяет активную загрузку трека.
   * @param {string|number} trackId
   */
  cancel(trackId) {
    const trackIdStr = String(trackId);
    this.downloadGenerations.set(
      trackIdStr,
      (this.downloadGenerations.get(trackIdStr) || 0) + 1,
    );

    const record = this.ongoingDownloads.get(trackIdStr);
    if (!record) return;

    if (typeof record.markCancelled === 'function') {
      record.markCancelled('cancel', createCancelledError('cancel'));
    } else {
      record.cancelReason = 'cancel';
      this._abortRecord(record, createCancelledError('cancel'));
    }
  }

  /**
   * Удаляет трек из кеша и manifest.
   * @param {string|number} trackId
   */
  async remove(trackId) {
    if (!this.isInitialized) return;
    const trackIdStr = String(trackId);
    this.cancel(trackIdStr);

    const entry = this.manifest[trackIdStr];
    if (entry?.uri) {
      try {
        const file = new File(entry.uri);
        if (file.exists) {
          file.delete();
        }
      } catch {}
      delete this.manifest[trackIdStr];
      this._scheduleSaveManifest();
    }
  }

  /**
   * Очищает весь кеш.
   */
  async clear() {
    // Отменяем все текущие загрузки
    for (const trackId of Array.from(this.ongoingDownloads.keys())) {
      this.cancel(trackId);
    }

    if (this._saveManifestTimeout) {
      clearTimeout(this._saveManifestTimeout);
      this._saveManifestTimeout = null;
    }

    try {
      if (this.cacheDir.exists) {
        this.cacheDir.delete();
      }
    } catch {}

    this.manifest = {};
    this.isInitialized = false;
    await this.init();
  }

  /**
   * Возвращает суммарный размер всех файлов в кеше в байтах.
   */
  async getSize() {
    if (!this.isInitialized) return 0;
    let total = 0;
    for (const entry of Object.values(this.manifest)) {
      if (typeof entry?.size === 'number') {
        total += entry.size;
      }
    }
    return total;
  }

  /**
   * Устанавливает максимальный размер кеша и запускает LRU очистку при необходимости.
   * @param {number} maxSizeBytes
   */
  async setMaxSize(maxSizeBytes) {
    this.maxSizeBytes = maxSizeBytes;
    await this._enforceSizeLimit();
  }

  // --- Внутренние методы ---

  _makeError(message, kind) {
    const err = new Error(message);
    if (kind) err.cacheErrorKind = kind;
    return err;
  }

  _isStale(trackIdStr, record) {
    return Boolean(
      !record ||
      record.cancelled ||
      (record.userSignal && record.userSignal.aborted) ||
      this.downloadGenerations.get(trackIdStr) !== record.generation,
    );
  }

  _throwIfStale(trackIdStr, record) {
    if (this._isStale(trackIdStr, record)) {
      throw createCancelledError(record?.cancelReason);
    }
  }

  /**
   * Синхронно помечает запись отменённой и снимает сеть/таймеры/подписки.
   * Ожидающий промис реджектится немедленно, даже если нативный download promise
   * игнорирует cancel().
   */
  _abortRecord(record, error) {
    if (!record) return;
    // Повторная отмена должна оставаться идемпотентной, но не блокировать
    // уборку записи/ожиданий первого вызова.
    const alreadyCancelled = record.cancelled;
    record.cancelled = true;
    record.cancelError = error;

    this._clearTotalTimer(record);
    // Снимаем внешний abort-listener.
    this._detachUserSignal(record);
    // Прерываем текущую попытку (таймеры/backoff/progress/native) и
    // немедленно settle её ожидания.
    if (record.attempt) {
      this._abortAttempt(record, record.attempt);
      record.attempt = null;
    }
    // Немедленно settle внешнего эпизода: даже если init()/нативный downloadAsync
    // игнорируют отмену, caller не останется висеть.
    if (typeof record.settleEpisode === 'function') {
      record.settleEpisode(
        'reject',
        error instanceof Error ? error : createCancelledError(),
      );
    }
    // Синхронно убираем запись: новый getOrFetch() сразу создаст новую генерацию.
    // Поздний/cancel-ignoring native не сможет опубликовать (см. _isStale).
    if (record.trackIdStr !== undefined) {
      const current = this.ongoingDownloads.get(record.trackIdStr);
      if (current === record) {
        this.ongoingDownloads.delete(record.trackIdStr);
      }
    }
  }

  _abortAttempt(record, attempt) {
    if (!attempt || attempt.settled) {
      // Даже завершённая попытка может иметь живые таймеры/подписку.
    }
    if (attempt.backoffCancel) {
      const cancel = attempt.backoffCancel;
      attempt.backoffCancel = null;
      cancel();
    }
    if (attempt.armInactivityTimer === null) {
      // уже очищено
    }
    if (attempt.timeoutId) {
      clearTimeout(attempt.timeoutId);
      attempt.timeoutId = null;
    }
    if (attempt.progressSubscription) {
      try {
        attempt.progressSubscription.remove();
      } catch {}
      attempt.progressSubscription = null;
    }
    if (typeof attempt.settle === 'function' && !attempt.settled) {
      attempt.settled = true;
      attempt.settle(
        undefined,
        undefined,
        record.cancelError || createCancelledError(record.cancelReason),
      );
    }
    // Не удаляем tempFile здесь: нативный downloadAsync может ещё писать в него.
    // Временный файл вычищается владельцем попытки при её завершении.
    if (attempt.task) {
      try {
        if (typeof attempt.task.cancel === 'function') attempt.task.cancel();
      } catch {}
      try {
        if (typeof attempt.task.release === 'function') attempt.task.release();
      } catch {}
    }
  }

  _detachUserSignal(record) {
    if (record.abortListener && record.userSignal) {
      try {
        record.userSignal.removeEventListener('abort', record.abortListener);
      } catch {}
      record.abortListener = null;
    }
  }

  _checkDiskSpace() {
    try {
      const available = Paths.availableDiskSpace;
      if (typeof available === 'number' && available < this.safetyMarginBytes) {
        console.warn(
          `[AudioCache] Low disk space: ${available} bytes available`,
        );
      }
    } catch {}
  }

  async _downloadWithRetry(
    trackIdStr,
    remoteUri,
    options,
    record,
    attempt = 0,
  ) {
    this._throwIfStale(trackIdStr, record);

    let err;
    try {
      return await this._downloadAttempt(
        trackIdStr,
        remoteUri,
        options,
        record,
      );
    } catch (error) {
      err = error;
    }

    if (this._isStale(trackIdStr, record)) {
      throw createCancelledError(record?.cancelReason);
    }

    const classification = classifyDownloadError(err);
    const canRetry =
      classification.retryable && attempt < this.retryDelaysMs.length;

    if (!canRetry) throw err;

    const remaining = record.totalDeadline - this.now();
    if (remaining <= 0) {
      throw this._makeError('Download total budget exceeded', 'transient');
    }
    const delay = Math.min(this.retryDelaysMs[attempt], remaining);
    // Backoff привязан к попытке: отмена эпизода прерывает ожидание.
    await this._abortableDelay(delay, record);
    this._throwIfStale(trackIdStr, record);
    if (this.now() >= record.totalDeadline) {
      throw this._makeError('Download total budget exceeded', 'transient');
    }
    return this._downloadWithRetry(
      trackIdStr,
      remoteUri,
      options,
      record,
      attempt + 1,
    );
  }

  /**
   * Прерываемый backoff, привязанный к эпизоду и попытке.
   */
  _abortableDelay(ms, record) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const attemptBox = { backoffCancel: null };

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (record.attempt && record.attempt.backoffCancel === cancel) {
          record.attempt.backoffCancel = null;
        }
        fn(value);
      };
      const cancel = () => {
        finish(reject, createCancelledError(record?.cancelReason));
      };

      if (this._isStale(record.trackIdStr, record)) {
        reject(createCancelledError(record?.cancelReason));
        return;
      }

      attemptBox.backoffCancel = cancel;
      // Привязываем к текущему attempt-контейнеру, если он есть.
      if (record.attempt) {
        record.attempt.backoffCancel = cancel;
      } else {
        record.backoffCancel = cancel;
      }
      timer = setTimeout(() => finish(resolve, undefined), Math.max(0, ms));
      if (typeof timer?.unref === 'function') timer.unref();
    });
  }

  async _downloadAttempt(trackIdStr, remoteUri, options, record) {
    this._throwIfStale(trackIdStr, record);

    if (this.now() >= record.totalDeadline) {
      throw this._makeError('Download total budget exceeded', 'transient');
    }

    const publicationName = this._nextPublicationName(trackIdStr);
    const tempFileName = `${publicationName}.part.mp3`;
    const tempFile = new File(this.tempDir, tempFileName);
    const finalFile = new File(this.cacheDir, `${publicationName}.mp3`);

    // Каждая попытка имеет собственный scope: свой таймер, baseline прогресса
    // и привязку нативной задачи. Поздний прогресс старой задачи не может
    // продлить inactivity новой попытки.
    const attempt = {
      tempFile,
      task: null,
      timeoutId: null,
      backoffCancel: null,
      progressSubscription: null,
      settled: false,
      settle: null,
      lastBytesWritten: undefined,
      armInactivityTimer: null,
    };
    record.attempt = attempt;

    const taskOptions = {
      headers: options.headers,
    };
    // Внутренний onProgress: только для inactivity-budget, привязан к attempt.
    taskOptions.onProgress = (progress) => {
      this._noteProgress(attempt, progress);
      if (typeof options.onProgress === 'function') {
        try {
          options.onProgress(progress);
        } catch {}
      }
    };

    const downloadTask = File.createDownloadTask(
      remoteUri,
      tempFile,
      taskOptions,
    );
    attempt.task = downloadTask;
    if (record.cancelled) {
      // Отмена пришла между созданием задачи и её регистрацией.
      this._abortAttempt(record, attempt);
      record.attempt = null;
      this._cancelNativeTask(attempt, tempFile);
      throw createCancelledError(record.cancelReason);
    }

    try {
      const downloadedFile = await new Promise((resolve, reject) => {
        const settle = (handler, value, overrideError) => {
          if (attempt.settled) return;
          attempt.settled = true;
          if (attempt.timeoutId) {
            clearTimeout(attempt.timeoutId);
            attempt.timeoutId = null;
          }
          handler(overrideError || value);
        };
        attempt.settle = settle;

        const armInactivityTimer = () => {
          if (attempt.timeoutId) clearTimeout(attempt.timeoutId);
          attempt.timeoutId = setTimeout(() => {
            attempt.timeoutId = null;
            try {
              if (typeof downloadTask.cancel === 'function') {
                downloadTask.cancel();
              }
            } catch {}
            // Останавливаем свой task и отписываемся, чтобы старый native не
            // мог влиять на новые попытки.
            try {
              if (typeof downloadTask.release === 'function') {
                downloadTask.release();
              }
            } catch {}
            const err = this._makeError(
              `Download inactivity timeout after ${this.inactivityTimeoutMs}ms`,
              'transient',
            );
            err.cacheOwnedTimeout = true;
            settle(reject, err);
          }, this.inactivityTimeoutMs);
          if (typeof attempt.timeoutId?.unref === 'function') {
            attempt.timeoutId.unref();
          }
        };
        attempt.armInactivityTimer = armInactivityTimer;
        armInactivityTimer();

        if (this._isStale(trackIdStr, record)) {
          settle(reject, createCancelledError(record?.cancelReason));
          return;
        }

        Promise.resolve()
          .then(() => downloadTask.downloadAsync())
          .then(
            (result) => settle(resolve, result),
            (error) => settle(reject, error),
          );
      });

      this._throwIfStale(trackIdStr, record);

      const resolvedFile = downloadedFile || tempFile;
      if (!resolvedFile || !resolvedFile.exists) {
        throw this._makeError('Downloaded file missing or empty', 'transient');
      }

      const info =
        typeof resolvedFile.info === 'function'
          ? resolvedFile.info()
          : { size: resolvedFile.size };
      const size = info?.size ?? resolvedFile.size ?? 0;
      if (size <= 0) {
        throw this._makeError('Downloaded file has 0 bytes', 'transient');
      }

      this._throwIfStale(trackIdStr, record);

      // Атомарная публикация под уникальным именем: не перезаписываем
      // чужой/свежий файл. Если имя занято — публикуем следующее уникальное.
      let publishFile = resolvedFile;
      let publishUri = resolvedFile.uri;
      if (resolvedFile.uri !== finalFile.uri) {
        if (finalFile.exists) {
          const altName = this._nextPublicationName(trackIdStr);
          const altFile = new File(this.cacheDir, `${altName}.mp3`);
          await resolvedFile.move(altFile);
          publishFile = altFile;
        } else {
          await resolvedFile.move(finalFile);
          publishFile = finalFile;
        }
        publishUri = publishFile.uri;
      }

      this._throwIfStale(trackIdStr, record);

      const previousUri = this.manifest[trackIdStr]?.uri;
      const now = Date.now();
      this.manifest[trackIdStr] = {
        uri: publishUri,
        size,
        mtime: now,
        lastAccessed: now,
      };
      this._scheduleSaveManifest();

      if (this._isStale(trackIdStr, record)) {
        if (this.manifest[trackIdStr]?.uri === publishUri) {
          delete this.manifest[trackIdStr];
          this._scheduleSaveManifest();
        }
        try {
          if (publishFile.exists) publishFile.delete();
        } catch {}
        throw createCancelledError(record?.cancelReason);
      }

      // Убираем предыдущий файл только после публикации нового.
      if (previousUri && previousUri !== publishUri) {
        try {
          const previousFile = new File(previousUri);
          if (previousFile.exists) previousFile.delete();
        } catch {}
      }

      await this._enforceSizeLimit();

      return publishUri;
    } catch (error) {
      try {
        if (tempFile.exists) tempFile.delete();
      } catch {}
      throw error;
    } finally {
      if (attempt.timeoutId) {
        clearTimeout(attempt.timeoutId);
        attempt.timeoutId = null;
      }
      if (attempt.progressSubscription) {
        try {
          attempt.progressSubscription.remove();
        } catch {}
        attempt.progressSubscription = null;
      }
      attempt.armInactivityTimer = null;
      try {
        if (typeof downloadTask.release === 'function') downloadTask.release();
      } catch {}
      if (record.attempt === attempt) {
        record.attempt = null;
      }
    }
  }

  _cancelNativeTask(attempt, tempFile) {
    if (attempt && attempt.task) {
      try {
        if (typeof attempt.task.cancel === 'function') attempt.task.cancel();
      } catch {}
      try {
        if (typeof attempt.task.release === 'function') attempt.task.release();
      } catch {}
      attempt.task = null;
    }
    const file = tempFile || attempt?.tempFile;
    if (file) {
      try {
        if (file.exists) file.delete();
      } catch {}
    }
  }

  /**
   * Прогресс привязан к конкретной попытке. Повторный/нулевой bytesWritten
   * не продлевает inactivity; первое strictly-increasing значение — да.
   */
  _noteProgress(attempt, progress) {
    if (!attempt || attempt.settled) return;
    const bytesWritten = progress?.bytesWritten;
    if (!Number.isFinite(bytesWritten) || bytesWritten <= 0) return;
    if (
      attempt.lastBytesWritten !== undefined &&
      bytesWritten <= attempt.lastBytesWritten
    ) {
      return;
    }
    attempt.lastBytesWritten = bytesWritten;
    if (typeof attempt.armInactivityTimer === 'function') {
      attempt.armInactivityTimer();
    }
  }

  _nextPublicationName(trackIdStr) {
    this._publicationCounter += 1;
    const safeId = String(trackIdStr).replace(/[^a-zA-Z0-9._-]/g, '_');
    return `${safeId}_${this._publicationNonce}_${this._publicationCounter}`;
  }

  async _clearTempDir() {
    try {
      if (this.tempDir.exists) {
        const files = this.tempDir.list();
        for (const f of files) {
          try {
            f.delete();
          } catch {}
        }
      }
    } catch (e) {
      console.warn('[AudioCache] Failed to clear temp dir:', e);
    }
  }

  /**
   * Удаляет orphan-файлы внутри cacheDir, не упомянутые в manifest.
   * Если листинг недоступен — тихо пропускает.
   */
  async _purgeOrphanFiles() {
    try {
      if (!this.cacheDir.exists) return;
      const referenced = new Set();
      for (const entry of Object.values(this.manifest)) {
        if (entry && typeof entry.uri === 'string') {
          referenced.add(entry.uri);
        }
      }
      const children = this.cacheDir.list();
      for (const child of children) {
        if (!child || typeof child.uri !== 'string') continue;
        if (child.uri === this.tempDir.uri) continue;
        if (child.uri === this.manifestFile.uri) continue;
        if (referenced.has(child.uri)) continue;
        // Удаляем только собственные публикации кеша (mp3 из cacheDir).
        if (!child.uri.endsWith('.mp3') && !child.uri.endsWith('.part.mp3')) {
          continue;
        }
        try {
          if (child.exists) child.delete();
        } catch {}
      }
    } catch {
      // Listing недоступен: не мешаем init.
    }
  }

  async _loadManifest() {
    try {
      if (!this.manifestFile.exists) {
        this.manifest = {};
        return;
      }
      const text = await this.manifestFile.text();
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        this.manifest = parsed;
      } else {
        this.manifest = {};
      }

      // Валидация: проверяем, что указанные файлы реально есть на диске и не являются устаревшими/временными
      let hasChanges = false;
      for (const [id, entry] of Object.entries(this.manifest)) {
        if (
          !entry?.uri ||
          typeof entry.uri !== 'string' ||
          !entry.uri.startsWith('file://')
        ) {
          delete this.manifest[id];
          hasChanges = true;
          continue;
        }
        try {
          if (
            entry.uri.endsWith('.audio') ||
            entry.uri.includes('.part') ||
            entry.uri.includes('/.temp/')
          ) {
            try {
              const legacyFile = new File(entry.uri);
              if (legacyFile.exists) legacyFile.delete();
            } catch {}
            delete this.manifest[id];
            hasChanges = true;
            continue;
          }
          const file = new File(entry.uri);
          let exists = false;
          try {
            exists = Boolean(file.exists);
          } catch {
            exists = false;
          }
          if (!exists) {
            delete this.manifest[id];
            hasChanges = true;
          }
        } catch {
          delete this.manifest[id];
          hasChanges = true;
        }
      }

      if (hasChanges) {
        await this._saveManifest();
      }
    } catch (e) {
      console.warn('[AudioCache] Corrupted manifest, starting fresh:', e);
      this.manifest = {};
    }
  }

  _scheduleSaveManifest(delayMs = 1000) {
    if (this._saveManifestTimeout) {
      clearTimeout(this._saveManifestTimeout);
    }
    this._saveManifestTimeout = setTimeout(() => {
      this._saveManifestTimeout = null;
      this._saveManifest().catch(() => {});
    }, delayMs);
    if (typeof this._saveManifestTimeout?.unref === 'function') {
      this._saveManifestTimeout.unref();
    }
  }

  async _saveManifest() {
    try {
      const data = JSON.stringify(this.manifest, null, 2);
      await this.manifestFile.write(data);
    } catch (e) {
      console.error('[AudioCache] Failed to save manifest:', e);
    }
  }

  /**
   * LRU Eviction: если суммарный размер превышает maxSizeBytes,
   * удаляет наименее востребованные файлы (по lastAccessed / mtime).
   */
  async _enforceSizeLimit() {
    const entries = Object.entries(this.manifest).map(([id, data]) => ({
      id,
      ...data,
      accessScore: data.lastAccessed || data.mtime || 0,
    }));

    let currentTotal = entries.reduce((acc, e) => acc + (e.size || 0), 0);
    if (currentTotal <= this.maxSizeBytes) return;

    // Сортируем: старые первыми (наименьший accessScore)
    entries.sort((a, b) => a.accessScore - b.accessScore);

    let hasEvicted = false;
    for (const entry of entries) {
      if (currentTotal <= this.maxSizeBytes) break;
      if (this.protectedTrackIds.has(String(entry.id).trim())) {
        continue;
      }

      try {
        const file = new File(entry.uri);
        if (file.exists) {
          file.delete();
        }
      } catch {}

      delete this.manifest[entry.id];
      currentTotal -= entry.size || 0;
      hasEvicted = true;
    }

    if (hasEvicted) {
      await this._saveManifest();
    }
  }
}

function getMonotonicNow() {
  if (
    typeof globalThis !== 'undefined' &&
    globalThis.performance &&
    typeof globalThis.performance.now === 'function'
  ) {
    return globalThis.performance.now();
  }
  return Date.now();
}

function resolveInactivityTimeout(options) {
  if (
    Number.isFinite(options.inactivityTimeoutMs) &&
    options.inactivityTimeoutMs > 0
  ) {
    return options.inactivityTimeoutMs;
  }
  // Deprecated override: old callers/tests passed downloadTimeoutMs as a per-attempt timeout.
  if (
    Number.isFinite(options.downloadTimeoutMs) &&
    options.downloadTimeoutMs > 0
  ) {
    return options.downloadTimeoutMs;
  }
  return INACTIVITY_TIMEOUT_MS;
}

function generatePublicationNonce() {
  const time = Date.now().toString(36);
  let random = '';
  try {
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID) {
      random = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    }
  } catch {}
  if (!random) {
    random = Math.random().toString(36).slice(2, 10);
  }
  return `${time}${random}`.slice(0, 16);
}

const defaultAudioCache = new AudioCache();
export default defaultAudioCache;
