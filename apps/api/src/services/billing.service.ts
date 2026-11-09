// Billing: invoices drawn from a matter's unbilled time and disbursements,
// payments, client statements, aging, and the trust/operating ledger.
//
// - A draft holds the time and disbursements on it (other drafts can't take
//   them, and the time can't change) until it is issued or deleted.
// - Issuing gives the invoice the firm's next number. The counter moves in the
//   same transaction, so numbers are sequential with no gaps; a voided
//   invoice keeps its number and returns its time to work in progress.
// - What may name people (subject, notes, line descriptions) is encrypted
//   with the firm's data key. Amounts, numbers and dates stay in clear columns
//   for totals and reports. Audit rows carry only numbers.
// - Amounts are integer cents; the API accepts and returns rands.
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type {
  AgingBuckets,
  AgingReport,
  BillingSummary,
  ClientStatement,
  Disbursement,
  Invoice,
  InvoiceLine,
  InvoicePayment,
  InvoiceStatus,
  LedgerEntry,
  PaymentMethod,
  StatementLine,
} from '@ahava88/shared';
import { db } from '../db/client';
import { currentFirm } from '../db/tenant-context';
import { nextValue } from '../db/sequences';
import { atomically } from '../db/tenant';
import {
  caseParties,
  cases,
  disbursements,
  invoicePayments,
  invoices,
  ledgerEntries,
  parties,
  timeEntries,
  users,
  type CaseRow,
  type FirmRow,
  type DisbursementRow,
  type InvoiceContent,
  type InvoiceLineRecord,
  type InvoicePaymentRow,
  type InvoiceRow,
  type LedgerRow,
} from '../db/schema';
import { httpError } from '../lib/http';
import { isUuid } from '../lib/ids';
import { actorName, type Actor } from '../lib/actor';
import { fromCents, toCents, vatRate } from '../lib/money';
import { iso, isoOrNull, localDate } from '../lib/time';
import {
  disbursementSchema,
  invoiceDraftSchema,
  invoiceSendSchema,
  invoiceUpdateSchema,
  ledgerEntrySchema,
  parse,
  paymentSchema,
} from '../validation/schemas';
import { decryptJson, encryptJson } from './privacy.service';
import { getFirmBrand } from '../config/brand';
import { invoicePdf, statementPdf, type Letterhead, type PdfParty } from './pdf.service';
import { readAsset } from './white-label.service';
import { sendMail } from './mail.service';
import { partyDetails } from './party.service';
import { billingSettings, profileSettings } from './firm-settings.service';
import { isClosed } from '../lib/matter-status';
import * as intakeService from './intake.service';
import * as auditService from './audit.service';

const OPEN_STATUSES = ['issued', 'partially_paid'];
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- amounts

/** The VAT rate (basis points) the firm charges now: 0 when not a VAT vendor. */
export function firmVatBp(): number {
  return billingSettings(currentFirm()).vatRegistered ? Math.round(vatRate() * 10_000) : 0;
}

export function totals(lines: InvoiceLineRecord[], vatBp: number) {
  const subtotalCents = lines.reduce((total, line) => total + line.amountCents, 0);
  const vatableCents = lines
    .filter((line) => line.vatable)
    .reduce((total, line) => total + line.amountCents, 0);
  const vatCents = Math.round((vatableCents * vatBp) / 10_000);
  return { subtotalCents, vatCents, totalCents: subtotalCents + vatCents };
}

// ---------------------------------------------------------------- presenting

async function invoiceContent(row: InvoiceRow): Promise<InvoiceContent> {
  if (row.contentEncrypted) {
    return (await decryptJson<InvoiceContent>(row.contentEncrypted)) ?? { subject: '', lines: [] };
  }
  // Invoices from before epic 7.
  return {
    subject: row.subject,
    lines: row.lineItems.map((item) => ({
      kind: 'other' as const,
      description: item.description,
      quantity: item.quantity,
      unitCents: item.rateCents,
      amountCents: Math.round(item.quantity * item.rateCents),
      vatable: row.vatCents > 0,
    })),
  };
}

function presentLine(line: InvoiceLineRecord): InvoiceLine {
  return {
    kind: line.kind,
    description: line.description,
    quantity: line.quantity,
    unitPrice: fromCents(line.unitCents),
    amount: fromCents(line.amountCents),
    vatable: line.vatable,
    workDate: line.workDate ?? null,
    feeEarner: line.feeEarner ?? null,
    timeEntryId: line.timeEntryId ?? null,
    disbursementId: line.disbursementId ?? null,
  };
}

function presentPayment(row: InvoicePaymentRow): InvoicePayment {
  return {
    id: row.id,
    amount: fromCents(row.amountCents),
    receivedOn: row.receivedOn,
    method: row.method as PaymentMethod,
    reference: row.reference,
    createdAt: iso(row.createdAt),
  };
}

