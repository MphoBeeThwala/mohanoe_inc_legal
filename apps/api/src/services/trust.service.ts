// Trust accounting (Legal Practice Act s86). Built to be reviewed by the
// firm's auditor before live use, and switched on per firm by the platform.
//
// Controls enforced here:
// - One ledger per matter per trust bank account. Posted entries are never
//   changed or deleted; mistakes are corrected with a reversal.
// - No matter's ledger may go into debit: checked when money leaves, under a
//   lock on the trust account, so two payments can't both pass.
// - Receipts post when recorded. Money out (payments, fee transfers, matter
//   to matter transfers), opening balances, interest and reversals wait for
//   authorisation by a practitioner (trust.authorise) who is not the person
//   who requested them.
// - Fee transfers to the business account only against an issued invoice on
//   the same matter, for no more than it still owes; posting records the
//   invoice payment.
// - Monthly reconciliation: bank statement vs cash book vs the sum of client
//   ledgers, with uncleared items, signed off by a practitioner.
//
// References and descriptions are encrypted (bank references often carry a
// payer's name); audit rows carry matter numbers and amounts only.
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  TRUST_ENTRY_KINDS,
  type TrustAccount,
  type TrustAccountKind,
  type TrustEntry,
  type TrustEntryKind,
  type TrustLedger,
  type TrustLedgerLine,
  type TrustReconciliation,
} from '@ahava88/shared';
import { db } from '../db/client';
import { atomically, withSystemScope } from '../db/tenant';
import { currentFirm } from '../db/tenant-context';
import {
  cases,
  invoices,
  trustAccounts,
  trustEntries,
  trustReconciliations,
  type CaseRow,
  type TrustEntryRow,
  type TrustReconciliationRow,
} from '../db/schema';
import { httpError } from '../lib/http';
import { isUuid } from '../lib/ids';
import type { Actor } from '../lib/actor';
import { iso, isoOrNull, localDate } from '../lib/time';
import { toCents } from '../lib/money';
import { parse } from '../validation/schemas';
import { decryptJson, encryptJson } from './privacy.service';
import { findCaseByRef } from './intake.service';
import * as billing from './billing.service';
import * as auditService from './audit.service';

// ------------------------------------------------------------------ guards

export function trustEnabled(): boolean {
  return Boolean(currentFirm().features?.trustAccounting);
}

function requireTrust(): void {
  if (!trustEnabled()) {
    throw httpError('Trust accounting is not enabled for this firm.', 404);
  }
}

const money = z.coerce
  .number()
  .positive('The amount must be more than zero')
  .max(1_000_000_000)
  .refine(
    (value) => Math.round(value * 100) === Number((value * 100).toFixed(4)),
    'At most two decimals',
  );

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date (YYYY-MM-DD)');
const notFuture = (value: string) => value <= localDate();

const accountSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['trust', 'investment_86_3', 'investment_86_4']).default('trust'),
  bankName: z.string().trim().min(1).max(120),
  accountNumber: z
    .string()
    .trim()
    .regex(/^[\d -]{6,20}$/, 'A bank account number'),
});

const entrySchema = z.object({
  accountId: z.string().uuid(),
  caseRef: z.string().trim().min(1).max(120),
  amount: money,
  entryDate: calendarDate.refine(notFuture, "An entry can't be dated in the future").optional(),
  reference: z.string().trim().max(120).default(''),
  description: z.string().trim().min(1, 'Say what it is for').max(500),
});

const transferSchema = entrySchema.extend({ toCaseRef: z.string().trim().min(1).max(120) });
const feeTransferSchema = entrySchema
  .omit({ description: true })
  .extend({ invoiceId: z.string().uuid(), description: z.string().trim().max(500).optional() });
