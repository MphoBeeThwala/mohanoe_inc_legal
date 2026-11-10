// The platform super-admin console: Ahava on 88 operators manage firms,
// plans, research sources and the Court Online court list.
//
// - It answers only on PLATFORM_CONSOLE_HOST (unset: the console is off),
//   never on a firm's address, and runs outside any firm's tenant context.
// - Operators sign in with password + authenticator (the same checks,
//   lockout and replay protection as support sign-in); console sessions are
//   server-side, on their own cookie.
// - Operators see firm metadata and counts, never client data. Looking into
//   a firm still needs that firm's support grant (support.service).
// - consoleRole 'viewer' reads; 'admin' changes. Every change is written to
//   platform_audit.
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ConsoleAuditEntry, ConsoleFirm, ConsoleOperator, ConsoleRole } from '@ahava88/shared';
import { rootDb, db } from '../db/client';
import { withTenant } from '../db/tenant';
import {
  cases,
  firms,
  platformAudit,
  platformOperators,
  platformSessions,
  users,
  type FirmRow,
  type PlatformOperatorRow,
} from '../db/schema';
import { authSettings } from '../config/auth';
import { clearCookie, readCookie, setCookie } from '../lib/cookies';
import { httpError } from '../lib/http';
import { isUuid } from '../lib/ids';
import { randomToken, sha256 } from '../lib/tokens';
import { iso, isoOrNull } from '../lib/time';
import { parse } from '../validation/schemas';
import { authenticateOperator } from './support.service';
import { clearFirmCache, createFirm, findFirmById, inviteFirmAdmin } from './firm.service';
import * as subscriptions from './subscription.service';
import * as ai from './ai.service';
import * as corpus from './corpus.service';
import * as court from './court.service';

const IDLE_MINUTES = 30;
const MAX_HOURS = 8;

export const consoleHost = () =>
  String(process.env.PLATFORM_CONSOLE_HOST || '')
    .trim()
    .toLowerCase();
const cookieName = () => (authSettings().secureCookies ? '__Host-platform' : 'platform');

export function isConsoleHost(hostname: string): boolean {
  const host = consoleHost();
  return Boolean(host) && hostname.toLowerCase() === host;
}

// ------------------------------------------------------------------ sessions

export async function signIn(input: unknown, res: Response): Promise<ConsoleOperator> {
  const operator = await authenticateOperator(input);
  const token = randomToken();
  await rootDb()
    .insert(platformSessions)
    .values({
      operatorId: operator.id,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + MAX_HOURS * 3_600_000),
    });
  setCookie(res, cookieName(), token, {
    secure: authSettings().secureCookies,
    sameSite: 'Strict',
    maxAgeSeconds: MAX_HOURS * 3600,
  });
  await record(operator, 'console_sign_in', null, 'Signed in to the platform console');
  return toOperator(operator);
}

const toOperator = (row: PlatformOperatorRow): ConsoleOperator => ({
  id: row.id,
  email: row.email,
  fullName: row.fullName,
  consoleRole: row.consoleRole as ConsoleRole,
});

export async function requireOperator(req: Request): Promise<PlatformOperatorRow> {
  const token = readCookie(req, cookieName());
  if (!token) throw httpError('Please sign in', 401);
  const now = new Date();
  const [row] = await rootDb()
    .select({ session: platformSessions, operator: platformOperators })
    .from(platformSessions)
    .innerJoin(platformOperators, eq(platformOperators.id, platformSessions.operatorId))
    .where(
      and(
        eq(platformSessions.tokenHash, sha256(token)),
        isNull(platformSessions.revokedAt),
        gt(platformSessions.expiresAt, now),
      ),
    );
  if (!row || !row.operator.isActive) throw httpError('Please sign in', 401);
  if (now.getTime() - row.session.lastSeenAt.getTime() > IDLE_MINUTES * 60_000) {
    await rootDb()
      .update(platformSessions)
      .set({ revokedAt: now })
      .where(eq(platformSessions.id, row.session.id));
    throw httpError('Your session timed out. Please sign in again.', 401);
  }
  await rootDb()
    .update(platformSessions)
    .set({ lastSeenAt: now })
    .where(eq(platformSessions.id, row.session.id));
  return row.operator;
}

export function requireAdmin(operator: PlatformOperatorRow): void {
  if (operator.consoleRole !== 'admin') {
    throw httpError('Only console administrators can make changes', 403);
  }
}