async function formatInvoice(
  row: InvoiceRow,
  payments: InvoicePaymentRow[] = [],
): Promise<Invoice> {
  const content = await invoiceContent(row);
  const vatBp =
    row.vatRateBp ??
    (row.subtotalCents ? Math.round((row.vatCents / row.subtotalCents) * 10_000) : 0);
  return {
    id: row.id,
    caseId: row.caseId,
    caseNumber: row.caseNumber,
    clientLabel: row.clientLabel,
    clientPartyId: row.clientPartyId,
    number: row.invoiceNumber,
    subject: content.subject,
    notes: content.notes ?? '',
    currency: row.currency,
    status: row.status as InvoiceStatus,
    lines: content.lines.map(presentLine),
    lineItems: content.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      rate: fromCents(line.unitCents),
    })),
    subtotal: fromCents(row.subtotalCents),
    vat: fromCents(row.vatCents),
    vatRate: vatBp / 10_000,
    total: fromCents(row.totalCents),
    paid: fromCents(row.paidCents),
    balance: row.status === 'void' || row.status === 'draft' ? 0 : fromCents(balanceCents(row)),
    payments: payments.map(presentPayment),
    issuedAt: isoOrNull(row.issuedAt),
    dueAt: isoOrNull(row.dueAt),
    paidAt: isoOrNull(row.paidAt),
    sentAt: isoOrNull(row.sentAt),
    voidedAt: isoOrNull(row.voidedAt),
    createdAt: iso(row.createdAt),
  };
}

function balanceCents(row: InvoiceRow): number {
  return row.totalCents - row.paidCents;
}

async function paymentsFor(invoiceIds: string[]): Promise<Map<string, InvoicePaymentRow[]>> {
  const byInvoice = new Map<string, InvoicePaymentRow[]>();
  if (!invoiceIds.length) return byInvoice;
  const rows = await db()
    .select()
    .from(invoicePayments)
    .where(inArray(invoicePayments.invoiceId, invoiceIds))
    .orderBy(asc(invoicePayments.receivedOn), asc(invoicePayments.createdAt));
  for (const row of rows) {
    byInvoice.set(row.invoiceId, [...(byInvoice.get(row.invoiceId) ?? []), row]);
  }
  return byInvoice;
}

/** Invoices with their payments, in the API shape (used by exports too). */
export async function presentInvoices(rows: InvoiceRow[]): Promise<Invoice[]> {
  const payments = await paymentsFor(rows.map((row) => row.id));
  return Promise.all(rows.map((row) => formatInvoice(row, payments.get(row.id) ?? [])));
}

async function present(row: InvoiceRow): Promise<Invoice> {
  return formatInvoice(row, (await paymentsFor([row.id])).get(row.id) ?? []);
}

function formatLedgerEntry(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    caseId: row.caseId,
    caseNumber: row.caseNumber,
    entryType: row.entryType,
    account: row.account,
    amount: fromCents(row.amountCents),
    reference: row.reference,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
  };
}

async function auditInvoice(
  action: string,
  summary: string,
  row: InvoiceRow,
  actor: Actor,
  extra: Record<string, unknown> = {},
) {
  await auditService.logEvent(
    {
      entityType: 'invoice',
      entityId: row.id,
      action,
      summary,
      details: {
        caseId: row.caseId,
        number: row.invoiceNumber,
        totalCents: row.totalCents,
        ...extra,
      },
    },
    actor,
  );
}

// ---------------------------------------------------------------- invoices

export interface InvoiceQuery {
  caseId?: string;
  status?: string;
  clientPartyId?: string;
  limit?: number;
}

export async function listInvoices(query: InvoiceQuery | number = {}): Promise<Invoice[]> {
  const options = typeof query === 'number' ? { limit: query } : query;
  const conditions: SQL[] = [];
  if (options.caseId) conditions.push(eq(invoices.caseId, options.caseId));
  if (options.status) conditions.push(eq(invoices.status, options.status));
  if (options.clientPartyId) conditions.push(eq(invoices.clientPartyId, options.clientPartyId));
  const rows = await db()
    .select()
    .from(invoices)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(invoices.createdAt))
    .limit(Math.min(Math.max(options.limit ?? 200, 1), 500));
  return presentInvoices(rows);
}

async function requireInvoice(id: string): Promise<InvoiceRow> {
  if (!isUuid(id)) {
    throw httpError('Invoice not found', 404);
  }
  const [row] = await db().select().from(invoices).where(eq(invoices.id, id)).limit(1);
  if (!row) {
    throw httpError('Invoice not found', 404);
  }
  return row;
}

export async function getInvoice(id: string): Promise<Invoice> {
  return present(await requireInvoice(id));
}

async function requireDraft(id: string): Promise<InvoiceRow> {
  const row = await requireInvoice(id);
  if (row.status !== 'draft') {
    throw httpError('Only a draft invoice can change', 409);
  }
  return row;
}

/** The matter's client (the first linked as client), if it has one. */
async function matterClient(caseId: string): Promise<string | null> {
  const [link] = await db()
    .select({ partyId: caseParties.partyId })
    .from(caseParties)
    .where(and(eq(caseParties.caseId, caseId), eq(caseParties.role, 'client')))
    .orderBy(asc(caseParties.createdAt))
    .limit(1);
  return link?.partyId ?? null;
}

function manualLines(
  lines: Array<{ description: string; quantity: number; rate: number; vatable: boolean }>,
  subject: string,
): InvoiceLineRecord[] {
  return lines.map((line) => {
    const unitCents = toCents(line.rate);
    return {
      kind: 'other',
      description: line.description || subject,
      quantity: line.quantity,
      unitCents,
      amountCents: Math.round(line.quantity * unitCents),
      vatable: line.vatable,
    };
  });
}