const openingSchema = entrySchema.extend({ direction: z.enum(['credit']).default('credit') });
const rejectSchema = z.object({ reason: z.string().trim().min(1).max(500) });
const clearSchema = z.object({
  entryIds: z.array(z.string().uuid()).min(1).max(500),
  clearedOn: calendarDate.refine(notFuture, "Can't clear in the future"),
});
const reconcileSchema = z.object({
  periodEnd: calendarDate.refine(notFuture, "A period can't end in the future"),
  bankBalance: z.coerce.number().min(-1_000_000_000).max(1_000_000_000),
  notes: z.string().trim().max(2000).optional(),
});
const signOffSchema = z.object({ notes: z.string().trim().max(2000).optional() });

const OUTGOING: TrustEntryKind[] = ['payment', 'transfer_to_business', 'transfer_out'];

// --------------------------------------------------------------- accounts

async function balanceOf(accountId: string, caseId?: string, upTo?: string): Promise<number> {
  const [row] = await db()
    .select({ total: sql<string>`coalesce(sum(${trustEntries.amountCents}), 0)` })
    .from(trustEntries)
    .where(
      and(
        eq(trustEntries.accountId, accountId),
        eq(trustEntries.status, 'posted'),
        caseId ? eq(trustEntries.caseId, caseId) : undefined,
        upTo ? lte(trustEntries.entryDate, upTo) : undefined,
      ),
    );
  return Number(row?.total ?? 0);
}

export async function listAccounts(): Promise<TrustAccount[]> {
  requireTrust();
  const rows = await db().select().from(trustAccounts).orderBy(asc(trustAccounts.name));
  // Account balances include every matter (restricted ones too).
  return withSystemScope(() =>
    Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind as TrustAccountKind,
        bankName: row.bankName,
        accountLast4: row.accountLast4,
        isActive: row.isActive,
        balanceCents: await balanceOf(row.id),
      })),
    ),
  );
}

export async function createAccount(input: unknown, actor: Actor): Promise<TrustAccount> {
  requireTrust();
  const account = parse(accountSchema, input);
  const digits = account.accountNumber.replace(/\D/g, '');
  const [row] = await db()
    .insert(trustAccounts)
    .values({
      name: account.name,
      kind: account.kind,
      bankName: account.bankName,
      accountNumberEncrypted: await encryptJson(digits),
      accountLast4: digits.slice(-4),
    })
    .returning();
  await auditService.logEvent(
    {
      entityType: 'trust_account',
      entityId: row!.id,
      action: 'trust_account_created',
      summary: `Trust account added (${account.kind}, ending ${digits.slice(-4)})`,
      details: { kind: account.kind },
    },
    actor,
  );
  return { ...(await listAccounts()).find((a) => a.id === row!.id)! };
}

async function requireAccount(id: string, lock = false) {
  if (!isUuid(id)) throw httpError('Trust account not found', 404);
  const query = db().select().from(trustAccounts).where(eq(trustAccounts.id, id));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw httpError('Trust account not found', 404);
  return row;
}

async function requireCase(ref: string): Promise<CaseRow> {
  const row = await findCaseByRef(ref);
  if (!row) throw httpError('Matter not found', 404);
  return row;
}

// ---------------------------------------------------------------- entries

async function present(row: TrustEntryRow): Promise<TrustEntry> {
  const [matter] = await db()
    .select({ caseNumber: cases.caseNumber })
    .from(cases)
    .where(eq(cases.id, row.caseId));
  const [invoice] = row.invoiceId
    ? await db()
        .select({ number: invoices.invoiceNumber })
        .from(invoices)
        .where(eq(invoices.id, row.invoiceId))
    : [];
  const [reversal] = await db()
    .select({ id: trustEntries.id })
    .from(trustEntries)
    .where(and(eq(trustEntries.reversesId, row.id), ne(trustEntries.status, 'rejected')));
  return {
    id: row.id,
    accountId: row.accountId,
    caseNumber: matter?.caseNumber ?? '',
    kind: row.kind as TrustEntryKind,
    amountCents: row.amountCents,
    entryDate: row.entryDate,
    reference: (await decryptJson<string>(row.referenceEncrypted)) ?? '',
    description: (await decryptJson<string>(row.descriptionEncrypted)) ?? '',
    status: row.status as TrustEntry['status'],
    invoiceNumber: invoice?.number ?? null,
    requestedBy: row.requestedBy,
    authorisedBy: row.authorisedBy,
    authorisedAt: isoOrNull(row.authorisedAt),
    rejectedReason: row.rejectedReason,
    reversesId: row.reversesId,
    reversedBy: reversal?.id ?? null,
    clearedOn: row.clearedOn,
    groupId: row.groupId,
  };
}

