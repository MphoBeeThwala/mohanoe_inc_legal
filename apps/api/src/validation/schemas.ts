// Request validation. Every endpoint that accepts input parses it with one of
// these schemas (see parse() below); services receive the typed result.
//
// The web app posts HTML form values, so numbers may arrive as strings and
// optional fields as ''. `optionalText` and `money` absorb that.

import { z } from 'zod';
import { httpError } from '../lib/http';
import { MAX_UNITS_PER_DAY, MINUTES_PER_UNIT, TIME_ACTIVITIES } from '@ahava88/shared';

const MAX_TEXT = 20_000;

const requiredText = (max = 500) => z.string().trim().min(1).max(max);

/** Optional text: '' and whitespace become undefined. */
const optionalText = (max = 2_000) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().max(max).optional(),
  );

/** Optional ISO date/time string ('' → undefined). */
const optionalDateTime = z.preprocess(
  (value) => (value === '' || value === null ? undefined : value),
  z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), 'must be a valid date')
    .optional(),
);

/** Rand amount: accepts 1500, "1500", "1 500.50"; at most two decimals. */
const money = z.preprocess(
  (value) => (typeof value === 'string' ? Number(value.replace(/[\s,]/g, '')) : value),
  z
    .number()
    .finite()
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, {
      message: 'must have at most two decimal places',
    }),
);

export const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

// ---------------------------------------------------------------- auth

export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters long')
  .max(200)
  .refine(
    (value) => /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value),
    'Password must include upper-case, lower-case, and a number',
  );

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(200),
});

const challengeToken = z.string().min(20).max(4_000);

export const challengeSchema = z.object({ challengeToken });

/** A 6-digit authenticator code, or a recovery code (xxxxx-xxxxx). */
export const mfaVerifySchema = z.object({
  challengeToken,
  code: z.string().trim().min(6).max(20),
});