async function billableTime(matter: CaseRow, ids: 'all' | string[]) {
  if (Array.isArray(ids) && !ids.length) return [];
  const rows = await db()
    .select({ entry: timeEntries, fullName: users.fullName })
    .from(timeEntries)
    .innerJoin(users, eq(users.id, timeEntries.userId))
    .where(
      and(
        eq(timeEntries.caseId, matter.id),
        eq(timeEntries.status, 'unbilled'),
        eq(timeEntries.billable, true),
        isNull(timeEntries.invoiceId),
        ids === 'all' ? undefined : inArray(timeEntries.id, ids),
      ),
    )
    .orderBy(asc(timeEntries.workDate), asc(timeEntries.createdAt));
  if (Array.isArray(ids) && rows.length !== new Set(ids).size) {
    throw httpError(
      'Some of that time is not unbilled billable time on this matter, or is on another draft',
      409,
    );
  }
  return rows;
}

async function billableDisbursements(matter: CaseRow, ids: 'all' | string[]) {
  if (Array.isArray(ids) && !ids.length) return [];
  const rows = await db()
    .select()
    .from(disbursements)
    .where(
      and(
        eq(disbursements.caseId, matter.id),
        eq(disbursements.status, 'unbilled'),
        isNull(disbursements.invoiceId),
        ids === 'all' ? undefined : inArray(disbursements.id, ids),
      ),
    )
    .orderBy(asc(disbursements.incurredOn), asc(disbursements.createdAt));
  if (Array.isArray(ids) && rows.length !== new Set(ids).size) {
    throw httpError(
      'Some of those disbursements are not unbilled on this matter, or are on another draft',
      409,
    );
  }
  return rows;
}

/** Drafts an invoice for a matter from its unbilled time and disbursements. */
async function createDraftSteps(input: unknown, actor: Actor = {}): Promise<Invoice> {
  const draft = parse(invoiceDraftSchema, input);
  const matter = await intakeService.findCaseByRef(draft.caseRef);
  if (!matter) {
    throw httpError('Case not found', 404);
  }

  const time = await billableTime(matter, draft.timeEntryIds);
  const costs = await billableDisbursements(matter, draft.disbursementIds);
  const lines: InvoiceLineRecord[] = [
    ...(await Promise.all(
      time.map(async ({ entry, fullName }): Promise<InvoiceLineRecord> => ({
        kind: 'fee',
        description: (await decryptJson<string>(entry.descriptionEncrypted)) ?? '',
        quantity: entry.units / 10,
        unitCents: entry.rateCents,
        amountCents: entry.amountCents,
        vatable: true,
        workDate: entry.workDate,
        feeEarner: fullName,
        timeEntryId: entry.id,
      })),
    )),
    ...(await Promise.all(
      costs.map(async (cost): Promise<InvoiceLineRecord> => ({
        kind: 'disbursement',
        description: (await decryptJson<string>(cost.descriptionEncrypted)) ?? '',
        quantity: 1,
        unitCents: cost.amountCents,
        amountCents: cost.amountCents,
        vatable: cost.vatable,
        workDate: cost.incurredOn,
        disbursementId: cost.id,
      })),
    )),
    ...manualLines(draft.lines, draft.subject),
  ];
  if (!lines.length) {
    throw httpError('Nothing to bill: no unbilled time, disbursements or lines', 400);
  }

  const vatRateBp = firmVatBp();
  const content: InvoiceContent = { subject: draft.subject, notes: draft.notes, lines };
  const [saved] = await db()
    .insert(invoices)
    .values({
      caseId: matter.id,
      caseNumber: matter.caseNumber,
      clientLabel: matter.clientLabel,
      clientPartyId: await matterClient(matter.id),
      status: 'draft',
      contentEncrypted: await encryptJson(content),
      vatRateBp,
      ...totals(lines, vatRateBp),
      createdBy: actorName(actor),
    })
    .returning();
  if (!saved) {
    throw new Error('Invoice was not stored');
  }

  // Hold the time and disbursements on this draft.
  if (time.length) {
    const held = await db()
      .update(timeEntries)
      .set({ invoiceId: saved.id, updatedAt: new Date() })
      .where(
        and(
          inArray(
            timeEntries.id,
            time.map(({ entry }) => entry.id),
          ),
          isNull(timeEntries.invoiceId),
          eq(timeEntries.status, 'unbilled'),
        ),
      )
      .returning({ id: timeEntries.id });
    if (held.length !== time.length) {
      throw httpError('Some of that time was billed meanwhile; try again', 409);
    }
  }
  if (costs.length) {
    const held = await db()
      .update(disbursements)
      .set({ invoiceId: saved.id, updatedAt: new Date() })
      .where(
        and(
          inArray(
            disbursements.id,
            costs.map((cost) => cost.id),
          ),
          isNull(disbursements.invoiceId),
          eq(disbursements.status, 'unbilled'),
        ),
      )
      .returning({ id: disbursements.id });
    if (held.length !== costs.length) {
      throw httpError('Some of those disbursements were billed meanwhile; try again', 409);
    }
  }

  await auditInvoice('invoice_drafted', `Draft invoice on ${matter.caseNumber}`, saved, actor, {
    timeEntries: time.length,
    disbursements: costs.length,
  });
  return present(saved);
}

