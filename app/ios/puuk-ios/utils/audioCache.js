/**
 * Persistent audio cache using expo-file-system.
 * Stores audio files locally to avoid repeated downloads.
 * Implements deduplication, retry/timeout, LRU cleanup by lastAccessed/mtime,
 * atomic download via temp file + rename/move, manifest tracking, and task cancellation.
 */

import { File, Directory, Paths } from 'expo-file-system';

export const CACHE_DIR_NAME = 'audio-cache';
export const MANIFEST_FILE_NAME = 'manifest.json';
export const TEMP_DIR_NAME = '.temp';
export const DEFAULT_MAX_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
export const DOWNLOAD_TIMEOUT_MS = 45000; // 45s per attempt
export const RETRY_DELAYS_MS = [800, 2000]; // 2 retries (total 3 attempts)
export const SAFETY_MARGIN_BYTES = 50 * 1024 * 1024; // 50 MB safety margin

export class AudioCache {
  constructor(options = {}) {
    const baseDir = options.baseDir || Paths.document;
    this.cacheDir = new Directory(baseDir, options.cacheDirName || CACHE_DIR_NAME);
    this.tempDir = new Directory(this.cacheDir, options.tempDirName || TEMP_DIR_NAME);
    this.manifestFile = new File(this.cacheDir, options.manifestFileName || MANIFEST_FILE_NAME);
    this.manifest = {}; // [trackId]: { uri, size, mtime, lastAccessed }
    this.ongoingDownloads = new Map(); // trackId => { promise, task, tempFile, cancelled, generation }
    this.downloadGenerations = new Map(); // trackId => number
    this.maxSizeBytes = options.maxSizeBytes || DEFAULT_MAX_SIZE_BYTES;
    this.downloadTimeoutMs = options.downloadTimeoutMs || DOWNLOAD_TIMEOUT_MS;
    this.safetyMarginBytes = options.safetyMarginBytes || SAFETY_MARGIN_BYTES;
    this.isInitialized = false;
    this._saveManifestTimeout = null;
    this.protectedTrackIds = new Set();
  }

  /**
   * Устанавливает ID треков, защищённых от LRU вытеснения (текущий трек, очередь).
   * @param {Array<string|number>} ids
   */
  setProtectedTrackIds(ids) {
    this.protectedTrackIds = new Set((ids || []).map(id => String(id).trim()));
  }

  /**
   * Инициализирует кеш: создаёт директории, загружает manifest,
   * валидирует наличие файлов на диске и очищает временную директорию.
   */
  async init() {
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
    if (!entry || typeof entry !== 'object' || typeof entry.uri !== 'string') return null;

    const uri = entry.uri.trim();

    // 1. Проверяем валидность file:// схемы
    if (!uri.startsWith('file://')) {
      console.warn(`[AudioCache] Invalid non-file URI in manifest for track ${trackIdStr}: ${uri}`);
      delete this.manifest[trackIdStr];
      this._scheduleSaveManifest();
      return null;
    }

    // 2. Исключаем устаревший .audio формат и временные файлы
    if (uri.endsWith('.audio') || uri.includes('.part') || uri.includes('/.temp/')) {
      console.warn(`[AudioCache] Cleaning up invalid/legacy format file in manifest: ${uri}`);
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
        console.warn(`[AudioCache] file.exists check failed for ${uri}:`, err?.message);
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
        console.warn(`[AudioCache] file.size check failed for ${uri}:`, err?.message);
        size = 0;
      }

      if (size > 0) {
        entry.lastAccessed = Date.now();
        this._scheduleSaveManifest();
        return file.uri;
      }

      // Файл пустой (0 байт) — удаляем
      console.warn(`[AudioCache] Cached file for track ${trackIdStr} has 0 bytes, removing: ${uri}`);
      try {
        file.delete();
      } catch {}
      delete this.manifest[trackIdStr];
      this._scheduleSaveManifest();
      return null;
    } catch (err) {
      console.error(`[AudioCache] getCachedUri unexpected error for track ${trackIdStr}:`, err);
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
    return (record && record.promise && !record.cancelled) ? record.promise : null;
  }

