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
