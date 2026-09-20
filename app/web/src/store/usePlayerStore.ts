import { create } from 'zustand';
import { PlayerStoreState, RepeatMode, ActiveView, RightPanelTab, PlaybackStatus } from '../types/player';
import { Track } from '../types/track';
import { audioEngine } from '../engine/AudioEngine';
import { parseLRC } from '../engine/lrcParser';
import {
  generateAccentColor,
  applyAccentColor,
  parseLyricsPayload,
  isDemoTrack,
} from './playerStoreHelpers';
import {
  fetchLyrics as apiFetchLyrics,
  fetchHistory,
  getStreamUrl,
  recordTrackHistory,
  toggleLikeTrack,
} from '../api/tracks';
import { fetchWaveQueue, sendWaveFeedback } from '../api/wave';

const HISTORY_LIMIT = 50;

export const usePlayerStore = create<PlayerStoreState>((set, get) => {
  audioEngine.on('timeupdate', ({ currentTime, duration }) => {
    set({ currentTime, duration: duration || get().duration });
  });

  audioEngine.on('statuschange', ({ status }) => {
    set({ status });
  });

  audioEngine.on('ended', () => {
    const { repeatMode, nextTrack, currentTrack, duration } = get();
    if (currentTrack) {
      const trackDurationMs = Math.round((currentTrack.duration || duration || 0) * 1000);
      sendWaveFeedback(currentTrack.id, 'finish', trackDurationMs, trackDurationMs).catch(() => {});
    }

    if (repeatMode === 'one' && currentTrack) {
      audioEngine.seek(0);
      audioEngine.play();
    } else {
      nextTrack();
    }
  });

  return {
    currentTrack: null,
    status: 'idle',
    currentTime: 0,
    duration: 0,
    volume: 0.85,
    isMuted: false,
    repeatMode: 'off',
    isShuffled: false,
    isWaveActive: false,

    activeView: 'home',
    isRightPanelOpen: false,
    rightPanelTab: 'lyrics',
    isFullscreen: false,
    isDebugOpen: false,
    isLoginOpen: false,
    accentColor: '#6366f1',

     queue: [],
    history: [],
    recentlyPlayed: [],
    isHistoryLoading: false,
    currentTrackIndex: -1,

    lyrics: [],
    isLyricsLoading: false,
    rawLyricsText: '',
    wordData: null,

    playTrack: async (track: Track, newQueue?: Track[]) => {
      const state = get();
      const updatedQueue = newQueue || (state.queue.length > 0 ? state.queue : [track]);
      const index = updatedQueue.findIndex((t) => t.id === track.id);

      const accent = generateAccentColor(track.title + track.artist);
      applyAccentColor(accent);

      set({
        currentTrack: track,
        currentTrackIndex: index >= 0 ? index : 0,
        queue: updatedQueue,
        status: 'loading',
        currentTime: 0,
        duration: track.duration || 0,
        accentColor: accent,
        lyrics: [],
        rawLyricsText: '',
        wordData: null,
      });

      get().fetchLyrics(track.id);
      get().recordHistory(track);

      const streamUrl = getStreamUrl(track.id);
      await audioEngine.load(streamUrl, true);
    },

    togglePlay: () => {
      const { status, currentTrack, queue } = get();
      if (!currentTrack) {
        if (queue.length > 0) {
          get().playTrack(queue[0]);
        }
        return;
      }

      if (status === 'playing') {
        audioEngine.pause();
      } else {
        audioEngine.play();
      }
    },

    pause: () => {
      audioEngine.pause();
    },

    resume: () => {
      audioEngine.play();
    },

    seek: (seconds: number) => {
      audioEngine.seek(seconds);
      set({ currentTime: seconds });
    },

    setVolume: (volume: number) => {
      const clamped = Math.max(0, Math.min(1, volume));
      audioEngine.setVolume(get().isMuted ? 0 : clamped);
      set({ volume: clamped, isMuted: false });
    },

    toggleMute: () => {
      const { isMuted, volume } = get();
      const nextMuted = !isMuted;
      audioEngine.setVolume(nextMuted ? 0 : volume);
      set({ isMuted: nextMuted });
    },

    nextTrack: async () => {
      const { queue, currentTrackIndex, isShuffled, isWaveActive, currentTrack, currentTime, duration, playTrack } = get();

      if (currentTrack) {
        const listenMs = Math.round(currentTime * 1000);
        const totalMs = Math.round((currentTrack.duration || duration || 0) * 1000);
        sendWaveFeedback(currentTrack.id, 'skip', listenMs, totalMs).catch(() => {});
      }

      // If Wave is active, pull next from Qdrant vector queue
      if (isWaveActive) {
        try {
          const nextWaveTracks = await fetchWaveQueue({
            currentTrackId: currentTrack?.id,
            limit: 5,
          });
          if (nextWaveTracks.length > 0) {
            playTrack(nextWaveTracks[0], [...queue, ...nextWaveTracks]);
            return;
          }
        } catch (e) {
          console.warn('Wave queue fetch failed:', e);
        }
      }

      if (queue.length === 0) return;

      let nextIndex: number;
      if (isShuffled) {
        nextIndex = Math.floor(Math.random() * queue.length);
      } else {
        nextIndex = currentTrackIndex + 1;
        if (nextIndex >= queue.length) {
          if (get().repeatMode === 'all') {
            nextIndex = 0;
          } else {
            return; // end of queue per WEB_CLIENT_ARCH
          }
        }
      }

      if (queue[nextIndex]) {
        playTrack(queue[nextIndex]);
      }
    },

    previousTrack: () => {
      const { currentTime, queue, currentTrackIndex, playTrack } = get();
      if (currentTime > 3) {
        audioEngine.seek(0);
        return;
      }

      if (queue.length === 0) return;
      const prevIndex = currentTrackIndex > 0 ? currentTrackIndex - 1 : 0;
      if (queue[prevIndex]) {
        playTrack(queue[prevIndex]);
      }
    },

    setRepeatMode: (repeatMode: RepeatMode) => {
      set({ repeatMode });
    },

    toggleShuffle: () => {
      set((state) => ({ isShuffled: !state.isShuffled }));
    },

    toggleWave: async () => {
      const nextWave = !get().isWaveActive;
      set({ isWaveActive: nextWave });
      if (nextWave && !get().currentTrack) {
        try {
          const waveTracks = await fetchWaveQueue({ limit: 10 });
          if (waveTracks.length > 0) {
            get().playTrack(waveTracks[0], waveTracks);
          }
        } catch (e) {
          console.error('Failed to start wave:', e);
        }
      }
    },

    addToQueue: (track: Track) => {
      set((state) => ({
        queue: [...state.queue, track],
      }));
    },

    removeFromQueue: (index: number) => {
      set((state) => {
        const newQueue = [...state.queue];
        newQueue.splice(index, 1);
        return { queue: newQueue };
      });
    },

    clearQueue: () => {
      set({ queue: [], currentTrackIndex: -1 });
    },

    setActiveView: (activeView: ActiveView) => {
      set({ activeView });
    },

    setIsRightPanelOpen: (isRightPanelOpen: boolean) => {
      set({ isRightPanelOpen });
    },

    toggleRightPanel: (tab?: RightPanelTab) => {
      const { isRightPanelOpen, rightPanelTab } = get();
      if (tab) {
        if (isRightPanelOpen && rightPanelTab === tab) {
          set({ isRightPanelOpen: false });
        } else {
          set({ isRightPanelOpen: true, rightPanelTab: tab });
        }
      } else {
        set({ isRightPanelOpen: !isRightPanelOpen });
      }
    },

    setRightPanelTab: (rightPanelTab: RightPanelTab) => {
      set({ rightPanelTab, isRightPanelOpen: true });
    },

    setIsFullscreen: (isFullscreen: boolean) => {
      set({ isFullscreen });
    },

    setIsDebugOpen: (isDebugOpen: boolean) => {
      set({ isDebugOpen });
    },

    setIsLoginOpen: (isLoginOpen: boolean) => {
      set({ isLoginOpen });
    },

    fetchLyrics: async (trackId: string, force = false) => {
      set({ isLyricsLoading: true, lyrics: [], rawLyricsText: '', wordData: null });
      try {
        const data = await apiFetchLyrics(trackId, force);
        const { lyrics: parsed, rawLyricsText, wordData } = parseLyricsPayload(data);

        set({
          lyrics: parsed,
          rawLyricsText,
          wordData,
          isLyricsLoading: false,
        });
      } catch (err) {
        console.warn('Could not fetch lyrics:', err);
        set({ lyrics: [], rawLyricsText: '', wordData: null, isLyricsLoading: false });
      }
    },

    updateTime: (currentTime: number, duration: number) => {
      set({ currentTime, duration });
    },

    setStatus: (status: PlaybackStatus) => {
      set({ status });
    },

    toggleLike: async (trackId: string) => {
      try {
        const currentState = get();
        const track = currentState.currentTrack?.id === trackId 
          ? currentState.currentTrack 
          : currentState.queue.find(t => t.id === trackId);
        
        const currentIsLiked = track?.is_liked || false;
        const { is_liked } = await toggleLikeTrack(trackId, currentIsLiked);

        // Отправляем feedback лайка для обогащения персонального вектора вкусов
        if (is_liked) {
          const listenMs = Math.round(currentState.currentTime * 1000);
          const totalMs = Math.round(((track?.duration || currentState.duration) || 0) * 1000);
          sendWaveFeedback(trackId, 'like', listenMs, totalMs).catch(() => {});
        }
        
        set((state) => {
          const update = (t: Track) => (t.id === trackId ? { ...t, is_liked } : t);
          return {
            currentTrack: state.currentTrack?.id === trackId ? { ...state.currentTrack, is_liked } : state.currentTrack,
            queue: state.queue.map(update),
          };
        });
      } catch (e) {
        console.error('Failed to toggle like:', e);
      }
    },

    recordHistory: (track: Track) => {
      if (!track?.id || isDemoTrack(track.id)) return;

      set((state) => {
        const withoutDuplicate = state.recentlyPlayed.filter((t) => t.id !== track.id);
        return {
          recentlyPlayed: [track, ...withoutDuplicate].slice(0, HISTORY_LIMIT),
          history: [track, ...state.history.filter((t) => t.id !== track.id)].slice(0, HISTORY_LIMIT),
        };
      });

      recordTrackHistory(track.id).catch(() => {});
    },

    loadHistory: async () => {
      set({ isHistoryLoading: true });
      try {
        const serverHistory = await fetchHistory(HISTORY_LIMIT);
        const seen = new Set<string>();
        const deduped = serverHistory.filter((track) => {
          if (seen.has(track.id)) return false;
          seen.add(track.id);
          return true;
        });
        set({ recentlyPlayed: deduped, history: deduped, isHistoryLoading: false });
      } catch (err) {
        console.warn('Could not load listening history:', err);
        set({ isHistoryLoading: false });
      }
    },

    updateTrackInStore: (trackId: string, updatedTrack: Partial<Track>) => {
      set((state) => {
        const update = (t: Track): Track => (t.id === trackId ? { ...t, ...updatedTrack } : t);

        let newCurrent = state.currentTrack;
        let newLyrics = state.lyrics;
        let newRawLyrics = state.rawLyricsText;
        let newWordData = state.wordData;
        let newAccent = state.accentColor;

        if (state.currentTrack?.id === trackId) {
          newCurrent = { ...state.currentTrack, ...updatedTrack };

          if (updatedTrack.title || updatedTrack.artist) {
            newAccent = generateAccentColor((newCurrent.title || '') + (newCurrent.artist || ''));
            applyAccentColor(newAccent);
          }

          if (updatedTrack.lyrics !== undefined) {
            const rawLrc = updatedTrack.lyrics || '';
            newRawLyrics = rawLrc;
            newLyrics = parseLRC(rawLrc);
            newWordData = null;
          }
        }

        return {
          currentTrack: newCurrent,
          queue: state.queue.map(update),
          history: state.history.map(update),
          recentlyPlayed: state.recentlyPlayed.map(update),
          lyrics: newLyrics,
          rawLyricsText: newRawLyrics,
          wordData: newWordData,
          accentColor: newAccent,
        };
      });
    },
  };
});
