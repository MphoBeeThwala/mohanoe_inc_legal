const { randomUUID } = require('crypto');
const { getSupabaseClient } = require('../config/supabase');
const intakeService = require('./intake.service');
const auditService = require('./audit.service');

const memory = {
  invoices: [],
  ledger: [],
};

function toIso(value = new Date()) {
  return new Date(value).toISOString();
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function resolveCase(caseRef) {
  if (!caseRef) {
    return null;
  }

  const cases = await intakeService.listCases();
  return (
    cases.find(
      (item) =>
        item.id === caseRef ||
        item.caseNumber === caseRef ||
        item.submissionId === caseRef,
    ) || null
  );
}

async function listRows(table, memoryKey) {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db.from(table).select('*').order('created_at', {
      ascending: false,
    });
    if (error) {
      throw error;
    }

    return data || [];
  }

  return [...memory[memoryKey]].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
}

async function saveRow(table, memoryKey, record) {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db.from(table).insert(record).select().single();
    if (error) {
      throw error;
    }

    return data;
  }

  memory[memoryKey].unshift(record);
  return record;
}

function sumLineItems(items = []) {
  return items.reduce(
    (total, item) =>
      total + toNumber(item.quantity || 1) * toNumber(item.rate || item.amount || 0),
    0,
  );
}

function formatInvoice(row, caseRecord) {
  return {
    id: row.id,
    caseId: row.case_id,
    caseNumber: caseRecord?.caseNumber || row.case_number || null,
    clientLabel: row.client_label,
    number: row.invoice_number,
    subject: row.subject,
    currency: row.currency,
    status: row.status,
    lineItems: row.line_items || [],
    subtotal: row.subtotal,
    vat: row.vat,
    total: row.total,
    issuedAt: row.issued_at,
    dueAt: row.due_at,
    paidAt: row.paid_at,
    createdAt: row.created_at,
  };
}

function formatLedgerEntry(row, caseRecord) {
  return {
    id: row.id,
    caseId: row.case_id,
    caseNumber: caseRecord?.caseNumber || row.case_number || null,
    entryType: row.entry_type,
    account: row.account,
    amount: row.amount,
    reference: row.reference,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

async function listInvoices() {
  const rows = await listRows('billing_invoices', 'invoices');
  const cases = await intakeService.listCases();
  return rows.map((row) =>
    formatInvoice(
      row,
      cases.find((item) => item.id === row.case_id || item.caseNumber === row.case_number),
    ),
  );
}

async function listLedgerEntries() {
  const rows = await listRows('billing_ledger', 'ledger');
  const cases = await intakeService.listCases();
  return rows.map((row) =>
    formatLedgerEntry(
      row,
      cases.find((item) => item.id === row.case_id || item.caseNumber === row.case_number),
    ),
  );
}

async function createInvoice(input = {}, actor = {}) {
  const caseRef = String(input.caseId || input.caseRef || '').trim();
  const caseRecord = await resolveCase(caseRef);
  const subject = String(input.subject || '').trim();
  const lineItems = Array.isArray(input.lineItems) ? input.lineItems : [];
  const currency = String(input.currency || 'ZAR').trim();

  if (!caseRecord || !subject || !lineItems.length) {
    const error = new Error('caseId, subject, and lineItems are required');
    error.statusCode = 400;
    throw error;
  }

  const subtotal = sumLineItems(lineItems);
  const vat = input.vatIncluded === false ? 0 : subtotal * 0.15;
  const total = subtotal + vat;
  const now = toIso();
  const record = {
    id: randomUUID(),
    case_id: caseRecord.id,
    case_number: caseRecord.caseNumber,
    client_label: caseRecord.clientLabel,
    invoice_number: String(input.invoiceNumber || `INV-${Date.now()}`),
    subject,
    currency,
    status: String(input.status || 'issued').trim(),
    line_items: lineItems,
    subtotal,
    vat,
    total,
    issued_at: input.issuedAt || now,
    due_at: input.dueAt || null,
    paid_at: input.paidAt || null,
    created_by: actor?.fullName || actor?.email || 'system',
    created_at: now,
    updated_at: now,
  };

  const saved = await saveRow('billing_invoices', 'invoices', record);
  await auditService.logEvent(
    {
      entityType: 'invoice',
      entityId: saved.id,
      action: 'invoice_created',
      summary: `Invoice created: ${subject}`,
      details: {
        caseId: caseRecord.id,
        total,
        currency,
      },
    },
    actor,
  );

  return formatInvoice(saved, caseRecord);
}

async function recordLedgerEntry(input = {}, actor = {}) {
  const caseRef = String(input.caseId || input.caseRef || '').trim();
  const caseRecord = await resolveCase(caseRef);
  const entryType = String(input.entryType || 'payment').trim();
  const account = String(input.account || 'trust').trim();
  const amount = toNumber(input.amount);

  if (!caseRecord || !entryType || !account || !amount) {
    const error = new Error('caseId, entryType, account, and amount are required');
    error.statusCode = 400;
    throw error;
  }

  const now = toIso();
  const record = {
    id: randomUUID(),
    case_id: caseRecord.id,
    case_number: caseRecord.caseNumber,
    entry_type: entryType,
    account,
    amount,
    reference: String(input.reference || '').trim(),
    notes: String(input.notes || '').trim(),
    created_by: actor?.fullName || actor?.email || 'system',
    created_at: now,
  };

  const saved = await saveRow('billing_ledger', 'ledger', record);
  await auditService.logEvent(
    {
      entityType: 'ledger',
      entityId: saved.id,
      action: 'ledger_entry_created',
      summary: `Ledger entry recorded: ${entryType}`,
      details: {
        caseId: caseRecord.id,
        amount,
        account,
      },
    },
    actor,
  );

  return formatLedgerEntry(saved, caseRecord);
}

async function getBillingSummary() {
  const invoices = await listInvoices();
  const ledger = await listLedgerEntries();

  const outstanding = invoices
    .filter((invoice) => invoice.status !== 'paid')
    .reduce((total, invoice) => total + toNumber(invoice.total), 0);

  const trustBalance = ledger.reduce((total, entry) => {
    if (entry.account === 'trust') {
      return total + toNumber(entry.amount);
    }

    return total;
  }, 0);

  const operatingBalance = ledger.reduce((total, entry) => {
    if (entry.account === 'operating') {
      return total + toNumber(entry.amount);
    }

    return total;
  }, 0);

  return {
    invoices: invoices.length,
    outstanding,
    trustBalance,
    operatingBalance,
    recentInvoices: invoices.slice(0, 5),
    recentLedger: ledger.slice(0, 8),
  };
}

module.exports = {
  createInvoice,
  getBillingSummary,
  listInvoices,
  listLedgerEntries,
  recordLedgerEntry,
};
