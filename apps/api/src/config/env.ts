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
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
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

  return problems;
}

function configWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = [];
  if (
    env.NODE_ENV === 'production' &&
    String(env.ALLOW_PUBLIC_REGISTRATION || '').toLowerCase() === 'true'
  ) {
    warnings.push(
      'ALLOW_PUBLIC_REGISTRATION is true in production: disable it once the first admin exists',
    );
  }
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

function requireSecret(name: string, devFallback: string): string {
  const value = process.env[name];
  if (value) {
    return value;
  }

  if (isProduction()) {
    throw httpError(`${name} must be set in production`, 500);
  }

  return devFallback;
}

export {
  REQUIRED_IN_PRODUCTION,
  assertConfig,
  configWarnings,
  isProduction,
  requireSecret,
  validateConfig,
};