export const mfaConfirmSchema = z.object({
  challengeToken,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({ password: passwordSchema });

const staffRole = z.enum(['admin', 'attorney', 'paralegal', 'secretary', 'bookkeeper']);

export const inviteSchema = z.object({
  email,
  fullName: requiredText(200),
  role: staffRole,
});

export const acceptInviteSchema = z.object({
  fullName: optionalText(200),
  password: passwordSchema,
});

export const userUpdateSchema = z
  .object({
    role: staffRole.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => value.role !== undefined || value.isActive !== undefined, {
    message: 'Nothing to update',
  });

export const uuidSchema = z.string().uuid();

// ---------------------------------------------------------------- matter access

export const matterAccessSchema = z.object({ access: z.enum(['firm', 'restricted']) });

export const matterMemberSchema = z.object({
  userId: z.string().uuid(),
  memberRole: z.enum(['lead', 'member']).default('member'),
});

export const matterExclusionSchema = z.object({
  userId: z.string().uuid(),
  reason: requiredText(500),
});

// ---------------------------------------------------------------- intake

export const intakeSubmissionSchema = z.object({
  fullName: requiredText(200),
  email,
  phone: requiredText(40),
  practiceArea: requiredText(100),
  jurisdiction: optionalText(200).transform((value) => value ?? 'South Africa'),
  matterSummary: requiredText(MAX_TEXT),
  requestedOutcome: optionalText(MAX_TEXT).transform((value) => value ?? ''),
  documentsMentioned: optionalText(MAX_TEXT).transform((value) => value ?? ''),
  urgencyHint: optionalText(40).transform((value) => value ?? 'unspecified'),
  preferredLanguage: optionalText(40).transform((value) => value ?? 'English'),
  consentToAi: z.literal(
    true,
    'Consent for storage and AI assessment is required before submission',
  ),
  consentToStorage: z.literal(
    true,
    'Consent for storage and AI assessment is required before submission',
  ),
});
export type IntakeSubmission = z.infer<typeof intakeSubmissionSchema>;

// ---------------------------------------------------------------- cases

export const caseTaskSchema = z.object({
  title: requiredText(300),
  description: optionalText(MAX_TEXT).transform((value) => value ?? ''),
  dueDate: z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    z.iso.date().optional(),
  ),
  assigneeName: optionalText(200),
});
export type CaseTaskInput = z.infer<typeof caseTaskSchema>;

export const caseStatusSchema = z.object({
  status: requiredText(60),
  nextAction: optionalText(1_000),
});
export type CaseStatusInput = z.infer<typeof caseStatusSchema>;

export const timelineNoteSchema = z.object({
  eventType: optionalText(60).transform((value) => value ?? 'note'),
  message: requiredText(MAX_TEXT),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});
export type TimelineNoteInput = z.infer<typeof timelineNoteSchema>;

// ---------------------------------------------------------------- documents

export const documentSchema = z
  .object({
    title: requiredText(300),
    body: requiredText(200_000),
    documentType: optionalText(60).transform((value) => value ?? 'correspondence'),
    tags: z.array(z.string().trim().min(1).max(60)).max(30).optional().default([]),
    status: optionalText(40).transform((value) => value ?? 'draft'),
    metadata: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .and(z.object({ caseId: optionalText(100), caseRef: optionalText(100) }))
  .transform(({ caseId, caseRef, ...rest }) => ({ ...rest, caseRef: caseId || caseRef || '' }));
export type DocumentInput = z.infer<typeof documentSchema>;

// ---------------------------------------------------------------- billing

const lineItemSchema = z
  .object({
    description: optionalText(500),
    quantity: z.preprocess(
      (value) => (value === '' || value === undefined ? 1 : Number(value)),
      z.number().positive().max(100_000),
    ),
    rate: money.optional(),
    amount: money.optional(),
  })
  .transform((item) => ({
    description: item.description ?? '',
    quantity: item.quantity,
    rate: item.rate ?? item.amount ?? 0,
  }))
  .refine((item) => item.rate > 0, { message: 'each line item needs a positive rate or amount' });

export const invoiceSchema = z
  .object({
    subject: requiredText(300),
    invoiceNumber: optionalText(60),
    currency: optionalText(3).transform((value) => (value ?? 'ZAR').toUpperCase()),
    status: optionalText(40).transform((value) => value ?? 'issued'),
    lineItems: z.array(lineItemSchema).min(1).max(200),
    vatIncluded: z.boolean().optional(),
    issuedAt: optionalDateTime,
    dueAt: optionalDateTime,
    paidAt: optionalDateTime,
  })
  .and(z.object({ caseId: optionalText(100), caseRef: optionalText(100) }))
  .transform(({ caseId, caseRef, ...rest }) => ({ ...rest, caseRef: caseId || caseRef || '' }));
export type InvoiceInput = z.infer<typeof invoiceSchema>;

export const ledgerEntrySchema = z
  .object({
    entryType: optionalText(60).transform((value) => value ?? 'payment'),
    account: z.enum(['trust', 'operating']).default('trust'),
    amount: money.refine((value) => value !== 0, 'amount must not be zero'),
    reference: optionalText(200).transform((value) => value ?? ''),
    notes: optionalText(2_000).transform((value) => value ?? ''),
  })
  .and(z.object({ caseId: optionalText(100), caseRef: optionalText(100) }))
  .transform(({ caseId, caseRef, ...rest }) => ({ ...rest, caseRef: caseId || caseRef || '' }));
export type LedgerEntryInput = z.infer<typeof ledgerEntrySchema>;

// ---------------------------------------------------------------- calendar

export const calendarEventSchema = z.object({
  caseId: requiredText(100),
  title: requiredText(300),
  eventType: optionalText(60).transform((value) => value ?? 'deadline'),
  startsAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'must be a valid date'),
  endsAt: optionalDateTime,
  location: optionalText(300).transform((value) => value ?? ''),
  notes: optionalText(2_000).transform((value) => value ?? ''),
});
export type CalendarEventInput = z.infer<typeof calendarEventSchema>;

// ---------------------------------------------------------------- notifications

export const notificationSchema = z.object({
  title: requiredText(300),
  body: requiredText(5_000),
  category: optionalText(60).transform((value) => value ?? 'general'),
  priority: optionalText(20).transform((value) => value ?? 'medium'),
  recipientRole: optionalText(40).transform((value) => value ?? 'attorney'),
  recipientUserId: z.preprocess((value) => (value === '' ? undefined : value), z.uuid().optional()),
  relatedEntityType: optionalText(60),
  relatedEntityId: optionalText(100),
});
export type NotificationInput = z.infer<typeof notificationSchema>;

export const notificationFilterSchema = z.object({
  recipientRole: optionalText(40),
  isRead: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
});

// ---------------------------------------------------------------- reports

export const reportSchema = z.object({
  title: optionalText(300).transform((value) => value ?? 'Operational snapshot'),
  reportType: optionalText(60).transform((value) => value ?? 'dashboard'),
});

// ---------------------------------------------------------------- compliance

export const complianceRequestSchema = z.object({
  requestType: z
    .enum(['access', 'correction', 'deletion', 'export', 'objection'])
    .default('access'),
  subjectName: requiredText(200),
  subjectEmail: email,
  caseRef: optionalText(100),
  description: requiredText(5_000),
  dueAt: optionalDateTime,
});
export type ComplianceRequestInput = z.infer<typeof complianceRequestSchema>;

export const complianceFulfilSchema = z.object({
  status: optionalText(40).transform((value) => value ?? 'fulfilled'),
  responseSummary: optionalText(5_000),
  responsePayload: z.unknown().optional(),
});
export type ComplianceFulfilInput = z.infer<typeof complianceFulfilSchema>;

export const complianceFilterSchema = z.object({
  status: optionalText(40),
  requestType: optionalText(40),
});

export const dataExportQuerySchema = z
  .object({
    subjectEmail: z.preprocess((value) => (value === '' ? undefined : value), email.optional()),
    caseRef: optionalText(100),
  })
  .refine((value) => value.subjectEmail || value.caseRef, {
    message: 'subjectEmail or caseRef is required',
  });
export type DataExportQuery = z.infer<typeof dataExportQuerySchema>;

export const auditFilterSchema = z.object({
  entityType: optionalText(60),
  entityId: optionalText(100),
});

// ---------------------------------------------------------------- helper

/**
 * Parses untrusted input or throws a 400 HttpError listing the problems,
 * e.g. "Invalid request: email: Invalid email address; password: Required".
 */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input ?? {});
  if (result.success) {
    return result.data;
  }
  const problems = result.error.issues.map((issue) => {
    const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
    return `${where}${issue.message}`;
  });
  throw httpError(`Invalid request: ${problems.join('; ')}`, 400);
}

// ---------------------------------------------------------------- clients and parties

const partyKind = z.enum(['individual', 'entity']);

export const partyDetailsSchema = z.object({
  name: requiredText(300),
  idNumber: optionalText(40),
  registrationNumber: optionalText(40),
  email: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    email.optional(),
  ),
  phone: optionalText(40),
  address: optionalText(1_000),
  notes: optionalText(2_000),
});

