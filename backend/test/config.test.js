const test = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig, configWarnings } = require('../config/env');

const goodProduction = {
  NODE_ENV: 'production',
  JWT_SECRET: 'x'.repeat(48),
  INTAKE_ENCRYPTION_KEY: 'a'.repeat(64),
  AUDIT_CHAIN_SECRET: 'y'.repeat(48),
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
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
