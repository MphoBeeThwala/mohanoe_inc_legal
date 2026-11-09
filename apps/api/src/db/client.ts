// Database connection.
//
// - DATABASE_URL set  → PostgreSQL over node-postgres (production, staging,
//   any real database: Supabase today, Azure PostgreSQL later).
// - DATABASE_URL unset → PGlite, a real Postgres engine embedded in Node,
//   for local development and tests only. Production refuses to start
//   without DATABASE_URL (see config/env.ts).
//
// Call initDb() once at startup (server.ts, or the test setup), then use db().

import * as fs from 'fs';
import * as path from 'path';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Either the database or an open transaction. */
export type Executor = Db | Tx;

export const MIGRATIONS_FOLDER = path.resolve(__dirname, '..', '..', 'drizzle');

let current: { db: Db; close: () => Promise<void>; driver: 'postgres' | 'pglite' } | null = null;

function pgliteDataDir(): string {
  const configured = process.env.PGLITE_DATA_DIR;
  if (configured) {
    return configured;
  }
  // Persist local development data under the repo root (git-ignored).
  return path.resolve(__dirname, '..', '..', '..', '..', '.data', 'pglite');
}

async function connect(): Promise<NonNullable<typeof current>> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const pool = new Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_MAX || 10),
      ssl: process.env.DATABASE_SSL === 'false' ? false : undefined,
    });
    const db = drizzle({ client: pool, schema });
    if (process.env.DB_MIGRATE_ON_START !== 'false') {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    }
    return { db: db as unknown as Db, close: () => pool.end(), driver: 'postgres' };
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL must be set in production');
  }

  // Development/test only: loaded lazily so production never needs PGlite.
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const dataDir = pgliteDataDir();
  if (!dataDir.startsWith('memory://')) {
    // PGlite won't create missing parent folders on a fresh checkout.
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const client = new PGlite(dataDir);
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db: db as unknown as Db, close: () => client.close(), driver: 'pglite' };
}

export async function initDb(): Promise<Db> {
  if (!current) {
    current = await connect();
  }
  return current.db;
}

export function db(): Db {
  if (!current) {
    throw new Error('Database not initialised: call initDb() at startup');
  }
  return current.db;
}

export function dbDriver(): 'postgres' | 'pglite' | null {
  return current?.driver ?? null;
}

export async function closeDb(): Promise<void> {
  if (current) {
    const { close } = current;
    current = null;
    await close();
  }
}

/** True when the database answers a trivial query. Used by /ready. */
export async function pingDb(): Promise<boolean> {
  if (!current) {
    return false;
  }
  try {
    await current.db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}
