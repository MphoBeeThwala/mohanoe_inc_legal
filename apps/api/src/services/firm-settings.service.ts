// Settings a firm's administrators manage themselves: practice details,
// name, colours and numbering, invoicing, retention, FICA and Microsoft 365
// staff sign-in. RLS lets a request update only its own firm's
// row, and the migration grants UPDATE on these columns only.
import { eq } from 'drizzle-orm';
import {
  contrastRatio,
  MIN_BRAND_CONTRAST,
  type BillingSettings,
  type FirmBrandSettings,
  type FirmProfileSettings,
  type FirmSettings,
} from '@ahava88/shared';
import { z } from 'zod';
import { workforceAvailable } from '../config/auth';
import { getFirmBrand } from '../config/brand';
import { db } from '../db/client';
import { currentFirm } from '../db/tenant-context';
import { firms, type FirmRow } from '../db/schema';
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
  ficaEnforced: z.boolean().optional(),
  billing: z
    .object({
      vatRegistered: z.boolean().optional(),
      vatNumber: z
        .string()
        .trim()
        .regex(/^4\d{9}$/, 'must be a 10-digit SARS VAT number starting with 4')
        .nullable()
        .optional(),
      paymentTermsDays: z.number().int().min(0).max(365).optional(),
      address: z.string().trim().max(500).optional(),
      bankDetails: z.string().trim().max(500).optional(),
      invoiceFooter: z.string().trim().max(500).optional(),
      invoicePrefix: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{2,6}$/, 'must be 2 to 6 letters')
        .optional(),
    })
    .optional(),
  profile: z
    .object({
      registrationNumber: z.string().trim().max(40).optional(),
      lpcNumber: z.string().trim().max(40).optional(),
      fidelityFundCertificate: z.string().trim().max(60).optional(),
      email: z.union([z.literal(''), z.string().trim().toLowerCase().email()]).optional(),
      phone: z
        .string()
        .trim()
        .max(30)
        .regex(/^[+0-9 ()-]*$/, 'must be a phone number')
        .optional(),
      website: z
        .union([
          z.literal(''),
          z.string().trim().url().startsWith('https://', 'must start with https://'),
        ])
        .optional(),
      replyToEmail: z.union([z.literal(''), z.string().trim().toLowerCase().email()]).optional(),
    })
    .optional(),
  brand: z
    .object({
      legalName: z.string().trim().min(2).max(200).optional(),
      tradingName: z.string().trim().min(2).max(120).optional(),
      primaryColor: z
        .string()
        .trim()
        .regex(/^#[0-9a-f]{6}$/i, 'must be a colour such as #1f4e79')
        .optional(),
      accentColor: z
        .string()
        .trim()
        .regex(/^#[0-9a-f]{6}$/i, 'must be a colour such as #c8a24a')
        .optional(),
      casePrefix: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9]{2,8}$/, 'must be 2 to 8 letters or digits')
        .optional(),
    })
    .optional(),
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

export function billingSettings(firm: FirmRow): BillingSettings {
  const settings = firm.billingSettings ?? {};
  return {
    vatRegistered: settings.vatRegistered ?? true,
    vatNumber: firm.vatNumber,
    paymentTermsDays: settings.paymentTermsDays ?? 30,
    address: settings.address ?? '',
    bankDetails: settings.bankDetails ?? '',
    invoiceFooter: settings.invoiceFooter ?? '',
    invoicePrefix: settings.invoicePrefix ?? 'INV',
  };
}

export function profileSettings(firm: FirmRow): FirmProfileSettings {
  const profile = firm.profile ?? {};
  return {
    registrationNumber: profile.registrationNumber ?? '',
    lpcNumber: profile.lpcNumber ?? '',
    fidelityFundCertificate: profile.fidelityFundCertificate ?? '',
    email: profile.email ?? '',
    phone: profile.phone ?? '',
    website: profile.website ?? '',
    replyToEmail: profile.replyToEmail ?? '',
  };
}

export function brandSettings(firm: FirmRow): FirmBrandSettings {
  const brand = getFirmBrand(firm);
  return {
    legalName: firm.legalName,
    tradingName: firm.tradingName,
    primaryColor: brand.primaryColor,
    accentColor: brand.accentColor,
    casePrefix: brand.casePrefix,
    logoUrl: brand.logoUrl,
    iconUrl: firm.branding?.iconHash ? (brand.iconUrl ?? null) : null,
  };
}

export function getSettings(): FirmSettings {
  const firm = currentFirm();
  return {
    retentionDays: firm.retentionDays ?? defaultRetentionDays(),
    retentionIsDefault: firm.retentionDays === null,
    ficaEnforced: firm.ficaEnforced,
    billing: billingSettings(firm),
    profile: profileSettings(firm),
    brand: brandSettings(firm),
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
  if (changes.ficaEnforced !== undefined) {
    set.ficaEnforced = changes.ficaEnforced;
    details.ficaEnforced = changes.ficaEnforced;
  }
  if (changes.billing) {
    const { vatNumber, ...rest } = changes.billing;
    if (vatNumber !== undefined) {
      set.vatNumber = vatNumber;
    }
    set.billingSettings = { ...(firm.billingSettings ?? {}), ...rest };
    // Only which settings changed: addresses and bank details stay out of the audit trail.
    details.billing = Object.keys(changes.billing);
  }
  if (changes.profile) {
    set.profile = { ...(firm.profile ?? {}), ...changes.profile };
    details.profile = Object.keys(changes.profile);
  }
  if (changes.brand) {
    const { legalName, tradingName, primaryColor, accentColor, casePrefix } = changes.brand;
    for (const [label, colour] of [
      ['main colour', primaryColor],
      ['accent colour', accentColor],
    ] as const) {
      if (colour && contrastRatio(colour, '#ffffff') < MIN_BRAND_CONTRAST) {
        throw httpError(
          `The ${label} is too light for white text on it; choose a darker colour (contrast at least ${MIN_BRAND_CONTRAST}:1)`,
          400,
        );
      }
    }
    if (legalName) set.legalName = legalName;
    if (tradingName) set.tradingName = tradingName;
    if (casePrefix) set.casePrefix = casePrefix;
    if (primaryColor || accentColor) {
      set.branding = {
        ...(firm.branding ?? {}),
        ...(primaryColor ? { primaryColor } : {}),
        ...(accentColor ? { accentColor } : {}),
      };
    }
    details.brand = changes.brand;
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
      summary: changes.microsoft
        ? 'Sign-in settings changed'
        : changes.brand
          ? 'Firm name, colours or numbering changed'
          : changes.profile
            ? 'Practice details changed'
            : changes.billing
              ? 'Billing settings changed'
              : changes.ficaEnforced !== undefined
                ? 'FICA requirement changed'
                : 'Retention period changed',
      details,
    },
    actor,
  );
  return getSettings();
}
