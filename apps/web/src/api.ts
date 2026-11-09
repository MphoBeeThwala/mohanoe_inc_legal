import axios, { type AxiosInstance } from 'axios';
import type { ApiErrorBody } from '@ahava88/shared';

export type ApiClient = AxiosInstance;

// The session lives in an httpOnly cookie set by the API: scripts never see
// it, so there is nothing to store in the browser.
export const api: ApiClient = axios.create({
  baseURL: '/api',
  timeout: 35000,
  withCredentials: true,
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

export function apiStatus(error: unknown): number | undefined {
  return axios.isAxiosError(error) ? error.response?.status : undefined;
}
