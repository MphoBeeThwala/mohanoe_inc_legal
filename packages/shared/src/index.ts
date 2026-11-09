// Types shared by the API (apps/api) and the web app (apps/web).
// Keep this package free of runtime dependencies: types and tiny pure helpers only.

// ---------------------------------------------------------------- branding

export interface PlatformInfo {
  legalName: string;
  supportEmail: string | null;
}

/** A firm's white-label brand, returned by GET /api/tenant/branding. */
export interface FirmBrand {
  firmName: string;
  firmShortName: string;
  productName: string;
  logoUrl: string | null;
  primaryColor: string;
  accentColor: string;
  casePrefix: string;
}

export interface PublicBranding extends FirmBrand {
  platform: PlatformInfo;
}

export const PLATFORM_LEGAL_NAME = 'Ahava on 88 (Pty) Ltd';

export const DEFAULT_FIRM_BRAND: FirmBrand = Object.freeze({
  firmName: 'Your Firm',
  firmShortName: 'Your Firm',
  productName: 'Legal Practice Workspace',
  logoUrl: null,
  primaryColor: '#1b7a58',
  accentColor: '#0f5d43',
  casePrefix: 'MAT',
});

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

// ---------------------------------------------------------------- auth

export type UserRole = 'admin' | 'attorney' | 'paralegal' | 'secretary' | 'bookkeeper' | 'support';

/** Roles a firm can give its own staff ('support' is only for platform support sessions). */
export const STAFF_ROLES: readonly UserRole[] = [
  'admin',
  'attorney',
  'paralegal',
  'secretary',
  'bookkeeper',
];

export const ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  admin: 'Administrator',
  attorney: 'Attorney',
  paralegal: 'Paralegal',
  secretary: 'Secretary',
  bookkeeper: 'Bookkeeper',
  support: 'Platform support',
};

export type Permission =
  | 'intake.read'
  | 'intake.write'
  | 'matters.read'
  | 'matters.write'
  | 'documents.read'
  | 'documents.write'
  | 'calendar.read'
  | 'calendar.write'
  | 'billing.read'
  | 'billing.write'
  | 'reports.read'
  | 'notifications.read'
  | 'notifications.write'
  | 'compliance.read'
  | 'compliance.write'
  | 'compliance.admin'
  | 'audit.read'
  | 'users.manage'
  | 'clients.read'
  | 'clients.write'
  | 'conflicts.check'
  | 'conflicts.waive';

const FEE_EARNER: readonly Permission[] = [
  'clients.read',
  'clients.write',
  'conflicts.check',
  'intake.read',
  'intake.write',
  'matters.read',
  'matters.write',
  'documents.read',
  'documents.write',
  'calendar.read',
  'calendar.write',
  'billing.read',
  'billing.write',
  'reports.read',
  'notifications.read',
  'notifications.write',
];

/** What each role may do within its firm. Matter-level access narrows this further. */
export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = {
  // POPIA data-subject requests are handled by administrators (the firm's
  // information officer), not by every fee earner.
  admin: [
    ...FEE_EARNER,
    'compliance.read',
    'compliance.write',
    'compliance.admin',
    'audit.read',
    'users.manage',
    'conflicts.waive',
  ],
  attorney: FEE_EARNER,
  paralegal: FEE_EARNER,
  secretary: [
    'clients.read',
    'clients.write',
    'conflicts.check',
    'intake.read',
    'intake.write',
    'matters.read',
    'documents.read',
    'documents.write',
    'calendar.read',
    'calendar.write',
    'notifications.read',
  ],
  bookkeeper: [
    'clients.read',
    'matters.read',
    'billing.read',
    'billing.write',
    'reports.read',
    'notifications.read',
  ],
  // Platform support, while the firm allows it: read-only, and still subject
  // to restricted matters and ethical walls.
  support: [
    'intake.read',
    'matters.read',
    'documents.read',
    'calendar.read',
    'billing.read',
    'reports.read',
    'notifications.read',
  ],
};

