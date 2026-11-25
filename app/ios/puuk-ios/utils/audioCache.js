/** Version-bound foreground cache. Immutable, uniquely named manifest snapshots
 * are committed with SDK's synchronous rename-to-absent operation. No existing
 * manifest is overwritten, and no network capability is persisted. */
import { File, Directory, Paths } from 'expo-file-system';
import { getOfflineSession } from '../offline/session';
import { reserveCacheTransfer, setBudgetCache } from '../offline/budget';
import { acquirePlayable } from '../offline';
import { authFetch, addSessionListener } from '../shared/api/api';
import { mediaSession, hasOfflineSession, isMediaSessionCurrent, validateMediaUrl,
  boundedMediaOperation, monotonicNow, MediaDeliveryError } from '../shared/api/media';
export const CACHE_DIR_NAME = 'audio-cache';
export const MANIFEST_FILE_NAME = 'manifest.json'; // legacy, quarantined
export const TEMP_DIR_NAME = '.temp';
export const DEFAULT_MAX_SIZE_BYTES = 500 * 1024 * 1024;
export const INACTIVITY_TIMEOUT_MS = 15000;
export const DOWNLOAD_TIMEOUT_MS = INACTIVITY_TIMEOUT_MS;
export const TOTAL_TIMEOUT_MS = 120000;
export const RETRY_DELAYS_MS = [];
export const MAX_ATTEMPTS = 2;
export const SAFETY_MARGIN_BYTES = 50 * 1024 * 1024;
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

const hashPattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const keyOf = (s, id, version) => JSON.stringify([s.origin, s.userId, id, version]);
const safeDelete = file => { try { if (file?.exists) file.delete(); } catch {} };
// Metadata corruption detector, not an audio cryptographic checksum.
function checksum(text) { let n = 2166136261; for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619); return (n >>> 0).toString(16); }
export class AudioCache {
  constructor(options = {}) {
    this.cacheDir = new Directory(options.baseDir || Paths.document, options.cacheDirName || CACHE_DIR_NAME);
    this.tempDir = new Directory(this.cacheDir, TEMP_DIR_NAME);
    this.manifestFile = new File(this.cacheDir, MANIFEST_FILE_NAME);
    this.manifest = {};
    this.ongoingDownloads = new Map();
    this.maxSizeBytes = Math.min(options.maxSizeBytes || DEFAULT_MAX_SIZE_BYTES, DEFAULT_MAX_SIZE_BYTES);
    this.now = options.now || monotonicNow;
    this.session = options.session || mediaSession;
    this.sessionValid = options.sessionValid || hasOfflineSession;
    this.inactivityTimeoutMs = Math.min(options.inactivityTimeoutMs || INACTIVITY_TIMEOUT_MS, INACTIVITY_TIMEOUT_MS);
    this.totalTimeoutMs = Math.min(options.totalTimeoutMs || TOTAL_TIMEOUT_MS, TOTAL_TIMEOUT_MS);
    this.safetyMarginBytes = options.safetyMarginBytes ?? SAFETY_MARGIN_BYTES;
    this.protectedTrackIds = new Set();
    this.generation = 0;
    this.foreground = true;
    this.online = true;
    this.validated = new Map();
    this.isInitialized = false;
    this._initPromise = null;
    this._publication = Promise.resolve();
    this._sequence = 0;
    this._nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this._counter = 0;
    this.reservedBytes = 0;
    this.pinned = new Map();
    this.useOfflineBudget = options.useOfflineBudget === true;
  }
  revoke() {
    this.generation++;
    this.validated.clear();
    for (const r of this.ongoingDownloads.values()) r.cancel();
  }
  setForeground(active) { this.foreground = active; this.revoke(); }
  setOnline(online) { if (online && !this.online) this.validated.clear(); this.online = online; }
  setActiveTrackId(id) { this.activeTrackId = id; }
  setProtectedTrackIds(ids) { this.protectedTrackIds = new Set((ids || []).map(String)); }
  async init() {
    if (this.isInitialized) return this;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._runInit();
    try { return await this._initPromise; } finally { this._initPromise = null; }
  }
  _validEntry(e, key) {
    if (!e || e.verification !== 'bound-transfer-v1' || e.complete !== true || !uuidPattern.test(e.trackId) ||
      !hashPattern.test(e.contentVersion) || typeof e.userId !== 'string' || !e.userId ||
      e.size !== e.expectedLength || !Number.isSafeInteger(e.size) || e.size <= 0 || e.size > DEFAULT_MAX_SIZE_BYTES ||
      key !== keyOf(e, e.trackId, e.contentVersion) || typeof e.uri !== 'string' ||
      !e.uri.startsWith(`${this.cacheDir.uri.replace(/\/$/, '')}/object-`) || !/^object-[A-Za-z0-9.-]+\.mp3$/.test(e.uri.split('/').pop()) ||
      Object.keys(e).some(k => /source|headers|url|token/i.test(k))) return false;
    try { return new URL(e.origin).origin === e.origin && new File(e.uri).exists && new File(e.uri).size === e.size; } catch { return false; }
  }
  async _runInit() {
    this.cacheDir.create({ intermediates: true, idempotent: true });
    this.tempDir.create({ intermediates: true, idempotent: true });
    for (const file of this.tempDir.list()) safeDelete(file);
    const snapshots = this.cacheDir.list().filter(f => /^index-[0-9]+-[A-Za-z0-9-]+\.json$/.test(f.name));
    snapshots.sort((a, b) => Number(b.name.split('-')[1]) - Number(a.name.split('-')[1]));
    this.manifest = {};
    for (const f of snapshots) {
      try {
        if (f.size > 4 * 1024 * 1024) continue;
        const envelope = JSON.parse(await f.text());
        if (envelope.format !== 1 || typeof envelope.data !== 'string' || checksum(envelope.data) !== envelope.checksum || envelope.end !== 'complete') continue;
        const data = JSON.parse(envelope.data);
        if (!data || Array.isArray(data) || typeof data !== 'object') continue;
        this.manifest = Object.fromEntries(Object.entries(data).filter(([k, e]) => this._validEntry(e, k)));
        this._sequence = Number(f.name.split('-')[1]);
        break;
      } catch { /* incomplete/corrupt snapshot is never a cache hit */ }
    }
    const retained = new Set(Object.values(this.manifest).map(e => e.uri));
    for (const f of this.cacheDir.list()) {
      if (f.name === TEMP_DIR_NAME) continue;
      if (f.name === MANIFEST_FILE_NAME || /^index-.*\.json$/.test(f.name)) continue;
      if (!retained.has(f.uri)) safeDelete(f);
    }
    // Keep bounded recovery metadata. Legacy manifest is never loaded/relabelled.
    for (const f of snapshots.slice(2)) safeDelete(f);
    this.isInitialized = true;
    return this;
  }
  async prepareTrack(track, { signal, resolveTicket } = {}) {
    if (!this.online || !this.sessionValid()) return;
    const id = String(track?.id ?? track?.track_id ?? track), s = this.session(), generation = this.generation;
    const key = `${s.origin}|${s.userId}|${id}`;
    const validated = this.validated.get(key);
    if (validated && this.now() < validated.until && (!track?.content_version || track.content_version === validated.version))
      return this.getCachedUri(id);
    this.validated.delete(key);
    if (!Object.values(this.manifest).some(e =>
      e.origin === s.origin && e.userId === s.userId && e.trackId === id)) return;
    const current = () => !signal?.aborted && this.sessionValid() && this.online &&
      generation === this.generation && JSON.stringify(s) === JSON.stringify(this.session());
    try {
      const ticket = await resolveTicket?.();
      if (!current()) return;
      let version, until;
      if (ticket && !ticket.legacy) {
        if (ticket.trackId !== id || JSON.stringify(ticket.session) !== JSON.stringify(s)) return;
        const entry = this.manifest[keyOf(s, id, ticket.contentVersion)];
        if (entry && (!ticket.cacheable || entry.size !== ticket.contentLength)) return;
        version = ticket.contentVersion;
        until = Math.min(ticket.reuseUntil, ticket.usableUntil);
      } else {
        // Older servers do not include the content version in the ticket.
        const dto = await boundedMediaOperation(async requestSignal => {
          const response = await authFetch(`/api/tracks/${id}?credits_only=true`, { retry: 0, timeout: 3000, signal: requestSignal, cache: 'no-store' });
          if (!response.ok) { if ([404, 410].includes(response.status)) return { content_version: null }; throw new MediaDeliveryError('metadata', response.status); }
          return response.json();
        }, { signal, timeout: 3000 });
        if (!current()) return;
        version = dto.content_version ?? null;
        until = this.now() + 30000;
      }
      this.validated.set(key, { version, until });
      while (this.validated.size > 200) this.validated.delete(this.validated.keys().next().value);
      for (const [k, e] of Object.entries(this.manifest)) if (e.origin === s.origin && e.userId === s.userId && e.trackId === id && e.trackId !== this.activeTrackId && !this.pinned.has(e.uri) && e.contentVersion !== version) {
        safeDelete(new File(e.uri)); delete this.manifest[k];
      }
      return this.getCachedUri(id);
    } catch { /* no metadata proof => online cache remains inaccessible */ }
  }
  getCachedUri(track, expectedVersion = track?.content_version) {
    if (!this.isInitialized || !this.sessionValid()) return null;
    const id = String(track?.id ?? track?.track_id ?? track), s = this.session();
    const proof = this.validated.get(`${s.origin}|${s.userId}|${id}`);
    const version = proof && this.now() < proof.until ? proof.version : null;
    if (this.online && (!version || (expectedVersion && version !== expectedVersion))) return null;
    const selectedVersion = this.online ? version : expectedVersion;
    const key = selectedVersion ? keyOf(s, id, selectedVersion) :
      Object.keys(this.manifest).find(k => {
        const e = this.manifest[k];
        return e.origin === s.origin && e.userId === s.userId && e.trackId === id;
      });
    const entry = this.manifest[key];
    if (!entry) return null;
    if (!this._validEntry(entry, key)) { delete this.manifest[key]; return null; }
    entry.lastAccessed = Date.now();
    return entry.uri;
  }
  isCached(id) { return !!this.getCachedUri(id); }
  getDownloadState(id) { const r = this.ongoingDownloads.get(String(id)); return r ? { status: r.cancelled ? 'cancelled' : 'downloading', promise: r.promise } : null; }
  isDownloading(id) { return this.getDownloadState(id)?.status === 'downloading'; }
  getOngoingPromise(id) { return this.ongoingDownloads.get(String(id))?.promise || null; }
  getOrFetch(trackId, descriptor, options = {}) {
    const id = String(trackId);
    const existing = this.ongoingDownloads.get(id);
    const s = this.session(), generation = this.generation;
    const identity = keyOf(s || {}, id, descriptor?.contentVersion);
    if (existing) return identity === existing.identity && generation === existing.generation
      ? existing.publicPromise || existing.promise
      : Promise.reject(new MediaDeliveryError('busy'));
    if (!this.foreground || this.ongoingDownloads.size >= 2) return Promise.reject(new MediaDeliveryError('busy'));
    let controller = new AbortController();
    const r = { identity, generation, cancelled: false, task: null, promise: null, cancel: () => { r.cancelled = true; controller.abort(); try { r.task?.cancel(); } catch {} } };
    const stale = () => r.cancelled || options.signal?.aborted || !this.foreground || !this.sessionValid() || generation !== this.generation || JSON.stringify(s) !== JSON.stringify(this.session());
    const guard = () => { if (stale()) throw createCancelledError(); };
    const cancel = () => r.cancel();
    options.signal?.addEventListener('abort', cancel, { once: true });
    let rejectPublic;
    const aborted = new Promise((_, reject) => { rejectPublic = reject; });
    const originalCancel = r.cancel;
    r.cancel = () => { originalCancel(); rejectPublic(createCancelledError()); };
    r.promise = (async () => {
      await this.init(); guard();
      for (let attempt = 0; attempt < 2; attempt++) {
        controller = new AbortController();
        const deadline = this.now() + this.totalTimeoutMs;
        let temp, final, task, timer, inactivity, admissionTimer, globalReservation, reserved = 0, bytes = 0, failed = false;
        const expire = () => { failed = true; r.cancelled = true; rejectPublic(new MediaDeliveryError('timeout')); controller.abort(); try { task?.cancel(); } catch {} };
        const check = () => { guard(); if (failed || this.now() >= deadline) throw new MediaDeliveryError('timeout'); };
        try {
          if (attempt) {
            if (!options.resolveFresh) throw new MediaDeliveryError('download');
            descriptor = await boundedMediaOperation(() => options.resolveFresh(), { signal: controller.signal, timeout: 3000 }); guard();
          }
          const d = descriptor;
          if (!d?.cacheable || d.trackId !== id || !hashPattern.test(d.contentVersion) || !Number.isSafeInteger(d.contentLength) || d.contentLength <= 0 || d.contentLength > this.maxSizeBytes ||
            JSON.stringify(d.session) !== JSON.stringify(s) || this.now() >= d.reuseUntil ||
            d.downloadBinding !== (d.delivery === 'cdn' ? 'immutable-path' : 'if-match')) throw new MediaDeliveryError('stream_only');
          validateMediaUrl(d.uri, { origin: s.origin, trackId: id, delivery: d.delivery, contentVersion: d.contentVersion });
          if (this.useOfflineBudget) {
            const session = getOfflineSession();
            const durable = await acquirePlayable(session, id, d.contentVersion);
            if (durable) {
              durable.release();
              guard();
              return durable.uri;
            }
            globalReservation = await reserveCacheTransfer(session, s, id, d.contentVersion, d.contentLength, () => !stale());
            if (!globalReservation) throw new MediaDeliveryError('space');
            check();
          } else if (Paths.availableDiskSpace < d.contentLength + this.safetyMarginBytes) {
            throw new MediaDeliveryError('space');
          }
          // Reserve aggregate bytes before native IO; two concurrent transfers
          // cannot each consume the full cache capacity. Evict across namespaces.
          const reservation = this._publication.catch(() => {}).then(() => {
            check();
            let total = Object.values(this.manifest).reduce((n, e) => n + e.size, 0) + this.reservedBytes + d.contentLength;
            for (const [key, e] of Object.entries(this.manifest).sort((a,b) => a[1].lastAccessed - b[1].lastAccessed)) {
              if (total <= this.maxSizeBytes) break;
              if (this.pinned.has(e.uri) || e.trackId === this.activeTrackId || this.protectedTrackIds.has(e.trackId)) continue;
              safeDelete(new File(e.uri)); delete this.manifest[key]; total -= e.size;
            }
            if (total > this.maxSizeBytes) throw new MediaDeliveryError('space');
            this.reservedBytes += d.contentLength; reserved = d.contentLength;
          });
          this._publication = reservation;
          await reservation; check();
          const name = `${this._nonce}-${++this._counter}`;
          temp = new File(this.tempDir, `object-${name}.part`);
          final = new File(this.cacheDir, `object-${name}.mp3`);
          globalReservation?.setFiles(temp, final);
          // CDN gets a new EMPTY object; direct conditional GET binds the bytes.
          const headers = d.delivery === 'cdn' ? {} : { 'If-Match': `"sha256-${d.contentVersion}"` };
          timer = setTimeout(expire, this.totalTimeoutMs);
          const arm = () => { clearTimeout(inactivity); inactivity = setTimeout(expire, this.inactivityTimeoutMs); };
          arm();
          task = File.createDownloadTask(d.uri, temp, { headers, signal: controller.signal, sessionType: 'foreground', onProgress: p => {
            if (stale() || failed) return;
            if (Number.isFinite(p.bytesWritten) && p.bytesWritten > bytes) {
              bytes = p.bytesWritten;
              globalReservation?.recordProgress(bytes);
              arm();
            }
          } });
          r.task = task;
          // Retain slot/temp until the actual SDK promise ends, even after abort.
          const result = await task.downloadAsync();
          check(); clearTimeout(inactivity);
          if (!result || result.uri !== temp.uri || !result.exists || result.size !== d.contentLength) throw new MediaDeliveryError('partial');
          const admissionDeadline = Math.min(deadline, this.now() + 5000);
          admissionTimer = setTimeout(expire, Math.max(1, admissionDeadline - this.now()));
          await result.move(final, { overwrite: false });
          check();
          if (!final.exists || final.size !== d.contentLength) throw new MediaDeliveryError('partial');
          const entry = { origin: s.origin, userId: s.userId, trackId: id, contentVersion: d.contentVersion,
            uri: final.uri, size: d.contentLength, expectedLength: d.contentLength, mime: 'audio/mpeg',
            verification: 'bound-transfer-v1', complete: true, lastAccessed: Date.now() };
          await this._publish(keyOf(s, id, d.contentVersion), entry, () => { check(); if (this.now() >= admissionDeadline) throw new MediaDeliveryError('timeout'); });
          check();
          this.validated.set(`${s.origin}|${s.userId}|${id}`, { version: d.contentVersion, until: this.now() + 30000 });
          while (this.validated.size > 200) this.validated.delete(this.validated.keys().next().value);
          return final.uri;
        } catch (error) {
          safeDelete(temp); safeDelete(final);
          if (stale()) throw createCancelledError();
          // Native SDK errors have no supported status accessor. Fresh resolution
          // is the only bounded retry, including a possible precondition failure.
          if (attempt || !options.resolveFresh || ['stream_only', 'space'].includes(error?.code) || error?.terminal) throw new MediaDeliveryError(error instanceof MediaDeliveryError ? error.code : 'download');
        } finally { globalReservation?.release(); this.reservedBytes -= reserved; clearTimeout(timer); clearTimeout(inactivity); clearTimeout(admissionTimer); try { task?.release?.(); } catch {} r.task = null; }
      }
      throw new MediaDeliveryError('download');
    })().finally(() => { options.signal?.removeEventListener('abort', cancel); if (this.ongoingDownloads.get(id) === r) this.ongoingDownloads.delete(id); });
    this.ongoingDownloads.set(id, r);
    const publicPromise = Promise.race([r.promise, aborted]);
    publicPromise.settled = r.promise.then(() => {}, () => {});
    r.publicPromise = publicPromise;
    return publicPromise;
  }
  _publish(key, entry, guard = () => {}) {
    const operation = this._publication.catch(() => {}).then(async () => {
      guard();
      const next = { ...this.manifest, [key]: entry };
      let total = Object.values(next).reduce((n, e) => n + e.size, 0);
      const evict = [];
      for (const [k, e] of Object.entries(next).sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)) {
        if (total <= this.maxSizeBytes) break;
        if (k === key || this.pinned.has(e.uri) || e.trackId === this.activeTrackId || this.protectedTrackIds.has(e.trackId)) continue;
        delete next[k]; total -= e.size; evict.push(e.uri);
      }
      if (total > this.maxSizeBytes) throw new MediaDeliveryError('space');
      if (Object.keys(next).length > 4096) throw new MediaDeliveryError('space');
      const data = JSON.stringify(next);
      const pending = new File(this.tempDir, `index-${this._nonce}-${++this._counter}.part`);
      const name = `index-${++this._sequence}-${this._nonce}-${this._counter}.json`;
      try {
        pending.write(JSON.stringify({ format: 1, data, checksum: checksum(data), end: 'complete' }));
        const readback = JSON.parse(await pending.text());
        if (readback.data !== data || readback.checksum !== checksum(data)) throw new MediaDeliveryError('manifest');
        guard();
        // SDK rename is synchronous, refuses existing destination, same directory.
        // Stage in cacheDir via async move; only the final rename is the commit.
        const staged = new File(this.cacheDir, `${name}.part`);
        await pending.move(staged, { overwrite: false });
        try {
          guard();
          staged.rename(name); // no await: revocation cannot interleave here
          this.manifest = next;
        } catch (e) { safeDelete(staged); throw e; }
        for (const uri of evict) safeDelete(new File(uri));
        const indexes = this.cacheDir.list().filter(f => /^index-.*\.json$/.test(f.name)).sort((a, b) => Number(b.name.split('-')[1]) - Number(a.name.split('-')[1]));
        for (const f of indexes.slice(2)) safeDelete(f);
      } finally { safeDelete(pending); }
    });
    this._publication = operation;
    return operation;
  }
  cancel(id) { this.ongoingDownloads.get(String(id))?.cancel(); }
  async invalidate(id, expectedUri) {
    const s = this.session();
    for (const [key, e] of Object.entries(this.manifest)) if (e.origin === s.origin && e.userId === s.userId && e.trackId === String(id) && (!expectedUri || e.uri === expectedUri)) { safeDelete(new File(e.uri)); delete this.manifest[key]; }
  }
  remove(id) { this.cancel(id); return this.invalidate(id); }
  borrowVersion(owner, trackId, contentVersion) {
    const key = keyOf(owner, String(trackId), contentVersion);
    const entry = this.manifest[key];
    if (!this._validEntry(entry, key)) return null;
    const uri = entry.uri;
    this.pinned.set(uri, (this.pinned.get(uri) || 0) + 1);
    let released = false;
    return {
      file: new File(uri),
      discard: () => {
        if (released || this.pinned.get(uri) !== 1 || this.activeTrackId === entry.trackId ||
            this.manifest[key]?.uri !== uri) return;
        const file = new File(uri);
        safeDelete(file);
        if (!file.exists) delete this.manifest[key];
      },
      release: () => {
        if (released) return;
        released = true;
        const remaining = this.pinned.get(uri) - 1;
        if (remaining) this.pinned.set(uri, remaining);
        else this.pinned.delete(uri);
      },
    };
  }
  budgetFiles() {
    const sizes = new Map();
    for (const dir of [this.cacheDir, this.tempDir]) {
      if (!dir.exists) continue;
      for (const file of dir.list()) {
        if (file instanceof File && file.exists) sizes.set(file.uri, Number(file.size) || 0);
      }
    }
    return sizes;
  }
  async evictForBudget(fits, { clear = false } = {}) {
    await this._evict(fits, clear);
  }
  async _evict(fits, ignoreProtectedTracks) {
    await this.init();
    const operation = this._publication.catch(() => {}).then(() => {
      let freedBytes = 0;
      let failedFiles = 0;
      for (const [key, entry] of Object.entries(this.manifest).sort((a, b) =>
        a[1].lastAccessed - b[1].lastAccessed)) {
        if (fits(freedBytes)) break;
        if (this.pinned.has(entry.uri) || this.activeTrackId === entry.trackId ||
            (!ignoreProtectedTracks && this.protectedTrackIds.has(entry.trackId))) continue;
        const file = new File(entry.uri);
        const bytes = file.exists ? Number(file.size) || 0 : 0;
        safeDelete(file);
        if (file.exists) {
          failedFiles++;
          continue;
        }
        delete this.manifest[key];
        freedBytes += bytes;
      }
      return { freedBytes, failedFiles };
    });
    this._publication = operation;
    return operation;
  }
  async clear() {
    this.revoke();
    return this._evict(() => false, true);
  }
  async getSize() { await this.init(); return Object.values(this.manifest).reduce((n, e) => n + e.size, 0); }
  async setMaxSize(size) { this.maxSizeBytes = Math.min(size, DEFAULT_MAX_SIZE_BYTES); }
}
const defaultAudioCache = new AudioCache({ useOfflineBudget: true });
setBudgetCache({
  files: () => defaultAudioCache.budgetFiles(),
  evict: fits => defaultAudioCache.evictForBudget(fits, { clear: true }),
});
if (typeof addSessionListener === 'function') addSessionListener(() => defaultAudioCache.revoke());
export default defaultAudioCache;
