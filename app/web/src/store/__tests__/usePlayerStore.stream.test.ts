import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { Track } from '../../types/track.ts';

// Тот же bootstrap, что в usePlayerStore.wave.test.ts: стор написан под
// бандлер (импорты без расширений), type-only модули подменяются шиммами.
const realPlayerTypesUrl = new URL('../../types/player.ts', import.meta.url).href;
const realTrackTypesUrl = new URL('../../types/track.ts', import.meta.url).href;
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
});

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

  get currentSrc(): string {
    return this.srcValue;
  }

  private handlers = new Map<string, ((event: Event) => void)[]>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(listener);
    this.handlers.set(type, list);
  }

  load(): void {}
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
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

let blobCounter = 0;
(globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL = () => `blob:mock-${++blobCounter}`;
(globalThis.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};

// fire('play') в движке запускает time-loop на rAF; в node колбэки не тикают.
(globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame = () => 0;
(globalThis as unknown as { cancelAnimationFrame: () => void }).cancelAnimationFrame = () => {};

interface RecordedFetch {
  url: string;
  method: string;
}

const networkCalls: RecordedFetch[] = [];

// Media-тикет: FIFO фабрик ответов; пустой список — мгновенный успешный тикет.
const ticketFactories: Array<() => Response | Promise<Response>> = [];
let ticketCounter = 0;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function ticketFor(trackId: string): Response {
  ticketCounter += 1;
  return jsonResponse({ url: `/api/stream/${trackId}?mt=ticket-${ticketCounter}`, expires_in: 600 });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
  networkCalls.push({ url, method: init?.method ?? 'GET' });

  if (url.includes('/api/media-ticket')) {
    const trackId = String(body?.track_id ?? '');
    if (ticketFactories.length > 0) return await ticketFactories.shift()!();
    return ticketFor(trackId);
  }
  if (url.includes('/api/wave/feedback')) return jsonResponse({ status: 'ok' });
  return jsonResponse({});
}) as typeof fetch;

const { usePlayerStore } = await import('../usePlayerStore.ts');

const track = (id: string): Track => ({ id, title: `Title ${id}`, artist: `Artist ${id}`, duration: 180 });

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function streamSrcLog(): string[] {
  return audioInstance.srcLog.filter((src) => src.includes('/api/stream/'));
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
  ticketFactories.length = 0;
  audioInstance.srcLog.length = 0;
  audioInstance.paused = true;
});

describe('Переключение трека: немедленное глушение и гонки загрузки', () => {
  it('1. прежний источник глушится синхронно, до ответа media-тикета', async () => {
    usePlayerStore.setState({ currentTrack: track('A'), queue: [track('A')], status: 'playing' });
    audioInstance.paused = false;

    let releaseB!: (response: Response) => void;
    ticketFactories.push(
      () => new Promise<Response>((resolve) => { releaseB = resolve; }),
    );

    const switching = usePlayerStore.getState().playTrack(track('B'), [track('B')]);

    // Синхронная часть playTrack: UI уже на новом треке, старый звук выключен,
    // хотя билет для B ещё не вернулся.
    assert.equal(usePlayerStore.getState().currentTrack?.id, 'B');
    assert.equal(usePlayerStore.getState().status, 'loading');
    assert.equal(audioInstance.paused, true);
    assert.equal(audioInstance.src, '');

    releaseB(ticketFor('B'));
    await switching;
    audioInstance.fire('play');

    assert.ok(streamSrcLog()[0].startsWith('/api/stream/B?mt='));
    assert.equal(usePlayerStore.getState().status, 'playing');
  });

  it('2. поздний ответ устаревшего переключения не запускает свой трек', async () => {
    let releaseA!: (response: Response) => void;
    ticketFactories.push(
      () => new Promise<Response>((resolve) => { releaseA = resolve; }),
    );

    const first = usePlayerStore.getState().playTrack(track('A'), [track('A')]);
    const second = usePlayerStore.getState().playTrack(track('B'), [track('B')]);

    releaseA(ticketFor('A'));
    await Promise.all([first, second]);
    await settle();
    audioInstance.fire('play');

    // A опоздал: играет только B, статус не испорчен.
    assert.deepEqual(streamSrcLog().map((src) => src.split('?')[0]), ['/api/stream/B']);
    assert.equal(usePlayerStore.getState().currentTrack?.id, 'B');
    assert.equal(usePlayerStore.getState().status, 'playing');
  });

  it('3. ошибка тикета актуального запроса даёт error, устаревшего — ничего', async () => {
    const fail = () => jsonResponse({ detail: 'ticket rejected' }, 401);

    // Сначала сбой на актуальном переключении.
    ticketFactories.push(fail);
    await usePlayerStore.getState().playTrack(track('A'), [track('A')]);
    assert.equal(usePlayerStore.getState().status, 'error');

    // Затем сбой опоздавшего запроса поверх успешного B.
    usePlayerStore.setState({ status: 'playing' });
    let releaseSlow!: (response: Response) => void;
    ticketFactories.push(
      () => new Promise<Response>((resolve) => { releaseSlow = resolve; }),
    );
    const stale = usePlayerStore.getState().playTrack(track('C'), [track('C')]);
    const fresh = usePlayerStore.getState().playTrack(track('B'), [track('B')]);
    releaseSlow(fail());
    await Promise.all([stale, fresh]);
    await settle();
    audioInstance.fire('play');

    assert.equal(usePlayerStore.getState().status, 'playing');
    assert.equal(usePlayerStore.getState().currentTrack?.id, 'B');
    assert.deepEqual(streamSrcLog().map((src) => src.split('?')[0]), ['/api/stream/B']);
  });

  it('4. togglePlay во время ожидания тикета не ставит error', async () => {
    usePlayerStore.setState({ currentTrack: track('A'), queue: [track('A')], status: 'playing' });

    ticketFactories.push(
      () => new Promise<Response>(() => {}), // билет не приходит
    );

    void usePlayerStore.getState().playTrack(track('B'), [track('B')]);
    usePlayerStore.getState().togglePlay();
    await settle();

    assert.equal(usePlayerStore.getState().status, 'loading');
  });
});
