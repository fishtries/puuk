import { create } from 'zustand';
import { User, LoginCredentials } from '../types/user';
import { loginWithCredentials, loginWithCode, fetchCurrentUser } from '../api/auth';

interface AuthStoreState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
  login: (credentials: LoginCredentials) => Promise<void>;
  loginWithTelegramCode: (code: string) => Promise<void>;
  logout: () => void;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthStoreState>((set) => ({
  user: null,
  token: localStorage.getItem('puuk_token'),
  isLoading: false,
  error: null,

  login: async (credentials: LoginCredentials) => {
    set({ isLoading: true, error: null });
    try {
      const response = await loginWithCredentials(credentials);
      localStorage.setItem('puuk_token', response.access_token);
      set({ token: response.access_token, user: response.user || null, isLoading: false });
      if (!response.user) {
        const user = await fetchCurrentUser();
        set({ user });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message || 'Authentication failed', isLoading: false });
      throw err;
    }
  },

  loginWithTelegramCode: async (code: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await loginWithCode(code);
      localStorage.setItem('puuk_token', response.access_token);
      set({ token: response.access_token, user: response.user || null, isLoading: false });
      if (!response.user) {
        const user = await fetchCurrentUser();
        set({ user });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message || 'Invalid Telegram code', isLoading: false });
      throw err;
    }
  },

  logout: () => {
    localStorage.removeItem('puuk_token');
    set({ user: null, token: null, error: null });
  },

  checkAuth: async () => {
    const token = localStorage.getItem('puuk_token');
    if (!token) return;
    try {
      const user = await fetchCurrentUser();
      set({ user });
    } catch {
      localStorage.removeItem('puuk_token');
      set({ token: null, user: null });
    }
  },
}));
