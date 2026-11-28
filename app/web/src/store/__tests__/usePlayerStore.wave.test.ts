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
let queueReplyOverride: ((signal?: AbortSignal | null) => Response | Promise<Response>) | null = null;

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
    if (queueReplyOverride) return await queueReplyOverride(init?.signal);
    return jsonResponse(waveQueueReplies.shift() ?? []);
  }
  if (url.includes('/api/media-ticket')) {
    const trackId = String(body?.track_id ?? '');
    return jsonResponse({ url: `/api/stream/${trackId}?mt=ticket-${trackId}`, expires_in: 600 });
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

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.handlers.set(type, (this.handlers.get(type) ?? []).filter(item => item !== listener));
  }
  removeAttribute(name: string): void { if (name === 'src') this.src = ''; }
  load(): void { if (this.src) queueMicrotask(() => this.fire('canplay')); }
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }

  get currentSrc(): string {
    return this.srcValue;
  }

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
const { resetAudioTicketCache } = await import('../../api/media.ts');

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
  // Стрим по media-тикету: файл тянет сам <audio>, поэтому факт загрузки трека
  // наблюдаем по смене src аудио-элемента на /api/stream/{id}?mt=...
  return audioInstance.srcLog
    .filter((src) => src.includes('/api/stream/'))
    .map((src) => decodeURIComponent(src.split('/api/stream/')[1].split('?')[0]));
}

function seedWave(currentTrackId: string, queueIds: string[], playedIds: string[]): void {
  audioInstance.src = `/api/stream/${currentTrackId}?mt=synthetic-media`;
  audioInstance.srcLog.length = 0;
  usePlayerStore.setState({
    isWaveActive: true,
    currentTrack: track(currentTrackId),
    queue: queueIds.map(track),
    currentTrackIndex: queueIds.indexOf(currentTrackId),
    wavePlayedIds: playedIds,
  });
}

