import { create } from 'zustand';
import { PlayerStoreState, RepeatMode, ActiveView, RightPanelTab, PlaybackStatus } from '../types/player';
import { Track } from '../types/track';
import { audioEngine } from '../engine/AudioEngine';
import { parseLRC } from '../engine/lrcParser';
import { parseLyricsPayload, isDemoTrack } from './playerStoreHelpers';
import {
  fetchLyrics as apiFetchLyrics,
  fetchHistory,
  getStreamUrl,
  recordTrackHistory,
  toggleLikeTrack,
} from '../api/tracks';
import { fetchWaveQueue, sendWaveFeedback } from '../api/wave';
import {
  WAVE_BATCH_SIZE,
  WAVE_PREFETCH_THRESHOLD,
  type WaveExclusionSets,
  buildWaveExclusions,
  compactWaveQueue,
  mergeWaveTracks,
  trimPlayedIds,
  upcomingWaveTracks,
} from './waveQueue';

const HISTORY_LIMIT = 50;
const LOUDNESS_STORAGE_KEY = 'puuk:loudness-normalization:v1';
export const DEFAULT_LOUDNESS_NORMALIZATION = true;

export function getInitialLoudnessSetting(): boolean {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_LOUDNESS_NORMALIZATION;
    const val = localStorage.getItem(LOUDNESS_STORAGE_KEY);
    if (val === null) return DEFAULT_LOUDNESS_NORMALIZATION;
    if (val === 'true') return true;
    if (val === 'false') return false;
    return DEFAULT_LOUDNESS_NORMALIZATION;
  } catch {
    return DEFAULT_LOUDNESS_NORMALIZATION;
  }
}

export function computeTrackNormalizationGainDb(track: Track | null | undefined, isEnabled: boolean): number {
  if (!isEnabled || !track) return 0;
  if (track.loudness_status === 'analyzed' && track.normalization_gain_db != null) {
    return track.normalization_gain_db;
  }
  return 0;
}

/**
 * Single in-flight wave request. Concurrent Next presses share one HTTP call
 * instead of stacking duplicate batches on the queue.
 */
let waveFetchPromise: Promise<Track[]> | null = null;

/**
 * In-flight wave transition (see advanceWaveOnce). Guarantees a concurrent
 * Next press cannot walk the fetch path in parallel and replay the batch head.
 */
let waveAdvanceInFlight: Promise<void> | null = null;

function requestWaveBatch(
  currentTrackId: string | undefined,
  exclusions: WaveExclusionSets,
): Promise<Track[]> {
  if (waveFetchPromise) return waveFetchPromise;

  waveFetchPromise = fetchWaveQueue({
    currentTrackId,
    limit: WAVE_BATCH_SIZE,
    excludeTrackIds: exclusions.excludeTrackIds,
    queuedTrackIds: exclusions.queuedTrackIds,
  }).finally(() => {
    waveFetchPromise = null;
  });

  return waveFetchPromise;
}

