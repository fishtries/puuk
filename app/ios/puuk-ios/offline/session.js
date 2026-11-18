import { offlineDatabase } from './storage';

export const ownerKey = ({ origin, userId }) =>
  JSON.stringify([origin, userId]);
export const createOfflineId = () => require('expo-crypto').randomUUID();

export function jwtExpiry(token, userId) {
  try {
    const segment = token.split('.')[1];
    if (!segment || segment.length > 12000) return 0;
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let bits = 0;
    let value = 0;
    let text = '';
    for (const char of segment.replace(/-/g, '+').replace(/_/g, '/')) {
      if (char === '=') break;
      const digit = alphabet.indexOf(char);
      if (digit < 0) return 0;
      value = (value << 6) | digit;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        text += String.fromCharCode((value >>> bits) & 255);
      }
    }
    const payload = JSON.parse(text);
    return userId != null &&
      String(payload.sub) === String(userId) &&
      Number.isFinite(payload.exp) &&
      payload.scope !== 'media'
      ? payload.exp * 1000
      : 0;
  } catch {
    return 0;
  }
}

let active = null;
let expiryTimer;
const listeners = new Set();

export function subscribeOfflineIndex(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyOfflineIndex(event) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* Subscribers do not participate in commits. */
    }
  }
}

export function getOfflineSession() {
  return active && active.expiresAt > Date.now() ? active.session : null;
}

export function isOfflineSessionCurrent(session) {
  const current = getOfflineSession();
  return Boolean(
    session &&
    current &&
    session.activationId === current.activationId &&
    session.generation === current.generation &&
    ownerKey(session.owner) === ownerKey(current.owner),
  );
}

export function closeOfflineSession() {
  clearTimeout(expiryTimer);
  const previous = active?.session;
  active = null;
  if (previous) notifyOfflineIndex({ type: 'closed', session: previous });
  return previous;
}

// The SecureStore envelope is authoritative only when this independent marker agrees.
export async function persistOfflineActivation(session) {
  const db = await offlineDatabase();
  await db.runAsync(
    'INSERT OR REPLACE INTO activation VALUES (1, ?, ?)',
    ownerKey(session.owner),
    session.activationId,
  );
}

export async function revokeOfflineActivation(session) {
  const db = await offlineDatabase();
  if (session) {
    await db.runAsync(
      'DELETE FROM activation WHERE singleton = 1 AND activation_id = ?',
      session.activationId,
    );
  } else {
    await db.runAsync('DELETE FROM activation WHERE singleton = 1');
  }
}

export async function openOfflineSession(
  session,
  expiresAt,
  stillCurrent,
  onExpiry,
) {
  if (expiresAt <= Date.now()) return false;
  const db = await offlineDatabase();
  const row = await db.getFirstAsync(
    'SELECT * FROM activation WHERE singleton = 1',
  );
  if (
    !stillCurrent() ||
    row?.owner !== ownerKey(session.owner) ||
    row.activation_id !== session.activationId ||
    expiresAt <= Date.now()
  )
    return false;
  clearTimeout(expiryTimer);
  active = {
    session: Object.freeze({
      ...session,
      owner: Object.freeze({ ...session.owner }),
    }),
    expiresAt,
  };
  const arm = () => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) onExpiry();
    else expiryTimer = setTimeout(arm, Math.min(remaining, 2 ** 31 - 1));
  };
  arm();
  notifyOfflineIndex({ type: 'opened', session: active.session });
  return true;
}
