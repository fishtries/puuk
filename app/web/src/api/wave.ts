import { apiClient } from './client';
import { Track } from '../types/track';

export interface WaveProfileStats {
  user_id: number;
  track_count: number;
  favorites_count: number;
  feedback_count: number;
  last_updated?: string | null;
  is_personalized: boolean;
}

export async function fetchWaveQueue(params?: {
  currentTrackId?: string;
  limit?: number;
  excludeTrackIds?: string[];
  queuedTrackIds?: string[];
}): Promise<Track[]> {
  const query = new URLSearchParams();
  if (params?.currentTrackId) query.append('current_track_id', params.currentTrackId);
  if (params?.limit) query.append('limit', params.limit.toString());
  for (const trackId of params?.excludeTrackIds ?? []) {
    if (trackId) query.append('exclude_track_ids', trackId);
  }
  for (const trackId of params?.queuedTrackIds ?? []) {
    if (trackId) query.append('queued_track_ids', trackId);
  }
  const queryString = query.toString();
  return apiClient<Track[]>(`/api/wave/queue${queryString ? `?${queryString}` : ''}`);
}

export async function sendWaveFeedback(
  trackId: string,
  eventType: 'like' | 'skip' | 'finish',
  listenDurationMs: number = 0,
  trackDurationMs: number = 0
): Promise<void> {
  await apiClient<{ status: string }>('/api/wave/feedback', {
    method: 'POST',
    body: JSON.stringify({
      track_id: trackId,
      event_type: eventType,
      listen_duration_ms: Math.max(0, Math.round(listenDurationMs)),
      track_duration_ms: Math.max(0, Math.round(trackDurationMs)),
    }),
  });
}

export async function fetchWaveProfileStats(): Promise<WaveProfileStats> {
  return apiClient<WaveProfileStats>('/api/user/profile-stats');
}
