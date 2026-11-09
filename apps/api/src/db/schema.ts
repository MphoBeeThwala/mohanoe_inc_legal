// Database schema — the single source of truth for every table.
//
// Change it here, then run `npm run db:generate -w apps/api` to create a new
// migration in apps/api/drizzle/. Never edit an applied migration and never
// change production with hand-written SQL.
//
// Conventions: TypeScript fields are camelCase, columns are snake_case (kept
// from the original schema so existing data can be migrated). Money is stored
// as integer cents. Timestamps are timestamptz.
//
// Multi-tenancy: every table except `firms` carries firm_id and a forced
// row-level security policy. firm_id defaults to the request's firm
// (`app.firm_id`, set per request by db/tenant.ts), so a row can only ever be
// written to, and read from, the firm of the request that touches it.

import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  jsonb,
  numeric,
  pgPolicy,
  primaryKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
};

const updatable = {
  ...timestamps,
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

// ---------------------------------------------------------------- tenancy

export interface FirmBranding {
  logoUrl?: string | null;
  primaryColor?: string;
  accentColor?: string;
}

/** A law firm licensed to use the platform (a tenant). Platform-level table. */
export const firms = pgTable('firms', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** URL-safe identifier; also the subdomain under PLATFORM_BASE_DOMAIN. */
  slug: text('slug').notNull().unique(),
  legalName: text('legal_name').notNull(),
  tradingName: text('trading_name').notNull(),
  productName: text('product_name'),
  branding: jsonb('branding').$type<FirmBranding>().notNull().default({}),
  casePrefix: text('case_prefix').notNull().default('MAT'),
  /** Custom domains (lower-case host names) that resolve to this firm. */
  domains: text('domains')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  vatNumber: text('vat_number'),
  plan: text('plan').notNull().default('pilot'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The firm of the current request, from the transaction-local setting. */
const CURRENT_FIRM = sql`nullif(current_setting('app.firm_id', true), '')::uuid`;

/** firm_id column: defaults to the request's firm; cascades if the firm is deleted. */
const firmId = () =>
  uuid('firm_id')
    .notNull()
    .default(CURRENT_FIRM)
    .references(() => firms.id, { onDelete: 'cascade' });

/** Row-level security: a row is visible and writable only within its firm. */
const tenantPolicy = (table: string) =>
  pgPolicy(`${table}_tenant_isolation`, {
    as: 'permissive',
    for: 'all',
    using: sql`firm_id = nullif(current_setting('app.firm_id', true), '')::uuid`,
    withCheck: sql`firm_id = nullif(current_setting('app.firm_id', true), '')::uuid`,
  });

// ---------------------------------------------------------------- identity

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    role: text('role').notNull().default('attorney'),
    passwordHash: text('password_hash').notNull(),
    passwordSalt: text('password_salt').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_firm_email_idx').on(t.firmId, t.email), tenantPolicy('users')],
);

// ---------------------------------------------------------------- sequences

/**
 * Named counters for human-readable numbers (case numbers, client labels).
 * Incremented atomically with UPDATE … RETURNING, so concurrent requests can
 * never receive the same number.
 */
export const counters = pgTable(
  'counters',
  {
    firmId: firmId(),
    name: text('name').notNull(),
    value: bigint('value', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.firmId, t.name] }), tenantPolicy('counters')],
);

// ---------------------------------------------------------------- intake

export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    clientLabel: text('client_label').notNull(),
    practiceArea: text('practice_area').notNull(),
    jurisdiction: text('jurisdiction').notNull().default('South Africa'),
    urgencyHint: text('urgency_hint').notNull().default('unspecified'),
    status: text('status').notNull().default('received'),
    summaryRedacted: text('summary_redacted').notNull(),
    rawPayloadEncrypted: text('raw_payload_encrypted').notNull(),
    /** Keyed hash of the client's email (blind index) for POPIA lookups. */
    emailLookup: text('email_lookup').notNull(),
    consentToAi: boolean('consent_to_ai').notNull().default(false),
    consentToStorage: boolean('consent_to_storage').notNull().default(false),
    ...updatable,
  },
  (t) => [
    index('submissions_created_at_idx').on(t.createdAt),
    index('submissions_email_lookup_idx').on(t.emailLookup),
    tenantPolicy('submissions'),
  ],
);

