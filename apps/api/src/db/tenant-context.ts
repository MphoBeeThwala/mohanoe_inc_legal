// The per-request tenant context, carried through async calls with
// AsyncLocalStorage. Kept free of other imports to avoid cycles.
import { AsyncLocalStorage } from 'async_hooks';
import type { Tx } from './client';
import type { FirmRow } from './schema';

export interface TenantContext {
  firm: FirmRow;
  tx: Tx;
}

export const tenantStorage = new AsyncLocalStorage<TenantContext>();

export function currentTenant(): TenantContext | undefined {
  return tenantStorage.getStore();
}

/** The current firm. Throws outside a tenant context. */
export function currentFirm(): FirmRow {
  const tenant = tenantStorage.getStore();
  if (!tenant) {
    throw new Error('No tenant context');
  }
  return tenant.firm;
}
