import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { Track } from '../../types/track.ts';

// The store graph is written for a bundler (extensionless relative imports);
// teach the Node resolver to append the .ts extension for them. Type-only
// modules are additionally redirected to local shims because type stripping
// erases their declarations and leaves the runtime imports unlinkable.
const realPlayerTypesUrl = new URL('../../types/player.ts', import.meta.url).href;
const realTrackTypesUrl = new URL('../../types/track.ts', import.meta.url).href;
const realWaveQueueUrl = new URL('../waveQueue.ts', import.meta.url).href;
const runtimeTypeShims = new Map([
  [realPlayerTypesUrl, new URL('./playerTypesShim.ts', import.meta.url).href],
  [realTrackTypesUrl, new URL('./trackTypesShim.ts', import.meta.url).href],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    let resolved;
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        resolved = nextResolve(`${specifier}.ts`, context);
      } catch {
        resolved = nextResolve(specifier, context);
      }
    } else {
      resolved = nextResolve(specifier, context);
    }

    const shimUrl = runtimeTypeShims.get(resolved.url);
    if (shimUrl) return { url: shimUrl, shortCircuit: true };
    return resolved;
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== realWaveQueueUrl) return result;

    // WaveExclusionSets is exported as a type from the untouched waveQueue
    // module; re-attach a linkable placeholder after type stripping so the
    // store's named import still resolves at runtime.
    return {
      format: result.format,
      shortCircuit: true,
      source: `${String(result.source)}\nexport const WaveExclusionSets = undefined;\n`,
    };
  },
});

const track = (id: string): Track => ({ id, title: `Title ${id}`, artist: `Artist ${id}`, duration: 180 });

interface RecordedFetch {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

const networkCalls: RecordedFetch[] = [];
const waveQueueFetchUrls: string[] = [];
let waveQueueReplies: Track[][] = [];
let queueReplyOverride: (() => Response | Promise<Response>) | null = null;

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
  networkCalls.push({ url, method: init?.method ?? 'GET', body });

  if (url.includes('/api/wave/feedback')) return jsonResponse({ status: 'ok' });
  if (url.includes('/api/wave/queue')) {
    waveQueueFetchUrls.push(url);
    if (queueReplyOverride) return await queueReplyOverride();
    return jsonResponse(waveQueueReplies.shift() ?? []);
  }
  return jsonResponse({});
}) as typeof fetch;

// AudioEngine touches the DOM at import time; a controllable <audio> stand-in
// lets tests observe loads (src changes) and fire lifecycle events like `ended`.
class FakeAudioElement {
  readonly srcLog: string[] = [];
  private srcValue = '';

  preload = 'metadata';
  crossOrigin = '';
  paused = true;
  currentTime = 0;
  duration = NaN;
  volume = 1;
  error: { message: string } | null = null;

  get src(): string {
    return this.srcValue;
  }
  set src(value: string) {
    this.srcValue = value;
    this.srcLog.push(value);
  }

  private handlers = new Map<string, ((event: Event) => void)[]>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(listener);
    this.handlers.set(type, list);
  }

  load(): void {}
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {}

  fire(type: string): void {
    for (const listener of this.handlers.get(type) ?? []) {
      listener(new Event(type));
    }
  }
}

const audioInstance = new FakeAudioElement();

globalThis.Audio = function (): HTMLAudioElement {
  return audioInstance as unknown as HTMLAudioElement;
} as unknown as typeof Audio;

globalThis.localStorage = {
  getItem: () => 'test-token',
  setItem: () => {},
  removeItem: () => {},
} as unknown as Storage;

