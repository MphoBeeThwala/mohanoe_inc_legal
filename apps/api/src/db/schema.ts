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
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  index,
  integer,
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

/** Binary content (node-postgres gives a Buffer, PGlite a Uint8Array). */
/** Full-text search vector (generated from a text column). */
const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

const bytea = customType<{ data: Buffer; driverData: Uint8Array | Buffer }>({
  dataType: () => 'bytea',
  fromDriver: (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value)),
});

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
};

const updatable = {
  ...timestamps,
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

// ---------------------------------------------------------------- tenancy

export interface FirmBranding {
  /** An external logo link (older firms); an uploaded logo takes precedence. */
  logoUrl?: string | null;
  primaryColor?: string;
  accentColor?: string;
  /** Version (content hash prefix) of the uploaded logo and icon in firm_assets. */
  logoHash?: string | null;
  iconHash?: string | null;
}

/** What a firm prints on its invoices and statements. */
export interface FirmBillingSettings {
  /** VAT vendor: charge VAT and issue tax invoices (default true). */
  vatRegistered?: boolean;
  /** Days from issue to due date (default 30). */
  paymentTermsDays?: number;
  /** Physical / postal address (required on a tax invoice). */
  address?: string;
  /** Business account for payments (never a trust account number in emails). */
  bankDetails?: string;
  /** Short note at the foot of every invoice. */
  invoiceFooter?: string;
  /** Letters before invoice numbers (default INV): INV-000001. */
  invoicePrefix?: string;
}

/** The firm's practice details (all public business information). */
export interface FirmProfile {
  /** CIPC registration number, e.g. 2015/123456/21. */
  registrationNumber?: string;
  /** Legal Practice Council firm or practitioner number. */
  lpcNumber?: string;
  /** Fidelity Fund certificate number and year. */
  fidelityFundCertificate?: string;
  email?: string;
  phone?: string;
  website?: string;
  /** Replies to emails the platform sends for the firm go here. */
  replyToEmail?: string;
}

/** Progress through the onboarding wizard. */
export interface FirmNotificationSettings {
  /** Staff told about every court roll match, change and reminder (e.g. the office manager). */
  courtRollWatcherIds?: string[];
}

export interface FirmFeatures {
  /** Trust accounting (pilots first, after auditor review). */
  trustAccounting?: boolean;
}

export interface FirmOnboarding {
  done?: string[];
  completedAt?: string;
}

/** A law firm licensed to use the platform (a tenant). Platform-level table. */
export const firms = pgTable(
  'firms',
  {
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
    /** Days a closed matter is kept; null = CLIENT_DATA_RETENTION_DAYS. */
    retentionDays: integer('retention_days'),
    /** Microsoft 365 (Entra ID) directory (tenant) id for staff sign-in. */
    ssoTenantId: text('sso_tenant_id'),
    /** Work email domains that belong to that directory. */
    ssoDomains: text('sso_domains')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Staff (except admins, as break-glass) must use Microsoft sign-in. */
    ssoEnforced: boolean('sso_enforced').notNull().default(false),
    /** New matters only for FICA-verified clients (FIC Act customer due diligence). */
    ficaEnforced: boolean('fica_enforced').notNull().default(false),
    billingSettings: jsonb('billing_settings').$type<FirmBillingSettings>().notNull().default({}),
    profile: jsonb('profile').$type<FirmProfile>().notNull().default({}),
    onboarding: jsonb('onboarding').$type<FirmOnboarding>().notNull().default({}),
    /** Who else is told about court rolls (firm administrators set it). */
    notificationSettings: jsonb('notification_settings')
      .$type<FirmNotificationSettings>()
      .notNull()
      .default({}),
    /** Platform-controlled feature flags (requests cannot change them). */
    features: jsonb('features').$type<FirmFeatures>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    // Requests (app_tenant) can read firms, and update only their own firm's
    // row; the migration grants UPDATE on just the settings columns. Platform
    // code (rootDb, the table owner) is not affected: RLS is not forced here.
    pgPolicy('firms_tenant_read', {
      as: 'permissive',
      for: 'select',
      to: 'app_tenant',
      using: sql`true`,
    }),
    pgPolicy('firms_tenant_update_own', {
      as: 'permissive',
      for: 'update',
      to: 'app_tenant',
      using: sql`id = nullif(current_setting('app.firm_id', true), '')::uuid`,
      withCheck: sql`id = nullif(current_setting('app.firm_id', true), '')::uuid`,
    }),
  ],
);

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

/**
 * Matter-level access for a table whose rows belong to a case: a row is
 * visible only when its case is (the subquery is itself filtered by the
 * cases_matter_access policy). Applies to app_tenant, i.e. every request.
 */
const matterPolicy = (table: string) =>
  pgPolicy(`${table}_matter_access`, {
    as: 'restrictive',
    for: 'all',
    to: 'app_tenant',
    using: sql.raw(`exists (select 1 from cases c where c.id = ${table}.case_id)`),
    withCheck: sql.raw(`exists (select 1 from cases c where c.id = ${table}.case_id)`),
  });

/** A firm's logo and icon, served before sign-in (not personal information). */
export const firmAssets = pgTable(
  'firm_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    /** 'logo' | 'icon' */
    kind: text('kind').notNull(),
    contentType: text('content_type').notNull(),
    content: bytea('content').notNull(),
    /** sha-256 (hex) of the content: a cache-busting version. */
    contentHash: text('content_hash').notNull(),
    ...updatable,
  },
  (t) => [uniqueIndex('firm_assets_kind_idx').on(t.firmId, t.kind), tenantPolicy('firm_assets')],
);

/**
 * A custom domain a firm is adding. It becomes active (added to firms.domains
 * and used in email links) only when its DNS TXT record proves ownership and
 * an HTTPS request to it reaches the platform.
 */
