import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { Track } from '../../types/track.ts';

// Same bootstrap as usePlayerStore.wave.test.ts: the store graph is written for
// a bundler (extensionless relative imports), and type-only modules need
// linkable runtime shims because type stripping erases their declarations.
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
  preload = 'metadata';
  crossOrigin = '';
  paused = true;
  currentTime = 0;
  duration = NaN;
  volume = 1;
  error: { message: string } | null = null;
  private srcValue = '';
  get src(): string {
    return this.srcValue;
  }
  set src(value: string) {
    this.srcValue = value;
  }
  addEventListener(): void {}
  load(): void {}
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {}
}

globalThis.Audio = function (): HTMLAudioElement {
  return new FakeAudioElement() as unknown as HTMLAudioElement;
} as unknown as typeof Audio;

globalThis.localStorage = {
  getItem: () => 'test-token',
  setItem: () => {},
  removeItem: () => {},
} as unknown as Storage;

globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;

const { usePlayerStore } = await import('../usePlayerStore.ts');

const track = (id: string): Track => ({ id, title: `Title ${id}`, artist: `Artist ${id}`, duration: 180 });

function seed(currentTrackId: string, queueIds: string[], currentIndex?: number): void {
  const index = currentIndex ?? queueIds.indexOf(currentTrackId);
  usePlayerStore.setState({
    currentTrack: track(currentTrackId),
    queue: queueIds.map(track),
    currentTrackIndex: index,
  });
}

describe('purgeTrackFromQueue', () => {
  beforeEach(() => {
    usePlayerStore.setState({
      currentTrack: null,
      queue: [],
      currentTrackIndex: -1,
    });
  });

  it('удаляет будущие вхождения, оставляя игрующий трек и очередь до него', () => {
    seed('a', ['a', 'b', 'c', 'b']);
    usePlayerStore.getState().purgeTrackFromQueue('b');
    const { queue, currentTrackIndex } = usePlayerStore.getState();
    assert.deepEqual(queue.map((t) => t.id), ['a', 'c']);
    assert.equal(currentTrackIndex, 0);
  });

  it('сохраняет играющий дубликат и корректирует индекс при удалении до него', () => {
    seed('b', ['b', 'x', 'b'], 2);
    usePlayerStore.getState().purgeTrackFromQueue('b');
    const { queue, currentTrackIndex } = usePlayerStore.getState();
    assert.deepEqual(queue.map((t) => t.id), ['x', 'b']);
    assert.equal(currentTrackIndex, 1);
    assert.equal(usePlayerStore.getState().currentTrack?.id, 'b');
  });

  it('сдвигает индекс, когда удалённые вхождения стояли перед играющим треком', () => {
    seed('c', ['a', 'x', 'c', 'a', 'd'], 2);
    usePlayerStore.getState().purgeTrackFromQueue('a');
    const { queue, currentTrackIndex } = usePlayerStore.getState();
    assert.deepEqual(queue.map((t) => t.id), ['x', 'c', 'd']);
    assert.equal(currentTrackIndex, 1);
  });

  it('ничего не меняет, если трека нет в очереди', () => {
    seed('a', ['a', 'b']);
    usePlayerStore.getState().purgeTrackFromQueue('zzz');
    const { queue, currentTrackIndex } = usePlayerStore.getState();
    assert.deepEqual(queue.map((t) => t.id), ['a', 'b']);
    assert.equal(currentTrackIndex, 0);
  });
});
