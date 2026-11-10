// Queue actions address an occurrence, rather than a song ID: a song may be
// deliberately queued twice. Metadata remains a regular track DTO.
const identities = new WeakMap();
let sequence = 0;

export function queueKey(track) {
  if (!identities.has(track)) identities.set(track, `queue-${++sequence}`);
  return identities.get(track);
}

export function carryQueueIdentity(previous, next) {
  if (previous && next && previous !== next && !identities.has(next))
    identities.set(next, queueKey(previous));
  return next;
}

export function shuffledTracks(tracks) {
  const result = [...tracks];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
