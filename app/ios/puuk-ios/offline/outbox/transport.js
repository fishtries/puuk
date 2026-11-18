const DELETED_TRACK_DETAIL = 'Трек не найден';

function requestFor(job) {
  const path = `/api/tracks/${encodeURIComponent(job.trackId)}`;
  switch (job.kind) {
    case 'rating':
      return { url: `${path}/rating`, method: 'PUT' };
    case 'history':
      return { url: `${path}/history`, method: 'PUT' };
    case 'feedback':
      return { url: '/api/wave/feedback', method: 'PUT' };
    default:
      throw new Error('Unknown offline outbox operation');
  }
}

function acknowledged(job, data) {
  if (data?.track_id !== job.trackId) return false;
  if (job.kind === 'rating') {
    return (
      data.status === 'ok' &&
      data.operation_id === job.eventId &&
      data.rating === job.body.rating &&
      typeof data.applied === 'boolean'
    );
  }
  return (
    data.playback_id === job.eventId &&
    data.status === (job.kind === 'history' ? 'logged' : 'ok')
  );
}

export function createOutboxTransport({ authFetch, timeoutMs = 10000 }) {
  return async (session, job, signal) => {
    const { url, method } = requestFor(job);
    const request = new AbortController();
    let timer;
    let cancel;
    try {
      const stopped = new Promise((resolve) => {
        cancel = () => {
          request.abort();
          resolve({ state: 'cancelled' });
        };
        signal.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => {
          request.abort();
          resolve({ state: 'retry' });
        }, timeoutMs);
      });
      if (signal.aborted) return { state: 'cancelled' };
      const response = (async () => {
        const res = await authFetch(`${session.owner.origin}${url}`, {
          method,
          body: job.body,
          signal: request.signal,
          retry: 0,
          timeout: timeoutMs,
        });
        if (res.status === 401) return { state: 'unauthorized' };
        if (res.status === 429) {
          return {
            state: 'retry',
            rateLimited: true,
            retryAfter: res.headers?.get('Retry-After'),
          };
        }
        if (res.status >= 500 || res.status === 408 || res.status === 405)
          return { state: 'retry' };
        if (res.status === 404) {
          const body = await res.json();
          return {
            state: body?.detail === DELETED_TRACK_DETAIL ? 'missing' : 'retry',
          };
        }
        if (!res.ok) return { state: 'failed' };
        return {
          state: acknowledged(job, await res.json()) ? 'synced' : 'retry',
        };
      })().catch(() => ({ state: signal.aborted ? 'cancelled' : 'retry' }));
      return await Promise.race([response, stopped]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    }
  };
}
