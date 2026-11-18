import {
  createOfflineOutbox,
  createOutboxTransport,
  createSQLiteOutboxStorage,
} from '..';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
const { mkdtempSync, rmSync } = process.getBuiltinModule('node:fs');
const { tmpdir } = process.getBuiltinModule('node:os');
const { join } = process.getBuiltinModule('node:path');

const alice = {
  owner: { origin: 'https://one.test', userId: 1 },
  activationId: 'a',
  generation: 1,
};
const bob = {
  owner: { origin: 'https://one.test', userId: 2 },
  activationId: 'b',
  generation: 2,
};
const aliceAgain = { ...alice, activationId: 'a2', generation: 3 };
const otherOrigin = {
  owner: { ...alice.owner, origin: 'https://two.test' },
  activationId: 'c',
  generation: 4,
};
const play = {
  trackId: 'track',
  playbackId: 'play-1',
  occurredAt: '2020-01-01T01:02:03.456Z',
  context: 'wave',
};
const outcome = {
  ...play,
  outcome: 'finish',
  listenDurationMs: 2000,
  trackDurationMs: 2000,
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function response(status, data, retryAfter = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => data,
    headers: { get: () => retryAfter },
  };
}

let db;
let tempDir;
let active;
let now;
let createId;
let authFetch;

