import { boundedMediaOperation } from '../shared/api/media';
import { authFetch } from '../shared/api/api';
import { getCurrentNetworkPolicy, subscribeNetworkPolicy } from '../utils/networkPolicy';
import { getOfflineSession, isOfflineSessionCurrent, ownerKey, subscribeOfflineIndex } from './session';
import { offlineDatabase } from './storage';

const freshness = 6 * 60 * 60 * 1000;
const batchSize = 512;

async function database() {
  const db = await offlineDatabase();
  db.execSync(`CREATE TABLE IF NOT EXISTS offline_wave_plan (
    owner TEXT PRIMARY KEY, inventory TEXT NOT NULL, updated INTEGER NOT NULL, plan TEXT NOT NULL
  )`);
  return db;
}

export async function readWavePlan(session) {
  const db = await database();
  if (!isOfflineSessionCurrent(session)) return null;
  const row = db.getFirstSync('SELECT plan FROM offline_wave_plan WHERE owner=?', ownerKey(session.owner));
  return row ? JSON.parse(row.plan) : null;
}

export async function refreshWavePlan(session, signal, force = false) {
  const db = await database();
  const current = () => !signal.aborted && isOfflineSessionCurrent(session);
  if (!current()) return;
  const owner = ownerKey(session.owner);
  const rows = await db.getAllAsync(`SELECT m.track_id FROM media m JOIN track_version v
    ON v.owner=m.owner AND v.track_id=m.track_id AND v.desired_version=m.version
    WHERE m.owner=? ORDER BY m.track_id`, owner);
  if (!current()) return;
  const ids = rows.map(row => row.track_id);
  const inventory = JSON.stringify(ids);
  const cached = db.getFirstSync('SELECT inventory, updated FROM offline_wave_plan WHERE owner=?', owner);
  if (!force && cached?.inventory === inventory && Date.now() - cached.updated < freshness) return;

  const ranked = [];
  const next = Object.create(null);
  const blocked = [];
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    const plan = await boundedMediaOperation(async requestSignal => {
      const response = await authFetch(session.owner.origin + '/api/wave/offline-plan', {
        method: 'POST', body: { track_ids: batch }, signal: requestSignal, timeout: 15000, retry: 0, background: true,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }, { signal, timeout: 15000 });
    if (!current()) return;
    const allowed = new Set(batch);
    if (!Array.isArray(plan.starts) || !plan.next || !Array.isArray(plan.blocked) ||
        !plan.starts.every(entry => Array.isArray(entry) && allowed.has(entry[0]) && Number.isFinite(entry[1])) ||
        !plan.blocked.every(id => allowed.has(id))) throw new Error('Invalid Wave plan');
    for (const [id, neighbors] of Object.entries(plan.next)) {
      if (!allowed.has(id) || !Array.isArray(neighbors) || !neighbors.every(key => allowed.has(key)))
        throw new Error('Invalid Wave neighbors');
      next[id] = neighbors;
    }
    ranked.push(...plan.starts);
    blocked.push(...plan.blocked);
  }
  const starts = ranked.sort((a, b) => b[1] - a[1]).map(entry => entry[0]);
  db.runSync('INSERT OR REPLACE INTO offline_wave_plan VALUES (?,?,?,?)',
    owner, inventory, Date.now(), JSON.stringify({ starts, next, blocked }));
}

export function startWavePlanSync() {
  let timer;
  let due = Infinity;
  let active;
  let force = false;
  let pending = false;
  let stopped = false;
  let earliest = 0;
  function schedule(delay = 1000) {
    if (stopped || !getOfflineSession() || getCurrentNetworkPolicy()?.isConnected === false) {
      clearTimeout(timer);
      due = Infinity;
      return;
    }
    if (active) {
      pending = true;
      return;
    }
    const target = Math.max(Date.now() + delay, earliest);
    if (due <= target) return;
    clearTimeout(timer);
    due = target;
    timer = setTimeout(run, Math.max(0, target - Date.now()));
  }
  async function run() {
    due = Infinity;
    const session = getOfflineSession();
    if (!session || stopped) return;
    const controller = new AbortController();
    active = controller;
    const refresh = force;
    force = false;
    pending = false;
    earliest = Date.now() + 60_000;
    let delay = freshness;
    try {
      await refreshWavePlan(session, controller.signal, refresh);
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn('[Offline Wave] Recommendation refresh failed', error.message);
        force ||= refresh;
        delay = 60_000;
      }
    } finally {
      active = null;
      schedule(pending ? 1000 : delay);
    }
  }
  const unsubscribe = subscribeOfflineIndex(({ type }) => {
    if (type === 'closed' || type === 'opened') {
      active?.abort();
      earliest = 0;
      force = false;
    }
    if (type === 'interactions-drained') force = true;
    if (['closed', 'opened', 'published', 'missing', 'version', 'interactions-drained'].includes(type)) schedule();
  });
  const network = subscribeNetworkPolicy(policy => {
    if (policy?.isConnected === false) active?.abort();
    schedule();
  });
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    active?.abort();
    unsubscribe();
    network();
  };
}