interface NewEntry {
  accountId: string;
  caseId: string;
  kind: TrustEntryKind;
  amountCents: number;
  entryDate: string;
  reference: string;
  description: string;
  status: 'pending' | 'posted';
  invoiceId?: string | null;
  groupId?: string | null;
  reversesId?: string | null;
}

async function insertEntry(entry: NewEntry, actor: Actor): Promise<TrustEntryRow> {
  const [row] = await db()
    .insert(trustEntries)
    .values({
      accountId: entry.accountId,
      caseId: entry.caseId,
      kind: entry.kind,
      amountCents: entry.amountCents,
      entryDate: entry.entryDate,
      referenceEncrypted: await encryptJson(entry.reference),
      descriptionEncrypted: await encryptJson(entry.description),
      status: entry.status,
      invoiceId: entry.invoiceId ?? null,
      groupId: entry.groupId ?? null,
      reversesId: entry.reversesId ?? null,
      requestedBy: actor.userId ?? null,
      ...(entry.status === 'posted'
        ? { authorisedBy: actor.userId ?? null, authorisedAt: new Date() }
        : {}),
    })
    .returning();
  return row!;
}

async function auditEntry(action: string, summary: string, row: TrustEntryRow, actor: Actor) {
  const [matter] = await db()
    .select({ caseNumber: cases.caseNumber })
    .from(cases)
    .where(eq(cases.id, row.caseId));
  await auditService.logEvent(
    {
      entityType: 'trust_entry',
      entityId: row.id,
      action,
      summary: `${summary} on ${matter?.caseNumber ?? 'a matter'}`,
      details: {
        caseNumber: matter?.caseNumber,
        kind: row.kind,
        amountCents: row.amountCents,
        accountId: row.accountId,
        status: row.status,
      },
    },
    actor,
  );
}

/** Money received into trust for a matter: posted at once. */
export function recordReceipt(input: unknown, actor: Actor): Promise<TrustEntry> {
  requireTrust();
  return atomically(async () => {
    const entry = parse(entrySchema, input);
    const account = await requireAccount(entry.accountId);
    if (!account.isActive) throw httpError('That trust account is closed', 409);
    const matter = await requireCase(entry.caseRef);
    const row = await insertEntry(
      {
        accountId: account.id,
        caseId: matter.id,
        kind: 'receipt',
        amountCents: toCents(entry.amount),
        entryDate: entry.entryDate ?? localDate(),
        reference: entry.reference,
        description: entry.description,
        status: 'posted',
      },
      actor,
    );
    await auditEntry('trust_receipt_recorded', 'Trust receipt recorded', row, actor);
    return present(row);
  });
}

async function assertCovered(accountId: string, caseId: string, outCents: number) {
  const balance = await balanceOf(accountId, caseId);
  if (outCents > balance) {
    throw httpError(
      `The matter holds R ${(balance / 100).toFixed(2)} in this trust account; a trust ledger may never go into debit.`,
      409,
    );
  }
}

/** A trust payment to a third party or the client: waits for authorisation. */
export function requestPayment(input: unknown, actor: Actor): Promise<TrustEntry> {
  requireTrust();
  return atomically(async () => {
    const entry = parse(entrySchema, input);
    const account = await requireAccount(entry.accountId);
    const matter = await requireCase(entry.caseRef);
    const amountCents = toCents(entry.amount);
    // Checked now for a clear answer, and again when it is authorised.
    await assertCovered(account.id, matter.id, amountCents);
    const row = await insertEntry(
      {
        accountId: account.id,
        caseId: matter.id,
        kind: 'payment',
        amountCents: -amountCents,
        entryDate: entry.entryDate ?? localDate(),
        reference: entry.reference,
        description: entry.description,
        status: 'pending',
      },
      actor,
    );
    await auditEntry('trust_payment_requested', 'Trust payment requested', row, actor);
    return present(row);
  });
}

