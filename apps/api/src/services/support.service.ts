// Platform support access.
//
// Ahava on 88 support staff (platform operators) have no standing access to
// any firm. A firm administrator opens a support grant (1–72 hours, with a
// reason). While a grant is active, an operator can sign in at that firm's
// address with their email, password and authenticator code. They get a
// read-only session as the firm's "Platform support" stand-in account:
//   - role 'support' (read-only permissions; restricted matters and ethical
//     walls still apply, because RLS treats them like any non-admin);
//   - the session ends when the grant expires or is revoked;
//   - every request they make is written to the firm's audit trail.
// Operators are managed with `npm run ops -w apps/api -- operator …`.
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { PLATFORM_LEGAL_NAME, type SupportGrant } from '@ahava88/shared';
import { authSettings } from '../config/auth';
import { db, rootDb } from '../db/client';
import { withTenant } from '../db/tenant';
import { currentFirm } from '../db/tenant-context';
import {
  platformOperators,
  sessions,
  supportGrants,
  users,
  type PlatformOperatorRow,
  type SessionRow,
  type SupportGrantRow,
  type UserRow,
} from '../db/schema';
import { httpError, sendError } from '../lib/http';
import type { Actor } from '../lib/actor';
import { iso, isoOrNull } from '../lib/time';
import * as totp from '../lib/totp';
import { email, parse } from '../validation/schemas';
import { legacyKey } from './keys.service';
import { createPasswordHash, verifyPassword } from './auth.service';
import { resolveFirmForHost } from './firm.service';
import * as sessionService from './session.service';
import * as auditService from './audit.service';

// ---------------------------------------------------------------- platform secrets

const PLATFORM_AAD = Buffer.from('ahava88:platform-operator:v1');

function platformKey(): Buffer {
  const key = legacyKey();
  if (!key) {
    throw new Error('INTAKE_ENCRYPTION_KEY must be set to manage platform operators');
  }
  return key;
}

function seal(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', platformKey(), iv);
  cipher.setAAD(PLATFORM_AAD);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString('base64')).join('.');
}

