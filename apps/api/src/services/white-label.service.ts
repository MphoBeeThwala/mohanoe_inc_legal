// White label: the firm's logo and browser icon, custom domains, and the
// onboarding checklist.
//
// Logos are business information, not personal information, and are served
// before sign-in, so they are stored as they are (no encryption). Only PNG,
// JPEG and WebP are accepted, checked by their first bytes: SVG is refused
// because it can carry script.
//
// A custom domain is used only once it is proven twice: a DNS TXT record
// shows the firm controls it, and an HTTPS request to it reaches this
// platform (so its certificate and routing work). Until then email links keep
// using the firm's platform address.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { and, eq, ne, sql } from 'drizzle-orm';
import {
  ONBOARDING_LABELS,
  ONBOARDING_STEPS,
  type FirmAssetKind,
  type FirmDomain,
  type OnboardingStatus,
  type OnboardingStep,
} from '@ahava88/shared';
import { z } from 'zod';
import { db, rootDb } from '../db/client';
import { withTenant } from '../db/tenant';
import { currentFirm } from '../db/tenant-context';
import { firmAssets, firmDomains, firms, type FirmDomainRow, type FirmRow } from '../db/schema';
import { httpError } from '../lib/http';
import { isUuid } from '../lib/ids';
import type { Actor } from '../lib/actor';
import { iso, isoOrNull } from '../lib/time';
import { parse } from '../validation/schemas';
import { clearFirmCache } from './firm.service';
import * as auditService from './audit.service';

// ---------------------------------------------------------------- logo and icon

const MAX_BYTES: Record<FirmAssetKind, number> = { logo: 1024 * 1024, icon: 256 * 1024 };

const assetSchema = z.object({
  contentType: z.string().trim().max(100),
  contentBase64: z.string().min(1).max(1_500_000),
});

/** The image type from the file's first bytes (not the name or declared type). */
export function imageType(body: Buffer): string | null {
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  if (
    body.subarray(0, 4).toString('latin1') === 'RIFF' &&
    body.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** Width and height of a PNG (from its header), to refuse absurd sizes. */
function pngSize(body: Buffer): { width: number; height: number } | null {
  if (body.length < 24) return null;
  return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
}

async function refresh(firm: FirmRow, set: Partial<typeof firms.$inferInsert>) {
  const [updated] = await db()
    .update(firms)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(firms.id, firm.id))
    .returning();
  clearFirmCache();
  if (updated) Object.assign(firm, updated);
}

export async function uploadAsset(kind: FirmAssetKind, input: unknown, actor: Actor = {}) {
  const upload = parse(assetSchema, input);
  const body = Buffer.from(upload.contentBase64, 'base64');
  const contentType = imageType(body);
  if (!contentType) {
    throw httpError('Upload a PNG, JPEG or WebP image (SVG is not accepted)', 400);
  }
  if (body.length > MAX_BYTES[kind]) {
    throw httpError(`The ${kind} must be ${MAX_BYTES[kind] / 1024} KB or smaller`, 400);
  }
  const size = contentType === 'image/png' ? pngSize(body) : null;
  if (size && (size.width > 4000 || size.height > 4000 || !size.width || !size.height)) {
    throw httpError('The image must be at most 4000 × 4000 pixels', 400);
  }
  const contentHash = createHash('sha256').update(body).digest('hex');
  await db()
    .insert(firmAssets)
    .values({ kind, contentType, content: body, contentHash })
    .onConflictDoUpdate({
      target: [firmAssets.firmId, firmAssets.kind],
      set: { contentType, content: body, contentHash, updatedAt: new Date() },
    });
  const firm = currentFirm();
  await refresh(firm, {
    branding: { ...(firm.branding ?? {}), [`${kind}Hash`]: contentHash.slice(0, 16) },
  });
  await auditService.logEvent(
    {
      entityType: 'firm',
      entityId: firm.id,
      action: `firm_${kind}_uploaded`,
      summary: `Firm ${kind} changed`,
      details: { contentType, bytes: body.length },
    },
    actor,
  );
  return {
    url:
      kind === 'logo'
        ? `/api/tenant/logo?v=${contentHash.slice(0, 16)}`
        : `/api/tenant/icon?v=${contentHash.slice(0, 16)}`,
  };
}

export async function deleteAsset(kind: FirmAssetKind, actor: Actor = {}) {
  await db().delete(firmAssets).where(eq(firmAssets.kind, kind));
  const firm = currentFirm();
  await refresh(firm, { branding: { ...(firm.branding ?? {}), [`${kind}Hash`]: null } });
  await auditService.logEvent(
    {
      entityType: 'firm',
      entityId: firm.id,
      action: `firm_${kind}_removed`,
      summary: `Firm ${kind} removed`,
      details: {},
    },
    actor,
  );
  return { deleted: true };
}

/** The current firm's logo or icon (an icon falls back to the logo). */
export async function readAsset(kind: FirmAssetKind) {
  const kinds: FirmAssetKind[] = kind === 'icon' ? ['icon', 'logo'] : ['logo'];
  for (const candidate of kinds) {
    const [asset] = await db()
      .select()
      .from(firmAssets)
      .where(eq(firmAssets.kind, candidate))
      .limit(1);
    if (asset) return asset;
  }
  return null;
}

// ---------------------------------------------------------------- custom domains

const domainSchema = z.object({
  domain: z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/[/:].*$/, '')
            .replace(/\.$/, '')
        : value,
    z
      .string()
      .regex(
        /^(?=.{4,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,24}$/,
        'must be a domain such as portal.nkosilaw.co.za',
      ),
  ),
});

