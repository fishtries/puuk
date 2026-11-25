const BASE_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL) || '';
const AUTH_EXEMPT_PREFIXES = ['/api/auth/login', '/api/auth/verify-code', '/api/auth/me'];
let unauthorizedHandler: (() => void) | null = null;
let unauthorizedLatch = false;
let generation = 0;
let observedToken: string | null | undefined;
const sessionListeners = new Set<() => void>();
const requests = new Set<AbortController>();

export const API_BASE_URL = BASE_URL;
export interface ApiSession { generation: number; token: string | null; origin: string }
export class ApiRequestError extends Error {
  readonly status: number;
  constructor(status: number) { super(status === 401 ? 'Требуется вход' : `Ошибка запроса (${status})`); this.status = status; }
}
export class SessionChangedError extends Error {
  constructor() { super('Session changed'); this.name = 'SessionChangedError'; }
}
export function getApiOrigin(): string {
  return new URL(BASE_URL || '/', typeof window !== 'undefined' ? window.location?.href || 'https://web.puuk.fun/' : 'https://web.puuk.fun/').origin;
}
function readToken(): string | null {
  try { return localStorage.getItem('puuk_token'); } catch { return null; }
}
/** Advance before clearing protected state, so even late body decoding cannot publish. */
export function advanceApiSession(): void {
  generation += 1;
  observedToken = readToken();
  for (const controller of requests) controller.abort();
  requests.clear();
  unauthorizedLatch = false;
  for (const listener of sessionListeners) listener();
}
export function onApiSessionChange(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}
export function captureApiSession(): ApiSession {
  const token = readToken();
  if (observedToken === undefined) observedToken = token;
  else if (observedToken !== token) advanceApiSession();
  return { generation, token, origin: getApiOrigin() };
}
export function isApiSessionCurrent(session: ApiSession): boolean {
  const current = captureApiSession();
  return current.generation === session.generation && current.token === session.token && current.origin === session.origin;
}
export function assertApiSessionCurrent(session: ApiSession): void {
  if (!isApiSessionCurrent(session)) throw new SessionChangedError();
}
export function setUnauthorizedHandler(handler: (() => void) | null): void { unauthorizedHandler = handler; }
export function resetUnauthorizedLatch(): void { unauthorizedLatch = false; }
function handleUnauthorized(endpoint: string, session: ApiSession): void {
  if (!isApiSessionCurrent(session) || unauthorizedLatch || AUTH_EXEMPT_PREFIXES.some(prefix => endpoint.startsWith(prefix))) return;
  unauthorizedLatch = true;
  unauthorizedHandler?.();
}
/** Only the configured API origin receives account credentials. */
export function isTrustedApiOrigin(url: string): boolean {
  try {
    if (/[\\\s]/.test(url) || url.startsWith('//')) return false;
    const parsed = new URL(url, `${getApiOrigin()}/`);
    return !parsed.username && !parsed.password && parsed.origin === getApiOrigin();
  } catch { return false; }
}
function withBaseUrl(url: string): string {
  if (!isTrustedApiOrigin(url)) throw new Error('Untrusted API destination');
  if (/^https?:\/\//.test(url)) return url;
  return `${BASE_URL}${url.startsWith('/') ? url : `/${url}`}`;
}
async function withAuthorizedResponse<T>(url: string, options: RequestInit, consume: (response: Response) => T | Promise<T>): Promise<T> {
  const endpoint = withBaseUrl(url); // Validate before reading/attaching credentials.
  const session = captureApiSession();
  const headers = new Headers(options.headers);
  headers.delete('Authorization');
  if (session.token) headers.set('Authorization', `Bearer ${session.token}`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  requests.add(controller);
  try {
    if (controller.signal.aborted) throw new SessionChangedError();
    const response = await fetch(endpoint, { ...options, headers, credentials: 'omit', redirect: 'error', signal: controller.signal });
    assertApiSessionCurrent(session);
    if (controller.signal.aborted) throw new SessionChangedError();
    if (response.redirected) throw new Error('Unexpected API redirect');
    if (response.status === 401) handleUnauthorized(url, session);
    return await consume(response);
  } finally {
    requests.delete(controller);
    options.signal?.removeEventListener('abort', abort);
  }
}
export function authorizedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  return withAuthorizedResponse(url, options, response => response);
}

export async function apiClient<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const session = captureApiSession();
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  return withAuthorizedResponse(endpoint, { ...options, headers }, async response => {
    assertApiSessionCurrent(session);
    // Never surface arbitrary server bodies (they can contain permissions/paths).
    if (!response.ok) throw new ApiRequestError(response.status);
    if (response.status === 204) return {} as T;
    const value = await response.json();
    assertApiSessionCurrent(session);
    return value as T;
  });
}