beforeEach(() => {
  usePlayerStore.getState().resetUserData();
  usePlayerStore.setState({
    currentTrack: null,
    status: 'idle',
    currentTime: 0,
    duration: 0,
    queue: [],
    currentTrackIndex: -1,
    wavePlayedIds: [],
    isWaveActive: false,
    autoplayAfterQueue: false,
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
  resetAudioTicketCache();
  audioInstance.srcLog.length = 0;
});

describe('Wave double-feedback guard', () => {
  it('1. ended auto-advance reports finish only — no duplicate skip for the same track', async () => {
    seedWave('00000000-0000-4000-a000-000000000042', ['00000000-0000-4000-a000-000000000042', '00000000-0000-4000-a000-000000000043'], []);
    audioInstance.fire('ended');
    await settleAsyncChains();

    assert.deepEqual(feedbackSummaries(), [{ track_id: '00000000-0000-4000-a000-000000000042', event_type: 'finish' }]);
    assert.equal(usePlayerStore.getState().currentTrack?.id, '00000000-0000-4000-a000-000000000043');
  });

  it('2. manual nextTrack still reports skip feedback (external no-arg contract)', async () => {
    usePlayerStore.setState({ currentTime: 45 });
    seedWave('00000000-0000-4000-a000-000000000042', ['00000000-0000-4000-a000-000000000042', '00000000-0000-4000-a000-000000000043'], []);

    await usePlayerStore.getState().nextTrack();

    assert.deepEqual(feedbackSummaries(), [{ track_id: '00000000-0000-4000-a000-000000000042', event_type: 'skip' }]);
    assert.equal(firstFeedbackBody()?.listen_duration_ms, 45000);
    assert.equal(firstFeedbackBody()?.context, 'wave');
    assert.equal(firstFeedbackBody()?.client, 'web');
    assert.equal(typeof firstFeedbackBody()?.event_id, 'string');
    assert.ok(Date.parse(String(firstFeedbackBody()?.occurred_at)));
    assert.equal(usePlayerStore.getState().currentTrack?.id, '00000000-0000-4000-a000-000000000043');
  });

  it('3. ended with repeatMode one replays the current track without skipping ahead', async () => {
    seedWave('00000000-0000-4000-a000-000000000042', ['00000000-0000-4000-a000-000000000042', '00000000-0000-4000-a000-000000000043'], []);
    usePlayerStore.setState({ repeatMode: 'one' });

    audioInstance.fire('ended');
    await settleAsyncChains();

    assert.deepEqual(feedbackSummaries(), [{ track_id: '00000000-0000-4000-a000-000000000042', event_type: 'finish' }]);
    assert.equal(usePlayerStore.getState().currentTrack?.id, '00000000-0000-4000-a000-000000000042');
    assert.deepEqual(usePlayerStore.getState().queue.map((t) => t.id), ['00000000-0000-4000-a000-000000000042', '00000000-0000-4000-a000-000000000043']);
    assert.deepEqual(loadedStreamIds(), ['00000000-0000-4000-a000-000000000042']);
  });
});

describe('Wave batch consumption', () => {
  it('cancelling Wave interrupts a queue response still waiting for its body', async () => {
    let aborted = false;
    queueReplyOverride = (signal) => new Response(new ReadableStream({
      start(controller) {
        assert.ok(signal);
        signal.addEventListener('abort', () => {
          aborted = true;
          controller.error(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      },
    }));
    const launch = usePlayerStore.getState().toggleWave();
    await settleAsyncChains();
    assert.equal(usePlayerStore.getState().isWaveLoading, true);

    await usePlayerStore.getState().toggleWave();
    assert.equal(aborted, true);
    assert.equal(await launch, false);
    assert.equal(usePlayerStore.getState().isWaveLoading, false);
    assert.equal(usePlayerStore.getState().isWaveActive, false);
  });

  it('4. toggleWave activates with exactly one fetch and plays the batch head', async () => {
    waveQueueReplies = [['00000000-0000-4000-a000-000000000041', '00000000-0000-4000-a000-000000000042', '00000000-0000-4000-a000-000000000043'].map(track)];

    await usePlayerStore.getState().toggleWave();

    assert.equal(waveQueueFetchUrls.length, 1);
    assert.equal(usePlayerStore.getState().currentTrack?.id, '00000000-0000-4000-a000-000000000041');
    assert.deepEqual(usePlayerStore.getState().queue.map((t) => t.id), ['00000000-0000-4000-a000-000000000041', '00000000-0000-4000-a000-000000000042', '00000000-0000-4000-a000-000000000043']);
    assert.deepEqual(loadedStreamIds(), ['00000000-0000-4000-a000-000000000041']);
  });

  it('the home card starts a different run from a playing Wave', async () => {
    const previous = '00000000-0000-4000-a000-000000000041';
    const next = '00000000-0000-4000-a000-000000000042';
    seedWave(previous, [previous], [previous]);
    waveQueueReplies = [[track(next)]];
    await usePlayerStore.getState().startWave();
    const params = new URL(waveQueueFetchUrls[0], 'http://localhost').searchParams;
    assert.equal(params.get('mode'), 'start');
    assert.equal(params.get('previous_track_id'), previous);
    assert.equal(usePlayerStore.getState().currentTrack?.id, next);
  });

  it('5. repeated Next consumes the buffer: played head leaves the queue, ids are remembered', async () => {
    seedWave('00000000-0000-4000-a000-000000000042', ['00000000-0000-4000-a000-000000000042', '00000000-0000-4000-a000-000000000043', '00000000-0000-4000-a000-000000000044', '00000000-0000-4000-a000-000000000045', '00000000-0000-4000-a000-000000000046', '00000000-0000-4000-a000-000000000047', '00000000-0000-4000-a000-000000000048', '00000000-0000-4000-a000-000000000049'], ['00000000-0000-4000-a000-000000000042']);

    await usePlayerStore.getState().nextTrack();
    await usePlayerStore.getState().nextTrack();

    const state = usePlayerStore.getState();
    assert.equal(state.currentTrack?.id, '00000000-0000-4000-a000-000000000044');
    assert.deepEqual(state.queue.map((t) => t.id), ['00000000-0000-4000-a000-000000000043', '00000000-0000-4000-a000-000000000044', '00000000-0000-4000-a000-000000000045', '00000000-0000-4000-a000-000000000046', '00000000-0000-4000-a000-000000000047', '00000000-0000-4000-a000-000000000048', '00000000-0000-4000-a000-000000000049']);
    for (const id of ['00000000-0000-4000-a000-000000000042', '00000000-0000-4000-a000-000000000043', '00000000-0000-4000-a000-000000000044']) {
      assert.ok(state.wavePlayedIds.includes(id), `wavePlayedIds should contain ${id}`);
    }
    // Buffer serves both Next presses: no Qdrant fetch, exactly one load per
    // consumed track (C and D) — the seeded head B is never re-loaded.
    assert.equal(waveQueueFetchUrls.length, 0);
    assert.deepEqual(loadedStreamIds(), ['00000000-0000-4000-a000-000000000043', '00000000-0000-4000-a000-000000000044']);
  });

  it('6. prefetch loads the next batch only when the remaining buffer hits the threshold', async () => {
    seedWave('00000000-0000-4000-a000-000000000042', ['00000000-0000-4000-a000-000000000042', '00000000-0000-4000-a000-000000000043', '00000000-0000-4000-a000-000000000044', '00000000-0000-4000-a000-000000000045', '00000000-0000-4000-a000-000000000046', '00000000-0000-4000-a000-000000000047', '00000000-0000-4000-a000-000000000048', '00000000-0000-4000-a000-000000000049'], ['00000000-0000-4000-a000-000000000042']);
    waveQueueReplies = [['00000000-0000-4000-a000-00000000004a', '00000000-0000-4000-a000-00000000004b', '00000000-0000-4000-a000-00000000004c', '00000000-0000-4000-a000-00000000004d', '00000000-0000-4000-a000-00000000004e', '00000000-0000-4000-a000-00000000004f', '00000000-0000-4000-a000-000000000050', '00000000-0000-4000-a000-000000000051'].map(track)];

    for (let i = 0; i < 4; i += 1) {
      await usePlayerStore.getState().nextTrack();
    }
    assert.equal(waveQueueFetchUrls.length, 0);
    assert.equal(usePlayerStore.getState().currentTrack?.id, '00000000-0000-4000-a000-000000000046');

    await usePlayerStore.getState().nextTrack();
    await settleAsyncChains();

    assert.equal(waveQueueFetchUrls.length, 1);
    const state = usePlayerStore.getState();
    assert.equal(state.currentTrack?.id, '00000000-0000-4000-a000-000000000047');
    // Keep the current track as the navigation anchor before the unplayed buffer.
    assert.deepEqual(state.queue.map((t) => t.id), [
      '00000000-0000-4000-a000-000000000047', '00000000-0000-4000-a000-000000000048', '00000000-0000-4000-a000-000000000049', '00000000-0000-4000-a000-00000000004a', '00000000-0000-4000-a000-00000000004b', '00000000-0000-4000-a000-00000000004c', '00000000-0000-4000-a000-00000000004d', '00000000-0000-4000-a000-00000000004e', '00000000-0000-4000-a000-00000000004f', '00000000-0000-4000-a000-000000000050', '00000000-0000-4000-a000-000000000051',
    ]);
  });
});

describe('Wave single in-flight request', () => {
  it('7. concurrent nextTrack calls share one wave fetch and fetch again after reset', async () => {
    seedWave('00000000-0000-4000-a000-000000000042', [], ['00000000-0000-4000-a000-000000000042']);
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

    releaseGate([track('00000000-0000-4000-a000-000000000058')]);
    await Promise.all([first, second]);
    await settleAsyncChains();

    assert.equal(usePlayerStore.getState().currentTrack?.id, '00000000-0000-4000-a000-000000000058');
    assert.equal(waveQueueFetchUrls.length, 1);
    // The batch head streamed exactly once — a shared in-flight fetch must not
    // double-play X when both parked presses resume.
    assert.deepEqual(loadedStreamIds(), ['00000000-0000-4000-a000-000000000058']);

    // The in-flight slot was released: the next call performs a fresh fetch.
    waveQueueReplies = [[track('00000000-0000-4000-a000-000000000059')]];
    queueReplyOverride = null;
    await usePlayerStore.getState().nextTrack();

    assert.equal(waveQueueFetchUrls.length, 2);
    assert.equal(usePlayerStore.getState().currentTrack?.id, '00000000-0000-4000-a000-000000000059');
  });

  it('9. concurrent presses on an empty buffer land distinct tracks — the batch head never double-plays', async () => {
    seedWave('00000000-0000-4000-a000-000000000042', [], ['00000000-0000-4000-a000-000000000042']);
    waveQueueReplies = [['00000000-0000-4000-a000-000000000058', '00000000-0000-4000-a000-000000000059'].map(track)];

    const first = usePlayerStore.getState().nextTrack();
    const second = usePlayerStore.getState().nextTrack();
    await settleAsyncChains();
    await Promise.all([first, second]);
    await settleAsyncChains();

    // Second press consumed the refreshed buffer: X played once, then Y.
    // The extra fetch is the automatic buffer refill after Y.
    assert.equal(waveQueueFetchUrls.length, 2);
    assert.equal(usePlayerStore.getState().currentTrack?.id, '00000000-0000-4000-a000-000000000059');
    assert.deepEqual(loadedStreamIds(), ['00000000-0000-4000-a000-000000000058', '00000000-0000-4000-a000-000000000059']);
  });

  it('8. concurrent Next presses with a buffered queue consume it sequentially', async () => {
    seedWave('00000000-0000-4000-a000-000000000042', ['00000000-0000-4000-a000-000000000042', '00000000-0000-4000-a000-000000000043', '00000000-0000-4000-a000-000000000044', '00000000-0000-4000-a000-000000000045', '00000000-0000-4000-a000-000000000046', '00000000-0000-4000-a000-000000000047', '00000000-0000-4000-a000-000000000048', '00000000-0000-4000-a000-000000000049'], ['00000000-0000-4000-a000-000000000042']);

    void usePlayerStore.getState().nextTrack();
    await usePlayerStore.getState().nextTrack();

    const state = usePlayerStore.getState();
    assert.equal(state.currentTrack?.id, '00000000-0000-4000-a000-000000000044');
    assert.equal(waveQueueFetchUrls.length, 0);
    assert.deepEqual(loadedStreamIds(), ['00000000-0000-4000-a000-000000000043', '00000000-0000-4000-a000-000000000044']);
  });
});


describe('Collection order and search recommendations', () => {
  it('plays from the selected collection position and starts similar tracks after the last ended event', async () => {
    seedWave('old', ['old', 'unrelated'], []);
    const list = ['00000000-0000-4000-a000-000000000041', '00000000-0000-4000-a000-000000000042', '00000000-0000-4000-a000-000000000043'].map(track);
    await usePlayerStore.getState().playTrack(list[1], list, 'collection');
    assert.equal(usePlayerStore.getState().isWaveActive, false);
    await usePlayerStore.getState().nextTrack();
    assert.equal(usePlayerStore.getState().currentTrack?.id, '00000000-0000-4000-a000-000000000043');
    assert.equal(waveQueueFetchUrls.length, 0);
    waveQueueReplies = [['00000000-0000-4000-a000-000000000044', '00000000-0000-4000-a000-000000000045', '00000000-0000-4000-a000-000000000046', '00000000-0000-4000-a000-000000000047'].map(track)];
    await settleAsyncChains();
    audioInstance.fire('ended');
    await settleAsyncChains();
    assert.equal(usePlayerStore.getState().currentTrack?.id, '00000000-0000-4000-a000-000000000044');
    assert.deepEqual(usePlayerStore.getState().queue.map((t) => t.id), ['00000000-0000-4000-a000-000000000044', '00000000-0000-4000-a000-000000000045', '00000000-0000-4000-a000-000000000046', '00000000-0000-4000-a000-000000000047']);
    assert.equal(waveQueueFetchUrls.length, 1);
    assert.equal(new URL(waveQueueFetchUrls[0], 'https://puuk.app').searchParams.get('current_track_id'), '00000000-0000-4000-a000-000000000043');
  });

  it('search keeps the selected track playing and follows it with the first recommendation', async () => {
    waveQueueReplies = [['00000000-0000-4000-a000-000000000042', '00000000-0000-4000-a000-000000000043', '00000000-0000-4000-a000-000000000044', '00000000-0000-4000-a000-000000000045'].map(track)];
    await usePlayerStore.getState().playTrack(track('00000000-0000-4000-a000-000000000041'), undefined, 'search');
    await settleAsyncChains();
    assert.equal(usePlayerStore.getState().currentTrack?.id, '00000000-0000-4000-a000-000000000041');
    assert.deepEqual(usePlayerStore.getState().queue.map((t) => t.id), ['00000000-0000-4000-a000-000000000041', '00000000-0000-4000-a000-000000000042', '00000000-0000-4000-a000-000000000043', '00000000-0000-4000-a000-000000000044', '00000000-0000-4000-a000-000000000045']);
    await usePlayerStore.getState().nextTrack();
    assert.equal(usePlayerStore.getState().currentTrack?.id, '00000000-0000-4000-a000-000000000042');
  });

  it('repeat all and repeat one take priority over collection autoplay', async () => {
    const list = ['00000000-0000-4000-a000-000000000041', '00000000-0000-4000-a000-000000000042'].map(track);
    await usePlayerStore.getState().playTrack(list[1], list, 'collection');
    usePlayerStore.getState().setRepeatMode('one');
    audioInstance.fire('ended');
    await settleAsyncChains();
    assert.equal(usePlayerStore.getState().currentTrack?.id, '00000000-0000-4000-a000-000000000042');
    usePlayerStore.getState().setRepeatMode('all');
    audioInstance.fire('ended');
    await settleAsyncChains();
    assert.equal(usePlayerStore.getState().currentTrack?.id, '00000000-0000-4000-a000-000000000041');
    assert.equal(waveQueueFetchUrls.length, 0);
  });

  for (const source of ['search', 'collection'] as const) {
    it(`discards late ${source} recommendations after selecting a new collection`, async () => {
      let release!: (response: Response) => void;
      queueReplyOverride = () => new Promise((resolve) => { release = resolve; });
      await usePlayerStore.getState().playTrack(track('00000000-0000-4000-a000-000000000041'), [track('00000000-0000-4000-a000-000000000041')], source);
      const advance = source === 'collection' ? usePlayerStore.getState().nextTrack() : undefined;
      await settleAsyncChains();
      await usePlayerStore.getState().playTrack(track('00000000-0000-4000-a000-000000000058'), ['00000000-0000-4000-a000-000000000058', '00000000-0000-4000-a000-000000000059'].map(track), 'collection');
      release(jsonResponse([track('stale')]));
      await advance;
      await settleAsyncChains();
      assert.equal(usePlayerStore.getState().currentTrack?.id, '00000000-0000-4000-a000-000000000058');
      assert.deepEqual(usePlayerStore.getState().queue.map((t) => t.id), ['00000000-0000-4000-a000-000000000058', '00000000-0000-4000-a000-000000000059']);
      assert.equal(usePlayerStore.getState().isWaveActive, false);
    });
  }
});
