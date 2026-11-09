import { httpError } from '../lib/http';
// Startup configuration checks.
//
// In production the server must refuse to start without real secrets and a
// real datastore. Silent fallbacks (development keys, in-memory storage) are
// only allowed outside production.

export class ConfigError extends Error {
  readonly code = 'INVALID_CONFIG';
}

const REQUIRED_IN_PRODUCTION = [
  'JWT_SECRET',
  'INTAKE_ENCRYPTION_KEY',
  'AUDIT_CHAIN_SECRET',
  'DATABASE_URL',
];

const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER = /^replace-with/i;

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function validateConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];

  if (env.NODE_ENV !== 'production') {
    return problems;
  }

  REQUIRED_IN_PRODUCTION.forEach((name) => {
    const value = String(env[name] || '').trim();
    if (!value) {
      problems.push(`${name} is not set`);
    } else if (PLACEHOLDER.test(value)) {
      problems.push(`${name} still has its placeholder value`);
    }
  });

  ['JWT_SECRET', 'AUDIT_CHAIN_SECRET'].forEach((name) => {
    const value = String(env[name] || '').trim();
    if (value && value.length < MIN_SECRET_LENGTH) {
      problems.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
    }
  });

  if (String(env.OIDC_ISSUER || '').trim()) {
    if (!String(env.OIDC_CLIENT_ID || '').trim()) {
      problems.push('OIDC_CLIENT_ID must be set when OIDC_ISSUER is set');
    }
    if (!/^https:\/\//i.test(String(env.OIDC_ISSUER))) {
      problems.push('OIDC_ISSUER must be an https:// URL');
    }
  }
  if (env.KEY_PROVIDER === 'azure-keyvault' && !String(env.AZURE_KEY_VAULT_KEY_ID || '').trim()) {
    problems.push('AZURE_KEY_VAULT_KEY_ID must be set when KEY_PROVIDER=azure-keyvault');
  }
  if (env.KEY_PROVIDER && !['local', 'azure-keyvault'].includes(env.KEY_PROVIDER)) {
    problems.push('KEY_PROVIDER must be local or azure-keyvault');
  }
  if (
    env.OBJECT_STORE === 'azure-blob' &&
    !String(env.AZURE_STORAGE_ACCOUNT_URL || env.AZURE_STORAGE_CONNECTION_STRING || '').trim()
  ) {
    problems.push(
      'OBJECT_STORE=azure-blob needs AZURE_STORAGE_ACCOUNT_URL or AZURE_STORAGE_CONNECTION_STRING',
    );
  }
  if (env.OBJECT_STORE && !['filesystem', 'azure-blob'].includes(env.OBJECT_STORE)) {
    problems.push('OBJECT_STORE must be filesystem or azure-blob');
  }
  if (String(env.SESSION_COOKIE_SECURE || '').toLowerCase() === 'false') {
    problems.push('SESSION_COOKIE_SECURE cannot be false in production');
  }

  return problems;
}

function configWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = [];
  if (env.NODE_ENV !== 'production') {
    return warnings;
  }
  if (!String(env.SMTP_URL || '').trim()) {
    warnings.push(
      'SMTP_URL is not set: invite and reset links are shown to administrators but not emailed',
    );
  }
  if ((env.KEY_PROVIDER || 'local') === 'local') {
    warnings.push(
      'KEY_PROVIDER is local: firm keys are wrapped with INTAKE_ENCRYPTION_KEY, not Azure Key Vault',
    );
  }
  if (!env.OBJECT_STORE) {
    warnings.push(
      'OBJECT_STORE is not set: documents stay in the database and audit anchors have no immutable copy',
    );
  } else if (env.OBJECT_STORE === 'filesystem') {
    warnings.push(
      'OBJECT_STORE=filesystem in production: make sure OBJECT_STORE_DIR is persistent',
    );
  }
  ['ALLOW_PUBLIC_REGISTRATION', 'SEED_ADMIN_ON_STARTUP', 'DEFAULT_ADMIN_PASSWORD'].forEach(
    (name) => {
      if (env[name]) {
        warnings.push(`${name} is no longer used: staff join by invite (see README)`);
      }
    },
  );
  return warnings;
}

function assertConfig(env: NodeJS.ProcessEnv = process.env): void {
  const problems = validateConfig(env);
  if (problems.length) {
    throw new ConfigError(
      `Refusing to start: invalid production configuration\n - ${problems.join('\n - ')}`,
    );
  }
}

/**
 * Development fallback secrets are only safe with the embedded development
 * database. Against any real database (DATABASE_URL), a fallback key would
 * silently encrypt data or sign audit events with a key the server doesn't
 * share, so the real secrets are required everywhere outside local dev.
 */
function devSecretsAllowed(): boolean {
  return !isProduction() && !process.env.DATABASE_URL;
}

function requireSecret(name: string, devFallback: string): string {
  const value = process.env[name];
  if (value) {
    return value;
  }

  if (!devSecretsAllowed()) {
    throw httpError(
      `${name} must be set ${isProduction() ? 'in production' : 'when DATABASE_URL is set'}`,
      500,
    );
  }

  return devFallback;
}

export {
  REQUIRED_IN_PRODUCTION,
  assertConfig,
  configWarnings,
  devSecretsAllowed,
  isProduction,
  requireSecret,
  validateConfig,
};