  /**
   * Возвращает file:// URI для трека:
   * 1. Если уже в кеше — возвращает готовый URI.
   * 2. Если загрузка уже идёт — возвращает существующий Promise (deduplication).
   * 3. Иначе запускает атомарную загрузку с таймаутом и повторными попытками.
   *
   * @param {string|number} trackId
   * @param {string} remoteUri
   * @param {Object} [options]
   * @param {Record<string, string>} [options.headers]
   * @param {AbortSignal} [options.signal]
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
      if (options.signal) {
        if (options.signal.aborted) {
          const err = new Error('Download cancelled');
          err.name = 'AbortError';
          return Promise.reject(err);
        }
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            const err = new Error('Download cancelled');
            err.name = 'AbortError';
            reject(err);
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

    // 3. Создаём запись и регистрируем промис сразу
    const generation = (this.downloadGenerations.get(trackIdStr) || 0) + 1;
    this.downloadGenerations.set(trackIdStr, generation);

    const downloadRecord = {
      promise: null,
      task: null,
      tempFile: null,
      cancelled: false,
      generation,
    };

    const promise = (async () => {
      if (!this.isInitialized) {
        await this.init();
      }

      // Повторная проверка кеша после init()
      const cachedAfterInit = this.getCachedUri(trackIdStr);
      if (cachedAfterInit) {
        return cachedAfterInit;
      }

      this._checkDiskSpace();

      try {
        const fileUri = await this._downloadWithRetry(trackIdStr, remoteUri, options, downloadRecord);
        return fileUri;
      } finally {
        const current = this.ongoingDownloads.get(trackIdStr);
        if (current?.promise === promise) {
          this.ongoingDownloads.delete(trackIdStr);
        }
      }
    })();

    downloadRecord.promise = promise;
    this.ongoingDownloads.set(trackIdStr, downloadRecord);

    return promise;
  }

  /**
   * Отменяет активную загрузку трека.
   * @param {string|number} trackId
   */
  cancel(trackId) {
    const trackIdStr = String(trackId);
    this.downloadGenerations.set(trackIdStr, (this.downloadGenerations.get(trackIdStr) || 0) + 1);

    const record = this.ongoingDownloads.get(trackIdStr);
    if (!record) return;

    record.cancelled = true;
    try {
      if (record.task && typeof record.task.cancel === 'function') {
        record.task.cancel();
      }
    } catch (e) {
      // Игнорируем ошибки отмены уже завершённой задачи
    }
    try {
      if (record.task && typeof record.task.release === 'function') {
        record.task.release();
      }
    } catch {}

    try {
      if (record.tempFile && record.tempFile.exists) {
        record.tempFile.delete();
      }
    } catch {}

    this.ongoingDownloads.delete(trackIdStr);
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
      await this._saveManifest();
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

    try {
      if (this.cacheDir.exists) {
        this.cacheDir.delete();
      }
    } catch {}

    this.manifest = {};
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

  _checkDiskSpace() {
    try {
      const available = Paths.availableDiskSpace;
      if (typeof available === 'number' && available < this.safetyMarginBytes) {
        console.warn(`[AudioCache] Low disk space: ${available} bytes available`);
      }
    } catch {}
  }

  async _downloadWithRetry(trackIdStr, remoteUri, options, record, attempt = 0) {
    if (
      record?.cancelled ||
      options.signal?.aborted ||
      this.downloadGenerations.get(trackIdStr) !== record?.generation
    ) {
      throw new Error('Download cancelled');
    }

    try {
      return await this._downloadAttempt(trackIdStr, remoteUri, options, record);
    } catch (err) {
      if (
        record?.cancelled ||
        options.signal?.aborted ||
        this.downloadGenerations.get(trackIdStr) !== record?.generation
      ) {
        throw new Error('Download cancelled');
      }

      if (attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt];
        await new Promise(resolve => setTimeout(resolve, delay));
        return this._downloadWithRetry(trackIdStr, remoteUri, options, record, attempt + 1);
      }

      throw err;
    }
  }