/** Changes a draft's subject, notes or manual lines. */
export async function updateDraft(id: string, input: unknown, actor: Actor = {}): Promise<Invoice> {
  const changes = parse(invoiceUpdateSchema, input);
  const row = await requireDraft(id);
  const content = await invoiceContent(row);
  const subject = changes.subject ?? content.subject;
  const lines = changes.lines
    ? [
        ...content.lines.filter((line) => line.kind !== 'other'),
        ...manualLines(changes.lines, subject),
      ]
    : content.lines;
  if (!lines.length) {
    throw httpError('An invoice needs at least one line', 400);
  }
  const vatRateBp = firmVatBp();
  const [saved] = await db()
    .update(invoices)
    .set({
      contentEncrypted: await encryptJson({
        subject,
        notes: changes.notes !== undefined ? changes.notes : content.notes,
        lines,
      }),
      vatRateBp,
      ...totals(lines, vatRateBp),
      updatedAt: new Date(),
    })
    .where(and(eq(invoices.id, row.id), eq(invoices.status, 'draft')))
    .returning();
  if (!saved) {
    throw httpError('Only a draft invoice can change', 409);
  }
  await auditInvoice('invoice_draft_updated', 'Draft invoice changed', saved, actor);
  return present(saved);
}

async function release(invoiceId: string) {
  await db()
    .update(timeEntries)
    .set({ invoiceId: null, status: 'unbilled', updatedAt: new Date() })
    .where(eq(timeEntries.invoiceId, invoiceId));
  await db()
    .update(disbursements)
    .set({ invoiceId: null, status: 'unbilled', updatedAt: new Date() })
    .where(eq(disbursements.invoiceId, invoiceId));
}

/** Deletes a draft; its time and disbursements return to work in progress. */
async function deleteDraftSteps(id: string, actor: Actor = {}): Promise<{ deleted: true }> {
  const row = await requireDraft(id);
  await release(row.id);
  await db()
    .delete(invoices)
    .where(and(eq(invoices.id, row.id), eq(invoices.status, 'draft')));
  await auditInvoice('invoice_draft_deleted', 'Draft invoice deleted', row, actor);
  return { deleted: true };
}

export function formatInvoiceNumber(value: number, prefix = 'INV'): string {
  return `${prefix}-${String(value).padStart(6, '0')}`;
}

/** Issues a draft: the next invoice number, due date, and its time billed. */
async function issueInvoiceSteps(id: string, actor: Actor = {}): Promise<Invoice> {
  const row = await requireDraft(id);
  const settings = billingSettings(currentFirm());
  if (settings.vatRegistered && !settings.vatNumber) {
    throw httpError(
      "Add the firm's VAT number (Account & team → Records → Billing) before issuing tax invoices",
      409,
    );
  }
  if (!settings.address) {
    throw httpError(
      "Add the firm's address (Account & team → Records → Billing) before issuing invoices",
      409,
    );
  }
  const content = await invoiceContent(row);
  const vatRateBp = firmVatBp();
  const issuedAt = new Date();
  // Same transaction as the update below: if anything fails, the number is not used.
  const invoiceNumber = formatInvoiceNumber(
    await nextValue('invoice_number'),
    settings.invoicePrefix,
  );
  const [taken] = await db()
    .select({ id: invoices.id })
    .from(invoices)
    .where(eq(invoices.invoiceNumber, invoiceNumber))
    .limit(1);
  if (taken) {
    throw httpError(`Invoice number ${invoiceNumber} is already in use`, 409);
  }

  const [saved] = await db()
    .update(invoices)
    .set({
      invoiceNumber,
      status: 'issued',
      vatRateBp,
      ...totals(content.lines, vatRateBp),
      issuedAt,
      dueAt: new Date(issuedAt.getTime() + settings.paymentTermsDays * DAY_MS),
      updatedAt: issuedAt,
    })
    .where(and(eq(invoices.id, row.id), eq(invoices.status, 'draft')))
    .returning();
  if (!saved) {
    throw httpError('Only a draft invoice can be issued', 409);
  }
  await db()
    .update(timeEntries)
    .set({ status: 'billed', updatedAt: issuedAt })
    .where(eq(timeEntries.invoiceId, saved.id));
  await db()
    .update(disbursements)
    .set({ status: 'billed', updatedAt: issuedAt })
    .where(eq(disbursements.invoiceId, saved.id));
  await auditInvoice('invoice_issued', `Invoice ${invoiceNumber} issued`, saved, actor);
  return present(saved);
}

/** Voids an unpaid issued invoice: the number stays used, its time returns to WIP. */
async function voidInvoiceSteps(id: string, actor: Actor = {}): Promise<Invoice> {
  const row = await requireInvoice(id);
  if (!OPEN_STATUSES.includes(row.status)) {
    throw httpError('Only an issued invoice can be voided (delete a draft instead)', 409);
  }
  if (row.paidCents > 0) {
    throw httpError('Reverse the payments on this invoice before voiding it', 409);
  }
  const [saved] = await db()
    .update(invoices)
    .set({ status: 'void', voidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(invoices.id, row.id), eq(invoices.paidCents, 0)))
    .returning();
  if (!saved) {
    throw httpError('Reverse the payments on this invoice before voiding it', 409);
  }
  await release(saved.id);
  await auditInvoice('invoice_voided', `Invoice ${row.invoiceNumber} voided`, saved, actor);
  return present(saved);
}

async function settle(row: InvoiceRow, paidCents: number, paidOn: string | null) {
  const status = paidCents >= row.totalCents ? 'paid' : paidCents > 0 ? 'partially_paid' : 'issued';
  const [saved] = await db()
    .update(invoices)
    .set({
      paidCents,
      status,
      paidAt: status === 'paid' && paidOn ? new Date(`${paidOn}T12:00:00Z`) : null,
      updatedAt: new Date(),
    })
    .where(and(eq(invoices.id, row.id), eq(invoices.paidCents, row.paidCents)))
    .returning();
  if (!saved) {
    throw httpError('The invoice changed meanwhile; try again', 409);
  }
  return saved;
}

