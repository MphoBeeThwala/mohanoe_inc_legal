const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getSupabaseClient } = require('../config/supabase');
const auditService = require('./audit.service');

const memory = {
  users: [],
};

function getJwtSecret() {
  return process.env.JWT_SECRET || 'mohanoe-dev-secret';
}

function getAdminSeedToken() {
  return process.env.ADMIN_SEED_TOKEN || process.env.BOOTSTRAP_ADMIN_TOKEN || '';
}

function isPublicRegistrationEnabled() {
  return String(process.env.ALLOW_PUBLIC_REGISTRATION || '').toLowerCase() === 'true';
}

function normalizeRole(role) {
  const normalized = String(role || 'attorney').trim().toLowerCase();
  const allowedRoles = new Set(['admin', 'attorney', 'paralegal']);
  if (!allowedRoles.has(normalized)) {
    const error = new Error('Role must be admin, attorney, or paralegal');
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    salt,
    hash: hashPassword(password, salt),
  };
}

function verifyPassword(password, salt, expectedHash) {
  return hashPassword(password, salt) === expectedHash;
}

function signToken(user) {
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
      issuer: 'mohanoe-inc-legal',
      expiresIn: process.env.JWT_EXPIRES_IN || '12h',
    },
  );
}

function toPublicUser(user) {
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

async function findUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const users = await readUsers();
  return users.find((user) => String(user.email).trim().toLowerCase() === normalized) || null;
}

async function findUserById(id) {
  const users = await readUsers();
  return users.find((user) => String(user.id) === String(id)) || null;
}

async function saveUser(record) {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db.from('users').insert(record).select().single();
    if (error) {
      throw error;
    }

    return data;
  }

  memory.users.push(record);
  return record;
}

async function updateUser(id, patch) {
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

async function registerUser(input, options = {}) {
  const fullName = String(input.fullName || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const password = String(input.password || '');
  const role = options.allowRoleOverride
    ? normalizeRole(options.role || input.role || 'attorney')
    : 'attorney';
  const passwordLength = password.length;

  if (!fullName || !email || !password) {
    const error = new Error('fullName, email, and password are required');
    error.statusCode = 400;
    throw error;
  }

  if (!options.allowRoleOverride && !isPublicRegistrationEnabled()) {
    const error = new Error('Public registration is disabled');
    error.statusCode = 403;
    throw error;
  }

  if (passwordLength < 12) {
    const error = new Error('Password must be at least 12 characters long');
    error.statusCode = 400;
    throw error;
  }

  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
    const error = new Error('Password must include upper-case, lower-case, and a number');
    error.statusCode = 400;
    throw error;
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    const error = new Error('A user with that email already exists');
    error.statusCode = 409;
    throw error;
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

async function loginUser(input) {
  const email = String(input.email || '').trim().toLowerCase();
  const password = String(input.password || '');

  if (!email || !password) {
    const error = new Error('email and password are required');
    error.statusCode = 400;
    throw error;
  }

  const user = await findUserByEmail(email);
  if (!user || user.is_active === false) {
    const error = new Error('Invalid credentials');
    error.statusCode = 401;
    throw error;
  }

  if (!verifyPassword(password, user.password_salt, user.password_hash)) {
    const error = new Error('Invalid credentials');
    error.statusCode = 401;
    throw error;
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

async function getSessionUser(userId) {
  const user = await findUserById(userId);
  return toPublicUser(user);
}

function authenticateRequest(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      const error = new Error('Missing bearer token');
      error.statusCode = 401;
      throw error;
    }

    const decoded = jwt.verify(token, getJwtSecret(), {
      issuer: 'mohanoe-inc-legal',
    });

    req.auth = {
      userId: decoded.sub,
      email: decoded.email,
      role: decoded.role,
      fullName: decoded.fullName,
    };

    next();
  } catch (error) {
    error.statusCode = error.statusCode || 401;
    next(error);
  }
}

function requireRoles(...roles) {
  return (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      const error = new Error('Insufficient permissions');
      error.statusCode = 403;
      next(error);
      return;
    }

    next();
  };
}

function requireAdminSeedAccess(req, _res, next) {
  const setupToken = getAdminSeedToken();
  const providedToken =
    req.headers['x-admin-seed-token'] ||
    req.headers['x-setup-token'] ||
    req.body?.adminSeedToken ||
    req.body?.setupToken;

  if (setupToken && providedToken && String(providedToken) === setupToken) {
    next();
    return;
  }

  authenticateRequest(req, _res, (authError) => {
    if (authError) {
      const error = new Error(
        setupToken
          ? 'Admin seed token is required'
          : 'Admin seeding requires an authenticated admin or ADMIN_SEED_TOKEN',
      );
      error.statusCode = 401;
      next(error);
      return;
    }

    if (req.auth?.role !== 'admin') {
      const error = new Error('Only admins can seed admin users');
      error.statusCode = 403;
      next(error);
      return;
    }

    next();
  });
}

async function seedDefaultUsers() {
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

module.exports = {
  authenticateRequest,
  getSessionUser,
  loginUser,
  isPublicRegistrationEnabled,
  registerUser,
  requireAdminSeedAccess,
  requireRoles,
  seedDefaultUsers,
  signToken,
};