export const firmDomains = pgTable(
  'firm_domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    domain: text('domain').notNull(),
    /** Value of the TXT record the firm publishes. */
    token: text('token').notNull(),
    /** 'pending_dns' | 'pending_routing' | 'active' */
    status: text('status').notNull().default('pending_dns'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastError: text('last_error'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    ...updatable,
  },
  (t) => [
    uniqueIndex('firm_domains_domain_idx').on(t.firmId, t.domain),
    index('firm_domains_token_idx').on(t.token),
    tenantPolicy('firm_domains'),
  ],
);

// ------------------------------------------------------------ subscriptions
//
// The firm's own subscription to the platform, paid through PayFast. These
// rows describe the firm as a customer of Ahava on 88; no client personal
// information belongs here (PayFast's payer names and emails are not kept).

/** One row per firm. */
export const firmSubscriptions = pgTable(
  'firm_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    /** SubscriptionState as last recorded (see subscription.service effectiveStatus). */
    state: text('state').notNull().default('trialing'),
    planCode: text('plan_code'),
    /** 'monthly' | 'annual' */
    interval: text('interval'),
    /** Seats paid for; null = not limited (trial uses SUBSCRIPTION_TRIAL_SEATS). */
    seats: integer('seats'),
    /** Each period's charge in cents, VAT included (what PayFast collects). */
    recurringAmountCents: integer('recurring_amount_cents'),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    /** End of the paid (or complimentary) period. */
    paidThrough: timestamp('paid_through', { withTimezone: true }),
    /** PayFast subscription token (identifies the recurring agreement). */
    payfastToken: text('payfast_token'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** Notices already emailed, by kind, keyed to the paid-through date they were for. */
    notices: jsonb('notices').$type<Record<string, string>>().notNull().default({}),
    ...updatable,
  },
  (t) => [
    uniqueIndex('firm_subscriptions_firm_idx').on(t.firmId),
    tenantPolicy('firm_subscriptions'),
  ],
);

/** A PayFast checkout started by an administrator (m_payment_id = id). */
export const subscriptionCheckouts = pgTable(
  'subscription_checkouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    planCode: text('plan_code').notNull(),
    interval: text('interval').notNull(),
    seats: integer('seats').notNull(),
    amountCents: integer('amount_cents').notNull(),
    /** 'pending' | 'complete' | 'superseded' */
    status: text('status').notNull().default('pending'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('subscription_checkouts_firm_idx').on(t.firmId, t.createdAt),
    tenantPolicy('subscription_checkouts'),
  ],
);

/** Each payment PayFast confirmed (ITN), once per pf_payment_id. */
export const subscriptionPayments = pgTable(
  'subscription_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    checkoutId: uuid('checkout_id').references(() => subscriptionCheckouts.id, {
      onDelete: 'set null',
    }),
    pfPaymentId: text('pf_payment_id').notNull(),
    amountCents: integer('amount_cents').notNull(),
    feeCents: integer('fee_cents'),
    /** 'complete' | 'failed' | 'mismatch' (amount differed from what we expected) */
    status: text('status').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('subscription_payments_pf_idx').on(t.firmId, t.pfPaymentId),
    tenantPolicy('subscription_payments'),
  ],
);

// ------------------------------------------------------------------- AI
//
// Every model call, for metering, per-firm caps and the redacted prompt and
// response log (roadmap §7). Prompts are de-identified before they are sent,
// and both are still encrypted here: they describe a client's matter.
export const aiCalls = pgTable(
  'ai_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    /** 'triage' | 'research' | 'evaluation' */
    purpose: text('purpose').notNull(),
    /** What the call was for, e.g. 'submission' or 'research_request', and its id. */
    subjectType: text('subject_type'),
    subjectId: uuid('subject_id'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** 'ok' | 'failed' */
    status: text('status').notNull(),
    /** Our own error message (never the provider's body). */
    error: text('error'),
    durationMs: integer('duration_ms'),
    /** Encrypted {system, messages} as sent (already de-identified). */
    promptEncrypted: text('prompt_encrypted'),
    /** Encrypted model answer. */
    responseEncrypted: text('response_encrypted'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('ai_calls_firm_month_idx').on(t.firmId, t.createdAt), tenantPolicy('ai_calls')],
);

/** A research question on a matter, its de-identified brief and (later) its answer. */
export const researchRequests = pgTable(
  'research_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    /** 'draft' | 'confirmed' */
    status: text('status').notNull().default('draft'),
    /** Encrypted question as the attorney asked it. */
    questionEncrypted: text('question_encrypted').notNull(),
    /** Encrypted {text, replacements, warnings}: exactly what the model will see. */
    briefEncrypted: text('brief_encrypted').notNull(),
    /** Encrypted token -> original mapping (never sent anywhere). */
    mappingEncrypted: text('mapping_encrypted').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** Encrypted ResearchAnswer: verified claims, removed claims, gaps. */
    answerEncrypted: text('answer_encrypted'),
    /** Encrypted copy of every passage the answer could cite, as retrieved. */
    sourcesEncrypted: text('sources_encrypted'),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    /** Our error message when the last run failed (no personal information). */
    lastError: text('last_error'),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** Encrypted note from the approving attorney. */
    approvalNoteEncrypted: text('approval_note_encrypted'),
    ...updatable,
  },
  (t) => [
    index('research_requests_case_idx').on(t.caseId, t.createdAt),
    tenantPolicy('research_requests'),
    matterPolicy('research_requests'),
  ],
);

// ------------------------------------------------------------ legal corpus
//
// The approved corpus (roadmap §7.4). Public sources are platform tables:
// requests may read them, only platform operators (ops CLI) change them, and
// a source is searchable only while its licence or permission is recorded
// and it is approved. Firm precedents are each firm's own (tenant tables),
// de-identified and reviewed before they can be searched.

export const legalSources = pgTable('legal_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  /** SourceKind: legislation, case_law, regulation, rules, practice_directive, tribunal, guidance, journal, treatise, other */
  kind: text('kind').notNull(),
  publisher: text('publisher').notNull().default(''),
  url: text('url').notNull().default(''),
  /** The licence or terms that allow this use. */
  licence: text('licence').notNull(),
  /** The written permission or agreement relied on (reference, date). */
  permission: text('permission').notNull().default(''),
  /** 'approved' | 'suspended' */
  status: text('status').notNull().default('approved'),
  approvedBy: text('approved_by').notNull(),
  approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
  ...updatable,
});

