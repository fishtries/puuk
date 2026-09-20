export interface User {
  id: string;
  username: string;
  telegram_id?: number;
  role?: string;
  avatar_url?: string;
}

export interface LoginCredentials {
  username: string;
  password?: string;
}

export interface CodeCredentials {
  code: string;
}

export interface AuthResponse {
  access_token: string;
  token_type: string;
  user?: User;
}
