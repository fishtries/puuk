import { getTrackId } from '../../shared/domain/trackAdapter';

const HASH = /^[0-9a-f]{64}$/;
const MAX_BYTES = 500 * 1024 * 1024;
const RETRY_DELAY = [5_000, 30_000, 120_000];
const WAIT_FOR_SPACE = 30_000;
const VERIFY_DELAY = 30_000;
const sameOwner = (a, b) => a?.origin === b?.origin && a?.userId === b?.userId;
const belongsTo = (transfer, session) => transfer.activationId === session.activationId &&
  sameOwner(transfer, session.owner);
const isIdle = job => ['ready', 'failed', 'cancelled'].includes(job.state);

function validTicket(ticket, trackId, session) {
  return ticket && ticket.trackId === trackId && ticket.session?.generation === session.generation &&
    sameOwner(ticket.session, session.owner) && HASH.test(ticket.contentVersion) &&
    Number.isSafeInteger(ticket.contentLength) && ticket.contentLength > 0 && ticket.contentLength <= MAX_BYTES &&
    ((ticket.delivery === 'direct' && ticket.downloadBinding === 'if-match') ||
      (ticket.delivery === 'cdn' && ticket.downloadBinding === 'immutable-path'));
}

function failureKind(failure, status) {
  if (failure === 'space') return 'space';
  if (status === 412 || status === 409) return 'version';
  if ([401, 403, 408, 425, 429].includes(status) || status >= 500) return 'retry';
  if (failure === 'integrity' || (status >= 400 && status < 500)) return 'terminal';
  return 'retry';
}

/**
 * The index owns reservations and publication. The caller supplies live session and
 * network policy getters, and wakes the scheduler when either changes.
 */