export const assessments = pgTable(
  'assessments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    intakeSubmissionId: uuid('intake_submission_id')
      .notNull()
      .unique()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    modelName: text('model_name').notNull(),
    matterType: text('matter_type').notNull(),
    urgency: text('urgency').notNull(),
    summary: text('summary').notNull(),
    keyFacts: jsonb('key_facts').$type<string[]>().notNull().default([]),
    attorneyQuestions: jsonb('attorney_questions').$type<string[]>().notNull().default([]),
    recommendedDocuments: jsonb('recommended_documents').$type<string[]>().notNull().default([]),
    complianceFlags: jsonb('compliance_flags').$type<string[]>().notNull().default([]),
    nextActions: jsonb('next_actions').$type<string[]>().notNull().default([]),
    confidence: numeric('confidence', { precision: 4, scale: 2, mode: 'number' })
      .notNull()
      .default(0),
    popiaNotes: jsonb('popia_notes').$type<string[]>().notNull().default([]),
    rawRedactedBrief: jsonb('raw_redacted_brief')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ...timestamps,
  },
  () => [tenantPolicy('assessments')],
);

// ---------------------------------------------------------------- matters

export const cases = pgTable(
  'cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    intakeSubmissionId: uuid('intake_submission_id')
      .notNull()
      .unique()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    caseNumber: text('case_number').notNull(),
    clientLabel: text('client_label').notNull(),
    practiceArea: text('practice_area').notNull(),
    urgency: text('urgency').notNull(),
    status: text('status').notNull().default('triage'),
    nextAction: text('next_action').notNull(),
    ...updatable,
  },
  (t) => [
    index('cases_created_at_idx').on(t.createdAt),
    uniqueIndex('cases_firm_case_number_idx').on(t.firmId, t.caseNumber),
    tenantPolicy('cases'),
  ],
);

export const caseTasks = pgTable(
  'case_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status').notNull().default('open'),
    dueDate: date('due_date', { mode: 'string' }),
    assigneeName: text('assignee_name'),
    createdBy: text('created_by').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('case_tasks_case_id_idx').on(t.caseId), tenantPolicy('case_tasks')],
);

export const caseTimeline = pgTable(
  'case_timeline',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull().default('note'),
    message: text('message').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    actorName: text('actor_name').notNull(),
    ...timestamps,
  },
  (t) => [index('case_timeline_case_id_idx').on(t.caseId), tenantPolicy('case_timeline')],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    caseNumber: text('case_number').notNull(),
    clientLabel: text('client_label').notNull(),
    title: text('title').notNull(),
    documentType: text('document_type').notNull().default('correspondence'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    status: text('status').notNull().default('draft'),
    encryptedContent: text('encrypted_content').notNull(),
    contentPreview: text('content_preview').notNull().default(''),
    createdBy: text('created_by').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    ...updatable,
  },
  (t) => [index('documents_case_id_idx').on(t.caseId), tenantPolicy('documents')],
);

// ---------------------------------------------------------------- billing

export interface StoredLineItem {
  description: string;
  quantity: number;
  /** Unit price in cents. */
  rateCents: number;
}

export const invoices = pgTable(
  'billing_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    caseNumber: text('case_number').notNull(),
    clientLabel: text('client_label').notNull(),
    invoiceNumber: text('invoice_number').notNull(),
    subject: text('subject').notNull(),
    currency: text('currency').notNull().default('ZAR'),
    status: text('status').notNull().default('issued'),
    lineItems: jsonb('line_items').$type<StoredLineItem[]>().notNull().default([]),
    subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull().default(0),
    vatCents: bigint('vat_cents', { mode: 'number' }).notNull().default(0),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp('due_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    ...updatable,
  },
  (t) => [
    index('billing_invoices_case_id_idx').on(t.caseId),
    uniqueIndex('billing_invoices_firm_number_idx').on(t.firmId, t.invoiceNumber),
    tenantPolicy('billing_invoices'),
  ],
);