export async function signOut(req: Request, res: Response): Promise<void> {
  const token = readCookie(req, cookieName());
  if (token) {
    await rootDb()
      .update(platformSessions)
      .set({ revokedAt: new Date() })
      .where(eq(platformSessions.tokenHash, sha256(token)));
  }
  clearCookie(res, cookieName(), { secure: authSettings().secureCookies, sameSite: 'Strict' });
}

export const me = (operator: PlatformOperatorRow) => toOperator(operator);

// --------------------------------------------------------------------- audit

export async function record(
  operator: PlatformOperatorRow,
  action: string,
  firmId: string | null,
  summary: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await rootDb()
    .insert(platformAudit)
    .values({ operatorId: operator.id, action, firmId, summary, details });
}

export async function auditLog(limit = 200): Promise<ConsoleAuditEntry[]> {
  const rows = await rootDb()
    .select({ entry: platformAudit, operator: platformOperators.email, slug: firms.slug })
    .from(platformAudit)
    .leftJoin(platformOperators, eq(platformOperators.id, platformAudit.operatorId))
    .leftJoin(firms, eq(firms.id, platformAudit.firmId))
    .orderBy(desc(platformAudit.createdAt))
    .limit(limit);
  return rows.map(({ entry, operator, slug }) => ({
    id: entry.id,
    operator,
    action: entry.action,
    firmSlug: slug,
    summary: entry.summary,
    createdAt: iso(entry.createdAt),
  }));
}

// --------------------------------------------------------------------- firms

/** Counts and status from inside the firm (system scope): no client data. */
async function describe(firm: FirmRow): Promise<ConsoleFirm> {
  const inside = await withTenant(
    firm,
    async () => {
      const [staff] = await db()
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(and(eq(users.isActive, true), ne(users.role, 'support')));
      const [matters] = await db()
        .select({ count: sql<number>`count(*)::int` })
        .from(cases);
      const sub = await subscriptions.ensureSubscription();
      const usage = await ai.usage();
      return {
        staff: staff?.count ?? 0,
        matters: matters?.count ?? 0,
        subscription: {
          state: sub.state,
          effectiveStatus: subscriptions.effectiveStatus(sub),
          planCode: sub.planCode,
          seats: sub.seats,
          paidThrough: isoOrNull(subscriptions.periodEnd(sub)),
        },
        aiTokensThisMonth: usage.tokensUsed,
      };
    },
    { system: true },
  );
  return {
    id: firm.id,
    slug: firm.slug,
    legalName: firm.legalName,
    tradingName: firm.tradingName,
    status: firm.status,
    domains: firm.domains,
    createdAt: iso(firm.createdAt),
    features: { trustAccounting: Boolean(firm.features?.trustAccounting) },
    ...inside,
  };
}

export async function listFirms(): Promise<ConsoleFirm[]> {
  const rows = await rootDb().select().from(firms).orderBy(firms.slug);
  const out: ConsoleFirm[] = [];
  for (const firm of rows) out.push(await describe(firm));
  return out;
}

async function requireFirm(id: string): Promise<FirmRow> {
  const firm = isUuid(id) ? await findFirmById(id) : null;
  if (!firm) throw httpError('Firm not found', 404);
  return firm;
}

const newFirmSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'lower-case letters, digits and dashes'),
  legalName: z.string().trim().min(2).max(200),
  tradingName: z.string().trim().max(200).optional(),
  domains: z.array(z.string().trim().toLowerCase().min(3).max(253)).max(5).default([]),
  adminEmail: z.string().trim().email().max(254),
  adminName: z.string().trim().min(2).max(120),
});

/** Creates a firm and emails its first administrator an invitation. */
export async function createFirmWithAdmin(
  operator: PlatformOperatorRow,
  input: unknown,
): Promise<ConsoleFirm> {
  requireAdmin(operator);
  const values = parse(newFirmSchema, input);
  const firm = await createFirm({
    slug: values.slug,
    legalName: values.legalName,
    tradingName: values.tradingName,
    domains: values.domains,
  });
  const invite = await inviteFirmAdmin(firm, {
    email: values.adminEmail,
    fullName: values.adminName,
  });
  await record(
    operator,
    'firm_created',
    firm.id,
    `Created firm ${firm.slug} and invited its first administrator`,
    {
      inviteEmailed: invite.emailed,
    },
  );
  return describe(firm);
}

const firmUpdateSchema = z.object({
  status: z.enum(['active', 'suspended']).optional(),
  trustAccounting: z.boolean().optional(),
});

