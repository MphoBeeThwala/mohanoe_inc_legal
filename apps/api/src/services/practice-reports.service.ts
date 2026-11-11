// Practice reports: work in progress, debtors, utilisation, realisation and a
// fee-earner summary, each as JSON and CSV.
//
// Scope:
// - 'firm' (reports.firm: administrators and bookkeepers) covers every fee
//   earner and every matter. Figures from restricted matters count in the
//   totals, but rows for matters the caller can't see read "Restricted
//   matter" (withSystemScope, as the trust cashbook does).
// - 'own' (everyone else with reports.read) covers the caller's own time and
//   disbursements, on matters they can see (row-level security applies).
//
// Reports name matters by number and clients by their label (the party
// number), never by decrypted names. Amounts are integer cents; hours come
// from 6-minute units (units / 10).
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import {
  hasPermission,
  type DebtorBuckets,
  type DebtorsReport,
  type FeeEarnerReport,
  type FeeEarnerSummaryRow,
  type PracticeReportKind,
  type RealisationFigures,
  type RealisationReport,
  type ReportMatter,
  type ReportPeriod,
  type ReportScope,
  type UtilisationReport,
  type UtilisationRow,
  type WipReport,
} from '@ahava88/shared';
import { db } from '../db/client';
import { withSystemScope } from '../db/tenant';
import {
  cases,
  disbursements,
  invoicePayments,
  invoices,
  timeEntries,
  users,
  type TimeEntryRow,
} from '../db/schema';
import type { Actor } from '../lib/actor';
import { csv, randsCell } from '../lib/csv';
import { httpError } from '../lib/http';
import { localDate } from '../lib/time';
import { parse } from '../validation/schemas';
import { agingReport } from './billing.service';

const RESTRICTED = 'Restricted matter';
const ISSUED = ['issued', 'partially_paid', 'paid'];
const DAY_MS = 86_400_000;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const periodSchema = z.object({ from: date.optional(), to: date.optional() });

const hours = (units: number) => Math.round(units * 10) / 100; // units / 10, two decimals
const ratio = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null;

/** The period asked for: this month to date by default, at most a year. */
export function period(input: unknown): { from: string; to: string } {
  const values = parse(periodSchema, input ?? {});
  const today = localDate();
  const to = values.to ?? today;
  const from = values.from ?? `${to.slice(0, 7)}-01`;
  if (from > to) throw httpError('The start date is after the end date', 400);
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS > 366) {
    throw httpError('A report covers at most a year', 400);
  }
  return { from, to };
}

export function scopeFor(actor: Actor): ReportScope {
  return hasPermission(actor.role ?? undefined, 'reports.firm') ? 'firm' : 'own';
}

const inScope = <T>(scope: ReportScope, fn: () => Promise<T>) =>
  scope === 'firm' ? withSystemScope(fn) : fn();

/** Matters this caller can see (row-level security), by id. */
async function visibleMatters(): Promise<Map<string, string>> {
  const rows = await db().select({ id: cases.id, caseNumber: cases.caseNumber }).from(cases);
  return new Map(rows.map((row) => [row.id, row.caseNumber]));
}

/** Every matter's number, for the firm scope (run inside withSystemScope). */
async function allMatters(): Promise<Map<string, string>> {
  return visibleMatters();
}

function matterRef(
  caseId: string | null,
  visible: Map<string, string>,
  all: Map<string, string>,
): ReportMatter {
  if (caseId && visible.has(caseId)) {
    return { caseId, caseNumber: visible.get(caseId)!, restricted: false };
  }
  if (caseId && all.has(caseId)) return { caseId: null, caseNumber: RESTRICTED, restricted: true };
  return { caseId: null, caseNumber: RESTRICTED, restricted: true };
}

async function staffNames(): Promise<Map<string, string>> {
  const rows = await db().select({ id: users.id, fullName: users.fullName }).from(users);
  return new Map(rows.map((row) => [row.id, row.fullName]));
}

const nameOf = (names: Map<string, string>, id: string | null) =>
  (id && names.get(id)) || 'Former staff member';

/** Restricted matters fold into one row, so their numbers never show. */
const groupKey = (ref: ReportMatter) => (ref.restricted ? RESTRICTED : ref.caseId!);

// ------------------------------------------------------------------ WIP

