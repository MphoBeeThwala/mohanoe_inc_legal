import type { Request, Response } from 'express';

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) {
      continue;
    }
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  path?: string;
  secure: boolean;
  sameSite: 'Lax' | 'Strict';
}

export function setCookie(res: Response, name: string, value: string, options: CookieOptions) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? '/'}`,
    'HttpOnly',
    `SameSite=${options.sameSite}`,
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  res.append('Set-Cookie', parts.join('; '));
}

export function clearCookie(
  res: Response,
  name: string,
  options: Omit<CookieOptions, 'maxAgeSeconds'>,
) {
  setCookie(res, name, '', { ...options, maxAgeSeconds: 0 });
}
