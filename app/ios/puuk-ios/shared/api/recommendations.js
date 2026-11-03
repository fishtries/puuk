import { authFetch, SERVER_URL } from './api';
import { normalizeTrack } from '../domain/trackAdapter';

/**
 * Fetches personalized genre recommendations ("You'll like this").
 * Endpoint: /api/recommendations/youll-like-this
 *
 * @param {Object} [options]
 * @param {number} [options.limit=20] Max tracks per section (1-20)
 * @param {number} [options.sections=3] Max sections (1-3)
 * @param {AbortSignal} [options.signal] Optional abort signal
 * @returns {Promise<{ sections: Array<{ id: string, type: string, title: string, description: string, genre: string, tracks: Array<Object> }> }>}
 */
export async function fetchPersonalizedRecommendations(options = {}) {
  const params = new URLSearchParams();
  if (options.limit !== undefined) {
    const limit = Math.min(20, Math.max(1, Number(options.limit) || 20));
    params.append('limit', String(limit));
  }
  if (options.sections !== undefined) {
    const sections = Math.min(3, Math.max(1, Number(options.sections) || 3));
    params.append('sections', String(sections));
  }

  const query = params.toString();
  const endpoint = `/api/recommendations/youll-like-this${query ? `?${query}` : ''}`;
  const response = await authFetch(endpoint, { signal: options.signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  const rawSections = Array.isArray(data?.sections) ? data.sections : [];

  return {
    sections: rawSections.map((sec) => ({
      id: sec.id || `genre-${(sec.genre || 'mix').toLowerCase().replace(/\s+/g, '-')}`,
      type: sec.type || 'genre',
      title: sec.title || (sec.genre ? `${sec.genre} Mix` : 'Mix'),
      description: sec.description || '',
      genre: sec.genre || '',
      tracks: Array.isArray(sec.tracks)
        ? sec.tracks
            .map((t) => normalizeTrack(t, { serverUrl: SERVER_URL }))
            .filter(Boolean)
        : [],
    })),
  };
}
