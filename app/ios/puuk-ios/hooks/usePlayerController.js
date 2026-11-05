import { useState, useCallback, useRef, useEffect } from 'react';
import {
  useAudioPlayer,
  useAudioPlayerStatus,
  setAudioModeAsync,
} from 'expo-audio';
import {
  authFetch,
  SERVER_URL,
  getAuthHeaders,
  getCachedAuthHeaders,
  getCachedUser,
  addAuthListener,
  getSavedUser,
  isRetryableStatus,
  isNetworkError,
  ApiError,
} from '../shared/api/api';
import { recordPlayStart } from '../shared/api/artists';
import { subscribeArtistCreditsUpdated } from '../shared/domain/artistCreditEvents';
import defaultPlaybackCoordinator from '../utils/playbackCoordinator';
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
    artist: source?.artist || 'My Wave',
    is_liked: !!source?.is_liked,
  };
}

// Паритет с backend MAX_EXCLUDE_IDS: длиннее список клиент не передает.
const MAX_EXCLUDE_IDS = 100;
// Ограничение будущего буфера волны и истории сессии.
const MAX_QUEUE_BUFFER = 20;
const MAX_HISTORY = 50;
const HISTORY_COOLDOWN_MS = 30000;
let selectionSequence = 0;

function capIds(ids, limit = MAX_EXCLUDE_IDS) {
  const valid = (ids || []).map(getTrackId).filter((id) => id !== null);
  const unique = [...new Set(valid.map((id) => String(id).trim()))];
  return unique.length > limit ? unique.slice(unique.length - limit) : unique;
}

/** URL /api/wave/queue с повторяющимися query-параметрами исключений. */
function buildWaveQueueUrl(trackId, { excludeIds = [], queuedIds = [] } = {}) {
  const params = new URLSearchParams();
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
  return merged.length > maxBuffer ? merged.slice(0, maxBuffer) : merged;
}