/** Fees or disbursements to the business account, against an issued invoice. */
export function requestFeeTransfer(input: unknown, actor: Actor): Promise<TrustEntry> {
  requireTrust();
  return atomically(async () => {
    const entry = parse(feeTransferSchema, input);
    const account = await requireAccount(entry.accountId);
    const matter = await requireCase(entry.caseRef);
    const [invoice] = await db()
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, entry.invoiceId), eq(invoices.caseId, matter.id)));
    if (!invoice) throw httpError('That invoice is not on this matter', 400);
    if (!['issued', 'partially_paid'].includes(invoice.status)) {
      throw httpError('Trust money can only settle an issued invoice that is still owing', 409);
    }
    const amountCents = toCents(entry.amount);
    if (amountCents > invoice.totalCents - invoice.paidCents) {
      throw httpError('That is more than the invoice still owes', 400);
    }
    await assertCovered(account.id, matter.id, amountCents);
    const row = await insertEntry(
      {
        accountId: account.id,
        caseId: matter.id,
        kind: 'transfer_to_business',
        amountCents: -amountCents,
        entryDate: entry.entryDate ?? localDate(),
        reference: entry.reference || invoice.invoiceNumber || '',
        description: entry.description || `Fees: invoice ${invoice.invoiceNumber}`,
        status: 'pending',
        invoiceId: invoice.id,
      },
      actor,
    );
    await auditEntry('trust_fee_transfer_requested', 'Trust fee transfer requested', row, actor);
    return present(row);
  });
}

/** From one matter's ledger to another's (same account): two legs, one authorisation. */
export function requestMatterTransfer(input: unknown, actor: Actor): Promise<TrustEntry> {
  requireTrust();
  return atomically(async () => {
    const entry = parse(transferSchema, input);
    const account = await requireAccount(entry.accountId);
    const from = await requireCase(entry.caseRef);
    const to = await requireCase(entry.toCaseRef);
    if (from.id === to.id) throw httpError('Choose two different matters', 400);
    const amountCents = toCents(entry.amount);
    await assertCovered(account.id, from.id, amountCents);
    const groupId = randomUUID();
    const common = {
      accountId: account.id,
      entryDate: entry.entryDate ?? localDate(),
      reference: entry.reference,
      description: entry.description,
      status: 'pending' as const,
      groupId,
    };
    const out = await insertEntry(
      { ...common, caseId: from.id, kind: 'transfer_out', amountCents: -amountCents },
      actor,
    );
    await insertEntry({ ...common, caseId: to.id, kind: 'transfer_in', amountCents }, actor);
    await auditEntry(
      'trust_transfer_requested',
      `Trust transfer to ${to.caseNumber} requested`,
      out,
      actor,
    );
    return present(out);
  });
}

/** Opening balances (moving to the platform) and interest credited: authorised. */
export function requestCredit(
  kind: 'opening_balance' | 'interest',
  input: unknown,
  actor: Actor,
): Promise<TrustEntry> {
  requireTrust();
  return atomically(async () => {
    const entry = parse(openingSchema, input);
    const account = await requireAccount(entry.accountId);
    const matter = await requireCase(entry.caseRef);
    const row = await insertEntry(
      {
        accountId: account.id,
        caseId: matter.id,
        kind,
        amountCents: toCents(entry.amount),
        entryDate: entry.entryDate ?? localDate(),
        reference: entry.reference,
        description: entry.description,
        status: 'pending',
      },
      actor,
    );
    await auditEntry(
      `trust_${kind}_requested`,
      `Trust ${kind.replace('_', ' ')} requested`,
      row,
      actor,
    );
    return present(row);
  });
}

