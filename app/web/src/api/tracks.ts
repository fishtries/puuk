import { apiClient } from './client.ts';
import type {
  Album,
  Playlist,
  SearchResults,
  Track,
  TrackEditPayloadDTO,
  MetadataSearchResultDTO,
  LyricsSearchResultDTO,
} from '../types/track.ts';

export interface LyricsResponse {
  lyrics: string | null;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  isSynced: boolean;
  lyricsSource?: string | null;
  lyricsStatus?: string | null;
  lyricsLanguage?: string | null;
}

export async function fetchLyrics(trackId: string, force = false): Promise<LyricsResponse> {
  try {
    return await apiClient<LyricsResponse>(`/api/tracks/${trackId}/lyrics${force ? '?force=true' : ''}`);
  } catch {
    return { lyrics: null, isSynced: false };
  }
}

export async function fetchTracks(params?: { search?: string; limit?: number; offset?: number }): Promise<Track[]> {
  const query = new URLSearchParams();
  if (params?.search) query.append('q', params.search);
  if (params?.limit) query.append('limit', params.limit.toString());
  if (params?.offset) query.append('offset', params.offset.toString());
  return apiClient<Track[]>(`/api/tracks${query.toString() ? `?${query.toString()}` : ''}`);
}

export async function fetchTrack(trackId: string): Promise<Track> {
  return apiClient<Track>(`/api/tracks/${trackId}`);
}

export async function fetchAlbums(): Promise<Album[]> {
  return apiClient<Album[]>('/api/albums');
}

export async function fetchAlbumTracks(albumId: string): Promise<Track[]> {
  return apiClient<Track[]>(`/api/albums/${albumId}`);
}

export async function fetchPlaylists(): Promise<Playlist[]> {
  return apiClient<Playlist[]>('/api/playlists');
}

export async function fetchPlaylist(playlistId: string | number): Promise<Playlist> {
  return apiClient<Playlist>(`/api/playlists/${playlistId}`);
}

export interface PlaylistDetail extends Playlist {
  tracks: Track[];
}

export async function fetchPlaylistTracks(playlistId: string | number): Promise<PlaylistDetail> {
  return apiClient<PlaylistDetail>(`/api/playlists/${playlistId}`);
}

export async function fetchFavorites(): Promise<Track[]> {
  return apiClient<Track[]>('/api/favorites');
}

export async function toggleLikeTrack(trackId: string, isLiked: boolean): Promise<{ is_liked: boolean }> {
  const method = isLiked ? 'DELETE' : 'POST';
  return apiClient<{ is_liked: boolean }>(`/api/tracks/${trackId}/like`, {
    method,
  });
}

export async function recordTrackHistory(trackId: string): Promise<void> {
  try {
    await apiClient<void>(`/api/tracks/${trackId}/history`, {
      method: 'POST',
    });
  } catch {
    // Ignore history recording errors
  }
}

export async function fetchHistory(limit = 50): Promise<Track[]> {
  return apiClient<Track[]>(`/api/history?limit=${limit}`);
}

export async function searchTracks(query: string, limit = 30): Promise<SearchResults> {
  const params = new URLSearchParams({ q: query, limit: limit.toString() });
  return apiClient<SearchResults>(`/api/search?${params.toString()}`);
}

export function getStreamUrl(trackId: string): string {
  const baseUrl = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL) || '';
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('puuk_token') : null;
  return `${baseUrl}/api/stream/${trackId}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

export function getCoverUrl(
  item?: Track | Album | Playlist | { id?: string; cover_id?: string; coverArt?: string; cover_version?: number } | string | null
): string {
  if (!item) return '';

  if (typeof item === 'string') {
    const trimmed = item.trim();
    if (!trimmed) return '';
    const apiIndex = trimmed.indexOf('/api/cover/');
    if (apiIndex !== -1) {
      return trimmed.slice(apiIndex);
    }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }
    return `/api/cover/${trimmed}`;
  }

  const versionSuffix = typeof item === 'object' && item && 'cover_version' in item && typeof item.cover_version === 'number'
    ? `?v=${item.cover_version}`
    : '';

  if (item.coverArt) {
    const apiIndex = item.coverArt.indexOf('/api/cover/');
    if (apiIndex !== -1) {
      const base = item.coverArt.slice(apiIndex);
      return versionSuffix && !base.includes('?v=') ? `${base}${versionSuffix}` : base;
    }
    return item.coverArt;
  }

  const id = item.cover_id || item.id;
  if (id) {
    return `/api/cover/${id}${versionSuffix}`;
  }

  return '';
}

export async function updateTrackMetadata(
  trackId: string,
  payload: TrackEditPayloadDTO
): Promise<Track> {
  return apiClient<Track>(`/api/tracks/${trackId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function searchMetadata(query: string): Promise<MetadataSearchResultDTO[]> {
  const params = new URLSearchParams({ q: query });
  return apiClient<MetadataSearchResultDTO[]>(`/api/search/metadata?${params.toString()}`);
}

export async function searchOnlineLyrics(query: string): Promise<LyricsSearchResultDTO[]> {
  const params = new URLSearchParams({ q: query });
  return apiClient<LyricsSearchResultDTO[]>(`/api/search/lyrics?${params.toString()}`);
}

export async function resyncTrack(trackId: string): Promise<Track> {
  return apiClient<Track>(`/api/tracks/${trackId}/resync`, {
    method: 'POST',
  });
}

