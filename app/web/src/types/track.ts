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

// Backend DTO types (strictly matching WhisperAnchorBackend JSON output)
export interface WordLyricsWordDTO {
  text: string;
  start: number | null;
  end: number | null;
  alignment?: 'matched' | 'interpolated' | 'unresolved' | null;
  timestamp_source?: 'whisper' | 'interpolated' | 'line_fallback' | 'unresolved' | null;
  confidence?: number | null;
  is_interpolated?: boolean | null;
  prefix?: string;
  suffix?: string;
}

export interface WordLyricsLineDTO {
  start: number;
  end: number;
  language: string;
  text: string;
  quality?: 'approximate' | 'line_fallback' | 'degraded' | 'failed' | string;
  word_timing_available?: boolean;
  timestamp_source?: 'whisper' | 'interpolated' | 'line_fallback' | 'unresolved' | string;
  confidence?: number | null;
  matched_words?: number;
  interpolated_words?: number;
  unresolved_words?: number;
  line_fallback_words?: number;
  unresolved_rate?: number;
  words: WordLyricsWordDTO[];
}

export interface WordLyricsPayloadDTO {
  version: number;
  backend: string;
  quality: 'approximate' | 'line_fallback' | 'degraded' | 'failed' | string;
  language: string;
  confidence?: number | null;
  lines: WordLyricsLineDTO[];
  stats?: Record<string, any>;
}

// Frontend Domain types
export type WordAlignment = 'matched' | 'interpolated' | 'unresolved';
export type WordTimestampSource = 'whisper' | 'interpolated' | 'line_fallback' | 'unresolved';
export type LineQuality = 'approximate' | 'line_fallback' | 'degraded' | 'failed' | string;
export type LineDisplayMode = 'word' | 'line';

export interface LyricsWord {
  text: string;
  startTime: number | null; // seconds, null if unresolved/missing
  endTime: number | null;   // seconds, null if unresolved/missing
  alignment: WordAlignment;
  timestampSource: WordTimestampSource;
  confidence: number | null;
  isInterpolated: boolean;
  prefix?: string;          // Leading brackets/punctuation (e.g. "(", "«")
  suffix?: string;          // Trailing punctuation/brackets/whitespace (e.g. ")?", ",", "—)")
}

export interface LyricsLine {
  time: number; // canonical line start anchor
  endTime?: number; // canonical line end anchor
  text: string; // full line reference text
  language?: string;
  quality: LineQuality;
  wordTimingAvailable: boolean;
  displayMode: LineDisplayMode; // 'word' | 'line' based on 20% unresolved policy
  unresolvedRate?: number;
  timestampSource?: WordTimestampSource | string;
  confidence?: number | null;
  matchedWords?: number;
  interpolatedWords?: number;
  unresolvedWords?: number;
  lineFallbackWords?: number;
  words?: LyricsWord[]; // undefined if no word-level tags
}

export interface WordLyricsPayload {
  version: number;
  backend: string;
  quality: string;
  language: string;
  confidence: number | null;
  lines: LyricsLine[];
  stats?: Record<string, any>;
}
