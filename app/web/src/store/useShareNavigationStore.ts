/**
 * Safe Share Navigation Store and Tab-Scoped Pending Destination State.
 * Conforms to CDN & Share Links Contract v1 (§7, §8).
 *
 * Rules:
 * - Tab-scoped sessionStorage entry: { type, id, savedAt }, max 24h wall-clock age.
 * - Rejects malformed, negative, or future-corrupt ages.
 * - Clears on successful display, explicit cancel, expiry, or explicit navigation away.
 * - Retains pending target across 401 auth challenges (for login completion) and network errors (for retry).
 * - History pushState for entity navigation, replaceState for alias/trailing slash canonicalization.
 * - popstate re-parses path and cancels stale requests; NEVER calls pushState from popstate.
 * - Avoids history loops and stale requests via generation fencing after every await.
 * - Incoming link, navigation, login, and alias resolution NEVER auto-play or modify audio queue.
 */

import { create } from 'zustand';
import { onApiSessionChange, captureApiSession, isApiSessionCurrent } from '../api/client.ts';
import { parseShareTarget, type ShareEntityType } from '../utils/shareLinks.ts';
import {
  fetchShareEntity,
  ShareApiError,
  type ShareEntityResponse,
  type ShareEntityPayload,
} from '../api/share.ts';

export const PENDING_SHARE_STORAGE_KEY = 'puuk_pending_share_destination';
export const PENDING_SHARE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface ShareTarget {
  type: ShareEntityType;
  id: string;
}

export interface PendingShareDestination extends ShareTarget {
  savedAt: number;
}

export interface ShareNavigationError {
  kind: 'auth' | 'terminal' | 'retryable' | 'invalid';
  status?: number;
  message: string;
  code?: string;
}

export interface ShareNavigationState {
  currentTarget: ShareTarget | null;
  pendingDestination: PendingShareDestination | null;
  isResolving: boolean;
  resolvedEntity: ShareEntityResponse | null;
  error: ShareNavigationError | null;
  generation: number;

  // Actions
  initFromLocation: () => ShareTarget | null;
  setPendingDestination: (target: ShareTarget | null) => void;
  clearPendingDestination: () => void;
  navigateToTarget: (target: ShareTarget, options?: { replace?: boolean; updateHistory?: boolean }) => void;
  cancelNavigation: () => void;
  handlePopState: (pathname?: string) => void;
  canonicalizeUrl: (canonicalPath: string) => void;
  resolveCurrentTarget: () => Promise<ShareEntityResponse | null>;
  reset: () => void;
  suspendForAuth: () => void;
}

/**
 * Safe accessor for sessionStorage (handles restricted/private mode or non-browser environments).
 */
export function getSafeSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage || null;
  } catch {
    return null;
  }
}

/**
 * Reads and revalidates pending destination from sessionStorage.
 * Rejects corrupt, negative, future, or >24h expired timestamps.
 */
export function readPendingDestination(
  storage: Storage | null = getSafeSessionStorage(),
  now: number = Date.now()
): PendingShareDestination | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PENDING_SHARE_STORAGE_KEY);
    if (!raw) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      storage.removeItem(PENDING_SHARE_STORAGE_KEY);
      return null;
    }

    if (!parsed || typeof parsed !== 'object') {
      storage.removeItem(PENDING_SHARE_STORAGE_KEY);
      return null;
    }

    const { type, id, savedAt } = parsed as {
      type?: unknown;
      id?: unknown;
      savedAt?: unknown;
    };

    if (typeof type !== 'string' || typeof id !== 'string') {
      storage.removeItem(PENDING_SHARE_STORAGE_KEY);
      return null;
    }

    // Revalidate entity type and ID format
    const validated = parseShareTarget(`/${type}/${id}`);
    if (!validated || validated.hasTrailingSlash) {
      storage.removeItem(PENDING_SHARE_STORAGE_KEY);
      return null;
    }

    // Validate savedAt timestamp
    if (typeof savedAt !== 'number' || !Number.isFinite(savedAt) || savedAt < 0 || !Number.isFinite(now)) {
      storage.removeItem(PENDING_SHARE_STORAGE_KEY);
      return null;
    }

    // Reject future-corrupt timestamp
    if (savedAt > now) {
      storage.removeItem(PENDING_SHARE_STORAGE_KEY);
      return null;
    }

    // Reject expired timestamp (24h wall-clock age)
    if (now - savedAt > PENDING_SHARE_MAX_AGE_MS) {
      storage.removeItem(PENDING_SHARE_STORAGE_KEY);
      return null;
    }

    return {
      type: validated.type,
      id: validated.id,
      savedAt,
    };
  } catch {
    try {
      storage.removeItem(PENDING_SHARE_STORAGE_KEY);
    } catch {
      // ignore
    }
    return null;
  }
}

/**
 * Writes validated pending destination to sessionStorage.
 */