/** Corrects a posted entry with an equal and opposite one (authorised). */
export function requestReversal(
  entryId: string,
  input: unknown,
  actor: Actor,
): Promise<TrustEntry> {
  requireTrust();
  return atomically(async () => {
    const { reason } = parse(rejectSchema, input);
    const original = await requireEntry(entryId);
    if (original.status !== 'posted' || original.kind === 'reversal') {
      throw httpError('Only a posted entry can be reversed', 409);
    }
    if (original.groupId) {
      throw httpError('Reverse a matter transfer by transferring back', 409);
    }
    if (original.kind === 'transfer_to_business') {
      throw httpError(
        'A fee transfer is corrected by reversing the invoice payment and receiving the money back into trust',
        409,
      );
    }
    const [existing] = await db()
      .select({ id: trustEntries.id })
      .from(trustEntries)
      .where(and(eq(trustEntries.reversesId, original.id), ne(trustEntries.status, 'rejected')));
    if (existing) throw httpError('This entry already has a reversal', 409);
    const row = await insertEntry(
      {
        accountId: original.accountId,
        caseId: original.caseId,
        kind: 'reversal',
        amountCents: -original.amountCents,
        entryDate: localDate(),
        reference: (await decryptJson<string>(original.referenceEncrypted)) ?? '',
        description: `Reversal: ${reason}`,
        status: 'pending',
        reversesId: original.id,
      },
      actor,
    );
    await auditEntry('trust_reversal_requested', 'Trust reversal requested', row, actor);
    return present(row);
  });
}

async function requireEntry(id: string): Promise<TrustEntryRow> {
  if (!isUuid(id)) throw httpError('Trust entry not found', 404);
  const [row] = await db().select().from(trustEntries).where(eq(trustEntries.id, id));
  if (!row) throw httpError('Trust entry not found', 404);
  return row;
}

/**
 * A practitioner (not the requester) authorises a pending entry. The ledger
 * is checked again under a lock on the account, so it never goes into debit.
 */
export function authorise(entryId: string, actor: Actor): Promise<TrustEntry> {
  requireTrust();
  return atomically(async () => {
    const entry = await requireEntry(entryId);
    if (entry.status !== 'pending')
      throw httpError('This entry is not waiting for authorisation', 409);
    if (entry.requestedBy && entry.requestedBy === actor.userId) {
      throw httpError('Someone other than the requester must authorise trust entries', 403);
    }
    await requireAccount(entry.accountId, true);
    const legs = entry.groupId
      ? await db().select().from(trustEntries).where(eq(trustEntries.groupId, entry.groupId))
      : [entry];
    for (const leg of legs) {
      if (leg.amountCents < 0) {
        await assertCovered(leg.accountId, leg.caseId, -leg.amountCents);
      }
    }
    for (const leg of legs) {
      await db()
        .update(trustEntries)
        .set({ status: 'posted', authorisedBy: actor.userId ?? null, authorisedAt: new Date() })
        .where(and(eq(trustEntries.id, leg.id), eq(trustEntries.status, 'pending')));
    }
    if (entry.kind === 'transfer_to_business' && entry.invoiceId) {
      await billing.recordPayment(
        entry.invoiceId,
        {
          amount: -entry.amountCents / 100,
          receivedOn: entry.entryDate,
          method: 'trust_transfer',
          reference: `Trust transfer ${entry.id.slice(0, 8)}`,
        },
        actor,
      );
    }
    const [posted] = await db().select().from(trustEntries).where(eq(trustEntries.id, entry.id));
    await auditEntry(
      'trust_entry_authorised',
      `Trust ${entry.kind.replace(/_/g, ' ')} authorised`,
      posted!,
      actor,
    );
    return present(posted!);
  });
}