export async function wip(input: unknown, actor: Actor): Promise<WipReport> {
  const { from, to } = period(input);
  const scope = scopeFor(actor);
  const visible = await visibleMatters();
  return inScope(scope, async () => {
    const all = scope === 'firm' ? await allMatters() : visible;
    const own = scope === 'own' ? (actor.userId ?? '') : null;
    const time = await db()
      .select()
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.status, 'unbilled'),
          eq(timeEntries.billable, true),
          lte(timeEntries.workDate, to),
          own === null ? undefined : eq(timeEntries.userId, own),
        ),
      );
    const costs = await db()
      .select()
      .from(disbursements)
      .where(
        and(
          eq(disbursements.status, 'unbilled'),
          lte(disbursements.incurredOn, to),
          own === null ? undefined : eq(disbursements.createdBy, own),
        ),
      );
    const names = await staffNames();
    const matters = new Map<string, WipReport['matters'][number]>();
    const row = (caseId: string) => {
      const ref = matterRef(caseId, visible, all);
      const key = groupKey(ref);
      let entry = matters.get(key);
      if (!entry) {
        entry = {
          ...ref,
          hours: 0,
          timeCents: 0,
          disbursementCents: 0,
          totalCents: 0,
          oldestWorkDate: null,
        };
        matters.set(key, entry);
      }
      return entry;
    };
    const earners = new Map<string, WipReport['feeEarners'][number]>();
    const totals = { hours: 0, timeCents: 0, disbursementCents: 0, totalCents: 0 };
    for (const entry of time) {
      const matter = row(entry.caseId);
      matter.hours += hours(entry.units);
      matter.timeCents += entry.amountCents;
      matter.totalCents += entry.amountCents;
      if (!matter.oldestWorkDate || entry.workDate < matter.oldestWorkDate) {
        matter.oldestWorkDate = entry.workDate;
      }
      const key = entry.userId ?? 'former';
      const earner = earners.get(key) ?? {
        userId: entry.userId,
        name: nameOf(names, entry.userId),
        hours: 0,
        timeCents: 0,
      };
      earner.hours += hours(entry.units);
      earner.timeCents += entry.amountCents;
      earners.set(key, earner);
      totals.hours += hours(entry.units);
      totals.timeCents += entry.amountCents;
    }
    for (const cost of costs) {
      const matter = row(cost.caseId);
      matter.disbursementCents += cost.amountCents;
      matter.totalCents += cost.amountCents;
      totals.disbursementCents += cost.amountCents;
    }
    totals.totalCents = totals.timeCents + totals.disbursementCents;
    totals.hours = round2(totals.hours);
    return {
      from,
      to,
      scope,
      matters: [...matters.values()]
        .map((m) => ({ ...m, hours: round2(m.hours) }))
        .sort((a, b) => b.totalCents - a.totalCents),
      feeEarners: [...earners.values()]
        .map((e) => ({ ...e, hours: round2(e.hours) }))
        .sort((a, b) => b.timeCents - a.timeCents),
      totals,
    };
  });
}

const round2 = (value: number) => Math.round(value * 100) / 100;

// -------------------------------------------------------------- debtors

const BUCKETS = ['current', 'days30', 'days60', 'days90', 'days120', 'total'] as const;

// agingReport() works in rands; reports work in cents.
function inCents(buckets: DebtorBuckets): DebtorBuckets {
  const out = { ...buckets };
  for (const key of BUCKETS) out[key] = Math.round(buckets[key] * 100);
  return out;
}

function minus(a: DebtorBuckets, b: DebtorBuckets): DebtorBuckets {
  const out = { ...a };
  for (const key of BUCKETS) out[key] = a[key] - b[key];
  return out;
}

/** Aged debtors at the end of the period, by client label (the party number). */
export async function debtors(input: unknown, actor: Actor): Promise<DebtorsReport> {
  const { from, to } = period(input);
  const scope = scopeFor(actor);
  // What the caller can see, by client; the firm scope adds one line for the rest.
  const visible = await agingReport(to);
  const everything = scope === 'firm' ? await withSystemScope(() => agingReport(to)) : visible;
  const totals = inCents(everything.totals);
  const hidden = minus(totals, inCents(visible.totals));
  return {
    from,
    to,
    scope,
    asOf: to,
    clients: visible.clients.map(({ clientPartyId: _id, clientLabel, invoices, ...buckets }) => ({
      clientLabel,
      invoices,
      ...inCents({ ...buckets }),
    })),
    restricted: hidden.total > 0 ? hidden : null,
    totals,
  };
}

