import { authorizedFetch, isTrustedApiOrigin } from './client';

// Авторизованные медиа (обложки, аудио): backend отдаёт их только с Bearer JWT,
// поэтому <img src> / audio.src получают одноразовый blob: URL, а не ссылку с токеном.
const CACHE_LIMIT = 120;

const objectUrlBySource = new Map<string, string>();
const sourceByObjectUrl = new Map<string, string>();
let currentAudioObjectUrl: string | null = null;

export function resolveMediaSource(objectUrl: string): string {
  return sourceByObjectUrl.get(objectUrl) ?? objectUrl;
}

function revokeObjectUrl(objectUrl: string): void {
  const source = sourceByObjectUrl.get(objectUrl);
  if (source !== undefined) {
    sourceByObjectUrl.delete(objectUrl);
    if (objectUrlBySource.get(source) === objectUrl) {
      objectUrlBySource.delete(source);
    }
  }
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(objectUrl);
  }
}

function rememberObjectUrl(sourceUrl: string, objectUrl: string): void {
  objectUrlBySource.set(sourceUrl, objectUrl);
  sourceByObjectUrl.set(objectUrl, sourceUrl);

  while (objectUrlBySource.size > CACHE_LIMIT) {
    const oldest = objectUrlBySource.keys().next().value;
    if (oldest === undefined) break;
    const oldestObjectUrl = objectUrlBySource.get(oldest);
    if (oldestObjectUrl !== undefined && oldestObjectUrl !== currentAudioObjectUrl) {
      revokeObjectUrl(oldestObjectUrl);
    } else {
      break;
    }
  }
}

function isForeignCdnUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && !isTrustedApiOrigin(url);
}

export async function fetchAuthorizedBlobUrl(sourceUrl: string): Promise<string> {
  if (!sourceUrl) {
    throw new Error('Empty media URL');
  }
  if (sourceUrl.startsWith('blob:') || isForeignCdnUrl(sourceUrl)) {
    return sourceUrl;
  }

  const cached = objectUrlBySource.get(sourceUrl);
  if (cached) {
    // LRU: освежаем позицию, чтобы живые обложки не вытеснялись
    objectUrlBySource.delete(sourceUrl);
    objectUrlBySource.set(sourceUrl, cached);
    return cached;
  }

  const response = await authorizedFetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  rememberObjectUrl(sourceUrl, objectUrl);
  return objectUrl;
}

export async function fetchAuthorizedAudioUrl(streamUrl: string): Promise<string> {
  if (currentAudioObjectUrl) {
    revokeObjectUrl(currentAudioObjectUrl);
    currentAudioObjectUrl = null;
  }
  const objectUrl = await fetchAuthorizedBlobUrl(streamUrl);
  currentAudioObjectUrl = objectUrl;
  return objectUrl;
}
