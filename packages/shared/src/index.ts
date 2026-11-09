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

export type UserRole = 'admin' | 'attorney' | 'paralegal';

export const STAFF_ROLES: readonly UserRole[] = ['admin', 'attorney', 'paralegal'];

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuthConfig {
  publicRegistration: boolean;
  seedAdminOnStartup: boolean;
}

export interface AuthResult {
  user: PublicUser;
  token: string;
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
  submissionId: string;
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
  submissionId: string;
  caseNumber: string;
  clientLabel: string;
  practiceArea: string;
  urgency: string;
  status: string;
  nextAction: Nullable<string>;
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
