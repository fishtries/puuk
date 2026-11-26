import { saveRatingWithFeedback, showRatingError } from '../features/downloads/ratingFeedback';
import { nativeEQ } from '../features/equalizer/equalizer';
import { normalizeStreamUrl } from '../utils/streamUrl';
import { AppState, DeviceEventEmitter } from 'react-native';
import defaultAudioCache from '../utils/audioCache';
import defaultPreloadScheduler from '../utils/preloadScheduler';
import { boundedMediaOperation, mediaDelivery } from '../shared/api/media';
import {
  LOCAL_WAVE_BATCH_SIZE,
  readWaveQueue,
  saveWaveQueue,
  selectLocalWaveTracks,
  setWavePlaybackMode,
  waveTrackDuration,
} from '../offline/wave';
import { readMediaKey } from '../offline';
import { DEFAULT_WAVE_RESERVE_MINUTES } from '../offline/policy';
import { getCurrentNetworkPolicy, subscribeNetworkPolicy } from '../utils/networkPolicy';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  useAudioPlayer,
  setAudioModeAsync,
} from 'expo-audio';
import { usePlaybackState, getPlaybackSnapshot } from './playbackStatus';
import {
  authFetch,
  addSessionListener,
  SERVER_URL,
  getAuthHeaders,
  getCachedAuthHeaders,
  getCachedUser,
  addAuthListener,
  getSavedUser,
} from '../shared/api/api';
import {
  getOfflineSession,
  isOfflineSessionCurrent,
  subscribeOfflineIndex,
} from '../offline/session';
import {
  getRatingOverlay,
  getLocalDislikeIds,
  overlayDislikeIds,
  startOutboxSync,
} from '../offline/outbox/runtime';
import {
  completePlayback,
  createPlaybackEpisode,
  observePlayback,
} from '../offline/outbox/playbackEpisode';
import { recordPlayStart } from '../shared/api/artists';
import {
  queueKey,
  carryQueueIdentity,
  shuffledTracks,
} from '../utils/queueIdentity';
import { subscribeArtistCreditsUpdated } from '../shared/domain/artistCreditEvents';
import defaultPlaybackCoordinator from '../utils/playbackCoordinator';
import { normalizePlaybackRate } from '../utils/playbackSpeed';
import {
  clearSavedLastTrack,
  getSettings,
  addSettingsListener,
} from '../shared/storage/settings';
import {
  applyTrackNormalization,
  computeEffectivePlayerVolume,
  computeTrackNormalizationGainDb,
} from '../utils/loudnessNormalization';
import {
  getTrackId,
  areTrackIdsEqual,
  normalizeTrack,
} from '../shared/domain/trackAdapter';

/**
 * Единое DTO трека для плеера: сохраняет все дополнительные поля,
 * нормализует канонический id и алиас track_id, задаёт дефолты плеера.
 */
export function normalizeTrackDto(source) {
  const normalized = normalizeTrack(source, { serverUrl: SERVER_URL });
  if (!normalized) return null;
  return {
    bpm: 0,
    duration: 0,
    normalization_gain_db: null,
    loudness_status: 'pending',
    loudness_lufs: null,
    true_peak_db: null,
    ...normalized,
    stream_url: normalizeStreamUrl(normalized),
    artist: source?.artist || 'My Wave',
    is_liked: !!source?.is_liked,
  };
}

// Паритет с backend MAX_EXCLUDE_IDS: длиннее список клиент не передает.
const MAX_EXCLUDE_IDS = 100;
// Ограничение будущего буфера волны и истории сессии.
const MAX_QUEUE_BUFFER = 400;
const WAVE_RETRY_DELAY = 30_000;
const WAVE_REQUEST = { retry: 0, timeout: 3500 };
const WAVE_RESERVE_DELAY_MS = 400;
const MAX_HISTORY = 50;
let selectionSequence = 0;

