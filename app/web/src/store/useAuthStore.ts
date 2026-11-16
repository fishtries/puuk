import { create } from 'zustand';
import type { User, LoginCredentials } from '../types/user';
import { loginWithCredentials, loginWithCode, fetchCurrentUser } from '../api/auth';
import { resetUnauthorizedLatch, advanceApiSession, captureApiSession, isApiSessionCurrent, ApiRequestError } from '../api/client';
import { queryClient } from '../api/queryClient';
import { usePlayerStore } from './usePlayerStore';

interface AuthStoreState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
  isAuthChecked: boolean;
  login: (credentials: LoginCredentials) => Promise<void>;
  loginWithTelegramCode: (code: string) => Promise<void>;
  logout: () => void;
  checkAuth: () => Promise<void>;
}

let authOperation = 0;
function clearUserSession() {
  advanceApiSession();
  localStorage.removeItem('puuk_token');
  void queryClient.cancelQueries();
  queryClient.clear();
  usePlayerStore.getState().resetUserData();
}

export const useAuthStore = create<AuthStoreState>((set) => ({
  user: null,
  token: localStorage.getItem('puuk_token'),
  isLoading: false,
  error: null,
  isAuthChecked: false,

  login: async (credentials: LoginCredentials) => {
    const operation = ++authOperation;
    clearUserSession();
    set({ user: null, token: null, isLoading: true, error: null });
    try {
      const response = await loginWithCredentials(credentials);
      if (operation !== authOperation) return;
      localStorage.setItem('puuk_token', response.access_token);
      advanceApiSession();
      const user = response.user || await fetchCurrentUser();
      if (operation !== authOperation) return;
      set({ token: response.access_token, user, isLoading: false, isAuthChecked: true });
      resetUnauthorizedLatch();
      void queryClient.invalidateQueries();
    } catch (err: unknown) {
      if (operation !== authOperation) return;
      set({ error: (err as Error).message || 'Authentication failed', isLoading: false });
      throw err;
    }
  },

  loginWithTelegramCode: async (code: string) => {
    const operation = ++authOperation;
    clearUserSession();
    set({ user: null, token: null, isLoading: true, error: null });
    try {
      const response = await loginWithCode(code);
      if (operation !== authOperation) return;
      localStorage.setItem('puuk_token', response.access_token);
      advanceApiSession();
      const user = response.user || await fetchCurrentUser();
      if (operation !== authOperation) return;
      set({ token: response.access_token, user, isLoading: false, isAuthChecked: true });
      resetUnauthorizedLatch();
      void queryClient.invalidateQueries();
    } catch (err: unknown) {
      if (operation !== authOperation) return;
      set({ error: (err as Error).message || 'Invalid Telegram code', isLoading: false });
      throw err;
    }
  },

  logout: () => {
    ++authOperation;
    clearUserSession();
    set({ user: null, token: null, error: null, isLoading: false, isAuthChecked: true });
  },

  checkAuth: async () => {
    const operation = ++authOperation;
    const session = captureApiSession();
    const token = localStorage.getItem('puuk_token');
    if (!token) {
      set({ isAuthChecked: true, isLoading: false });
      return;
    }
    set({ isLoading: true });
    try {
      const user = await fetchCurrentUser();
      if (operation !== authOperation || !isApiSessionCurrent(session)) return;
      set({ token, user, isAuthChecked: true, isLoading: false });
      queryClient.invalidateQueries();
    } catch (error) {
      if (operation !== authOperation || !isApiSessionCurrent(session)) return;
      if (!(error instanceof ApiRequestError) || error.status !== 401) {
        set({ isAuthChecked: true, isLoading: false, error: 'Не удалось проверить сессию' });
        return;
      }
      clearUserSession();
      set({ token: null, user: null, isAuthChecked: true, isLoading: false });
    }
  },
}));

// Other tabs cannot leave singleton audio running behind an auth gate.
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === 'puuk_token' || event.key === null) {
    ++authOperation;
    advanceApiSession();
    useAuthStore.setState({ user: null, token: localStorage.getItem('puuk_token'), isAuthChecked: false });
    void useAuthStore.getState().checkAuth();
  }
});
