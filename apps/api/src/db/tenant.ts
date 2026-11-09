// Running work as one firm.
//
// withTenant(firm, fn) opens a transaction, sets app.firm_id for it, and
// switches to the restricted app_tenant role (SET LOCAL ROLE), so every
// query inside fn is filtered by the row-level security policies, even if
// the connection user owns the tables. Nested calls to db().transaction()
// become savepoints inside it.
//
// Matter-level access (cases_matter_access and related RLS policies) also
// depends on who is asking: setPrincipal() records the signed-in user for the
// rest of the transaction; { system: true } (or elevateToSystem()) is for
// platform jobs and statutory compliance work that must see every matter.

import { sql } from 'drizzle-orm';
import { db, rootDb, type Tx } from './client';
import type { FirmRow } from './schema';
import { currentTenant, tenantStorage } from './tenant-context';

export const TENANT_ROLE = 'app_tenant';

async function enterTenant(tx: Tx, firm: FirmRow): Promise<void> {
  await tx.execute(sql`select set_config('app.firm_id', ${firm.id}, true)`);
  await tx.execute(sql.raw(`set local role ${TENANT_ROLE}`));
}

export interface TenantOptions {
  /** See every matter in the firm (platform jobs, CLI, compliance). */
  system?: boolean;
}

export async function withTenant<T>(
  firm: FirmRow,
  fn: () => Promise<T>,
  options: TenantOptions = {},
): Promise<T> {
  const hooks: Array<() => Promise<void>> = [];
  const result = await rootDb().transaction(async (tx) => {
    await enterTenant(tx, firm);
    if (options.system) {
      await tx.execute(sql`select set_config('app.principal', 'system', true)`);
    }
    return tenantStorage.run({ firm, tx, afterCommit: hooks }, fn);
  });
  for (const hook of hooks) {
    await hook().catch((error: unknown) =>
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'after_commit_failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }
  return result;
}

/** Records the signed-in user for matter-level RLS, for the rest of the transaction. */
export async function setPrincipal(user: { id: string; role: string }): Promise<void> {
  const tx = db();
  await tx.execute(sql`select set_config('app.user_id', ${user.id}, true)`);
  await tx.execute(sql`select set_config('app.user_role', ${user.role}, true)`);
}

/**
 * Lifts matter-level restrictions for the rest of the request. Only for
 * statutory work that must cover every matter (POPIA exports, erasure,
 * retention); callers must already have checked the permission and audit it.
 */
export async function elevateToSystem(): Promise<void> {
  await db().execute(sql`select set_config('app.principal', 'system', true)`);
}

/** Thrown inside a tenant transaction to roll it back on purpose. */
export class RollbackSignal extends Error {
  constructor() {
    super('rollback');
  }
}

/**
 * Runs fn with matter-level restrictions lifted, then restores the caller's
 * view. For checks that must look across every matter but only report
 * what the caller may see (conflict checks). fn must not return data from
 * matters the caller can't see.
 */
export async function withSystemScope<T>(fn: () => Promise<T>): Promise<T> {
  const tx = db();
  const result = (await tx.execute(
    sql`select coalesce(current_setting('app.principal', true), '') as principal`,
  )) as unknown as { rows: Array<{ principal: string }> };
  const previous = result.rows[0]?.principal ?? '';
  await tx.execute(sql`select set_config('app.principal', 'system', true)`);
  try {
    return await fn();
  } finally {
    await tx.execute(sql`select set_config('app.principal', ${previous}, true)`);
  }
}

/**
 * Runs fn in a savepoint of the request's transaction: if it throws, all of
 * its writes are undone, even when the request then answers with a 4xx
 * (which otherwise commits). Use it for multi-step changes that must happen
 * together, such as issuing an invoice with its number.
 */
export async function atomically<T>(fn: () => Promise<T>): Promise<T> {
  const tenant = currentTenant();
  if (!tenant) {
    throw new Error('No tenant context');
  }
  return tenant.tx.transaction((savepoint: Tx) =>
    tenantStorage.run({ ...tenant, tx: savepoint }, fn),
  );
}
