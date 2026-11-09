import type { Response } from 'express';

/** An error that carries the HTTP status the API should answer with. */
export class HttpError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

export function httpError(message: string, statusCode: number): HttpError {
  return new HttpError(message, statusCode);
}

export function errorStatus(error: unknown, fallback = 500): number {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const status = Number((error as { statusCode: unknown }).statusCode);
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      return status;
    }
  }
  return fallback;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return 'Internal server error';
}

/**
 * Full description for logs: includes the underlying cause, e.g. the
 * PostgreSQL error behind Drizzle's "Failed query: …" wrapper.
 */
export function describeError(error: unknown): string {
  const message = errorMessage(error);
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  return cause ? `${errorMessage(cause)} (${message.split('\n')[0]})` : message;
}

/** Standard JSON error response used by every controller. */
export function sendError(res: Response, error: unknown): void {
  res.status(errorStatus(error)).json({ message: errorMessage(error) });
}
