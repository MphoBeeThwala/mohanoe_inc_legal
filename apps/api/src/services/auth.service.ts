import crypto from 'crypto';
import { count, eq } from 'drizzle-orm';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import type { AuthConfig, AuthResult, PublicUser, UserRole } from '@ahava88/shared';
import { HttpError, errorMessage, httpError } from '../lib/http';
import { requireSecret } from '../config/env';
import { db } from '../db/client';
import { currentFirm } from '../db/tenant-context';
import { users, type UserRow } from '../db/schema';
import { iso, isoOrNull } from '../lib/time';
import { loginSchema, parse, registerSchema } from '../validation/schemas';
import * as auditService from './audit.service';

const JWT_ISSUER = process.env.JWT_ISSUER || 'ahava88-legal-pms';

function getJwtSecret() {
  return requireSecret('JWT_SECRET', 'local-development-jwt-secret');
}

function isPublicRegistrationEnabled() {
  return String(process.env.ALLOW_PUBLIC_REGISTRATION || '').toLowerCase() === 'true';
}

function isSeedAdminOnStartupEnabled() {
  return String(process.env.SEED_ADMIN_ON_STARTUP || '').toLowerCase() === 'true';
}

function hashPassword(password: string, salt: string) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createPasswordHash(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    salt,
    hash: hashPassword(password, salt),
  };
}

// Compared against when the email is unknown, so a failed login takes the
// same time whether or not the account exists (no user enumeration).
const DUMMY_CREDENTIALS = createPasswordHash(crypto.randomBytes(16).toString('hex'));

function verifyPassword(password: string, salt: string, expectedHash: string) {
  if (!salt || !expectedHash) {
    return false;
  }

  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(String(expectedHash), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function signToken(user: UserRow): string {
  return jwt.sign(
    {
      sub: user.id,
      firmId: user.firmId,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
    },
    getJwtSecret(),
    {
      algorithm: 'HS256',
      issuer: JWT_ISSUER,
      expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as SignOptions['expiresIn'],
    },
  );
}

function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role as UserRole,
    createdAt: iso(user.createdAt),
    lastLoginAt: isoOrNull(user.lastLoginAt),
  };
}

async function findUserByEmail(email: string): Promise<UserRow | null> {
  const normalized = email.trim().toLowerCase();
  const [user] = await db().select().from(users).where(eq(users.email, normalized)).limit(1);
  return user ?? null;
}

async function findUserById(id: string): Promise<UserRow | null> {
  const [user] = await db().select().from(users).where(eq(users.id, id)).limit(1);
  return user ?? null;
}

async function userCount(): Promise<number> {
  const [row] = await db().select({ value: count() }).from(users);
  return row?.value ?? 0;
}

interface RegisterOptions {
  /** Bypass the public-registration switch and set the role (admin seeding). */
  role?: UserRole;
}

async function registerUser(input: unknown, options: RegisterOptions = {}): Promise<AuthResult> {
  const { fullName, email, password } = parse(registerSchema, input);

  if (!options.role && !isPublicRegistrationEnabled()) {
    throw httpError('Public registration is disabled', 403);
  }

  if (await findUserByEmail(email)) {
    throw httpError('A user with that email already exists', 409);
  }

  // Bootstrap: a firm's first account is its admin.
  const role: UserRole = options.role ?? ((await userCount()) === 0 ? 'admin' : 'attorney');
  const passwordData = createPasswordHash(password);
  const [saved] = await db()
    .insert(users)
    .values({
      email,
      fullName,
      role,
      passwordHash: passwordData.hash,
      passwordSalt: passwordData.salt,
    })
    .onConflictDoNothing({ target: [users.firmId, users.email] })
    .returning();
  if (!saved) {
    throw httpError('A user with that email already exists', 409);
  }

  await auditService.logEventSafely(
    {
      entityType: 'user',
      entityId: saved.id,
      action: 'user_registered',
      summary: `User registered: ${saved.email}`,
      details: { role: saved.role },
    },
    { userId: saved.id, email: saved.email, fullName: saved.fullName, role: saved.role },
  );
  return {
    user: toPublicUser(saved),
    token: signToken(saved),
  };
}

