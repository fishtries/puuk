import { apiClient } from './client';
import { AuthResponse, LoginCredentials, User } from '../types/user';

export async function loginWithCredentials(credentials: LoginCredentials): Promise<AuthResponse> {
  const formData = new URLSearchParams();
  formData.append('username', credentials.username);
  if (credentials.password) {
    formData.append('password', credentials.password);
  }

  return apiClient<AuthResponse>('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formData.toString(),
  });
}

export async function loginWithCode(code: string): Promise<AuthResponse> {
  return apiClient<AuthResponse>('/api/auth/verify-code', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export async function fetchCurrentUser(): Promise<User> {
  return apiClient<User>('/api/auth/me');
}