// ---------------------------------------------------------- utilisation

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [year, month] = from.slice(0, 7).split('-').map(Number) as [number, number];
  const last = to.slice(0, 7);
  for (;;) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    out.push(key);
    if (key >= last) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

async function timeInPeriod(
  scope: ReportScope,
  actor: Actor,
  from: string,
  to: string,
): Promise<TimeEntryRow[]> {
  return db()
    .select()
    .from(timeEntries)
    .where(
      and(
        gte(timeEntries.workDate, from),
        lte(timeEntries.workDate, to),
        scope === 'own' ? eq(timeEntries.userId, actor.userId ?? '') : undefined,
      ),
    );
}

/** Billable hours against each fee earner's monthly target, month by month. */
export async function utilisation(input: unknown, actor: Actor): Promise<UtilisationReport> {
  const { from, to } = period(input);
  const scope = scopeFor(actor);
  return inScope(scope, async () => {
    const entries = await timeInPeriod(scope, actor, from, to);
    const staff = await db()
      .select({
        id: users.id,
        fullName: users.fullName,
        role: users.role,
        isActive: users.isActive,
        targetHoursPerMonth: users.targetHoursPerMonth,
      })
      .from(users);
    const months = monthsBetween(from, to);
    const people = staff.filter(
      (person) =>
        person.role !== 'support' &&
        (scope === 'firm' ? true : person.id === actor.userId) &&
        (person.isActive || entries.some((e) => e.userId === person.id)),
    );
    const rows: UtilisationRow[] = [];
    for (const person of people) {
      // Only people who record time, or have a target, are listed.
      const mine = entries.filter((e) => e.userId === person.id);
      if (!mine.length && person.targetHoursPerMonth === null) continue;
      for (const month of months) {
        const inMonth = mine.filter((e) => e.workDate.startsWith(month));
        const billableHours = round2(
          inMonth.filter((e) => e.billable).reduce((sum, e) => sum + hours(e.units), 0),
        );
        const nonBillableHours = round2(
          inMonth.filter((e) => !e.billable).reduce((sum, e) => sum + hours(e.units), 0),
        );
        const target = person.targetHoursPerMonth;
        rows.push({
          userId: person.id,
          name: person.fullName,
          month,
          billableHours,
          nonBillableHours,
          targetHours: target,
          utilisation: target ? ratio(billableHours, target) : null,
        });
      }
    }
    return { from, to, scope, rows };
  });
}

// ---------------------------------------------------------- realisation

function figures(): RealisationFigures {
  return {
    recordedCents: 0,
    billedCents: 0,
    writtenOffCents: 0,
    unbilledCents: 0,
    billingRealisation: null,
  };
}

function addEntry(target: RealisationFigures, entry: TimeEntryRow) {
  target.recordedCents += entry.amountCents;
  if (entry.status === 'billed') target.billedCents += entry.amountCents;
  else if (entry.status === 'written_off') target.writtenOffCents += entry.amountCents;
  else target.unbilledCents += entry.amountCents;
}

const finish = <T extends RealisationFigures>(row: T): T => ({
  ...row,
  billingRealisation: ratio(row.billedCents, row.recordedCents),
});

/**
 * Billing realisation: of the billable time recorded in the period, how much
 * was billed (the rest is written off or still unbilled). Collection
 * realisation: of the invoices issued in the period, how much has been paid
 * by the end of it.
 */
