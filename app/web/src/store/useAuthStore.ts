import { create } from 'zustand';
import { User, LoginCredentials } from '../types/user';
import { loginWithCredentials, loginWithCode, fetchCurrentUser } from '../api/auth';
import { queryClient } from '../api/queryClient';
import { usePlayerStore } from './usePlayerStore';

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

function clearUserSession() {
  localStorage.removeItem('puuk_token');
  queryClient.removeQueries({ queryKey: ['favorites'] });
  queryClient.removeQueries({ queryKey: ['history'] });
  queryClient.removeQueries({ queryKey: ['playlists'] });
  queryClient.removeQueries({ queryKey: ['playlist'] });
  queryClient.removeQueries({ queryKey: ['recommendations'] });
  queryClient.removeQueries({ queryKey: ['wave-profile-stats'] });
  queryClient.removeQueries({ queryKey: ['tracks'] });
  queryClient.removeQueries({ queryKey: ['albums'] });
  queryClient.removeQueries({ queryKey: ['search'] });
  queryClient.removeQueries({ queryKey: ['album-tracks'] });
  usePlayerStore.getState().resetUserData();
}

export const useAuthStore = create<AuthStoreState>((set) => ({
  user: null,
  token: localStorage.getItem('puuk_token'),
  isLoading: false,
  error: null,

  login: async (credentials: LoginCredentials) => {
    set({ isLoading: true, error: null });
    try {
      clearUserSession();
      const response = await loginWithCredentials(credentials);
      localStorage.setItem('puuk_token', response.access_token);
      const user = response.user || await fetchCurrentUser();
      set({ token: response.access_token, user, isLoading: false });
      void queryClient.invalidateQueries();
    } catch (err: unknown) {
      set({ error: (err as Error).message || 'Authentication failed', isLoading: false });
      throw err;
    }
  },

  loginWithTelegramCode: async (code: string) => {
    set({ isLoading: true, error: null });
    try {
      clearUserSession();
      const response = await loginWithCode(code);
      localStorage.setItem('puuk_token', response.access_token);
      const user = response.user || await fetchCurrentUser();
      set({ token: response.access_token, user, isLoading: false });
      void queryClient.invalidateQueries();
    } catch (err: unknown) {
      set({ error: (err as Error).message || 'Invalid Telegram code', isLoading: false });
      throw err;
    }
  },

  logout: () => {
    clearUserSession();
    set({ user: null, token: null, error: null });
  },

  checkAuth: async () => {
    const token = localStorage.getItem('puuk_token');
    if (!token) {
      set({ isLoading: false });
      return;
    }
    set({ isLoading: true });
    try {
      const user = await fetchCurrentUser();
      set({ user, isLoading: false });
      queryClient.invalidateQueries();
    } catch {
      clearUserSession();
      set({ token: null, user: null, isLoading: false });
    }
  },
}));
