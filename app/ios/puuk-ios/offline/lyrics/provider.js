import {
  extractPlainLyrics, isLrcSynced, parseLrc,
} from '../../utils/lrcParser';
import { validateAndParseWordLyrics } from '../../components/fullplayer/lyrics/wordLyricsParser';

const UNKNOWN = Object.freeze({ state: 'unknown' });
const EMPTY = Object.freeze({ lines: [], plainText: '', isSynced: false, hasWords: false });
const SHA256 = /^[a-f0-9]{64}$/;
const hasText = value => typeof value === 'string' && value.trim().length > 0;

function parsePayload(payload, trackId, version) {
  const word = validateAndParseWordLyrics(payload?.wordLyrics, trackId);
  if (word && (!version || payload.wordLyrics.audioSha256.toLowerCase() === version)) {
    return {
      lines: word.lines,
      plainText: hasText(payload.plainLyrics)
        ? payload.plainLyrics : word.lines.map(line => line.text).join('\n'),
      isSynced: true,
      hasWords: true,
    };
  }

  const raw = [payload?.syncedLyrics, payload?.lyrics, payload?.plainLyrics].find(hasText);
  if (!raw) return EMPTY;
  const lines = parseLrc(raw);
  const plainText = hasText(payload.plainLyrics) ? payload.plainLyrics : extractPlainLyrics(raw);
  if (!hasText(plainText) && !lines.some(line => hasText(line.text))) return EMPTY;
  return {
    lines,
    plainText,
    isSynced: raw === payload.syncedLyrics || (payload.isSynced ?? isLrcSynced(raw)),
    hasWords: false,
  };
}

export function parseLyricsResult(result, trackId) {
  if (result?.state !== 'ready') return EMPTY;
  return parsePayload(result.payload, trackId, result.contentVersion);
}

function classifyPayload(payload, parsed) {
  if (parsed !== EMPTY) return 'ready';
  // Both "empty" and "failed" can follow a failed provider lookup on legacy brain.
  if (payload?.lyricsStatus === 'absent' && !payload.wordLyrics &&
      ![payload.lyrics, payload.syncedLyrics, payload.plainLyrics].some(hasText)) return 'absent';
  return 'unknown';
}

function matchesKey(session, key, trackId, version) {
  return Boolean(session?.owner && key?.owner && key.owner.origin === session.owner.origin &&
    key.owner.userId === session.owner.userId && String(key.trackId) === String(trackId) &&
    SHA256.test(key.contentVersion) && (!version || version === key.contentVersion));
}

function requestKey(session, trackId, version, authGeneration, persisted) {
  return JSON.stringify([
    session?.owner.origin, session?.owner.userId, session?.activationId,
    session?.generation, authGeneration, trackId, version, persisted,
  ]);
}

export function createLyricsProvider({
  readMediaKey, readLyrics, saveLyricsResult, isOfflineSessionCurrent,
  fetchLyrics, fetchContentVersion, getAuthGeneration,
}) {
  const requests = new Map();

  function shareRequest(key, signal, work) {
    if (signal?.aborted) return Promise.resolve(UNKNOWN);
    let entry = requests.get(key);
    if (!entry || entry.controller.signal.aborted) {
      entry = { controller: new AbortController(), consumers: 0 };
      requests.set(key, entry);
      const request = entry;
      request.promise = Promise.resolve().then(() => work(request.controller.signal))
        .catch(() => UNKNOWN).finally(() => {
          if (requests.get(key) === request) requests.delete(key);
        });
    }
    entry.consumers += 1;

    // A screen closing must not abort a refresh also owned by the publisher.
    return new Promise(resolve => {
      const release = result => {
        signal?.removeEventListener('abort', onAbort);
        entry.consumers -= 1;
        resolve(result);
      };
      const onAbort = () => {
        release(UNKNOWN);
        if (entry.consumers === 0) entry.controller.abort();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(result => {
        if (!signal?.aborted) release(result);
      });
    });
  }

  async function getMediaKey(session, trackId, version) {
    if (!session || !isOfflineSessionCurrent(session)) return null;
    const key = await readMediaKey(session, trackId, version).catch(() => null);
    return isOfflineSessionCurrent(session) && matchesKey(session, key, trackId, version) ? key : null;
  }

  function refreshLyrics(session, mediaKey, { signal } = {}) {
    const { trackId, contentVersion } = mediaKey ?? {};
    if (!matchesKey(session, mediaKey, trackId) || !isOfflineSessionCurrent(session)) {
      return Promise.resolve(UNKNOWN);
    }
    const generation = getAuthGeneration();
    const key = requestKey(session, String(trackId), contentVersion, generation, true);
    return shareRequest(key, signal, async requestSignal => {
      const current = () => !requestSignal.aborted && getAuthGeneration() === generation &&
        isOfflineSessionCurrent(session);
      if (!current() || !await getMediaKey(session, trackId, contentVersion) || !current()) return UNKNOWN;

      const payload = await fetchLyrics(trackId, requestSignal);
      if (!current()) return UNKNOWN;
      const parsed = parsePayload(payload, trackId, contentVersion);
      const state = classifyPayload(payload, parsed);
      if (state === 'unknown') return UNKNOWN;

      // Contract v1 binds word timings directly to audio. Legacy responses
      // need confirmation from track metadata before they can be saved.
      if (!parsed.hasWords && await fetchContentVersion(trackId, requestSignal) !== contentVersion) return UNKNOWN;
      if (!current() || !await getMediaKey(session, trackId, contentVersion) || !current()) return UNKNOWN;

      const checkedAt = Date.now();
      const result = state === 'absent' ? { state, checkedAt } : {
        state, payload, checkedAt,
        ...(parsed.hasWords ? { lyricsRevision: payload.wordLyrics.revision } : {}),
      };
      await saveLyricsResult(session, mediaKey, result).catch(() => false);
      return current() ? { ...result, contentVersion } : UNKNOWN;
    });
  }

  async function readSelectedLyrics(session, trackId, version, { signal } = {}) {
    const generation = getAuthGeneration();
    const current = () => !signal?.aborted && generation === getAuthGeneration() &&
      (!session || isOfflineSessionCurrent(session));
    if (!current()) return UNKNOWN;

    const mediaKey = await getMediaKey(session, trackId, version);
    if (!current()) return UNKNOWN;
    if (mediaKey) {
      const local = await readLyrics(session, mediaKey).catch(() => UNKNOWN);
      if (!current()) return UNKNOWN;
      const selectedKey = await getMediaKey(session, trackId, version);
      if (!current() || selectedKey?.contentVersion !== mediaKey.contentVersion) return UNKNOWN;
      if (local?.state === 'absent' ||
          (local?.state === 'ready' && parsePayload(local.payload, trackId, mediaKey.contentVersion) !== EMPTY)) {
        return { ...local, contentVersion: mediaKey.contentVersion };
      }
      const result = await refreshLyrics(session, mediaKey, { signal });
      const latestKey = await getMediaKey(session, trackId, version);
      return current() && latestKey?.contentVersion === mediaKey.contentVersion ? result : UNKNOWN;
    }

    const key = requestKey(session, trackId, version, generation, false);
    const result = await shareRequest(key, signal, async requestSignal => {
      if (requestSignal.aborted || !current()) return UNKNOWN;
      const payload = await fetchLyrics(trackId, requestSignal);
      const state = classifyPayload(payload, parsePayload(payload, trackId, version));
      return state === 'ready' ? { state, payload, contentVersion: version } : { state };
    });
    return current() ? result : UNKNOWN;
  }

  return { readSelectedLyrics, refreshLyrics };
}
