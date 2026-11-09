import { withTenant } from '../db/tenant';
import { findFirmBySlug } from '../services/firm.service';

/** Runs fn as the default firm (created by setup.ts), like a request would. */
export async function inDefaultFirm<T>(fn: () => Promise<T>): Promise<T> {
  const firm = await findFirmBySlug('default');
  if (!firm) {
    throw new Error('Default firm missing: is src/test/setup.ts loaded?');
  }
  return withTenant(firm, fn);
}
