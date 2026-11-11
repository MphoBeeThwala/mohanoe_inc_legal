// Staff accounts: invites (the only way in), administration, password resets.
//
// Links in emails always use the firm's own address (firmOrigin), never the
// request's Host header, so a forged Host cannot redirect a reset link.
import { and, asc, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type {
  Invite,
  InvitePreview,
  LinkIssued,
  StaffDirectoryEntry,
  StaffUser,
  UserRole,
} from '@ahava88/shared';
import { authSettings } from '../config/auth';
import { getFirmBrand } from '../config/brand';
import { db } from '../db/client';
import { currentFirm } from '../db/tenant-context';
import { invites, passwordResets, users, type InviteRow, type UserRow } from '../db/schema';
import { httpError } from '../lib/http';
import type { Actor } from '../lib/actor';
import { iso } from '../lib/time';
import { randomToken, sha256 } from '../lib/tokens';
import {
  acceptInviteSchema,
  forgotPasswordSchema,
  inviteSchema,
  parse,
  resetPasswordSchema,
  userUpdateSchema,
  uuidSchema,
} from '../validation/schemas';
import { firmOrigin } from './firm.service';
import { sendMail } from './mail.service';
import * as authService from './auth.service';
import * as sessionService from './session.service';
import * as auditService from './audit.service';
import * as subscriptions from './subscription.service';

// ---------------------------------------------------------------- invites

function inviteStatus(row: InviteRow): Invite['status'] {
  if (row.acceptedAt) return 'accepted';
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt.getTime() <= Date.now()) return 'expired';
  return 'pending';
}

function toInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    role: row.role as UserRole,
    status: inviteStatus(row),
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
  };
}

export async function createInvite(input: unknown, actor: Actor): Promise<LinkIssued<Invite>> {
  const invite = parse(inviteSchema, input);
  if (await authService.findUserByEmail(invite.email)) {
    throw httpError('A staff member with that email already exists', 409);
  }
  // A replacement invite for the same address doesn't need another seat.
  const [samePending] = await db()
    .select({ id: invites.id })
    .from(invites)
    .where(
      and(
        eq(invites.email, invite.email),
        isNull(invites.acceptedAt),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!samePending) {
    await subscriptions.assertSeatAvailable();
  }
  // A new invite replaces any pending one for the same address.
  await db()
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(invites.email, invite.email), isNull(invites.acceptedAt), isNull(invites.revokedAt)),
    );

  const token = randomToken();
  const [saved] = await db()
    .insert(invites)
    .values({
      email: invite.email,
      fullName: invite.fullName,
      role: invite.role,
      tokenHash: sha256(token),
      invitedBy: actor.userId ?? null,
      expiresAt: new Date(Date.now() + authSettings().inviteDays * 86_400_000),
    })
    .returning();
  if (!saved) {
    throw new Error('Invite was not stored');
  }

  const firm = currentFirm();
  const brand = getFirmBrand(firm);
  const url = `${firmOrigin(firm)}/invite/${token}`;
  const emailed = await sendMail({
    to: saved.email,
    subject: `You're invited to ${brand.firmName}`,
    text: [
      `Hello ${saved.fullName},`,
      '',
      `${actor.fullName || 'An administrator'} has invited you to ${brand.firmName}'s ${brand.productName}.`,
      `Accept the invitation within ${authSettings().inviteDays} days:`,
      url,
      '',
      'You will set a password and connect an authenticator app (two-factor sign-in).',
    ].join('\n'),
  });

  await auditService.logEventSafely(
    {
      entityType: 'invite',
      entityId: saved.id,
      action: 'staff_invited',
      summary: `Staff member invited as ${saved.role}`,
      details: { role: saved.role, emailed },
    },
    actor,
  );
  return { item: toInvite(saved), url, emailed };
}

export async function listInvites(): Promise<Invite[]> {
  const rows = await db().select().from(invites).orderBy(desc(invites.createdAt)).limit(200);
  return rows.map(toInvite);
}