export default function usePlayerController({ setTracks }) {
  const [currentTrack, commitCurrentTrack] = useState(null);
  const currentTrackRef = useRef(null);
  const setCurrentTrack = useCallback((update) => {
    const next =
      typeof update === 'function' ? update(currentTrackRef.current) : update;
    currentTrackRef.current = next;
    commitCurrentTrack(next);
  }, []);
  const [isLoading, setIsLoading] = useState(false);
  const [isPlayerVisible, setIsPlayerVisible] = useState(false);
  const [playerExpandToken, setPlayerExpandToken] = useState(0);
  const [upNextQueue, commitQueue] = useState([]);
  const queueRef = useRef([]);
  const setUpNextQueue = useCallback((update) => {
    const next =
      typeof update === 'function' ? update(queueRef.current) : update;
    queueRef.current = next;
    commitQueue(next);
  }, []);
  const [history, commitHistory] = useState([]);
  const historyRef = useRef([]);
  const setHistory = useCallback((update) => {
    const next =
      typeof update === 'function' ? update(historyRef.current) : update;
    historyRef.current = next;
    commitHistory(next);
  }, []);

  // Состояние сети и предзагрузки для Network UX
  const [networkUX, setNetworkUX] = useState(
    defaultPlaybackCoordinator.getState(),
  );

  // Сессия волны: prefetch рекомендаций подмешивает в буфер только в wave-сессии
  const isWaveSessionRef = useRef(false);
  const autoplayAfterQueueRef = useRef(false);
  const collectionTrackIdsRef = useRef([]);
  const queueRequestRef = useRef(null);
  // Эпоха очереди: инвалидирует in-flight ответы fetchQueue
  const queueEpochRef = useRef(0);
  // Защита от двойного перехода
  const isAdvancingRef = useRef(false);

  // Дедупликация истории (30с кулдаун) и буфер повторов фоновых событий
  // Дедупликация истории (user_id + session + track_id + event) и буфер повторов фоновых событий
  const recentHistoryRef = useRef(new Map());
  const pendingBackgroundEventsRef = useRef([]);
  const isFlushingBackgroundEventsRef = useRef(false);
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
  const retryTimerRef = useRef(null);
  const flushPendingBackgroundEventsRef = useRef(null);
  const authEpochRef = useRef(0);
  const authAbortControllerRef = useRef(null);
  const authReadyRef = useRef(Boolean(initialUser));
  const pendingHistoryRef = useRef([]);
  const recordTrackHistoryRef = useRef(null);

  const player = useAudioPlayer(null, {
    keepAudioSessionActive: true,
  });
  const status = useAudioPlayerStatus(player);

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
  const currentTime = status.currentTime || 0;
  const duration = status.duration || 0;

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
  const durationRef = useRef(duration);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  // Отслеживание смены пользователя: сброс дедупликации и таймеров повтора
  useEffect(() => {
    let isMounted = true;
    const resetAuthScopedState = (
      user,
      { preservePendingHistory = false } = {},
    ) => {
      const newUserId = user
        ? String(user.id || user.user_id || user.username || 'user')
        : 'anonymous';
      if (currentUserIdRef.current === newUserId && authReadyRef.current)
        return;

      const hadOwner = authReadyRef.current;
      if (hadOwner) {
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
        collectionTrackIdsRef.current = [];
      }
      currentUserIdRef.current = newUserId;
      authReadyRef.current = true;
      authEpochRef.current += 1;
      recentHistoryRef.current.clear();
      confirmedStartRef.current.clear();
      pendingBackgroundEventsRef.current = [];
      if (!preservePendingHistory) {
        pendingHistoryRef.current = [];
      }
      authAbortControllerRef.current?.abort();
      authAbortControllerRef.current = null;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    const savedUserEpoch = authEpochRef.current;
    if (typeof getSavedUser === 'function') {
      try {
        const res = getSavedUser();
        if (res && typeof res.then === 'function') {
          res
            .then((user) => {
              if (isMounted && savedUserEpoch === authEpochRef.current) {
                resetAuthScopedState(user, {
                  preservePendingHistory: !authReadyRef.current,
                });
                const pending = pendingHistoryRef.current;
                pendingHistoryRef.current = [];
                for (const item of pending) {
                  recordTrackHistoryRef.current?.(item.trackId, item.event);
                }
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
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      authAbortControllerRef.current?.abort();
    };
  }, [player, setCurrentTrack, setUpNextQueue, setHistory]);

  const isRetryableError = (err, status = null) => {
    if (status !== null && status !== undefined) {
      return isRetryableStatus(status);
    }
    if (!err) return false;
    if (err.name === 'AbortError') return false;
    if (err.status && !isRetryableStatus(err.status)) return false;
    if (err.isTimeout || err.name === 'TimeoutError' || err.type === 'timeout')
      return true;
    if (err.isNetwork || isNetworkError(err)) return true;
    if (err.status && isRetryableStatus(err.status)) return true;
    const msg = (err.message || '').toLowerCase();
    if (
      msg.includes('network') ||
      msg.includes('timeout') ||
      msg.includes('fetch failed')
    ) {
      return true;
    }
    return false;
  };

  const scheduleFlush = useCallback((delayMs = 5000) => {
    if (retryTimerRef.current) return;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      flushPendingBackgroundEventsRef.current?.();
    }, delayMs);
  }, []);

  // Очистка и повтор фоновых событий при восстановлении сети или по таймеру
  const flushPendingBackgroundEvents = useCallback(async () => {
    if (isFlushingBackgroundEventsRef.current) return;
    if (pendingBackgroundEventsRef.current.length === 0) return;

    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    isFlushingBackgroundEventsRef.current = true;
    let hasFailedEvents = false;
    const flushEpoch = authEpochRef.current;
    const flushController = new AbortController();
    authAbortControllerRef.current = flushController;

    try {
      const events = [...pendingBackgroundEventsRef.current];
      pendingBackgroundEventsRef.current = [];

      const now = Date.now();
      for (const event of events) {
        if (
          flushEpoch !== authEpochRef.current ||
          event.authEpoch !== flushEpoch
        ) {
          continue;
        }
        if (now - event.timestamp > 10 * 60 * 1000 || event.attempts >= 3) {
          continue;
        }
        try {
          const options = {
            method: 'POST',
            retry: 0,
            background: true,
            signal: flushController.signal,
          };
          if (event.body) {
            options.body = event.body;
          }
          const res = await authFetch(event.url, options);
          if (flushEpoch !== authEpochRef.current) continue;
          if (!res.ok) {
            if (isRetryableStatus(res.status)) {
              throw new ApiError(`HTTP ${res.status}`, { status: res.status });
            } else {
              console.warn(
                `[usePlayerController] Background event permanent HTTP ${res.status} on retry (${event.url})`,
              );
              continue;
            }
          }
        } catch (retryErr) {
          if (
            flushEpoch !== authEpochRef.current ||
            retryErr?.name === 'AbortError'
          ) {
            continue;
          }
          if (isRetryableError(retryErr, retryErr?.status)) {
            event.attempts += 1;
            if (
              event.attempts < 3 &&
              event.authEpoch === authEpochRef.current
            ) {
              pendingBackgroundEventsRef.current.push(event);
              hasFailedEvents = true;
            }
          }
        }
      }
    } finally {
      isFlushingBackgroundEventsRef.current = false;
      if (authAbortControllerRef.current === flushController) {
        authAbortControllerRef.current = null;
      }
      if (hasFailedEvents && pendingBackgroundEventsRef.current.length > 0) {
        scheduleFlush(10000);
      }
    }
  }, [scheduleFlush]);

  useEffect(() => {
    flushPendingBackgroundEventsRef.current = flushPendingBackgroundEvents;
  }, [flushPendingBackgroundEvents]);

  const sendBackgroundEvent = useCallback(
    async (url, body = null) => {
      const options = {
        method: 'POST',
        retry: 1,
        background: true,
      };
      if (body) {
        options.body = body;
      }

      try {
        const response = await authFetch(url, options);
        if (!response.ok) {
          if (isRetryableStatus(response.status)) {
            throw new ApiError(`HTTP ${response.status}`, {
              status: response.status,
              type: response.status >= 500 ? 'server' : 'transient_http',
            });
          } else {
            console.warn(
              `[usePlayerController] Background event permanent HTTP ${response.status} (${url})`,
            );
            return;
          }
        }
      } catch (err) {
        console.warn(
          `[usePlayerController] Background event failed (${url}):`,
          err?.message || err,
        );
        if (isRetryableError(err, err?.status)) {
          const authEpoch = authEpochRef.current;
          if (pendingBackgroundEventsRef.current.length < 50) {
            pendingBackgroundEventsRef.current.push({
              url,
              body,
              timestamp: Date.now(),
              attempts: 1,
              authEpoch,
            });
          }
          scheduleFlush(5000);
        }
      }
    },
    [scheduleFlush],
  );

  const recordTrackHistory = useCallback(
    (trackId, event = 'listen') => {
      if (
        trackId === undefined ||
        trackId === null ||
        (trackId === '' && trackId !== 0)
      )
        return;
      if (!authReadyRef.current) {
        pendingHistoryRef.current.push({ trackId, event });
        return;
      }
      const idStr = String(trackId);
      const userId = currentUserIdRef.current || 'anonymous';
      const sessionId = sessionIdRef.current || 'default';
      const dedupKey = `${userId}:${sessionId}:${idStr}:${event}`;

      const now = Date.now();
      const lastRecorded = recentHistoryRef.current.get(dedupKey);
      if (lastRecorded && now - lastRecorded < HISTORY_COOLDOWN_MS) {
        return;
      }
      recentHistoryRef.current.set(dedupKey, now);

      if (recentHistoryRef.current.size > 200) {
        for (const [k, timestamp] of recentHistoryRef.current.entries()) {
          if (now - timestamp > HISTORY_COOLDOWN_MS) {
            recentHistoryRef.current.delete(k);
          }
        }
      }

      sendBackgroundEvent(
        `/api/tracks/${encodeURIComponent(idStr)}/history`,
        null,
      );
    },
    [sendBackgroundEvent],
  );

  useEffect(() => {
    recordTrackHistoryRef.current = recordTrackHistory;
  }, [recordTrackHistory]);

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
      if (
        state?.networkStatus === 'good' &&
        pendingBackgroundEventsRef.current.length > 0
      ) {
        flushPendingBackgroundEvents();
      }
    });
    return unsubscribe;
  }, [flushPendingBackgroundEvents]);

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
  const creditContextKey = JSON.stringify([getTrackId(currentTrack), upNextQueue.map(getTrackId), history.map(getTrackId)]);
  const creditContextEpoch = (creditContextRef.current?.epoch || 0) + (creditContextRef.current?.key === creditContextKey ? 0 : 1);
  creditContextRef.current = { key: creditContextKey, epoch: creditContextEpoch, currentTrack, upNextQueue, history };

  // Credit edits patch metadata only; playback and position remain owned by the audio engine.
  useEffect(() => {
    let active = true;
    const versions = new Map();
    const pending = new Map();
    let running = 0;
    const patchTracks = (updates) => {
      if (!active || !updates.length) return;
      const byId = new Map(updates.filter((track) => getTrackId(track) !== null).map((track) => [String(getTrackId(track)), track]));
      const merge = (track) => {
        const incoming = track && byId.get(String(getTrackId(track)));
        if (!incoming) return track;
        const patch = {};
        for (const key of ['artist', 'artist_id', 'artists', 'artists_revision', 'album_artist', 'album_artists', 'album_artists_revision']) {
          if (Object.prototype.hasOwnProperty.call(incoming, key)) patch[key] = incoming[key];
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
        if (versions.get(id) !== task.version || authEpochRef.current !== task.authEpoch || SERVER_URL !== task.server || creditContextRef.current.epoch !== task.context) continue;
        running += 1;
        (async () => {
          try {
            const response = await authFetch(`/api/tracks/${encodeURIComponent(id)}?credits_only=true`);
            const track = response.ok ? await response.json() : null;
            if (active && versions.get(id) === task.version && authEpochRef.current === task.authEpoch &&
                SERVER_URL === task.server && creditContextRef.current.epoch === task.context &&
                track && String(getTrackId(track)) === id) patchTracks([track]);
          } catch { /* Preserve existing metadata for a later refresh. */ }
        })().finally(() => { running -= 1; pump(); });
      }
    };
    const unsubscribe = subscribeArtistCreditsUpdated((event) => {
      const updates = event.scope === 'track' ? [event.track] : event.scope === 'album' ? (event.tracks || []) : [];
      const ids = event.scope === 'bulk' ? (event.affected?.track_ids || []) : updates.map(getTrackId);
      const uniqueIds = [...new Set(ids.map(getTrackId).filter((id) => id !== null).map(String))];
      for (const id of uniqueIds) {
        versions.set(id, (versions.get(id) || 0) + 1);
        pending.delete(id);
      }
      if (event.scope !== 'bulk') { patchTracks(updates); return; }
      const context = creditContextRef.current;
      const relevant = new Set([context.currentTrack, ...context.upNextQueue, ...context.history].map(getTrackId).filter((id) => id !== null).map(String));
      for (const id of uniqueIds) {
        if (relevant.has(id)) pending.set(id, { version: versions.get(id), authEpoch: authEpochRef.current, server: SERVER_URL, context: context.epoch });
      }
      pump();
    });
    return () => { active = false; pending.clear(); unsubscribe(); };
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

  /** Делегируем воспроизведение координатору */
  const loadAndPlay = useCallback(
    (track) => {
      if (!mountedRef.current) return Promise.resolve({ superseded: true });
      const request = ++playbackRequestRef.current;
      const requestId = `selection_${++selectionSequence}`;
      const authEpoch = authEpochRef.current;
      currentRequestIdRef.current = null;
      defaultPlaybackCoordinator.cancelCurrent('superseded', player);
      currentRequestIdRef.current = requestId;
      currentTimeRef.current = 0;
      durationRef.current = track?.duration || 0;
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
        });
      } catch (e) {
        reportPlaybackError(e);
        return Promise.resolve({ isLocal: false, uri: null, error: e });
      }

      if (track && track.loudness_status !== 'analyzed') {
        const trackId = getTrackId(track);
        if (trackId !== null) {
          refreshTrackLoudness(trackId);
        }
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
    [player, refreshTrackLoudness],
  );

  const fetchQueue = useCallback((trackId, signal, exclusions = {}) => {
    const epoch = queueEpochRef.current;
    if (queueRequestRef.current?.epoch === epoch) {
      return queueRequestRef.current.promise;
    }
    const excludeIds = [
      ...(exclusions.excludeIds || []),
      ...collectionTrackIdsRef.current,
    ];
    const excluded = new Set(
      [trackId, ...excludeIds, ...(exclusions.queuedIds || [])]
        .filter((id) => id !== null && id !== undefined)
        .map(String),
    );
    const promise = (async () => {
      try {
        const response = await authFetch(
          buildWaveQueueUrl(trackId, { ...exclusions, excludeIds }),
          { signal },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (epoch !== queueEpochRef.current) return [];
        const normalizedQueue = mergeUniqueQueue(
          [],
          (Array.isArray(data) ? data : [])
            .map(normalizeTrackDto)
            .filter(
              (track) => track && !excluded.has(String(getTrackId(track))),
            ),
        );
        setUpNextQueue((prev) => mergeUniqueQueue(prev, normalizedQueue));
        return normalizedQueue;
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.warn('Failed to load queue:', error.message);
        }
        return [];
      } finally {
        if (queueRequestRef.current?.epoch === epoch)
          queueRequestRef.current = null;
      }
    })();
    queueRequestRef.current = { epoch, promise };
    return promise;
  }, []);

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
    (options = {}) => {
      if (!mountedRef.current || !currentRequestIdRef.current) return;
      const currentTrack = currentTrackRef.current;
      const history = historyRef.current;
      const upNextQueue = queueRef.current;
      const force = typeof options === 'boolean' ? options : !!options?.force;
      if (!force && (currentTimeRef.current || 0) > 3) {
        seekTo(0);
        return;
      }

      if (history.length > 0) {
        const newHistory = [...history];
        const prevTrack = newHistory.pop();

        if (currentTrack) {
          setUpNextQueue([currentTrack, ...upNextQueue]);
        }

        currentTrackRef.current = prevTrack;
        setHistory(newHistory);
        setCurrentTrack(prevTrack);
        loadAndPlay(prevTrack);
        const prevTrackId = getTrackId(prevTrack);
        if (prevTrackId !== null) {
          recordTrackHistory(prevTrackId);
        }
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
      recordTrackHistory,
      seekTo,
    ],
  );

  const fetchNextTrack = useCallback(async () => {
    const currentTrack = currentTrackRef.current;
    const upNextQueue = queueRef.current;
    const history = historyRef.current;
    if (!mountedRef.current || !currentTrack || !currentRequestIdRef.current)
      return;
    if (isAdvancingRef.current) return;
    isAdvancingRef.current = true;
    const epoch = queueEpochRef.current;
    const transition = transitionEpochRef.current;
    const currentDur = durationRef.current || currentTrack.duration || 0;
    const currentPos = currentTimeRef.current || 0;

    try {
      setIsLoading(true);
      let nextTrack;
      let newQueue = [...upNextQueue];

      // A collection remains ordered until its final track has finished.
      if (newQueue.length === 0 && autoplayAfterQueueRef.current) {
        newQueue = await fetchQueue(getTrackId(currentTrack), undefined, {
          excludeIds: history.map(getTrackId).filter((id) => id !== null),
          queuedIds: [],
        });
        if (
          epoch !== queueEpochRef.current ||
          transition !== transitionEpochRef.current
        )
          return;
        isWaveSessionRef.current = true;
      }

      if (newQueue.length > 0) {
        nextTrack = newQueue.shift();
        setUpNextQueue(newQueue);
      }

      if (nextTrack) {
        setHistory((prev) => [...prev, currentTrack].slice(-MAX_HISTORY));
        const nextTrackId = getTrackId(nextTrack);
        const currentTrackId = getTrackId(currentTrack);

        currentTrackRef.current = nextTrack;
        setCurrentTrack(nextTrack);
        const playPromise = loadAndPlay(nextTrack);

        if (isWaveSessionRef.current && newQueue.length < 3) {
          fetchQueue(nextTrackId, undefined, {
            excludeIds: [
              ...history.map(getTrackId).filter((id) => id !== null),
              currentTrackId,
            ],
            queuedIds: newQueue.map(getTrackId).filter((id) => id !== null),
          });
        }

        // Телеметрия волны: finish при дослушивании, иначе skip
        const trackMs = Math.round(
          (currentTrack.duration || currentDur || 0) * 1000,
        );
        const listenedMs = Math.round((currentPos || 0) * 1000);
        const eventType =
          currentDur > 0 && currentPos >= currentDur * 0.9 ? 'finish' : 'skip';
        if (currentTrackId !== null) {
          sendBackgroundEvent('/api/wave/feedback', {
            track_id: currentTrackId,
            event_type: eventType,
            listen_duration_ms: listenedMs,
            track_duration_ms: trackMs,
          });
        }

        // Записываем прослушивание в историю
        if (nextTrackId !== null) {
          recordTrackHistory(nextTrackId);
        }

        await playPromise;
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
      }
    }
  }, [
    currentTrack,
    upNextQueue,
    player,
    loadAndPlay,
    fetchQueue,
    history,
    sendBackgroundEvent,
    recordTrackHistory,
  ]);

  const fetchNextTrackRef = useRef(fetchNextTrack);
  const playPreviousTrackRef = useRef(playPreviousTrack);

  useEffect(() => {
    fetchNextTrackRef.current = fetchNextTrack;
  }, [fetchNextTrack]);

  useEffect(() => {
    playPreviousTrackRef.current = playPreviousTrack;
  }, [playPreviousTrack]);

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
      if (Number.isFinite(event.duration)) durationRef.current = event.duration;
      if (result.didStart && !confirmedStartRef.current.has(requestId)) {
        confirmedStartRef.current.add(requestId);
        const trackId = getTrackId(currentTrackRef.current);
        if (trackId !== null)
          recordPlayStart(trackId, { retry: 1 }).catch(() => {});
      }
      if (result.didFinish) fetchNextTrackRef.current?.();
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
      currentRequestIdRef.current = null;
      playbackRequestRef.current += 1;
      queueEpochRef.current += 1;
      intentRef.current = 'pause';
      statusSub?.remove?.();
      nextSub?.remove?.();
      prevSub?.remove?.();
      defaultPlaybackCoordinator.cancelCurrent('unmount', player);
    };
  }, [player]);

  // Old binaries retain completion presentation, without v1 recovery attribution.
  useEffect(() => {
    if (
      !defaultPlaybackCoordinator.getState().identityAvailable &&
      status?.didJustFinish &&
      currentRequestIdRef.current
    ) {
      fetchNextTrackRef.current?.();
    }
  }, [player, status?.didJustFinish]);

  const togglePlayPause = useCallback(() => {
    if (!mountedRef.current || !currentRequestIdRef.current) return;
    const current = defaultPlaybackCoordinator.getState().current;
    const type =
      (current?.intent || intentRef.current) === 'play' ? 'pause' : 'play';
    transitionEpochRef.current += 1;
    intentRef.current = type;
    return defaultPlaybackCoordinator.setIntent(player, {
      type,
      requestId: currentRequestIdRef.current,
    });
  }, [player]);

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
      const activeTrack = currentTrackRef.current || currentTrack;
      const currentId = getTrackId(activeTrack);

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
        isWaveSessionRef.current = source === 'search';
        autoplayAfterQueueRef.current = source === 'search';
        collectionTrackIdsRef.current = [];
      }
      setCurrentTrack(track);
      loadAndPlay(track);
      // Инвалидируем ответы старой очереди до запуска нового запроса.
      // Иначе fetchQueue захватит уже устаревшую эпоху и сможет примешать
      // старый ответ к новой сессии воспроизведения.
      queueEpochRef.current += 1;
      isAdvancingRef.current = false;
      setIsLoading(false);
      setUpNextQueue(
        source === 'queue' ? upNextQueue.slice(queueIndex + 1) : [],
      );
      if (source === 'search')
        fetchQueue(trackId, undefined, {
          excludeIds: [
            ...history.map(getTrackId).filter((id) => id !== null),
            currentId,
          ],
          queuedIds: [],
        });
      recordTrackHistory(trackId);
    },
    [
      currentTrack,
      history,
      upNextQueue,
      fetchQueue,
      loadAndPlay,
      recordTrackHistory,
    ],
  );

  const playTrackList = useCallback(
    (trackList, startIndex = 0) => {
      if (!mountedRef.current || !trackList || trackList.length === 0) return;
      const track = trackList[startIndex];
      const trackId = getTrackId(track);
      if (trackId === null) return;
      const queue = trackList.slice(startIndex + 1);

      setHistory(trackList.slice(0, startIndex).slice(-MAX_HISTORY));
      const newSession =
        'list_' +
        Date.now().toString(36) +
        '_' +
        Math.random().toString(36).slice(2, 6);
      sessionIdRef.current = newSession;
      setPlaybackSessionId(newSession);
      currentTrackRef.current = track;
      isWaveSessionRef.current = false;
      autoplayAfterQueueRef.current = true;
      collectionTrackIdsRef.current = trackList
        .map(getTrackId)
        .filter((id) => id !== null);
      setCurrentTrack(track);
      loadAndPlay(track);
      // Ручной плейлист также инвалидирует in-flight wave queue response.
      queueEpochRef.current += 1;
      isAdvancingRef.current = false;
      setIsLoading(false);
      setUpNextQueue(queue);
      recordTrackHistory(trackId);
    },
    [loadAndPlay, recordTrackHistory],
  );

  const handleToggleLike = useCallback(
    async (track) => {
      if (!track) return;
      const trackId = getTrackId(track);
      if (trackId === null) return;
      const currentLiked = !!track.is_liked;
      const newLiked = !currentLiked;

      setCurrentTrack((prev) => {
        return prev && areTrackIdsEqual(prev, trackId)
          ? { ...prev, is_liked: newLiked }
          : prev;
      });
      setTracks((prev) =>
        prev.map((t) => {
          return areTrackIdsEqual(t, trackId)
            ? { ...t, is_liked: newLiked }
            : t;
        }),
      );

      try {
        const response = await authFetch(
          `/api/tracks/${encodeURIComponent(String(trackId))}/like`,
          {
            method: newLiked ? 'POST' : 'DELETE',
          },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (err) {
        console.warn('Failed to toggle like:', err);
        setCurrentTrack((prev) => {
          return prev && areTrackIdsEqual(prev, trackId)
            ? { ...prev, is_liked: currentLiked }
            : prev;
        });
        setTracks((prev) =>
          prev.map((t) => {
            return areTrackIdsEqual(t, trackId)
              ? { ...t, is_liked: currentLiked }
              : t;
          }),
        );
      }
    },
    [setTracks],
  );

  const startWave = useCallback(async () => {
    if (!mountedRef.current) return;
    const epoch = ++queueEpochRef.current;
    isAdvancingRef.current = false;
    setIsLoading(false);
    try {
      const response = await authFetch(
        '/api/wave/next?current_track_id=random',
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (epoch !== queueEpochRef.current) return;
      const waveTrack = normalizeTrackDto(data);
      if (!waveTrack) throw new Error('Wave track missing valid identifier');
      const waveTrackId = getTrackId(waveTrack);
      const currentTrackId = getTrackId(currentTrack);

      if (currentTrack && !areTrackIdsEqual(currentTrack, waveTrackId)) {
        setHistory((prev) => [...prev, currentTrack].slice(-MAX_HISTORY));
      }
      const newSession =
        'wave_' +
        Date.now().toString(36) +
        '_' +
        Math.random().toString(36).slice(2, 6);
      sessionIdRef.current = newSession;
      setPlaybackSessionId(newSession);
      currentTrackRef.current = waveTrack;
      isWaveSessionRef.current = true;
      autoplayAfterQueueRef.current = true;
      collectionTrackIdsRef.current = [];
      setCurrentTrack(waveTrack);
      loadAndPlay(waveTrack);
      queueEpochRef.current += 1;
      isAdvancingRef.current = false;
      setIsLoading(false);
      setUpNextQueue([]);
      fetchQueue(waveTrackId, undefined, {
        excludeIds: [
          ...history.map(getTrackId).filter((id) => id !== null),
          currentTrackId,
        ],
        queuedIds: [],
      });
      recordTrackHistory(waveTrackId);
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.warn('Failed to start wave:', error.message);
      }
    }
  }, [history, currentTrack, fetchQueue, loadAndPlay, recordTrackHistory]);

  const dismissPlayer = useCallback(async () => {
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
    isWaveSessionRef.current = false;
    autoplayAfterQueueRef.current = false;
    collectionTrackIdsRef.current = [];
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
  }, [player]);

  return {
    player,
    status,
    currentTrack,
    setCurrentTrack,
    isPlaying,
    currentTime,
    duration,
    isLoading,
    isPlayerVisible,
    setIsPlayerVisible,
    playerExpandToken,
    requestExpandPlayer,
    upNextQueue,
    history,
    previousTrack: history.length > 0 ? history[history.length - 1] : null,
    nextTrack: upNextQueue.length > 0 ? upNextQueue[0] : null,
    playPreviousTrack,
    fetchNextTrack,
    togglePlayPause,
    playTrack,
    playTrackList,
    handleToggleLike,
    startWave,
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
