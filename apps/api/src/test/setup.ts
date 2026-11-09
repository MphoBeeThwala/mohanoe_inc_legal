// Runs before every test file (vitest.config.ts → setupFiles).
//
// Default: each file gets a fresh in-memory Postgres (PGlite) with all
// migrations applied, so tests exercise real SQL, constraints and cascades.
//
// TEST_DATABASE_URL=postgres://… runs the same suite against a real
// PostgreSQL server over the production driver. The database is wiped and
// re-migrated for each file, so point it at a disposable database only, and
// run with --no-file-parallelism (npm run test:postgres does both).
import { afterAll, beforeAll } from 'vitest';
import { closeDb, initDb } from '../db/client';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.DATABASE_SSL = process.env.DATABASE_SSL ?? 'false';
} else {
  delete process.env.DATABASE_URL;
  process.env.PGLITE_DATA_DIR = 'memory://';
}
process.env.ALLOW_PUBLIC_REGISTRATION = 'true';
process.env.LOG_HTTP = 'false';
process.env.FIRM_NAME = 'Nkosi & Partners Inc.';
process.env.FIRM_SHORT_NAME = 'Nkosi';
process.env.FIRM_CASE_PREFIX = 'NKP';
delete process.env.ANTHROPIC_API_KEY;

async function resetPostgres(url: string): Promise<void> {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('drop schema if exists drizzle cascade');
    await client.query('drop schema if exists public cascade');
    await client.query('create schema public');
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  if (testDatabaseUrl) {
    await resetPostgres(testDatabaseUrl);
  }
  await initDb();
});

afterAll(async () => {
  await closeDb();
});
