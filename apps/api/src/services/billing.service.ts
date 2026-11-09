// Invoices and the trust/operating ledger.
//
// Amounts are stored as integer cents; the API accepts and returns rands.
// (Time recording, gap-free per-firm invoice numbering and trust accounting
// arrive in roadmap epic 7.)

import { desc, sql } from 'drizzle-orm';
import type { BillingSummary, Invoice, LedgerEntry } from '@ahava88/shared';
import { db } from '../db/client';
import {
  invoices,
  ledgerEntries,
  type InvoiceRow,
  type LedgerRow,
  type StoredLineItem,
} from '../db/schema';
import { httpError } from '../lib/http';
import { actorName, type Actor } from '../lib/actor';
import { fromCents, toCents, vatRate } from '../lib/money';
import { iso, isoOrNull, toDateOrNull } from '../lib/time';
import { invoiceSchema, ledgerEntrySchema, parse } from '../validation/schemas';
import * as intakeService from './intake.service';
import * as auditService from './audit.service';

function formatInvoice(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    caseId: row.caseId,
    caseNumber: row.caseNumber,
    clientLabel: row.clientLabel,
    number: row.invoiceNumber,
    subject: row.subject,
    currency: row.currency,
    status: row.status,
    lineItems: row.lineItems.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      rate: fromCents(item.rateCents),
    })),
    subtotal: fromCents(row.subtotalCents),
    vat: fromCents(row.vatCents),
    total: fromCents(row.totalCents),
    issuedAt: isoOrNull(row.issuedAt),
    dueAt: isoOrNull(row.dueAt),
    paidAt: isoOrNull(row.paidAt),
    createdAt: iso(row.createdAt),
  };
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

export async function listInvoices(limit = 200): Promise<Invoice[]> {
  const rows = await db().select().from(invoices).orderBy(desc(invoices.createdAt)).limit(limit);
  return rows.map(formatInvoice);
}

export async function listLedgerEntries(limit = 200): Promise<LedgerEntry[]> {
  const rows = await db()
    .select()
    .from(ledgerEntries)
    .orderBy(desc(ledgerEntries.createdAt))
    .limit(limit);
  return rows.map(formatLedgerEntry);
}

export async function createInvoice(input: unknown, actor: Actor = {}): Promise<Invoice> {
  const invoice = parse(invoiceSchema, input);
  const caseRecord = await intakeService.findCaseByRef(invoice.caseRef);
  if (!caseRecord) {
    throw httpError('caseId, subject, and lineItems are required', 400);
  }

  const lineItems: StoredLineItem[] = invoice.lineItems.map((item) => ({
    description: item.description || invoice.subject,
    quantity: item.quantity,
    rateCents: toCents(item.rate),
  }));
  const subtotalCents = lineItems.reduce(
    (total, item) => total + Math.round(item.quantity * item.rateCents),
    0,
  );
  const vatCents = invoice.vatIncluded === false ? 0 : Math.round(subtotalCents * vatRate());

  const [saved] = await db()
    .insert(invoices)
    .values({
      caseId: caseRecord.id,
      caseNumber: caseRecord.caseNumber,
      clientLabel: caseRecord.clientLabel,
      invoiceNumber: invoice.invoiceNumber || `INV-${Date.now()}`,
      subject: invoice.subject,
      currency: invoice.currency,
      status: invoice.status,
      lineItems,
      subtotalCents,
      vatCents,
      totalCents: subtotalCents + vatCents,
      issuedAt: toDateOrNull(invoice.issuedAt) ?? new Date(),
      dueAt: toDateOrNull(invoice.dueAt),
      paidAt: toDateOrNull(invoice.paidAt),
      createdBy: actorName(actor),
    })
    .onConflictDoNothing({ target: invoices.invoiceNumber })
    .returning();
  if (!saved) {
    throw httpError(`Invoice number ${invoice.invoiceNumber} is already in use`, 409);
  }

  await auditService.logEvent(
    {
      entityType: 'invoice',
      entityId: saved.id,
      action: 'invoice_created',
      summary: `Invoice created: ${saved.subject}`,
      details: { caseId: caseRecord.id, totalCents: saved.totalCents, currency: saved.currency },
    },
    actor,
  );

  return formatInvoice(saved);
}

export async function recordLedgerEntry(input: unknown, actor: Actor = {}): Promise<LedgerEntry> {
  const entry = parse(ledgerEntrySchema, input);
  const caseRecord = await intakeService.findCaseByRef(entry.caseRef);
  if (!caseRecord) {
    throw httpError('caseId, entryType, account, and amount are required', 400);
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

export async function countUnpaidInvoices(): Promise<number> {
  const [row] = await db()
    .select({ value: sql<number>`count(*) filter (where ${invoices.status} <> 'paid')::int` })
    .from(invoices);
  return row?.value ?? 0;
}

export async function getBillingSummary(): Promise<BillingSummary> {
  // Totals are computed in the database, over every row, in cents.
  const [invoiceTotals] = await db()
    .select({
      count: sql<number>`count(*)::int`,
      outstanding: sql<string>`coalesce(sum(${invoices.totalCents}) filter (where ${invoices.status} <> 'paid'), 0)`,
    })
    .from(invoices);
  const [ledgerTotals] = await db()
    .select({
      trust: sql<string>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${ledgerEntries.account} = 'trust'), 0)`,
      operating: sql<string>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${ledgerEntries.account} = 'operating'), 0)`,
    })
    .from(ledgerEntries);

  return {
    invoices: invoiceTotals?.count ?? 0,
    outstanding: fromCents(Number(invoiceTotals?.outstanding ?? 0)),
    trustBalance: fromCents(Number(ledgerTotals?.trust ?? 0)),
    operatingBalance: fromCents(Number(ledgerTotals?.operating ?? 0)),
    recentInvoices: await listInvoices(5),
    recentLedger: await listLedgerEntries(8),
  };
}
