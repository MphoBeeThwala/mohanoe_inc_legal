// Settings a firm's administrators manage themselves.
import { eq } from 'drizzle-orm';
import type { FirmSettings } from '@ahava88/shared';
import { z } from 'zod';
import { db } from '../db/client';
import { currentFirm } from '../db/tenant-context';
import { firms } from '../db/schema';
import type { Actor } from '../lib/actor';
import { parse } from '../validation/schemas';
import { clearFirmCache } from './firm.service';
import { defaultRetentionDays } from './compliance.service';
import * as auditService from './audit.service';

// At least a year: closed matters are removed for good by the retention sweep.
const settingsSchema = z.object({
  retentionDays: z.number().int().min(365).max(36_500).nullable(),
});

export function getSettings(): FirmSettings {
  const firm = currentFirm();
  return {
    retentionDays: firm.retentionDays ?? defaultRetentionDays(),
    retentionIsDefault: firm.retentionDays === null,
  };
}

export async function updateSettings(input: unknown, actor: Actor): Promise<FirmSettings> {
  const { retentionDays } = parse(settingsSchema, input);
  const firm = currentFirm();
  // RLS lets a request update only its own firm's row (and only these columns).
  const [updated] = await db()
    .update(firms)
    .set({ retentionDays, updatedAt: new Date() })
    .where(eq(firms.id, firm.id))
    .returning();
  clearFirmCache();
  if (updated) {
    Object.assign(firm, updated);
  }
  await auditService.logEvent(
    {
      entityType: 'firm',
      entityId: firm.id,
      action: 'firm_settings_updated',
      summary: 'Retention period changed',
      details: { retentionDays },
    },
    actor,
  );
  return getSettings();
}
