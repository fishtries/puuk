import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WAVE_MAX_BUFFER_SIZE,
  buildWaveExclusions,
  compactWaveQueue,
  mergeWaveTracks,
  trimPlayedIds,
  upcomingWaveTracks,
} from '../waveQueue.ts';
import type { Track } from '../../types/track.ts';

const track = (id: string): Track => ({ id, title: `Title ${id}`, artist: `Artist ${id}`, duration: 180 });

describe('Wave queue helpers', () => {
  it('1. mergeWaveTracks removes duplicates and keeps recommendation order', () => {
    const merged = mergeWaveTracks([track('B'), track('C')], [track('C'), track('D'), track('B')], new Set());
    assert.deepEqual(merged.map((t) => t.id), ['B', 'C', 'D']);
  });

  it('2. mergeWaveTracks drops excluded and already played ids', () => {
    const merged = mergeWaveTracks(
      [track('B')],
      [track('C'), track('D')],
      new Set(['B'])
    );
    assert.deepEqual(merged.map((t) => t.id), ['C', 'D']);
  });

  it('3. mergeWaveTracks never resurrects the current track', () => {
    const merged = mergeWaveTracks([], [track('A'), track('B')], new Set(['A']));
    assert.deepEqual(merged.map((t) => t.id), ['B']);
  });

  it('4. upcomingWaveTracks ignores played and past tracks', () => {
    const queue = [track('A'), track('B'), track('C'), track('D')];
    const upcoming = upcomingWaveTracks(queue, 1, ['A']);
    assert.deepEqual(upcoming.map((t) => t.id), ['C', 'D']);
  });

  it('5. compactWaveQueue drops played history before the current track', () => {
    const queue = [track('A'), track('B'), track('C'), track('D')];
    const compacted = compactWaveQueue(queue, 2, ['A', 'B']);
    // Played history is discarded; queue starts at the current track.
    assert.deepEqual(compacted.map((t) => t.id), ['C', 'D']);
  });

  it('6. compactWaveQueue bounds the future buffer', () => {
    const queue = Array.from({ length: 40 }, (_, i) => track(`T${i}`));
    const compacted = compactWaveQueue(queue, 0, []);
    assert.equal(compacted.length, 1 + WAVE_MAX_BUFFER_SIZE);
  });

  it('7. trimPlayedIds keeps the most recent ids', () => {
    const ids = Array.from({ length: 120 }, (_, i) => `id-${i}`);
    const trimmed = trimPlayedIds(ids, 100);
    assert.equal(trimmed.length, 100);
    assert.equal(trimmed[trimmed.length - 1], 'id-119');
    assert.equal(trimmed[0], 'id-20');
  });

  it('8. buildWaveExclusions splits queue ids from played ids', () => {
    const exclusions = buildWaveExclusions(
      track('A'),
      [track('A'), track('B'), track('C')],
      ['A', 'B']
    );

    // Queue ids never include the current track.
    assert.deepEqual(exclusions.queuedTrackIds, ['B', 'C']);
    // Played ids exclude whatever is still queued/current.
    assert.deepEqual(exclusions.excludeTrackIds, []);
  });

  it('9. buildWaveExclusions sends already played ids as exclude', () => {
    const exclusions = buildWaveExclusions(
      track('D'),
      [track('D'), track('E')],
      ['A', 'B', 'C']
    );

    assert.deepEqual(exclusions.queuedTrackIds, ['E']);
    assert.deepEqual(exclusions.excludeTrackIds, ['A', 'B', 'C']);
  });
});
