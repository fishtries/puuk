import type { Track } from '../types/track';

export function trackRowKey(track: Track): string {
  return track.playlist_entry_id == null ? track.id : `entry:${track.playlist_entry_id}`;
}