/** Platform switches: the firm's status and feature flags. */
export async function updateFirm(
  operator: PlatformOperatorRow,
  id: string,
  input: unknown,
): Promise<ConsoleFirm> {
  requireAdmin(operator);
  const changes = parse(firmUpdateSchema, input);
  const firm = await requireFirm(id);
  const [saved] = await rootDb()
    .update(firms)
    .set({
      ...(changes.status ? { status: changes.status } : {}),
      ...(changes.trustAccounting !== undefined
        ? { features: { ...firm.features, trustAccounting: changes.trustAccounting } }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(firms.id, firm.id))
    .returning();
  clearFirmCache();
  await record(operator, 'firm_updated', firm.id, `Updated ${firm.slug}`, changes);
  return describe(saved!);
}

const compSchema = z.object({
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  seats: z.coerce.number().int().min(1).max(10_000).nullable().optional(),
});

export async function setComplimentary(
  operator: PlatformOperatorRow,
  id: string,
  input: unknown,
): Promise<ConsoleFirm> {
  requireAdmin(operator);
  const { until, seats } = parse(compSchema, input);
  const firm = await requireFirm(id);
  await withTenant(
    firm,
    () =>
      subscriptions.setComplimentary(
        until ? new Date(`${until}T23:59:59+02:00`) : null,
        seats ?? null,
      ),
    { system: true },
  );
  await record(operator, 'firm_complimentary', firm.id, `Complimentary access for ${firm.slug}`, {
    until,
    seats,
  });
  return describe(firm);
}

// ------------------------------------------- plans, sources, Court Online

export const plans = () => subscriptions.listAllPlans();

export async function savePlan(operator: PlatformOperatorRow, input: unknown) {
  requireAdmin(operator);
  const plan = await subscriptions.upsertPlan(input);
  await record(operator, 'plan_saved', null, `Saved plan ${plan.code}`, {
    monthlySeatPriceCents: plan.monthlySeatPriceCents,
    annualSeatPriceCents: plan.annualSeatPriceCents,
  });
  return plan;
}

export async function retirePlan(operator: PlatformOperatorRow, code: string) {
  requireAdmin(operator);
  if (!(await subscriptions.disablePlan(code))) throw httpError('Plan not found', 404);
  await record(operator, 'plan_retired', null, `Retired plan ${code}`);
  return { code, isActive: false };
}

export const sources = () => corpus.listAllSources();

export async function setSourceStatus(operator: PlatformOperatorRow, code: string, input: unknown) {
  requireAdmin(operator);
  const { status } = parse(z.object({ status: z.enum(['approved', 'suspended']) }), input);
  if (!(await corpus.setSourceStatus(code, status))) throw httpError('Source not found', 404);
  await record(operator, 'source_status', null, `Research source ${code}: ${status}`);
  return { code, status };
}

export async function saveSource(operator: PlatformOperatorRow, input: unknown) {
  requireAdmin(operator);
  const values = parse(
    z.object({
      code: z.string(),
      name: z.string(),
      kind: z.string(),
      publisher: z.string().optional(),
      url: z.string().optional(),
      licence: z.string(),
      permission: z.string().optional(),
    }),
    input,
  );
  const saved = await corpus.upsertSource({ ...values, approvedBy: operator.email });
  await record(operator, 'source_saved', null, `Registered research source ${saved.code}`, {
    licence: saved.licence,
    permission: saved.permission,
  });
  return saved;
}

export const courtOnlineCourts = async () => {
  const rows = await rootDb()
    .select()
    .from(court.courtOnlineTable)
    .orderBy(court.courtOnlineTable.division);
  return rows.map(({ division, since, source }) => ({ division, since, source }));
};

export async function saveCourtOnline(operator: PlatformOperatorRow, input: unknown) {
  requireAdmin(operator);
  const { division, since, source } = parse(
    z.object({ division: z.string(), since: z.string(), source: z.string() }),
    input,
  );
  await court.setCourtOnlineCourt(division, since, source);
  await record(operator, 'court_online_saved', null, `${division} on Court Online since ${since}`, {
    source,
  });
  return { division, since, source };
}

export async function removeCourtOnline(operator: PlatformOperatorRow, division: string) {
  requireAdmin(operator);
  if (!(await court.removeCourtOnlineCourt(division))) throw httpError('Not listed', 404);
  await record(
    operator,
    'court_online_removed',
    null,
    `${division} removed from the Court Online list`,
  );
  return { division };
}
