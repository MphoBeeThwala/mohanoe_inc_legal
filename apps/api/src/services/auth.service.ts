// Staff authentication.
//
// - Accounts exist only through invites (user.service.ts); there is no public
//   registration.
// - Email + password sign-in always continues to a second factor: an
//   authenticator-app code (TOTP) or a one-time recovery code. A user without
//   MFA is sent through enrolment before any session is issued.
// - Entra External ID sign-in (oidc.service.ts) relies on Entra's own MFA.
// - Repeated failures lock the account for LOGIN_LOCKOUT_MINUTES.
// - Sessions are server-side and revocable (session.service.ts).
import crypto from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import QRCode from 'qrcode';
import type { NextFunction, Request, Response } from 'express';
import {
  ROLE_PERMISSIONS,
  hasPermission,
  type AuthConfig,
  type MfaEnrollment,
  type MfaEnrollmentResult,
  type Permission,
  type PublicUser,
  type SignInMethod,
  type SignInResult,
  type UserRole,
} from '@ahava88/shared';
import { HttpError, errorMessage, httpError } from '../lib/http';
import { requireSecret } from '../config/env';
import { authSettings, oidcSettings } from '../config/auth';
import { getFirmBrand } from '../config/brand';
import { db } from '../db/client';
import { setPrincipal } from '../db/tenant';
import { currentFirm } from '../db/tenant-context';
import { mfaRecoveryCodes, users, type UserRow } from '../db/schema';
import { iso, isoOrNull } from '../lib/time';
import { sha256 } from '../lib/tokens';
import * as totp from '../lib/totp';
import type { Actor } from '../lib/actor';
import {
  challengeSchema,
  changePasswordSchema,
  loginSchema,
  mfaConfirmSchema,
  mfaVerifySchema,
  parse,
} from '../validation/schemas';
import { decryptJson, encryptJson } from './privacy.service';
import { mailEnabled } from './mail.service';
import * as sessionService from './session.service';
import * as auditService from './audit.service';

const JWT_ISSUER = process.env.JWT_ISSUER || 'ahava88-legal-pms';
const CHALLENGE_MINUTES = 10;
const RECOVERY_CODE_COUNT = 10;
const INVALID_CREDENTIALS =
  'Invalid email or password. After repeated failures the account is locked for a few minutes.';

function getJwtSecret() {
  return requireSecret('JWT_SECRET', 'local-development-jwt-secret');
}

// ---------------------------------------------------------------- passwords

function hashPassword(password: string, salt: string) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

export function createPasswordHash(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}

// Compared against when the account is unknown or has no password, so a
// failed sign-in takes the same time either way (no user enumeration).
const DUMMY_CREDENTIALS = createPasswordHash(crypto.randomBytes(16).toString('hex'));

function verifyPassword(password: string, salt: string | null, expectedHash: string | null) {
  const credentials =
    salt && expectedHash ? { salt, hash: expectedHash } : { ...DUMMY_CREDENTIALS, real: false };
  const actual = Buffer.from(hashPassword(password, credentials.salt), 'hex');
  const expected = Buffer.from(String(credentials.hash), 'hex');
  const matches = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  return matches && 'real' in credentials === false;
}

// ---------------------------------------------------------------- users

export function signInMethods(user: UserRow): SignInMethod[] {
  const methods: SignInMethod[] = [];
  if (user.passwordHash) {
    methods.push('password');
  }
  if (user.oidcSubject) {
    methods.push('oidc');
  }
  return methods;
}

export function toPublicUser(user: UserRow): PublicUser {
  const role = user.role as UserRole;
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role,
    createdAt: iso(user.createdAt),
    lastLoginAt: isoOrNull(user.lastLoginAt),
    permissions: [...(ROLE_PERMISSIONS[role] ?? [])],
    mfaEnabled: Boolean(user.mfaEnabledAt),
    signInMethods: signInMethods(user),
  };
}

export function actorFor(user: UserRow): Actor {
  return { userId: user.id, email: user.email, fullName: user.fullName, role: user.role };
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const normalized = email.trim().toLowerCase();
  const [user] = await db().select().from(users).where(eq(users.email, normalized)).limit(1);
  return user ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const [user] = await db().select().from(users).where(eq(users.id, id)).limit(1);
  return user ?? null;
}

