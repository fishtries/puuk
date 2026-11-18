import { createDownloadScheduler } from '../scheduler';

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const owner = { origin: 'https://puuk.test', userId: '1' };
const activation = { owner, activationId: 'first-login', generation: 1 };
const wifi = { connected: true, type: 'WIFI', allowCellular: false };

function setup({ initialTransfers = [], policy = wifi } = {}) {
  let session = activation;
  let network = policy;
  let time = 100;
  let serial = 0;
  let transfers = [...initialTransfers];
  const rows = new Map();
  const onState = jest.fn();
  const index = {
    getOfflineSession: () => session,
    isOfflineSessionCurrent: value => value === session,
    queueDownload: jest.fn(async (_, trackId) => {
      const jobId = `job-${trackId}`;
      if (!rows.has(jobId)) rows.set(jobId, { jobId, trackId, state: 'queued' });
      return { jobId };
    }),
    listDownloadJobs: jest.fn(async () => [...rows.values()]),
    saveDownloadSchedule: jest.fn(async (_, job) => rows.set(job.jobId, { ...rows.get(job.jobId), ...job })),
    reserveTransfer: jest.fn(async (_, jobId) => {
      const operationId = `op-${++serial}`;
      rows.set(jobId, { ...rows.get(jobId), operationId });
      const stagingPath = `staging/${operationId}.part`;
      return { jobId, operationId, stagingPath, stagingUri: `file:///root/${stagingPath}` };
    }),
    attachNativeTask: jest.fn(async () => true),
    publishVerifiedDownload: jest.fn(async (_, { receipt }) => ({
      owner: session.owner, trackId: 'track', contentVersion: receipt.sha256,
    })),
    reconcileTransfers: jest.fn(async () => {}),
    resetTransfer: jest.fn(async (_, jobId, operationId) => {
      if (rows.get(jobId)?.operationId !== operationId) return false;
      rows.set(jobId, { ...rows.get(jobId), operationId: null });
      return true;
    }),
  };
  const transport = {
    start: jest.fn(async request => {
      const ref = { nativeSessionId: request.allowCellular ? 'cellular' : 'wifi', nativeTaskId: serial };
      transfers.push({ ...request, ...ref });
      return ref;
    }),
    snapshot: jest.fn(async () => [...transfers]),
    discard: jest.fn(async operationId => { transfers = transfers.filter(task => task.operationId !== operationId); }),
  };
  const ticket = (trackId, contentVersion = OLD) => ({
    trackId, contentVersion, contentLength: 120,
    uri: 'https://puuk.test/api/stream/audio?mt=signed',
    delivery: 'direct', downloadBinding: 'if-match', usableUntil: time + 1000,
    session: { ...session?.owner, generation: session?.generation },
  });
  const resolve = jest.fn(async trackId => ticket(trackId));
  const dependencies = {
    index, transport, resolveTicket: resolve, getNetworkPolicy: () => network,
    now: () => time, ticketNow: () => time, onState,
  };
  return {
    index, transport, resolve, ticket, dependencies, onState, rows,
    setSession: value => { session = value; },
    setNetwork: value => { network = value; },
    advance: ms => { time += ms; },
    complete: (data = {}) => {
      const task = transfers[0];
      transfers[0] = {
        ...task, receipt: { status: 200, bytes: 120, sha256: task.contentVersion, stagingPath: task.stagingPath, ...data },
      };
    },
  };
}

async function enqueue(scheduler, track = 'track') {
  await scheduler.enqueue(activation, track, 'manual');
  await scheduler.wake();
}

test('recovers a completed transfer across JS restart using activation and original operation identity', async () => {
  const f = setup();
  let scheduler = createDownloadScheduler(f.dependencies);
  await enqueue(scheduler);
  expect(f.index.reserveTransfer.mock.calls[0][2]).not.toHaveProperty('uri');
  expect(f.transport.start.mock.calls[0][0]).toMatchObject({
    ...owner, trackId: 'track', jobId: 'job-track', operationId: 'op-1',
    activationId: activation.activationId, generation: 1, allowCellular: false,
    ifMatch: `"sha256-${OLD}"`,
  });
  f.complete();
  scheduler.stop();
  const session = { ...activation, generation: 12 };
  f.setSession(session);
  scheduler = createDownloadScheduler(f.dependencies);
  await scheduler.wake();
  expect(f.index.publishVerifiedDownload).toHaveBeenCalledWith(session, {
    jobId: 'job-track', operationId: 'op-1',
    receipt: { status: 200, bytes: 120, sha256: OLD, stagingPath: 'staging/op-1.part' },
  });
  expect(f.transport.discard).toHaveBeenCalledWith('op-1');
  expect(f.transport.start).toHaveBeenCalledTimes(1);
  scheduler.stop();
});

