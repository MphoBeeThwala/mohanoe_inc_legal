import axios, { type AxiosInstance } from 'axios';
import type { ApiErrorBody } from '@ahava88/shared';

const TOKEN_KEY = 'pms_session_token';

// Browser storage can be missing or throw (private mode, locked-down
// browsers, test environments). Never let that crash the workspace.
export const sessionStore = {
  get(): string | null {
    try {
      return window.localStorage?.getItem(TOKEN_KEY) ?? null;
    } catch {
      return null;
    }
  },
  set(value: string): void {
    try {
      window.localStorage?.setItem(TOKEN_KEY, value);
    } catch {
      // ignore: the session simply won't survive a reload
    }
  },
  clear(): void {
    try {
      window.localStorage?.removeItem(TOKEN_KEY);
    } catch {
      // ignore
    }
  },
};

export type ApiClient = AxiosInstance;

export const api: ApiClient = axios.create({
  baseURL: '/api',
  timeout: 35000,
});

api.interceptors.request.use((config) => {
  const token = sessionStore.get();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/** The best human-readable message for a failed API call. */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError<ApiErrorBody>(error)) {
    return error.response?.data?.message || error.message || fallback;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}