export function writePendingDestination(
  target: ShareTarget,
  storage: Storage | null = getSafeSessionStorage(),
  now: number = Date.now()
): boolean {
  if (!storage) return false;
  try {
    const validated = parseShareTarget(`/${target.type}/${target.id}`);
    if (!validated || validated.hasTrailingSlash) {
      return false;
    }
    const entry: PendingShareDestination = {
      type: validated.type,
      id: validated.id,
      savedAt: now,
    };
    storage.setItem(PENDING_SHARE_STORAGE_KEY, JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes pending destination from sessionStorage.
 */
export function deletePendingDestination(storage: Storage | null = getSafeSessionStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(PENDING_SHARE_STORAGE_KEY);
  } catch {
    // ignore
  }
}

let request: { controller: AbortController; promise: Promise<ShareEntityResponse | null> } | null = null;
function abortRequest() { request?.controller.abort(); request = null; }
function locationPath(): string {
  return typeof window === 'undefined' ? '' : `${window.location.pathname}${window.location.search || ''}${window.location.hash || ''}`;
}
function historyTarget(target: ShareTarget | null, replace: boolean) {
  if (typeof window === 'undefined') return;
  try { window.history[replace ? 'replaceState' : 'pushState'](target ? { shareTarget: target } : null, '', target ? `/${target.type}/${target.id}` : '/'); } catch { /* Browser may restrict history. */ }
}
export const useShareNavigationStore = create<ShareNavigationState>((set, get) => ({
  currentTarget: null, pendingDestination: null, isResolving: false, resolvedEntity: null, error: null, generation: 0,
  initFromLocation: () => {
    abortRequest();
    const path = locationPath();
    const parsed = parseShareTarget(path);
    const target = parsed ? { type: parsed.type, id: parsed.id } : null;
    if (target) {
      writePendingDestination(target);
      if (parsed!.hasTrailingSlash) historyTarget(target, true);
    } else if (path !== '/') deletePendingDestination();
    set(state => ({ currentTarget: target, pendingDestination: readPendingDestination(), resolvedEntity: null, error: null, isResolving: false, generation: state.generation + 1 }));
    return target;
  },
  setPendingDestination: target => {
    if (target) writePendingDestination(target); else deletePendingDestination();
    set({ pendingDestination: readPendingDestination() });
  },
  clearPendingDestination: () => { deletePendingDestination(); set({ pendingDestination: null }); },
  navigateToTarget: (target, options) => {
    const parsed = parseShareTarget(`/${target.type}/${target.id}`);
    if (!parsed || parsed.hasTrailingSlash) { set({ error: { kind: 'invalid', message: 'Некорректная ссылка' } }); return; }
    const current = get().currentTarget;
    if (current?.type === target.type && current.id === target.id) return;
    abortRequest();
    const clean = { type: parsed.type, id: parsed.id };
    if (options?.updateHistory !== false) historyTarget(clean, Boolean(options?.replace));
    writePendingDestination(clean);
    set(state => ({ currentTarget: clean, pendingDestination: readPendingDestination(), resolvedEntity: null, error: null, isResolving: false, generation: state.generation + 1 }));
  },
  cancelNavigation: () => {
    abortRequest();
    deletePendingDestination();
    historyTarget(null, true);
    set(state => ({ currentTarget: null, pendingDestination: null, resolvedEntity: null, error: null, isResolving: false, generation: state.generation + 1 }));
  },
  handlePopState: path => {
    abortRequest();
    const parsed = parseShareTarget(path ?? locationPath());
    const target = parsed ? { type: parsed.type, id: parsed.id } : null;
    if (target) { writePendingDestination(target); if (parsed!.hasTrailingSlash) historyTarget(target, true); }
    else deletePendingDestination();
    set(state => ({ currentTarget: target, pendingDestination: readPendingDestination(), resolvedEntity: null, error: null, isResolving: false, generation: state.generation + 1 }));
  },
  canonicalizeUrl: path => {
    const parsed = parseShareTarget(path);
    if (!parsed || parsed.hasTrailingSlash || parsed.canonicalPath !== path || parsed.type !== get().currentTarget?.type) return;
    historyTarget({ type: parsed.type, id: parsed.id }, true);
  },
  resolveCurrentTarget: () => {
    if (request && get().isResolving) return request.promise;
    const { currentTarget, generation } = get();
    if (!currentTarget) return Promise.resolve(null);
    const session = captureApiSession();
    const controller = new AbortController();
    const current = () => get().generation === generation && !controller.signal.aborted && isApiSessionCurrent(session);
    set({ isResolving: true, error: null });
    const promise = fetchShareEntity(currentTarget.type, currentTarget.id, { signal: controller.signal }).then(res => {
      if (!current()) return null;
      if (res.canonical_id !== currentTarget.id) get().canonicalizeUrl(res.canonical_path);
      deletePendingDestination();
      set({ currentTarget: { type: res.type, id: res.canonical_id }, pendingDestination: null, resolvedEntity: res as ShareEntityResponse<ShareEntityPayload>, isResolving: false, error: null });
      return res;
    }).catch((error: unknown) => {
      if (!current()) return null;
      const known = error instanceof ShareApiError ? error : null;
      if (known?.isTerminal) get().clearPendingDestination();
      set({ isResolving: false, error: { kind: known?.isAuth ? 'auth' : known?.isTerminal ? 'terminal' : 'retryable', status: known?.status, code: known?.code, message: known?.message ?? 'Не удалось загрузить. Повторите попытку' } });
      return null;
    }).finally(() => { if (request?.promise === promise) request = null; });
    request = { controller, promise };
    return promise;
  },
  suspendForAuth: () => {
    abortRequest();
    const target = get().currentTarget;
    if (target) writePendingDestination(target);
    set(state => ({ resolvedEntity: null, error: null, isResolving: false, pendingDestination: readPendingDestination(), generation: state.generation + 1 }));
  },
  reset: () => {
    abortRequest();
    set(state => ({ currentTarget: null, pendingDestination: null, resolvedEntity: null, error: null, isResolving: false, generation: state.generation + 1 }));
  },
}));
onApiSessionChange(() => useShareNavigationStore.getState().suspendForAuth());