export async function revokeInvite(id: string, actor: Actor): Promise<Invite> {
  const [row] = await db()
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(invites.id, parse(uuidSchema, id)),
        isNull(invites.acceptedAt),
        isNull(invites.revokedAt),
      ),
    )
    .returning();
  if (!row) {
    throw httpError('Invite not found or no longer pending', 404);
  }
  await auditService.logEventSafely(
    { entityType: 'invite', entityId: row.id, action: 'invite_revoked', summary: 'Invite revoked' },
    actor,
  );
  return toInvite(row);
}

async function pendingInvite(token: string): Promise<InviteRow> {
  const [row] = await db()
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.tokenHash, sha256(token)),
        isNull(invites.acceptedAt),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) {
    throw httpError(
      'This invitation is invalid or has expired. Ask your administrator for a new one.',
      404,
    );
  }
  return row;
}

export async function previewInvite(token: string): Promise<InvitePreview> {
  const row = await pendingInvite(token);
  return {
    email: row.email,
    fullName: row.fullName,
    role: row.role as UserRole,
    firmName: getFirmBrand(currentFirm()).firmName,
    expiresAt: iso(row.expiresAt),
  };
}

interface NewAccount {
  passwordHash?: string;
  passwordSalt?: string;
  oidcIssuer?: string;
  oidcSubject?: string;
  fullName?: string;
}

async function createAccountFromInvite(row: InviteRow, account: NewAccount): Promise<UserRow> {
  const [claimed] = await db()
    .update(invites)
    .set({ acceptedAt: new Date() })
    .where(and(eq(invites.id, row.id), isNull(invites.acceptedAt)))
    .returning({ id: invites.id });
  if (!claimed) {
    throw httpError('This invitation has already been used', 409);
  }
  const now = new Date();
  const [user] = await db()
    .insert(users)
    .values({
      email: row.email,
      fullName: account.fullName || row.fullName,
      role: row.role,
      passwordHash: account.passwordHash ?? null,
      passwordSalt: account.passwordSalt ?? null,
      passwordChangedAt: account.passwordHash ? now : null,
      oidcIssuer: account.oidcIssuer ?? null,
      oidcSubject: account.oidcSubject ?? null,
    })
    .onConflictDoNothing({ target: [users.firmId, users.email] })
    .returning();
  if (!user) {
    throw httpError('A staff member with that email already exists', 409);
  }
  await auditService.logEventSafely(
    {
      entityType: 'user',
      entityId: user.id,
      action: 'invite_accepted',
      summary: `Staff account created (${user.role})`,
      details: { inviteId: row.id, method: account.oidcSubject ? 'oidc' : 'password' },
    },
    authService.actorFor(user),
  );
  return user;
}

/** Accepts an invite with a password. MFA enrolment follows before any session. */
export async function acceptInviteWithPassword(token: string, input: unknown): Promise<UserRow> {
  const { fullName, password } = parse(acceptInviteSchema, input);
  const row = await pendingInvite(token);
  const passwordData = authService.createPasswordHash(password);
  return createAccountFromInvite(row, {
    fullName,
    passwordHash: passwordData.hash,
    passwordSalt: passwordData.salt,
  });
}

/** Accepts an invite by linking an Entra External ID identity. */
export async function acceptInviteWithOidc(
  token: string,
  identity: { issuer: string; subject: string; name?: string },
): Promise<UserRow> {
  const row = await pendingInvite(token);
  return createAccountFromInvite(row, {
    oidcIssuer: identity.issuer,
    oidcSubject: identity.subject,
    fullName: identity.name,
  });
}

// ---------------------------------------------------------------- staff administration

function toStaffUser(user: UserRow): StaffUser {
  return {
    ...authService.toPublicUser(user),
    isActive: user.isActive,
    lockedUntil: user.lockedUntil && user.lockedUntil > new Date() ? iso(user.lockedUntil) : null,
    targetHoursPerMonth: user.targetHoursPerMonth,
  };
}

