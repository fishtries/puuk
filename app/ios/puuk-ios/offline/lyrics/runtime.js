// Keep network work independent of playback and bounded across scans and publications.
export function createLyricsSync({ getSession, isCurrent, listUnknown, refresh, subscribeIndex,
  subscribeNetwork, getNetwork, subscribeAppState }) {
  return function start() {
    let stopped = false;
    let controller = new AbortController();
    let pending = false;
    let busy = false;
    let online = getNetwork()?.isConnected !== false;
    let active = true;
    let cursor = '';
    let inFlight = null;
    const publications = new Map();
    const identity = (session, key) => JSON.stringify([
      session.owner.origin, session.owner.userId, session.activationId, session.generation,
      key.trackId, key.contentVersion,
    ]);
    const run = async () => {
      pending = true;
      if (busy) return;
      busy = true;
      try {
        while (pending && !stopped) {
          pending = false;
          const session = getSession();
          const signal = controller.signal;
          if (!session || !online || !active || !isCurrent(session)) continue;
          const current = () => !stopped && !signal.aborted && online && active && isCurrent(session);
          const seen = new Set();
          let count = 0;
          // Publications share the same concurrency limit as the scan.
          for (const [id, item] of publications) {
            publications.delete(id);
            if (!current()) break;
            if (!isCurrent(item.session)) continue;
            seen.add(id);
            count += 1;
            inFlight = id;
            await refresh(item.session, item.key, { signal }).catch(() => {});
            inFlight = null;
            if (count >= 50) break;
          }
          while (current() && count < 50) {
            const limit = Math.min(20, 50 - count);
            const rows = await listUnknown(session, cursor, limit);
            if (!current()) break;
            if (!rows.length) { cursor = ''; break; }
            for (const key of rows) {
              if (!current()) break;
              cursor = key.trackId;
              const id = identity(session, key);
              if (seen.has(id)) continue;
              seen.add(id);
              count += 1;
              inFlight = id;
              await refresh(session, key, { signal }).catch(() => {});
              inFlight = null;
              if (count >= 50) break;
            }
            if (rows.length < limit) { cursor = ''; break; }
          }
        }
      } catch { /* The next lifecycle signal retries; playback is independent. */ }
      finally { busy = false; }
    };
    const reset = (ownerChanged = false) => {
      controller.abort(); controller = new AbortController(); publications.clear();
      if (ownerChanged) cursor = '';
    };
    const unsubscribeIndex = subscribeIndex(event => {
      if (event.type === 'closed') reset(true);
      if (event.type === 'opened') void run();
      if (event.type === 'published' && isCurrent(event.session)) {
        // Overflow remains discoverable by the bounded ready-media scan.
        const id = identity(event.session, event.mediaKey);
        if (id === inFlight || publications.has(id)) return;
        if (publications.size < 50) publications.set(id, {
          session: event.session, key: event.mediaKey,
        });
        void run();
      }
    });
    const unsubscribeNetwork = subscribeNetwork(policy => {
      const wasOnline = online;
      online = policy?.isConnected !== false;
      if (!online) reset();
      else if (!wasOnline) void run();
    });
    const unsubscribeApp = subscribeAppState(state => {
      active = state === 'active';
      if (!active) reset();
      else void run();
    });
    void run();
    return () => { stopped = true; reset(); unsubscribeIndex(); unsubscribeNetwork(); unsubscribeApp(); };
  };
}