function isLocked(user: UserRow): boolean {
  return Boolean(user.lockedUntil && user.lockedUntil.getTime() > Date.now());
}

/** Counts a failed password or MFA attempt; locks the account at the limit. */
async function recordFailure(user: UserRow): Promise<void> {
  const settings = authSettings();
  const failures = user.failedLoginCount + 1;
  const lock = failures >= settings.maxFailedAttempts;
  await db()
    .update(users)
    .set({
      failedLoginCount: lock ? 0 : failures,
      lockedUntil: lock
        ? new Date(Date.now() + settings.lockoutMinutes * 60_000)
        : user.lockedUntil,
    })
    .where(eq(users.id, user.id));
  if (lock) {
    await auditService.logEventSafely(
      {
        entityType: 'user',
        entityId: user.id,
        action: 'user_locked',
        summary: 'Account locked after repeated failed sign-in attempts',
        details: { minutes: settings.lockoutMinutes },
      },
      actorFor(user),
    );
  }
}

/** Marks a completed sign-in: clears failures and records the time. */
export async function recordSignIn(user: UserRow, method: SignInMethod): Promise<UserRow> {
  const [updated] = await db()
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(users.id, user.id))
    .returning();
  await auditService.logEventSafely(
    {
      entityType: 'user',
      entityId: user.id,
      action: 'user_signed_in',
      summary: 'Staff member signed in',
      details: { method },
    },
    actorFor(user),
  );
  return updated ?? user;
}

// ---------------------------------------------------------------- challenges

type ChallengePurpose = 'mfa' | 'mfa_enroll';

interface ChallengeClaims extends JwtPayload {
  sub: string;
  firmId: string;
  purpose: ChallengePurpose;
}

/** A short-lived token proving the password step passed, for the MFA step. */
export function issueChallenge(user: UserRow, purpose: ChallengePurpose): string {
  return jwt.sign({ sub: user.id, firmId: user.firmId, purpose }, getJwtSecret(), {
    algorithm: 'HS256',
    issuer: JWT_ISSUER,
    audience: 'mfa-challenge',
    expiresIn: CHALLENGE_MINUTES * 60,
  });
}

async function readChallenge(token: string, purpose: ChallengePurpose): Promise<UserRow> {
  let claims: ChallengeClaims;
  try {
    const decoded = jwt.verify(token, getJwtSecret(), {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: 'mfa-challenge',
    });
    if (typeof decoded === 'string') {
      throw new Error('bad token');
    }
    claims = decoded as ChallengeClaims;
  } catch {
    throw httpError('Your sign-in has expired. Please sign in again.', 401);
  }
  if (claims.purpose !== purpose || claims.firmId !== currentFirm().id) {
    throw httpError('Your sign-in has expired. Please sign in again.', 401);
  }
  const user = await findUserById(claims.sub);
  if (!user || !user.isActive || isLocked(user)) {
    throw httpError(INVALID_CREDENTIALS, 401);
  }
  return user;
}

// ---------------------------------------------------------------- sign-in

/** Step 1: email + password. Never returns a session; MFA comes next. */
export async function signInWithPassword(input: unknown): Promise<SignInResult> {
  if (!authSettings().passwordLogin) {
    throw httpError('Password sign-in is disabled for this workspace', 403);
  }
  const { email, password } = parse(loginSchema, input);
  const user = await findUserByEmail(email);
  const passwordOk = verifyPassword(
    password,
    user?.passwordSalt ?? null,
    user?.passwordHash ?? null,
  );

  if (!user || !user.isActive || isLocked(user) || !passwordOk) {
    if (user && user.isActive && !isLocked(user)) {
      await recordFailure(user);
    }
    throw httpError(INVALID_CREDENTIALS, 401);
  }

  if (user.mfaEnabledAt) {
    return { status: 'mfa_required', challengeToken: issueChallenge(user, 'mfa') };
  }
  return { status: 'mfa_enrollment_required', challengeToken: issueChallenge(user, 'mfa_enroll') };
}

