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
  auto_genres?: AutoGenreItem[] | null;
  auto_genre_model?: string | null;
  auto_genre_updated_at?: string | null;
  track_number?: string;
  disc_number?: string;
  comment?: string;
  file_size?: number;
  file_mtime_ns?: number;
  cover_version?: number;
  dominant_color?: string;
  normalization_gain_db?: number | null;
  loudness_status?: 'pending' | 'processing' | 'analyzed' | 'failed' | string;
  loudness_lufs?: number | null;
  true_peak_db?: number | null;
}

export interface AutoGenreItem {
  name: string;
  confidence: number;
}

export interface TrackEditPayloadDTO {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  album_artist?: string | null;
  year?: string | null;
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
  album_artist?: string;
  cover_id?: string;
  coverArt?: string;
  cover_color?: string;
  track_count?: number;
  total_duration?: number;
  year?: string | number;
}

export interface AlbumDetail {
  album: Album;
  tracks: Track[];
}

export interface AlbumEditPayloadDTO {
  title?: string | null;
  album_artist?: string | null;
  year?: string | null;
  cover_action?: 'keep' | 'replace' | 'remove';
  cover_base64?: string | null;
  cover_url?: string | null;
}

export interface AlbumEditResult {
  status: 'success' | 'partial';
  changed: boolean;
  merged?: boolean;
  album: Album;
  tracks: Track[];
  failed_tracks: Array<{ track_id: string; title?: string; error: string }>;
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
