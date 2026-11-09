import { test } from 'vitest';
import assert from 'node:assert/strict';
import { configWarnings, devSecretsAllowed, requireSecret, validateConfig } from '../config/env';

const goodProduction: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  JWT_SECRET: 'x'.repeat(48),
  INTAKE_ENCRYPTION_KEY: 'a'.repeat(64),
  AUDIT_CHAIN_SECRET: 'y'.repeat(48),
  DATABASE_URL: 'postgres://app:secret@db.example.com:5432/practice',
};

test('development config never blocks startup', () => {
  assert.deepEqual(validateConfig({ NODE_ENV: 'development' }), []);
});

test('complete production config passes', () => {
  assert.deepEqual(validateConfig(goodProduction), []);
});

test('production refuses missing secrets', () => {
  const { JWT_SECRET, INTAKE_ENCRYPTION_KEY, ...rest } = goodProduction;
  const problems = validateConfig(rest);
  assert.ok(problems.includes('JWT_SECRET is not set'));
  assert.ok(problems.includes('INTAKE_ENCRYPTION_KEY is not set'));
});

test('production refuses placeholder and short secrets', () => {
  const problems = validateConfig({
    ...goodProduction,
    JWT_SECRET: 'replace-with-a-long-random-secret',
    AUDIT_CHAIN_SECRET: 'short',
  });
  assert.ok(problems.includes('JWT_SECRET still has its placeholder value'));
  assert.ok(problems.some((p) => p.startsWith('AUDIT_CHAIN_SECRET must be at least')));
});

test('public registration in production is a warning, not a blocker', () => {
  const env = { ...goodProduction, ALLOW_PUBLIC_REGISTRATION: 'true' };
  assert.deepEqual(validateConfig(env), []);
  assert.equal(configWarnings(env).length, 1);
});

test('development fallback secrets are refused against a real database', () => {
  const saved = { url: process.env.DATABASE_URL, secret: process.env.SOME_TEST_SECRET };
  delete process.env.SOME_TEST_SECRET;
  try {
    delete process.env.DATABASE_URL;
    assert.equal(devSecretsAllowed(), true);
    assert.equal(requireSecret('SOME_TEST_SECRET', 'dev'), 'dev');
    process.env.DATABASE_URL = 'postgres://example/db';
    assert.equal(devSecretsAllowed(), false);
    assert.throws(() => requireSecret('SOME_TEST_SECRET', 'dev'), /when DATABASE_URL is set/);
  } finally {
    if (saved.url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.url;
  }
});