export const ledgerEntries = pgTable(
  'billing_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    caseNumber: text('case_number').notNull(),
    entryType: text('entry_type').notNull(),
    account: text('account').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    reference: text('reference').notNull().default(''),
    notes: text('notes').notNull().default(''),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (t) => [index('billing_ledger_case_id_idx').on(t.caseId), tenantPolicy('billing_ledger')],
);

// ---------------------------------------------------------------- calendar & notifications

export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    caseNumber: text('case_number').notNull(),
    title: text('title').notNull(),
    eventType: text('event_type').notNull().default('deadline'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    location: text('location').notNull().default(''),
    notes: text('notes').notNull().default(''),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (t) => [index('calendar_events_starts_at_idx').on(t.startsAt), tenantPolicy('calendar_events')],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    category: text('category').notNull().default('general'),
    priority: text('priority').notNull().default('medium'),
    recipientRole: text('recipient_role').notNull().default('attorney'),
    recipientUserId: uuid('recipient_user_id'),
    relatedEntityType: text('related_entity_type'),
    relatedEntityId: text('related_entity_id'),
    isRead: boolean('is_read').notNull().default(false),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (t) => [
    index('notifications_recipient_idx').on(t.recipientRole, t.isRead),
    tenantPolicy('notifications'),
  ],
);

// ---------------------------------------------------------------- audit, reports, compliance

/**
 * Tamper-evident audit trail. Each row's entry_hash is an HMAC over its
 * contents and the previous row's hash; `seq` gives the chain a strict order.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    id: uuid('id').notNull().unique().defaultRandom(),
    firmId: firmId(),
    actorId: uuid('actor_id'),
    actorName: text('actor_name').notNull(),
    actorRole: text('actor_role').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    action: text('action').notNull(),
    summary: text('summary').notNull().default(''),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    previousHash: text('previous_hash').notNull(),
    entryHash: text('entry_hash').notNull(),
    ...timestamps,
  },
  (t) => [
    index('audit_events_entity_idx').on(t.entityType, t.entityId),
    tenantPolicy('audit_events'),
  ],
);

export const reportSnapshots = pgTable(
  'report_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    reportType: text('report_type').notNull().default('dashboard'),
    title: text('title').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  () => [tenantPolicy('report_snapshots')],
);

export const complianceRequests = pgTable(
  'compliance_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    requestType: text('request_type').notNull().default('access'),
    subjectName: text('subject_name').notNull(),
    subjectEmail: text('subject_email').notNull(),
    caseRef: text('case_ref'),
    description: text('description').notNull(),
    status: text('status').notNull().default('open'),
    responseSummary: text('response_summary').notNull().default(''),
    responsePayload: jsonb('response_payload').$type<unknown>().notNull().default({}),
    dueAt: timestamp('due_at', { withTimezone: true }),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    ...updatable,
  },
  (t) => [index('compliance_status_idx').on(t.status), tenantPolicy('compliance_requests')],
);

// Row types for services.
export type FirmRow = typeof firms.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type SubmissionRow = typeof submissions.$inferSelect;
export type AssessmentRow = typeof assessments.$inferSelect;
export type CaseRow = typeof cases.$inferSelect;
export type CaseTaskRow = typeof caseTasks.$inferSelect;
export type CaseTimelineRow = typeof caseTimeline.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type InvoiceRow = typeof invoices.$inferSelect;
export type LedgerRow = typeof ledgerEntries.$inferSelect;
export type CalendarEventRow = typeof calendarEvents.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type ReportSnapshotRow = typeof reportSnapshots.$inferSelect;
export type ComplianceRequestRow = typeof complianceRequests.$inferSelect;