export const legalDocuments = pgTable(
  'legal_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => legalSources.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** How lawyers cite it: "Act 50 of 1998", "[2019] ZACC 12". */
    citation: text('citation').notNull(),
    url: text('url').notNull().default(''),
    jurisdiction: text('jurisdiction').notNull().default('South Africa'),
    /** The version (point in time) the text is current at. */
    versionDate: text('version_date'),
    /**
     * Hierarchy of authority (1 = strongest): 1 Constitutional Court, 2 SCA,
     * 3 High Court and specialist courts, 4 statutes and regulations,
     * 5 rules and practice directives, 6 tribunals, guidance and commentary.
     */
    authorityLevel: integer('authority_level').notNull().default(6),
    /** Court or body: 'ZACC', 'ZASCA', 'ZAGPJHC', 'CCMA', 'Parliament'... */
    court: text('court').notNull().default(''),
    /** When it took effect (statutes: commencement). */
    effectiveDate: text('effective_date'),
    /** 'in_force' | 'amended' | 'repealed' | 'not_commenced' | 'overruled' */
    validity: text('validity').notNull().default('in_force'),
    repealedDate: text('repealed_date'),
    contentHash: text('content_hash').notNull(),
    ...updatable,
  },
  (t) => [uniqueIndex('legal_documents_source_citation_idx').on(t.sourceId, t.citation)],
);

export const legalPassages = pgTable(
  'legal_passages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => legalDocuments.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    /** Pinpoint: "section 4(1)", "para 23". */
    pinpoint: text('pinpoint').notNull().default(''),
    text: text('text').notNull(),
    /** A provision repealed within an act still in force. */
    repealed: boolean('repealed').notNull().default(false),
    search: tsvector('search').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(pinpoint, '') || ' ' || text)`,
    ),
  },
  (t) => [
    index('legal_passages_document_idx').on(t.documentId, t.ordinal),
    index('legal_passages_search_idx').using('gin', t.search),
  ],
);

/** A firm's own precedent (opinion, heads, memo), de-identified for research. */
export const firmPrecedents = pgTable(
  'firm_precedents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    title: text('title').notNull(),
    practiceArea: text('practice_area').notNull().default(''),
    /** 'review' (not searchable yet) | 'approved' */
    status: text('status').notNull().default('review'),
    /** Encrypted original text as uploaded. */
    originalEncrypted: text('original_encrypted').notNull(),
    /** Encrypted {warnings, replacements} from de-identification. */
    reviewEncrypted: text('review_encrypted').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    ...updatable,
  },
  (t) => [index('firm_precedents_status_idx').on(t.status), tenantPolicy('firm_precedents')],
);

/** De-identified passages of a firm precedent (what research can search and cite). */
export const precedentPassages = pgTable(
  'precedent_passages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    precedentId: uuid('precedent_id')
      .notNull()
      .references(() => firmPrecedents.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    pinpoint: text('pinpoint').notNull().default(''),
    /** De-identified text (no client personal information). */
    text: text('text').notNull(),
    search: tsvector('search').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(pinpoint, '') || ' ' || text)`,
    ),
  },
  (t) => [
    index('precedent_passages_precedent_idx').on(t.precedentId, t.ordinal),
    index('precedent_passages_search_idx').using('gin', t.search),
    tenantPolicy('precedent_passages'),
  ],
);

export type LegalSourceRow = typeof legalSources.$inferSelect;
export type LegalDocumentRow = typeof legalDocuments.$inferSelect;
export type FirmPrecedentRow = typeof firmPrecedents.$inferSelect;

// -------------------------------------------------------- trust accounting
//
// Trust money held for clients (Legal Practice Act s86). One ledger per
// matter per trust bank account; entries are never changed or deleted once
// posted (corrections are reversals), and no matter's ledger may go into
// debit. Money out needs a practitioner's authorisation by someone other
// than the requester.

export const trustAccounts = pgTable(
  'trust_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    name: text('name').notNull(),
    /** 'trust' (s86(2)) | 'investment_86_3' | 'investment_86_4' */
    kind: text('kind').notNull().default('trust'),
    bankName: text('bank_name').notNull(),
    accountNumberEncrypted: text('account_number_encrypted').notNull(),
    accountLast4: text('account_last4').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...updatable,
  },
  (t) => [tenantPolicy('trust_accounts')],
);

export const trustEntries = pgTable(
  'trust_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => trustAccounts.id),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id),
    /** TrustEntryKind */
    kind: text('kind').notNull(),
    /** Signed cents: + into the matter's ledger, - out of it. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    entryDate: date('entry_date', { mode: 'string' }).notNull(),
    /** Encrypted bank reference (often carries a payer's name). */
    referenceEncrypted: text('reference_encrypted').notNull(),
    descriptionEncrypted: text('description_encrypted').notNull(),
    /** 'pending' | 'posted' | 'rejected' */
    status: text('status').notNull(),
    invoiceId: uuid('invoice_id').references(() => invoices.id),
    /** The two legs of a matter-to-matter transfer share a group. */
    groupId: uuid('group_id'),
    reversesId: uuid('reverses_id'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    authorisedBy: uuid('authorised_by').references(() => users.id, { onDelete: 'set null' }),
    authorisedAt: timestamp('authorised_at', { withTimezone: true }),
    rejectedReason: text('rejected_reason'),
    /** Date the entry appeared on the bank statement. */
    clearedOn: date('cleared_on', { mode: 'string' }),
    ...timestamps,
  },
  (t) => [
    index('trust_entries_ledger_idx').on(t.accountId, t.caseId, t.status),
    index('trust_entries_date_idx').on(t.accountId, t.entryDate),
    uniqueIndex('trust_entries_reversal_idx')
      .on(t.reversesId)
      .where(sql`${t.reversesId} is not null and ${t.status} <> 'rejected'`),
    tenantPolicy('trust_entries'),
    matterPolicy('trust_entries'),
  ],
);

export const trustReconciliations = pgTable(
  'trust_reconciliations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => trustAccounts.id),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    bankBalanceCents: bigint('bank_balance_cents', { mode: 'number' }).notNull(),
    cashbookCents: bigint('cashbook_cents', { mode: 'number' }).notNull(),
    ledgerTotalCents: bigint('ledger_total_cents', { mode: 'number' }).notNull(),
    unclearedReceiptsCents: bigint('uncleared_receipts_cents', { mode: 'number' }).notNull(),
    unclearedPaymentsCents: bigint('uncleared_payments_cents', { mode: 'number' }).notNull(),
    debitLedgers: integer('debit_ledgers').notNull(),
    notesEncrypted: text('notes_encrypted'),
    preparedBy: uuid('prepared_by').references(() => users.id, { onDelete: 'set null' }),
    signedOffBy: uuid('signed_off_by').references(() => users.id, { onDelete: 'set null' }),
    signedOffAt: timestamp('signed_off_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('trust_reconciliations_account_idx').on(t.accountId, t.periodEnd),
    tenantPolicy('trust_reconciliations'),
  ],
);

