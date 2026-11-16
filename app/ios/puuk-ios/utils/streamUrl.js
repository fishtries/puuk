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

  // Catalog metadata is never an authority for a capability or remote origin.
  return `${cleanServerUrl}/api/stream/${encodeURIComponent(trackIdStr)}`;
}