/** Prefix of the TXT record a firm publishes. */
export function txtRecordName(domain: string): string {
  return `_firm-verify.${domain}`;
}

const txtValue = (token: string) => `firm-domain-verification=${token}`;

function domainSecret(): string {
  // env.ts refuses to start production without AUDIT_CHAIN_SECRET.
  return process.env.AUDIT_CHAIN_SECRET || 'development-domain-check';
}

/**
 * What this platform answers at https://<host>/.well-known/firm-domain-check:
 * an HMAC of the host only this platform can produce, so a match proves the
 * domain reaches us.
 */
export function domainCheckValue(host: string): string {
  return createHmac('sha256', domainSecret())
    .update(`firm-domain-check:${host.toLowerCase()}`)
    .digest('hex');
}

function platformBase(): string {
  return (process.env.PLATFORM_BASE_DOMAIN || '').trim().toLowerCase();
}

function present(row: FirmDomainRow): FirmDomain {
  return {
    id: row.id,
    domain: row.domain,
    status: row.status as FirmDomain['status'],
    txtRecordName: txtRecordName(row.domain),
    txtRecordValue: txtValue(row.token),
    cnameTarget: (process.env.CUSTOM_DOMAIN_CNAME_TARGET || '').trim() || null,
    lastCheckedAt: isoOrNull(row.lastCheckedAt),
    lastError: row.lastError,
    activatedAt: isoOrNull(row.activatedAt),
    createdAt: iso(row.createdAt),
  };
}

export async function listDomains(): Promise<FirmDomain[]> {
  const rows = await db().select().from(firmDomains).orderBy(firmDomains.createdAt);
  return rows.map(present);
}

/** Another firm already uses the domain (firms are readable by requests). */
async function inUseElsewhere(domain: string): Promise<boolean> {
  const [other] = await db()
    .select({ id: firms.id })
    .from(firms)
    .where(and(ne(firms.id, currentFirm().id), sql`${domain} = any(${firms.domains})`))
    .limit(1);
  return Boolean(other);
}

export async function addDomain(input: unknown, actor: Actor = {}): Promise<FirmDomain> {
  const { domain } = parse(domainSchema, input);
  const base = platformBase();
  if (base && (domain === base || domain.endsWith(`.${base}`))) {
    throw httpError('That is a platform address; add your own domain', 400);
  }
  if (await inUseElsewhere(domain)) {
    throw httpError('That domain is already in use', 409);
  }
  const [saved] = await db()
    .insert(firmDomains)
    .values({ domain, token: randomBytes(18).toString('base64url') })
    .onConflictDoNothing()
    .returning();
  if (!saved) {
    throw httpError('That domain has already been added', 409);
  }
  await auditService.logEvent(
    {
      entityType: 'firm',
      entityId: currentFirm().id,
      action: 'firm_domain_added',
      summary: `Custom domain ${domain} added`,
      details: { domain },
    },
    actor,
  );
  return present(saved);
}

export interface DomainChecks {
  resolveTxt: (name: string) => Promise<string[][]>;
  fetchCheck: (url: string) => Promise<string>;
}

const realChecks: DomainChecks = {
  resolveTxt,
  fetchCheck: async (url) => {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.text()).trim();
  },
};

async function setPrimaryDomains(domainsInOrder: string[]) {
  const firm = currentFirm();
  await refresh(firm, { domains: domainsInOrder });
}

/**
 * Checks a domain: its TXT record, then that https://domain reaches the
 * platform. An active domain becomes the firm's main address for links.
 */