export type TrustAccountRow = typeof trustAccounts.$inferSelect;
export type TrustEntryRow = typeof trustEntries.$inferSelect;
export type TrustReconciliationRow = typeof trustReconciliations.$inferSelect;

// ------------------------------------------------------------ client portal
//
// Clients sign in to see their own matters: an emailed one-time link plus an
// authenticator code (two factors), never a staff account. Every portal
// query is filtered to the matters where the portal user's party is the
// client.

export const portalUsers = pgTable(
  'portal_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'cascade' }),
    /** Blind index of the sign-in email (lookup without decrypting). */
    emailIndex: text('email_index').notNull(),
    emailEncrypted: text('email_encrypted').notNull(),
    /** 'invited' | 'active' | 'disabled' */
    status: text('status').notNull().default('invited'),
    totpSecretEncrypted: text('totp_secret_encrypted'),
    /** Last TOTP step accepted (no replays). */
    lastTotpStep: integer('last_totp_step'),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
    ...updatable,
  },
  (t) => [
    uniqueIndex('portal_users_party_idx').on(t.firmId, t.partyId),
    uniqueIndex('portal_users_email_idx').on(t.firmId, t.emailIndex),
    tenantPolicy('portal_users'),
  ],
);

/** One-time links (invite, sign-in): only the token's hash is kept. */
export const portalLinks = pgTable(
  'portal_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    portalUserId: uuid('portal_user_id')
      .notNull()
      .references(() => portalUsers.id, { onDelete: 'cascade' }),
    /** 'invite' | 'sign_in' */
    purpose: text('purpose').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    /** Wrong authenticator codes against this link. */
    attempts: integer('attempts').notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex('portal_links_token_idx').on(t.tokenHash), tenantPolicy('portal_links')],
);

export const portalSessions = pgTable(
  'portal_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    portalUserId: uuid('portal_user_id')
      .notNull()
      .references(() => portalUsers.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('portal_sessions_token_idx').on(t.tokenHash),
    tenantPolicy('portal_sessions'),
  ],
);

export const portalMessages = pgTable(
  'portal_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    /** 'client' | 'staff' */
    sender: text('sender').notNull(),
    portalUserId: uuid('portal_user_id').references(() => portalUsers.id, { onDelete: 'set null' }),
    staffUserId: uuid('staff_user_id').references(() => users.id, { onDelete: 'set null' }),
    bodyEncrypted: text('body_encrypted').notNull(),
    readByClientAt: timestamp('read_by_client_at', { withTimezone: true }),
    readByStaffAt: timestamp('read_by_staff_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('portal_messages_case_idx').on(t.caseId, t.createdAt),
    tenantPolicy('portal_messages'),
    matterPolicy('portal_messages'),
  ],
);

export type PortalUserRow = typeof portalUsers.$inferSelect;

export type AiCallRow = typeof aiCalls.$inferSelect;
export type ResearchRequestRow = typeof researchRequests.$inferSelect;

export type FirmSubscriptionRow = typeof firmSubscriptions.$inferSelect;
export type SubscriptionCheckoutRow = typeof subscriptionCheckouts.$inferSelect;
export type SubscriptionPaymentRow = typeof subscriptionPayments.$inferSelect;

export type FirmAssetRow = typeof firmAssets.$inferSelect;
export type FirmDomainRow = typeof firmDomains.$inferSelect;

// ---------------------------------------------------------------- platform

/**
 * Ahava on 88 support staff (platform operators). Platform-level: no firm_id,
 * and the app_tenant role has no access at all. Operators can only enter a
 * firm's workspace while that firm has granted support access.
 */
export const platformOperators = pgTable('platform_operators', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  fullName: text('full_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  passwordSalt: text('password_salt').notNull(),
  /** TOTP secret, sealed with the platform key. MFA is mandatory. */
  mfaSecretEncrypted: text('mfa_secret_encrypted').notNull(),
  mfaLastStep: bigint('mfa_last_step', { mode: 'number' }),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The plans firms can subscribe to. Platform-level: no firm_id; requests
 * (app_tenant) may only read them. Managed with `npm run ops -- plans`.
 */
export const subscriptionPlans = pgTable('subscription_plans', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  /** Per seat per month, excluding VAT, in cents. */
  monthlySeatPriceCents: integer('monthly_seat_price_cents').notNull(),
  /** Per seat per year, excluding VAT, in cents. */
  annualSeatPriceCents: integer('annual_seat_price_cents').notNull(),
  minSeats: integer('min_seats').notNull().default(1),
  maxSeats: integer('max_seats'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  ...updatable,
});

export type SubscriptionPlanRow = typeof subscriptionPlans.$inferSelect;

/** A firm administrator's time-boxed permission for platform support to sign in (read-only). */
export const supportGrants = pgTable(
  'support_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    reason: text('reason').notNull(),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('support_grants_expires_idx').on(t.expiresAt), tenantPolicy('support_grants')],
);

// ---------------------------------------------------------------- keys

/**
 * Per-firm data-encryption keys (envelope encryption). Each key is stored
 * only wrapped by a key-encryption key: Azure Key Vault in production, or the
 * local INTAKE_ENCRYPTION_KEY. purpose 'data' encrypts records (rotatable);
 * 'index' keys blind indexes (stable, so lookups keep working).
 */
export const firmKeys = pgTable(
  'firm_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    purpose: text('purpose').notNull(),
    version: integer('version').notNull(),
    wrappedKey: text('wrapped_key').notNull(),
    /** 'local' or 'azure-keyvault'. */
    kekProvider: text('kek_provider').notNull(),
    /** Key-encryption key id (Key Vault key URL with version, or local fingerprint). */
    kekId: text('kek_id').notNull(),
    status: text('status').notNull().default('active'),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('firm_keys_firm_purpose_version_idx').on(t.firmId, t.purpose, t.version),
    tenantPolicy('firm_keys'),
  ],
);

// ---------------------------------------------------------------- identity

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    role: text('role').notNull().default('attorney'),
    /** Null for accounts that only sign in with Entra External ID. */
    passwordHash: text('password_hash'),
    passwordSalt: text('password_salt'),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    /** Entra External ID (OIDC) identity, linked through an invite. */
    oidcIssuer: text('oidc_issuer'),
    oidcSubject: text('oidc_subject'),
    /** TOTP secret, encrypted with privacy.service. Null until enrolled. */
    mfaSecretEncrypted: text('mfa_secret_encrypted'),
    mfaEnabledAt: timestamp('mfa_enabled_at', { withTimezone: true }),
    /** Last accepted TOTP time step, so a code can't be replayed. */
    mfaLastStep: bigint('mfa_last_step', { mode: 'number' }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    /** Set on the firm's stand-in account for a platform support operator. */
    platformOperatorId: uuid('platform_operator_id'),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('users_firm_email_idx').on(t.firmId, t.email),
    uniqueIndex('users_firm_oidc_idx').on(t.firmId, t.oidcIssuer, t.oidcSubject),
    tenantPolicy('users'),
  ],
);