export function hasPermission(
  role: UserRole | string | undefined,
  permission: Permission,
): boolean {
  return Boolean(role && ROLE_PERMISSIONS[role as UserRole]?.includes(permission));
}

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  createdAt: string;
  lastLoginAt: string | null;
  /** Permissions granted by the role (for the UI; the API enforces them). */
  permissions: Permission[];
  mfaEnabled: boolean;
  signInMethods: SignInMethod[];
}

export type SignInMethod = 'password' | 'oidc' | 'support';

/** GET /api/auth/me */
export interface MeResponse {
  user: PublicUser;
  session: { method: SignInMethod; expiresAt: string };
}

export interface AuthConfig {
  /** Email + password (with authenticator-app MFA). */
  passwordLogin: boolean;
  /** Entra External ID sign-in, when configured. */
  oidc: { enabled: boolean; label: string };
  /** The firm's own Microsoft 365 directory, when the firm has set it up. */
  microsoft: { enabled: boolean; label: string; enforced: boolean };
  /** Self-service password reset needs outgoing email. */
  selfServiceReset: boolean;
}

/**
 * The result of a sign-in step. Password sign-in never yields a session
 * directly: it always passes through MFA verification or enrolment.
 */
export type SignInResult =
  | { status: 'signed_in'; user: PublicUser }
  | { status: 'mfa_required'; challengeToken: string }
  | { status: 'mfa_enrollment_required'; challengeToken: string };

export interface MfaEnrollment {
  /** Base32 secret for manual entry. */
  secret: string;
  otpauthUrl: string;
  /** QR code as an SVG data URL. */
  qrCodeDataUrl: string;
}

export interface MfaEnrollmentResult {
  user: PublicUser;
  /** Shown once; each code signs in once if the authenticator is lost. */
  recoveryCodes: string[];
}

