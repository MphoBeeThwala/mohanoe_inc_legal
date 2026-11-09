import type { DbRow, RequestBody } from '../types/db';
import { HttpError, errorMessage, httpError } from '../lib/http';
import crypto from 'crypto';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { type AuthConfig, type AuthResult, type PublicUser, type UserRole } from '@ahava88/shared';
import { getSupabaseClient } from '../config/supabase';
import * as auditService from './audit.service';
import { requireSecret } from '../config/env';

const JWT_ISSUER = process.env.JWT_ISSUER || 'ahava88-legal-pms';

const memory: Record<string, DbRow[]> = {
  users: [],
};

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

function verifyPassword(password: string, salt: string, expectedHash: string) {
  if (!salt || !expectedHash) {
    return false;
  }

  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(String(expectedHash), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function signToken(user: DbRow): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      fullName: user.full_name,
    },
    getJwtSecret(),
    {
      algorithm: 'HS256',
      issuer: JWT_ISSUER,
      expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as SignOptions['expiresIn'],
    },
  );
}

function toPublicUser(user: DbRow): PublicUser;
function toPublicUser(user: DbRow | null | undefined): PublicUser | null;
function toPublicUser(user: DbRow | null | undefined): PublicUser | null {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at || null,
  };
}

async function readUsers() {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db.from('users').select('*').order('created_at');
    if (error) {
      throw error;
    }

    return data || [];
  }

  return [...memory.users];
}

async function findUserByEmail(email: string) {
  const normalized = String(email || '').trim().toLowerCase();
  const users = await readUsers();
  return users.find((user) => String(user.email).trim().toLowerCase() === normalized) || null;
}

async function findUserById(id: string) {
  const users = await readUsers();
  return users.find((user) => String(user.id) === String(id)) || null;
}

async function saveUser(record: DbRow) {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db.from('users').insert(record).select().single();
    if (error) {
      console.error('[auth] users insert failed:', {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
      });
      throw error;
    }

    return data;
  }

  memory.users.push(record);
  return record;
}

async function updateUser(id: string, patch: RequestBody) {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db
      .from('users')
      .update(patch)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return data;
  }

  const index = memory.users.findIndex((user) => String(user.id) === String(id));
  if (index >= 0) {
    memory.users[index] = { ...memory.users[index], ...patch };
    return memory.users[index];
  }

  return null;
}

async function registerUser(input: RequestBody, options: RequestBody = {}): Promise<AuthResult> {
  const fullName = String(input.fullName || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const password = String(input.password || '');
  const role = options.allowRoleOverride
    ? String(options.role || input.role || 'attorney').trim()
    : 'attorney';
  const passwordLength = password.length;

  if (!fullName || !email || !password) {
    throw httpError('fullName, email, and password are required', 400);
  }

  if (!options.allowRoleOverride && !isPublicRegistrationEnabled()) {
    throw httpError('Public registration is disabled', 403);
  }

  if (passwordLength < 12) {
    throw httpError('Password must be at least 12 characters long', 400);
  }

  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
    throw httpError('Password must include upper-case, lower-case, and a number', 400);
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    throw httpError('A user with that email already exists', 409);
  }

  const passwordData = createPasswordHash(password);
  const user = {
    id: crypto.randomUUID(),
    email,
    full_name: fullName,
    role,
    password_hash: passwordData.hash,
    password_salt: passwordData.salt,
    is_active: true,
    created_at: new Date().toISOString(),
    last_login_at: null,
  };

  const saved = await saveUser(user);
  await auditService
    .logEvent(
      {
        entityType: 'user',
        entityId: saved.id,
        action: 'user_registered',
        summary: `User registered: ${saved.email}`,
      },
      { userId: saved.id, email: saved.email, fullName: saved.full_name, role: saved.role },
    )
    .catch(() => {});
  return {
    user: toPublicUser(saved),
    token: signToken(saved),
  };
}

async function loginUser(input: RequestBody): Promise<AuthResult> {
  const email = String(input.email || '').trim().toLowerCase();
  const password = String(input.password || '');

  if (!email || !password) {
    throw httpError('email and password are required', 400);
  }

  const user = await findUserByEmail(email);
  if (!user || user.is_active === false) {
    throw httpError('Invalid credentials', 401);
  }

  if (!verifyPassword(password, user.password_salt, user.password_hash)) {
    throw httpError('Invalid credentials', 401);
  }

  const updated = await updateUser(user.id, {
    last_login_at: new Date().toISOString(),
  });
  await auditService
    .logEvent(
      {
        entityType: 'user',
        entityId: user.id,
        action: 'user_logged_in',
        summary: `User logged in: ${user.email}`,
      },
      { userId: user.id, email: user.email, fullName: user.full_name, role: user.role },
    )
    .catch(() => {});

  return {
    user: toPublicUser(updated || user),
    token: signToken(updated || user),
  };
}

async function getSessionUser(userId: string) {
  const user = await findUserById(userId);
  return toPublicUser(user);
}

interface SessionClaims extends JwtPayload {
  sub: string;
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

    req.auth = {
      userId: claims.sub,
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

// TODO(later-stage): enable SEED_ADMIN_ON_STARTUP=true with DEFAULT_ADMIN_* env vars
// to auto-provision the initial admin account on server boot.
async function seedDefaultUsers() {
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

  const created = await registerUser({
    fullName: seedName,
    email: seedEmail,
    password: seedPassword,
  }, {
    allowRoleOverride: true,
    role: 'admin',
  });

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
