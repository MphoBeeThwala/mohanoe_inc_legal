// Server-side sessions.
//
// The browser gets a random 256-bit token in an httpOnly, SameSite=Lax cookie
// (__Host- prefixed and Secure in production). Only the token's SHA-256 hash
// is stored. Sessions expire after SESSION_IDLE_MINUTES without use and
// SESSION_MAX_HOURS after sign-in, and are revoked on sign-out, password
// change or reset, MFA reset, and deactivation. API clients may send the same
// token as "Authorization: Bearer …" instead of the cookie.
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { Request, Response } from 'express';
import type { SessionInfo, SignInMethod } from '@ahava88/shared';
import { db } from '../db/client';
import { sessions, users, type SessionRow, type UserRow } from '../db/schema';
import { authSettings } from '../config/auth';
import { clearCookie, readCookie, setCookie } from '../lib/cookies';
import { randomToken, sha256 } from '../lib/tokens';
import { iso } from '../lib/time';

const TOUCH_INTERVAL_MS = 60_000;

export interface PresentedToken {
  token: string;
  viaCookie: boolean;
}

export function presentedToken(req: Request): PresentedToken | null {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    return token ? { token, viaCookie: false } : null;
  }
  const cookie = readCookie(req, authSettings().sessionCookie);
  return cookie ? { token: cookie, viaCookie: true } : null;
}

export async function createSession(
  user: UserRow,
  method: SignInMethod,
  req: Request,
  res: Response,
): Promise<string> {
  const settings = authSettings();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + settings.sessionMaxHours * 3_600_000);
  await db()
    .insert(sessions)
    .values({
      userId: user.id,
      tokenHash: sha256(token),
      method,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300) || null,
      expiresAt,
    });
  setCookie(res, settings.sessionCookie, token, {
    secure: settings.secureCookies,
    sameSite: 'Lax',
    maxAgeSeconds: settings.sessionMaxHours * 3600,
  });
  return token;
}

export interface ActiveSession {
  session: SessionRow;
  user: UserRow;
}

/** The live session for a token, or null (unknown, expired, idle, revoked, inactive user). */
export async function findActiveSession(token: string): Promise<ActiveSession | null> {
  const settings = authSettings();
  const now = new Date();
  const [row] = await db()
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, sha256(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .limit(1);
  if (!row || !row.user.isActive) {
    return null;
  }
  const idleLimit = now.getTime() - settings.sessionIdleMinutes * 60_000;
  if (row.session.lastSeenAt.getTime() < idleLimit) {
    await revokeSession(row.session.id);
    return null;
  }
  if (now.getTime() - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db().update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.session.id));
  }
  return row;
}

export async function revokeSession(id: string): Promise<void> {
  await db()
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
}

/** Revokes every session of a user, optionally keeping one (the caller's). */
export async function revokeUserSessions(
  userId: string,
  exceptSessionId?: string,
): Promise<number> {
  const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
  if (exceptSessionId) {
    conditions.push(ne(sessions.id, exceptSessionId));
  }
  const revoked = await db()
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: sessions.id });
  return revoked.length;
}

export async function listUserSessions(userId: string, currentId: string): Promise<SessionInfo[]> {
  const rows = await db()
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(sessions.lastSeenAt))
    .limit(50);
  return rows.map((row) => ({
    id: row.id,
    method: row.method as SignInMethod,
    userAgent: row.userAgent,
    createdAt: iso(row.createdAt),
    lastSeenAt: iso(row.lastSeenAt),
    current: row.id === currentId,
  }));
}

export function clearSessionCookie(res: Response): void {
  const settings = authSettings();
  clearCookie(res, settings.sessionCookie, { secure: settings.secureCookies, sameSite: 'Lax' });
}