async function recordPaymentSteps(id: string, input: unknown, actor: Actor = {}): Promise<Invoice> {
  const payment = parse(paymentSchema, input);
  const row = await requireInvoice(id);
  if (!OPEN_STATUSES.includes(row.status)) {
    throw httpError(
      row.status === 'paid'
        ? 'This invoice is paid in full'
        : 'Only an issued invoice takes payments',
      409,
    );
  }
  const receivedOn = payment.receivedOn ?? localDate();
  if (receivedOn > localDate()) {
    throw httpError("A payment can't be dated in the future", 400);
  }
  const amountCents = toCents(payment.amount);
  if (amountCents > balanceCents(row)) {
    throw httpError(
      `That is more than the R ${fromCents(balanceCents(row)).toFixed(2)} still owing`,
      400,
    );
  }
  const [stored] = await db()
    .insert(invoicePayments)
    .values({
      invoiceId: row.id,
      caseId: row.caseId,
      amountCents,
      receivedOn,
      method: payment.method,
      reference: payment.reference,
      recordedBy: actor.userId ?? null,
    })
    .returning();
  const saved = await settle(row, row.paidCents + amountCents, receivedOn);
  await auditInvoice('payment_recorded', `Payment on invoice ${row.invoiceNumber}`, saved, actor, {
    paymentId: stored?.id,
    amountCents,
    method: payment.method,
  });
  return present(saved);
}

/** Reverses a payment recorded in error (billing.void). */
async function reversePaymentSteps(
  id: string,
  paymentId: string,
  actor: Actor = {},
): Promise<Invoice> {
  const row = await requireInvoice(id);
  if (!isUuid(paymentId)) {
    throw httpError('Payment not found', 404);
  }
  const [payment] = await db()
    .delete(invoicePayments)
    .where(and(eq(invoicePayments.id, paymentId), eq(invoicePayments.invoiceId, row.id)))
    .returning();
  if (!payment) {
    throw httpError('Payment not found', 404);
  }
  const [latest] = await db()
    .select({ receivedOn: invoicePayments.receivedOn })
    .from(invoicePayments)
    .where(eq(invoicePayments.invoiceId, row.id))
    .orderBy(desc(invoicePayments.receivedOn))
    .limit(1);
  const saved = await settle(row, row.paidCents - payment.amountCents, latest?.receivedOn ?? null);
  await auditInvoice(
    'payment_reversed',
    `Payment reversed on invoice ${row.invoiceNumber}`,
    saved,
    actor,
    {
      paymentId,
      amountCents: payment.amountCents,
    },
  );
  return present(saved);
}

// ---------------------------------------------------------------- documents and email

async function clientFor(
  partyId: string | null,
  fallback: string,
): Promise<PdfParty & { email?: string }> {
  if (!partyId) {
    return { name: fallback };
  }
  const [party] = await db().select().from(parties).where(eq(parties.id, partyId)).limit(1);
  if (!party) {
    return { name: fallback };
  }
  const details = await partyDetails(party);
  return {
    name: details.name,
    address: details.address,
    email: details.email,
    reference: party.partyNumber,
  };
}

async function letterheadFor(firm: FirmRow): Promise<Letterhead> {
  const logo = firm.branding?.logoHash ? await readAsset('logo') : null;
  return {
    logo: logo && logo.contentType !== 'image/webp' ? logo.content : null,
    profile: profileSettings(firm),
  };
}

export interface RenderedPdf {
  fileName: string;
  content: Buffer;
}

/** The invoice as a branded PDF (drafts and voided invoices are stamped). */
export async function invoiceDocument(id: string, actor: Actor = {}): Promise<RenderedPdf> {
  const row = await requireInvoice(id);
  const invoice = await present(row);
  const firm = currentFirm();
  const client = await clientFor(row.clientPartyId, row.clientLabel);
  const content = await invoicePdf(
    invoice,
    getFirmBrand(firm),
    billingSettings(firm),
    client,
    await letterheadFor(firm),
  );
  await auditService.logEventSafely(
    {
      entityType: 'invoice',
      entityId: row.id,
      action: 'invoice_pdf_viewed',
      summary: `Invoice ${row.invoiceNumber ?? 'draft'} opened as PDF`,
      details: { caseId: row.caseId },
    },
    actor,
  );
  return { fileName: `${row.invoiceNumber ?? `draft-${row.caseNumber}`}.pdf`, content };
}

