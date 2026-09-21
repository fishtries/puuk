export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration: number; // in seconds
  file_path?: string;
  bitrate?: number;
  sample_rate?: number;
  channels?: number;
  format?: string;
  cover_id?: string;
  coverArt?: string;
  cover_color?: string;
  lyrics?: string;
  is_liked?: boolean;
  bpm?: number;
  key?: string;
  energy?: number;
  year?: number;
  album_artist?: string;
  genre?: string;
  track_number?: string;
  disc_number?: string;
  comment?: string;
  file_size?: number;
  file_mtime_ns?: number;
  cover_version?: number;
  dominant_color?: string;
}

export interface TrackEditPayloadDTO {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  album_artist?: string | null;
  year?: number | null;
  genre?: string | null;
  track_number?: string | null;
  disc_number?: string | null;
  comment?: string | null;
  lyrics?: string | null;
  cover_action?: 'keep' | 'replace' | 'remove';
  cover_base64?: string | null;
  cover_mime?: string | null;
}

export interface MetadataSearchResultDTO {
  title: string;
  artist: string;
  album: string;
  year?: number;
  genre?: string;
  track_number?: string;
  cover_url?: string;
  source: string;
}

export interface LyricsSearchResultDTO {
  id: number;
  track_name: string;
  artist_name: string;
  album_name: string;
  duration: number;
  synced_lyrics?: string;
  plain_lyrics?: string;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  syncedLyrics?: string;
  plainLyrics?: string;
}

export interface Album {
  id: string;
  title: string;
  artist: string;
  cover_id?: string;
  coverArt?: string;
  cover_color?: string;
  track_count?: number;
  year?: number;
}

export interface Playlist {
  id: string;
  name: string;
  title?: string;
  description?: string;
  track_count?: number;
  is_public?: boolean;
  user_id?: number;
  created_at?: string;
  cover_id?: string;
  coverArt?: string;
}

export interface Artist {
  name: string;
  track_count: number;
  album_count: number;
  coverArt?: string | null;
}

export interface SearchResults {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
}

// Frontend Domain types
export type LineQuality = 'approximate' | 'line_fallback' | 'degraded' | 'failed' | string;

export interface LyricsLine {
  time: number; // canonical line start anchor
  endTime?: number; // canonical line end anchor
  text: string; // full line reference text
  language?: string;
  quality?: LineQuality;
  timestampSource?: string;
}
