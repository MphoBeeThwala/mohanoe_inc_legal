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
    nextAction: text('next_action').notNull(),
    /** 'firm': all staff with matter access; 'restricted': members (and admins) only. */
    access: text('access').notNull().default('firm'),
    ...updatable,
  },
  (t) => [
    index('cases_created_at_idx').on(t.createdAt),
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
    ...updatable,
  },
  (t) => [
    index('documents_case_id_idx').on(t.caseId),
    tenantPolicy('documents'),
    matterPolicy('documents'),
  ],
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
  (t) => [
    index('calendar_events_starts_at_idx').on(t.startsAt),
    tenantPolicy('calendar_events'),
    matterPolicy('calendar_events'),
  ],
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