/** Emails an issued invoice (PDF attached) to the client, or to the address given. */
export async function sendInvoice(id: string, input: unknown, actor: Actor = {}): Promise<Invoice> {
  const { to } = parse(invoiceSendSchema, input ?? {});
  const row = await requireInvoice(id);
  if (!OPEN_STATUSES.includes(row.status) && row.status !== 'paid') {
    throw httpError('Only an issued invoice can be sent', 409);
  }
  const firm = currentFirm();
  const brand = getFirmBrand(firm);
  const settings = billingSettings(firm);
  const client = await clientFor(row.clientPartyId, row.clientLabel);
  const recipient = to ?? client.email;
  if (!recipient) {
    throw httpError('The client has no email address; add one or give an address', 400);
  }
  const invoice = await present(row);
  const content = await invoicePdf(invoice, brand, settings, client, await letterheadFor(firm));
  const due = invoice.dueAt ? ` by ${invoice.dueAt.slice(0, 10)}` : '';
  const sent = await sendMail({
    to: recipient,
    subject: `${brand.firmName}: invoice ${row.invoiceNumber}`,
    text: [
      `Dear ${client.name},`,
      '',
      `Please find invoice ${row.invoiceNumber} for matter ${row.caseNumber} attached.`,
      `Amount due: R ${invoice.balance.toFixed(2)}${due}.`,
      ...(settings.bankDetails ? ['', 'Payment details:', settings.bankDetails] : []),
      ...(row.invoiceNumber ? [`Reference: ${row.invoiceNumber}`] : []),
      '',
      'Kind regards,',
      brand.firmName,
    ].join('\n'),
    attachments: [
      { filename: `${row.invoiceNumber}.pdf`, content, contentType: 'application/pdf' },
    ],
  });
  if (!sent) {
    throw httpError('Email is not set up for this installation (SMTP_URL)', 503);
  }
  const [saved] = await db()
    .update(invoices)
    .set({ sentAt: new Date(), updatedAt: new Date() })
    .where(eq(invoices.id, row.id))
    .returning();
  // Not the address: audit rows are not encrypted.
  await auditInvoice('invoice_sent', `Invoice ${row.invoiceNumber} emailed`, saved ?? row, actor, {
    toClientAddress: !to || to === client.email,
  });
  return present(saved ?? row);
}

export async function statementDocument(
  partyId: string,
  range: { from?: string; to?: string },
): Promise<RenderedPdf> {
  const statement = await clientStatement(partyId, range);
  const firm = currentFirm();
  const client = await clientFor(partyId, statement.partyNumber);
  const content = await statementPdf(
    statement,
    getFirmBrand(firm),
    billingSettings(firm),
    client,
    await letterheadFor(firm),
  );
  return { fileName: `statement-${statement.partyNumber}-${statement.to}.pdf`, content };
}

// Each of these runs as one unit: a failure part-way leaves nothing behind
// (no draft without its time held, no invoice number used without an invoice).
export function createDraft(input: unknown, actor: Actor = {}): Promise<Invoice> {
  return atomically(() => createDraftSteps(input, actor));
}

export function deleteDraft(id: string, actor: Actor = {}): Promise<{ deleted: true }> {
  return atomically(() => deleteDraftSteps(id, actor));
}

export function issueInvoice(id: string, actor: Actor = {}): Promise<Invoice> {
  return atomically(() => issueInvoiceSteps(id, actor));
}

export function voidInvoice(id: string, actor: Actor = {}): Promise<Invoice> {
  return atomically(() => voidInvoiceSteps(id, actor));
}

export function recordPayment(id: string, input: unknown, actor: Actor = {}): Promise<Invoice> {
  return atomically(() => recordPaymentSteps(id, input, actor));
}

export function reversePayment(id: string, paymentId: string, actor: Actor = {}): Promise<Invoice> {
  return atomically(() => reversePaymentSteps(id, paymentId, actor));
}

// ---------------------------------------------------------------- disbursements

async function formatDisbursement(row: DisbursementRow, caseNumber: string): Promise<Disbursement> {
  return {
    id: row.id,
    caseId: row.caseId,
    caseNumber,
    incurredOn: row.incurredOn,
    description: (await decryptJson<string>(row.descriptionEncrypted)) ?? '',
    amount: fromCents(row.amountCents),
    vatable: row.vatable,
    status: row.status as Disbursement['status'],
    invoiceId: row.invoiceId,
    createdAt: iso(row.createdAt),
  };
}

