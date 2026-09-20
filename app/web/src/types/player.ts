import { Track, LyricsLine, WordLyricsPayload } from './track';

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';
export type RepeatMode = 'off' | 'all' | 'one';
export type ActiveView = 'home' | 'search' | 'library';
export type RightPanelTab = 'lyrics' | 'queue';

export interface AudioEngineEventMap {
  timeupdate: { currentTime: number; duration: number };
  statuschange: { status: PlaybackStatus };
  ended: void;
  error: { message: string };
  analyserdata: { frequencyData: Uint8Array };
}

export interface PlayerStoreState {
  // Playback
  currentTrack: Track | null;
  status: PlaybackStatus;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  repeatMode: RepeatMode;
  isShuffled: boolean;
  isWaveActive: boolean;

  // Layout & Overlays
  activeView: ActiveView;
  isRightPanelOpen: boolean;
  rightPanelTab: RightPanelTab;
  isFullscreen: boolean;
  isDebugOpen: boolean;
  isLoginOpen: boolean;
  accentColor: string;

  // Queue & History
  queue: Track[];
  history: Track[];
  recentlyPlayed: Track[];
  isHistoryLoading: boolean;
  currentTrackIndex: number;

  // Lyrics
  lyrics: LyricsLine[];
  isLyricsLoading: boolean;
  rawLyricsText: string;
  wordData: WordLyricsPayload | null;

  // Actions
  playTrack: (track: Track, queue?: Track[]) => Promise<void>;
  togglePlay: () => void;
  pause: () => void;
  resume: () => void;
  seek: (seconds: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  nextTrack: () => void;
  previousTrack: () => void;
  setRepeatMode: (mode: RepeatMode) => void;
  toggleShuffle: () => void;
  toggleWave: () => void;
  addToQueue: (track: Track) => void;
  removeFromQueue: (index: number) => void;
  clearQueue: () => void;
  setActiveView: (view: ActiveView) => void;
  setIsRightPanelOpen: (isOpen: boolean) => void;
  toggleRightPanel: (tab?: RightPanelTab) => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  setIsFullscreen: (isOpen: boolean) => void;
  setIsDebugOpen: (isOpen: boolean) => void;
  setIsLoginOpen: (isOpen: boolean) => void;
  fetchLyrics: (trackId: string, force?: boolean) => Promise<void>;
  updateTime: (currentTime: number, duration: number) => void;
  setStatus: (status: PlaybackStatus) => void;
  toggleLike: (trackId: string) => void;
  recordHistory: (track: Track) => void;
  loadHistory: () => Promise<void>;
  updateTrackInStore: (trackId: string, updatedTrack: Partial<Track>) => void;
}