export function reject(entryId: string, input: unknown, actor: Actor): Promise<TrustEntry> {
  requireTrust();
  return atomically(async () => {
    const { reason } = parse(rejectSchema, input);
    const entry = await requireEntry(entryId);
    if (entry.status !== 'pending')
      throw httpError('This entry is not waiting for authorisation', 409);
    await db()
      .update(trustEntries)
      .set({
        status: 'rejected',
        rejectedReason: reason,
        authorisedBy: actor.userId ?? null,
        authorisedAt: new Date(),
      })
      .where(
        entry.groupId
          ? and(eq(trustEntries.groupId, entry.groupId), eq(trustEntries.status, 'pending'))
          : eq(trustEntries.id, entry.id),
      );
    const [rejected] = await db().select().from(trustEntries).where(eq(trustEntries.id, entry.id));
    await auditEntry(
      'trust_entry_rejected',
      `Trust ${entry.kind.replace(/_/g, ' ')} rejected`,
      rejected!,
      actor,
    );
    return present(rejected!);
  });
}

export async function pending(): Promise<TrustEntry[]> {
  requireTrust();
  const rows = await db()
    .select()
    .from(trustEntries)
    .where(and(eq(trustEntries.status, 'pending'), sql`${trustEntries.kind} <> 'transfer_in'`))
    .orderBy(asc(trustEntries.createdAt));
  return Promise.all(rows.map(present));
}

// ---------------------------------------------------------------- ledgers

export async function ledger(accountId: string, caseRef: string): Promise<TrustLedger> {
  requireTrust();
  const account = await requireAccount(accountId);
  const matter = await requireCase(caseRef);
  const rows = await db()
    .select()
    .from(trustEntries)
    .where(and(eq(trustEntries.accountId, account.id), eq(trustEntries.caseId, matter.id)))
    .orderBy(asc(trustEntries.entryDate), asc(trustEntries.createdAt));
  return {
    caseNumber: matter.caseNumber,
    accountId: account.id,
    balanceCents: await balanceOf(account.id, matter.id),
    entries: await Promise.all(rows.map(present)),
  };
}

/** Every matter's balance in an account (the client ledger listing). */
export async function balances(accountId: string, asAt?: string): Promise<TrustLedgerLine[]> {
  requireTrust();
  const account = await requireAccount(accountId);
  const rows = await db()
    .select({
      caseId: trustEntries.caseId,
      caseNumber: cases.caseNumber,
      balance: sql<string>`sum(${trustEntries.amountCents})`,
    })
    .from(trustEntries)
    .innerJoin(cases, eq(cases.id, trustEntries.caseId))
    .where(
      and(
        eq(trustEntries.accountId, account.id),
        eq(trustEntries.status, 'posted'),
        asAt ? lte(trustEntries.entryDate, asAt) : undefined,
      ),
    )
    .groupBy(trustEntries.caseId, cases.caseNumber)
    .orderBy(asc(cases.caseNumber));
  return rows
    .map((row) => ({
      caseId: row.caseId,
      caseNumber: row.caseNumber,
      balanceCents: Number(row.balance),
    }))
    .filter((row) => row.balanceCents !== 0);
}

/** Entries that appeared on the bank statement. */
export async function markCleared(input: unknown, actor: Actor): Promise<number> {
  requireTrust();
  const { entryIds, clearedOn } = parse(clearSchema, input);
  let count = 0;
  for (const id of entryIds) {
    const rows = await db()
      .update(trustEntries)
      .set({ clearedOn })
      .where(
        and(
          eq(trustEntries.id, id),
          eq(trustEntries.status, 'posted'),
          isNull(trustEntries.clearedOn),
        ),
      )
      .returning({ id: trustEntries.id });
    count += rows.length;
  }
  await auditService.logEventSafely(
    {
      entityType: 'trust_account',
      entityId: null,
      action: 'trust_entries_cleared',
      summary: `${count} trust entries matched to the bank statement`,
      details: { clearedOn, count },
    },
    actor,
  );
  return count;
}

// --------------------------------------------------------- reconciliation

