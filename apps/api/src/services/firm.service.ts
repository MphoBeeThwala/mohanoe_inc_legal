// Firms (tenants): platform-level operations on the `firms` table.
//
// How a request finds its firm (resolveFirmForHost):
//   1. <slug>.<PLATFORM_BASE_DOMAIN>   e.g. nkosi.ahava-legal.co.za
//   2. a custom domain listed on the firm, e.g. portal.nkosilaw.co.za
//   3. otherwise DEFAULT_FIRM_SLUG (single-firm deployments, localhost).
//      When PLATFORM_BASE_DOMAIN is set and DEFAULT_FIRM_SLUG is not, unknown
//      hosts resolve to no firm at all, so they can never fall into a tenant.

import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { PLATFORM_LEGAL_NAME, isHexColor } from '@ahava88/shared';
import { rootDb } from '../db/client';
import { firms, type FirmRow } from '../db/schema';
import { withTenant } from '../db/tenant';
import { envFirmDefaults } from '../config/brand';
import { httpError } from '../lib/http';
import { parse } from '../validation/schemas';
import * as userService from './user.service';

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { firm: FirmRow | null; expires: number }>();

export function clearFirmCache(): void {
  cache.clear();
}

function baseDomain(): string | null {
  const value = String(process.env.PLATFORM_BASE_DOMAIN || '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '');
  return value || null;
}

function defaultSlug(): string | null {
  const configured = String(process.env.DEFAULT_FIRM_SLUG || '').trim();
  if (configured) {
    return configured;
  }
  return baseDomain() ? null : 'default';
}

export async function findFirmBySlug(slug: string): Promise<FirmRow | null> {
  const [firm] = await rootDb().select().from(firms).where(eq(firms.slug, slug)).limit(1);
  return firm ?? null;
}

export async function findFirmById(id: string): Promise<FirmRow | null> {
  const [firm] = await rootDb().select().from(firms).where(eq(firms.id, id)).limit(1);
  return firm ?? null;
}

async function findFirmByDomain(host: string): Promise<FirmRow | null> {
  const [firm] = await rootDb()
    .select()
    .from(firms)
    .where(sql`${host} = any(${firms.domains})`)
    .limit(1);
  return firm ?? null;
}

async function lookup(host: string): Promise<FirmRow | null> {
  const base = baseDomain();
  if (base && host.endsWith(`.${base}`)) {
    const slug = host.slice(0, -(base.length + 1));
    return slug && !slug.includes('.') ? findFirmBySlug(slug) : null;
  }
  const byDomain = await findFirmByDomain(host);
  if (byDomain) {
    return byDomain;
  }
  const fallback = defaultSlug();
  return fallback ? findFirmBySlug(fallback) : null;
}

export async function resolveFirmForHost(hostname: string): Promise<FirmRow | null> {
  const host = hostname.trim().toLowerCase().replace(/:\d+$/, '');
  const cached = cache.get(host);
  if (cached && cached.expires > Date.now()) {
    return cached.firm;
  }
  const firm = await lookup(host);
  cache.set(host, { firm, expires: Date.now() + CACHE_TTL_MS });
  return firm;
}

export const createFirmSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/, 'slug: lower-case letters, digits and dashes'),
  legalName: z.string().trim().min(1).max(300),
  tradingName: z.string().trim().min(1).max(300).optional(),
  productName: z.string().trim().max(100).optional(),
  casePrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,8}$/, 'casePrefix: 2–8 letters or digits')
    .default('MAT'),
  domains: z.array(z.string().trim().toLowerCase().min(3).max(253)).default([]),
  vatNumber: z.string().trim().max(30).optional(),
  plan: z.string().trim().max(40).default('pilot'),
  branding: z
    .object({
      logoUrl: z.url().nullable().optional(),
      primaryColor: z.string().refine(isHexColor, 'must be a #rrggbb colour').optional(),
      accentColor: z.string().refine(isHexColor, 'must be a #rrggbb colour').optional(),
    })
    .default({}),
});
export type CreateFirmInput = z.input<typeof createFirmSchema>;

export async function createFirm(input: CreateFirmInput): Promise<FirmRow> {
  const firm = parse(createFirmSchema, input);
  const [saved] = await rootDb()
    .insert(firms)
    .values({
      slug: firm.slug,
      legalName: firm.legalName,
      tradingName: firm.tradingName || firm.legalName,
      productName: firm.productName ?? null,
      casePrefix: firm.casePrefix,
      domains: firm.domains,
      vatNumber: firm.vatNumber ?? null,
      plan: firm.plan,
      branding: firm.branding,
    })
    .onConflictDoNothing({ target: firms.slug })
    .returning();
  if (!saved) {
    throw httpError(`A firm with slug "${firm.slug}" already exists`, 409);
  }
  clearFirmCache();
  return saved;
}

export async function listFirms(): Promise<FirmRow[]> {
  return rootDb().select().from(firms).orderBy(asc(firms.createdAt));
}

/**
 * Single-firm deployments: when there are no firms yet, create the default
 * firm from the FIRM_* environment variables, so a fresh install just works.
 * Returns the default firm, if there is one.
 */
export async function ensureDefaultFirm(): Promise<FirmRow | null> {
  const slug = defaultSlug();
  if (!slug) {
    return null;
  }
  const existing = await findFirmBySlug(slug);
  if (existing) {
    return existing;
  }
  const [{ count } = { count: 0 }] = await rootDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(firms);
  if (count > 0) {
    return null;
  }
  const defaults = envFirmDefaults();
  return createFirm({
    slug,
    legalName: defaults.firmName,
    tradingName: defaults.firmShortName,
    productName: defaults.productName,
    casePrefix: defaults.casePrefix,
    branding: {
      logoUrl: defaults.logoUrl,
      primaryColor: defaults.primaryColor,
      accentColor: defaults.accentColor,
    },
  });
}

/**
 * The firm's public address, used for links in invites and reset emails.
 * Never taken from a request's Host header.
 */
export function firmOrigin(firm: FirmRow): string {
  if (firm.domains[0]) {
    return `https://${firm.domains[0]}`;
  }
  const base = baseDomain();
  if (base) {
    return `https://${firm.slug}.${base}`;
  }
  return (process.env.APP_ORIGIN || 'http://localhost:3000').replace(/\/+$/, '');
}

/** Invites a firm administrator. Returns the invite link (shown once). */
export async function inviteFirmAdmin(
  firm: FirmRow,
  admin: { email: string; fullName: string },
): Promise<{ email: string; url: string; emailed: boolean }> {
  const issued = await withTenant(
    firm,
    () =>
      userService.createInvite(
        { email: admin.email, fullName: admin.fullName, role: 'admin' },
        { fullName: `${PLATFORM_LEGAL_NAME} onboarding`, role: 'system' },
      ),
    { system: true },
  );
  return { email: issued.item.email, url: issued.url, emailed: issued.emailed };
}