export async function checkDomain(
  id: string,
  actor: Actor = {},
  checks: DomainChecks = realChecks,
): Promise<FirmDomain> {
  if (!isUuid(id)) throw httpError('Domain not found', 404);
  const [row] = await db().select().from(firmDomains).where(eq(firmDomains.id, id)).limit(1);
  if (!row) throw httpError('Domain not found', 404);
  if (row.status === 'active') return present(row);

  let status = row.status;
  let lastError: string | null = null;
  try {
    const records = (await checks.resolveTxt(txtRecordName(row.domain))).map((parts) =>
      parts.join(''),
    );
    if (!records.includes(txtValue(row.token))) {
      throw new Error(`The TXT record ${txtRecordName(row.domain)} was not found`);
    }
    status = 'pending_routing';
    let answer: string;
    try {
      answer = await checks.fetchCheck(`https://${row.domain}/.well-known/firm-domain-check`);
    } catch {
      throw new Error(
        `https://${row.domain} does not reach the platform yet (CNAME and certificate pending)`,
      );
    }
    if (answer !== domainCheckValue(row.domain)) {
      throw new Error(`https://${row.domain} answers, but not from this platform`);
    }
    if (await inUseElsewhere(row.domain)) {
      throw new Error('That domain is already in use');
    }
    status = 'active';
  } catch (failure) {
    lastError = failure instanceof Error ? failure.message : 'Check failed';
  }

  const [saved] = await db()
    .update(firmDomains)
    .set({
      status,
      lastError,
      lastCheckedAt: new Date(),
      ...(status === 'active' ? { activatedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(firmDomains.id, row.id))
    .returning();
  if (status === 'active') {
    const firm = currentFirm();
    // The custom domain becomes the main address (used in email links).
    await setPrimaryDomains([row.domain, ...firm.domains.filter((d) => d !== row.domain)]);
    await auditService.logEvent(
      {
        entityType: 'firm',
        entityId: firm.id,
        action: 'firm_domain_activated',
        summary: `Custom domain ${row.domain} is active`,
        details: { domain: row.domain },
      },
      actor,
    );
  }
  return present(saved!);
}

export async function removeDomain(id: string, actor: Actor = {}): Promise<{ deleted: true }> {
  if (!isUuid(id)) throw httpError('Domain not found', 404);
  const [row] = await db().delete(firmDomains).where(eq(firmDomains.id, id)).returning();
  if (!row) throw httpError('Domain not found', 404);
  const firm = currentFirm();
  if (firm.domains.includes(row.domain)) {
    await setPrimaryDomains(firm.domains.filter((domain) => domain !== row.domain));
  }
  await auditService.logEvent(
    {
      entityType: 'firm',
      entityId: firm.id,
      action: 'firm_domain_removed',
      summary: `Custom domain ${row.domain} removed`,
      details: { domain: row.domain },
    },
    actor,
  );
  return { deleted: true };
}

/** Rechecks every firm's pending domains (the scheduled job). */
export async function checkPendingDomains(checks: DomainChecks = realChecks) {
  const all = await rootDb().select().from(firms).where(eq(firms.status, 'active'));
  const results: Array<{ firm: string; domain: string; status: string; error: string | null }> = [];
  for (const firm of all) {
    await withTenant(
      firm,
      async () => {
        const pending = await db()
          .select()
          .from(firmDomains)
          .where(ne(firmDomains.status, 'active'));
        for (const row of pending) {
          const checked = await checkDomain(row.id, {}, checks);
          results.push({
            firm: firm.slug,
            domain: checked.domain,
            status: checked.status,
            error: checked.lastError,
          });
        }
      },
      { system: true },
    );
  }
  return results;
}

// ---------------------------------------------------------------- onboarding

export function onboardingStatus(firm: FirmRow = currentFirm()): OnboardingStatus {
  const done = new Set(firm.onboarding?.done ?? []);
  return {
    steps: ONBOARDING_STEPS.map((id) => ({ id, label: ONBOARDING_LABELS[id], done: done.has(id) })),
    complete: Boolean(firm.onboarding?.completedAt),
    completedAt: firm.onboarding?.completedAt ?? null,
  };
}

const onboardingSchema = z.object({
  done: z.enum(ONBOARDING_STEPS).optional(),
  finish: z.boolean().optional(),
});

export async function updateOnboarding(
  input: unknown,
  actor: Actor = {},
): Promise<OnboardingStatus> {
  const change = parse(onboardingSchema, input);
  const firm = currentFirm();
  const done = new Set<string>(firm.onboarding?.done ?? []);
  if (change.done) done.add(change.done as OnboardingStep);
  const completedAt =
    firm.onboarding?.completedAt ?? (change.finish ? new Date().toISOString() : undefined);
  await refresh(firm, { onboarding: { done: [...done], ...(completedAt ? { completedAt } : {}) } });
  if (change.finish) {
    await auditService.logEventSafely(
      {
        entityType: 'firm',
        entityId: firm.id,
        action: 'firm_onboarding_finished',
        summary: 'Onboarding finished',
        details: { done: [...done] },
      },
      actor,
    );
  }
  return onboardingStatus(firm);
}