async function loginUser(input: unknown): Promise<AuthResult> {
  const { email, password } = parse(loginSchema, input);

  const user = await findUserByEmail(email);
  const credentials = user
    ? { salt: user.passwordSalt, hash: user.passwordHash }
    : DUMMY_CREDENTIALS;
  const passwordOk = verifyPassword(password, credentials.salt, credentials.hash);
  if (!user || !user.isActive || !passwordOk) {
    throw httpError('Invalid credentials', 401);
  }

  const [updated] = await db()
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id))
    .returning();
  const current = updated ?? user;

  await auditService.logEventSafely(
    {
      entityType: 'user',
      entityId: user.id,
      action: 'user_logged_in',
      summary: `User logged in: ${user.email}`,
    },
    { userId: user.id, email: user.email, fullName: user.fullName, role: user.role },
  );

  return {
    user: toPublicUser(current),
    token: signToken(current),
  };
}

async function getSessionUser(userId: string): Promise<PublicUser | null> {
  const user = await findUserById(userId);
  return user && user.isActive ? toPublicUser(user) : null;
}

interface SessionClaims extends JwtPayload {
  sub: string;
  firmId: string;
  email: string;
  role: UserRole;
  fullName: string;
}

function authenticateRequest(req: Request, _res: Response, next: NextFunction): void {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      throw httpError('Missing bearer token', 401);
    }

    const decoded = jwt.verify(token, getJwtSecret(), {
      issuer: JWT_ISSUER,
    });
    if (typeof decoded === 'string' || !decoded.sub) {
      throw httpError('Invalid session token', 401);
    }
    const claims = decoded as SessionClaims;
    // A session is only valid on its own firm's workspace.
    if (!claims.firmId || claims.firmId !== currentFirm().id) {
      throw httpError('Session belongs to another workspace', 401);
    }

    req.auth = {
      userId: claims.sub,
      firmId: claims.firmId,
      email: claims.email,
      role: claims.role,
      fullName: claims.fullName,
    };

    next();
  } catch (error) {
    // Any verification failure (expired, bad signature, wrong issuer) is a 401.
    next(error instanceof HttpError ? error : httpError(errorMessage(error), 401));
  }
}

function requireRoles(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      next(httpError('Insufficient permissions', 403));
      return;
    }

    next();
  };
}

// Set SEED_ADMIN_ON_STARTUP=true with DEFAULT_ADMIN_EMAIL / DEFAULT_ADMIN_PASSWORD
// to provision the default firm's admin on server boot. Must run inside that
// firm's tenant context (server.ts does this).
async function seedDefaultUsers(): Promise<PublicUser | null> {
  if (!isSeedAdminOnStartupEnabled()) {
    return null;
  }

  const seedEmail = process.env.DEFAULT_ADMIN_EMAIL;
  const seedPassword = process.env.DEFAULT_ADMIN_PASSWORD;
  const seedName = process.env.DEFAULT_ADMIN_NAME || 'Practice Admin';

  if (!seedEmail || !seedPassword) {
    return null;
  }

  const existing = await findUserByEmail(seedEmail);
  if (existing) {
    return toPublicUser(existing);
  }

  const created = await registerUser(
    { fullName: seedName, email: seedEmail, password: seedPassword },
    { role: 'admin' },
  );
  return created.user;
}

function getAuthConfig(): AuthConfig {
  return {
    publicRegistration: isPublicRegistrationEnabled(),
    seedAdminOnStartup: isSeedAdminOnStartupEnabled(),
  };
}

export {
  authenticateRequest,
  getAuthConfig,
  getSessionUser,
  loginUser,
  isPublicRegistrationEnabled,
  isSeedAdminOnStartupEnabled,
  registerUser,
  requireRoles,
  seedDefaultUsers,
  signToken,
};