// Медиа-хелпер создаёт blob: URL для аудио (закрытый режим: стрим только с JWT)
let blobCounter = 0;
(globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL = () => `blob:mock-${++blobCounter}`;
(globalThis.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};

const { usePlayerStore } = await import('../usePlayerStore.ts');

async function settleAsyncChains(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function feedbackSummaries(): Array<{ track_id: string; event_type: string }> {
  return networkCalls
    .filter((call) => call.url.includes('/api/wave/feedback'))
    .map((call) => {
      const body = call.body ?? {};
      return { track_id: body.track_id as string, event_type: body.event_type as string };
    });
}

function firstFeedbackBody(): Record<string, unknown> | undefined {
  return networkCalls.find((call) => call.url.includes('/api/wave/feedback'))?.body;
}

function loadedStreamIds(): string[] {
  // Закрытый режим: аудио грузится авторизованным fetch в blob: URL,
  // поэтому факт загрузки трека наблюдаем по сетевым запросам стрима.
  return networkCalls
    .filter((call) => call.method === 'GET' && call.url.includes('/api/stream/'))
    .map((call) => decodeURIComponent(call.url.split('/api/stream/')[1].split('?')[0]));
}

function seedWave(currentTrackId: string, queueIds: string[], playedIds: string[]): void {
  usePlayerStore.setState({
    isWaveActive: true,
    currentTrack: track(currentTrackId),
    queue: queueIds.map(track),
    currentTrackIndex: queueIds.indexOf(currentTrackId),
    wavePlayedIds: playedIds,
  });
}

beforeEach(() => {
  usePlayerStore.setState({
    currentTrack: null,
    status: 'idle',
    currentTime: 0,
    duration: 0,
    queue: [],
    currentTrackIndex: -1,
    wavePlayedIds: [],
    isWaveActive: false,
    isWaveLoading: false,
    repeatMode: 'off',
    isShuffled: false,
    history: [],
    recentlyPlayed: [],
    lyrics: [],
    rawLyricsText: '',
    isLyricsLoading: false,
    isHistoryLoading: false,
  });
  networkCalls.length = 0;
  waveQueueFetchUrls.length = 0;
  waveQueueReplies = [];
  queueReplyOverride = null;
  audioInstance.srcLog.length = 0;
});

describe('Wave double-feedback guard', () => {
  it('1. ended auto-advance reports finish only — no duplicate skip for the same track', async () => {
    seedWave('B', ['B', 'C'], []);
    audioInstance.fire('ended');
    await settleAsyncChains();

    assert.deepEqual(feedbackSummaries(), [{ track_id: 'B', event_type: 'finish' }]);
    assert.equal(usePlayerStore.getState().currentTrack?.id, 'C');
  });

  it('2. manual nextTrack still reports skip feedback (external no-arg contract)', async () => {
    usePlayerStore.setState({ currentTime: 45 });
    seedWave('B', ['B', 'C'], []);

    await usePlayerStore.getState().nextTrack();

    assert.deepEqual(feedbackSummaries(), [{ track_id: 'B', event_type: 'skip' }]);
    assert.equal(firstFeedbackBody()?.listen_duration_ms, 45000);
    assert.equal(usePlayerStore.getState().currentTrack?.id, 'C');
  });

  it('3. ended with repeatMode one replays the current track without skipping ahead', async () => {
    seedWave('B', ['B', 'C'], []);
    usePlayerStore.setState({ repeatMode: 'one' });

    audioInstance.fire('ended');
    await settleAsyncChains();

    assert.deepEqual(feedbackSummaries(), [{ track_id: 'B', event_type: 'finish' }]);
    assert.equal(usePlayerStore.getState().currentTrack?.id, 'B');
    assert.deepEqual(usePlayerStore.getState().queue.map((t) => t.id), ['B', 'C']);
    assert.deepEqual(loadedStreamIds(), []);
  });
});

describe('Wave batch consumption', () => {
  it('4. toggleWave activates with exactly one fetch and plays the batch head', async () => {
    waveQueueReplies = [['A', 'B', 'C'].map(track)];

    await usePlayerStore.getState().toggleWave();

    assert.equal(waveQueueFetchUrls.length, 1);
    assert.equal(usePlayerStore.getState().currentTrack?.id, 'A');
    assert.deepEqual(usePlayerStore.getState().queue.map((t) => t.id), ['A', 'B', 'C']);
    assert.deepEqual(loadedStreamIds(), ['A']);
  });

  it('5. repeated Next consumes the buffer: played head leaves the queue, ids are remembered', async () => {
    seedWave('B', ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'], ['B']);

    await usePlayerStore.getState().nextTrack();
    await usePlayerStore.getState().nextTrack();

    const state = usePlayerStore.getState();
    assert.equal(state.currentTrack?.id, 'D');
    assert.deepEqual(state.queue.map((t) => t.id), ['C', 'D', 'E', 'F', 'G', 'H', 'I']);
    for (const id of ['B', 'C', 'D']) {
      assert.ok(state.wavePlayedIds.includes(id), `wavePlayedIds should contain ${id}`);
    }
    // Buffer serves both Next presses: no Qdrant fetch, exactly one load per
    // consumed track (C and D) — the seeded head B is never re-loaded.
    assert.equal(waveQueueFetchUrls.length, 0);
    assert.deepEqual(loadedStreamIds(), ['C', 'D']);
  });

  it('6. prefetch loads the next batch only when the remaining buffer hits the threshold', async () => {
    seedWave('B', ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'], ['B']);
    waveQueueReplies = [['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'].map(track)];

    for (let i = 0; i < 4; i += 1) {
      await usePlayerStore.getState().nextTrack();
    }
    assert.equal(waveQueueFetchUrls.length, 0);
    assert.equal(usePlayerStore.getState().currentTrack?.id, 'F');

    await usePlayerStore.getState().nextTrack();
    await settleAsyncChains();

    assert.equal(waveQueueFetchUrls.length, 1);
    const state = usePlayerStore.getState();
    assert.equal(state.currentTrack?.id, 'G');
    // The freshly played current (G) is dropped from the buffered queue;
    // batch 2 (J..Q) is merged onto the unplayed remainder.
    assert.deepEqual(state.queue.map((t) => t.id), [
      'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q',
    ]);
  });
});

describe('Wave single in-flight request', () => {
  it('7. concurrent nextTrack calls share one wave fetch and fetch again after reset', async () => {
    seedWave('B', [], ['B']);
    let releaseGate!: (batch: Track[]) => void;
    const gate = new Promise<Track[]>((resolve) => {
      releaseGate = resolve;
    });
    queueReplyOverride = () => gate.then((batch) => jsonResponse(batch));

    const first = usePlayerStore.getState().nextTrack();
    const second = usePlayerStore.getState().nextTrack();
    await settleAsyncChains();

    // Both callers park on the shared promise: exactly one HTTP fetch happened.
    assert.equal(waveQueueFetchUrls.length, 1);

    releaseGate([track('X')]);
    await Promise.all([first, second]);
    await settleAsyncChains();

    assert.equal(usePlayerStore.getState().currentTrack?.id, 'X');
    assert.equal(waveQueueFetchUrls.length, 1);
    // The batch head streamed exactly once — a shared in-flight fetch must not
    // double-play X when both parked presses resume.
    assert.deepEqual(loadedStreamIds(), ['X']);

    // The in-flight slot was released: the next call performs a fresh fetch.
    waveQueueReplies = [[track('Y')]];
    queueReplyOverride = null;
    await usePlayerStore.getState().nextTrack();

    assert.equal(waveQueueFetchUrls.length, 2);
    assert.equal(usePlayerStore.getState().currentTrack?.id, 'Y');
  });

  it('9. concurrent presses on an empty buffer land distinct tracks — the batch head never double-plays', async () => {
    seedWave('B', [], ['B']);
    waveQueueReplies = [['X', 'Y'].map(track)];

    const first = usePlayerStore.getState().nextTrack();
    const second = usePlayerStore.getState().nextTrack();
    await settleAsyncChains();
    await Promise.all([first, second]);
    await settleAsyncChains();

    // Second press consumed the refreshed buffer: X played once, then Y.
    // The extra fetch is the automatic buffer refill after Y.
    assert.equal(waveQueueFetchUrls.length, 2);
    assert.equal(usePlayerStore.getState().currentTrack?.id, 'Y');
    assert.deepEqual(loadedStreamIds(), ['X', 'Y']);
  });

  it('8. concurrent Next presses with a buffered queue consume it sequentially', async () => {
    seedWave('B', ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'], ['B']);

    void usePlayerStore.getState().nextTrack();
    await usePlayerStore.getState().nextTrack();

    const state = usePlayerStore.getState();
    assert.equal(state.currentTrack?.id, 'D');
    assert.equal(waveQueueFetchUrls.length, 0);
    assert.deepEqual(loadedStreamIds(), ['C', 'D']);
  });
});