export function createDownloadScheduler({
  index, transport, resolveTicket, getNetworkPolicy, onState = () => {},
  onTransferSnapshot = () => {}, orderJobs = async (_session, jobs) => jobs,
  promoteCache,
  now = Date.now, ticketNow = () => performance.now(), parallelism = 2,
}) {
  const jobs = new Map();
  const attached = new Set();
  let timer;
  let dirty = false;
  let running;
  let stopped = false;
  let activeController;
  let clearOrphans = false;
  let unavailable = false;
  let mutations = Promise.resolve();
  let pendingMutations = 0;

  const current = session => !stopped && index.isOfflineSessionCurrent(session);
  const networkAllows = policy => policy?.connected === true &&
    (policy.allowCellular === true || policy.type === 'WIFI');
  const compatible = transfer => getNetworkPolicy()?.allowCellular === true || !transfer.allowCellular;

  function register(session, job) {
    const existing = jobs.get(job.jobId);
    const stored = {
      ...existing, ...job, track: job.track ?? existing?.track,
      ...session.owner, activationId: session.activationId,
      attempt: job.attempt ?? 0, nextAttemptAt: job.nextAttemptAt ?? 0,
      verifyAfter: existing?.operationId === job.operationId ? existing?.verifyAfter : undefined,
    };
    jobs.set(job.jobId, stored);
    return stored;
  }

  async function update(session, job, state, delay = 0) {
    if (!current(session)) return;
    const nextAttemptAt = now() + delay;
    const saved = await index.saveDownloadSchedule(session, {
      jobId: job.jobId, state, attempt: job.attempt, nextAttemptAt,
      handledOperation: job.handledOperation,
    });
    if (!saved || !current(session)) return false;
    Object.assign(job, { state, nextAttemptAt });
    onState({ jobId: job.jobId, trackId: job.trackId, state, nextAttemptAt });
    return true;
  }

  async function failed(session, job, kind) {
    if (kind === 'space') return update(session, job, 'space', WAIT_FOR_SPACE);
    if (kind === 'terminal' || job.attempt >= RETRY_DELAY.length) return update(session, job, 'failed');
    const delay = RETRY_DELAY[job.attempt];
    job.attempt += 1;
    return update(session, job, 'retry', delay);
  }

  async function freshTicket(session, trackId) {
    const ticket = await resolveTicket(trackId, { signal: activeController.signal });
    return validTicket(ticket, trackId, session) ? ticket : null;
  }

  async function start(session, job) {
    try {
      let ticket = await freshTicket(session, job.trackId);
      if (!current(session)) return;
      if (!ticket) return update(session, job, 'failed');
      if (ticketNow() >= ticket.usableUntil) ticket = await freshTicket(session, job.trackId);
      if (!current(session)) return;
      if (!ticket || ticketNow() >= ticket.usableUntil) return failed(session, job, 'retry');
      if (!networkAllows(getNetworkPolicy())) return update(session, job, 'network');

      const { contentVersion, contentLength } = ticket;
      const descriptor = { trackId: job.trackId, track: job.track, contentVersion, contentLength };
      const promotion = promoteCache?.(session, ticket, activeController.signal);
      let reservation;
      if (promotion) {
        try {
          reservation = await index.reserveTransfer(session, job.jobId, descriptor, { localCopy: true });
          if (reservation?.operationId) {
            const receipt = await promotion.stage(reservation);
            if (!current(session)) return;
            if (receipt) {
              const latest = await freshTicket(session, job.trackId);
              if (!current(session)) return;
              if (latest?.contentVersion !== contentVersion || latest?.contentLength !== contentLength) {
                await index.resetTransfer(session, job.jobId, reservation.operationId);
                return failed(session, job, 'version');
              }
              const published = await index.publishVerifiedDownload(session, { ...reservation, receipt });
              if (published) {
                promotion.commit?.();
                await update(session, job, 'ready');
                dirty = true;
                return;
              }
              await index.resetTransfer(session, job.jobId, reservation.operationId);
              return failed(session, job, 'retry');
            }
          }
        } finally { promotion.release(); }
      }
      if (!reservation && current(session))
        reservation = await index.reserveTransfer(session, job.jobId, descriptor);
      if (!current(session)) return;
      if (reservation?.mediaKey) return update(session, job, 'ready');
      if (reservation?.waitingForTransfer) return update(session, job, 'retry', 2_000);
      if (!reservation) return update(session, job, 'space', WAIT_FOR_SPACE);
      dirty = true;
      const policy = getNetworkPolicy();
      if (!networkAllows(policy) || ticketNow() >= ticket.usableUntil) {
        dirty = true;
        return networkAllows(policy) ? failed(session, job, 'retry') : update(session, job, 'network');
      }
      const ref = await transport.start({
        ...reservation, ...session.owner, activationId: session.activationId, generation: session.generation,
        trackId: job.trackId, contentVersion, contentLength, uri: ticket.uri,
        ifMatch: ticket.delivery === 'direct' ? `"sha256-${contentVersion}"` : undefined,
        allowCellular: policy.allowCellular === true,
      });
      dirty = true;
      if (!index.isOfflineSessionCurrent(session) || !compatible(policy)) {
        await transport.discard(reservation.operationId);
        return;
      }
      if (stopped) return;
      if (await index.attachNativeTask(session, job.jobId, reservation.operationId, ref)) {
        attached.add(reservation.operationId);
        await update(session, job, 'transferring');
      } else if (current(session)) {
        await transport.discard(reservation.operationId);
        await failed(session, job, 'retry');
      }
    } catch (error) {
      if (!current(session)) return;
      const kind = error?.terminal ? 'terminal' : failureKind(error?.code, error?.status);
      await failed(session, job, kind);
    }
  }

  async function run(session) {
    const saved = await index.listDownloadJobs(session);
    if (!current(session)) return;
    const known = new Set(saved.map(job => job.jobId));
    for (const jobId of jobs.keys()) if (!known.has(jobId)) jobs.delete(jobId);
    for (const job of saved) register(session, job);
    const transfers = await transport.snapshot();
    if (!current(session)) return;
    onTransferSnapshot(transfers);
    const tasks = [];
    const clean = [];
    const removedOperations = new Set();
    let occupied = 0;

    for (const transfer of transfers) {
      if (!current(session)) return;
      if (!belongsTo(transfer, session)) {
        await transport.discard(transfer.operationId);
        removedOperations.add(transfer.operationId);
        continue;
      }

      const { jobId, operationId, receipt } = transfer;
      const job = jobs.get(jobId);
      const identity = { jobId, operationId };
      if (!job || job.operationId !== operationId || job.state === 'ready' || job.state === 'cancelled') {
        clean.push(transfer);
        continue;
      }
      if (!receipt) {
        if (!compatible(transfer)) {
          await transport.discard(operationId);
          removedOperations.add(operationId);
          await update(session, job, 'network');
          continue;
        }
        if (!attached.has(operationId)) {
          const accepted = await index.attachNativeTask(session, jobId, operationId, transfer);
          if (!current(session)) return;
          if (!accepted) {
            await transport.discard(operationId);
            removedOperations.add(operationId);
            continue;
          }
          attached.add(operationId);
        }
        tasks.push(identity);
        occupied += 1;
        const state = networkAllows(getNetworkPolicy()) ? 'transferring' : 'network';
        if (job.state !== state) await update(session, job, state);
        continue;
      }
      if (receipt.failure || receipt.status !== 200 || receipt.bytes !== transfer.contentLength ||
          receipt.sha256 !== transfer.contentVersion || receipt.stagingPath !== transfer.stagingPath) {
        const kind = receipt.failure == null && receipt.status === 200
          ? 'terminal' : failureKind(receipt.failure, receipt.status);
        if (job.handledOperation !== operationId) {
          job.handledOperation = operationId;
          await failed(session, job, kind);
        }
        clean.push(transfer);
        continue;
      }

      if (networkAllows(getNetworkPolicy()) && !(job.verifyAfter > now())) {
        try {
          const ticket = await freshTicket(session, transfer.trackId);
          if (!current(session)) return;
          if (ticket && ticket.contentVersion === transfer.contentVersion &&
              ticket.contentLength === transfer.contentLength) {
            const published = await index.publishVerifiedDownload(session, { ...identity, receipt });
            if (!current(session)) return;
            if (published) {
              await update(session, job, 'ready');
              clean.push(transfer);
              continue;
            }
            // Publication may have lost its reservation to a newer operation.
            clean.push(transfer);
            await update(session, job, 'failed');
            continue;
          }
          if (ticket) {
            if (job.handledOperation !== operationId) {
              job.handledOperation = operationId;
              await failed(session, job, 'version');
            }
            clean.push(transfer);
            continue;
          }
        } catch (error) {
          if (!current(session)) return;
          if ([404, 410].includes(error?.status)) {
            await update(session, job, 'failed');
            clean.push(transfer);
            continue;
          }
        }
        job.verifyAfter = now() + VERIFY_DELAY;
      }
      tasks.push(identity);
      occupied += 1;
      await update(session, job, 'verifying');
    }

    if (!current(session)) return;
    for (const transfer of clean) {
      await transport.discard(transfer.operationId);
      removedOperations.add(transfer.operationId);
    }
    if (removedOperations.size && current(session))
      onTransferSnapshot(transfers.filter(transfer => !removedOperations.has(transfer.operationId)));
    await index.reapInactiveTransfers?.(session, tasks.map(task => task.operationId));
    if (!current(session)) return;
    await index.reconcileTransfers(session, { receipts: [], tasks, backgroundOnly: true });
    if (!current(session)) return;
    const liveOperations = new Set(tasks.map(task => task.operationId));
    for (const operationId of attached) if (!liveOperations.has(operationId)) attached.delete(operationId);
    const busy = new Set(tasks.map(task => task.jobId));
    if (saved.some(job => job.operationId && !busy.has(job.jobId) && !isIdle(job))) {
      // The index can finish its own journaled publication during reconciliation.
      for (const entry of await index.listDownloadJobs(session)) {
        if (entry.state === 'ready' && !busy.has(entry.jobId)) register(session, entry);
      }
    }
    const candidates = [...jobs.values()].filter(job => belongsTo(job, session) && !busy.has(job.jobId) && !isIdle(job));
    for (const job of await orderJobs(session, candidates, now())) {
      if (!current(session) || occupied >= parallelism) break;
      if (job.nextAttemptAt > now()) continue;
      if (!networkAllows(getNetworkPolicy())) {
        if (job.state !== 'network') await update(session, job, 'network');
        continue;
      }
      occupied += 1;
      await start(session, job);
    }
  }

  function armTimer(session) {
    if (!session || !current(session) || !networkAllows(getNetworkPolicy())) return;
    const time = now();
    const due = [...jobs.values()].filter(job => belongsTo(job, session) && !isIdle(job))
      .flatMap(job => [job.nextAttemptAt, job.verifyAfter]).filter(value => value > time);
    if (due.length) timer = setTimeout(() => { void wake(); }, Math.min(...due) - time);
  }

  function wake() {
    if (stopped) return Promise.resolve();
    dirty = true;
    if (running) return running;
    if (pendingMutations) return mutations;
    clearTimeout(timer);
    running = Promise.resolve().then(async () => {
      while (dirty && !stopped && !pendingMutations) {
        dirty = false;
        const session = index.getOfflineSession();
        activeController = new AbortController();
        try {
          if (session) {
            clearOrphans = false;
            await run(session);
          } else if (clearOrphans) {
            jobs.clear();
            attached.clear();
            for (const transfer of await transport.snapshot()) {
              if (stopped || index.getOfflineSession()) break;
              await transport.discard(transfer.operationId);
            }
            if (!stopped && !index.getOfflineSession()) {
              onTransferSnapshot([]);
              await index.reapInactiveTransfers?.(null, []);
            }
            clearOrphans = false;
          }
          if (!stopped && unavailable) {
            unavailable = false;
            onState({ state: 'available' });
          }
        } catch {
          if (!stopped && (current(session) || clearOrphans)) {
            unavailable = true;
            onState({ state: 'unavailable' });
            timer = setTimeout(() => { void wake(); }, RETRY_DELAY[0]);
            return;
          }
        }
      }
      armTimer(index.getOfflineSession());
    }).finally(() => { running = null; });
    return running;
  }

  function mutate(action) {
    pendingMutations += 1;
    const inFlight = running;
    const result = mutations.then(async () => {
      await inFlight;
      return action();
    }).finally(() => {
      pendingMutations -= 1;
      void wake();
    });
    mutations = result.catch(() => {});
    return result;
  }

  const subscription = transport.addListener?.(() => { void wake(); });
  return {
    enqueue: (session, track, reason) => mutate(async () => {
      const id = getTrackId(track);
      if (!current(session) || id === null || reason === 'foreground-favorites') return null;
      const trackId = String(id);
      const queued = await index.queueDownload(session, trackId, reason, track);
      if (!queued || !current(session)) return null;
      const saved = (await index.listDownloadJobs(session)).find(job => job.jobId === queued.jobId);
      if (!saved || !current(session)) return null;
      const job = register(session, saved);
      if (typeof track === 'object' && track) job.track = track;
      if (job.state === 'cancelled' && job.operationId) {
        await transport.discard(job.operationId);
        await index.resetTransfer(session, job.jobId, job.operationId);
      }
      if (['failed', 'cancelled'].includes(job.state)) {
        job.attempt = 0;
        if (!await update(session, job, 'queued')) return null;
      }
      return current(session) ? queued : null;
    }),
    cancel: (session, jobId) => mutate(async () => {
      if (!current(session)) return false;
      const saved = (await index.listDownloadJobs(session)).find(job => job.jobId === jobId);
      if (!current(session) || !saved || saved.state === 'ready') return false;
      const job = register(session, saved);
      return job.state === 'cancelled' || update(session, job, 'cancelled');
    }),
    reconsiderSpace() {
      return mutate(async () => {
        const session = index.getOfflineSession();
        if (!current(session)) return;
        for (const job of await index.listDownloadJobs(session)) {
          if (job.state === 'space') await update(session, register(session, job), 'queued');
        }
      });
    },
    wake,
    sessionChanged() {
      activeController?.abort();
      clearOrphans = !index.getOfflineSession();
      return wake();
    },
    stop() {
      stopped = true;
      activeController?.abort();
      clearTimeout(timer);
      subscription?.remove();
    },
  };
}