async function consumeRecoveryCode(user: UserRow, code: string): Promise<boolean> {
  const normalized = code.replace(/\s/g, '').toLowerCase();
  const [used] = await db()
    .update(mfaRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(mfaRecoveryCodes.userId, user.id),
        eq(mfaRecoveryCodes.codeHash, sha256(normalized)),
        isNull(mfaRecoveryCodes.usedAt),
      ),
    )
    .returning({ id: mfaRecoveryCodes.id });
  return Boolean(used);
}

async function mfaSecret(user: UserRow): Promise<string | null> {
  return user.mfaSecretEncrypted ? decryptJson<string>(user.mfaSecretEncrypted) : null;
}

/** Step 2: an authenticator code (or recovery code). Returns the user to start a session for. */
export async function verifyMfa(input: unknown): Promise<UserRow> {
  const { challengeToken, code } = parse(mfaVerifySchema, input);
  const user = await readChallenge(challengeToken, 'mfa');
  const secret = await mfaSecret(user);
  if (!secret || !user.mfaEnabledAt) {
    throw httpError('Set up your authenticator app first', 409);
  }

  if (/^\d{6}$/.test(code.replace(/\s/g, ''))) {
    const step = totp.verifyCode(secret, code);
    // Each code works once: refuse a step at or before the last one used.
    if (step !== null && (user.mfaLastStep === null || step > user.mfaLastStep)) {
      await db().update(users).set({ mfaLastStep: step }).where(eq(users.id, user.id));
      return recordSignIn(user, 'password');
    }
  } else if (await consumeRecoveryCode(user, code)) {
    await auditService.logEventSafely(
      {
        entityType: 'user',
        entityId: user.id,
        action: 'mfa_recovery_code_used',
        summary: 'Signed in with an MFA recovery code',
      },
      actorFor(user),
    );
    return recordSignIn(user, 'password');
  }

  await recordFailure(user);
  throw httpError('That code is not valid. Check your authenticator app and try again.', 401);
}

/** Enrolment step 1: a new secret (stored, not yet active) and its QR code. */
export async function startMfaEnrollment(input: unknown): Promise<MfaEnrollment> {
  const { challengeToken } = parse(challengeSchema, input);
  const user = await readChallenge(challengeToken, 'mfa_enroll');
  if (user.mfaEnabledAt) {
    throw httpError('Two-factor sign-in is already set up', 409);
  }
  const secret = totp.generateSecret();
  await db()
    .update(users)
    .set({ mfaSecretEncrypted: await encryptJson(secret), mfaLastStep: null })
    .where(eq(users.id, user.id));

  const issuer = getFirmBrand(currentFirm()).firmName;
  const url = totp.otpauthUrl(secret, user.email, issuer);
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return {
    secret,
    otpauthUrl: url,
    qrCodeDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
  };
}

function newRecoveryCode(): string {
  const raw = crypto.randomBytes(8).toString('hex').slice(0, 10);
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Enrolment step 2: confirm a code, activate MFA, issue recovery codes. */
export async function confirmMfaEnrollment(
  input: unknown,
): Promise<{ user: UserRow; recoveryCodes: string[] }> {
  const { challengeToken, code } = parse(mfaConfirmSchema, input);
  const user = await readChallenge(challengeToken, 'mfa_enroll');
  const secret = await mfaSecret(user);
  if (user.mfaEnabledAt) {
    throw httpError('Two-factor sign-in is already set up', 409);
  }
  if (!secret) {
    throw httpError('Start the set-up again', 409);
  }
  const step = totp.verifyCode(secret, code);
  if (step === null) {
    await recordFailure(user);
    throw httpError('That code is not valid. Check the time on your phone and try again.', 401);
  }

  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await db().delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, user.id));
  await db()
    .insert(mfaRecoveryCodes)
    .values(recoveryCodes.map((value) => ({ userId: user.id, codeHash: sha256(value) })));
  const [enabled] = await db()
    .update(users)
    .set({ mfaEnabledAt: new Date(), mfaLastStep: step })
    .where(eq(users.id, user.id))
    .returning();

  await auditService.logEventSafely(
    {
      entityType: 'user',
      entityId: user.id,
      action: 'mfa_enrolled',
      summary: 'Two-factor sign-in set up',
    },
    actorFor(user),
  );
  const signedIn = await recordSignIn(enabled ?? user, 'password');
  return { user: signedIn, recoveryCodes };
}