/**
 * Signed-in sessions. The browser holds a random token in an httpOnly cookie;
 * only its SHA-256 hash is stored, so a database leak yields no usable session.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    /** 'password' (with TOTP) or 'oidc' (MFA enforced by Entra). */
    method: text('method').notNull(),
    userAgent: text('user_agent'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('sessions_user_id_idx').on(t.userId), tenantPolicy('sessions')],
);

/** One-time MFA recovery codes (hashed). */
export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('mfa_recovery_codes_user_id_idx').on(t.userId), tenantPolicy('mfa_recovery_codes')],
);

/** Staff invitations: the only way to create an account in a firm. */
export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    role: text('role').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('invites_firm_email_idx').on(t.firmId, t.email), tenantPolicy('invites')],
);

/** Password reset links (hashed tokens, single use, short-lived). */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('password_resets_user_id_idx').on(t.userId), tenantPolicy('password_resets')],
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
    /** The matter this intake became (set in the same transaction as the case). */
    caseId: uuid('case_id').references((): AnyPgColumn => cases.id, { onDelete: 'set null' }),
    ...updatable,
  },
  (t) => [
    index('submissions_created_at_idx').on(t.createdAt),
    index('submissions_email_lookup_idx').on(t.emailLookup),
    tenantPolicy('submissions'),
    // An intake is hidden when the matter it became is hidden.
    pgPolicy('submissions_matter_access', {
      as: 'restrictive',
      for: 'all',
      to: 'app_tenant',
      using: sql`case_id is null or exists (select 1 from cases c where c.id = submissions.case_id)`,
      withCheck: sql`case_id is null or exists (select 1 from cases c where c.id = submissions.case_id)`,
    }),
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
  () => [
    tenantPolicy('assessments'),
    pgPolicy('assessments_matter_access', {
      as: 'restrictive',
      for: 'all',
      to: 'app_tenant',
      using: sql`exists (select 1 from submissions s where s.id = assessments.intake_submission_id)`,
      withCheck: sql`exists (select 1 from submissions s where s.id = assessments.intake_submission_id)`,
    }),
  ],
);

// ---------------------------------------------------------------- matters

export const cases = pgTable(
  'cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    /** The intake this matter came from; null for matters opened for a client directly. */
    intakeSubmissionId: uuid('intake_submission_id')
      .unique()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    caseNumber: text('case_number').notNull(),
    /** Short description of the matter (no personal information). */
    title: text('title'),
    clientLabel: text('client_label').notNull(),
    practiceArea: text('practice_area').notNull(),
    urgency: text('urgency').notNull(),
    status: text('status').notNull().default('triage'),
    /** Encrypted update for the client, shown in the portal. */
    clientUpdateEncrypted: text('client_update_encrypted'),
    clientUpdateAt: timestamp('client_update_at', { withTimezone: true }),
    nextAction: text('next_action').notNull(),
    /** 'firm': all staff with matter access; 'restricted': members (and admins) only. */
    access: text('access').notNull().default('firm'),
    /** Court division code (COURT_DIVISIONS in shared), once the matter is in court. */
    courtDivision: text('court_division'),
    /** The court's case number as given, e.g. 12345/2025 or 2025-012345 (not personal information). */
    courtCaseNumber: text('court_case_number'),
    /** courtCaseNumber normalised (number/yyyy) for matching court rolls. */
    courtCaseKey: text('court_case_key'),
    /** Court Online case number (court case numbers are not personal information). */
    courtOnlineReference: text('court_online_reference'),
    /** Normalised Court Online number: rolls are matched against it too. */
    courtOnlineKey: text('court_online_key'),
    ...updatable,
  },
  (t) => [
    index('cases_created_at_idx').on(t.createdAt),
    index('cases_court_case_key_idx').on(t.courtDivision, t.courtCaseKey),
    index('cases_court_online_key_idx').on(t.courtDivision, t.courtOnlineKey),
    uniqueIndex('cases_firm_case_number_idx').on(t.firmId, t.caseNumber),
    tenantPolicy('cases'),
    pgPolicy('cases_matter_access', {
      as: 'restrictive',
      for: 'all',
      to: 'app_tenant',
      using: sql`app_case_visible(access, id)`,
      withCheck: sql`app_case_visible(access, id)`,
    }),
  ],
);

// ---------------------------------------------------------------- clients and parties

/**
 * People and organisations the firm deals with: clients, opposing parties,
 * their attorneys, related persons. Identifying details are encrypted with
 * the firm's data key; party_index holds blind-index hashes so parties can be
 * found (and conflicts checked) without decrypting the register. The register
 * is firm-wide; which matters a party is on is matter-scoped (case_parties).
 */
export const parties = pgTable(
  'parties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    partyNumber: text('party_number').notNull(),
    /** 'individual' | 'entity' */
    kind: text('kind').notNull(),
    isClient: boolean('is_client').notNull().default(false),
    clientSince: timestamp('client_since', { withTimezone: true }),
    /** Encrypted PartyDetails (name, ID/registration number, contacts, address). */
    detailsEncrypted: text('details_encrypted').notNull(),
    /** The conflict check that cleared this party as a client. */
    conflictCheckId: uuid('conflict_check_id'),
    ...updatable,
  },
  (t) => [
    uniqueIndex('parties_firm_number_idx').on(t.firmId, t.partyNumber),
    index('parties_is_client_idx').on(t.isClient),
    tenantPolicy('parties'),
  ],
);

/** Blind-index hashes of a party's names, tokens, ID/registration numbers, email and phone. */
export const partyIndex = pgTable(
  'party_index',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'cascade' }),
    /** 'name' | 'token' | 'id_number' | 'reg_number' | 'email' | 'phone' */
    field: text('field').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [
    index('party_index_hash_idx').on(t.firmId, t.hash),
    index('party_index_party_idx').on(t.partyId),
    tenantPolicy('party_index'),
  ],
);