test.each([
  { ...activation, owner: { ...owner, userId: '2' } },
  { ...activation, owner: { ...owner, origin: 'https://other.test' } },
  { ...activation, activationId: 'new-login' },
])('discards a late completion from another owner or login (%j)', async next => {
  const f = setup();
  const scheduler = createDownloadScheduler(f.dependencies);
  await enqueue(scheduler);
  f.complete();
  f.setSession(next);
  await scheduler.sessionChanged();
  expect(f.transport.discard).toHaveBeenCalledWith('op-1');
  expect(f.index.publishVerifiedDownload).not.toHaveBeenCalled();
  scheduler.stop();
});

test('discards a late receipt after explicit logout and checks no ticket before restore', async () => {
  const f = setup();
  const scheduler = createDownloadScheduler(f.dependencies);
  await enqueue(scheduler);
  f.complete();
  f.setSession(null);
  await scheduler.wake();
  expect(f.transport.discard).not.toHaveBeenCalled();
  await scheduler.sessionChanged();
  expect(f.transport.discard).toHaveBeenCalledWith('op-1');
  expect(f.index.publishVerifiedDownload).not.toHaveBeenCalled();
  scheduler.stop();
});

test('waits on cellular, applies Wi-Fi-only to the system request and restarts after tightening policy', async () => {
  const f = setup({ policy: { ...wifi, type: 'CELLULAR' } });
  const scheduler = createDownloadScheduler(f.dependencies);
  await enqueue(scheduler);
  expect(f.resolve).not.toHaveBeenCalled();
  f.setNetwork({ ...wifi, type: 'CELLULAR', allowCellular: true });
  await scheduler.wake();
  expect(f.transport.start.mock.calls[0][0]).toMatchObject({ allowCellular: true });
  f.setNetwork({ ...wifi, type: 'CELLULAR' });
  await scheduler.wake();
  expect(f.transport.discard).toHaveBeenCalledWith('op-1');
  expect(f.transport.start).toHaveBeenCalledTimes(1);
  f.setNetwork(wifi);
  await scheduler.wake();
  expect(f.transport.start.mock.calls[1][0]).toMatchObject({ allowCellular: false, operationId: 'op-2' });
  scheduler.stop();
});

test('waits to verify while offline and replaces a superseded version with a fresh operation', async () => {
  const f = setup();
  const scheduler = createDownloadScheduler(f.dependencies);
  await enqueue(scheduler);
  f.complete();
  f.setNetwork({ ...wifi, connected: false });
  await scheduler.wake();
  expect(f.index.publishVerifiedDownload).not.toHaveBeenCalled();
  expect(f.transport.discard).not.toHaveBeenCalled();
  f.resolve.mockImplementation(async trackId => f.ticket(trackId, NEW));
  f.setNetwork(wifi);
  await scheduler.wake();
  expect(f.transport.discard).toHaveBeenCalledWith('op-1');
  expect(f.index.publishVerifiedDownload).not.toHaveBeenCalled();
  f.advance(5000);
  await scheduler.wake();
  expect(f.transport.start.mock.calls[1][0]).toMatchObject({
    jobId: 'job-track', operationId: 'op-2', contentVersion: NEW,
  });
  scheduler.stop();
});

test('refreshes an expired ticket and limits retries for expired URLs', async () => {
  const f = setup();
  f.resolve.mockResolvedValueOnce({ ...f.ticket('track'), usableUntil: 90 });
  const scheduler = createDownloadScheduler(f.dependencies);
  await enqueue(scheduler);
  expect(f.resolve).toHaveBeenCalledTimes(2);
  for (const delay of [5000, 30000, 120000, 120000]) {
    f.complete({ status: 403, failure: 'http' });
    await scheduler.wake();
    f.advance(delay);
    await scheduler.wake();
  }
  expect(f.transport.start.mock.calls.map(([request]) => request.operationId)).toEqual(['op-1', 'op-2', 'op-3', 'op-4']);
  expect(f.onState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'failed' }));
  scheduler.stop();
});

test('rate limits concurrent transfers, waits for disk space and preserves the existing job id', async () => {
  const f = setup();
  f.index.reserveTransfer.mockResolvedValueOnce(null);
  const scheduler = createDownloadScheduler({ ...f.dependencies, parallelism: 1 });
  await enqueue(scheduler);
  expect(f.onState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'space' }));
  f.advance(30000);
  await scheduler.wake();
  await enqueue(scheduler, 'second');
  expect(f.transport.start).toHaveBeenCalledTimes(1);
  f.complete();
  await scheduler.wake();
  expect(f.transport.start.mock.calls.map(([request]) => request.jobId)).toEqual(['job-track', 'job-second']);
  scheduler.stop();
});