export function enrollmentResult(user: UserRow, recoveryCodes: string[]): MfaEnrollmentResult {
  return { user: toPublicUser(user), recoveryCodes };
}

// ---------------------------------------------------------------- signed-in actions

export async function changePassword(
  userId: string,
  sessionId: string,
  input: unknown,
): Promise<void> {
  const { currentPassword, newPassword } = parse(changePasswordSchema, input);
  const user = await findUserById(userId);
  if (!user) {
    throw httpError('Not signed in', 401);
  }
  if (!verifyPassword(currentPassword, user.passwordSalt, user.passwordHash)) {
    await recordFailure(user);
    throw httpError('Your current password is not correct', 400);
  }
  const passwordData = createPasswordHash(newPassword);
  await db()
    .update(users)
    .set({
      passwordHash: passwordData.hash,
      passwordSalt: passwordData.salt,
      passwordChangedAt: new Date(),
    })
    .where(eq(users.id, user.id));
  // Every other session ends; this one stays signed in.
  await sessionService.revokeUserSessions(user.id, sessionId);
  await auditService.logEventSafely(
    {
      entityType: 'user',
      entityId: user.id,
      action: 'password_changed',
      summary: 'Password changed',
    },
    actorFor(user),
  );
}

export async function getSessionUser(userId: string): Promise<PublicUser | null> {
  const user = await findUserById(userId);
  return user && user.isActive ? toPublicUser(user) : null;
}

// ---------------------------------------------------------------- request guards

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cookie-authenticated requests that change data must come from this
 * workspace's own pages (Origin check). With SameSite=Lax cookies this blocks
 * cross-site request forgery. Bearer-token clients are not affected.
 */
function assertSameOrigin(req: Request): void {
  if (SAFE_METHODS.has(req.method)) {
    return;
  }
  const origin = req.get('origin');
  if (!origin) {
    throw httpError('Missing Origin header', 403);
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw httpError('Invalid Origin header', 403);
  }
  if (originHost !== req.get('host')) {
    throw httpError('Cross-site request refused', 403);
  }
}

/** Requires a live session for this workspace; sets req.auth and the RLS principal. */
export function authenticateRequest(req: Request, _res: Response, next: NextFunction): void {
  (async () => {
    const presented = sessionService.presentedToken(req);
    if (!presented) {
      throw httpError('Not signed in', 401);
    }
    if (presented.viaCookie) {
      assertSameOrigin(req);
    }
    // Sessions live in the firm's own (RLS-protected) table: a token from
    // another workspace is simply not found.
    const active = await sessionService.findActiveSession(presented.token);
    if (!active) {
      throw httpError('Your session has ended. Please sign in again.', 401);
    }
    const { session, user } = active;
    req.auth = {
      userId: user.id,
      firmId: user.firmId,
      email: user.email,
      role: user.role as UserRole,
      fullName: user.fullName,
      sessionId: session.id,
      method: session.method as SignInMethod,
    };
    await setPrincipal({ id: user.id, role: user.role });
  })().then(
    () => next(),
    (error: unknown) =>
      next(error instanceof HttpError ? error : httpError(errorMessage(error), 500)),
  );
}

/** Requires every listed permission (see ROLE_PERMISSIONS in @ahava88/shared). */
export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const role = req.auth?.role;
    if (!role || !permissions.every((permission) => hasPermission(role, permission))) {
      next(httpError('Insufficient permissions', 403));
      return;
    }
    next();
  };
}

export function requireRoles(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      next(httpError('Insufficient permissions', 403));
      return;
    }
    next();
  };
}

export function getAuthConfig(): AuthConfig {
  const oidc = oidcSettings();
  return {
    passwordLogin: authSettings().passwordLogin,
    oidc: { enabled: Boolean(oidc), label: oidc?.label ?? '' },
    selfServiceReset: authSettings().passwordLogin && mailEnabled(),
  };
}
