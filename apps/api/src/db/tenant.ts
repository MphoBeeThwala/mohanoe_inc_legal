// Running work as one firm.
//
// withTenant(firm, fn) opens a transaction, sets app.firm_id for it, and
// switches to the restricted app_tenant role (SET LOCAL ROLE), so every
// query inside fn is filtered by the row-level security policies, even if
// the connection user owns the tables. Nested calls to db().transaction()
// become savepoints inside it.

import { sql } from 'drizzle-orm';
import { rootDb, type Tx } from './client';
import type { FirmRow } from './schema';
import { tenantStorage } from './tenant-context';

export const TENANT_ROLE = 'app_tenant';

async function enterTenant(tx: Tx, firm: FirmRow): Promise<void> {
  await tx.execute(sql`select set_config('app.firm_id', ${firm.id}, true)`);
  await tx.execute(sql.raw(`set local role ${TENANT_ROLE}`));
}

export async function withTenant<T>(firm: FirmRow, fn: () => Promise<T>): Promise<T> {
  return rootDb().transaction(async (tx) => {
    await enterTenant(tx, firm);
    return tenantStorage.run({ firm, tx }, fn);
  });
}

/** Thrown inside a tenant transaction to roll it back on purpose. */
export class RollbackSignal extends Error {
  constructor() {
    super('rollback');
  }
}