/**
 * Conflict-of-interest checks, kept as the firm's record (LPC rules). The
 * searched names are encrypted; results hold only party ids, strengths and
 * matter references.
 */
export const conflictChecks = pgTable(
  'conflict_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    queryEncrypted: text('query_encrypted').notNull(),
    results: jsonb('results').$type<Record<string, unknown>[]>().notNull().default([]),
    strongMatches: integer('strong_matches').notNull().default(0),
    possibleMatches: integer('possible_matches').notNull().default(0),
    /** 'pending' | 'clear' | 'conflict' | 'waived' */
    decision: text('decision').notNull().default('pending'),
    decisionNotesEncrypted: text('decision_notes_encrypted'),
    performedBy: uuid('performed_by').references(() => users.id, { onDelete: 'set null' }),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('conflict_checks_created_idx').on(t.createdAt), tenantPolicy('conflict_checks')],
);

// ---------------------------------------------------------------- FICA

/**
 * Customer due diligence for a client (FIC Act): risk rating and factors,
 * verification status and the date the next review is due.
 */
export const ficaProfiles = pgTable(
  'fica_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'cascade' }),
    /** 'in_progress' | 'verified' */
    status: text('status').notNull().default('in_progress'),
    /** 'low' | 'medium' | 'high' */
    riskRating: text('risk_rating').notNull().default('low'),
    riskFactors: jsonb('risk_factors').$type<Record<string, boolean>>().notNull().default({}),
    /** Encrypted notes on the assessment (may name people). */
    notesEncrypted: text('notes_encrypted'),
    verifiedBy: uuid('verified_by').references(() => users.id, { onDelete: 'set null' }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    reviewDue: date('review_due', { mode: 'string' }),
    ...updatable,
  },
  (t) => [uniqueIndex('fica_profiles_party_idx').on(t.partyId), tenantPolicy('fica_profiles')],
);

/**
 * KYC documents (ID, proof of address, company registration …). The file and
 * its name are encrypted with the firm's key and kept in the object store
 * (or in the row when none is configured).
 */
export const ficaDocuments = pgTable(
  'fica_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'cascade' }),
    docType: text('doc_type').notNull(),
    /** Encrypted original file name (often contains the person's name). */
    fileNameEncrypted: text('file_name_encrypted').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Encrypted { fileName, data } when no object store is configured. */
    encryptedContent: text('encrypted_content'),
    storageKey: text('storage_key'),
    contentKeyVersion: integer('content_key_version'),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('fica_documents_party_idx').on(t.partyId), tenantPolicy('fica_documents')],
);

/** Who is on a matter, and in what role. Matter-scoped. */
export const caseParties = pgTable(
  'case_parties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'cascade' }),
    /** 'client' | 'opposing' | 'opposing_attorney' | 'related' | 'witness' */
    role: text('role').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('case_parties_unique_idx').on(t.caseId, t.partyId, t.role),
    index('case_parties_party_idx').on(t.partyId),
    tenantPolicy('case_parties'),
    matterPolicy('case_parties'),
  ],
);

/** Staff on a matter. A restricted matter is visible only to its members and admins. */
export const caseMembers = pgTable(
  'case_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'lead' can manage the matter's access; 'member' can work on it. */
    memberRole: text('member_role').notNull().default('member'),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('case_members_case_user_idx').on(t.caseId, t.userId),
    index('case_members_user_id_idx').on(t.userId),
    tenantPolicy('case_members'),
  ],
);

/** Ethical walls: these staff can never see the matter, whatever their role. */
export const caseExclusions = pgTable(
  'case_exclusions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('case_exclusions_case_user_idx').on(t.caseId, t.userId),
    index('case_exclusions_user_id_idx').on(t.userId),
    tenantPolicy('case_exclusions'),
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
  (t) => [
    index('case_tasks_case_id_idx').on(t.caseId),
    tenantPolicy('case_tasks'),
    matterPolicy('case_tasks'),
  ],
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
  (t) => [
    index('case_timeline_case_id_idx').on(t.caseId),
    tenantPolicy('case_timeline'),
    matterPolicy('case_timeline'),
  ],
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
    /** Encrypted body, when no object store is configured (and legacy rows). */
    encryptedContent: text('encrypted_content'),
    /** Object-store key of the encrypted body, when OBJECT_STORE is set. */
    storageKey: text('storage_key'),
    /** Data-key version the stored object is encrypted with (re-encryption). */
    contentKeyVersion: integer('content_key_version'),
    contentPreview: text('content_preview').notNull().default(''),
    createdBy: text('created_by').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    /** Shown to the matter's client in the portal (staff choose). */
    sharedWithClientAt: timestamp('shared_with_client_at', { withTimezone: true }),
    ...updatable,
  },
  (t) => [
    index('documents_case_id_idx').on(t.caseId),
    tenantPolicy('documents'),
    matterPolicy('documents'),
  ],
);

// ---------------------------------------------------------------- billing

/** Line items of invoices created before epic 7 (kept for reading). */
export interface StoredLineItem {
  description: string;
  quantity: number;
  /** Unit price in cents. */
  rateCents: number;
}

/** One line of an invoice (stored encrypted with the subject and notes). */
export interface InvoiceLineRecord {
  kind: 'fee' | 'disbursement' | 'other';
  description: string;
  /** Hours for fees; a count otherwise. */
  quantity: number;
  unitCents: number;
  amountCents: number;
  vatable: boolean;
  workDate?: string;
  feeEarner?: string;
  timeEntryId?: string;
  disbursementId?: string;
}