export const usePlayerStore = create<PlayerStoreState>((set, get) => {
  async function loadWaveBatch(): Promise<Track[]> {
    const { currentTrack, queue, wavePlayedIds } = get();
    const exclusions = buildWaveExclusions(currentTrack, queue, wavePlayedIds);

    set({ isWaveLoading: true });
    try {
      // requestWaveBatch de-duplicates concurrent callers by sharing one promise,
      // so a second Next press waits for the same in-flight request instead of
      // dropping it and returning an empty batch.
      return await requestWaveBatch(currentTrack?.id, exclusions);
    } catch (e) {
      console.warn('Wave queue fetch failed:', e);
      return [];
    } finally {
      set({ isWaveLoading: false });
    }
  }

  /**
   * Consume the buffered wave head, if any. Returns true when playback advanced,
   * false when the buffer is exhausted (caller proceeds to a fresh fetch).
   * State mutations land synchronously before the first await, so concurrent
   * Next presses resolve to distinct heads instead of replaying one.
   */
  async function playWaveBufferHead(resolvedIndex: number, playedIds: string[]): Promise<boolean> {
    const { queue, isWaveActive, playTrack } = get();
    if (!isWaveActive) return false;

    const upcoming = upcomingWaveTracks(queue, resolvedIndex, playedIds);
    if (upcoming.length === 0) return false;

    const head = upcoming[0];
    const compacted = compactWaveQueue(queue, resolvedIndex, playedIds);
    const nextIndex = compacted.findIndex((t) => t.id === head.id);

    set({
      wavePlayedIds: playedIds,
      queue: compacted,
      currentTrackIndex: nextIndex >= 0 ? nextIndex : 1,
    });
    await playTrack(head, compacted);

    if (get().isWaveActive && upcoming.length - 1 <= WAVE_PREFETCH_THRESHOLD) {
      void prefetchWave();
    }
    return true;
  }

  /**
   * Wave navigation: play the next buffered track, or fetch a fresh batch only
   * when the buffer is exhausted. The finished track is remembered so the
   * backend never returns it again within the session.
   */
  async function advanceWave(finishedTrack: Track | null) {
    const { queue, currentTrackIndex, currentTrack, wavePlayedIds, playTrack } = get();
    const playedIds = finishedTrack?.id
      ? trimPlayedIds([...wavePlayedIds, finishedTrack.id])
      : wavePlayedIds;

    // Trust the playing track's id over a possibly stale index (manual queue edits).
    const anchorIndex = currentTrack
      ? queue.findIndex((t) => t.id === currentTrack.id)
      : currentTrackIndex;
    const resolvedIndex = anchorIndex >= 0 ? anchorIndex : currentTrackIndex;

    if (await playWaveBufferHead(resolvedIndex, playedIds)) return;

    set({ wavePlayedIds: playedIds });
    const fresh = await loadWaveBatch();
    const merged = mergeWaveTracks(
      compactWaveQueue(queue, resolvedIndex, playedIds),
      fresh,
      new Set([...playedIds, ...(get().currentTrack?.id ? [get().currentTrack!.id] : [])])
    );

    if (merged.length === 0) return;
    await playTrack(merged[0], merged);
  }

  /**
   * Serialized wave transition. A press that lands while an advance (including
   * its fetch) is in flight waits for it, then consumes one track from the
   * refreshed buffer — it never replays the just-landed batch head, which
   * would double-play it. Buffered presses stay sequential per press.
   */
  function advanceWaveOnce(finishedTrack: Track | null): Promise<void> {
    if (waveAdvanceInFlight) {
      return waveAdvanceInFlight.then(() => {
        const { currentTrack, queue, currentTrackIndex, wavePlayedIds } = get();
        const anchorIndex = currentTrack
          ? queue.findIndex((t) => t.id === currentTrack.id)
          : currentTrackIndex;
        const resolvedIndex = anchorIndex >= 0 ? anchorIndex : currentTrackIndex;
        return playWaveBufferHead(resolvedIndex, wavePlayedIds).then(() => undefined);
      });
    }

    waveAdvanceInFlight = advanceWave(finishedTrack).finally(() => {
      waveAdvanceInFlight = null;
    });
    return waveAdvanceInFlight;
  }

  /** Background refill: never touches playback, only extends the queue. */
  async function prefetchWave() {
    const { currentTrack, queue, wavePlayedIds, isWaveLoading } = get();
    if (isWaveLoading) return;

    const playedIds = trimPlayedIds(wavePlayedIds);
    const exclusions = buildWaveExclusions(currentTrack, queue, playedIds);

    set({ isWaveLoading: true });
    try {
      const fresh = await requestWaveBatch(currentTrack?.id, exclusions);
      const state = get();
      const anchorIndex = state.currentTrack
        ? state.queue.findIndex((t) => t.id === state.currentTrack?.id)
        : state.currentTrackIndex;
      const resolvedIndex = anchorIndex >= 0 ? anchorIndex : state.currentTrackIndex;
      const compacted = compactWaveQueue(state.queue, resolvedIndex, playedIds);
      const merged = mergeWaveTracks(
        compacted,
        fresh,
        new Set([...playedIds, ...(state.currentTrack?.id ? [state.currentTrack.id] : [])])
      );
      set({ queue: merged, currentTrackIndex: state.currentTrack ? 0 : state.currentTrackIndex });
    } catch (e) {
      console.warn('Wave prefetch failed:', e);
    } finally {
      set({ isWaveLoading: false });
    }
  }

  /**
   * Navigation shared by manual Next and natural track end. Auto-advance passes
   * reportSkip=false: the ended listener has already reported `finish` for the
   * same track, and a duplicate skip would double-count it.
   */
  async function goToNextTrack(reportSkip: boolean) {
    const { queue, currentTrackIndex, isShuffled, isWaveActive, currentTrack, currentTime, duration, playTrack } = get();

    if (reportSkip && currentTrack) {
      const listenMs = Math.round(currentTime * 1000);
      const totalMs = Math.round((currentTrack.duration || duration || 0) * 1000);
      if (localStorage.getItem('puuk_token')) {
        sendWaveFeedback(currentTrack.id, 'skip', listenMs, totalMs).catch(() => {});
      }
    }

    // Wave active: consume the already-fetched buffer before asking Qdrant again.
    if (isWaveActive) {
      await advanceWaveOnce(currentTrack);
      return;
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
  }

  audioEngine.on('timeupdate', ({ currentTime, duration }) => {
    set({ currentTime, duration: duration || get().duration });
  });

  audioEngine.on('statuschange', ({ status }) => {
    set({ status });
  });

  audioEngine.on('ended', () => {
    const { repeatMode, currentTrack, duration } = get();
    if (currentTrack && localStorage.getItem('puuk_token')) {
      const trackDurationMs = Math.round((currentTrack.duration || duration || 0) * 1000);
      sendWaveFeedback(currentTrack.id, 'finish', trackDurationMs, trackDurationMs).catch(() => {});
    }

    if (repeatMode === 'one' && currentTrack) {
      audioEngine.seek(0);
      audioEngine.play();
    } else {
      goToNextTrack(false);
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
    isWaveLoading: false,
    isLoudnessNormalizationEnabled: getInitialLoudnessSetting(),

    activeView: 'home',
    isRightPanelOpen: false,
    rightPanelTab: 'lyrics',
    isTrackInfoOpen: false,
    isFullscreen: false,
    isDebugOpen: false,
    isLoginOpen: false,
    accentColor: '#ffdab9',

     queue: [],
    history: [],
    recentlyPlayed: [],
    isHistoryLoading: false,
    currentTrackIndex: -1,
    wavePlayedIds: [],

    lyrics: [],
    isLyricsLoading: false,
    rawLyricsText: '',

    playTrack: async (track: Track, newQueue?: Track[]) => {
      const state = get();
      const updatedQueue = newQueue || (state.queue.length > 0 ? state.queue : [track]);
      const index = updatedQueue.findIndex((t) => t.id === track.id);

      // A manual jump inside an active wave counts as "already heard".
      const nextPlayedIds = state.isWaveActive
        ? trimPlayedIds([...state.wavePlayedIds, track.id])
        : state.wavePlayedIds;

      set({
        currentTrack: track,
        currentTrackIndex: index >= 0 ? index : 0,
        queue: updatedQueue,
        wavePlayedIds: nextPlayedIds,
        status: 'loading',
        currentTime: 0,
        duration: track.duration || 0,
        lyrics: [],
        rawLyricsText: '',
      });

      get().fetchLyrics(track.id);
      get().recordHistory(track);

      const streamUrl = getStreamUrl(track.id);
      const isLoudnessEnabled = get().isLoudnessNormalizationEnabled;
      const trackGainDb = computeTrackNormalizationGainDb(track, isLoudnessEnabled);
      await audioEngine.load(streamUrl, {
        autoplay: true,
        normalizationGainDb: trackGainDb,
      });
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
      audioEngine.setUserVolume(clamped);
      audioEngine.setMuted(false);
      set({ volume: clamped, isMuted: false });
    },

    toggleMute: () => {
      const { isMuted } = get();
      const nextMuted = !isMuted;
      audioEngine.setMuted(nextMuted);
      set({ isMuted: nextMuted });
    },

    toggleLoudnessNormalization: () => {
      const next = !get().isLoudnessNormalizationEnabled;
      get().setLoudnessNormalizationEnabled(next);
    },

    setLoudnessNormalizationEnabled: (enabled: boolean) => {
      try {
        localStorage.setItem(LOUDNESS_STORAGE_KEY, String(enabled));
      } catch (err) {
        console.warn('Failed to save loudness normalization setting to localStorage:', err);
      }
      set({ isLoudnessNormalizationEnabled: enabled });

      const { currentTrack } = get();
      const nextGainDb = computeTrackNormalizationGainDb(currentTrack, enabled);
      audioEngine.setNormalizationGainDb(nextGainDb);
    },

    nextTrack: () => goToNextTrack(true),

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

    toggleWave: async (): Promise<boolean> => {
      if (!localStorage.getItem('puuk_token')) {
        set({ isLoginOpen: true });
        return false;
      }
      const nextWave = !get().isWaveActive;
      const currentTrack = get().currentTrack;

      if (!nextWave) {
        set({ isWaveActive: false, isWaveLoading: false });
        return false;
      }

      set({
        isWaveActive: true,
        wavePlayedIds: currentTrack?.id ? [currentTrack.id] : [],
      });

      const waveTracks = await loadWaveBatch();
      if (waveTracks.length === 0) {
        set({ isWaveActive: false });
        return false;
      }

      const state = get();
      if (!state.currentTrack) {
        await get().playTrack(waveTracks[0], mergeWaveTracks([], waveTracks, new Set()));
        return true;
      }

      // Keep playing the current track and refill the buffer behind it.
      const merged = mergeWaveTracks([], waveTracks, new Set([state.currentTrack.id]));
      set({
        queue: [state.currentTrack, ...merged],
        currentTrackIndex: 0,
      });

      return true;
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

        // Keep currentTrackIndex pointing at the playing track when the removed
        // row sat before it, otherwise upcoming navigation skips a track.
        let currentTrackIndex = state.currentTrackIndex;
        if (index < currentTrackIndex) {
          currentTrackIndex -= 1;
        } else if (state.currentTrack) {
          const realIndex = newQueue.findIndex((t) => t.id === state.currentTrack?.id);
          currentTrackIndex = realIndex >= 0 ? realIndex : currentTrackIndex;
        }

        return { queue: newQueue, currentTrackIndex };
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

    setIsTrackInfoOpen: (isTrackInfoOpen: boolean) => {
      set({ isTrackInfoOpen });
    },

    toggleTrackInfo: () => {
      set((state) => ({ isTrackInfoOpen: !state.isTrackInfoOpen }));
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
      set({ isLyricsLoading: true, lyrics: [], rawLyricsText: '' });
      try {
        const data = await apiFetchLyrics(trackId, force);
        const { lyrics: parsed, rawLyricsText } = parseLyricsPayload(data);

        set({
          lyrics: parsed,
          rawLyricsText,
          isLyricsLoading: false,
        });
      } catch (err) {
        console.warn('Could not fetch lyrics:', err);
        set({ lyrics: [], rawLyricsText: '', isLyricsLoading: false });
      }
    },

    updateTime: (currentTime: number, duration: number) => {
      set({ currentTime, duration });
    },

    setStatus: (status: PlaybackStatus) => {
      set({ status });
    },

    toggleLike: async (trackId: string) => {
      if (!localStorage.getItem('puuk_token')) {
        set({ isLoginOpen: true });
        return;
      }
      try {
        const currentState = get();
        const track = currentState.currentTrack?.id === trackId 
          ? currentState.currentTrack 
          : currentState.queue.find(t => t.id === trackId);
        
        const currentIsLiked = track?.is_liked || false;
        const likeResponse = await toggleLikeTrack(trackId, currentIsLiked);
        const is_liked = likeResponse.is_liked ?? !currentIsLiked;

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
      if (!track?.id || isDemoTrack(track.id) || !localStorage.getItem('puuk_token')) return;

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
      if (!localStorage.getItem('puuk_token')) {
        set({ history: [], recentlyPlayed: [], isHistoryLoading: false });
        return;
      }
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

    resetUserData: () => {
      set({ history: [], recentlyPlayed: [], isHistoryLoading: false });
    },

    updateTrackInStore: (trackId: string, updatedTrack: Partial<Track>) => {
      set((state) => {
        const update = (t: Track): Track => (t.id === trackId ? { ...t, ...updatedTrack } : t);

        let newCurrent = state.currentTrack;
        let newLyrics = state.lyrics;
        let newRawLyrics = state.rawLyricsText;

        if (state.currentTrack?.id === trackId) {
          newCurrent = { ...state.currentTrack, ...updatedTrack };

          if (updatedTrack.lyrics !== undefined) {
            const rawLrc = updatedTrack.lyrics || '';
            newRawLyrics = rawLrc;
            newLyrics = parseLRC(rawLrc);
          }
        }

        return {
          currentTrack: newCurrent,
          queue: state.queue.map(update),
          history: state.history.map(update),
          recentlyPlayed: state.recentlyPlayed.map(update),
          lyrics: newLyrics,
          rawLyricsText: newRawLyrics,
        };
      });
    },
  };
});
