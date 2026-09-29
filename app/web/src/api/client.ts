const BASE_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL) || '';

// Маршруты, чьи 401 не считаются истечением сессии:
// login/verify-code — это "неверный пароль/код", /me — обрабатывается в checkAuth.
const AUTH_EXEMPT_PREFIXES = ['/api/auth/login', '/api/auth/verify-code', '/api/auth/me'];

let unauthorizedHandler: (() => void) | null = null;
let unauthorizedLatch = false;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export function resetUnauthorizedLatch(): void {
  unauthorizedLatch = false;
}

function handleUnauthorized(endpoint: string): void {
  if (unauthorizedLatch) return;
  if (AUTH_EXEMPT_PREFIXES.some((prefix) => endpoint.startsWith(prefix))) return;
  unauthorizedLatch = true;
  unauthorizedHandler?.();
}

function withBaseUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${BASE_URL}${url.startsWith('/') ? url : `/${url}`}`;
}

export const API_BASE_URL = BASE_URL;

/**
 * Trusted origins receive the Authorization header: the page origin and the
 * configured API origin (VITE_API_URL). Foreign hosts (iTunes/Deezer CDNs)
 * must never receive it.
 */
export function isTrustedApiOrigin(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return true;
  if (typeof window === 'undefined' || !window.location) return false;
  try {
    const origin = new URL(url, window.location.href).origin;
    if (origin === window.location.origin) return true;
    if (BASE_URL) {
      return origin === new URL(BASE_URL, window.location.href).origin;
    }
    return false;
  } catch {
    return false;
  }
}

function authHeaders(headers?: HeadersInit): Headers {
  const merged = new Headers(headers);
  const token = localStorage.getItem('puuk_token');
  if (token) {
    merged.set('Authorization', `Bearer ${token}`);
  }
  return merged;
}

export async function apiClient<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers || {});

  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(withBaseUrl(endpoint), {
    ...options,
    headers: authHeaders(headers),
  });

  if (!response.ok) {
    if (response.status === 401) {
      handleUnauthorized(endpoint);
    }
    let errorMessage = `HTTP error! status: ${response.status}`;
    try {
      const errJson = await response.json();
      if (errJson.detail) {
        errorMessage = typeof errJson.detail === 'string' ? errJson.detail : JSON.stringify(errJson.detail);
      }
    } catch {
      // ignore
    }
    throw new Error(errorMessage);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return response.json();
}

export async function authorizedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const response = await fetch(withBaseUrl(url), {
    ...options,
    headers: authHeaders(options.headers),
  });
  if (response.status === 401) {
    handleUnauthorized(url);
  }
  return response;
}