export async function listDisbursements(
  query: { caseId?: string; status?: string } = {},
): Promise<Disbursement[]> {
  const conditions: SQL[] = [];
  if (query.caseId) conditions.push(eq(disbursements.caseId, query.caseId));
  if (query.status) conditions.push(eq(disbursements.status, query.status));
  const rows = await db()
    .select({ row: disbursements, caseNumber: cases.caseNumber })
    .from(disbursements)
    .innerJoin(cases, eq(cases.id, disbursements.caseId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(disbursements.incurredOn), desc(disbursements.createdAt))
    .limit(500);
  return Promise.all(rows.map(({ row, caseNumber }) => formatDisbursement(row, caseNumber)));
}

export async function recordDisbursement(input: unknown, actor: Actor = {}): Promise<Disbursement> {
  const cost = parse(disbursementSchema, input);
  const matter = await intakeService.findCaseByRef(cost.caseRef);
  if (!matter) {
    throw httpError('Case not found', 404);
  }
  if (isClosed(matter.status)) {
    throw httpError(`Matter ${matter.caseNumber} is closed`, 409);
  }
  const incurredOn = cost.incurredOn ?? localDate();
  if (incurredOn > localDate()) {
    throw httpError("A disbursement can't be dated in the future", 400);
  }
  const [saved] = await db()
    .insert(disbursements)
    .values({
      caseId: matter.id,
      incurredOn,
      descriptionEncrypted: await encryptJson(cost.description),
      amountCents: toCents(cost.amount),
      vatable: cost.vatable,
      createdBy: actor.userId ?? null,
    })
    .returning();
  if (!saved) {
    throw new Error('Disbursement was not stored');
  }
  await auditService.logEvent(
    {
      entityType: 'disbursement',
      entityId: saved.id,
      action: 'disbursement_recorded',
      summary: `Disbursement recorded on ${matter.caseNumber}`,
      details: { caseId: matter.id, amountCents: saved.amountCents, vatable: saved.vatable },
    },
    actor,
  );
  return formatDisbursement(saved, matter.caseNumber);
}

async function requireOpenDisbursement(id: string): Promise<DisbursementRow> {
  if (!isUuid(id)) {
    throw httpError('Disbursement not found', 404);
  }
  const [row] = await db().select().from(disbursements).where(eq(disbursements.id, id)).limit(1);
  if (!row) {
    throw httpError('Disbursement not found', 404);
  }
  if (row.status !== 'unbilled') {
    throw httpError(`This disbursement is ${row.status.replace('_', ' ')}`, 409);
  }
  if (row.invoiceId) {
    throw httpError('This disbursement is on a draft invoice; delete the draft first', 409);
  }
  return row;
}

export async function deleteDisbursement(
  id: string,
  actor: Actor = {},
): Promise<{ deleted: true }> {
  const row = await requireOpenDisbursement(id);
  await db().delete(disbursements).where(eq(disbursements.id, row.id));
  await auditService.logEvent(
    {
      entityType: 'disbursement',
      entityId: row.id,
      action: 'disbursement_deleted',
      summary: 'Disbursement deleted',
      details: { caseId: row.caseId, amountCents: row.amountCents },
    },
    actor,
  );
  return { deleted: true };
}

export async function writeOffDisbursement(id: string, actor: Actor = {}): Promise<Disbursement> {
  const row = await requireOpenDisbursement(id);
  const [saved] = await db()
    .update(disbursements)
    .set({ status: 'written_off', updatedAt: new Date() })
    .where(eq(disbursements.id, row.id))
    .returning();
  await auditService.logEvent(
    {
      entityType: 'disbursement',
      entityId: row.id,
      action: 'disbursement_written_off',
      summary: 'Disbursement written off',
      details: { caseId: row.caseId, amountCents: row.amountCents },
    },
    actor,
  );
  const [matter] = await db().select().from(cases).where(eq(cases.id, row.caseId));
  return formatDisbursement(saved!, matter?.caseNumber ?? '');
}

// ---------------------------------------------------------------- statements and aging

function emptyBuckets(): AgingBuckets {
  return { current: 0, days30: 0, days60: 0, days90: 0, days120: 0, total: 0 };
}

function bucketFor(dueAt: Date | null, asOf: string): keyof Omit<AgingBuckets, 'total'> {
  if (!dueAt) return 'current';
  const due = localDate(dueAt);
  const days = Math.round(
    (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / DAY_MS,
  );
  if (days <= 0) return 'current';
  if (days <= 30) return 'days30';
  if (days <= 60) return 'days60';
  if (days <= 90) return 'days90';
  return 'days120';
}

function addTo(buckets: AgingBuckets, bucket: keyof Omit<AgingBuckets, 'total'>, cents: number) {
  buckets[bucket] = Math.round(buckets[bucket] * 100 + cents) / 100;
  buckets.total = Math.round(buckets.total * 100 + cents) / 100;
}

/** Outstanding amounts on issued invoices as of a date, from invoices and payments up to it. */
function outstandingAsOf(
  rows: InvoiceRow[],
  payments: Map<string, InvoicePaymentRow[]>,
  asOf: string,
) {
  return rows
    .filter((row) => row.issuedAt && localDate(row.issuedAt) <= asOf)
    .map((row) => {
      const paid = (payments.get(row.id) ?? [])
        .filter((payment) => payment.receivedOn <= asOf)
        .reduce((total, payment) => total + payment.amountCents, 0);
      return { row, owing: row.totalCents - paid };
    })
    .filter(({ owing }) => owing > 0);
}

export async function agingReport(asOf: string = localDate()): Promise<AgingReport> {
  const rows = await db()
    .select()
    .from(invoices)
    .where(inArray(invoices.status, [...OPEN_STATUSES, 'paid']));
  const payments = await paymentsFor(rows.map((row) => row.id));
  const totalsByClient = new Map<string, { row: AgingReport['clients'][number] }>();
  const grand = emptyBuckets();
  for (const { row, owing } of outstandingAsOf(rows, payments, asOf)) {
    const key = row.clientPartyId ?? `label:${row.clientLabel}`;
    let entry = totalsByClient.get(key);
    if (!entry) {
      entry = {
        row: {
          clientPartyId: row.clientPartyId,
          clientLabel: row.clientLabel,
          invoices: 0,
          ...emptyBuckets(),
        },
      };
      totalsByClient.set(key, entry);
    }
    const bucket = bucketFor(row.dueAt, asOf);
    addTo(entry.row, bucket, owing);
    entry.row.invoices += 1;
    addTo(grand, bucket, owing);
  }
  return {
    asOf,
    totals: grand,
    clients: [...totalsByClient.values()].map(({ row }) => row).sort((a, b) => b.total - a.total),
  };
}

export async function clientStatement(
  partyId: string,
  range: { from?: string; to?: string } = {},
): Promise<ClientStatement> {
  if (!isUuid(partyId)) {
    throw httpError('Client not found', 404);
  }
  const [party] = await db().select().from(parties).where(eq(parties.id, partyId)).limit(1);
  if (!party) {
    throw httpError('Client not found', 404);
  }
  const to = range.to ?? localDate();
  const from = range.from ?? null;
  const rows = await db()
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.clientPartyId, party.id),
        inArray(invoices.status, [...OPEN_STATUSES, 'paid']),
      ),
    )
    .orderBy(asc(invoices.issuedAt));
  const payments = await paymentsFor(rows.map((row) => row.id));

  type Movement = Omit<StatementLine, 'balance'> & { cents: number };
  const movements: Movement[] = [];
  for (const row of rows) {
    if (!row.issuedAt) continue;
    movements.push({
      date: localDate(row.issuedAt),
      kind: 'invoice',
      reference: row.invoiceNumber ?? '',
      caseNumber: row.caseNumber,
      debit: fromCents(row.totalCents),
      credit: 0,
      cents: row.totalCents,
    });
    for (const payment of payments.get(row.id) ?? []) {
      movements.push({
        date: payment.receivedOn,
        kind: 'payment',
        reference: payment.reference || `Payment on ${row.invoiceNumber}`,
        caseNumber: row.caseNumber,
        debit: 0,
        credit: fromCents(payment.amountCents),
        cents: -payment.amountCents,
      });
    }
  }
  movements.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'invoice' ? -1 : 1));

  let balance = 0;
  let opening = 0;
  const lines: StatementLine[] = [];
  for (const { cents, ...movement } of movements) {
    if (movement.date > to) break;
    balance += cents;
    if (from && movement.date < from) {
      opening = balance;
      continue;
    }
    lines.push({ ...movement, balance: fromCents(balance) });
  }

  const aging = emptyBuckets();
  for (const { row, owing } of outstandingAsOf(rows, payments, to)) {
    addTo(aging, bucketFor(row.dueAt, to), owing);
  }

  return {
    partyId: party.id,
    partyNumber: party.partyNumber,
    clientName: (await partyDetails(party)).name,
    from,
    to,
    openingBalance: fromCents(opening),
    lines,
    closingBalance: fromCents(balance),
    aging,
  };
}

