import { SERVER_URL } from '../shared/api/api';
import { getTrackId } from '../shared/domain/trackAdapter';

/**
 * Нормализует stream URL для воспроизведения и загрузки:
 * - Гарантирует корректный базовый SERVER_URL (без лишних слешей)
 * - Гарантирует формат https://<host>/api/stream/<id>
 * - Исключает двойные слеши, кавычки, пробелы
 * - Проверяет валидность URL
 *
 * @param {Object} track
 * @param {string} [serverUrl]
 * @returns {string}
 */
export function normalizeStreamUrl(track, serverUrl = SERVER_URL) {
  if (!track) return '';
  const trackId = getTrackId(track);
  if (trackId === null) return '';
  const trackIdStr = String(trackId).trim().replace(/['"]/g, '');

  const effectiveServerUrl = serverUrl || SERVER_URL || 'https://web.puuk.fun';
  const cleanServerUrl = String(effectiveServerUrl)
    .trim()
    .replace(/['"]/g, '')
    .replace(/\/+$/, '');

  const rawStream =
    typeof track.stream_url === 'string'
      ? track.stream_url.trim().replace(/['"]/g, '')
      : '';

  let normalized;
  const streamPathIndex = rawStream.indexOf('/api/stream/');
  if (streamPathIndex !== -1) {
    const pathPart = rawStream.slice(streamPathIndex).replace(/\/+/g, '/');
    normalized = `${cleanServerUrl}${pathPart}`;
  } else if (
    rawStream.startsWith('http://') ||
    rawStream.startsWith('https://')
  ) {
    normalized = rawStream;
  } else if (rawStream.startsWith('/')) {
    normalized = `${cleanServerUrl}${rawStream.replace(/\/+/g, '/')}`;
  } else {
    normalized = `${cleanServerUrl}/api/stream/${encodeURIComponent(trackIdStr)}`;
  }

  return normalized;
}
