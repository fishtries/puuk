import type { Track } from '../types/track.ts';

/** Сколько рекомендаций запрашивать у бэкенда за раз. */
export const WAVE_BATCH_SIZE = 8;

/** Когда в буфере остаётся столько треков — пора подгружать следующую пачку. */
export const WAVE_PREFETCH_THRESHOLD = 2;

/** Сколько будущих треков разрешено держать в очереди Волны. */
export const WAVE_MAX_BUFFER_SIZE = 15;

/** Сколько ID проигранных треков помнить в рамках одной сессии Волны. */
export const WAVE_MAX_SESSION_HISTORY = 100;

/** Максимум ID, передаваемых бэкенду в exclude_track_ids. */
export const WAVE_MAX_EXCLUDE_IDS = 100;

/**
 * Убирает дубликаты по id и запрещённые треки, сохраняя порядок рекомендаций.
 * Применяется и к свежей пачке с бэкенда, и при слиянии с текущей очередью.
 */
export function mergeWaveTracks(existing: Track[], incoming: Track[], excludedIds: Set<string>): Track[] {
  const seen = new Set<string>(excludedIds);
  const merged: Track[] = [];

  for (const track of [...existing, ...incoming]) {
    if (!track?.id || seen.has(track.id)) continue;
    seen.add(track.id);
    merged.push(track);
  }

  return merged;
}

/**
 * Будущие треки очереди Волны: всё после текущей позиции, что ещё не проиграно.
 * Используется, чтобы понять, нужна ли предзагрузка.
 */
export function upcomingWaveTracks(queue: Track[], currentTrackIndex: number, playedIds: string[]): Track[] {
  if (currentTrackIndex < 0) return [];
  const played = new Set(playedIds);
  return queue.slice(currentTrackIndex + 1).filter((track) => track?.id && !played.has(track.id));
}

/**
 * Очередь Волны перед добавлением новой пачки: удаляет уже проигранные треки
 * до текущей позиции, чтобы очередь и `currentTrackIndex` не росли бесконечно.
 * Текущий трек и будущий буфер при этом сохраняются, порядок не меняется.
 *
 * Возвращает новую очередь, начинающуюся с текущего трека (индекс 0).
 */
export function compactWaveQueue(
  queue: Track[],
  currentTrackIndex: number,
  playedIds: string[],
  maxBufferSize: number = WAVE_MAX_BUFFER_SIZE
): Track[] {
  if (currentTrackIndex < 0 || currentTrackIndex >= queue.length) return queue;

  const played = new Set(playedIds);
  const current = queue[currentTrackIndex];
  const tail = queue.slice(currentTrackIndex + 1).filter((track) => track?.id);

  const uniqueTail: Track[] = [];
  const seen = new Set<string>([current.id]);
  for (const track of tail) {
    if (seen.has(track.id) || played.has(track.id)) continue;
    seen.add(track.id);
    uniqueTail.push(track);
  }

  return [current, ...uniqueTail.slice(0, maxBufferSize)];
}

/** Ограничивает список проигранных ID последними записями (самые свежие — в конце). */
export function trimPlayedIds(playedIds: string[], limit: number = WAVE_MAX_SESSION_HISTORY): string[] {
  return playedIds.length > limit ? playedIds.slice(playedIds.length - limit) : playedIds;
}

export interface WaveExclusionSets {
  /** Недавно проигранное: ослабляется первым. */
  excludeTrackIds: string[];
  /** Треки в текущей очереди: не должны возвращаться, пока есть альтернативы. */
  queuedTrackIds: string[];
}

/**
 * Делит исключения на два уровня, чтобы бэкенд не подсунул обратно трек,
 * который всё ещё лежит в буфере плеера, раньше, чем реально проигранный.
 */
export function buildWaveExclusions(
  currentTrack: Track | null,
  queue: Track[],
  playedIds: string[],
  limit: number = WAVE_MAX_EXCLUDE_IDS
): WaveExclusionSets {
  const queued = new Set<string>();
  for (const track of queue) {
    if (track?.id && track.id !== currentTrack?.id) queued.add(track.id);
  }

  const excludeTrackIds: string[] = [];
  const seen = new Set<string>([...queued, currentTrack?.id ?? '']);

  for (const id of playedIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    excludeTrackIds.push(id);
  }

  return {
    excludeTrackIds: excludeTrackIds.slice(-limit),
    queuedTrackIds: Array.from(queued).slice(-limit),
  };
}