/** The encrypted part of an invoice: everything that may name people. */
export interface InvoiceContent {
  subject: string;
  notes?: string;
  lines: InvoiceLineRecord[];
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
    /** Gap-free per firm, given when the invoice is issued (null for drafts). */
    invoiceNumber: text('invoice_number'),
    /** Pre-epic-7 invoices only; newer ones keep the subject in contentEncrypted. */
    subject: text('subject').notNull().default(''),
    currency: text('currency').notNull().default('ZAR'),
    /** 'draft' | 'issued' | 'partially_paid' | 'paid' | 'void' */
    status: text('status').notNull().default('draft'),
    /** Pre-epic-7 invoices only. */
    lineItems: jsonb('line_items').$type<StoredLineItem[]>().notNull().default([]),
    /** InvoiceContent, encrypted with privacy.service. */
    contentEncrypted: text('content_encrypted'),
    /** The client billed. */
    clientPartyId: uuid('client_party_id').references(() => parties.id, { onDelete: 'set null' }),
    /** VAT rate in basis points (1500 = 15%) used for this invoice. */
    vatRateBp: integer('vat_rate_bp'),
    subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull().default(0),
    vatCents: bigint('vat_cents', { mode: 'number' }).notNull().default(0),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
    paidCents: bigint('paid_cents', { mode: 'number' }).notNull().default(0),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    ...updatable,
  },
  (t) => [
    index('billing_invoices_case_id_idx').on(t.caseId),
    uniqueIndex('billing_invoices_firm_number_idx').on(t.firmId, t.invoiceNumber),
    tenantPolicy('billing_invoices'),
    matterPolicy('billing_invoices'),
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
  (t) => [
    index('billing_ledger_case_id_idx').on(t.caseId),
    tenantPolicy('billing_ledger'),
    matterPolicy('billing_ledger'),
  ],
);

/** Costs paid on a client's behalf (sheriff, counsel, court fees), billed at cost. */
export const disbursements = pgTable(
  'disbursements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    incurredOn: date('incurred_on').notNull(),
    descriptionEncrypted: text('description_encrypted').notNull(),
    /** Excluding VAT. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /** Court fees and other pass-through costs carry no VAT. */
    vatable: boolean('vatable').notNull().default(true),
    /** 'unbilled' | 'billed' | 'written_off' */
    status: text('status').notNull().default('unbilled'),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...updatable,
  },
  (t) => [
    index('disbursements_case_idx').on(t.caseId),
    tenantPolicy('disbursements'),
    matterPolicy('disbursements'),
  ],
);

/** A payment received against an invoice. */
export const invoicePayments = pgTable(
  'invoice_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    receivedOn: date('received_on').notNull(),
    /** 'eft' | 'card' | 'cash' | 'trust_transfer' | 'other' */
    method: text('method').notNull(),
    /** Bank or receipt reference (not a person's name). */
    reference: text('reference').notNull().default(''),
    recordedBy: uuid('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('invoice_payments_invoice_idx').on(t.invoiceId),
    tenantPolicy('invoice_payments'),
    matterPolicy('invoice_payments'),
  ],
);

export type DisbursementRow = typeof disbursements.$inferSelect;
export type InvoicePaymentRow = typeof invoicePayments.$inferSelect;

// ---------------------------------------------------------------- time recording

/** A fee earner's standard hourly rate. */
export const staffRates = pgTable(
  'staff_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    hourlyRateCents: bigint('hourly_rate_cents', { mode: 'number' }).notNull(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    ...updatable,
  },
  (t) => [uniqueIndex('staff_rates_user_idx').on(t.userId), tenantPolicy('staff_rates')],
);

/** An agreed rate on one matter: for one fee earner, or (user_id null) for everyone on it. */
export const matterRates = pgTable(
  'matter_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    hourlyRateCents: bigint('hourly_rate_cents', { mode: 'number' }).notNull(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    ...updatable,
  },
  (t) => [
    uniqueIndex('matter_rates_case_user_idx')
      .on(t.caseId, t.userId)
      .where(sql`${t.userId} is not null`),
    uniqueIndex('matter_rates_case_all_idx')
      .on(t.caseId)
      .where(sql`${t.userId} is null`),
    tenantPolicy('matter_rates'),
    matterPolicy('matter_rates'),
  ],
);

/**
 * Recorded time, in 6-minute units (0.1 hour). The rate is fixed when the
 * time is recorded. Unbilled billable time is the matter's work in progress.
 */
export const timeEntries = pgTable(
  'time_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    /** The fee earner whose time this is. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    workDate: date('work_date').notNull(),
    units: integer('units').notNull(),
    billable: boolean('billable').notNull().default(true),
    rateCents: bigint('rate_cents', { mode: 'number' }).notNull().default(0),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull().default(0),
    activity: text('activity').notNull().default('other'),
    /** Narrative of the work (may name people), encrypted with privacy.service. */
    descriptionEncrypted: text('description_encrypted').notNull(),
    /** 'manual' | 'timer' */
    source: text('source').notNull().default('manual'),
    /** 'unbilled' | 'billed' | 'written_off' */
    status: text('status').notNull().default('unbilled'),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...updatable,
  },
  (t) => [
    index('time_entries_case_idx').on(t.caseId),
    index('time_entries_user_date_idx').on(t.userId, t.workDate),
    tenantPolicy('time_entries'),
    matterPolicy('time_entries'),
  ],
);

/** A fee earner's running (or paused) timer; one per person. */
export const timers = pgTable(
  'timers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    activity: text('activity').notNull().default('other'),
    billable: boolean('billable').notNull().default(true),
    descriptionEncrypted: text('description_encrypted'),
    /** When the current run started; null while paused. */
    runningSince: timestamp('running_since', { withTimezone: true }),
    /** Seconds from earlier runs (before the last pause). */
    elapsedSeconds: integer('elapsed_seconds').notNull().default(0),
    ...updatable,
  },
  (t) => [
    uniqueIndex('timers_user_idx').on(t.userId),
    tenantPolicy('timers'),
    matterPolicy('timers'),
  ],
);

export type StaffRateRow = typeof staffRates.$inferSelect;
export type MatterRateRow = typeof matterRates.$inferSelect;
export type TimeEntryRow = typeof timeEntries.$inferSelect;
export type TimerRow = typeof timers.$inferSelect;

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
    /** Events from before epic 7 only; newer ones keep title, location and notes encrypted. */
    title: text('title').notNull().default(''),
    eventType: text('event_type').notNull().default('deadline'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    allDay: boolean('all_day').notNull().default(false),
    location: text('location').notNull().default(''),
    notes: text('notes').notNull().default(''),
    /** { title, location, notes } encrypted with privacy.service. */
    contentEncrypted: text('content_encrypted'),
    /** 'scheduled' | 'done' | 'cancelled' */
    status: text('status').notNull().default('scheduled'),
    /** 'manual' | 'prescription' | 'court_roll' */
    source: text('source').notNull().default('manual'),
    sourceRef: text('source_ref'),
    assigneeUserId: uuid('assignee_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Minutes before the start when reminders go out. */
    reminderOffsets: jsonb('reminder_offsets').$type<number[]>().notNull().default([]),
    /** Offsets already sent. */
    remindersSent: jsonb('reminders_sent').$type<number[]>().notNull().default([]),
    createdBy: text('created_by').notNull(),
    ...timestamps,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('calendar_events_starts_at_idx').on(t.startsAt),
    index('calendar_events_status_idx').on(t.status, t.startsAt),
    tenantPolicy('calendar_events'),
    matterPolicy('calendar_events'),
  ],
);

