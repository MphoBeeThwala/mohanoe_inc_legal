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

test('retired sign-up settings and missing SMTP are warnings, not blockers', () => {
  const env = { ...goodProduction, ALLOW_PUBLIC_REGISTRATION: 'true' };
  assert.deepEqual(validateConfig(env), []);
  const warnings = configWarnings(env);
  assert.ok(
    warnings.some((warning) => /ALLOW_PUBLIC_REGISTRATION is no longer used/.test(warning)),
  );
  assert.ok(warnings.some((warning) => /SMTP_URL is not set/.test(warning)));
  assert.deepEqual(
    configWarnings({
      ...goodProduction,
      SMTP_URL: 'smtp://mail',
      KEY_PROVIDER: 'azure-keyvault',
      AZURE_KEY_VAULT_KEY_ID: 'https://v.vault.azure.net/keys/k',
      OBJECT_STORE: 'azure-blob',
      AZURE_STORAGE_ACCOUNT_URL: 'https://acct.blob.core.windows.net',
      PAYFAST_MERCHANT_ID: '10000100',
      PAYFAST_MERCHANT_KEY: 'key',
      PAYFAST_PASSPHRASE: 'passphrase',
      AI_PROVIDER: 'foundry',
      AI_ENDPOINT: 'https://firm-ai.services.ai.azure.com/anthropic',
      AI_MODEL: 'claude-sonnet',
    }),
    [],
  );
});

test('production refuses insecure identity settings', () => {
  const problems = validateConfig({
    ...goodProduction,
    OIDC_ISSUER: 'http://login.example/v2.0',
    SESSION_COOKIE_SECURE: 'false',
  });
  assert.ok(problems.includes('OIDC_CLIENT_ID must be set when OIDC_ISSUER is set'));
  assert.ok(problems.includes('OIDC_ISSUER must be an https:// URL'));
  assert.ok(problems.includes('SESSION_COOKIE_SECURE cannot be false in production'));
  const storage = validateConfig({
    ...goodProduction,
    KEY_PROVIDER: 'azure-keyvault',
    OBJECT_STORE: 'azure-blob',
  });
  assert.ok(
    storage.includes('AZURE_KEY_VAULT_KEY_ID must be set when KEY_PROVIDER=azure-keyvault'),
  );
  assert.ok(storage.some((problem) => problem.startsWith('OBJECT_STORE=azure-blob needs')));
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

test('PayFast settings come as a set; sandbox and missing PayFast are warnings', () => {
  assert.ok(
    validateConfig({ ...goodProduction, PAYFAST_MERCHANT_ID: '10000100' }).some((problem) =>
      /PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY and PAYFAST_PASSPHRASE together/.test(problem),
    ),
  );
  const payfast = {
    ...goodProduction,
    PAYFAST_MERCHANT_ID: '10000100',
    PAYFAST_MERCHANT_KEY: 'key',
    PAYFAST_PASSPHRASE: 'passphrase',
  };
  assert.deepEqual(validateConfig(payfast), []);
  assert.ok(configWarnings(goodProduction).some((w) => /PayFast is not configured/.test(w)));
  assert.ok(
    configWarnings({ ...payfast, PAYFAST_SANDBOX: 'true' }).some((w) => /PayFast sandbox/.test(w)),
  );
});

test('AI settings must be complete for the chosen provider', () => {
  const problems = (extra: Record<string, string>) =>
    validateConfig({ ...goodProduction, ...extra });
  assert.ok(problems({ AI_PROVIDER: 'foundry', AI_MODEL: 'm' }).some((p) => /AI_ENDPOINT/.test(p)));
  assert.ok(
    problems({
      AI_PROVIDER: 'foundry',
      AI_ENDPOINT: 'https://x.services.ai.azure.com/anthropic',
    }).some((p) => /AI_MODEL/.test(p)),
  );
  assert.ok(problems({ AI_PROVIDER: 'openai' }).some((p) => /AI_PROVIDER must be/.test(p)));
  assert.deepEqual(
    problems({
      AI_PROVIDER: 'foundry',
      AI_ENDPOINT: 'https://x.services.ai.azure.com/anthropic',
      AI_MODEL: 'claude-sonnet',
    }),
    [],
  );
  assert.ok(configWarnings(goodProduction).some((w) => /AI is not configured/.test(w)));
});