const requestWave = (url, signal) => boundedMediaOperation(async requestSignal => {
  const response = await authFetch(url, { ...WAVE_REQUEST, signal: requestSignal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}, { signal, timeout: WAVE_REQUEST.timeout });

async function readyReserveBeforeResponse(request, session, history) {
  if (!session) return null;
  let timer;
  const local = new Promise(resolve => {
    timer = setTimeout(async () => {
      try {
        const ready = await selectLocalWaveTracks(session, { history });
        if (ready.tracks.length) resolve(ready);
      } catch {
        // The original request can still provide an online queue.
      }
    }, WAVE_RESERVE_DELAY_MS);
  });
  try {
    return await Promise.race([request.response.then(() => null), local]);
  } finally {
    clearTimeout(timer);
  }
}

function sameTrackOrder(previous, next) {
  return previous === next || (previous.length === next.length && next.every(
    (track, index) => track === previous[index] || getTrackId(track) === getTrackId(previous[index]),
  ));
}

function capIds(ids, limit = MAX_EXCLUDE_IDS) {
  const valid = (ids || []).map(getTrackId).filter((id) => id !== null);
  const unique = [...new Set(valid.map((id) => String(id).trim()))];
  return unique.length > limit ? unique.slice(unique.length - limit) : unique;
}

/** URL /api/wave/queue с повторяющимися query-параметрами исключений. */
function buildWaveQueueUrl(trackId, { excludeIds = [], queuedIds = [], limit = 50 } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  const canonicalId = getTrackId(trackId);
  if (canonicalId !== null) {
    params.append('current_track_id', String(canonicalId));
  }
  for (const id of capIds(excludeIds))
    params.append('exclude_track_ids', String(id));
  for (const id of capIds(queuedIds))
    params.append('queued_track_ids', String(id));
  return `/api/wave/queue?${params.toString()}`;
}

/** Слияние пачки рекомендаций с буфером без дублей. */
function mergeUniqueQueue(existing, incoming, maxBuffer = MAX_QUEUE_BUFFER) {
  const seen = new Set();
  for (const t of existing || []) {
    const id = getTrackId(t);
    if (id !== null) {
      seen.add(String(id).trim());
    }
  }
  const merged = [...(existing || [])];
  for (const track of incoming || []) {
    const trackId = getTrackId(track);
    if (trackId === null) continue;
    const key = String(trackId).trim();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(track);
  }
  return merged.slice(0, Math.max(maxBuffer, (existing || []).length));
}

export default function usePlayerController({ setTracks }) {
  const ratingOverlayRef = useRef(new Map());
  const favoriteIdsRef = useRef(null);
  const serverDislikeIdsRef = useRef(new Set());
  const projectRating = useCallback((track) => {
    if (!track) return track;
    const id = String(getTrackId(track));
    const entry = ratingOverlayRef.current.get(id);
    const liked = entry?.state === 'missing' ? false
      : entry && entry.state !== 'failed' ? entry.rating === 'like'
      : favoriteIdsRef.current ? favoriteIdsRef.current.has(id) : !!track.is_liked;
    return liked === !!track.is_liked ? track : carryQueueIdentity(track, { ...track, is_liked: liked });
  }, []);
  const projectTrackRatings = useCallback((tracks) => {
    let result = tracks;
    tracks.forEach((track, index) => {
      const updated = projectRating(track);
      if (updated === track) return;
      if (result === tracks) result = tracks.slice();
      result[index] = updated;
    });
    return result;
  }, [projectRating]);
  const [currentTrack, commitCurrentTrack] = useState(null);
  const currentTrackRef = useRef(null);
  const setCurrentTrack = useCallback((update) => {
    const previous = currentTrackRef.current;
    const next = projectRating(
      typeof update === 'function' ? update(currentTrackRef.current) : update,
    );
    if (previous && next && previous !== next && areTrackIdsEqual(previous, next)) {
      carryQueueIdentity(previous, next);
      cycleTracksRef.current = cycleTracksRef.current.map((track) =>
        track === previous ? next : track,
      );
    }
    currentTrackRef.current = next;
    commitCurrentTrack(next);
  }, [projectRating]);
  const [dislikeIds, setDislikeIds] = useState(new Set());
  const dislikeIdsRef = useRef(new Set());
  const ratingWritesRef = useRef(new Map());
  const [dislikePending, setDislikePending] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isPlayerVisible, setIsPlayerVisible] = useState(false);
  const [playerExpandToken, setPlayerExpandToken] = useState(0);
  const [upNextQueue, commitQueue] = useState([]);
  const queueRef = useRef([]);
  const cycleTracksRef = useRef([]);
  const unshuffledRef = useRef(null);
  const [repeatMode, setRepeatMode] = useState('off');
  const repeatModeRef = useRef('off');
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [autoplayEnabled, setAutoplayEnabled] = useState(false);
  const [queueUndo, setQueueUndo] = useState(null);
  const undoRef = useRef(null);
  const commitPreparedQueue = useCallback((tracks) => {
    queueRef.current = tracks;
    commitQueue(tracks);
  }, []);
  const setUpNextQueue = useCallback((update) => {
    const incoming = typeof update === 'function' ? update(queueRef.current) : update;
    const next = projectTrackRatings(incoming);
    if (next === queueRef.current) return;
    // Preserve occurrence identity when metadata refresh replaces DTO objects.
    const replacements = new Map();
    const upcoming = new Set(next);
    const previousEntries = new Set(queueRef.current);
    const unmatched = new Map();
    for (const track of queueRef.current) {
      if (upcoming.has(track)) continue;
      const id = String(getTrackId(track));
      const occurrences = unmatched.get(id) || [];
      occurrences.push(track);
      unmatched.set(id, occurrences);
    }
    for (const track of next) {
      if (previousEntries.has(track)) continue;
      const previous = unmatched.get(String(getTrackId(track)))?.shift();
      if (!previous) continue;
      carryQueueIdentity(previous, track);
      replacements.set(previous, track);
    }
    if (replacements.size) {
      const replace = (track) => replacements.get(track) || track;
      cycleTracksRef.current = cycleTracksRef.current.map(replace);
      if (unshuffledRef.current)
        unshuffledRef.current = unshuffledRef.current.map(replace);
    }
    next.forEach(queueKey);
    commitPreparedQueue(next);
  }, [commitPreparedQueue, projectTrackRatings]);
  const [history, commitHistory] = useState([]);
  const historyRef = useRef([]);
  const setHistory = useCallback((update) => {
    const incoming = typeof update === 'function' ? update(historyRef.current) : update;
    const next = projectTrackRatings(incoming);
    historyRef.current = next;
    commitHistory(next);
  }, [projectTrackRatings]);

  // Состояние сети и предзагрузки для Network UX
  const [networkUX, setNetworkUX] = useState(
    defaultPlaybackCoordinator.getState(),
  );

  // Сессия волны: prefetch рекомендаций подмешивает в буфер только в wave-сессии
  const isWaveSessionRef = useRef(false);
  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener('PUUK_PLAYLIST_POSITIONS_READY', ({ refreshed, added }) => {
      const current = currentTrackRef.current?.playlist_entry_id;
      if (current == null || shuffleEnabled || isWaveSessionRef.current) return;
      const position = refreshed.findIndex((track) => track.playlist_entry_id === current);
      if (position < 0) return;
      const ready = new Set(added.map((track) => track.playlist_entry_id));
      const queue = [...queueRef.current];
      const cycle = [...cycleTracksRef.current];
      for (let index = refreshed.length - 1; index > position; index--) {
        const item = refreshed[index];
        if (!ready.has(item.playlist_entry_id) ||
            queue.some((track) => track.playlist_entry_id === item.playlist_entry_id)) continue;
        const next = refreshed[index + 1];
        const insert = (list) => {
          const anchor = list.findIndex((track) => track.playlist_entry_id === next?.playlist_entry_id);
          if (next && anchor >= 0) list.splice(anchor, 0, item);
          else if (!next) list.push(item);
        };
        insert(queue);
        insert(cycle);
      }
      cycleTracksRef.current = cycle;
      if (queue.length !== queueRef.current.length) setUpNextQueue(queue);
    });
    return () => subscription.remove();
  }, [setUpNextQueue, shuffleEnabled]);
  const durableWaveRef = useRef(false);
  const reconnectPendingRef = useRef(false);
  const waveRetryAtRef = useRef(0);
  const awaitingRecommendationsRef = useRef(false);
  const waveErrorRef = useRef(null);
  const waveModeRef = useRef('idle');
  const pendingWaveSelectionRef = useRef(null);
  const setWaveMode = useCallback((mode) => {
    if (waveModeRef.current === mode) return;
    waveModeRef.current = mode;
    setWavePlaybackMode(getOfflineSession(), mode);
  }, []);
  const canRequestWave = useCallback(({ ignoreBackoff = false } = {}) =>
    getCurrentNetworkPolicy()?.isConnected !== false &&
    !reconnectPendingRef.current && (ignoreBackoff || Date.now() >= waveRetryAtRef.current), []);
  const autoplayAfterQueueRef = useRef(false);
  const collectionTracksRef = useRef([]);
  const removedQueueIdsRef = useRef(new Set());
  const queueRequestRef = useRef(null);
  const recommendationsRef = useRef(new Set());
  const refreshWaveAfterAdvanceRef = useRef(false);
  // Эпоха очереди: инвалидирует in-flight ответы fetchQueue
  const queueEpochRef = useRef(0);
  // Защита от двойного перехода
  const isAdvancingRef = useRef(false);

  // All user edits invalidate outstanding recommendation requests. The current
  // audio selection is untouched; the existing queue effect updates preloading.
  const invalidateQueueRequest = useCallback(() => {
    queueEpochRef.current += 1;
    isAdvancingRef.current = false;
    setIsLoading(false);
    undoRef.current = null;
    setQueueUndo(null);
  }, []);

  const editQueue = useCallback(
    (next, message) => {
      const before = queueRef.current;
      const cycle = cycleTracksRef.current;
      invalidateQueueRequest();
      setUpNextQueue(next);
      const upcoming = new Set(next);
      const previous = new Set(before);
      cycleTracksRef.current = cycle.filter(
        (track) =>
          track === currentTrackRef.current ||
          upcoming.has(track) ||
          !previous.has(track),
      );
      if (message) {
        const undo = {
          before,
          after: next,
          cycle,
          removedIds: new Set(removedQueueIdsRef.current),
          current: currentTrackRef.current,
          message,
        };
        undoRef.current = undo;
        setQueueUndo(undo);
      }
    },
    [invalidateQueueRequest, setUpNextQueue],
  );

  useEffect(() => {
    if (!queueUndo) return;
    if (
      queueRef.current !== queueUndo.after ||
      currentTrack !== queueUndo.current
    ) {
      undoRef.current = null;
      setQueueUndo(null);
      return;
    }
    const timer = setTimeout(() => {
      undoRef.current = null;
      setQueueUndo(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [queueUndo, currentTrack, upNextQueue]);

  const undoQueueEdit = useCallback(() => {
    const undo = undoRef.current;
    if (
      !undo ||
      queueRef.current !== undo.after ||
      currentTrackRef.current !== undo.current
    )
      return;
    invalidateQueueRequest();
    cycleTracksRef.current = undo.cycle;
    removedQueueIdsRef.current = undo.removedIds;
    setUpNextQueue(undo.before);
  }, [invalidateQueueRequest, setUpNextQueue]);

  const removeQueueTrack = useCallback(
    (key) => {
      const removed = queueRef.current.find((track) => queueKey(track) === key);
      const next = queueRef.current.filter((track) => queueKey(track) !== key);
      if (next.length !== queueRef.current.length)
        editQueue(next, 'Трек убран');
      if (removed) removedQueueIdsRef.current.add(String(getTrackId(removed)));
    },
    [editQueue],
  );

  const clearQueue = useCallback(() => {
    if (queueRef.current.length) {
      const removed = queueRef.current;
      editQueue([], 'Очередь очищена');
      for (const track of removed)
        removedQueueIdsRef.current.add(String(getTrackId(track)));
      cycleTracksRef.current = currentTrackRef.current
        ? [currentTrackRef.current]
        : [];
    }
  }, [editQueue]);

  const moveQueueTrack = useCallback(
    (key, targetKey) => {
      const next = [...queueRef.current];
      const from = next.findIndex((track) => queueKey(track) === key);
      const to = next.findIndex((track) => queueKey(track) === targetKey);
      if (from < 0 || to < 0 || from === to) return;
      next.splice(to, 0, next.splice(from, 1)[0]);
      editQueue(next);
      const cycle = cycleTracksRef.current;
      const currentIndex = cycle.indexOf(currentTrackRef.current);
      cycleTracksRef.current = [
        ...cycle.slice(0, Math.max(0, currentIndex)),
        currentTrackRef.current,
        ...next,
      ].filter(Boolean);
      unshuffledRef.current = null;
      setShuffleEnabled(false);
    },
    [editQueue],
  );

  const enqueueTrack = useCallback(
    (track, placement = 'last') => {
      const entry = normalizeTrackDto(track);
      if (!entry || !currentTrackRef.current) return false;
      entry.queueOrigin = 'manual';
      const next =
        placement === 'next'
          ? [entry, ...queueRef.current]
          : [...queueRef.current, entry];
      editQueue(next);
      const cycle = cycleTracksRef.current;
      const currentIndex = cycle.indexOf(currentTrackRef.current);
      cycleTracksRef.current = [
        ...cycle.slice(0, Math.max(0, currentIndex)),
        currentTrackRef.current,
        ...next,
      ];
      return true;
    },
    [editQueue],
  );

  const toggleShuffle = useCallback(() => {
    const original = unshuffledRef.current;
    const before = [...queueRef.current];
    let next;
    if (original) {
      const upcoming = new Set(before);
      const originalSet = new Set(original);
      next = [...original.filter(track => upcoming.has(track)), ...before.filter(track => !originalSet.has(track))];
    } else {
      next = shuffledTracks(before);
    }
    editQueue(next);
    unshuffledRef.current = original ? null : before;
    setShuffleEnabled(!original);
  }, [editQueue]);

  const cycleRepeatMode = useCallback(() => {
    const next = { off: 'all', all: 'one', one: 'off' }[repeatModeRef.current];
    repeatModeRef.current = next;
    setRepeatMode(next);
    if (next === 'all') {
      const cycle = cycleTracksRef.current;
      const members = new Set(cycle);
      cycleTracksRef.current = [
        ...cycle,
        ...queueRef.current.filter((track) => !members.has(track)),
      ];
    }
    invalidateQueueRequest();
  }, [invalidateQueueRequest]);

  const toggleAutoplay = useCallback(() => {
    autoplayAfterQueueRef.current = !autoplayAfterQueueRef.current;
    setAutoplayEnabled(autoplayAfterQueueRef.current);
    invalidateQueueRequest();
  }, [invalidateQueueRequest]);

  const playbackEpisodeRef = useRef(null);
  const confirmedStartRef = useRef(new Set());
  const playbackRequestRef = useRef(0);
  const currentRequestIdRef = useRef(null);
  const mountedRef = useRef(false);
  const retryPreloadRef = useRef(null);
  const intentRef = useRef('pause');
  const transitionEpochRef = useRef(0);
  const [loadedPlayback, setLoadedPlayback] = useState(null);
  const initialUser =
    typeof getCachedUser === 'function' ? getCachedUser() : null;
  const currentUserIdRef = useRef(
    initialUser
      ? String(
          initialUser.id ||
            initialUser.user_id ||
            initialUser.username ||
            'user',
        )
      : 'anonymous',
  );
  const initialSessionId = 'sess_' + Math.random().toString(36).slice(2, 9);
  const sessionIdRef = useRef(initialSessionId);
  const [playbackSessionId, setPlaybackSessionId] = useState(initialSessionId);
  const authEpochRef = useRef(0);
  const authReadyRef = useRef(Boolean(initialUser));

  const player = useAudioPlayer(null, {
    // Exact positions are observed locally by lyrics/progress, not by App.
    updateInterval: 100,
    keepAudioSessionActive: true,
  });

  useEffect(() => {
    const unsubscribe = typeof addSessionListener === 'function' ? addSessionListener(() => {
      playbackEpisodeRef.current = null;
      // Synchronous native revocation precedes SecureStore writes/auth rendering.
      defaultPlaybackCoordinator.cancelCurrent('logout', player);
      defaultAudioCache.revoke();
      currentRequestIdRef.current = null;
      playbackRequestRef.current += 1;
      authEpochRef.current += 1;
      queueEpochRef.current += 1;
      intentRef.current = 'pause';
      durableWaveRef.current = false;
      isWaveSessionRef.current = false;
      waveRetryAtRef.current = 0;
      reconnectPendingRef.current = false;
      waveModeRef.current = 'idle';
      awaitingRecommendationsRef.current = false;
      setCurrentTrack(null);
      setUpNextQueue([]);
      setHistory([]);
      setLoadedPlayback(null);
      setIsLoading(false);
    }) : () => {};
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') defaultPlaybackCoordinator.foreground();
      else { defaultAudioCache.setForeground(false); defaultPreloadScheduler.cancelAll(); mediaDelivery.invalidate(); }
    });
    defaultAudioCache.setOnline(getCurrentNetworkPolicy()?.isConnected !== false);
    const network = subscribeNetworkPolicy(policy => {
      const online = policy?.isConnected !== false;
      defaultAudioCache.setOnline(online);
      if (!online) {
        reconnectPendingRef.current = true;
        awaitingRecommendationsRef.current = true;
        if (durableWaveRef.current && waveModeRef.current === 'online')
          setWaveMode('reserve');
      }
    });
    return () => { unsubscribe(); appState.remove(); network?.(); };
  }, [player, setCurrentTrack, setUpNextQueue, setWaveMode]);
  useEffect(() => {
    if (!nativeEQ) return;
    nativeEQ.bind(player);
    const reset = player.addListener('playbackStatusUpdate', event => {
      if (event.mediaServicesDidReset) nativeEQ.bind(player);
    });
    return () => {
      reset.remove();
      nativeEQ.unbind();
    };
  }, [player]);

  const status = usePlaybackState(player);
  const [playbackRate, setPlaybackRate] = useState(1);
  const actualPlaybackRateRef = useRef(1);

  // Native currentRate survives pause/resume and source replacement.
  useEffect(() => {
    player.shouldCorrectPitch = false;
  }, [player]);

  const appliedPlaybackRateRef = useRef(null);
  const changePlaybackRate = useCallback((value, { commit = true } = {}) => {
    const rate = normalizePlaybackRate(value);
    if (rate === null) return;
    actualPlaybackRateRef.current = rate;
    const applied = appliedPlaybackRateRef.current;
    if (applied?.player !== player || applied.rate !== rate) {
      player.setPlaybackRate(rate);
      appliedPlaybackRateRef.current = { player, rate };
    }
    // Slider previews reach audio immediately without rerendering App/navigation.
    if (commit) setPlaybackRate(rate);
  }, [player]);

  const [soundCheck, setSoundCheck] = useState(() => {
    try {
      const s = getSettings();
      return s?.soundCheck !== undefined ? Boolean(s.soundCheck) : true;
    } catch {
      return true;
    }
  });
  const soundCheckRef = useRef(soundCheck);
  useEffect(() => {
    soundCheckRef.current = soundCheck;
  }, [soundCheck]);

  useEffect(() => {
    const unsubscribe = addSettingsListener((newSettings) => {
      if (newSettings && newSettings.soundCheck !== undefined) {
        const next = Boolean(newSettings.soundCheck);
        setSoundCheck(next);
        soundCheckRef.current = next;
        if (player && currentTrackRef.current) {
          applyTrackNormalization(player, currentTrackRef.current, next);
        }
      }
    });
    return unsubscribe;
  }, [player]);

  const isPlaying = status.playing;
  const holdPosition = networkUX.current?.error?.holdTrack;
  const matchesSource = status.sourceIdentityVersion !== 1 ||
    status.sourceAttemptId === networkUX.current?.sourceAttemptId;
  const currentTime = holdPosition
    ? networkUX.current.positionSeconds
    : (matchesSource ? status.currentTime || 0 : 0);
  const duration = (matchesSource && status.duration) || Number(currentTrack?.duration) || 0;

  useEffect(() => {
    // Legacy presentation remains available without attributing v1 events.
    if (
      defaultPlaybackCoordinator.getState().identityAvailable ||
      !isPlaying ||
      !currentTrack
    )
      return;
    const trackId = getTrackId(currentTrack);
    if (trackId === null) return;
    if (
      !loadedPlayback ||
      loadedPlayback.request !== playbackRequestRef.current ||
      String(loadedPlayback.trackId) !== String(trackId) ||
      loadedPlayback.authEpoch !== authEpochRef.current
    )
      return;
    const key = `${currentUserIdRef.current}:${sessionIdRef.current}:${trackId}`;
    if (confirmedStartRef.current.has(key)) return;
    confirmedStartRef.current.add(key);
    recordPlayStart(trackId, { retry: 1 }).catch(() => {});
  }, [isPlaying, currentTrack, playbackSessionId, loadedPlayback, player]);

  const currentTimeRef = useRef(currentTime);
  const readCurrentTime = useCallback(() =>
    defaultPlaybackCoordinator.getState().identityAvailable === true
      ? currentTimeRef.current
      : getPlaybackSnapshot(player).currentTime ?? currentTimeRef.current,
  [player]);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  // Отслеживание смены пользователя: сброс дедупликации и таймеров повтора
  useEffect(() => {
    let isMounted = true;
    const resetAuthScopedState = (user) => {
      const newUserId = user
        ? String(user.id || user.user_id || user.username || 'user')
        : 'anonymous';
      if (currentUserIdRef.current === newUserId && authReadyRef.current)
        return;

      const hadOwner = authReadyRef.current;
      if (hadOwner) {
        playbackEpisodeRef.current = null;
        currentRequestIdRef.current = null;
        playbackRequestRef.current += 1;
        queueEpochRef.current += 1;
        retryPreloadRef.current = null;
        intentRef.current = 'pause';
        defaultPlaybackCoordinator.cancelCurrent(
          user ? 'auth-change' : 'logout',
          player,
        );
        if (!user) setCurrentTrack(null);
        setUpNextQueue([]);
        setHistory([]);
        setLoadedPlayback(null);
        setIsLoading(false);
        isAdvancingRef.current = false;
        isWaveSessionRef.current = false;
        autoplayAfterQueueRef.current = false;
        collectionTracksRef.current = [];
        removedQueueIdsRef.current.clear();
        cycleTracksRef.current = [];
        unshuffledRef.current = null;
        setShuffleEnabled(false);
        repeatModeRef.current = 'off';
        setRepeatMode('off');
        setAutoplayEnabled(false);
        undoRef.current = null;
        setQueueUndo(null);
      }
      currentUserIdRef.current = newUserId;
      authReadyRef.current = true;
      authEpochRef.current += 1;
      confirmedStartRef.current.clear();
    };

    const savedUserEpoch = authEpochRef.current;
    if (typeof getSavedUser === 'function') {
      try {
        const res = getSavedUser();
        if (res && typeof res.then === 'function') {
          res
            .then((user) => {
              if (isMounted && savedUserEpoch === authEpochRef.current) {
                resetAuthScopedState(user);
              }
            })
            .catch(() => {});
        } else if (isMounted) {
          authReadyRef.current = true;
        }
      } catch {
        authReadyRef.current = true;
      }
    } else {
      authReadyRef.current = true;
    }

    const unsubscribe =
      typeof addAuthListener === 'function'
        ? addAuthListener((user) => {
            resetAuthScopedState(user);
          })
        : () => {};

    return () => {
      isMounted = false;
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [player, setCurrentTrack, setUpNextQueue, setHistory]);

  // Конфигурация фонового воспроизведения и системной аудиосессии iOS
  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).catch((err) => {
      console.warn('Failed to configure audio mode:', err);
    });
  }, []);

  // Подписка на состояние координатора (сеть, предзагрузка)
  useEffect(() => {
    const unsubscribe = defaultPlaybackCoordinator.subscribe((state) => {
      setNetworkUX(state);
    });
    return unsubscribe;
  }, []);

  // Отслеживание медленной буферизации
  useEffect(() => {
    defaultPlaybackCoordinator.handleBufferingStatus(
      Boolean(status?.isBuffering),
    );
  }, [status?.isBuffering]);

  // Синхронизация очереди с координатором и планировщиком предзагрузки
  useEffect(() => {
    let active = true;
    const epoch = authEpochRef.current;
    const request = currentRequestIdRef.current;
    const queueEpoch = queueEpochRef.current;
    const sync = (headers) => {
      if (
        active &&
        mountedRef.current &&
        epoch === authEpochRef.current &&
        request === currentRequestIdRef.current &&
        queueEpoch === queueEpochRef.current
      ) {
        defaultPlaybackCoordinator.updateQueue(
          currentTrackRef.current,
          queueRef.current,
          { headers },
        );
      }
    };
    getAuthHeaders()
      .then(sync)
      .catch(() => sync(undefined));
    return () => {
      active = false;
    };
  }, [currentTrack, upNextQueue]);

  const creditSetTracksRef = useRef(setTracks);
  creditSetTracksRef.current = setTracks;
  const creditContextRef = useRef(null);
  const currentTrackId = getTrackId(currentTrack);
  const previousContext = creditContextRef.current;
  const sameSelection = previousContext && previousContext.currentTrackId === currentTrackId &&
    sameTrackOrder(previousContext.upNextQueue, upNextQueue) && sameTrackOrder(previousContext.history, history);
  const creditContextEpoch = (previousContext?.epoch || 0) + (sameSelection ? 0 : 1);
  creditContextRef.current = {
    currentTrackId,
    epoch: creditContextEpoch,
    currentTrack,
    upNextQueue,
    history,
  };

  // Credit edits patch metadata only; playback and position remain owned by the audio engine.
  useEffect(() => {
    let active = true;
    const versions = new Map();
    const pending = new Map();
    let running = 0;
    const patchTracks = (updates) => {
      if (!active || !updates.length) return;
      const byId = new Map(
        updates
          .filter((track) => getTrackId(track) !== null)
          .map((track) => [String(getTrackId(track)), track]),
      );
      const merge = (track) => {
        const incoming = track && byId.get(String(getTrackId(track)));
        if (!incoming) return track;
        const patch = {};
        for (const key of [
          'artist',
          'artist_id',
          'artists',
          'artists_revision',
          'album_artist',
          'album_artists',
          'album_artists_revision',
        ]) {
          if (Object.prototype.hasOwnProperty.call(incoming, key))
            patch[key] = incoming[key];
        }
        return { ...track, ...patch };
      };
      setCurrentTrack((previous) => {
        const updated = merge(previous);
        if (updated !== previous) currentTrackRef.current = updated;
        return updated;
      });
      setUpNextQueue((previous) => previous.map(merge));
      setHistory((previous) => previous.map(merge));
      creditSetTracksRef.current?.((previous) => previous.map(merge));
    };
    const pump = () => {
      while (active && running < 4 && pending.size) {
        const [id, task] = pending.entries().next().value;
        pending.delete(id);
        if (
          versions.get(id) !== task.version ||
          authEpochRef.current !== task.authEpoch ||
          SERVER_URL !== task.server ||
          creditContextRef.current.epoch !== task.context
        )
          continue;
        running += 1;
        (async () => {
          try {
            const response = await authFetch(
              `/api/tracks/${encodeURIComponent(id)}?credits_only=true`,
            );
            const track = response.ok ? await response.json() : null;
            if (
              active &&
              versions.get(id) === task.version &&
              authEpochRef.current === task.authEpoch &&
              SERVER_URL === task.server &&
              creditContextRef.current.epoch === task.context &&
              track &&
              String(getTrackId(track)) === id
            )
              patchTracks([track]);
          } catch {
            /* Preserve existing metadata for a later refresh. */
          }
        })().finally(() => {
          running -= 1;
          pump();
        });
      }
    };
    const unsubscribe = subscribeArtistCreditsUpdated((event) => {
      const updates =
        event.scope === 'track'
          ? [event.track]
          : event.scope === 'album'
            ? event.tracks || []
            : [];
      const ids =
        event.scope === 'bulk'
          ? event.affected?.track_ids || []
          : updates.map(getTrackId);
      const uniqueIds = [
        ...new Set(
          ids
            .map(getTrackId)
            .filter((id) => id !== null)
            .map(String),
        ),
      ];
      for (const id of uniqueIds) {
        versions.set(id, (versions.get(id) || 0) + 1);
        pending.delete(id);
      }
      if (event.scope !== 'bulk') {
        patchTracks(updates);
        return;
      }
      const context = creditContextRef.current;
      const relevant = new Set(
        [context.currentTrack, ...context.upNextQueue, ...context.history]
          .map(getTrackId)
          .filter((id) => id !== null)
          .map(String),
      );
      for (const id of uniqueIds) {
        if (relevant.has(id))
          pending.set(id, {
            version: versions.get(id),
            authEpoch: authEpochRef.current,
            server: SERVER_URL,
            context: context.epoch,
          });
      }
      pump();
    });
    return () => {
      active = false;
      pending.clear();
      unsubscribe();
    };
  }, []);

  const requestExpandPlayer = useCallback(() => {
    setIsPlayerVisible(true);
    setPlayerExpandToken((prev) => prev + 1);
  }, []);

  /** Фоновое обновление метаданных громкости (EBU R128), если трек еще pending */
  const refreshTrackLoudness = useCallback(
    async (trackId) => {
      if (trackId === undefined || trackId === null || trackId === '') return;
      const authEpoch = authEpochRef.current;
      try {
        const res = await authFetch(
          `/api/tracks/${encodeURIComponent(trackId)}`,
        );
        if (!res.ok) return;
        const fresh = await res.json();
        if (!mountedRef.current || authEpoch !== authEpochRef.current) return;
        if (
          !fresh ||
          fresh.loudness_status !== 'analyzed' ||
          fresh.normalization_gain_db == null
        )
          return;

        const patch = {
          loudness_status: fresh.loudness_status,
          normalization_gain_db: fresh.normalization_gain_db,
          loudness_lufs: fresh.loudness_lufs ?? null,
          true_peak_db: fresh.true_peak_db ?? null,
        };

        const activeTrack = currentTrackRef.current;
        if (areTrackIdsEqual(activeTrack, trackId)) {
          const updated = { ...activeTrack, ...patch };
          currentTrackRef.current = updated;
          if (player) {
            applyTrackNormalization(player, updated, soundCheckRef.current);
          }
          setCurrentTrack(updated);
        }

        setUpNextQueue((prev) =>
          prev.map((t) =>
            areTrackIdsEqual(t, trackId) ? { ...t, ...patch } : t,
          ),
        );
      } catch {
        // Метаданные громкости не критичны для непрерывности воспроизведения
      }
    },
    [player],
  );

  const lastPlayedTrackIdRef = useRef(null);

  /** Делегируем воспроизведение координатору */
  const loadAndPlay = useCallback(
    (track, context = isWaveSessionRef.current ? 'wave' : 'manual', { offlineOnly = false, startingRequest } = {}) => {
      if (!mountedRef.current) return Promise.resolve({ superseded: true });
      track = projectRating(track);
      const trackId = getTrackId(track);
      if (lastPlayedTrackIdRef.current !== null && trackId !== null &&
          !areTrackIdsEqual(lastPlayedTrackIdRef.current, trackId)) {
        changePlaybackRate(1);
      }
      lastPlayedTrackIdRef.current = trackId;
      const request = ++playbackRequestRef.current;
      const requestId = `selection_${++selectionSequence}`;
      const authEpoch = authEpochRef.current;
      if (queueRequestRef.current !== startingRequest) queueRequestRef.current?.controller.abort();
      completePlayback(playbackEpisodeRef.current, 'skip');
      playbackEpisodeRef.current = createPlaybackEpisode(
        requestId, trackId, context,
        () => actualPlaybackRateRef.current, track?.duration,
      );
      currentRequestIdRef.current = null;
      defaultPlaybackCoordinator.cancelCurrent('superseded', player);
      currentRequestIdRef.current = requestId;
      currentTimeRef.current = 0;
      intentRef.current = 'play';
      setLoadedPlayback(null);
      const reportPlaybackError = () => {
        console.error('[usePlayerController] Playback command failed');
      };

      let playbackPromise;
      try {
        const cached =
          typeof getCachedAuthHeaders === 'function'
            ? getCachedAuthHeaders()
            : null;
        playbackPromise = defaultPlaybackCoordinator.play(player, track, {
          headers: cached || undefined,
          getHeadersAsync: getAuthHeaders,
          soundCheck: soundCheckRef.current,
          requestId,
          authEpoch,
          getHeaders: getAuthHeaders,
          ...(offlineOnly ? { offlineOnly: true } : {}),
        });
      } catch (e) {
        reportPlaybackError(e);
        return Promise.resolve({ isLocal: false, uri: null, error: e });
      }

      return Promise.resolve(playbackPromise)
        .then((result) => {
          if (
            mountedRef.current &&
            request === playbackRequestRef.current &&
            authEpoch === authEpochRef.current &&
            result?.uri &&
            !result.error &&
            !result.superseded
          ) {
            if (!result.isLocal && trackId !== null && track?.loudness_status !== 'analyzed') {
              refreshTrackLoudness(trackId);
            }
            setLoadedPlayback({
              request,
              authEpoch,
              trackId: getTrackId(track),
            });
          }
          return result;
        })
        .catch((error) => {
          reportPlaybackError(error);
          return { isLocal: false, uri: null, error };
        });
    },
    [player, refreshTrackLoudness, changePlaybackRate, projectRating],
  );

  const saveCurrentWave = useCallback(() => {
    const session = getOfflineSession();
    if (!durableWaveRef.current || !session || !currentTrackRef.current || pendingWaveSelectionRef.current) return;
    void saveWaveQueue(session, {
      current: currentTrackRef.current, future: queueRef.current, history: historyRef.current,
    }, {
      updateReserve: canRequestWave() && !awaitingRecommendationsRef.current,
    }).catch(() => {});
  }, [canRequestWave]);

  const fetchQueue = useCallback((trackId, exclusions = {}, { replaceRecommendations = false, startingRequest } = {}) => {
    const epoch = queueEpochRef.current;
    const selection = currentRequestIdRef.current;
    const session = getOfflineSession();
    const durable = durableWaveRef.current;
    const isCurrent = () => mountedRef.current && epoch === queueEpochRef.current &&
      selection === currentRequestIdRef.current && (!session || isOfflineSessionCurrent(session));
    if (!isCurrent() || (durable && !canRequestWave())) return Promise.resolve([]);
    const pending = queueRequestRef.current;
    if (pending?.epoch === epoch && pending.selection === selection && !pending.controller.signal.aborted) {
      return pending.promise;
    }
    if (pending !== startingRequest) pending?.controller.abort();
    const hardExclusions = [
      ...collectionTracksRef.current.map(getTrackId),
      ...removedQueueIdsRef.current,
      ...dislikeIdsRef.current,
    ];
    const excludeIds = [...(exclusions.excludeIds || []), ...hardExclusions];
    const excluded = new Set(
      [trackId, ...(durable && replaceRecommendations ? hardExclusions : excludeIds),
        ...(exclusions.queuedIds || [])]
        .filter((id) => id !== null && id !== undefined)
        .map(String),
    );
    const controller = startingRequest?.controller ?? new AbortController();
    const { signal } = controller;
    const request = { epoch, selection, controller };
    queueRequestRef.current = request;
    request.promise = (async () => {
      try {
        const data = await (startingRequest?.response ?? requestWave(buildWaveQueueUrl(trackId, { ...exclusions, excludeIds }), signal));
        if (!isCurrent() || signal.aborted) return [];
        if (durable && !canRequestWave()) return [];
        if (!Array.isArray(data)) throw new Error('Invalid Wave queue');
        const normalizedQueue = mergeUniqueQueue(
          [],
          data.map(normalizeTrackDto)
            .filter(
              (track) => track && !excluded.has(String(getTrackId(track))) && !dislikeIdsRef.current.has(String(getTrackId(track))),
            ),
        );
        if (durable && replaceRecommendations && !normalizedQueue.length) {
          if (awaitingRecommendationsRef.current)
            waveRetryAtRef.current = Date.now() + WAVE_RETRY_DELAY;
          return [];
        }
        const previousRecommendations = recommendationsRef.current;
        const existing = replaceRecommendations
          ? queueRef.current.filter((track) => !previousRecommendations.has(queueKey(track)))
          : queueRef.current;
        const next = mergeUniqueQueue(existing, normalizedQueue);
        recommendationsRef.current = new Set(next.filter(
          (track) => normalizedQueue.includes(track) ||
            (!replaceRecommendations && previousRecommendations.has(queueKey(track))),
        ).map(queueKey));
        setUpNextQueue(next);
        if (startingRequest) cycleTracksRef.current = [currentTrackRef.current, ...queueRef.current];
        if (durable && normalizedQueue.length) {
          waveRetryAtRef.current = 0;
          awaitingRecommendationsRef.current = false;
          saveCurrentWave();
        } else if (durable && awaitingRecommendationsRef.current) {
          waveRetryAtRef.current = Date.now() + WAVE_RETRY_DELAY;
        }
        return normalizedQueue;
      } catch (error) {
        if (isCurrent() && !signal.aborted && error.name !== 'AbortError') {
          if (durable && isOfflineSessionCurrent(session)) {
            waveRetryAtRef.current = Date.now() + WAVE_RETRY_DELAY;
            awaitingRecommendationsRef.current = true;
            if (waveModeRef.current === 'online') setWaveMode('reserve');
          }
          console.warn('Failed to load queue:', error.message);
        }
        return [];
      } finally {
        if (queueRequestRef.current === request)
          queueRequestRef.current = null;
      }
    })();
    return request.promise;
  }, [setUpNextQueue, setWaveMode, canRequestWave, saveCurrentWave]);

  const refreshFutureWave = useCallback(() => {
    const trackId = getTrackId(currentTrackRef.current);
    if (!isWaveSessionRef.current || trackId === null) {
      refreshWaveAfterAdvanceRef.current = false;
      return;
    }
    if (isAdvancingRef.current) {
      refreshWaveAfterAdvanceRef.current = true;
      return;
    }
    refreshWaveAfterAdvanceRef.current = false;
    queueEpochRef.current += 1;
    fetchQueue(trackId, {
      excludeIds: historyRef.current.map(getTrackId),
      queuedIds: queueRef.current.filter((track) =>
        !recommendationsRef.current.has(queueKey(track)),
      ).map(getTrackId),
    }, { replaceRecommendations: true });
  }, [fetchQueue]);

  useEffect(saveCurrentWave, [saveCurrentWave, creditContextEpoch]);

  useEffect(() => {
    const trackId = getTrackId(currentTrackRef.current);
    if (!durableWaveRef.current || pendingWaveSelectionRef.current ||
        !currentRequestIdRef.current || trackId === null ||
        !canRequestWave() || awaitingRecommendationsRef.current || !queueRef.current.length) return;
    const target = (getSettings()?.waveReserveMinutes ?? DEFAULT_WAVE_RESERVE_MINUTES) * 60;
    if (queueRef.current.reduce((seconds, track) => seconds + waveTrackDuration(track), 0) >= target) return;
    void fetchQueue(trackId, {
      excludeIds: historyRef.current.map(getTrackId),
      queuedIds: queueRef.current.map(getTrackId),
    });
  }, [creditContextEpoch, canRequestWave, fetchQueue]);

  const applyWaveSnapshot = useCallback((snapshot) => {
    const projected = [snapshot.current, ...snapshot.future, ...snapshot.history].map(normalizeTrackDto);
    const current = projected[0];
    if (!current) return null;
    const future = projected.slice(1, snapshot.future.length + 1).filter(Boolean);
    const previous = projected.slice(snapshot.future.length + 1).filter(Boolean);
    durableWaveRef.current = true;
    isWaveSessionRef.current = true;
    autoplayAfterQueueRef.current = true;
    setAutoplayEnabled(true);
    setCurrentTrack(current);
    setUpNextQueue(future);
    setHistory(previous);
    recommendationsRef.current = new Set(future.map(queueKey));
    cycleTracksRef.current = [current, ...future];
    return current;
  }, [setCurrentTrack, setUpNextQueue, setHistory]);

  const restoreSavedWave = useCallback(async (session, track) => {
    const epoch = queueEpochRef.current;
    const snapshot = await readWaveQueue(session);
    if (!mountedRef.current || !isOfflineSessionCurrent(session) ||
        queueEpochRef.current !== epoch || currentTrackRef.current ||
        !track || !areTrackIdsEqual(snapshot?.current, track)) return false;
    const current = applyWaveSnapshot(snapshot);
    if (current) {
      if (snapshot.localFuture) awaitingRecommendationsRef.current = true;
      setWaveMode(canRequestWave() && !awaitingRecommendationsRef.current ? 'online' : 'reserve');
    }
    return Boolean(current);
  }, [applyWaveSnapshot, canRequestWave, setWaveMode]);

  const seekTo = useCallback(
    (positionSeconds) => {
      if (
        !mountedRef.current ||
        !currentRequestIdRef.current ||
        !Number.isFinite(positionSeconds)
      )
        return;
      transitionEpochRef.current += 1;
      currentTimeRef.current = Math.max(0, positionSeconds);
      return defaultPlaybackCoordinator.setIntent(player, {
        type: 'seek',
        positionSeconds: currentTimeRef.current,
        requestId: currentRequestIdRef.current,
      });
    },
    [player],
  );

  const playPreviousTrack = useCallback(
    async (options = {}) => {
      if (!mountedRef.current || !currentRequestIdRef.current) return;
      const currentTrack = currentTrackRef.current;
      const history = historyRef.current;
      const upNextQueue = queueRef.current;
      const force = typeof options === 'boolean' ? options : !!options?.force;
      if (!force && (readCurrentTime() || 0) > 3) {
        seekTo(0);
        return;
      }

      if (history.length > 0) {
        const newHistory = [...history];
        let prevTrack = newHistory.pop();
        const offlineOnly = durableWaveRef.current && (!canRequestWave() || awaitingRecommendationsRef.current);
        if (offlineOnly) {
          const session = getOfflineSession();
          const request = currentRequestIdRef.current;
          const epoch = queueEpochRef.current;
          const disliked = await getLocalDislikeIds(session);
          while (prevTrack && (disliked.has(String(getTrackId(prevTrack))) ||
              !await readMediaKey(session, getTrackId(prevTrack)))) prevTrack = newHistory.pop();
          if (!isOfflineSessionCurrent(session) || request !== currentRequestIdRef.current ||
              epoch !== queueEpochRef.current) return;
          if (!prevTrack) return seekTo(0);
        }

        if (currentTrack) {
          setUpNextQueue([currentTrack, ...upNextQueue]);
        }

        currentTrackRef.current = prevTrack;
        setHistory(newHistory);
        setCurrentTrack(prevTrack);
        loadAndPlay(prevTrack, undefined, { offlineOnly });
      } else {
        seekTo(0);
      }
    },
    [
      history,
      currentTrack,
      upNextQueue,
      player,
      loadAndPlay,
      seekTo,
      readCurrentTime,
      canRequestWave,
    ],
  );

  const beginWaveSession = useCallback((session) => {
    const newSession = 'wave_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    sessionIdRef.current = newSession;
    setPlaybackSessionId(newSession);
    durableWaveRef.current = Boolean(session);
    isWaveSessionRef.current = true;
    autoplayAfterQueueRef.current = true;
    setAutoplayEnabled(true);
    removedQueueIdsRef.current.clear();
    unshuffledRef.current = null;
    setShuffleEnabled(false);
    undoRef.current = null;
    setQueueUndo(null);
    collectionTracksRef.current = [];
  }, []);

  const tryWaveTrack = useCallback(async (track, options) => {
    const selection = {};
    pendingWaveSelectionRef.current = selection;
    try {
      setCurrentTrack(track);
      const playback = loadAndPlay(track, 'wave', options);
      const requestId = currentRequestIdRef.current;
      const result = await playback;
      return requestId === currentRequestIdRef.current ? result : { superseded: true };
    } finally {
      if (pendingWaveSelectionRef.current === selection) pendingWaveSelectionRef.current = null;
    }
  }, [loadAndPlay, setCurrentTrack]);

  const advanceLocalWave = useCallback(async ({
    session, valid, current, future = [], previous, exclude = [], restart = false, readyReserve, startingRequest,
  }) => {
    const { tracks, reserveIds } = readyReserve ?? await selectLocalWaveTracks(session, {
      current: restart ? null : current,
      future, history: previous, exclude: restart ? exclude : [...exclude, ...removedQueueIdsRef.current],
    });
    const manualIds = new Set(future.filter((track) =>
      !recommendationsRef.current.has(queueKey(track)),
    ).map((track) => String(getTrackId(track))));
    for (const [index, track] of tracks.entries()) {
      if (!valid()) return false;
      const trackId = String(getTrackId(track));
      if (dislikeIdsRef.current.has(trackId)) continue;
      const next = normalizeTrackDto(track);
      if (!next) continue;
      const result = await tryWaveTrack(next, { offlineOnly: true, startingRequest });
      if (!valid({ allowIntentChange: true }) || result?.superseded) return false;
      if (result?.error) {
        if (!valid()) return false;
        continue;
      }
      const queue = tracks.slice(index + 1)
        .filter((item) => !dislikeIdsRef.current.has(String(getTrackId(item))))
        .slice(0, Math.max(LOCAL_WAVE_BATCH_SIZE, future.length) - 1)
        .map(normalizeTrackDto).filter(Boolean);
      if (restart) beginWaveSession(session);
      awaitingRecommendationsRef.current = true;
      const mode = reserveIds.has(trackId) ? 'reserve' : 'library';
      setWaveMode(mode);
      setUpNextQueue(queue);
      recommendationsRef.current = new Set(queueRef.current.filter((item) =>
        !manualIds.has(String(getTrackId(item))),
      ).map(queueKey));
      if (restart) cycleTracksRef.current = [next, ...queue];
      setHistory(!restart && current ? [...previous, current].slice(-MAX_HISTORY) : previous);
      saveCurrentWave();
      return true;
    }
    if (!readyReserve && valid()) {
      if (currentTrackRef.current !== current) setCurrentTrack(current);
      setWaveMode('empty');
    }
    return false;
  }, [beginWaveSession, tryWaveTrack, saveCurrentWave, setCurrentTrack, setUpNextQueue, setHistory, setWaveMode]);

  const fetchNextTrack = useCallback(
    async ({ finished = false, forceLocal = false } = {}) => {
      const currentTrack = currentTrackRef.current;
      const upNextQueue = queueRef.current;
      const history = historyRef.current;
      if (!mountedRef.current || !currentTrack || !currentRequestIdRef.current)
        return;
      if (isAdvancingRef.current) {
        if (finished || forceLocal || !upNextQueue.length) return;
        // A manual skip can supersede an unfinished selection with a known next track.
        queueEpochRef.current += 1;
        queueRequestRef.current?.controller.abort();
      }
      isAdvancingRef.current = true;
      const epoch = queueEpochRef.current;
      const transition = transitionEpochRef.current;
      const session = getOfflineSession();
      const valid = ({ allowIntentChange = false } = {}) => epoch === queueEpochRef.current &&
        (allowIntentChange || transition === transitionEpochRef.current) && isOfflineSessionCurrent(session);
      const advanceLocal = (exclude = []) => advanceLocalWave({
        session, valid, current: currentTrack, future: queueRef.current, previous: history, exclude,
      });

      try {
        setIsLoading(true);
        if (durableWaveRef.current && (forceLocal || !canRequestWave() || awaitingRecommendationsRef.current)) {
          if (canRequestWave()) refreshWaveAfterAdvanceRef.current = true;
          if (await advanceLocal(forceLocal ? [currentTrack] : [])) return;
          if (!valid()) return;
          intentRef.current = 'pause';
          defaultPlaybackCoordinator.setIntent(player, { type: 'pause', requestId: currentRequestIdRef.current });
          return;
        }
        if (finished && repeatModeRef.current === 'one' &&
          (!isWaveSessionRef.current || !dislikeIdsRef.current.has(String(getTrackId(currentTrack))))) {
          await loadAndPlay(currentTrack, playbackEpisodeRef.current?.context);
          return;
        }
        let candidates = upNextQueue;

        if (candidates.length === 0 && repeatModeRef.current === 'all') {
          const cycle = cycleTracksRef.current.length
            ? cycleTracksRef.current
            : [currentTrack];
          candidates = unshuffledRef.current ? shuffledTracks(cycle) : cycle;
          if (isWaveSessionRef.current)
            candidates = candidates.filter((track) => !dislikeIdsRef.current.has(String(getTrackId(track))));
        }

        // A collection remains ordered until its final track has finished.
        if (
          candidates.length === 0 &&
          autoplayAfterQueueRef.current &&
          repeatModeRef.current === 'off'
        ) {
          candidates = await fetchQueue(getTrackId(currentTrack), {
            excludeIds: history.map(getTrackId).filter((id) => id !== null),
            queuedIds: [],
          });
          if (
            epoch !== queueEpochRef.current ||
            transition !== transitionEpochRef.current
          )
            return;
          isWaveSessionRef.current = true;
          if (durableWaveRef.current && candidates.length === 0 && await advanceLocal()) return;
          if (durableWaveRef.current && !valid()) return;
        }

        const nextTrack = candidates[0];
        if (nextTrack) {
          const newQueue = candidates.slice(1);
          // Slicing the active queue preserves every remaining occurrence and rating.
          if (candidates === queueRef.current) commitPreparedQueue(newQueue);
          else setUpNextQueue(newQueue);
          setHistory((prev) => [...prev, currentTrack].slice(-MAX_HISTORY));
          const nextTrackId = getTrackId(nextTrack);
          const currentTrackId = getTrackId(currentTrack);

          currentTrackRef.current = nextTrack;
          setCurrentTrack(nextTrack);
          if (durableWaveRef.current) setWaveMode('online');
          const playPromise = loadAndPlay(nextTrack);

          if (
            isWaveSessionRef.current &&
            autoplayAfterQueueRef.current &&
            repeatModeRef.current === 'off' &&
            newQueue.length < 3
          ) {
            fetchQueue(nextTrackId, {
              excludeIds: [
                ...history.map(getTrackId).filter((id) => id !== null),
                currentTrackId,
              ],
              queuedIds: newQueue.map(getTrackId).filter((id) => id !== null),
            });
          }

          const result = await playPromise;
          if (durableWaveRef.current && valid() && !result?.superseded && result?.error) {
            waveRetryAtRef.current = Date.now() + WAVE_RETRY_DELAY;
            awaitingRecommendationsRef.current = true;
            await advanceLocal([nextTrack]);
          }
        } else {
          intentRef.current = 'pause';
          defaultPlaybackCoordinator.setIntent(player, {
            type: 'pause',
            requestId: currentRequestIdRef.current,
          });
        }
      } finally {
        if (epoch === queueEpochRef.current) {
          setIsLoading(false);
          isAdvancingRef.current = false;
          if (refreshWaveAfterAdvanceRef.current) refreshFutureWave();
        }
      }
    },
    [player, loadAndPlay, fetchQueue, refreshFutureWave, setHistory, setCurrentTrack, setUpNextQueue, commitPreparedQueue, advanceLocalWave, canRequestWave, setWaveMode],
  );

  const fetchNextTrackRef = useRef(fetchNextTrack);
  const playPreviousTrackRef = useRef(playPreviousTrack);

  useEffect(() => {
    fetchNextTrackRef.current = fetchNextTrack;
  }, [fetchNextTrack]);

  useEffect(() => {
    playPreviousTrackRef.current = playPreviousTrack;
  }, [playPreviousTrack]);

  useEffect(() => {
    const state = networkUX.current;
    if (!durableWaveRef.current || waveModeRef.current === 'empty' || state?.status !== 'error' ||
        state.error?.holdTrack ||
        state.requestId !== currentRequestIdRef.current || waveErrorRef.current === state.requestId ||
        isAdvancingRef.current || pendingWaveSelectionRef.current) return;
    waveErrorRef.current = state.requestId;
    // A terminal source failure ends this episode without a listening outcome.
    playbackEpisodeRef.current = null;
    waveRetryAtRef.current = Date.now() + WAVE_RETRY_DELAY;
    awaitingRecommendationsRef.current = true;
    void fetchNextTrackRef.current?.({ forceLocal: true });
  }, [networkUX]);

  // Direct transport: React status snapshots can skip a one-event error/finish.
  useEffect(() => {
    mountedRef.current = true;
    const capable = () =>
      defaultPlaybackCoordinator.getState().identityAvailable === true;
    const validSelection = () =>
      mountedRef.current && currentRequestIdRef.current;
    const onStatus = (event) => {
      if (!validSelection()) return;
      const requestId = currentRequestIdRef.current;
      const result = defaultPlaybackCoordinator.handleNativeStatus(
        player,
        event,
      );
      if (!result.accepted || requestId !== currentRequestIdRef.current) return;
      const state = defaultPlaybackCoordinator.getState().current;
      if (
        state?.intent === 'pause' ||
        (event.nativeEvent === 'seekIntent' && event.seekOrigin === 'user')
      ) {
        transitionEpochRef.current += 1;
      }
      intentRef.current = state?.intent || intentRef.current;
      if (Number.isFinite(event.currentTime))
        currentTimeRef.current = event.currentTime;
      if (result.didStart && !confirmedStartRef.current.has(requestId)) {
        confirmedStartRef.current.add(requestId);
        const trackId = getTrackId(currentTrackRef.current);
        if (trackId !== null)
          recordPlayStart(trackId, { retry: 1 }).catch(() => {});
      }
      const episode = playbackEpisodeRef.current;
      if (episode?.requestId === requestId && state?.requestId === requestId) {
        observePlayback(episode, event, state.intent);
        if (result.didFinish) {
          episode.finishRevision = event.intentRevision;
          completePlayback(episode, 'finish');
        } else if (episode.finished === 'finish' && event.nativeEvent === 'intent' &&
          event.nativeIntent === 'play' && event.intentRevision > episode.finishRevision) {
          transitionEpochRef.current += 1;
          invalidateQueueRequest();
          loadAndPlay(currentTrackRef.current, episode.context);
        }
      }
      if (result.didFinish) fetchNextTrackRef.current?.({ finished: true });
    };
    const onSkip = (callback, event) => {
      if (!validSelection()) return;
      if (
        capable() &&
        !defaultPlaybackCoordinator.handleNativeStatus(player, event).accepted
      )
        return;
      callback.current?.();
    };
    const statusSub = player?.addListener?.('playbackStatusUpdate', onStatus);
    const nextSub = player?.addListener?.('nextTrack', (event) =>
      onSkip(fetchNextTrackRef, event),
    );
    const prevSub = player?.addListener?.('previousTrack', (event) =>
      onSkip(playPreviousTrackRef, event),
    );
    return () => {
      mountedRef.current = false;
      queueRequestRef.current?.controller.abort();
      playbackEpisodeRef.current = null;
      currentRequestIdRef.current = null;
      playbackRequestRef.current += 1;
      queueEpochRef.current += 1;
      intentRef.current = 'pause';
      statusSub?.remove?.();
      nextSub?.remove?.();
      prevSub?.remove?.();
      defaultPlaybackCoordinator.cancelCurrent('unmount', player);
    };
  }, [player, invalidateQueueRequest, loadAndPlay]);

  // Old binaries retain completion presentation, without v1 recovery attribution.
  useEffect(() => {
    if (
      !defaultPlaybackCoordinator.getState().identityAvailable &&
      status?.didJustFinish &&
      currentRequestIdRef.current
    ) {
      fetchNextTrackRef.current?.({ finished: true });
    }
  }, [player, status?.didJustFinish]);

  const togglePlayPause = useCallback(() => {
    if (!mountedRef.current) return;
    if (!currentRequestIdRef.current) {
      const restoredTrack = currentTrackRef.current;
      const session = getOfflineSession();
      if (getTrackId(restoredTrack) !== null && session) {
        if (durableWaveRef.current && (!canRequestWave() || awaitingRecommendationsRef.current)) {
          const epoch = queueEpochRef.current;
          const valid = () => mountedRef.current && epoch === queueEpochRef.current &&
            isOfflineSessionCurrent(session);
          return readMediaKey(session, getTrackId(restoredTrack)).then((key) => {
            if (!valid()) return;
            if (key) return loadAndPlay(restoredTrack, 'wave', { offlineOnly: true });
            return advanceLocalWave({
              session, valid, current: restoredTrack, future: queueRef.current, previous: historyRef.current,
            });
          });
        }
        return loadAndPlay(restoredTrack, durableWaveRef.current ? 'wave' : 'manual');
      }
      return;
    }
    const current = defaultPlaybackCoordinator.getState().current;
    const type =
      (current?.intent || intentRef.current) === 'play' ? 'pause' : 'play';
    if (type === 'play' && playbackEpisodeRef.current?.finished === 'finish') {
      const { context } = playbackEpisodeRef.current;
      invalidateQueueRequest();
      return loadAndPlay(currentTrackRef.current, context);
    }
    transitionEpochRef.current += 1;
    intentRef.current = type;
    return defaultPlaybackCoordinator.setIntent(player, {
      type,
      requestId: currentRequestIdRef.current,
    });
  }, [player, invalidateQueueRequest, loadAndPlay, advanceLocalWave, canRequestWave]);

  const retryCurrent = useCallback(() => {
    if (!mountedRef.current || !currentRequestIdRef.current)
      return Promise.resolve();
    return defaultPlaybackCoordinator.retryCurrent(player, {
      requestId: currentRequestIdRef.current,
      authEpoch: authEpochRef.current,
      getHeaders: getAuthHeaders,
    });
  }, [player]);

  const retryPreload = useCallback(() => {
    if (retryPreloadRef.current) return retryPreloadRef.current;
    const request = currentRequestIdRef.current;
    const authEpoch = authEpochRef.current;
    const queueEpoch = queueEpochRef.current;
    if (!mountedRef.current || !request) return Promise.resolve();
    const pending = getAuthHeaders()
      .then((headers) => {
        if (
          mountedRef.current &&
          request === currentRequestIdRef.current &&
          authEpoch === authEpochRef.current &&
          queueEpoch === queueEpochRef.current
        ) {
          defaultPlaybackCoordinator.updateQueue(
            currentTrackRef.current,
            queueRef.current,
            { headers, force: true },
          );
        }
      })
      .catch(() => {})
      .finally(() => {
        if (retryPreloadRef.current === pending) retryPreloadRef.current = null;
      });
    retryPreloadRef.current = pending;
    return pending;
  }, []);

  const playTrack = useCallback(
    (track, { source = 'single', queueIndex } = {}) => {
      if (!mountedRef.current || !track) return;
      const trackId = getTrackId(track);
      if (trackId === null) return;
      const activeTrack = currentTrackRef.current;
      const currentId = getTrackId(activeTrack);
      const previousHistory = historyRef.current;

      if (activeTrack && !areTrackIdsEqual(activeTrack, trackId)) {
        setHistory((prev) => [...prev, activeTrack].slice(-MAX_HISTORY));
      }
      if (!activeTrack || !areTrackIdsEqual(activeTrack, trackId)) {
        const newSession =
          'track_' +
          Date.now().toString(36) +
          '_' +
          Math.random().toString(36).slice(2, 6);
        sessionIdRef.current = newSession;
        setPlaybackSessionId(newSession);
      }
      currentTrackRef.current = track;
      if (source !== 'queue') {
        durableWaveRef.current = false;
        setWaveMode('idle');
        awaitingRecommendationsRef.current = false;
        isWaveSessionRef.current = source === 'search';
        autoplayAfterQueueRef.current = source === 'search';
        collectionTracksRef.current = [];
        removedQueueIdsRef.current.clear();
        cycleTracksRef.current = [track];
        unshuffledRef.current = null;
        setShuffleEnabled(false);
        setAutoplayEnabled(autoplayAfterQueueRef.current);
        undoRef.current = null;
        setQueueUndo(null);
      }
      setCurrentTrack(track);
      loadAndPlay(track, source === 'queue' && isWaveSessionRef.current ? 'wave' : 'manual');
      // Инвалидируем ответы старой очереди до запуска нового запроса.
      // Иначе fetchQueue захватит уже устаревшую эпоху и сможет примешать
      // старый ответ к новой сессии воспроизведения.
      queueEpochRef.current += 1;
      isAdvancingRef.current = false;
      setIsLoading(false);
      commitPreparedQueue(
        source === 'queue' ? queueRef.current.slice(queueIndex + 1) : [],
      );
      if (source === 'search')
        fetchQueue(trackId, {
          excludeIds: [
            ...previousHistory.map(getTrackId).filter((id) => id !== null),
            currentId,
          ],
          queuedIds: [],
        });
    },
    [
      setCurrentTrack,
      setHistory,
      commitPreparedQueue,
      fetchQueue,
      loadAndPlay,
      setWaveMode,
    ],
  );

  const playTrackList = useCallback(
    (trackList, startIndex = 0) => {
      if (!mountedRef.current || !trackList || trackList.length === 0) return;
      const track = trackList[startIndex];
      if (!track) return;
      const trackId = getTrackId(track);
      if (trackId === null) return;
      const newSession =
        'list_' +
        Date.now().toString(36) +
        '_' +
        Math.random().toString(36).slice(2, 6);
      sessionIdRef.current = newSession;
      setPlaybackSessionId(newSession);
      currentTrackRef.current = track;
      durableWaveRef.current = false;
      setWaveMode('idle');
      awaitingRecommendationsRef.current = false;
      isWaveSessionRef.current = false;
      autoplayAfterQueueRef.current = true;
      setAutoplayEnabled(true);
      cycleTracksRef.current = [];
      recommendationsRef.current.clear();
      removedQueueIdsRef.current.clear();
      unshuffledRef.current = null;
      setShuffleEnabled(false);
      undoRef.current = null;
      setQueueUndo(null);
      queueEpochRef.current += 1;
      isAdvancingRef.current = false;
      setIsLoading(false);
      setCurrentTrack(track);
      loadAndPlay(currentTrackRef.current, 'manual');

      // Keep stable DTOs for ordinary rows. Only repeated references need a
      // distinct occurrence for move, remove and undo in this new queue.
      const seen = new Set();
      const occurrences = trackList.map((item, index) => {
        if (index === startIndex) return currentTrackRef.current;
        if (item === track || seen.has(item)) return { ...item };
        seen.add(item);
        return item;
      });
      cycleTracksRef.current = occurrences;
      collectionTracksRef.current = occurrences;
      setHistory(occurrences.slice(Math.max(0, startIndex - MAX_HISTORY), startIndex));
      commitPreparedQueue(projectTrackRatings(occurrences.slice(startIndex + 1)));
    },
    [commitPreparedQueue, loadAndPlay, projectTrackRatings, setCurrentTrack, setHistory, setWaveMode],
  );

  const applyRatingProjection = useCallback(() => {
    const dislikes = overlayDislikeIds(
      serverDislikeIdsRef.current, ratingOverlayRef.current.values(),
    );
    dislikeIdsRef.current = dislikes;
    setDislikeIds(dislikes);
    setCurrentTrack((track) => track);
    setTracks(projectTrackRatings);
    setHistory((tracks) => tracks);
    setUpNextQueue((tracks) => {
      const candidates = tracks.filter((track) =>
        !recommendationsRef.current.has(queueKey(track)) ||
        !dislikes.has(String(getTrackId(track))),
      );
      return candidates.length === tracks.length ? tracks : candidates;
    });
  }, [projectTrackRatings, setTracks, setCurrentTrack, setHistory, setUpNextQueue]);

  const syncProjectionRef = useRef(null);
  syncProjectionRef.current = (event) => {
    const { type, session } = event;
    if (type === 'closed' || type === 'opened') {
      ratingOverlayRef.current.clear();
      favoriteIdsRef.current = null;
      serverDislikeIdsRef.current = new Set();
      ratingWritesRef.current.clear();
      setDislikePending(false);
      setDislikeIds(new Set());
      dislikeIdsRef.current = new Set();
      return;
    }
    if (!isOfflineSessionCurrent(session)) return;
    if (type === 'ratings-refreshed') {
      favoriteIdsRef.current = new Set(event.favoriteIds);
      serverDislikeIdsRef.current = new Set(event.dislikes.map(String));
      const incoming = new Map(event.overlay.map((entry) => [entry.trackId, entry]));
      // Keep commits observed after this refresh started its final SQLite read.
      for (const [id, entry] of ratingOverlayRef.current) {
        if (event.reconciled?.has(entry.operationId)) continue;
        if (entry.revision > (incoming.get(id)?.revision ?? 0)) incoming.set(id, entry);
      }
      ratingOverlayRef.current = incoming;
    } else if (type === 'rating' || type === 'rating-overlay') {
      if (event.snapshot && !favoriteIdsRef.current) {
        favoriteIdsRef.current = new Set(event.snapshot.favoriteIds);
        serverDislikeIdsRef.current = new Set(event.snapshot.dislikes.map(String));
      }
      for (const entry of event.overlay || [event.entry]) {
        const existing = ratingOverlayRef.current.get(entry.trackId);
        if (!existing || existing.revision <= entry.revision)
          ratingOverlayRef.current.set(entry.trackId, entry);
      }
    } else if (type === 'interactions-drained') {
      reconnectPendingRef.current = false;
      waveRetryAtRef.current = 0;
      refreshFutureWave();
      return;
    } else return;
    applyRatingProjection();
  };

  useEffect(() => {
    const unsubscribe = subscribeOfflineIndex((event) => syncProjectionRef.current(event));
    const stop = startOutboxSync();
    return () => {
      unsubscribe();
      stop();
    };
  }, []);

  const toggleRating = useCallback(async (track, target) => {
    const session = getOfflineSession();
    const id = getTrackId(track);
    if (!session || id === null || !mountedRef.current) return;
    const key = String(id);
    const writes = ratingWritesRef.current;
    if (writes.has(key)) return;
    const active = areTrackIdsEqual(currentTrackRef.current, id);
    const selection = currentRequestIdRef.current;
    writes.set(key, target);
    if (target === 'dislike') setDislikePending(true);
    if (active) {
      if (player?.setFavoritePending) player.setFavoritePending(selection || '', true);
      else player?.setFavoriteState?.(selection || '', !!currentTrackRef.current.is_liked, false);
    }
    try {
      const rating = (await getRatingOverlay(session, key)).find((entry) =>
        entry.trackId === key && ['pending', 'synced'].includes(entry.state),
      );
      if (!mountedRef.current || !isOfflineSessionCurrent(session)) return;
      const alreadyRated = rating ? rating.rating === target : target === 'like'
        ? !!projectRating(areTrackIdsEqual(currentTrackRef.current, id) ? currentTrackRef.current : track)?.is_liked
        : dislikeIdsRef.current.has(key);
      await saveRatingWithFeedback(session, track, alreadyRated ? 'neutral' : target);
      if (
        !alreadyRated && target === 'dislike' && isOfflineSessionCurrent(session) &&
        isWaveSessionRef.current && selection === currentRequestIdRef.current &&
        areTrackIdsEqual(currentTrackRef.current, id)
      ) {
        void fetchNextTrack().catch((error) => {
          if (isOfflineSessionCurrent(session))
            console.warn('[Outbox] Could not advance the wave:', error.message);
        });
      }
    } catch (error) {
      if (isOfflineSessionCurrent(session)) {
        console.warn('[Outbox] Could not save rating:', error.message);
        showRatingError();
      }
    } finally {
      if (mountedRef.current && isOfflineSessionCurrent(session)) {
        writes.delete(key);
        setDislikePending([...writes.values()].includes('dislike'));
        if (areTrackIdsEqual(currentTrackRef.current, id)) {
          const currentSelection = currentRequestIdRef.current || '';
          player?.setFavoritePending?.(currentSelection, false);
          player?.setFavoriteState?.(currentSelection, !!currentTrackRef.current.is_liked, true);
        }
      }
    }
  }, [player, projectRating, fetchNextTrack]);

  const handleToggleLike = useCallback((track) => toggleRating(track, 'like'), [toggleRating]);
  const handleToggleDislike = useCallback((track) => toggleRating(track, 'dislike'), [toggleRating]);

  // The selection token belongs to the track shown when the remote command fired.
  // Never apply a delayed command to a newer selection.
  const toggleLikeRef = useRef(handleToggleLike);
  toggleLikeRef.current = handleToggleLike;
  useEffect(() => {
    const subscription = player?.addListener?.('toggleFavorite', (event) => {
      if (
        !mountedRef.current ||
        !event?.favoriteSelectionId ||
        event.favoriteSelectionId !== currentRequestIdRef.current
      )
        return;
      toggleLikeRef.current(currentTrackRef.current);
    });
    return () => subscription?.remove?.();
  }, [player]);

  const favoriteSelectionId = currentRequestIdRef.current || '';
  useEffect(() => {
    player?.setFavoriteState?.(
      favoriteSelectionId,
      !!currentTrack?.is_liked,
      !!currentTrack && !!getOfflineSession() && (
        typeof player?.setFavoritePending === 'function' ||
        !ratingWritesRef.current.has(String(getTrackId(currentTrack)))
      ),
    );
    player?.setFavoritePending?.(
      favoriteSelectionId,
      ratingWritesRef.current.has(String(getTrackId(currentTrack))),
    );
  }, [player, currentTrack, favoriteSelectionId, dislikeIds]);

  const startWave = useCallback(async () => {
    if (!mountedRef.current) return;
    const epoch = ++queueEpochRef.current;
    queueRequestRef.current?.controller.abort();
    const transition = transitionEpochRef.current;
    const session = getOfflineSession();
    const previous = historyRef.current;
    const formerTrack = currentTrackRef.current;
    const valid = ({ allowIntentChange = false } = {}) => mountedRef.current &&
      epoch === queueEpochRef.current && (allowIntentChange || transition === transitionEpochRef.current) &&
      (!session || isOfflineSessionCurrent(session));
    isAdvancingRef.current = true;
    setIsLoading(true);
    try {
      const [snapshot, dislikes] = session
        ? await Promise.all([readWaveQueue(session), getLocalDislikeIds(session)])
        : [null, dislikeIdsRef.current];
      if (!valid()) return;

      const recent = new Map();
      for (const track of [...(snapshot?.history || []), snapshot?.current, ...previous, formerTrack]) {
        const trackId = getTrackId(track);
        if (trackId === null) continue;
        const key = String(trackId);
        recent.delete(key);
        recent.set(key, track);
      }
      const played = [...recent.values()].slice(-MAX_HISTORY);
      let failedTrack;
      if (canRequestWave({ ignoreBackoff: true })) {
        const controller = new AbortController();
        const lastPlayed = new Map(played.map((track, index) => [String(getTrackId(track)), index]));
        const response = requestWave(buildWaveQueueUrl(null, {
          limit: 8,
          excludeIds: [...dislikes, ...played.map(getTrackId)],
        }), controller.signal).then(data => {
          if (!Array.isArray(data)) return [];
          // The server can return recent tracks after exhausting other candidates.
          return data.filter(track => !dislikes.has(String(getTrackId(track)))).sort((a, b) =>
            (lastPlayed.get(String(getTrackId(a))) ?? -1) - (lastPlayed.get(String(getTrackId(b))) ?? -1));
        }).catch(() => null);
        const request = { epoch, controller, response };
        queueRequestRef.current = request;
        let data;
        try {
          const readyReserve = await readyReserveBeforeResponse(request, session, played);
          if (!valid()) return;
          if (readyReserve) {
            const started = await advanceLocalWave({
              session, valid, current: formerTrack, previous: played, restart: true, readyReserve, startingRequest: request,
            });
            if (started && valid({ allowIntentChange: true })) {
              waveRetryAtRef.current = 0;
              void fetchQueue(getTrackId(currentTrackRef.current), {}, { replaceRecommendations: true, startingRequest: request });
              return;
            }
            if (!valid()) return;
          }
          data = await response;
        } finally {
          if (queueRequestRef.current === request) {
            controller.abort();
            queueRequestRef.current = null;
          }
        }
        if (!valid()) return;
        if (Array.isArray(data) && canRequestWave({ ignoreBackoff: true })) {
          const candidates = mergeUniqueQueue([], data.map(normalizeTrackDto).filter(track =>
            track && !dislikeIdsRef.current.has(String(getTrackId(track)))));
          const [first, ...future] = candidates;
          if (first) {
            const result = await tryWaveTrack(first);
            if (!valid({ allowIntentChange: true }) || result?.superseded) return;
            if (!result?.error) {
              beginWaveSession(session);
              waveRetryAtRef.current = 0;
              awaitingRecommendationsRef.current = false;
              setWaveMode(canRequestWave() ? 'online' : 'reserve');
              setHistory(played);
              setUpNextQueue(future);
              recommendationsRef.current = new Set(queueRef.current.map(queueKey));
              cycleTracksRef.current = [first, ...future];
              saveCurrentWave();
              return;
            }
            if (!valid()) return;
            failedTrack = first;
          }
        }
        waveRetryAtRef.current = Date.now() + WAVE_RETRY_DELAY;
      }
      if (session) {
        const started = await advanceLocalWave({
          session, valid, current: formerTrack, previous: played, restart: true,
          exclude: failedTrack ? [failedTrack] : [],
        });
        if (started && canRequestWave()) refreshWaveAfterAdvanceRef.current = true;
      } else if (failedTrack) {
        setCurrentTrack(formerTrack);
      }
    } catch (error) {
      if (valid()) console.warn('Failed to start wave:', error.message);
    } finally {
      if (epoch === queueEpochRef.current) {
        isAdvancingRef.current = false;
        setIsLoading(false);
        if (refreshWaveAfterAdvanceRef.current) refreshFutureWave();
      }
    }
  }, [advanceLocalWave, beginWaveSession, canRequestWave, fetchQueue, tryWaveTrack, refreshFutureWave, saveCurrentWave, setCurrentTrack, setHistory, setUpNextQueue, setWaveMode]);

  const dismissPlayer = useCallback(async () => {
    completePlayback(playbackEpisodeRef.current, 'skip');
    playbackEpisodeRef.current = null;
    currentRequestIdRef.current = null;
    intentRef.current = 'pause';
    playbackRequestRef.current += 1;
    retryPreloadRef.current = null;
    setLoadedPlayback(null);
    defaultPlaybackCoordinator.cancelCurrent('dismiss', player);
    try {
      if (typeof player.setActiveForLockScreen === 'function') {
        player.setActiveForLockScreen(false);
      }
    } catch (e) {
      console.warn('[usePlayerController] Could not clear lock screen');
    }
    try {
      applyTrackNormalization(player, null, false);
    } catch (e) {}
    durableWaveRef.current = false;
    setWaveMode('idle');
    isWaveSessionRef.current = false;
    autoplayAfterQueueRef.current = false;
    collectionTracksRef.current = [];
    cycleTracksRef.current = [];
    removedQueueIdsRef.current.clear();
    unshuffledRef.current = null;
    setShuffleEnabled(false);
    repeatModeRef.current = 'off';
    setRepeatMode('off');
    setAutoplayEnabled(false);
    undoRef.current = null;
    setQueueUndo(null);
    queueEpochRef.current += 1;
    isAdvancingRef.current = false;
    setIsLoading(false);
    currentTrackRef.current = null;
    setCurrentTrack(null);
    setUpNextQueue([]);
    setIsPlayerVisible(false);
    defaultPlaybackCoordinator.updateQueue(null, []);
    try {
      await clearSavedLastTrack();
    } catch (e) {
      console.warn(
        '[usePlayerController] dismissPlayer clear storage error:',
        e,
      );
    }
  }, [player, setWaveMode]);

  const queueControls = useMemo(() => ({
    repeatMode,
    shuffleEnabled,
    autoplayEnabled,
    undoMessage: queueUndo?.message,
    remove: removeQueueTrack,
    move: moveQueueTrack,
    clear: clearQueue,
    undo: undoQueueEdit,
    enqueue: enqueueTrack,
    toggleShuffle,
    cycleRepeatMode,
    toggleAutoplay,
  }), [repeatMode, shuffleEnabled, autoplayEnabled, queueUndo?.message,
    removeQueueTrack, moveQueueTrack, clearQueue, undoQueueEdit, enqueueTrack,
    toggleShuffle, cycleRepeatMode, toggleAutoplay]);

  return {
    player,
    status,
    playbackRate,
    changePlaybackRate,
    currentTrack,
    setCurrentTrack,
    isPlaying,
    currentTime,
    duration,
    isLoading,
    // Legacy binaries cannot confirm coordinator startup through source-tagged events.
    // Once this selection is installed, use Expo's loaded status for presentation.
    isStartingPlayback:
      networkUX.current?.status === 'starting' &&
      (networkUX.identityAvailable === true ||
        !(
          loadedPlayback?.request === playbackRequestRef.current &&
          loadedPlayback?.authEpoch === authEpochRef.current &&
          status.isLoaded === true
        )),
    isPlayerVisible,
    setIsPlayerVisible,
    playerExpandToken,
    requestExpandPlayer,
    upNextQueue,
    queueControls,
    history,
    previousTrack: history.length > 0 ? history[history.length - 1] : null,
    nextTrack: upNextQueue.length > 0 ? upNextQueue[0] : null,
    playPreviousTrack,
    fetchNextTrack,
    togglePlayPause,
    playTrack,
    playTrackList,
    handleToggleLike,
    handleToggleDislike,
    dislikeIds,
    dislikePending,
    startWave,
    restoreSavedWave,
    dismissPlayer,
    soundCheck,
    isSoundCheckEnabled: soundCheck,
    // Network UX & Cache state (Agent 5 & 6)
    networkStatus: networkUX.networkStatus,
    nextTrackStatus: networkUX.nextTrackStatus,
    networkError: networkUX.networkError,
    isBufferingSlow: networkUX.isBufferingSlow,
    currentPlayback: networkUX.current,
    nextPlayback: networkUX.next,
    identityAvailable: networkUX.identityAvailable,
    seekTo,
    retryCurrent,
    retryPreload,
    skipToNext: fetchNextTrack,
  };
}