async function presentReconciliation(row: TrustReconciliationRow): Promise<TrustReconciliation> {
  const difference =
    row.bankBalanceCents +
    row.unclearedReceiptsCents -
    row.unclearedPaymentsCents -
    row.cashbookCents;
  const ledgerDifference = row.cashbookCents - row.ledgerTotalCents;
  return {
    id: row.id,
    accountId: row.accountId,
    periodEnd: row.periodEnd,
    bankBalanceCents: row.bankBalanceCents,
    cashbookCents: row.cashbookCents,
    ledgerTotalCents: row.ledgerTotalCents,
    unclearedReceiptsCents: row.unclearedReceiptsCents,
    unclearedPaymentsCents: row.unclearedPaymentsCents,
    differenceCents: difference,
    ledgerDifferenceCents: ledgerDifference,
    debitLedgers: row.debitLedgers,
    balanced: difference === 0 && ledgerDifference === 0 && row.debitLedgers === 0,
    notes: row.notesEncrypted ? ((await decryptJson<string>(row.notesEncrypted)) ?? '') : '',
    preparedBy: row.preparedBy,
    preparedAt: iso(row.createdAt),
    signedOffBy: row.signedOffBy,
    signedOffAt: isoOrNull(row.signedOffAt),
  };
}

/**
 * Prepares a reconciliation for a period end from the bank statement's
 * closing balance. Totals cover every matter (restricted ones included):
 * this is statutory compliance work.
 */
export function reconcile(
  accountId: string,
  input: unknown,
  actor: Actor,
): Promise<TrustReconciliation> {
  requireTrust();
  return atomically(() =>
    withSystemScope(async () => {
      const { periodEnd, bankBalance, notes } = parse(reconcileSchema, input);
      const account = await requireAccount(accountId);
      const posted = and(
        eq(trustEntries.accountId, account.id),
        eq(trustEntries.status, 'posted'),
        lte(trustEntries.entryDate, periodEnd),
      );
      const [cash] = await db()
        .select({ total: sql<string>`coalesce(sum(${trustEntries.amountCents}), 0)` })
        .from(trustEntries)
        .where(posted);
      // Independently: the sum of each client ledger's balance.
      const perMatter = await db()
        .select({ balance: sql<string>`sum(${trustEntries.amountCents})` })
        .from(trustEntries)
        .where(posted)
        .groupBy(trustEntries.caseId);
      const uncleared = await db()
        .select({
          receipts: sql<string>`coalesce(sum(${trustEntries.amountCents}) filter (where ${trustEntries.amountCents} > 0), 0)`,
          payments: sql<string>`coalesce(-sum(${trustEntries.amountCents}) filter (where ${trustEntries.amountCents} < 0), 0)`,
        })
        .from(trustEntries)
        .where(
          and(
            posted,
            // Matter-to-matter legs never touch the bank.
            sql`${trustEntries.groupId} is null`,
            or(isNull(trustEntries.clearedOn), sql`${trustEntries.clearedOn} > ${periodEnd}`),
          ),
        );
      const [row] = await db()
        .insert(trustReconciliations)
        .values({
          accountId: account.id,
          periodEnd,
          bankBalanceCents: toCents(bankBalance),
          cashbookCents: Number(cash?.total ?? 0),
          ledgerTotalCents: perMatter.reduce((sum, m) => sum + Number(m.balance), 0),
          unclearedReceiptsCents: Number(uncleared[0]?.receipts ?? 0),
          unclearedPaymentsCents: Number(uncleared[0]?.payments ?? 0),
          debitLedgers: perMatter.filter((m) => Number(m.balance) < 0).length,
          notesEncrypted: notes ? await encryptJson(notes) : null,
          preparedBy: actor.userId ?? null,
        })
        .returning();
      const result = await presentReconciliation(row!);
      await auditService.logEvent(
        {
          entityType: 'trust_reconciliation',
          entityId: row!.id,
          action: 'trust_reconciliation_prepared',
          summary: `Trust reconciliation to ${periodEnd}: ${result.balanced ? 'balanced' : 'difference found'}`,
          details: {
            accountId: account.id,
            differenceCents: result.differenceCents,
            ledgerDifferenceCents: result.ledgerDifferenceCents,
            debitLedgers: result.debitLedgers,
          },
        },
        actor,
      );
      return result;
    }),
  );
}

