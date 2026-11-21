import { trackRowKey } from '../utils/trackRowKey';
import { create } from 'zustand';
import type { PlayerStoreState, RepeatMode, ActiveView, RightPanelTab, PlaybackStatus } from '../types/player';
import type { Track } from '../types/track';
import { audioEngine } from '../engine/AudioEngine';
import { resolveAudioDelivery, invalidateAudioTicket, isAudioDeliveryUsable, deliveryNow, MediaDeliveryError, type AudioDelivery, type DeliveryMode } from '../api/media';
import { captureApiSession, isApiSessionCurrent, onApiSessionChange } from '../api/client';
import { toast } from 'sonner';
import { parseLRC } from '../engine/lrcParser';
import { parseLyricsPayload, isDemoTrack, hasLyricsContent } from './playerStoreHelpers';
import {
  fetchLyrics as apiFetchLyrics,
  fetchHistory,
  fetchTrack,
  fetchTracks,
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
const INITIAL_VOLUME = 0.85;
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

/**
 * Поколение загрузки аудио. Каждый playTrack наращивает счётчик; ответ
 * (media-тикет или ошибка) устаревшего поколения игнорируется — быстрые
 * переключения не дают позднему ответу запустить чужой трек или статус 'error'.
 */
let audioLoadGeneration = 0;
let queueGeneration = 0;

function invalidateWaveRequests() {
  queueGeneration += 1;
  waveFetchPromise = null;
  waveAdvanceInFlight = null;
}

function requestWaveBatch(
  currentTrackId: string | undefined,
  exclusions: WaveExclusionSets,
): Promise<Track[]> {
  if (waveFetchPromise) return waveFetchPromise;

  const request = fetchWaveQueue({
    currentTrackId,
    limit: WAVE_BATCH_SIZE,
    excludeTrackIds: exclusions.excludeTrackIds,
    queuedTrackIds: exclusions.queuedTrackIds,
  }).finally(() => {
    if (waveFetchPromise === request) waveFetchPromise = null;
  });
  waveFetchPromise = request;
  return request;
}

export const usePlayerStore = create<PlayerStoreState>((set, get) => {
  let source: AudioDelivery | null = null;
  let desiredPlaying = false;
  let exhausted = false;
  let episode: { controller: AbortController; generation: number } | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  function clearStall() { if (stallTimer) clearTimeout(stallTimer); stallTimer = null; }
  function cancelAudio() {
    clearStall();
    episode?.controller.abort();
    episode = null;
    source = null;
    audioEngine.stop();
  }
  function terminalAudio(error: unknown) {
    clearStall();
    exhausted = true;
    source = null;
    audioEngine.stop();
    set({ status: 'error' });
    toast.error(error instanceof MediaDeliveryError ? error.message : 'Не удалось воспроизвести трек. Нажмите Play для повтора');
  }
  /** The single recovery owner. No helper or engine layer retries a source. */
  async function runAudio(track: Track, position: number, recovery = false): Promise<void> {
    const previous = source;
    const session = captureApiSession();
    const generation = audioLoadGeneration;
    const controller = new AbortController();
    episode?.controller.abort();
    const currentEpisode = { controller, generation };
    episode = currentEpisode;
    clearStall();
    const deadline = deliveryNow() + 30_000;
    let refreshUsed = recovery;
    let directUsed = previous?.delivery === 'direct';
    let mode: DeliveryMode | undefined;
    let legacy = false;
    let calls = 0;
    let attempts = 0;
    let currentPosition = position;
    const current = () => generation === audioLoadGeneration && episode === currentEpisode && !controller.signal.aborted && isApiSessionCurrent(session) && get().currentTrack?.id === track.id;
    const remaining = (cap: number) => {
      const budget = Math.min(cap, deadline - deliveryNow());
      if (budget <= 0) throw new MediaDeliveryError('timeout');
      return budget;
    };
    source = null;
    audioEngine.stop();
    set({ status: 'loading' });
    try {
      while (current() && calls < 3 && attempts < 3) {
        let resolved: AudioDelivery;
        try {
          calls += 1;
          resolved = await resolveAudioDelivery(track.id, { mode, legacy, force: recovery || calls > 1, signal: controller.signal, timeoutMs: remaining(3000), contentVersion: track.content_version });
        } catch (error) {
          if (!current()) return;
          if (error instanceof MediaDeliveryError && error.canNegotiate && !refreshUsed && calls < 3) {
            refreshUsed = true;
            legacy = true;
            continue;
          }
          // Auth/track/DTO and ticket transport failures never bypass authorization.
          throw error;
        }
        if (!current()) return;
        source = resolved;
        if (resolved.delivery === 'direct') directUsed = true;
        attempts += 1;
        try {
          // The whole source phase includes AudioContext resume and play(),
          // both of which may remain pending before a media readiness event.
          const sourceController = new AbortController();
          const cancelSource = () => sourceController.abort();
          const cancelled = new Promise<never>((_, reject) => sourceController.signal.addEventListener('abort', () => reject(new Error('source_cancelled')), { once: true }));
          controller.signal.addEventListener('abort', cancelSource, { once: true });
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error('source_timeout'));
              sourceController.abort();
              if (current()) audioEngine.stop();
            }, remaining(7000));
          });
          try {
            await Promise.race([(async () => {
              await audioEngine.load(resolved.url, { autoplay: false, position: currentPosition, signal: sourceController.signal, timeoutMs: remaining(7000), normalizationGainDb: computeTrackNormalizationGainDb(get().currentTrack, get().isLoudnessNormalizationEnabled) });
              if (!current() || sourceController.signal.aborted) return;
              if (desiredPlaying) await audioEngine.play();
            })(), timeout, cancelled]);
          } finally {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', cancelSource);
          }
          if (!current()) return;
          set({ status: desiredPlaying ? 'playing' : 'paused' });
          return;
        } catch (error) {
          if (!current()) return;
          if (error instanceof Error && error.name === 'NotAllowedError') { desiredPlaying = false; set({ status: 'paused' }); return; }
          if (error instanceof Error && ['decode_error', 'unsupported_format'].includes(error.message)) throw error;
          currentPosition = Math.max(currentPosition, get().currentTime);
          audioEngine.stop();
          source = null;
          invalidateAudioTicket(track.id);
          if (!refreshUsed) { refreshUsed = true; mode = undefined; }
          else if (!directUsed && resolved.delivery === 'cdn') { directUsed = true; mode = 'direct'; }
          else throw error;
        }
      }
      if (current()) throw new MediaDeliveryError('timeout');
    } catch (error) {
      if (current()) terminalAudio(error);
    } finally {
      if (episode === currentEpisode) episode = null;
    }
  }
  function resumeAudio(position = get().currentTime) {
    const track = get().currentTrack;
    if (!track) return;
    desiredPlaying = true;
    if (episode && !episode.controller.signal.aborted) return;
    if (exhausted) {
      exhausted = false;
      ++audioLoadGeneration;
      void runAudio(track, position);
    } else if (!source || !isAudioDeliveryUsable(source)) {
      void runAudio(track, position, Boolean(source));
    } else {
      const generation = audioLoadGeneration;
      const session = captureApiSession();
      const activeSource = source;
      void audioEngine.play().catch(error => {
        if (generation !== audioLoadGeneration || source !== activeSource || !isApiSessionCurrent(session)) return;
        if (error?.name === 'NotAllowedError') { desiredPlaying = false; set({ status: 'paused' }); }
        else recoverAudio();
      });
    }
  }
  function recoverAudio() {
    if (!get().currentTrack || !desiredPlaying || exhausted || episode) return;
    void runAudio(get().currentTrack!, get().currentTime, true);
  }
  onApiSessionChange(() => get().resetUserData());
  async function loadWaveBatch(): Promise<Track[]> {
    const generation = queueGeneration;
    const { currentTrack, queue, wavePlayedIds } = get();
    const exclusions = buildWaveExclusions(currentTrack, queue, wavePlayedIds);

    set({ isWaveLoading: true });
    try {
      // requestWaveBatch de-duplicates concurrent callers by sharing one promise,
      // so a second Next press waits for the same in-flight request instead of
      // dropping it and returning an empty batch.
      const tracks = await requestWaveBatch(currentTrack?.id, exclusions);
      return generation === queueGeneration ? tracks : [];
    } catch (e) {
      console.warn('Wave queue fetch failed:', e);
      return [];
    } finally {
      if (generation === queueGeneration) set({ isWaveLoading: false });
    }
  }

  /**
   * Consume the buffered wave head, if any. Returns true when playback advanced,
   * false when the buffer is exhausted (caller proceeds to a fresh fetch).
   * State mutations land synchronously before the first await, so concurrent
   * Next presses resolve to distinct heads instead of replaying one.
   */
  async function playWaveBufferHead(resolvedIndex: number, playedIds: string[]): Promise<boolean> {
    const generation = queueGeneration;
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
    await playTrack(head, compacted, 'wave');

    if (generation === queueGeneration && get().isWaveActive && upcoming.length - 1 <= WAVE_PREFETCH_THRESHOLD) {
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
    const generation = queueGeneration;
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
    if (generation !== queueGeneration || !get().isWaveActive) return;

    set({ wavePlayedIds: playedIds });
    const fresh = await loadWaveBatch();
    if (generation !== queueGeneration || !get().isWaveActive) return;
    const merged = mergeWaveTracks(
      compactWaveQueue(queue, resolvedIndex, playedIds),
      fresh,
      new Set([...playedIds, ...(get().currentTrack?.id ? [get().currentTrack!.id] : [])])
    );

    if (merged.length === 0) return;
    await playTrack(merged[0], merged, 'wave');
  }

  /**
   * Serialized wave transition. A press that lands while an advance (including
   * its fetch) is in flight waits for it, then consumes one track from the
   * refreshed buffer — it never replays the just-landed batch head, which
   * would double-play it. Buffered presses stay sequential per press.
   */
  function advanceWaveOnce(finishedTrack: Track | null): Promise<void> {
    const generation = queueGeneration;
    if (waveAdvanceInFlight) {
      return waveAdvanceInFlight.then(() => {
        if (generation !== queueGeneration) return;
        const { currentTrack, queue, currentTrackIndex, wavePlayedIds } = get();
        const anchorIndex = currentTrack
          ? queue.findIndex((t) => t.id === currentTrack.id)
          : currentTrackIndex;
        const resolvedIndex = anchorIndex >= 0 ? anchorIndex : currentTrackIndex;
        return playWaveBufferHead(resolvedIndex, wavePlayedIds).then(() => undefined);
      });
    }

    waveAdvanceInFlight = advanceWave(finishedTrack).finally(() => {
      if (generation === queueGeneration) waveAdvanceInFlight = null;
    });
    return waveAdvanceInFlight;
  }

  /** Background refill: never touches playback, only extends the queue. */
  async function prefetchWave() {
    const generation = queueGeneration;
    const { currentTrack, queue, wavePlayedIds, isWaveLoading } = get();
    if (isWaveLoading) return;

    const playedIds = trimPlayedIds(wavePlayedIds);
    const exclusions = buildWaveExclusions(currentTrack, queue, playedIds);

    set({ isWaveLoading: true });
    try {
      const fresh = await requestWaveBatch(currentTrack?.id, exclusions);
      if (generation !== queueGeneration || !get().isWaveActive) return;
      const state = get();
      const anchorIndex = state.currentTrack
        ? state.queue.findIndex((t) => t.id === state.currentTrack?.id)
        : state.currentTrackIndex;
      const resolvedIndex = anchorIndex >= 0 ? anchorIndex : state.currentTrackIndex;
      const compacted = compactWaveQueue(state.queue, resolvedIndex, state.wavePlayedIds);
      const merged = mergeWaveTracks(
        compacted,
        fresh,
        new Set([...state.wavePlayedIds, ...(state.currentTrack?.id ? [state.currentTrack.id] : [])])
      );
      set({ queue: state.currentTrack ? [state.currentTrack, ...merged] : merged, currentTrackIndex: state.currentTrack ? 0 : state.currentTrackIndex });
    } catch (e) {
      console.warn('Wave prefetch failed:', e);
    } finally {
      if (generation === queueGeneration) set({ isWaveLoading: false });
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
        sendWaveFeedback(currentTrack.id, 'skip', listenMs, totalMs, isWaveActive ? 'wave' : 'manual').catch(() => {});
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
          if (get().autoplayAfterQueue && currentTrack && localStorage.getItem('puuk_token')) {
            set({ isWaveActive: true, wavePlayedIds: queue.map((track) => track.id) });
            await advanceWaveOnce(currentTrack);
          }
          return;
        }
      }
    }

    if (queue[nextIndex]) {
      await playTrack(queue[nextIndex]);
    }
  }

  audioEngine.setUserVolume(INITIAL_VOLUME);

  audioEngine.on('timeupdate', ({ currentTime, duration }) => {
    if (!get().currentTrack) return;
    if (currentTime > get().currentTime) clearStall();
    set({ currentTime, duration: duration || get().duration });
  });

  audioEngine.on('statuschange', ({ status }) => {
    if (!get().currentTrack || exhausted) return;
    if (status === 'loading' && desiredPlaying && !episode && !stallTimer) {
      stallTimer = setTimeout(() => { stallTimer = null; recoverAudio(); }, 7000);
    } else if (status === 'playing' || status === 'paused') clearStall();
    if (status !== 'error') set({ status });
  });
  audioEngine.on('error', ({ message }) => {
    if (!get().currentTrack || episode || exhausted) return;
    if (message === 'decode_error' || message === 'unsupported_format') terminalAudio(new Error(message));
    else recoverAudio();
  });

  audioEngine.on('ended', () => {
    if (episode || exhausted) return;
    const { repeatMode, currentTrack, duration } = get();
    if (currentTrack && localStorage.getItem('puuk_token')) {
      const trackDurationMs = Math.round((currentTrack.duration || duration || 0) * 1000);
      sendWaveFeedback(currentTrack.id, 'finish', trackDurationMs, trackDurationMs, get().isWaveActive ? 'wave' : 'manual').catch(() => {});
    }

    if (repeatMode === 'one' && currentTrack) {
      if (source && isAudioDeliveryUsable(source)) { audioEngine.seek(0); resumeAudio(0); }
      else { desiredPlaying = true; void runAudio(currentTrack, 0, Boolean(source)); }
    } else {
      goToNextTrack(false);
    }
  });

  return {
    currentTrack: null,
    status: 'idle',
    currentTime: 0,
    duration: 0,
    volume: INITIAL_VOLUME,
    isMuted: false,
    repeatMode: 'off',
    isShuffled: false,
    isWaveActive: false,
    autoplayAfterQueue: false,
    isWaveLoading: false,
    isLoudnessNormalizationEnabled: getInitialLoudnessSetting(),

    activeView: 'home',
    isRightPanelOpen: false,
    rightPanelTab: 'lyrics',
    isTrackInfoOpen: false,
    isFullscreen: false,
    isDebugOpen: false,
    isLoginOpen: false,
    accentColor: '#ff9b76',

     queue: [],
    history: [],
    recentlyPlayed: [],
    isHistoryLoading: false,
    currentTrackIndex: -1,
    wavePlayedIds: [],

    lyrics: [],
    isLyricsLoading: false,
    rawLyricsText: '',

    playTrack: async (track: Track, newQueue?: Track[], source?: 'collection' | 'search' | 'wave') => {
      if (!captureApiSession().token) { set({ isLoginOpen: true }); return; }
      if (source !== 'wave' && (newQueue || source)) {
        invalidateWaveRequests();
        set({
          isWaveActive: source === 'search',
          isWaveLoading: false,
          autoplayAfterQueue: source === 'collection' || source === 'search',
          wavePlayedIds: source === 'search' ? [track.id] : [],
        });
      }
      const state = get();
      const updatedQueue = source === 'search' ? [track] : newQueue || (state.queue.length > 0 ? state.queue : [track]);
      const index = updatedQueue.findIndex((t) => trackRowKey(t) === trackRowKey(track));
      ++audioLoadGeneration;
      cancelAudio();
      desiredPlaying = true;
      exhausted = false;

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

      // Глушим прежний источник синхронно: UI уже показывает новый трек,
      // и старый не должен звучать, пока запрашивается media-тикет и
      // открывается новый поток.
      audioEngine.stop();

      get().fetchLyrics(track.id);
      get().recordHistory(track);
      if (source === 'search') void prefetchWave();

      await runAudio(track, 0);
      if (get().currentTrack?.id === track.id && track.loudness_status !== 'analyzed') void get().refreshTrackLoudness(track.id);
    },

    togglePlay: () => {
      const { currentTrack, queue } = get();
      if (!currentTrack) {
        if (queue.length) void get().playTrack(queue[0]);
        else {
          const session = captureApiSession();
          const generation = audioLoadGeneration;
          void fetchTracks({ limit: 50 }).then(tracks => {
            if (isApiSessionCurrent(session) && generation === audioLoadGeneration && tracks.length) void get().playTrack(tracks[0], tracks);
          }).catch(() => {});
        }
      } else if (desiredPlaying && !exhausted) get().pause();
      else resumeAudio();
    },

    pause: () => {
      desiredPlaying = false;
      clearStall();
      if (episode) { episode.controller.abort(); source = null; audioEngine.stop(); }
      audioEngine.pause();
      set({ status: 'paused' });
    },

    resume: () => { resumeAudio(); },

    seek: (seconds: number) => {
      if (!Number.isFinite(seconds) || !get().currentTrack) return;
      const position = Math.max(0, Math.min(seconds, get().duration || seconds));
      set({ currentTime: position });
      if (episode || !source || !isAudioDeliveryUsable(source)) {
        void runAudio(get().currentTrack!, position, Boolean(source));
      } else audioEngine.seek(position);
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

    refreshTrackLoudness: async (trackId: string) => {
      const session = captureApiSession();
      try {
        const fresh = await fetchTrack(trackId);
        if (!isApiSessionCurrent(session)) return;
        if (fresh.loudness_status !== 'analyzed' || fresh.normalization_gain_db == null) return;

        const { currentTrack, queue, isLoudnessNormalizationEnabled } = get();
        if (currentTrack?.id !== trackId) return;

        const loudnessPatch: Partial<Track> = {
          loudness_status: fresh.loudness_status,
          normalization_gain_db: fresh.normalization_gain_db,
          loudness_lufs: fresh.loudness_lufs ?? null,
          true_peak_db: fresh.true_peak_db ?? null,
        };

        set({
          currentTrack: { ...currentTrack, ...loudnessPatch },
          queue: queue.map((t) => (t.id === trackId ? { ...t, ...loudnessPatch } : t)),
        });

        if (isLoudnessNormalizationEnabled) {
          audioEngine.setNormalizationGainDb(computeTrackNormalizationGainDb(get().currentTrack, true));
        }
      } catch {
        // Метаданные громкости некритичны для воспроизведения.
      }
    },

    nextTrack: () => goToNextTrack(true),

    previousTrack: () => {
      const { currentTime, queue, currentTrackIndex, playTrack } = get();
      if (currentTime > 3) {
        get().seek(0);
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
      invalidateWaveRequests();
      const generation = queueGeneration;
      const nextWave = !get().isWaveActive;
      const currentTrack = get().currentTrack;

      if (!nextWave) {
        set({ isWaveActive: false, isWaveLoading: false, autoplayAfterQueue: false });
        return false;
      }

      set({
        isWaveActive: true,
        wavePlayedIds: currentTrack?.id ? [currentTrack.id] : [],
      });

      const waveTracks = await loadWaveBatch();
      if (generation !== queueGeneration) return false;
      if (waveTracks.length === 0) {
        set({ isWaveActive: false });
        return false;
      }

      const state = get();
      if (!state.currentTrack) {
        await get().playTrack(waveTracks[0], mergeWaveTracks([], waveTracks, new Set()), 'wave');
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
          const realIndex = newQueue.findIndex((t) => state.currentTrack && trackRowKey(t) === trackRowKey(state.currentTrack));
          currentTrackIndex = realIndex >= 0 ? realIndex : currentTrackIndex;
        }

        return { queue: newQueue, currentTrackIndex };
      });
    },

    // Track deleted from the library: drop every upcoming occurrence so playback
    // never lands on a dead entry, but let the currently playing copy finish.
    purgeTrackFromQueue: (trackId: string) => {
      set((state) => {
        const kept: Track[] = [];
        let removedBeforeCurrent = 0;
        state.queue.forEach((t, index) => {
          const isPlayingSlot =
            t.id === trackId && state.currentTrackIndex >= 0 && index === state.currentTrackIndex;
          if (isPlayingSlot) {
            kept.push(t);
            return;
          }
          if (t.id === trackId) {
            if (index < state.currentTrackIndex) removedBeforeCurrent += 1;
            return;
          }
          kept.push(t);
        });
        if (kept.length === state.queue.length) return {};
        return { queue: kept, currentTrackIndex: state.currentTrackIndex - removedBeforeCurrent };
      });
    },

    clearQueue: () => {
      invalidateWaveRequests();
      set({ queue: [], currentTrackIndex: -1, isWaveActive: false, isWaveLoading: false, autoplayAfterQueue: false });
    },

    setActiveView: (activeView: ActiveView) => {
      set({ activeView });
    },

    setIsRightPanelOpen: (isRightPanelOpen: boolean) => {
      set({ isRightPanelOpen });
    },

    toggleRightPanel: (tab?: RightPanelTab) => {
      const { isRightPanelOpen, rightPanelTab, currentTrack, lyrics, rawLyricsText } = get();
      if (tab === 'lyrics' && !hasLyricsContent(currentTrack, lyrics, rawLyricsText)) {
        return;
      }
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
      if (rightPanelTab === 'lyrics') {
        const { currentTrack, lyrics, rawLyricsText } = get();
        if (!hasLyricsContent(currentTrack, lyrics, rawLyricsText)) {
          return;
        }
      }
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
      const session = captureApiSession();
      set({ isLyricsLoading: true, lyrics: [], rawLyricsText: '' });
      try {
        const data = await apiFetchLyrics(trackId, force);
        if (!isApiSessionCurrent(session)) return;
        // Ответ устаревшего запроса (трек уже переключили) не должен
        // перезаписывать текст актуального трека.
        if (get().currentTrack?.id !== trackId) return;
        const { lyrics: parsed, rawLyricsText } = parseLyricsPayload(data);
        const hasLyrics = parsed.length > 0 || Boolean(rawLyricsText && rawLyricsText.trim().length > 0);

        const currentTrack = get().currentTrack;
        const updatedTrack = currentTrack && currentTrack.id === trackId
          ? { ...currentTrack, has_lyrics: hasLyrics }
          : currentTrack;

        set({
          currentTrack: updatedTrack,
          lyrics: parsed,
          rawLyricsText,
          isLyricsLoading: false,
        });

        if (!hasLyrics && get().isRightPanelOpen && get().rightPanelTab === 'lyrics') {
          set({ rightPanelTab: 'queue' });
        }
      } catch (err) {
        if (!isApiSessionCurrent(session) || get().currentTrack?.id !== trackId) return;
        console.warn('Could not fetch lyrics:', err);
        set({ lyrics: [], rawLyricsText: '', isLyricsLoading: false });
        if (get().isRightPanelOpen && get().rightPanelTab === 'lyrics') {
          set({ rightPanelTab: 'queue' });
        }
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
      const session = captureApiSession();
      if (!localStorage.getItem('puuk_token')) {
        set({ history: [], recentlyPlayed: [], isHistoryLoading: false });
        return;
      }
      set({ isHistoryLoading: true });
      try {
        const serverHistory = await fetchHistory(HISTORY_LIMIT);
        if (!isApiSessionCurrent(session)) return;
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
      ++audioLoadGeneration;
      invalidateWaveRequests();
      desiredPlaying = false;
      exhausted = false;
      cancelAudio();
      if (typeof navigator !== 'undefined' && navigator.mediaSession) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
        for (const action of ['play', 'pause', 'nexttrack', 'previoustrack', 'seekto'] as const) navigator.mediaSession.setActionHandler(action, null);
      }
      set({ currentTrack: null, currentTrackIndex: -1, queue: [], history: [], recentlyPlayed: [], isHistoryLoading: false, isLyricsLoading: false, lyrics: [], rawLyricsText: '', currentTime: 0, duration: 0, status: 'idle', isWaveActive: false, isWaveLoading: false, wavePlayedIds: [], autoplayAfterQueue: false, isTrackInfoOpen: false });
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
            const hasLyrics = newLyrics.length > 0 || Boolean(rawLrc.trim().length > 0);
            newCurrent = { ...newCurrent, has_lyrics: hasLyrics };
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