  async _downloadAttempt(trackIdStr, remoteUri, options, record) {
    const generation = record?.generation ?? this.downloadGenerations.get(trackIdStr) ?? 0;
    const tempFileName = `${trackIdStr}_${Date.now()}.part.mp3`;
    const tempFile = new File(this.tempDir, tempFileName);
    // Уникальный final-путь на поколение загрузки: отменённая/устаревшая задача
    // физически не может перезаписать или удалить файл более новой загрузки.
    const finalFile = new File(this.cacheDir, `${trackIdStr}_${generation}.mp3`);

    if (record) {
      record.tempFile = tempFile;
    }

    const downloadTask = File.createDownloadTask(remoteUri, tempFile, {
      headers: options.headers,
    });

    if (record) {
      record.task = downloadTask;
    }

    // Слушатель сигнала отмены через options.signal
    let abortListener = null;
    if (options.signal) {
      abortListener = () => {
        try {
          downloadTask.cancel();
        } catch {}
      };
      options.signal.addEventListener('abort', abortListener, { once: true });
    }

    // Таймаут загрузки
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        try {
          downloadTask.cancel();
        } catch {}
        reject(new Error(`Download timeout after ${this.downloadTimeoutMs}ms`));
      }, this.downloadTimeoutMs);
    });

    try {
      const downloadedFile = await Promise.race([
        downloadTask.downloadAsync(),
        timeoutPromise,
      ]);

      clearTimeout(timeoutId);

      if (
        record?.cancelled ||
        options.signal?.aborted ||
        this.downloadGenerations.get(trackIdStr) !== record?.generation
      ) {
        throw new Error('Download cancelled');
      }

      if (!downloadedFile || !tempFile.exists) {
        throw new Error('Downloaded file missing or empty');
      }

      const info = tempFile.info ? tempFile.info() : { size: tempFile.size };
      const size = info?.size ?? tempFile.size ?? 0;
      if (size <= 0) {
        throw new Error('Downloaded file has 0 bytes');
      }

      // Проверка актуальности поколения перед перемещением файла
      if (
        record?.cancelled ||
        options.signal?.aborted ||
        this.downloadGenerations.get(trackIdStr) !== record?.generation
      ) {
        throw new Error('Download cancelled');
      }

      // Атомарное перемещение tempFile -> finalFile (уникальный путь для этого поколения)
      // Удаляем только возможный orphan от предыдущего запуска, где счётчик поколений начинался заново.
      if (finalFile.exists) {
        try {
          finalFile.delete();
        } catch {}
      }
      await tempFile.move(finalFile);

      // Повторная проверка актуальности поколения ПОСЛЕ асинхронного перемещения файла
      if (
        record?.cancelled ||
        options.signal?.aborted ||
        this.downloadGenerations.get(trackIdStr) !== record?.generation
      ) {
        try {
          if (finalFile.exists) {
            finalFile.delete();
          }
        } catch {}
        throw new Error('Download cancelled');
      }

      // Отмена могла произойти после move-проверки, но до публикации записи.
      if (
        record?.cancelled ||
        options.signal?.aborted ||
        this.downloadGenerations.get(trackIdStr) !== record?.generation
      ) {
        try {
          if (finalFile.exists) finalFile.delete();
        } catch {}
        throw new Error('Download cancelled');
      }

      const previousUri = this.manifest[trackIdStr]?.uri;
      const now = Date.now();
      this.manifest[trackIdStr] = {
        uri: finalFile.uri,
        size,
        mtime: now,
        lastAccessed: now,
      };

      await this._saveManifest();

      // Не оставляем в manifest результат, если отмена случилась во время его записи.
      if (
        record?.cancelled ||
        options.signal?.aborted ||
        this.downloadGenerations.get(trackIdStr) !== record?.generation
      ) {
        if (this.manifest[trackIdStr]?.uri === finalFile.uri) {
          delete this.manifest[trackIdStr];
          await this._saveManifest();
        }
        try {
          if (finalFile.exists) finalFile.delete();
        } catch {}
        throw new Error('Download cancelled');
      }

      // Убираем предыдущий файл только после публикации нового и если он больше не используется.
      if (previousUri && previousUri !== finalFile.uri && this.manifest[trackIdStr]?.uri !== previousUri) {
        try {
          const previousFile = new File(previousUri);
          if (previousFile.exists) previousFile.delete();
        } catch {}
      }

      await this._enforceSizeLimit();

      return finalFile.uri;
    } catch (error) {
      try {
        if (tempFile.exists) {
          tempFile.delete();
        }
      } catch {}
      throw error;
    } finally {
      clearTimeout(timeoutId);
      if (options.signal && abortListener) {
        options.signal.removeEventListener('abort', abortListener);
      }
      try {
        downloadTask.release();
      } catch {}
    }
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
        if (!entry?.uri || typeof entry.uri !== 'string' || !entry.uri.startsWith('file://')) {
          delete this.manifest[id];
          hasChanges = true;
          continue;
        }
        try {
          if (entry.uri.endsWith('.audio') || entry.uri.includes('.part') || entry.uri.includes('/.temp/')) {
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

  _scheduleSaveManifest() {
    if (this._saveManifestTimeout) return;
    this._saveManifestTimeout = setTimeout(() => {
      this._saveManifestTimeout = null;
      this._saveManifest().catch(() => {});
    }, 500);
  }

  async _saveManifest() {
    try {
      const data = JSON.stringify(this.manifest, null, 2);
      this.manifestFile.write(data);
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

const defaultAudioCache = new AudioCache();
export default defaultAudioCache;