export async function listUsers(): Promise<StaffUser[]> {
  const rows = await db().select().from(users).orderBy(asc(users.fullName)).limit(1_000);
  return rows.map(toStaffUser);
}

/** Active staff, for pickers. No email addresses. */
export async function directory(): Promise<StaffDirectoryEntry[]> {
  const rows = await db()
    .select({ id: users.id, fullName: users.fullName, role: users.role })
    .from(users)
    .where(and(eq(users.isActive, true), ne(users.role, 'support')))
    .orderBy(asc(users.fullName))
    .limit(1_000);
  return rows.map((row) => ({ ...row, role: row.role as UserRole }));
}

async function requireUser(id: string): Promise<UserRow> {
  const user = await authService.findUserById(parse(uuidSchema, id));
  if (!user) {
    throw httpError('Staff member not found', 404);
  }
  return user;
}

async function otherActiveAdmins(userId: string): Promise<number> {
  const [row] = await db()
    .select({ value: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.isActive, true), ne(users.id, userId)));
  return row?.value ?? 0;
}

export async function updateUser(id: string, input: unknown, actor: Actor): Promise<StaffUser> {
  const changes = parse(userUpdateSchema, input);
  const user = await requireUser(id);
  if (user.role === 'support') {
    throw httpError('Platform support accounts are controlled by support grants', 400);
  }
  // Administrators may set their own target hours, but not their own role or access.
  if (user.id === actor.userId && (changes.role !== undefined || changes.isActive !== undefined)) {
    throw httpError('You cannot change your own role or deactivate yourself', 400);
  }
  const losesAdmin =
    user.role === 'admin' &&
    user.isActive &&
    ((changes.role && changes.role !== 'admin') || changes.isActive === false);
  if (losesAdmin && (await otherActiveAdmins(user.id)) === 0) {
    throw httpError('A firm must keep at least one active administrator', 400);
  }

  if (changes.isActive === true && !user.isActive) {
    await subscriptions.assertSeatAvailable();
  }

  const [updated] = await db()
    .update(users)
    .set({
      ...(changes.role ? { role: changes.role } : {}),
      ...(changes.isActive !== undefined ? { isActive: changes.isActive } : {}),
      ...(changes.isActive ? { failedLoginCount: 0, lockedUntil: null } : {}),
      ...(changes.targetHoursPerMonth !== undefined
        ? { targetHoursPerMonth: changes.targetHoursPerMonth }
        : {}),
    })
    .where(eq(users.id, user.id))
    .returning();
  if (!updated) {
    throw httpError('Staff member not found', 404);
  }
  if (changes.isActive === false) {
    await sessionService.revokeUserSessions(user.id);
  }
  await auditService.logEventSafely(
    {
      entityType: 'user',
      entityId: user.id,
      action: 'user_updated',
      summary: 'Staff member updated',
      details: {
        ...(changes.role ? { role: { from: user.role, to: changes.role } } : {}),
        ...(changes.isActive !== undefined ? { isActive: changes.isActive } : {}),
        ...(changes.targetHoursPerMonth !== undefined
          ? { targetHoursPerMonth: changes.targetHoursPerMonth }
          : {}),
      },
    },
    actor,
  );
  return toStaffUser(updated);
}

/** Clears a user's authenticator (lost phone): they enrol again at next sign-in. */
export async function resetMfa(id: string, actor: Actor): Promise<StaffUser> {
  const user = await requireUser(id);
  const [updated] = await db()
    .update(users)
    .set({ mfaSecretEncrypted: null, mfaEnabledAt: null, mfaLastStep: null })
    .where(eq(users.id, user.id))
    .returning();
  await sessionService.revokeUserSessions(user.id);
  await auditService.logEventSafely(
    {
      entityType: 'user',
      entityId: user.id,
      action: 'mfa_reset',
      summary: 'Two-factor sign-in reset by an administrator',
    },
    actor,
  );
  return toStaffUser(updated ?? user);
}

