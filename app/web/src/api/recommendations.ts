import { apiClient } from './client';
import { getCoverUrl } from './tracks';
import type { Track } from '../types/track';
import type {
  MoodCatalogItem,
  MoodItem,
  MoodPlaylistResponse,
  YoullLikeThisResponse,
} from '../types/recommendations';

export const MOOD_DEFINITIONS: Record<
  string,
  {
    title: string;
    description: string;
    color: string;
    gradient: string;
    keywords: string[];
  }
> = {
  chill: {
    title: 'Chill mix',
    description: 'Спокойная музыка для отдыха и перезагрузки',
    color: '#38ef7d',
    gradient: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)',
    keywords: ['ambient', 'chill', 'lo-fi', 'lofi', 'acoustic', 'mellow'],
  },
  energetic: {
    title: 'Energy mix',
    description: 'Больше ритма и движения',
    color: '#ff416c',
    gradient: 'linear-gradient(135deg, #ff4b2b 0%, #ff416c 100%)',
    keywords: ['dance', 'edm', 'house', 'techno', 'electro', 'upbeat'],
  },
  focus: {
    title: 'Focus mix',
    description: 'Музыка для концентрации и работы',
    color: '#00c6ff',
    gradient: 'linear-gradient(135deg, #0072ff 0%, #00c6ff 100%)',
    keywords: ['instrumental', 'classical', 'piano', 'study', 'minimal'],
  },
  happy: {
    title: 'Happy mix',
    description: 'Яркая и жизнерадостная музыка',
    color: '#f7971e',
    gradient: 'linear-gradient(135deg, #ffd200 0%, #f7971e 100%)',
    keywords: ['pop', 'funk', 'disco', 'upbeat', 'indie', 'summer'],
  },
  sad: {
    title: 'Melancholy mix',
    description: 'Грустные и глубокие композиции',
    color: '#8a2387',
    gradient: 'linear-gradient(135deg, #8a2387 0%, #e94057 50%, #f27121 100%)',
    keywords: ['sad', 'melanchol', 'ballad', 'slow', 'blues', 'emotional'],
  },
  night: {
    title: 'Night mix',
    description: 'Атмосфера позднего вечера и полуночи',
    color: '#654ea3',
    gradient: 'linear-gradient(135deg, #1f1c2c 0%, #928dab 100%)',
    keywords: ['jazz', 'night', 'soul', 'r&b', 'rnb', 'smooth', 'nocturne'],
  },
};

export const DEFAULT_MOOD_ORDER = ['chill', 'energetic', 'focus', 'happy', 'sad', 'night'];

/**
 * Получить список всех настроений из каталога бэкенда.
 */
export async function fetchMoods(): Promise<MoodCatalogItem[]> {
  return apiClient<MoodCatalogItem[]>('/api/recommendations/moods');
}

/**
 * Получить персональный плейлист под настроение moodId.
 * При save=true бэкенд сохраняет плейлист в базу данных пользователя.
 */
export async function fetchMoodPlaylist(
  moodId: string,
  options: {
    limit?: number;
    save?: boolean;
    exclude_track_ids?: string[];
    queued_track_ids?: string[];
  } = {}
): Promise<MoodPlaylistResponse> {
  const params = new URLSearchParams();
  if (options.limit) params.append('limit', String(options.limit));
  if (options.save !== undefined) params.append('save', String(options.save));
  if (options.exclude_track_ids?.length) {
    options.exclude_track_ids.forEach((id) => params.append('exclude_track_ids', id));
  }
  if (options.queued_track_ids?.length) {
    options.queued_track_ids.forEach((id) => params.append('queued_track_ids', id));
  }

  const query = params.toString();
  return apiClient<MoodPlaylistResponse>(
    `/api/recommendations/moods/${moodId}/playlist${query ? `?${query}` : ''}`
  );
}

/**
 * Загрузить агрегированную подборку «You'll like this» для нескольких настроений.
 */
export async function fetchYoullLikeThis(
  moods: string[] = DEFAULT_MOOD_ORDER,
  limit: number = 8
): Promise<YoullLikeThisResponse> {
  const params = new URLSearchParams();
  params.append('moods', moods.join(','));
  params.append('limit', String(limit));

  return apiClient<YoullLikeThisResponse>(
    `/api/recommendations/youll-like-this?${params.toString()}`
  );
}

/**
 * Построить резервные mood-подборки из доступных локальных треков,
 * если бэкенд ещё не задеплоен или оффлайн.
 */
export function buildFallbackMoodItems(allTracks: Track[]): MoodItem[] {
  return DEFAULT_MOOD_ORDER.map((moodId, idx) => {
    const def = MOOD_DEFINITIONS[moodId] || {
      title: `${moodId} mix`,
      description: 'Персональная подборка от AI',
      color: '#ff7a00',
      gradient: 'linear-gradient(135deg, #ff7a00 0%, #ff0055 100%)',
      keywords: [],
    };

    // Пробуем найти треки по ключевым словам в title/artist/genre/album
    const matched = allTracks.filter((t) => {
      const searchTarget = `${t.title} ${t.artist} ${t.genre || ''} ${t.album || ''}`.toLowerCase();
      return def.keywords.some((k) => searchTarget.includes(k.toLowerCase()));
    });

    // Если совпадений мало, берём циклический срез из треков библиотеки
    const fallbackSlice = () => {
      if (allTracks.length === 0) return [];
      const offset = (idx * 3) % allTracks.length;
      return [...allTracks.slice(offset), ...allTracks.slice(0, offset)].slice(0, 10);
    };

    const tracks = matched.length >= 3 ? matched.slice(0, 12) : fallbackSlice();
    const coverUrl = tracks[0] ? getCoverUrl(tracks[0]) : undefined;

    return {
      id: moodId,
      title: def.title,
      description: def.description,
      color: def.color,
      gradient: def.gradient,
      tracks,
      coverUrl,
    };
  });
}
