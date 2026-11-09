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
  /** Browser tab icon (the logo when no icon is uploaded). */
  iconUrl?: string | null;
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

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a #rgb or #rrggbb colour. */
export function luminance(hex: string): number {
  const full = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(full.slice(at, at + 2), 16));
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}

/** WCAG contrast ratio between two colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** Brand colours carry white text, so they need at least this contrast with white. */
export const MIN_BRAND_CONTRAST = 4.5;

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
  | 'billing.void'
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
  | 'conflicts.waive'
  | 'fica.read'
  | 'fica.write'
  | 'fica.verify'
  | 'time.read'
  | 'time.record'
  | 'time.manage'
  | 'rates.manage';

const FEE_EARNER: readonly Permission[] = [
  'clients.read',
  'clients.write',
  'conflicts.check',
  'fica.read',
  'fica.write',
  'fica.verify',
  'time.read',
  'time.record',
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
    // Corrects or writes off other people's time, and sets hourly rates.
    'time.manage',
    'rates.manage',
    // Voids issued invoices (the number stays used).
    'billing.void',
  ],
  attorney: FEE_EARNER,
  paralegal: FEE_EARNER,
  secretary: [
    'clients.read',
    'clients.write',
    'conflicts.check',
    // Front desk collects FICA documents; a fee earner verifies.
    'fica.read',
    'fica.write',
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
    'fica.read',
    'matters.read',
    // Sees recorded time and work in progress, to bill it.
    'time.read',
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
    'time.read',
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
  /** New matters only for FICA-verified clients. */
  ficaEnforced: boolean;
  /** What invoices and statements show. */
  billing: BillingSettings;
  /** Practice details. */
  profile: FirmProfileSettings;
  /** Name, colours, logo and numbering. */
  brand: FirmBrandSettings;
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

export interface BillingSettings {
  vatRegistered: boolean;
  vatNumber: string | null;
  paymentTermsDays: number;
  address: string;
  bankDetails: string;
  invoiceFooter: string;
  /** Letters before invoice numbers, e.g. INV. */
  invoicePrefix: string;
}

export interface FirmProfileSettings {
  registrationNumber: string;
  lpcNumber: string;
  fidelityFundCertificate: string;
  email: string;
  phone: string;
  website: string;
  replyToEmail: string;
}

export interface FirmBrandSettings {
  legalName: string;
  tradingName: string;
  primaryColor: string;
  accentColor: string;
  casePrefix: string;
  logoUrl: string | null;
  iconUrl: string | null;
}

export type FirmBrandUpdate = Partial<
  Pick<
    FirmBrandSettings,
    'legalName' | 'tradingName' | 'primaryColor' | 'accentColor' | 'casePrefix'
  >
>;

export interface FirmSettingsUpdate {
  retentionDays?: number | null;
  ficaEnforced?: boolean;
  billing?: Partial<BillingSettings>;
  profile?: Partial<FirmProfileSettings>;
  brand?: FirmBrandUpdate;
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
  /** FICA status (clients). */
  ficaStatus?: FicaStatus;
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

// ---------------------------------------------------------------- FICA

export type FicaRiskRating = 'low' | 'medium' | 'high';

/** Risk factors considered in the firm's risk-based approach (FIC Act, RMCP). */
export interface FicaRiskFactors {
  /** Domestic or foreign prominent influential person, or their family / close associate. */
  politicallyExposed?: boolean;
  /** Linked to a high-risk or sanctioned jurisdiction. */
  highRiskJurisdiction?: boolean;
  /** Not met face to face. */
  nonFaceToFace?: boolean;
  /** Cash-intensive business, or large cash in the matter. */
  cashIntensive?: boolean;
  /** Complex ownership (trusts, layered companies) or unclear beneficial ownership. */
  complexStructure?: boolean;
}

export const FICA_DOCUMENT_TYPES = [
  'id_document',
  'proof_of_address',
  'company_registration',
  'directors_ids',
  'beneficial_ownership',
  'source_of_funds',
  'other',
] as const;

export type FicaDocumentType = (typeof FICA_DOCUMENT_TYPES)[number];

export const FICA_DOCUMENT_LABELS: Readonly<Record<FicaDocumentType, string>> = {
  id_document: 'ID document or passport',
  proof_of_address: 'Proof of address (≤ 3 months)',
  company_registration: 'Company registration (CIPC)',
  directors_ids: "Directors' / members' IDs",
  beneficial_ownership: 'Beneficial ownership declaration',
  source_of_funds: 'Source of funds / wealth',
  other: 'Other',
};

/** Effective status: 'review_due' once the review date has passed. */
export type FicaStatus = 'not_started' | 'in_progress' | 'verified' | 'review_due';

export interface FicaDocument {
  id: string;
  docType: FicaDocumentType;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  createdAt: string;
}

export interface FicaProfile {
  partyId: string;
  status: FicaStatus;
  riskRating: FicaRiskRating;
  riskFactors: FicaRiskFactors;
  notes: string | null;
  documents: FicaDocument[];
  /** Document types still needed for verification. */
  missing: FicaDocumentType[];
  verifiedBy: string | null;
  verifiedAt: string | null;
  reviewDue: string | null;
}

export interface FicaRiskInput {
  riskFactors: FicaRiskFactors;
  /** Raise the rating above what the factors give (never lower it). */
  riskRating?: FicaRiskRating;
  notes?: string;
}

export interface FicaDocumentUpload {
  docType: FicaDocumentType;
  fileName: string;
  contentType: string;
  /** File contents, base64 (max 10 MB). */
  dataBase64: string;
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
  /** Court division code (COURT_DIVISIONS), once the matter is in court. */
  courtDivision?: Nullable<string>;
  /** The court's case number, e.g. 12345/2025 or 2025-012345. */
  courtCaseNumber?: Nullable<string>;
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

export const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export interface InvoiceLine {
  kind: 'fee' | 'disbursement' | 'other';
  description: string;
  /** Hours for fees; a count otherwise. */
  quantity: number;
  /** Rand per hour or per item. */
  unitPrice: number;
  amount: number;
  vatable: boolean;
  workDate: Nullable<string>;
  feeEarner: Nullable<string>;
  timeEntryId: Nullable<string>;
  disbursementId: Nullable<string>;
}

export const PAYMENT_METHODS = ['eft', 'card', 'cash', 'trust_transfer', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface InvoicePayment {
  id: string;
  amount: number;
  receivedOn: string;
  method: PaymentMethod;
  reference: string;
  createdAt: string;
}

export interface Invoice {
  id: string;
  caseId: Nullable<string>;
  caseNumber: Nullable<string>;
  clientLabel: Nullable<string>;
  clientPartyId: Nullable<string>;
  /** Given when issued; null for drafts. */
  number: Nullable<string>;
  subject: string;
  notes: string;
  currency: string;
  status: InvoiceStatus | string;
  lines: InvoiceLine[];
  /** Same lines, in the pre-epic-7 shape. */
  lineItems: InvoiceLineItem[];
  subtotal: number;
  vat: number;
  /** e.g. 0.15 */
  vatRate: number;
  total: number;
  paid: number;
  balance: number;
  payments: InvoicePayment[];
  issuedAt: Nullable<string>;
  dueAt: Nullable<string>;
  paidAt: Nullable<string>;
  sentAt: Nullable<string>;
  voidedAt: Nullable<string>;
  createdAt: string;
}

export interface InvoiceManualLine {
  description: string;
  quantity?: number;
  /** Rand per item. */
  rate: number;
  vatable?: boolean;
}

/** A draft invoice for one matter: its unbilled time and disbursements, plus any manual lines. */
export interface InvoiceDraftInput {
  caseRef: string;
  subject: string;
  notes?: string;
  /** Time to bill: 'all' (default) unbilled billable time on the matter, or ids. */
  timeEntryIds?: 'all' | string[];
  /** Disbursements to bill: 'all' (default) or ids. */
  disbursementIds?: 'all' | string[];
  lines?: InvoiceManualLine[];
}

export interface InvoiceDraftUpdate {
  subject?: string;
  notes?: string;
  /** Replaces the manual lines (time and disbursement lines stay). */
  lines?: InvoiceManualLine[];
}

export interface PaymentInput {
  amount: number | string;
  /** YYYY-MM-DD, defaults to today. */
  receivedOn?: string;
  method: PaymentMethod;
  reference?: string;
}

export interface Disbursement {
  id: string;
  caseId: string;
  caseNumber: string;
  incurredOn: string;
  description: string;
  /** Excluding VAT. */
  amount: number;
  vatable: boolean;
  status: 'unbilled' | 'billed' | 'written_off';
  invoiceId: Nullable<string>;
  createdAt: string;
}

export interface DisbursementInput {
  caseRef: string;
  incurredOn?: string;
  description: string;
  amount: number | string;
  vatable?: boolean;
}

export interface StatementLine {
  date: string;
  kind: 'invoice' | 'payment';
  reference: string;
  caseNumber: string;
  debit: number;
  credit: number;
  balance: number;
}

/** A client's account: issued invoices and payments, with a running balance. */
export interface ClientStatement {
  partyId: string;
  partyNumber: string;
  clientName: string;
  from: Nullable<string>;
  to: string;
  openingBalance: number;
  lines: StatementLine[];
  closingBalance: number;
  aging: AgingBuckets;
}

export interface AgingBuckets {
  current: number;
  days30: number;
  days60: number;
  days90: number;
  days120: number;
  total: number;
}

export interface AgingRow extends AgingBuckets {
  clientPartyId: Nullable<string>;
  clientLabel: string;
  invoices: number;
}

/** Outstanding issued invoices by days past due. */
export interface AgingReport {
  asOf: string;
  totals: AgingBuckets;
  clients: AgingRow[];
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
  /** Issued invoices past their due date (rand outstanding). */
  overdue: number;
  drafts: number;
  /** Unbilled billable time (rand). */
  wip: number;
  /** Unbilled disbursements (rand, excluding VAT). */
  unbilledDisbursements: number;
  trustBalance: number;
  operatingBalance: number;
  recentInvoices: Invoice[];
  recentLedger: LedgerEntry[];
}

export const CALENDAR_EVENT_TYPES = [
  'court_date',
  'deadline',
  'prescription',
  'meeting',
  'consultation',
  'other',
] as const;
export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];

export const CALENDAR_EVENT_LABELS: Readonly<Record<CalendarEventType, string>> = {
  court_date: 'Court date',
  deadline: 'Deadline',
  prescription: 'Prescription',
  meeting: 'Meeting',
  consultation: 'Consultation',
  other: 'Other',
};

export type CalendarEventStatus = 'scheduled' | 'done' | 'cancelled';
/** Where an event came from: entered by staff, a prescription, or a court roll. */
export type CalendarEventSource = 'manual' | 'prescription' | 'court_roll';

export interface CalendarEvent {
  id: string;
  caseId: Nullable<string>;
  caseNumber: Nullable<string>;
  title: string;
  eventType: CalendarEventType | string;
  startsAt: string;
  endsAt: Nullable<string>;
  allDay?: boolean;
  location: Nullable<string>;
  notes: Nullable<string>;
  status?: CalendarEventStatus;
  source?: CalendarEventSource;
  assigneeUserId?: Nullable<string>;
  assigneeName?: Nullable<string>;
  /** Minutes before the start when reminders go out. */
  reminderOffsets?: number[];
  createdBy: Nullable<string>;
  createdAt: string;
}

export interface CalendarEventInput {
  caseId: string;
  title: string;
  eventType?: CalendarEventType;
  startsAt: string;
  endsAt?: string | null;
  allDay?: boolean;
  location?: string;
  notes?: string;
  assigneeUserId?: string | null;
  reminderOffsets?: number[];
}

export type CalendarEventUpdate = Partial<Omit<CalendarEventInput, 'caseId'>> & {
  status?: CalendarEventStatus;
};

/** Default reminders (minutes before) by event type. */
export const DEFAULT_REMINDERS: Readonly<Record<CalendarEventType, number[]>> = {
  court_date: [7 * 1440, 1440],
  deadline: [3 * 1440, 1440],
  prescription: [90 * 1440, 30 * 1440, 7 * 1440, 1440],
  meeting: [60],
  consultation: [60],
  other: [1440],
};

// ---------------------------------------------------------------- courts and prescription

/** High Court divisions (SAFLII codes), the Labour Court, and lower courts. */
export const COURT_DIVISIONS = [
  { code: 'ZAGPPHC', name: 'Gauteng Division, Pretoria' },
  { code: 'ZAGPJHC', name: 'Gauteng Local Division, Johannesburg' },
  { code: 'ZAWCHC', name: 'Western Cape Division, Cape Town' },
  { code: 'ZAKZDHC', name: 'KwaZulu-Natal Local Division, Durban' },
  { code: 'ZAKZPHC', name: 'KwaZulu-Natal Division, Pietermaritzburg' },
  { code: 'ZAECGHC', name: 'Eastern Cape Division, Makhanda' },
  { code: 'ZAFSHC', name: 'Free State Division, Bloemfontein' },
  { code: 'ZANCHC', name: 'Northern Cape Division, Kimberley' },
  { code: 'ZANWHC', name: 'North West Division, Mahikeng' },
  { code: 'ZALMPPHC', name: 'Limpopo Division, Polokwane' },
  { code: 'ZAMPMBHC', name: 'Mpumalanga Division, Mbombela' },
  { code: 'ZALCJHB', name: 'Labour Court, Johannesburg' },
  { code: 'MAGISTRATE', name: "Magistrate's court" },
  { code: 'OTHER', name: 'Other court or tribunal' },
] as const;
export type CourtDivisionCode = (typeof COURT_DIVISIONS)[number]['code'];

/**
 * Common limitation periods. The attorney confirms the period and the date it
 * started to run; delays (minority, curatorship, s13 of the Prescription Act)
 * and interruptions are entered by changing the dates.
 */
export const PRESCRIPTION_RULES = [
  {
    code: 'general_3y',
    label: 'Ordinary debt: 3 years',
    source: 'Prescription Act 68 of 1969, s11(d)',
    months: 36,
  },
  {
    code: 'bill_notarial_6y',
    label: 'Bill of exchange or notarial contract: 6 years',
    source: 'Prescription Act 68 of 1969, s11(c)',
    months: 72,
  },
  {
    code: 'state_15y',
    label: 'Certain debts owed to the State: 15 years',
    source: 'Prescription Act 68 of 1969, s11(b)',
    months: 180,
  },
  {
    code: 'bond_judgment_30y',
    label: 'Mortgage bond or judgment debt: 30 years',
    source: 'Prescription Act 68 of 1969, s11(a)',
    months: 360,
  },
  {
    code: 'organ_of_state_notice',
    label: 'Notice to an organ of state: 6 months',
    source: 'Act 40 of 2002, s3(2)(a)',
    months: 6,
  },
  {
    code: 'raf_identified',
    label: 'RAF claim, driver or owner identified: 3 years',
    source: 'Road Accident Fund Act 56 of 1996, s23(1)',
    months: 36,
  },
  {
    code: 'raf_unidentified',
    label: 'RAF claim, hit-and-run: 2 years',
    source: 'RAF regulations, reg 2(1)',
    months: 24,
  },
  { code: 'custom', label: 'Other period (enter the last day)', source: '', months: 0 },
] as const;
export type PrescriptionRuleCode = (typeof PRESCRIPTION_RULES)[number]['code'];

export type PrescriptionStatus = 'running' | 'interrupted' | 'closed';

export interface Prescription {
  id: string;
  caseId: string;
  caseNumber: string;
  rule: PrescriptionRuleCode;
  /** YYYY-MM-DD the period started to run (debt due, accident, etc.). */
  startsOn: string;
  /** YYYY-MM-DD: the last day to act. */
  lastDay: string;
  status: PrescriptionStatus;
  /** Running and the last day has passed. */
  lapsed: boolean;
  daysLeft: number;
  notes: string;
  eventId: Nullable<string>;
  createdAt: string;
}

export interface PrescriptionInput {
  caseRef: string;
  rule: PrescriptionRuleCode;
  startsOn: string;
  /** Required for 'custom'; otherwise computed. */
  lastDay?: string;
  notes?: string;
  assigneeUserId?: string | null;
}

export interface PrescriptionUpdate {
  status?: PrescriptionStatus;
  startsOn?: string;
  lastDay?: string;
  notes?: string;
}

export interface MatterCourtInput {
  courtDivision: CourtDivisionCode | null;
  courtCaseNumber: string | null;
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

// ---------------------------------------------------------------- time recording

/** Minutes in one billing unit: time is recorded in tenths of an hour. */
export const MINUTES_PER_UNIT = 6;

/** Most time one entry (or one person's day) can hold: 24 hours. */
export const MAX_UNITS_PER_DAY = 240;

export const TIME_ACTIVITIES = [
  'consultation',
  'drafting',
  'correspondence',
  'calls',
  'research',
  'court',
  'travel',
  'admin',
  'other',
] as const;
export type TimeActivity = (typeof TIME_ACTIVITIES)[number];

export const TIME_ACTIVITY_LABELS: Readonly<Record<TimeActivity, string>> = {
  consultation: 'Consultation',
  drafting: 'Drafting',
  correspondence: 'Correspondence',
  calls: 'Telephone calls',
  research: 'Research',
  court: 'Court attendance',
  travel: 'Travel',
  admin: 'Administration',
  other: 'Other',
};

export type TimeEntryStatus = 'unbilled' | 'billed' | 'written_off';

export interface TimeEntry {
  id: string;
  caseId: string;
  caseNumber: string;
  userId: string;
  feeEarnerName: string;
  /** YYYY-MM-DD */
  workDate: string;
  /** 6-minute units. */
  units: number;
  minutes: number;
  billable: boolean;
  /** Hourly rate in rands, fixed when the time was recorded. */
  rate: number;
  /** Value in rands (0 for non-billable time). */
  amount: number;
  activity: TimeActivity;
  description: string;
  source: 'manual' | 'timer';
  status: TimeEntryStatus;
  invoiceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TimeEntryInput {
  /** Matter id or number. */
  caseRef: string;
  /** Defaults to the signed-in fee earner (another person needs time.manage). */
  userId?: string;
  /** YYYY-MM-DD, defaults to today; not in the future. */
  workDate?: string;
  /** Give minutes (rounded up to whole 6-minute units) or units. */
  minutes?: number;
  units?: number;
  billable?: boolean;
  activity?: TimeActivity;
  description: string;
}

export type TimeEntryUpdate = Partial<Omit<TimeEntryInput, 'caseRef' | 'userId'>>;

export interface TimerState {
  caseId: string;
  caseNumber: string;
  activity: TimeActivity;
  billable: boolean;
  description: string;
  running: boolean;
  /** Seconds recorded so far, as of the response. */
  elapsedSeconds: number;
  /** Units the time would be recorded as if stopped now. */
  units: number;
}

export interface TimerStartInput {
  caseRef: string;
  activity?: TimeActivity;
  billable?: boolean;
  description?: string;
}

export interface TimerStopInput {
  activity?: TimeActivity;
  billable?: boolean;
  description?: string;
  workDate?: string;
}

export interface StaffRate {
  userId: string;
  fullName: string;
  role: UserRole;
  /** Rands per hour; null when not set. */
  hourlyRate: number | null;
}

export interface MatterRate {
  /** Null: the rate for everyone on the matter. */
  userId: string | null;
  fullName: string | null;
  hourlyRate: number;
}

export interface WipMatter {
  caseId: string;
  caseNumber: string;
  title: string | null;
  units: number;
  value: number;
  entries: number;
  oldestWorkDate: string;
}

export interface WipFeeEarner {
  userId: string;
  fullName: string;
  units: number;
  value: number;
}

/** Unbilled billable time on the matters the caller can see. */
export interface WipSummary {
  units: number;
  value: number;
  matters: WipMatter[];
  feeEarners: WipFeeEarner[];
}

// ---------------------------------------------------------------- court rolls

export type CourtRollMatchStatus = 'new' | 'accepted' | 'dismissed' | 'removed';

/** A matter found on a court roll, for staff to put on the calendar or dismiss. */
export interface CourtRollMatch {
  id: string;
  caseId: string;
  caseNumber: string;
  courtCaseNumber: string | null;
  origin: 'sync' | 'upload';
  /** The roll's URL (synced rolls only). */
  documentUrl: string | null;
  documentTitle: string;
  division: string;
  hearingDate: string | null;
  hearingTime: string | null;
  courtroom: string | null;
  judge: string | null;
  section: string | null;
  status: CourtRollMatchStatus;
  /** A scheduled court date on that day is already on the matter's calendar. */
  onCalendar: boolean;
  eventId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CourtRollAcceptInput {
  /** Needed when the roll gave no date (ISO, with offset). */
  startsAt?: string;
  assigneeUserId?: string | null;
}

export interface CourtRollUploadInput {
  division: string;
  title?: string;
  fileName: string;
  contentType: string;
  contentBase64: string;
}

export interface CourtRollUploadResult {
  hearings: number;
  matches: CourtRollMatch[];
}

// ---------------------------------------------------------------- white label and onboarding

export type FirmAssetKind = 'logo' | 'icon';

export interface FirmAssetUpload {
  contentType: string;
  contentBase64: string;
}

export type FirmDomainStatus = 'pending_dns' | 'pending_routing' | 'active';

export interface FirmDomain {
  id: string;
  domain: string;
  status: FirmDomainStatus;
  /** The DNS TXT record that proves the firm owns the domain. */
  txtRecordName: string;
  txtRecordValue: string;
  /** Where the domain's CNAME should point. */
  cnameTarget: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  activatedAt: string | null;
  createdAt: string;
}

export const ONBOARDING_STEPS = ['profile', 'brand', 'billing', 'practice', 'team'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_LABELS: Readonly<Record<OnboardingStep, string>> = {
  profile: 'Practice details',
  brand: 'Name, logo and colours',
  billing: 'Invoicing and VAT',
  practice: 'Numbering and compliance',
  team: 'Invite your team',
};

export interface OnboardingStatus {
  steps: Array<{ id: OnboardingStep; label: string; done: boolean }>;
  complete: boolean;
  completedAt: string | null;
}