export interface SessionInfo {
  id: string;
  method: SignInMethod;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

// ---------------------------------------------------------------- staff

export interface StaffUser extends PublicUser {
  isActive: boolean;
  lockedUntil: string | null;
}

/** Minimal staff entry for pickers (matter members, assignees). */
export interface StaffDirectoryEntry {
  id: string;
  fullName: string;
  role: UserRole;
}

export interface InviteInput {
  email: string;
  fullName: string;
  role: UserRole;
}

export interface Invite {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  createdAt: string;
}

/** Returned once when an invite or reset link is created. */
export interface LinkIssued<T> {
  item: T;
  /** The link to share. Only returned at creation; only its hash is stored. */
  url: string;
  /** Whether the link was also emailed. */
  emailed: boolean;
}

export interface InvitePreview {
  email: string;
  fullName: string;
  role: UserRole;
  firmName: string;
  expiresAt: string;
}

/** Firm settings administrators can change (GET/PATCH /api/firm/settings). */
export interface FirmSettings {
  /** Days a closed matter is kept before the retention sweep removes it. */
  retentionDays: number;
  /** Whether retentionDays is the platform default (not set for this firm). */
  retentionIsDefault: boolean;
  /** Microsoft 365 staff sign-in. */
  microsoft: {
    /** The platform's Microsoft 365 app is configured, so firms can turn this on. */
    available: boolean;
    /** The firm's Entra directory (tenant) id. */
    tenantId: string | null;
    /** Work email domains in that directory. */
    domains: string[];
    /** Staff other than administrators must use Microsoft sign-in. */
    enforced: boolean;
    /** Consent link for the firm's Microsoft 365 administrator. */
    adminConsentUrl: string | null;
  };
}

export interface FirmSettingsUpdate {
  retentionDays?: number | null;
  microsoft?: { tenantId: string | null; domains: string[]; enforced: boolean };
}

export interface UserUpdateInput {
  role?: UserRole;
  isActive?: boolean;
}

// ---------------------------------------------------------------- clients and parties

export type PartyKind = 'individual' | 'entity';

export type MatterPartyRole = 'client' | 'opposing' | 'opposing_attorney' | 'related' | 'witness';

export const MATTER_PARTY_ROLES: readonly MatterPartyRole[] = [
  'client',
  'opposing',
  'opposing_attorney',
  'related',
  'witness',
];

/** Identifying details of a party. Stored encrypted. */
export interface PartyDetails {
  name: string;
  /** SA ID or passport number (individuals). */
  idNumber?: string;
  /** Company / CIPC registration number (entities). */
  registrationNumber?: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
}

export interface PartyInput {
  kind: PartyKind;
  details: PartyDetails;
}

export interface PartySummary {
  id: string;
  partyNumber: string;
  kind: PartyKind;
  name: string;
  isClient: boolean;
  clientSince: string | null;
}

export interface PartyRecord extends PartySummary {
  details: PartyDetails;
  conflictCheckId: string | null;
  /** Matters the party is on that the viewer can see. */
  matters: Array<{
    caseId: string;
    caseNumber: string;
    title: string | null;
    role: MatterPartyRole;
  }>;
  createdAt: string;
}

/** New client: the conflict check that cleared them, and their details. */
export interface ClientInput extends PartyInput {
  conflictCheckId: string;
}

export interface ConflictSubject {
  name: string;
  kind?: PartyKind;
  idNumber?: string;
  registrationNumber?: string;
  email?: string;
  phone?: string;
}

export interface ConflictCheckInput {
  /** Who the check is for: the prospective client and the other parties (1–10). */
  subjects: ConflictSubject[];
  /** Short description of the proposed matter (no personal information). */
  purpose: string;
}

export type ConflictStrength = 'strong' | 'possible';

export interface ConflictMatch {
  /** Index into the check's subjects. */
  subject: number;
  party: PartySummary;
  strength: ConflictStrength;
  /** Which details matched, e.g. ['id_number', 'name']. */
  reasons: string[];
  /** Matters the party is on that the viewer can see. */
  matters: Array<{
    caseId: string;
    caseNumber: string;
    title: string | null;
    role: MatterPartyRole;
  }>;
  /** Matters the party is on that the viewer can't see (restricted or walled). */
  hiddenMatters: number;
}

export type ConflictDecision = 'pending' | 'clear' | 'conflict' | 'waived';

export interface ConflictCheck {
  id: string;
  subjects: ConflictSubject[];
  purpose: string;
  matches: ConflictMatch[];
  strongMatches: number;
  possibleMatches: number;
  decision: ConflictDecision;
  decisionNotes: string | null;
  performedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface ConflictDecisionInput {
  decision: Exclude<ConflictDecision, 'pending'>;
  notes?: string;
}

/** Open a matter for an existing client. */
export interface MatterOpenInput {
  clientId: string;
  conflictCheckId: string;
  title: string;
  practiceArea: string;
  urgency?: 'low' | 'medium' | 'high' | 'critical';
}

export interface MatterPartyInput {
  role: MatterPartyRole;
  /** An existing party, or details for a new one. */
  partyId?: string;
  party?: PartyInput;
  /** A conflict check recording a waiver, when the party is also a client. */
  conflictCheckId?: string;
}

export interface MatterParty {
  role: MatterPartyRole;
  party: PartySummary;
}

// ---------------------------------------------------------------- platform support

export interface SupportGrantInput {
  /** 1 to 72 hours. */
  hours: number;
  /** Why support needs access (e.g. the ticket number). Shown in the audit trail. */
  reason: string;
}

export interface SupportGrant {
  id: string;
  reason: string;
  grantedBy: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
}

export interface SupportSignInInput {
  email: string;
  password: string;
  code: string;
}

// ---------------------------------------------------------------- matter access

export type MatterAccessLevel = 'firm' | 'restricted';

export interface MatterMember {
  userId: string;
  fullName: string;
  role: UserRole;
  memberRole: 'lead' | 'member';
  addedAt: string;
}

export interface MatterExclusion {
  userId: string;
  fullName: string;
  role: UserRole;
  reason: string;
  createdAt: string;
}

export interface MatterAccess {
  caseId: string;
  access: MatterAccessLevel;
  members: MatterMember[];
  exclusions: MatterExclusion[];
  /** Whether the current user may change access, members and walls. */
  canManage: boolean;
}

// ---------------------------------------------------------------- intake

export type Urgency = 'low' | 'medium' | 'high' | 'critical';

export interface IntakeSubmissionInput {
  fullName: string;
  email: string;
  phone: string;
  practiceArea: string;
  jurisdiction?: string;
  matterSummary: string;
  requestedOutcome?: string;
  documentsMentioned?: string;
  urgencyHint?: string;
  preferredLanguage?: string;
  consentToAi: boolean;
  consentToStorage: boolean;
}

export interface Assessment {
  id: string;
  matterType: string;
  urgency: Urgency | string;
  summary: string;
  keyFacts: string[];
  attorneyQuestions: string[];
  recommendedDocuments: string[];
  complianceFlags: string[];
  nextActions: string[];
  confidence: number | null;
  model: string;
  provider: string;
  popiaNotes: string[];
  createdAt: string;
}

export interface MatterCaseSummary {
  id: string;
  /** The intake the matter came from; null when opened for a client directly. */
  submissionId: string | null;
  caseNumber: string;
  status: string;
  urgency: string;
  practiceArea: string;
  nextAction: string | null;
  createdAt: string;
}

export interface RetentionSweepResult {
  retentionDays: number;
  scannedCases: number;
  eligibleCases: number;
  removedSubmissions: number;
  removedCases: number;
}

export interface PublicSubmission {
  id: string;
  clientLabel: string;
  practiceArea: string;
  jurisdiction: string;
  urgencyHint: string;
  status: string;
  summary: string;
  createdAt: string;
  assessment: Assessment | null;
  matterCase: MatterCaseSummary | null;
}

// ---------------------------------------------------------------- errors

export interface ApiErrorBody {
  message: string;
  requestId?: string;
}

// ---------------------------------------------------------------- API response shapes
// These mirror the API's formatters. Until the data layer is typed end to end
// (roadmap epic 3), nullable columns are typed as `string | null`.

type Nullable<T> = T | null;

export interface UpcomingTaskItem {
  id: string;
  type: 'task';
  caseId: string;
  title: string;
  startsAt: string;
  status: string;
  assigneeName: Nullable<string>;
}

export type UpcomingItem = CalendarEvent | UpcomingTaskItem;

export interface IntakeSummary {
  openIntakes: number;
  assessedIntakes: number;
  liveCases: number;
  criticalMatters: number;
  encryptedStorage: boolean;
  popiaCompliantAi: boolean;
  latestIntake: PublicSubmission | null;
}

export interface PracticeDashboard {
  generatedAt: string;
  summary: IntakeSummary;
  caseCount: number;
  criticalCases: number;
  openTasks: number;
  overdueInvoices: number;
  unreadNotifications: number;
  upcomingHearings: number;
  auditEvents: number;
  casesByStatus: Record<string, number>;
  casesByPracticeArea: Record<string, number>;
}

export interface MatterCase {
  id: string;
  title: Nullable<string>;
  /** The intake the matter came from; null when opened for a client directly. */
  submissionId: string | null;
  caseNumber: string;
  clientLabel: string;
  practiceArea: string;
  urgency: string;
  status: string;
  nextAction: Nullable<string>;
  access: MatterAccessLevel;
  createdAt: string;
  updatedAt: Nullable<string>;
}

export interface CaseIndexEntry extends MatterCase {
  taskCount: number;
  openTaskCount: number;
  timelineCount: number;
}

export interface CaseTask {
  id: string;
  caseId: string;
  title: string;
  description: string;
  status: string;
  dueDate: Nullable<string>;
  assigneeName: Nullable<string>;
  createdBy: string;
  createdAt: string;
  completedAt: Nullable<string>;
}

export interface CaseTimelineEntry {
  id: string;
  caseId: string;
  eventType: string;
  message: string;
  metadata: Record<string, unknown>;
  actorName: string;
  createdAt: string;
}

export interface CaseDetail extends MatterCase {
  tasks: CaseTask[];
  timeline: CaseTimelineEntry[];
}

export interface DocumentContent {
  title: string;
  body: string;
  metadata: Record<string, unknown>;
}

export interface DocumentRecord {
  id: string;
  caseId: Nullable<string>;
  caseNumber: Nullable<string>;
  clientLabel: Nullable<string>;
  title: string;
  documentType: string;
  status: string;
  tags: string[];
  contentPreview: string;
  createdBy: Nullable<string>;
  createdAt: string;
  updatedAt: Nullable<string>;
  signedAt: Nullable<string>;
  content: DocumentContent | null;
}

/** Amounts in rand (the API stores cents and converts at the boundary). */
export interface InvoiceLineItem {
  description: string;
  quantity: number;
  rate: number;
}

export interface Invoice {
  id: string;
  caseId: Nullable<string>;
  caseNumber: Nullable<string>;
  clientLabel: Nullable<string>;
  number: string;
  subject: string;
  currency: string;
  status: string;
  lineItems: InvoiceLineItem[];
  subtotal: number;
  vat: number;
  total: number;
  issuedAt: Nullable<string>;
  dueAt: Nullable<string>;
  paidAt: Nullable<string>;
  createdAt: string;
}

export interface LedgerEntry {
  id: string;
  caseId: Nullable<string>;
  caseNumber: Nullable<string>;
  entryType: string;
  account: string;
  amount: number;
  reference: Nullable<string>;
  notes: Nullable<string>;
  createdBy: Nullable<string>;
  createdAt: string;
}

export interface BillingSummary {
  invoices: number;
  outstanding: number;
  trustBalance: number;
  operatingBalance: number;
  recentInvoices: Invoice[];
  recentLedger: LedgerEntry[];
}

export interface CalendarEvent {
  id: string;
  caseId: Nullable<string>;
  caseNumber: Nullable<string>;
  title: string;
  eventType: string;
  startsAt: string;
  endsAt: Nullable<string>;
  location: Nullable<string>;
  notes: Nullable<string>;
  createdBy: Nullable<string>;
  createdAt: string;
}

export interface NotificationRecord {
  id: string;
  title: string;
  body: string;
  category: string;
  priority: string;
  recipientRole: Nullable<string>;
  recipientUserId: Nullable<string>;
  relatedEntityType: Nullable<string>;
  relatedEntityId: Nullable<string>;
  isRead: boolean;
  readAt: Nullable<string>;
  createdAt: string;
}

export interface AuditEventRecord {
  id: string;
  seq: number;
  entityType: string;
  entityId: Nullable<string>;
  action: string;
  summary: string;
  details: Record<string, unknown>;
  actorId: Nullable<string>;
  actorName: string;
  actorRole: string;
  createdAt: string;
  previousHash: string;
  entryHash: string;
}

export type AuditChainResult =
  | { valid: true; count: number }
  | { valid: false; brokenAt: string; action: string; count: number };

/** Checks of the daily anchors (copies of the chain head in immutable storage). */
export interface AuditAnchorCheck {
  checked: number;
  lastAnchoredAt: string | null;
  /** Human-readable problems; empty when every anchor matches. */
  problems: string[];
}

/** GET /api/audit/verify: the hash chain plus its anchors. */
export type AuditTrailVerification = AuditChainResult & {
  anchors: AuditAnchorCheck;
  /** Chain valid and every anchor matches. */
  trustworthy: boolean;
};

export interface ReportSnapshot {
  id: string;
  reportType: string;
  title: string;
  payload: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
}

/** GET /api/compliance/export — a data subject's records (admin only). */
export interface ComplianceExport {
  generatedAt: string;
  retentionDays: number;
  subjectEmail: string | null;
  caseRef: string | null;
  submissions: unknown[];
  assessments: unknown[];
  cases: unknown[];
  documents: DocumentRecord[];
  invoices: Invoice[];
  ledger: LedgerEntry[];
  notices?: string[];
  [key: string]: unknown;
}

export interface ComplianceRequest {
  id: string;
  requestType: string;
  subjectName: Nullable<string>;
  subjectEmail: Nullable<string>;
  caseRef: Nullable<string>;
  description: Nullable<string>;
  status: string;
  responseSummary: Nullable<string>;
  responsePayload: unknown;
  dueAt: Nullable<string>;
  fulfilledAt: Nullable<string>;
  createdBy: Nullable<string>;
  createdAt: string;
  updatedAt: Nullable<string>;
}

export interface ComplianceSummary {
  retentionDays: number;
  totalRequests: number;
  openRequests: number;
  fulfilledRequests: number;
  eligibleForRetention: number;
  latestRequest: ComplianceRequest | null;
}
