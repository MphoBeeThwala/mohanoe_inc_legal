// The platform's invoices to firms: one for each subscription payment
// PayFast confirms.
//
// When the platform is a VAT vendor (PLATFORM_VAT_NUMBER set and a VAT rate
// above zero) each one is a full tax invoice (VAT Act s20(4)): the words "Tax
// invoice", the supplier's and the firm's names, addresses and VAT numbers, a
// serial number, the date, what was supplied, the value, the VAT and the
// total. A full tax invoice is used at every amount, so it is valid above
// R5 000 too. The VAT is the tax fraction of what PayFast collected
// (rate / (1 + rate)), since subscription prices include VAT.
//
// Numbers are one gap-free series for the platform: the counter row is locked
// and the invoice stored in the same transaction, so a failure leaves no gap.
// That transaction runs as the owner (app_tenant may only read invoices) but
// with app.firm_id set, so row-level security still limits it to one firm.
// Invoices never change once issued (a credit note would correct one).
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  PLATFORM_LEGAL_NAME,
  type ConsolePlatformInvoice,
  type PlatformInvoice,
} from '@ahava88/shared';
import { db, rootDb } from '../db/client';
import { withTenant } from '../db/tenant';
import {
  firmSubscriptions,
  firms,
  platformCounters,
  platformInvoices,
  subscriptionCheckouts,
  subscriptionPayments,
  subscriptionPlans,
  users,
  type FirmRow,
  type InvoiceParty,
  type PlatformInvoiceRow,
} from '../db/schema';
import { httpError } from '../lib/http';
import { isUuid } from '../lib/ids';
import { reportError } from '../lib/monitoring';
import { iso, isoOrNull } from '../lib/time';
import { firmOrigin } from './firm.service';
import { sendMail } from './mail.service';
import { platformInvoicePdf } from './pdf.service';

const COUNTER = 'platform_invoice';

type OwnerTx = Parameters<Parameters<ReturnType<typeof rootDb>['transaction']>[0]>[0];

/** A platform transaction limited (by row-level security) to one firm's rows. */
function inFirm<T>(firmId: string, fn: (tx: OwnerTx) => Promise<T>): Promise<T> {
  return rootDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.firm_id', ${firmId}, true)`);
    return fn(tx);
  });
}

function vatRate(): number {
  const value = Number(process.env.PLATFORM_VAT_RATE ?? 0.15);
  return Number.isFinite(value) && value >= 0 ? value : 0.15;
}

export function supplier(): InvoiceParty {
  return {
    name: String(process.env.PLATFORM_LEGAL_NAME || '').trim() || PLATFORM_LEGAL_NAME,
    address: String(process.env.PLATFORM_ADDRESS || '').trim(),
    vatNumber: String(process.env.PLATFORM_VAT_NUMBER || '').trim() || null,
    registrationNumber: String(process.env.PLATFORM_REGISTRATION_NUMBER || '').trim() || null,
  };
}

const prefix = () =>
  (String(process.env.PLATFORM_INVOICE_PREFIX || '').trim() || 'PI').toUpperCase();

function recipient(firm: FirmRow): InvoiceParty {
  return {
    name: firm.legalName,
    address: firm.billingSettings.address?.trim() || '',
    vatNumber: firm.vatNumber?.trim() || null,
    registrationNumber: firm.profile.registrationNumber?.trim() || null,
  };
}

function minusInterval(end: Date, interval: string): Date {
  const start = new Date(end.getTime());
  const dayOfMonth = start.getUTCDate();
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - (interval === 'annual' ? 12 : 1));
  const lastDay = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  ).getUTCDate();
  start.setUTCDate(Math.min(dayOfMonth, lastDay));
  return start;
}

/** VAT included in a VAT-inclusive amount (the tax fraction), in cents. */
export function vatIncluded(totalCents: number, rate: number): number {
  return rate > 0 ? Math.round((totalCents * rate) / (1 + rate)) : 0;
}

export function toInvoice(row: PlatformInvoiceRow): PlatformInvoice {
  return {
    id: row.id,
    number: row.number,
    taxInvoice: row.taxInvoice,
    issuedAt: iso(row.issuedAt),
    supplier: row.supplier,
    recipient: row.recipient,
    lines: row.lines,
    vatRate: row.vatRateBp / 10_000,
    exclusiveCents: row.exclusiveCents,
    vatCents: row.vatCents,
    totalCents: row.totalCents,
    paymentReference: row.pfPaymentId,
    periodStart: isoOrNull(row.periodStart),
    periodEnd: isoOrNull(row.periodEnd),
  };
}