function open(sealed: string): string {
  const [iv, tag, body] = sealed.split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', platformKey(), iv!);
  decipher.setAAD(PLATFORM_AAD);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(body!), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------- operators (CLI)

export interface NewOperator {
  email: string;
  password: string;
  secret: string;
  otpauthUrl: string;
}

export async function createOperator(input: {
  email: string;
  fullName: string;
}): Promise<NewOperator> {
  const address = parse(email, input.email);
  // Satisfies the password policy: upper, lower, digit, 20+ characters.
  const password = `Aa1-${randomBytes(18).toString('base64url')}`;
  const passwordData = createPasswordHash(password);
  const secret = totp.generateSecret();
  const [saved] = await rootDb()
    .insert(platformOperators)
    .values({
      email: address,
      fullName: input.fullName,
      passwordHash: passwordData.hash,
      passwordSalt: passwordData.salt,
      mfaSecretEncrypted: seal(secret),
    })
    .onConflictDoNothing()
    .returning();
  if (!saved) {
    throw new Error(`An operator with email ${address} already exists`);
  }
  return {
    email: saved.email,
    password,
    secret,
    otpauthUrl: totp.otpauthUrl(secret, saved.email, `${PLATFORM_LEGAL_NAME} support`),
  };
}

export async function listOperators(): Promise<PlatformOperatorRow[]> {
  return rootDb().select().from(platformOperators).orderBy(platformOperators.email);
}

export async function setOperatorActive(address: string, isActive: boolean): Promise<boolean> {
  const updated = await rootDb()
    .update(platformOperators)
    .set({ isActive, failedLoginCount: 0, lockedUntil: null })
    .where(eq(platformOperators.email, address.trim().toLowerCase()))
    .returning({ id: platformOperators.id });
  return updated.length > 0;
}

// ---------------------------------------------------------------- grants (firm admins)

const grantSchema = z.object({
  hours: z.coerce.number().int().min(1).max(72),
  reason: z.string().trim().min(3).max(300),
});

function toGrant(row: SupportGrantRow, grantedBy: string | null): SupportGrant {
  const status = row.revokedAt ? 'revoked' : row.expiresAt > new Date() ? 'active' : 'expired';
  return {
    id: row.id,
    reason: row.reason,
    grantedBy,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    revokedAt: isoOrNull(row.revokedAt),
    status,
  };
}

export async function listGrants(): Promise<SupportGrant[]> {
  const rows = await db()
    .select({ grant: supportGrants, grantedBy: users.fullName })
    .from(supportGrants)
    .leftJoin(users, eq(users.id, supportGrants.grantedBy))
    .orderBy(desc(supportGrants.createdAt))
    .limit(50);
  return rows.map((row) => toGrant(row.grant, row.grantedBy));
}

export async function createGrant(input: unknown, actor: Actor): Promise<SupportGrant> {
  const { hours, reason } = parse(grantSchema, input);
  const [saved] = await db()
    .insert(supportGrants)
    .values({
      reason,
      grantedBy: actor.userId ?? null,
      expiresAt: new Date(Date.now() + hours * 3_600_000),
    })
    .returning();
  if (!saved) {
    throw new Error('Grant was not stored');
  }
  await auditService.logEvent(
    {
      entityType: 'support',
      entityId: saved.id,
      action: 'support_access_granted',
      summary: `Platform support access granted for ${hours} hour(s)`,
      details: { hours, reason },
    },
    actor,
  );
  return toGrant(saved, actor.fullName ?? null);
}

async function supportUsers(): Promise<UserRow[]> {
  return db().select().from(users).where(eq(users.role, 'support'));
}

/** Ends every support session in the firm and deactivates the stand-in accounts. */
async function endSupportSessions(): Promise<void> {
  for (const user of await supportUsers()) {
    await sessionService.revokeUserSessions(user.id);
    await db().update(users).set({ isActive: false }).where(eq(users.id, user.id));
  }
}

export async function revokeGrant(id: string, actor: Actor): Promise<SupportGrant> {
  const [revoked] = await db()
    .update(supportGrants)
    .set({ revokedAt: new Date(), revokedBy: actor.userId ?? null })
    .where(and(eq(supportGrants.id, id), isNull(supportGrants.revokedAt)))
    .returning();
  if (!revoked) {
    throw httpError('Grant not found or already revoked', 404);
  }
  if (!(await activeGrant())) {
    await endSupportSessions();
  }
  await auditService.logEvent(
    {
      entityType: 'support',
      entityId: revoked.id,
      action: 'support_access_revoked',
      summary: 'Platform support access revoked',
    },
    actor,
  );
  return toGrant(revoked, null);
}

/** The current firm's active grant that ends last, if any. */
export async function activeGrant(): Promise<SupportGrantRow | null> {
  const [row] = await db()
    .select()
    .from(supportGrants)
    .where(and(isNull(supportGrants.revokedAt), gt(supportGrants.expiresAt, new Date())))
    .orderBy(desc(supportGrants.expiresAt))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------- operator sign-in

const signInSchema = z.object({
  email,
  password: z.string().min(1).max(200),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app'),
});

const REFUSED =
  'Support sign-in refused: check your details, and that the firm has granted access.';

export async function authenticateOperator(input: unknown): Promise<PlatformOperatorRow> {
  const { email: address, password, code } = parse(signInSchema, input);
  const [operator] = await rootDb()
    .select()
    .from(platformOperators)
    .where(eq(platformOperators.email, address))
    .limit(1);
  const passwordOk = verifyPassword(
    password,
    operator?.passwordSalt ?? null,
    operator?.passwordHash ?? null,
  );
  const locked = Boolean(operator?.lockedUntil && operator.lockedUntil > new Date());
  const step =
    operator && passwordOk ? totp.verifyCode(open(operator.mfaSecretEncrypted), code) : null;
  const fresh = step !== null && (operator?.mfaLastStep == null || step > operator.mfaLastStep);

  if (!operator || !operator.isActive || locked || !passwordOk || !fresh) {
    if (operator && operator.isActive && !locked) {
      const settings = authSettings();
      const failures = operator.failedLoginCount + 1;
      const lock = failures >= settings.maxFailedAttempts;
      await rootDb()
        .update(platformOperators)
        .set({
          failedLoginCount: lock ? 0 : failures,
          lockedUntil: lock ? new Date(Date.now() + settings.lockoutMinutes * 60_000) : null,
        })
        .where(eq(platformOperators.id, operator.id));
    }
    throw httpError(REFUSED, 401);
  }
  await rootDb()
    .update(platformOperators)
    .set({ failedLoginCount: 0, lockedUntil: null, mfaLastStep: step })
    .where(eq(platformOperators.id, operator.id));
  return operator;
}

/** The firm's stand-in account for an operator, created on first use. */
async function standInUser(operator: PlatformOperatorRow): Promise<UserRow> {
  const values = {
    email: `support+${operator.id}@platform.invalid`,
    fullName: `${operator.fullName} (${PLATFORM_LEGAL_NAME} support)`,
    role: 'support',
    platformOperatorId: operator.id,
    isActive: true,
  };
  const [user] = await db()
    .insert(users)
    .values(values)
    .onConflictDoUpdate({
      target: [users.firmId, users.email],
      set: { fullName: values.fullName, role: 'support', isActive: true },
    })
    .returning();
  if (!user) {
    throw new Error('Support account was not stored');
  }
  return user;
}

/**
 * POST /api/support/sign-in. Mounted before the tenant middleware: the
 * operator is checked against the platform table first (outside any firm's
 * transaction), then the firm's grant and session are handled inside it.
 */
export async function signInHandler(req: Request, res: Response): Promise<void> {
  try {
    const firm = await resolveFirmForHost(req.hostname || '');
    if (!firm || firm.status !== 'active') {
      throw httpError('Unknown workspace', 404);
    }
    const operator = await authenticateOperator(req.body);
    const { user, expiresAt } = await withTenant(firm, async () => {
      const grant = await activeGrant();
      if (!grant) {
        await auditService.logEventSafely(
          {
            entityType: 'support',
            action: 'support_sign_in_refused',
            summary: 'Platform support sign-in refused: no active grant',
            details: { operatorId: operator.id },
          },
          { fullName: `${PLATFORM_LEGAL_NAME} support`, role: 'system' },
        );
        return { user: null, expiresAt: null };
      }
      const stand = await standInUser(operator);
      await sessionService.createSession(stand, 'support', req, res, grant.expiresAt);
      await auditService.logEvent(
        {
          entityType: 'support',
          entityId: grant.id,
          action: 'support_signed_in',
          summary: `${operator.fullName} (platform support) signed in`,
          details: { operatorId: operator.id, grantId: grant.id },
        },
        { userId: stand.id, fullName: stand.fullName, role: 'support' },
      );
      return { user: stand, expiresAt: grant.expiresAt };
    });
    if (!user || !expiresAt) {
      throw httpError(REFUSED, 403);
    }
    res.status(200).json({ status: 'signed_in', expiresAt: iso(expiresAt) });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Called for every request made with a support session: the grant must still
 * be active, and the request is recorded in the firm's audit trail.
 */
export async function checkSupportRequest(req: Request, session: SessionRow, user: UserRow) {
  const grant = await activeGrant();
  if (!grant) {
    await db().update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session.id));
    throw httpError('Support access has ended', 401);
  }
  const path = `${req.baseUrl}${req.path}`.replace(/(.)\/+$/, '$1');
  await auditService.logEvent(
    {
      entityType: 'support',
      entityId: grant.id,
      action: 'support_request',
      summary: `Platform support: ${req.method} ${path}`,
      details: { method: req.method, path, firm: currentFirm().slug },
    },
    { userId: user.id, fullName: user.fullName, role: 'support' },
  );
}