export const partyInputSchema = z.object({
  kind: partyKind,
  details: partyDetailsSchema,
});

export const partyUpdateSchema = z.object({ details: partyDetailsSchema });

export const clientInputSchema = partyInputSchema.extend({ conflictCheckId: uuidSchema });

export const conflictCheckSchema = z.object({
  subjects: z
    .array(
      z.object({
        name: requiredText(300),
        kind: partyKind.optional(),
        idNumber: optionalText(40),
        registrationNumber: optionalText(40),
        email: z.preprocess(
          (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
          email.optional(),
        ),
        phone: optionalText(40),
      }),
    )
    .min(1)
    .max(10),
  purpose: requiredText(300),
});

export const conflictDecisionSchema = z.object({
  decision: z.enum(['clear', 'conflict', 'waived']),
  notes: optionalText(2_000),
});

export const matterOpenSchema = z.object({
  clientId: uuidSchema,
  conflictCheckId: uuidSchema,
  title: requiredText(200),
  practiceArea: requiredText(100),
  urgency: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
});

const matterPartyRole = z.enum(['client', 'opposing', 'opposing_attorney', 'related', 'witness']);

export const matterPartySchema = z
  .object({
    role: matterPartyRole,
    partyId: uuidSchema.optional(),
    party: partyInputSchema.optional(),
    conflictCheckId: uuidSchema.optional(),
  })
  .refine((value) => Boolean(value.partyId) !== Boolean(value.party), {
    message: 'Give either partyId or party details',
  });

// ---------------------------------------------------------------- time recording

const timeActivity = z.enum(TIME_ACTIVITIES);

/** A calendar date, YYYY-MM-DD, that exists. */
const calendarDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, 'must be a real date');

const optionalCount = (max: number) =>
  z.preprocess(
    (value) =>
      value === '' || value === null
        ? undefined
        : typeof value === 'string'
          ? Number(value)
          : value,
    z.number().int().min(1).max(max).optional(),
  );

const timeAmount = {
  minutes: optionalCount(MAX_UNITS_PER_DAY * MINUTES_PER_UNIT),
  units: optionalCount(MAX_UNITS_PER_DAY),
};

const onlyOneAmount = (value: { minutes?: number; units?: number }) =>
  value.minutes === undefined || value.units === undefined;

export const timeEntrySchema = z
  .object({
    caseRef: requiredText(120),
    userId: z.string().uuid().optional(),
    workDate: calendarDate.optional(),
    ...timeAmount,
    billable: z.boolean().default(true),
    activity: timeActivity.default('other'),
    description: requiredText(2_000),
  })
  .refine(onlyOneAmount, { message: 'give minutes or units, not both' })
  .refine((value) => value.minutes !== undefined || value.units !== undefined, {
    message: 'give the time spent (minutes or units)',
  });

export const timeEntryUpdateSchema = z
  .object({
    workDate: calendarDate.optional(),
    ...timeAmount,
    billable: z.boolean().optional(),
    activity: timeActivity.optional(),
    description: requiredText(2_000).optional(),
  })
  .refine(onlyOneAmount, { message: 'give minutes or units, not both' });

export const timerStartSchema = z.object({
  caseRef: requiredText(120),
  activity: timeActivity.default('other'),
  billable: z.boolean().default(true),
  description: optionalText(2_000),
});

export const timerStopSchema = z.object({
  activity: timeActivity.optional(),
  billable: z.boolean().optional(),
  description: optionalText(2_000),
  workDate: calendarDate.optional(),
});

const hourlyRate = z.union([
  z.null(),
  z.preprocess(
    (value) => (typeof value === 'string' ? Number(value.replace(/[\s,]/g, '')) : value),
    z
      .number()
      .finite()
      .positive('must be more than zero')
      .max(1_000_000)
      .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, {
        message: 'must have at most two decimal places',
      }),
  ),
]);

export const staffRateSchema = z.object({ hourlyRate: hourlyRate });

export const matterRateSchema = z.object({
  userId: z.string().uuid().nullable().default(null),
  hourlyRate: hourlyRate,
});