test('ignores partial and hash-mismatched system completions', async () => {
  const f = setup();
  const scheduler = createDownloadScheduler(f.dependencies);
  await enqueue(scheduler);
  f.complete({ status: 206, bytes: 21, sha256: NEW });
  await scheduler.wake();
  expect(f.index.publishVerifiedDownload).not.toHaveBeenCalled();
  expect(f.transport.discard).toHaveBeenCalledWith('op-1');
  scheduler.stop();
});

test('rehydrates untouched queued jobs and keeps a failed attempt in backoff across process restart', async () => {
  const f = setup({ policy: { ...wifi, connected: false } });
  let scheduler = createDownloadScheduler(f.dependencies);
  await enqueue(scheduler);
  const jobId = 'job-track';
  expect(f.transport.start).not.toHaveBeenCalled();
  scheduler.stop();
  f.setNetwork(wifi);
  scheduler = createDownloadScheduler(f.dependencies);
  await scheduler.wake();
  f.complete({ status: 503, failure: 'http' });
  await scheduler.wake();
  expect(f.rows.get(jobId)).toMatchObject({ attempt: 1, nextAttemptAt: 5100, handledOperation: 'op-1' });
  scheduler.stop();
  scheduler = createDownloadScheduler(f.dependencies);
  await scheduler.wake();
  expect(f.transport.start).toHaveBeenCalledTimes(1);
  f.advance(5000);
  await scheduler.wake();
  expect(f.transport.start.mock.calls[1][0]).toMatchObject({ jobId, operationId: 'op-2' });
  scheduler.stop();
});

test('reattaches an existing in-flight system task without starting another request', async () => {
  const f = setup();
  let scheduler = createDownloadScheduler(f.dependencies);
  await enqueue(scheduler);
  scheduler.stop();
  f.index.attachNativeTask.mockClear();
  f.setSession({ ...activation, generation: 2 });
  scheduler = createDownloadScheduler(f.dependencies);
  await scheduler.wake();
  expect(f.index.attachNativeTask).toHaveBeenCalledWith(
    expect.objectContaining({ generation: 2 }), 'job-track', 'op-1',
    expect.objectContaining({ nativeTaskId: 1, nativeSessionId: 'wifi' }),
  );
  expect(f.transport.start).toHaveBeenCalledTimes(1);
  scheduler.stop();
});

test('keeps the existing Wi-Fi-only task when Wi-Fi disappears and comes back', async () => {
  const f = setup();
  const scheduler = createDownloadScheduler(f.dependencies);
  await enqueue(scheduler);
  f.setNetwork({ ...wifi, type: 'CELLULAR' });
  await scheduler.wake();
  expect(f.onState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'network' }));
  expect(f.transport.discard).not.toHaveBeenCalled();
  f.setNetwork(wifi);
  await scheduler.wake();
  expect(f.onState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'transferring' }));
  expect(f.transport.start).toHaveBeenCalledTimes(1);
  scheduler.stop();
});

test('durably cancels one job, discards its late receipt after restart and can enqueue it again', async () => {
  const f = setup();
  let scheduler = createDownloadScheduler(f.dependencies);
  await enqueue(scheduler);
  await enqueue(scheduler, 'second');
  f.complete();
  f.transport.discard.mockRejectedValueOnce(new Error('temporary native failure'));
  expect(await scheduler.cancel(activation, 'job-track')).toBe(true);
  await scheduler.wake();
  expect(f.rows.get('job-track').state).toBe('cancelled');
  scheduler.stop();

  scheduler = createDownloadScheduler(f.dependencies);
  await scheduler.wake();
  expect(f.index.publishVerifiedDownload).not.toHaveBeenCalled();
  expect(f.transport.discard).toHaveBeenCalledWith('op-1');
  expect(f.transport.discard).not.toHaveBeenCalledWith('op-2');
  expect(f.rows.get('job-second').state).toBe('transferring');
  await enqueue(scheduler);
  expect(f.transport.start).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: 'job-track', operationId: 'op-3' }));
  scheduler.stop();
});