export async function realisation(input: unknown, actor: Actor): Promise<RealisationReport> {
  const { from, to } = period(input);
  const scope = scopeFor(actor);
  const visible = await visibleMatters();
  return inScope(scope, async () => {
    const all = scope === 'firm' ? await allMatters() : visible;
    const names = await staffNames();
    const entries = (await timeInPeriod(scope, actor, from, to)).filter((e) => e.billable);

    const earners = new Map<string, RealisationReport['feeEarners'][number]>();
    type MatterRow = RealisationReport['matters'][number];
    const matters = new Map<string, MatterRow>();
    const matter = (caseId: string) => {
      const ref = matterRef(caseId, visible, all);
      const key = groupKey(ref);
      let row = matters.get(key);
      if (!row) {
        row = {
          ...ref,
          ...figures(),
          invoicedCents: 0,
          collectedCents: 0,
          collectionRealisation: null,
        };
        matters.set(key, row);
      }
      return row;
    };
    const totals = {
      ...figures(),
      invoicedCents: 0,
      collectedCents: 0,
      collectionRealisation: null as number | null,
    };

    for (const entry of entries) {
      const key = entry.userId ?? 'former';
      const earner = earners.get(key) ?? {
        userId: entry.userId,
        name: nameOf(names, entry.userId),
        ...figures(),
      };
      addEntry(earner, entry);
      earners.set(key, earner);
      addEntry(matter(entry.caseId), entry);
      addEntry(totals, entry);
    }

    // Invoices issued in the period: on every matter (firm) or on the matters
    // the caller has time on (own), with what was paid by the period's end.
    const issued = (
      await db().select().from(invoices).where(inArray(invoices.status, ISSUED))
    ).filter((row) => {
      if (!row.issuedAt) return false;
      const day = localDate(row.issuedAt);
      if (day < from || day > to) return false;
      return scope === 'firm' || entries.some((e) => e.caseId === row.caseId);
    });
    const paid = issued.length
      ? await db()
          .select()
          .from(invoicePayments)
          .where(
            and(
              inArray(
                invoicePayments.invoiceId,
                issued.map((row) => row.id),
              ),
              lte(invoicePayments.receivedOn, to),
            ),
          )
      : [];
    for (const invoice of issued) {
      const collected = paid
        .filter((p) => p.invoiceId === invoice.id)
        .reduce((sum, p) => sum + p.amountCents, 0);
      const row = matter(invoice.caseId);
      row.invoicedCents += invoice.totalCents;
      row.collectedCents += collected;
      totals.invoicedCents += invoice.totalCents;
      totals.collectedCents += collected;
    }

    return {
      from,
      to,
      scope,
      feeEarners: [...earners.values()]
        .map(finish)
        .sort((a, b) => b.recordedCents - a.recordedCents),
      matters: [...matters.values()]
        .map((row) => ({
          ...finish(row),
          collectionRealisation: ratio(row.collectedCents, row.invoicedCents),
        }))
        .sort((a, b) => b.recordedCents - a.recordedCents),
      totals: {
        ...finish(totals),
        collectionRealisation: ratio(totals.collectedCents, totals.invoicedCents),
      },
    };
  });
}

// ---------------------------------------------------- fee-earner summary

export async function feeEarners(input: unknown, actor: Actor): Promise<FeeEarnerReport> {
  const { from, to } = period(input);
  const scope = scopeFor(actor);
  return inScope(scope, async () => {
    const entries = await timeInPeriod(scope, actor, from, to);
    const names = await staffNames();
    const rows = new Map<string, FeeEarnerSummaryRow>();
    for (const entry of entries) {
      const key = entry.userId ?? 'former';
      const row = rows.get(key) ?? {
        userId: entry.userId,
        name: nameOf(names, entry.userId),
        billableHours: 0,
        nonBillableHours: 0,
        recordedCents: 0,
        billedCents: 0,
        writtenOffCents: 0,
      };
      if (entry.billable) {
        row.billableHours += hours(entry.units);
        row.recordedCents += entry.amountCents;
        if (entry.status === 'billed') row.billedCents += entry.amountCents;
        if (entry.status === 'written_off') row.writtenOffCents += entry.amountCents;
      } else {
        row.nonBillableHours += hours(entry.units);
      }
      rows.set(key, row);
    }
    return {
      from,
      to,
      scope,
      rows: [...rows.values()]
        .map((row) => ({
          ...row,
          billableHours: round2(row.billableHours),
          nonBillableHours: round2(row.nonBillableHours),
        }))
        .sort((a, b) => b.recordedCents - a.recordedCents),
    };
  });
}

// ------------------------------------------------------------------ CSV

const pct = (value: number | null) => (value === null ? '' : (value * 100).toFixed(1));