/**
 * Issues the invoice for one confirmed payment (platform work: runs as the
 * owner, outside any request). Returns the existing invoice if there is one.
 */
export async function issueForPayment(
  firmId: string,
  paymentId: string,
): Promise<PlatformInvoiceRow | null> {
  const issued = await inFirm(firmId, async (tx) => {
    const [payment] = await tx
      .select()
      .from(subscriptionPayments)
      .where(and(eq(subscriptionPayments.id, paymentId), eq(subscriptionPayments.firmId, firmId)));
    if (!payment || payment.status !== 'complete') return null;
    const [existing] = await tx
      .select()
      .from(platformInvoices)
      .where(eq(platformInvoices.paymentId, payment.id));
    if (existing) return { row: existing, fresh: false };

    const [firm] = await tx.select().from(firms).where(eq(firms.id, payment.firmId));
    const [sub] = await tx
      .select()
      .from(firmSubscriptions)
      .where(eq(firmSubscriptions.firmId, payment.firmId));
    const [checkout] = payment.checkoutId
      ? await tx
          .select()
          .from(subscriptionCheckouts)
          .where(eq(subscriptionCheckouts.id, payment.checkoutId))
      : [];
    if (!firm || !sub) throw new Error('Payment without a firm subscription');

    // What was bought: the checkout for a first payment, else the agreement.
    const planCode = checkout?.planCode ?? sub.planCode ?? '';
    const seats = checkout?.seats ?? sub.seats ?? 1;
    const interval = checkout?.interval ?? sub.interval ?? 'monthly';
    const [plan] = await tx
      .select({ name: subscriptionPlans.name })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.code, planCode));

    // The period is known when this is the firm's latest payment.
    const [latest] = await tx
      .select({ id: subscriptionPayments.id })
      .from(subscriptionPayments)
      .where(
        and(
          eq(subscriptionPayments.firmId, payment.firmId),
          eq(subscriptionPayments.status, 'complete'),
        ),
      )
      .orderBy(desc(subscriptionPayments.paidAt))
      .limit(1);
    const periodEnd = latest?.id === payment.id ? sub.paidThrough : null;

    const from = supplier();
    const rate = vatRate();
    const taxInvoice = Boolean(from.vatNumber) && rate > 0;
    const vatCents = taxInvoice ? vatIncluded(payment.amountCents, rate) : 0;
    const exclusiveCents = payment.amountCents - vatCents;

    const [counter] = await tx
      .insert(platformCounters)
      .values({ name: COUNTER, value: 1 })
      .onConflictDoUpdate({
        target: platformCounters.name,
        set: { value: sql`${platformCounters.value} + 1` },
      })
      .returning({ value: platformCounters.value });
    const number = `${prefix()}-${String(counter!.value).padStart(6, '0')}`;

    const [row] = await tx
      .insert(platformInvoices)
      .values({
        firmId: firm.id,
        paymentId: payment.id,
        number,
        taxInvoice,
        issuedAt: payment.paidAt,
        supplier: from,
        recipient: recipient(firm),
        lines: [
          {
            description: `${plan?.name ?? planCode} subscription: ${seats} ${
              seats === 1 ? 'seat' : 'seats'
            }, billed ${interval === 'annual' ? 'yearly' : 'monthly'}`,
            quantity: seats,
            amountCents: exclusiveCents,
          },
        ],
        vatRateBp: taxInvoice ? Math.round(rate * 10_000) : 0,
        exclusiveCents,
        vatCents,
        totalCents: payment.amountCents,
        pfPaymentId: payment.pfPaymentId,
        periodStart: periodEnd ? minusInterval(periodEnd, interval) : null,
        periodEnd,
      })
      .returning();
    return { row: row!, fresh: true };
  });
  if (!issued) return null;
  if (issued.fresh) {
    try {
      await emailInvoice(issued.row);
    } catch (error) {
      // The invoice stands; administrators can download it under Subscription.
      reportError(error, { path: 'platform-invoice-email' });
    }
  }
  return issued.row;
}

