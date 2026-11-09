// The per-request tenant context, carried through async calls with
// AsyncLocalStorage. Kept free of other imports to avoid cycles.
import { AsyncLocalStorage } from 'async_hooks';
import type { Tx } from './client';
import type { FirmRow } from './schema';

export interface TenantContext {
  firm: FirmRow;
  tx: Tx;
  /** Work to do only once the transaction has committed (e.g. deleting blobs). */
  afterCommit: Array<() => Promise<void>>;
}

export const tenantStorage = new AsyncLocalStorage<TenantContext>();

export function currentTenant(): TenantContext | undefined {
  return tenantStorage.getStore();
}

/**
 * Runs fn after the current tenant transaction commits (never if it rolls
 * back). Failures are logged, not thrown: the database change already stands.
 */
export function afterCommit(fn: () => Promise<void>): void {
  const tenant = tenantStorage.getStore();
  if (!tenant) {
    throw new Error('No tenant context');
  }
  tenant.afterCommit.push(fn);
}

/** The current firm. Throws outside a tenant context. */
export function currentFirm(): FirmRow {
  const tenant = tenantStorage.getStore();
  if (!tenant) {
    throw new Error('No tenant context');
  }
  return tenant.firm;
}