export async function revokeSessions(id: string, actor: Actor): Promise<{ revoked: number }> {
  const user = await requireUser(id);
  const revoked = await sessionService.revokeUserSessions(user.id);
  await auditService.logEventSafely(
    {
      entityType: 'user',
      entityId: user.id,
      action: 'sessions_revoked',
      summary: 'All sessions signed out',
      details: { revoked },
    },
    actor,
  );
  return { revoked };
}

// ---------------------------------------------------------------- password resets

async function issueReset(user: UserRow): Promise<{ url: string; emailed: boolean }> {
  await db()
    .update(passwordResets)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));
  const token = randomToken();
  await db()
    .insert(passwordResets)
    .values({
      userId: user.id,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + authSettings().resetMinutes * 60_000),
    });
  const firm = currentFirm();
  const url = `${firmOrigin(firm)}/reset-password/${token}`;
  const emailed = await sendMail({
    to: user.email,
    subject: `Reset your ${getFirmBrand(firm).firmName} password`,
    text: [
      `Hello ${user.fullName},`,
      '',
      `Use this link within ${authSettings().resetMinutes} minutes to choose a new password:`,
      url,
      '',
      'If you did not ask for this, ignore this email; your password has not changed.',
    ].join('\n'),
  });
  return { url, emailed };
}

/** Admin-issued reset link (shown to the admin; also emailed when mail is set up). */
export async function adminPasswordReset(id: string, actor: Actor): Promise<LinkIssued<StaffUser>> {
  const user = await requireUser(id);
  if (!user.passwordHash) {
    throw httpError(
      'This staff member signs in with Microsoft; there is no password to reset',
      400,
    );
  }
  const { url, emailed } = await issueReset(user);
  await auditService.logEventSafely(
    {
      entityType: 'user',
      entityId: user.id,
      action: 'password_reset_issued',
      summary: 'Password reset link issued by an administrator',
      details: { emailed },
    },
    actor,
  );
  return { item: toStaffUser(user), url, emailed };
}

/** Self-service "forgot password": always succeeds, so it never reveals who has an account. */
export async function requestPasswordReset(input: unknown): Promise<void> {
  const { email } = parse(forgotPasswordSchema, input);
  const user = await authService.findUserByEmail(email);
  if (!user || !user.isActive || !user.passwordHash) {
    return;
  }
  const { emailed } = await issueReset(user);
  await auditService.logEventSafely(
    {
      entityType: 'user',
      entityId: user.id,
      action: 'password_reset_requested',
      summary: 'Password reset requested',
      details: { emailed },
    },
    authService.actorFor(user),
  );
}

/** Sets a new password from a reset link; ends every session and lifts any lock. */
export async function completePasswordReset(token: string, input: unknown): Promise<void> {
  const { password } = parse(resetPasswordSchema, input);
  const [reset] = await db()
    .update(passwordResets)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(passwordResets.tokenHash, sha256(token)),
        isNull(passwordResets.usedAt),
        gt(passwordResets.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!reset) {
    throw httpError('This reset link is invalid or has expired', 404);
  }
  const user = await authService.findUserById(reset.userId);
  if (!user || !user.isActive) {
    throw httpError('This reset link is invalid or has expired', 404);
  }
  const passwordData = authService.createPasswordHash(password);
  await db()
    .update(users)
    .set({
      passwordHash: passwordData.hash,
      passwordSalt: passwordData.salt,
      passwordChangedAt: new Date(),
      failedLoginCount: 0,
      lockedUntil: null,
    })
    .where(eq(users.id, user.id));
  await sessionService.revokeUserSessions(user.id);
  await auditService.logEventSafely(
    {
      entityType: 'user',
      entityId: user.id,
      action: 'password_reset_completed',
      summary: 'Password reset completed',
    },
    authService.actorFor(user),
  );
}