test('uses the durable handled operation when native receipt cleanup fails', async () => {
  const f = setup();
  let scheduler = createDownloadScheduler(f.dependencies);
  await enqueue(scheduler);
  f.complete({ status: 503, failure: 'http' });
  f.transport.discard.mockRejectedValueOnce(new Error('temporary native failure'));
  await scheduler.wake();
  expect(f.rows.get('job-track')).toMatchObject({ attempt: 1, handledOperation: 'op-1' });
  scheduler.stop();
  scheduler = createDownloadScheduler(f.dependencies);
  await scheduler.wake();
  expect(f.rows.get('job-track')).toMatchObject({ attempt: 1, nextAttemptAt: 5100, handledOperation: 'op-1' });
  expect(f.transport.discard).toHaveBeenLastCalledWith('op-1');
  scheduler.stop();
});

test('rejects the reserved foreground reason and ignores a superseded native operation', async () => {
  const f = setup();
  const scheduler = createDownloadScheduler(f.dependencies);
  expect(await scheduler.enqueue(activation, 'track', 'foreground-favorites')).toBeNull();
  expect(f.index.queueDownload).not.toHaveBeenCalled();
  await enqueue(scheduler);
  f.complete();
  f.rows.set('job-track', { ...f.rows.get('job-track'), operationId: 'new-op', state: 'failed' });
  await scheduler.wake();
  expect(f.index.publishVerifiedDownload).not.toHaveBeenCalled();
  expect(f.transport.discard).toHaveBeenCalledWith('op-1');
  scheduler.stop();
});

test('leaves a newly registered native transfer for recovery when JS tears down', async () => {
  const f = setup();
  const scheduler = createDownloadScheduler(f.dependencies);
  const start = f.transport.start.getMockImplementation();
  f.transport.start.mockImplementationOnce(async request => {
    const ref = await start(request);
    scheduler.stop();
    return ref;
  });
  await enqueue(scheduler);
  expect(f.transport.discard).not.toHaveBeenCalled();
  expect(f.index.attachNativeTask).not.toHaveBeenCalled();
  const restored = createDownloadScheduler(f.dependencies);
  await restored.wake();
  expect(f.index.attachNativeTask).toHaveBeenCalledTimes(1);
  expect(f.transport.start).toHaveBeenCalledTimes(1);
  restored.stop();
});

test('reconsiders space-paused downloads immediately when the user raises the limit', async () => {
  const f = setup();
  const reserve = f.index.reserveTransfer.getMockImplementation();
  f.index.reserveTransfer.mockResolvedValueOnce(null);
  const scheduler = createDownloadScheduler(f.dependencies);
  try {
    await enqueue(scheduler);
    expect(f.rows.get('job-track').state).toBe('space');
    expect(f.transport.start).not.toHaveBeenCalled();
    f.index.reserveTransfer.mockImplementation(reserve);
    await scheduler.reconsiderSpace();
    await scheduler.wake();
    expect(f.transport.start).toHaveBeenCalledTimes(1);
    expect(f.rows.get('job-track').state).toBe('transferring');
  } finally { scheduler.stop(); }
});

test('publishes a hashed ordinary-cache copy without starting another transport', async () => {
  const f = setup();
  const receipt = { status: 200, bytes: 120, sha256: OLD, stagingPath: 'staging/op-1.part' };
  const promotion = { stage: jest.fn(async () => receipt), release: jest.fn() };
  const scheduler = createDownloadScheduler({ ...f.dependencies, promoteCache: () => promotion });
  try {
    await enqueue(scheduler);
    expect(f.resolve).toHaveBeenCalledTimes(2);
    expect(f.index.publishVerifiedDownload).toHaveBeenCalledWith(activation, expect.objectContaining({ receipt }));
    expect(f.transport.start).not.toHaveBeenCalled();
    expect(f.rows.get('job-track').state).toBe('ready');
    expect(promotion.release).toHaveBeenCalledTimes(1);
  } finally { scheduler.stop(); }
});

test('releases a pinned copy before ordinary eviction and native admission when promotion would exceed the budget', async () => {
  const f = setup();
  const promotion = { stage: jest.fn(), release: jest.fn() };
  const reserve = f.index.reserveTransfer.getMockImplementation();
  f.index.reserveTransfer.mockImplementation((session, job, descriptor, options) => {
    if (options?.localCopy) return Promise.resolve(null);
    expect(promotion.release).toHaveBeenCalledTimes(1);
    return reserve(session, job, descriptor);
  });
  const scheduler = createDownloadScheduler({ ...f.dependencies, promoteCache: () => promotion });
  try {
    await enqueue(scheduler);
    expect(promotion.stage).not.toHaveBeenCalled();
    expect(f.transport.start).toHaveBeenCalledTimes(1);
  } finally { scheduler.stop(); }
});