// ---------------------------------------------------------------- ledger

export async function listLedgerEntries(limit = 200): Promise<LedgerEntry[]> {
  const rows = await db()
    .select()
    .from(ledgerEntries)
    .orderBy(desc(ledgerEntries.createdAt))
    .limit(limit);
  return rows.map(formatLedgerEntry);
}

export async function recordLedgerEntry(input: unknown, actor: Actor = {}): Promise<LedgerEntry> {
  const entry = parse(ledgerEntrySchema, input);
  const caseRecord = await intakeService.findCaseByRef(entry.caseRef);
  if (!caseRecord) {
    throw httpError('Case not found', 404);
  }

  const [saved] = await db()
    .insert(ledgerEntries)
    .values({
      caseId: caseRecord.id,
      caseNumber: caseRecord.caseNumber,
      entryType: entry.entryType,
      account: entry.account,
      amountCents: toCents(entry.amount),
      reference: entry.reference,
      notes: entry.notes,
      createdBy: actorName(actor),
    })
    .returning();
  if (!saved) {
    throw new Error('Ledger entry was not stored');
  }

  await auditService.logEvent(
    {
      entityType: 'ledger',
      entityId: saved.id,
      action: 'ledger_entry_created',
      summary: `Ledger entry recorded: ${saved.entryType}`,
      details: { caseId: caseRecord.id, amountCents: saved.amountCents, account: saved.account },
    },
    actor,
  );

  return formatLedgerEntry(saved);
}

// ---------------------------------------------------------------- summary

export async function countUnpaidInvoices(): Promise<number> {
  const [row] = await db()
    .select({ value: sql<number>`count(*)::int` })
    .from(invoices)
    .where(inArray(invoices.status, OPEN_STATUSES));
  return row?.value ?? 0;
}

export async function getBillingSummary(): Promise<BillingSummary> {
  // Totals are computed in the database, over every row, in cents.
  const [invoiceTotals] = await db()
    .select({
      count: sql<number>`count(*) filter (where ${invoices.status} <> 'draft')::int`,
      drafts: sql<number>`count(*) filter (where ${invoices.status} = 'draft')::int`,
      outstanding: sql<string>`coalesce(sum(${invoices.totalCents} - ${invoices.paidCents}) filter (where ${invoices.status} in ('issued', 'partially_paid')), 0)`,
      overdue: sql<string>`coalesce(sum(${invoices.totalCents} - ${invoices.paidCents}) filter (where ${invoices.status} in ('issued', 'partially_paid') and ${invoices.dueAt} < now()), 0)`,
    })
    .from(invoices);
  const [wip] = await db()
    .select({ value: sql<string>`coalesce(sum(${timeEntries.amountCents}), 0)` })
    .from(timeEntries)
    .where(and(eq(timeEntries.status, 'unbilled'), eq(timeEntries.billable, true)));
  const [costs] = await db()
    .select({ value: sql<string>`coalesce(sum(${disbursements.amountCents}), 0)` })
    .from(disbursements)
    .where(eq(disbursements.status, 'unbilled'));
  const [ledgerTotals] = await db()
    .select({
      trust: sql<string>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${ledgerEntries.account} = 'trust'), 0)`,
      operating: sql<string>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${ledgerEntries.account} = 'operating'), 0)`,
    })
    .from(ledgerEntries);

  return {
    invoices: invoiceTotals?.count ?? 0,
    outstanding: fromCents(Number(invoiceTotals?.outstanding ?? 0)),
    overdue: fromCents(Number(invoiceTotals?.overdue ?? 0)),
    drafts: invoiceTotals?.drafts ?? 0,
    wip: fromCents(Number(wip?.value ?? 0)),
    unbilledDisbursements: fromCents(Number(costs?.value ?? 0)),
    trustBalance: fromCents(Number(ledgerTotals?.trust ?? 0)),
    operatingBalance: fromCents(Number(ledgerTotals?.operating ?? 0)),
    recentInvoices: await listInvoices(5),
    recentLedger: await listLedgerEntries(8),
  };
}