export async function reconciliations(accountId: string): Promise<TrustReconciliation[]> {
  requireTrust();
  const account = await requireAccount(accountId);
  const rows = await db()
    .select()
    .from(trustReconciliations)
    .where(eq(trustReconciliations.accountId, account.id))
    .orderBy(desc(trustReconciliations.periodEnd), desc(trustReconciliations.createdAt));
  return Promise.all(rows.map(presentReconciliation));
}

/** A practitioner signs off; an unbalanced one needs an explanation. */
export function signOff(id: string, input: unknown, actor: Actor): Promise<TrustReconciliation> {
  requireTrust();
  return atomically(async () => {
    const { notes } = parse(signOffSchema, input ?? {});
    const [row] = isUuid(id)
      ? await db().select().from(trustReconciliations).where(eq(trustReconciliations.id, id))
      : [];
    if (!row) throw httpError('Reconciliation not found', 404);
    if (row.signedOffAt) throw httpError('Already signed off', 409);
    if (row.preparedBy && row.preparedBy === actor.userId) {
      throw httpError('Someone other than the preparer must sign off the reconciliation', 403);
    }
    const current = await presentReconciliation(row);
    const explanation = notes || current.notes;
    if (!current.balanced && !explanation) {
      throw httpError(
        'This reconciliation does not balance: explain the difference before signing off',
        400,
      );
    }
    const [saved] = await db()
      .update(trustReconciliations)
      .set({
        signedOffBy: actor.userId ?? null,
        signedOffAt: new Date(),
        notesEncrypted: explanation ? await encryptJson(explanation) : null,
      })
      .where(eq(trustReconciliations.id, row.id))
      .returning();
    await auditService.logEvent(
      {
        entityType: 'trust_reconciliation',
        entityId: row.id,
        action: 'trust_reconciliation_signed_off',
        summary: `Trust reconciliation to ${row.periodEnd} signed off${current.balanced ? '' : ' with a difference explained'}`,
        details: { accountId: row.accountId, balanced: current.balanced },
      },
      actor,
    );
    return presentReconciliation(saved!);
  });
}

/** Cash book as CSV for the auditor (every matter). */
export async function cashbookCsv(accountId: string, from: string, to: string): Promise<string> {
  requireTrust();
  if (![from, to].every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))) {
    throw httpError('from and to must be dates (YYYY-MM-DD)', 400);
  }
  // Matters the caller may see; others appear with amounts only.
  const visible = new Set((await db().select({ id: cases.id }).from(cases)).map((row) => row.id));
  return withSystemScope(async () => {
    const account = await requireAccount(accountId);
    const rows = await db()
      .select({ entry: trustEntries, caseNumber: cases.caseNumber })
      .from(trustEntries)
      .innerJoin(cases, eq(cases.id, trustEntries.caseId))
      .where(
        and(
          eq(trustEntries.accountId, account.id),
          eq(trustEntries.status, 'posted'),
          sql`${trustEntries.entryDate} between ${from} and ${to}`,
        ),
      )
      .orderBy(asc(trustEntries.entryDate), asc(trustEntries.createdAt));
    const cell = (value: string | number | null) => {
      const text = String(value ?? '');
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [
      [
        'date',
        'matter',
        'kind',
        'amount',
        'reference',
        'description',
        'cleared_on',
        'entry_id',
      ].join(','),
    ];
    for (const { entry, caseNumber } of rows) {
      const shown = visible.has(entry.caseId);
      lines.push(
        [
          entry.entryDate,
          shown ? caseNumber : 'Restricted matter',
          entry.kind,
          (entry.amountCents / 100).toFixed(2),
          shown ? ((await decryptJson<string>(entry.referenceEncrypted)) ?? '') : '',
          shown ? ((await decryptJson<string>(entry.descriptionEncrypted)) ?? '') : '',
          entry.clearedOn ?? '',
          entry.id,
        ]
          .map(cell)
          .join(','),
      );
    }
    return `${lines.join('\n')}\n`;
  });
}

export const ENTRY_KINDS = TRUST_ENTRY_KINDS;
export { OUTGOING };
