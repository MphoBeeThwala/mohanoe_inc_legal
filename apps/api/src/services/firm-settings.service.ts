// Settings a firm's administrators manage themselves: retention, and
// Microsoft 365 staff sign-in. RLS lets a request update only its own firm's
// row, and the migration grants UPDATE on these columns only.
import { eq } from 'drizzle-orm';
import type { FirmSettings } from '@ahava88/shared';
import { z } from 'zod';
import { workforceAvailable } from '../config/auth';
import { db } from '../db/client';
import { currentFirm } from '../db/tenant-context';
import { firms } from '../db/schema';
import { httpError } from '../lib/http';
import type { Actor } from '../lib/actor';
import { parse } from '../validation/schemas';
import { clearFirmCache, firmOrigin } from './firm.service';
import { defaultRetentionDays } from './compliance.service';
import * as auditService from './audit.service';

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/, 'must be a domain such as nkosilaw.co.za');

const settingsSchema = z.object({
  // At least a year: closed matters are removed for good by the retention sweep.
  retentionDays: z.number().int().min(365).max(36_500).nullable().optional(),
  microsoft: z
    .object({
      tenantId: z
        .string()
        .trim()
        .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
          message: 'must be the directory (tenant) ID, a GUID',
        })
        .nullable(),
      domains: z.array(domain).max(20),
      enforced: z.boolean(),
    })
    .optional(),
});

function consentUrl(tenantId: string | null): string | null {
  const clientId = (process.env.ENTRA_WORKFORCE_CLIENT_ID || '').trim();
  if (!clientId) {
    return null;
  }
  const authority = (process.env.ENTRA_WORKFORCE_AUTHORITY || 'https://login.microsoftonline.com')
    .trim()
    .replace(/\/+$/, '');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${firmOrigin(currentFirm())}/api/auth/oidc/callback`,
  });
  return `${authority}/${tenantId || 'organizations'}/adminconsent?${params.toString()}`;
}

export function getSettings(): FirmSettings {
  const firm = currentFirm();
  return {
    retentionDays: firm.retentionDays ?? defaultRetentionDays(),
    retentionIsDefault: firm.retentionDays === null,
    microsoft: {
      available: workforceAvailable(),
      tenantId: firm.ssoTenantId,
      domains: firm.ssoDomains,
      enforced: firm.ssoEnforced,
      adminConsentUrl: consentUrl(firm.ssoTenantId),
    },
  };
}

export async function updateSettings(input: unknown, actor: Actor): Promise<FirmSettings> {
  const changes = parse(settingsSchema, input);
  const firm = currentFirm();
  const set: Partial<typeof firms.$inferInsert> = { updatedAt: new Date() };
  const details: Record<string, unknown> = {};

  if (changes.retentionDays !== undefined) {
    set.retentionDays = changes.retentionDays;
    details.retentionDays = changes.retentionDays;
  }
  if (changes.microsoft) {
    const { tenantId, domains, enforced } = changes.microsoft;
    if (enforced && (!tenantId || !domains.length || !workforceAvailable())) {
      throw httpError(
        'Microsoft sign-in can only be required once it is set up (directory ID and domains)',
        400,
      );
    }
    set.ssoTenantId = tenantId;
    set.ssoDomains = [...new Set(domains)];
    set.ssoEnforced = enforced;
    details.microsoft = { tenantId, domains: set.ssoDomains, enforced };
  }

  const [updated] = await db().update(firms).set(set).where(eq(firms.id, firm.id)).returning();
  clearFirmCache();
  if (updated) {
    Object.assign(firm, updated);
  }
  await auditService.logEvent(
    {
      entityType: 'firm',
      entityId: firm.id,
      action: 'firm_settings_updated',
      summary: changes.microsoft ? 'Sign-in settings changed' : 'Retention period changed',
      details,
    },
    actor,
  );
  return getSettings();
}
