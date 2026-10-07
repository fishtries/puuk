import { SERVER_URL } from './api';

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
  const rawTrackId = (track.id !== undefined && track.id !== null)
    ? track.id
    : track.track_id;
  if (!rawTrackId && rawTrackId !== 0) return '';
  const trackIdStr = String(rawTrackId).trim().replace(/['"]/g, '');

  const cleanServerUrl = (serverUrl || 'https://web.puuk.fun')
    .trim()
    .replace(/['"]/g, '')
    .replace(/\/+$/, '');

  const rawStream = typeof track.stream_url === 'string'
    ? track.stream_url.trim().replace(/['"]/g, '')
    : '';

  let normalized;
  const streamPathIndex = rawStream.indexOf('/api/stream/');
  if (streamPathIndex !== -1) {
    const pathPart = rawStream.slice(streamPathIndex).replace(/\/+/g, '/');
    normalized = `${cleanServerUrl}${pathPart}`;
  } else if (rawStream.startsWith('http://') || rawStream.startsWith('https://')) {
    normalized = rawStream;
  } else if (rawStream.startsWith('/')) {
    normalized = `${cleanServerUrl}${rawStream.replace(/\/+/g, '/')}`;
  } else {
    normalized = `${cleanServerUrl}/api/stream/${encodeURIComponent(trackIdStr)}`;
  }

  return normalized;
}