/** Sends the invoice PDF to the firm's administrators. */
async function emailInvoice(row: PlatformInvoiceRow) {
  const [firm] = await rootDb().select().from(firms).where(eq(firms.id, row.firmId));
  if (!firm) return;
  const invoice = toInvoice(row);
  const pdf = await platformInvoicePdf(invoice);
  const label = invoice.taxInvoice ? 'Tax invoice' : 'Invoice';
  await withTenant(
    firm,
    async () => {
      const admins = await db()
        .select({ email: users.email, fullName: users.fullName })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.isActive, true)));
      for (const admin of admins) {
        await sendMail({
          platform: true,
          to: admin.email,
          subject: `${label} ${invoice.number} for your subscription`,
          text: [
            `Hello ${admin.fullName},`,
            '',
            `Attached is ${label.toLowerCase()} ${invoice.number} for the subscription payment PayFast collected (reference ${invoice.paymentReference}).`,
            'All invoices are also under Account → Subscription:',
            '',
            `${firmOrigin(firm)}/?view=account#subscription`,
          ].join('\n'),
          attachments: [
            { filename: `${invoice.number}.pdf`, content: pdf, contentType: 'application/pdf' },
          ],
        });
      }
    },
    { system: true },
  );
}

/** Catches up: invoices for confirmed payments that have none (run by `ops subscriptions`). */
export async function issueMissing(): Promise<{ issued: number; failed: number }> {
  let issued = 0;
  let failed = 0;
  for (const firm of await rootDb().select({ id: firms.id }).from(firms)) {
    const missing = await inFirm(firm.id, (tx) =>
      tx
        .select({ id: subscriptionPayments.id })
        .from(subscriptionPayments)
        .leftJoin(platformInvoices, eq(platformInvoices.paymentId, subscriptionPayments.id))
        .where(
          and(
            eq(subscriptionPayments.status, 'complete'),
            isNull(platformInvoices.id),
            eq(subscriptionPayments.firmId, firm.id),
          ),
        )
        .orderBy(asc(subscriptionPayments.paidAt)),
    );
    for (const { id } of missing) {
      try {
        if (await issueForPayment(firm.id, id)) issued += 1;
      } catch (error) {
        failed += 1;
        reportError(error, { path: 'platform-invoice-issue' });
      }
    }
  }
  return { issued, failed };
}

/** After a confirmed ITN: invoice it now (the catch-up job retries failures). */
export async function issueAfterItn(firmId: string, pfPaymentId: string): Promise<void> {
  try {
    const [payment] = await inFirm(firmId, (tx) =>
      tx
        .select({ id: subscriptionPayments.id })
        .from(subscriptionPayments)
        .where(
          and(
            eq(subscriptionPayments.firmId, firmId),
            eq(subscriptionPayments.pfPaymentId, pfPaymentId),
          ),
        ),
    );
    if (payment) await issueForPayment(firmId, payment.id);
  } catch (error) {
    reportError(error, { path: 'platform-invoice-issue' });
  }
}

// ------------------------------------------------------ the firm's view

export async function listForFirm(): Promise<PlatformInvoice[]> {
  const rows = await db()
    .select()
    .from(platformInvoices)
    .orderBy(desc(platformInvoices.issuedAt))
    .limit(500);
  return rows.map(toInvoice);
}

export async function pdfForFirm(id: string): Promise<{ number: string; pdf: Buffer }> {
  if (!isUuid(id)) throw httpError('Invoice not found', 404);
  const [row] = await db().select().from(platformInvoices).where(eq(platformInvoices.id, id));
  if (!row) throw httpError('Invoice not found', 404);
  return { number: row.number, pdf: await platformInvoicePdf(toInvoice(row)) };
}

// ---------------------------------------------------- the console's view

export async function listAll(limit = 500): Promise<ConsolePlatformInvoice[]> {
  const out: ConsolePlatformInvoice[] = [];
  for (const firm of await rootDb().select().from(firms)) {
    const rows = await inFirm(firm.id, (tx) =>
      tx
        .select()
        .from(platformInvoices)
        .where(eq(platformInvoices.firmId, firm.id))
        .orderBy(desc(platformInvoices.issuedAt))
        .limit(limit),
    );
    out.push(...rows.map((row) => ({ ...toInvoice(row), firmId: firm.id, firmSlug: firm.slug })));
  }
  return out.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)).slice(0, limit);
}

export async function pdfForConsole(
  firmId: string,
  id: string,
): Promise<{ number: string; pdf: Buffer }> {
  if (!isUuid(firmId) || !isUuid(id)) throw httpError('Invoice not found', 404);
  const [row] = await inFirm(firmId, (tx) =>
    tx
      .select()
      .from(platformInvoices)
      .where(and(eq(platformInvoices.id, id), eq(platformInvoices.firmId, firmId))),
  );
  if (!row) throw httpError('Invoice not found', 404);
  return { number: row.number, pdf: await platformInvoicePdf(toInvoice(row)) };
}