/** A limitation period on a matter, with its last day on the calendar. */
export const matterPrescriptions = pgTable(
  'matter_prescriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    /** PRESCRIPTION_RULES code in shared. */
    rule: text('rule').notNull(),
    startsOn: date('starts_on').notNull(),
    lastDay: date('last_day').notNull(),
    /** 'running' | 'interrupted' (e.g. summons served) | 'closed' */
    status: text('status').notNull().default('running'),
    notesEncrypted: text('notes_encrypted'),
    eventId: uuid('event_id').references(() => calendarEvents.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...updatable,
  },
  (t) => [
    index('matter_prescriptions_case_idx').on(t.caseId),
    tenantPolicy('matter_prescriptions'),
    matterPolicy('matter_prescriptions'),
  ],
);

export type MatterPrescriptionRow = typeof matterPrescriptions.$inferSelect;

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

// ---------------------------------------------------------------- court rolls

/**
 * A published court roll fetched by the sync job. Platform-level: rolls are
 * public and shared by every firm, and requests (app_tenant) can't read them.
 * Only case numbers, courtrooms, times and judges are kept, never party names.
 */
/**
 * Courts that use Court Online (the Office of the Chief Justice's e-filing
 * and case management system). Platform table: requests may only read it;
 * operators keep it current (`ops courts`).
 */
export const courtOnlineCourts = pgTable('court_online_courts', {
  division: text('division').primaryKey(),
  /** From when (as the source states it). */
  since: text('since').notNull(),
  /** Where this comes from (directive, notice, parliamentary reply). */
  source: text('source').notNull(),
  ...updatable,
});

export const courtRollDocuments = pgTable(
  'court_roll_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The configured source it came from (its index URL). */
    source: text('source').notNull(),
    division: text('division').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    rollDate: date('roll_date'),
    contentHash: text('content_hash').notNull(),
    contentType: text('content_type').notNull(),
    /** 'active' | 'superseded' (an amended version replaced it) | 'failed' */
    status: text('status').notNull().default('active'),
    supersededBy: uuid('superseded_by'),
    entryCount: integer('entry_count').notNull().default(0),
    error: text('error'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('court_roll_documents_version_idx').on(t.url, t.contentHash),
    index('court_roll_documents_division_idx').on(t.division, t.rollDate),
  ],
);

/** One matter on a roll: where and when it is heard. */
export const courtRollEntries = pgTable(
  'court_roll_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => courtRollDocuments.id, { onDelete: 'cascade' }),
    division: text('division').notNull(),
    /** Normalised court case number (lib/court.ts). */
    caseKey: text('case_key').notNull(),
    hearingDate: date('hearing_date'),
    hearingTime: text('hearing_time'),
    courtroom: text('courtroom'),
    judge: text('judge'),
    /** e.g. 'Opposed motions', 'Civil trials'. */
    section: text('section'),
  },
  (t) => [index('court_roll_entries_case_idx').on(t.division, t.caseKey)],
);

/** A firm's matter found on a court roll, for staff to put on the calendar or dismiss. */
export const courtRollMatches = pgTable(
  'court_roll_matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    /** 'sync' (published roll) | 'upload' (a roll the firm uploaded) */
    origin: text('origin').notNull(),
    /** The roll's URL, or upload:<sha256> for an uploaded file. */
    documentRef: text('document_ref').notNull(),
    documentTitle: text('document_title').notNull(),
    division: text('division').notNull(),
    hearingDate: date('hearing_date'),
    hearingTime: text('hearing_time'),
    courtroom: text('courtroom'),
    judge: text('judge'),
    section: text('section'),
    /** division|date|section|courtroom|time: one match per listing. */
    listingKey: text('listing_key').notNull(),
    /** 'new' | 'accepted' | 'dismissed' | 'removed' (no longer on an amended roll) */
    status: text('status').notNull().default('new'),
    eventId: uuid('event_id').references(() => calendarEvents.id, { onDelete: 'set null' }),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /** When the team was reminded that an unconfirmed listing is close. */
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    ...updatable,
  },
  (t) => [
    uniqueIndex('court_roll_matches_listing_idx').on(t.caseId, t.listingKey),
    index('court_roll_matches_status_idx').on(t.status),
    tenantPolicy('court_roll_matches'),
    matterPolicy('court_roll_matches'),
  ],
);

export type CourtRollDocumentRow = typeof courtRollDocuments.$inferSelect;
export type CourtRollEntryRow = typeof courtRollEntries.$inferSelect;
export type CourtRollMatchRow = typeof courtRollMatches.$inferSelect;

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

/**
 * Daily anchors of each firm's audit chain head. A copy is written to
 * immutable object storage, so history before an anchor can't be rewritten
 * without detection, even by someone holding AUDIT_CHAIN_SECRET.
 */
export const auditAnchors = pgTable(
  'audit_anchors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: firmId(),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull(),
    lastHash: text('last_hash').notNull(),
    eventCount: integer('event_count').notNull(),
    /** Where the immutable copy lives; null when no object store is configured. */
    objectKey: text('object_key'),
    ...timestamps,
  },
  (t) => [index('audit_anchors_last_seq_idx').on(t.lastSeq), tenantPolicy('audit_anchors')],
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
export type SessionRow = typeof sessions.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type CaseMemberRow = typeof caseMembers.$inferSelect;
export type CaseExclusionRow = typeof caseExclusions.$inferSelect;
export type FirmKeyRow = typeof firmKeys.$inferSelect;
export type AuditAnchorRow = typeof auditAnchors.$inferSelect;
export type PlatformOperatorRow = typeof platformOperators.$inferSelect;
export type SupportGrantRow = typeof supportGrants.$inferSelect;
export type PartyRow = typeof parties.$inferSelect;
export type ConflictCheckRow = typeof conflictChecks.$inferSelect;
export type FicaProfileRow = typeof ficaProfiles.$inferSelect;
export type FicaDocumentRow = typeof ficaDocuments.$inferSelect;
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