function instance() {
  const transaction = async (session, action) => {
    if (session !== active) throw new Error('Inactive session');
    const sql = {
      runSync: (statement, ...args) => db.prepare(statement).run(...args),
      getFirstSync: (statement, ...args) => db.prepare(statement).get(...args),
    };
    db.exec('BEGIN');
    try {
      const value = action(sql);
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  return createOfflineOutbox({
    storage: createSQLiteOutboxStorage({ transaction }),
    send: createOutboxTransport({ authFetch, timeoutMs: 100 }),
    isSessionCurrent: (session) => session === active,
    createId,
    now: () => now,
    random: () => 0,
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'puuk-outbox-'));
  db = new DatabaseSync(join(tempDir, 'index.sqlite'));
  active = alice;
  now = 100000;
  let id = 0;
  createId = () => `local-${++id}`;
  authFetch = jest.fn(async (url, { body }) => {
    const track_id = decodeURIComponent(
      url.match(/\/tracks\/([^/]+)/)?.[1] ?? body.track_id,
    );
    if (url.endsWith('/rating'))
      return response(200, { status: 'ok', track_id, applied: true, ...body });
    return response(200, {
      status: url.endsWith('/history') ? 'logged' : 'ok',
      track_id,
      playback_id: body.playback_id,
    });
  });
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test('commits the latest offline rating together with its intent and survives a database reopen', async () => {
  const outbox = instance();
  await expect(outbox.setRating(alice, 'track', 'like')).resolves.toMatchObject(
    {
      rating: 'like',
      revision: 1,
      state: 'pending',
    },
  );
  await outbox.setRating(alice, 'track', 'neutral');
  db.close();
  db = new DatabaseSync(join(tempDir, 'index.sqlite'));
  const restarted = instance();
  await expect(restarted.getRating(alice, 'track')).resolves.toMatchObject({
    rating: 'neutral',
    revision: 2,
    state: 'pending',
  });
  await expect(restarted.drain(alice)).resolves.toMatchObject({
    state: 'drained',
  });
  expect(authFetch).toHaveBeenCalledTimes(1);
  expect(authFetch.mock.calls[0]).toEqual([
    'https://one.test/api/tracks/track/rating',
    expect.objectContaining({
      method: 'PUT',
      retry: 0,
      body: { rating: 'neutral', operation_id: 'local-2' },
    }),
  ]);
  expect(await restarted.getRating(alice, 'track')).toMatchObject({
    state: 'synced',
    revision: 2,
  });
});

test('replays a claimed rating exactly before the next one and a stale ack keeps the newer revision', async () => {
  const lost = deferred();
  const firstStarted = deferred();
  const last = deferred();
  const lastStarted = deferred();
  authFetch.mockImplementationOnce(() => {
    firstStarted.resolve();
    return lost.promise;
  });
  const outbox = instance();
  await outbox.setRating(alice, 'track', 'like');
  const first = outbox.drain(alice);
  await firstStarted.promise;
  await outbox.setRating(alice, 'track', 'dislike');
  lost.resolve(response(503));
  const { nextDueAt } = await first;
  expect(authFetch).toHaveBeenCalledTimes(1);
  expect(nextDueAt).toBe(now + 500);
  now = nextDueAt;
  const normal = authFetch.getMockImplementation();
  authFetch.mockImplementationOnce(normal).mockImplementationOnce(() => {
    lastStarted.resolve();
    return last.promise;
  });
  const restarted = instance();
  const delivery = restarted.drain(alice);
  await lastStarted.promise;
  expect(authFetch.mock.calls[1][1].body).toEqual(
    authFetch.mock.calls[0][1].body,
  );
  expect(authFetch.mock.calls[2][1].body.rating).toBe('dislike');
  expect(await restarted.getRating(alice, 'track')).toMatchObject({
    state: 'pending',
    rating: 'dislike',
    revision: 2,
  });
  last.resolve(await normal(...authFetch.mock.calls[2]));
  await expect(delivery).resolves.toMatchObject({ state: 'drained' });
});

test('rolls back the projection when the intent cannot be inserted', async () => {
  const outbox = instance();
  await outbox.setRating(alice, 'track', 'like');
  db.exec(`CREATE TRIGGER outbox_test_failure BEFORE INSERT ON outbox_entry
    BEGIN SELECT raise(ABORT, 'simulated disk error'); END`);
  await expect(outbox.setRating(alice, 'track', 'neutral')).rejects.toThrow(
    'simulated disk error',
  );
  expect(await outbox.getRating(alice, 'track')).toMatchObject({
    rating: 'like',
    revision: 1,
  });
  db.exec('DROP TRIGGER outbox_test_failure');
  await outbox.drain(alice);
  expect(authFetch.mock.calls[0][1].body.rating).toBe('like');
});

test('keeps immutable playback payloads and original occurrence across response loss and restart', async () => {
  const outbox = instance();
  await outbox.recordStarted(alice, play);
  await expect(outbox.recordStarted(alice, play)).resolves.toBe(false);
  await expect(
    outbox.recordStarted(alice, { ...play, trackId: 'other' }),
  ).rejects.toThrow('Conflicting');
  await outbox.recordOutcome(alice, outcome);
  authFetch.mockRejectedValueOnce(new Error('response lost'));
  const first = await outbox.drain(alice);
  expect(first.state).toBe('pending');
  expect(authFetch.mock.calls[1][1].body).toEqual({
    playback_id: 'play-1',
    track_id: 'track',
    event_id: 'play-1',
    occurred_at: play.occurredAt,
    context: 'wave',
    event_type: 'finish',
    listen_duration_ms: 2000,
    track_duration_ms: 2000,
    client: 'ios',
  });
  now = first.nextDueAt;
  await expect(instance().drain(alice)).resolves.toMatchObject({
    state: 'drained',
  });
  expect(authFetch.mock.calls[2][1].body).toEqual(
    authFetch.mock.calls[0][1].body,
  );
  expect(() =>
    outbox.recordOutcome(alice, { ...outcome, listenDurationMs: 0 }),
  ).toThrow('Invalid');
});

test('honors Retry-After for feedback only and drains past a deleted track', async () => {
  const outbox = instance();
  await outbox.recordOutcome(alice, outcome);
  await outbox.recordOutcome(alice, { ...outcome, playbackId: 'play-2' });
  await outbox.setRating(alice, 'deleted', 'dislike');
  await outbox.setRating(alice, 'other', 'like');
  authFetch
    .mockResolvedValueOnce(response(429, null, '90'))
    .mockResolvedValueOnce(response(404, { detail: 'Трек не найден' }));
  const report = await outbox.drain(alice);
  expect(report.nextDueAt).toBe(now + 90000);
  expect(report.settled.map((e) => e.state)).toEqual(['missing', 'synced']);
  expect(await outbox.getRating(alice, 'deleted')).toMatchObject({
    state: 'missing',
  });
  expect(authFetch).toHaveBeenCalledTimes(3);
  now = report.nextDueAt - 1;
  await instance().drain(alice);
  expect(authFetch).toHaveBeenCalledTimes(3);
  now++;
  await expect(instance().drain(alice)).resolves.toMatchObject({
    state: 'drained',
  });
  expect(authFetch).toHaveBeenCalledTimes(5);
});

test('stops on 401 and resumes only after a new activation of the same owner', async () => {
  const outbox = instance();
  await outbox.setRating(alice, 'track', 'like');
  authFetch.mockResolvedValueOnce(response(401));
  await expect(outbox.drain(alice)).resolves.toMatchObject({
    state: 'unauthorized',
  });
  await outbox.drain(alice);
  active = bob;
  await expect(outbox.drain(bob)).resolves.toMatchObject({ state: 'drained' });
  expect(await outbox.getRating(bob, 'track')).toBeNull();
  active = otherOrigin;
  await expect(outbox.drain(otherOrigin)).resolves.toMatchObject({
    state: 'drained',
  });
  active = aliceAgain;
  await expect(outbox.drain(aliceAgain)).resolves.toMatchObject({
    state: 'drained',
  });
  expect(authFetch).toHaveBeenCalledTimes(2);
  expect(authFetch.mock.calls[1][1].body).toEqual(
    authFetch.mock.calls[0][1].body,
  );
});

test('an in-flight owner switch aborts the request and fences late completion', async () => {
  const started = deferred();
  const late = deferred();
  authFetch.mockImplementationOnce((url, options) => {
    started.resolve(options.signal);
    return late.promise;
  });
  const outbox = instance();
  await outbox.setRating(alice, 'track', 'like');
  const oldDrain = outbox.drain(alice);
  const signal = await started.promise;
  active = bob;
  outbox.cancelDrain(alice);
  expect(signal.aborted).toBe(true);
  await expect(outbox.setRating(alice, 'track', 'neutral')).rejects.toThrow(
    'session changed',
  );
  await outbox.setRating(bob, 'track', 'dislike');
  await outbox.drain(bob);
  late.resolve(
    response(200, {
      status: 'ok',
      track_id: 'track',
      rating: 'like',
      operation_id: 'local-1',
      applied: true,
    }),
  );
  await expect(oldDrain).resolves.toMatchObject({
    state: 'paused',
    settled: [],
  });
  expect(await outbox.getRating(bob, 'track')).toMatchObject({
    state: 'synced',
    rating: 'dislike',
  });
  active = aliceAgain;
  expect(await outbox.getRating(aliceAgain, 'track')).toMatchObject({
    state: 'pending',
    rating: 'like',
  });
});

test('does not acknowledge an old-server response or hang on a lost response body', async () => {
  const outbox = instance();
  await outbox.recordStarted(alice, play);
  authFetch.mockResolvedValueOnce(
    response(200, { status: 'logged', track_id: 'track' }),
  );
  const first = await outbox.drain(alice);
  expect(first.state).toBe('pending');
  now = first.nextDueAt;
  authFetch.mockResolvedValueOnce({
    status: 200,
    ok: true,
    json: () => new Promise(() => {}),
  });
  const second = await outbox.drain(alice);
  expect(second).toMatchObject({
    state: 'pending',
    nextDueAt: now + 1000,
    settled: [],
  });
  expect(authFetch.mock.calls[1][1].signal.aborted).toBe(true);
});

test('keeps a modern request across an old-server 405 and isolates a terminal conflict', async () => {
  const outbox = instance();
  await outbox.recordStarted(alice, play);
  await outbox.recordOutcome(alice, outcome);
  await outbox.setRating(alice, 'other', 'like');
  authFetch
    .mockResolvedValueOnce(response(405))
    .mockResolvedValueOnce(response(409));
  const report = await outbox.drain(alice);
  expect(authFetch.mock.calls.map(([, options]) => options.method)).toEqual([
    'PUT',
    'PUT',
    'PUT',
  ]);
  expect(report.settled.map(({ kind, state }) => [kind, state])).toEqual([
    ['feedback', 'failed'],
    ['rating', 'synced'],
  ]);
  expect(report.state).toBe('pending');
  now = report.nextDueAt;
  expect((await outbox.drain(alice)).state).toBe('drained');
  expect(authFetch.mock.calls[3][1].body).toEqual(
    authFetch.mock.calls[0][1].body,
  );
});