export async function reportCsv(
  kind: PracticeReportKind,
  input: unknown,
  actor: Actor,
): Promise<string> {
  const head = (report: ReportPeriod) => [
    ['Period', report.from, report.to],
    ['Scope', report.scope === 'firm' ? 'Whole firm' : 'Own figures'],
    [],
  ];
  switch (kind) {
    case 'wip': {
      const r = await wip(input, actor);
      return csv([
        ...head(r),
        ['Matter', 'Hours', 'Time (R)', 'Disbursements (R)', 'Total (R)', 'Oldest work date'],
        ...r.matters.map((m) => [
          m.caseNumber,
          m.hours,
          randsCell(m.timeCents),
          randsCell(m.disbursementCents),
          randsCell(m.totalCents),
          m.oldestWorkDate,
        ]),
        [
          'Total',
          r.totals.hours,
          randsCell(r.totals.timeCents),
          randsCell(r.totals.disbursementCents),
          randsCell(r.totals.totalCents),
          '',
        ],
        [],
        ['Fee earner', 'Hours', 'Time (R)'],
        ...r.feeEarners.map((e) => [e.name, e.hours, randsCell(e.timeCents)]),
      ]);
    }
    case 'debtors': {
      const r = await debtors(input, actor);
      const cells = (b: DebtorBuckets) =>
        [b.current, b.days30, b.days60, b.days90, b.days120, b.total].map(randsCell);
      return csv([
        ...head(r),
        [
          'Client',
          'Invoices',
          'Current',
          '1-30 days',
          '31-60 days',
          '61-90 days',
          '90+ days',
          'Total',
        ],
        ...r.clients.map((c) => [c.clientLabel, c.invoices, ...cells(c)]),
        ...(r.restricted ? [[RESTRICTED, '', ...cells(r.restricted)]] : []),
        ['Total', '', ...cells(r.totals)],
      ]);
    }
    case 'utilisation': {
      const r = await utilisation(input, actor);
      return csv([
        ...head(r),
        [
          'Fee earner',
          'Month',
          'Billable hours',
          'Non-billable hours',
          'Target hours',
          'Utilisation %',
        ],
        ...r.rows.map((row) => [
          row.name,
          row.month,
          row.billableHours,
          row.nonBillableHours,
          row.targetHours,
          pct(row.utilisation),
        ]),
      ]);
    }
    case 'realisation': {
      const r = await realisation(input, actor);
      const cols = (f: RealisationFigures) => [
        randsCell(f.recordedCents),
        randsCell(f.billedCents),
        randsCell(f.writtenOffCents),
        randsCell(f.unbilledCents),
        pct(f.billingRealisation),
      ];
      return csv([
        ...head(r),
        [
          'Fee earner',
          'Recorded (R)',
          'Billed (R)',
          'Written off (R)',
          'Unbilled (R)',
          'Billing realisation %',
        ],
        ...r.feeEarners.map((e) => [e.name, ...cols(e)]),
        [],
        [
          'Matter',
          'Recorded (R)',
          'Billed (R)',
          'Written off (R)',
          'Unbilled (R)',
          'Billing realisation %',
          'Invoiced (R)',
          'Collected (R)',
          'Collection realisation %',
        ],
        ...r.matters.map((m) => [
          m.caseNumber,
          ...cols(m),
          randsCell(m.invoicedCents),
          randsCell(m.collectedCents),
          pct(m.collectionRealisation),
        ]),
        [
          'Total',
          ...cols(r.totals),
          randsCell(r.totals.invoicedCents),
          randsCell(r.totals.collectedCents),
          pct(r.totals.collectionRealisation),
        ],
      ]);
    }
    case 'fee-earners': {
      const r = await feeEarners(input, actor);
      return csv([
        ...head(r),
        [
          'Fee earner',
          'Billable hours',
          'Non-billable hours',
          'Recorded (R)',
          'Billed (R)',
          'Written off (R)',
        ],
        ...r.rows.map((row) => [
          row.name,
          row.billableHours,
          row.nonBillableHours,
          randsCell(row.recordedCents),
          randsCell(row.billedCents),
          randsCell(row.writtenOffCents),
        ]),
      ]);
    }
  }
}

export const REPORT_KINDS: readonly PracticeReportKind[] = [
  'wip',
  'debtors',
  'utilisation',
  'realisation',
  'fee-earners',
];
