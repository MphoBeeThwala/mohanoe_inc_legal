// POPIA data-subject requests, subject data export, and retention.

import { and, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type {
  CalendarEvent,
  ComplianceExport,
  ComplianceRequest,
  ComplianceSummary,
  DocumentRecord,
  Invoice,
  LedgerEntry,
  MatterCaseSummary,
  RetentionSweepResult,
} from '@ahava88/shared';
import { db } from '../db/client';
import {
  calendarEvents,
  cases,
  partyIndex,
  complianceRequests,
  documents,
  invoices,
  ledgerEntries,
  type AssessmentRow,
  type CaseRow,
  type ComplianceRequestRow,
} from '../db/schema';
import { httpError } from '../lib/http';
import { actorName, type Actor } from '../lib/actor';
import { fromCents } from '../lib/money';
import { iso, isoOrNull, toDateOrNull } from '../lib/time';
import {
  complianceFulfilSchema,
  complianceRequestSchema,
  dataExportQuerySchema,
  parse,
} from '../validation/schemas';
import { ensureStringArray } from './ai.service';
import * as intakeService from './intake.service';
import * as notificationsService from './notifications.service';
import * as auditService from './audit.service';
import * as partyService from './party.service';
import { indexEntries } from './party-index';
import type { PartyRecord } from '@ahava88/shared';
import { currentFirm } from '../db/tenant-context';

/** Statuses that mean a matter is finished and its retention clock runs. */
const CLOSED_STATUSES = ['closed', 'resolved', 'completed'];

function toDays(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function defaultRetentionDays(): number {
  return toDays(process.env.CLIENT_DATA_RETENTION_DAYS, 3650);
}

/** The current firm's retention period (its own setting, else the platform default). */
export function getRetentionDays(): number {
  return currentFirm().retentionDays ?? defaultRetentionDays();
}

function retentionThreshold(): Date {
  return new Date(Date.now() - getRetentionDays() * 24 * 60 * 60 * 1000);
}

/**
 * Closed matters whose last change (the closing, for a closed matter) is
 * older than the retention window.
 */
function retentionEligible(): SQL {
  return and(
    inArray(sql`lower(${cases.status})`, CLOSED_STATUSES),
    lt(cases.updatedAt, retentionThreshold()),
  ) as SQL;
}

function formatRequest(row: ComplianceRequestRow): ComplianceRequest {
  return {
    id: row.id,
    requestType: row.requestType,
    subjectName: row.subjectName,
    subjectEmail: row.subjectEmail,
    caseRef: row.caseRef,
    description: row.description,
    status: row.status,
    responseSummary: row.responseSummary,
    responsePayload: row.responsePayload,
    dueAt: isoOrNull(row.dueAt),
    fulfilledAt: isoOrNull(row.fulfilledAt),
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function formatAssessmentExport(assessment: AssessmentRow | null) {
  if (!assessment) {
    return null;
  }
  return {
    id: assessment.id,
    matterType: assessment.matterType,
    urgency: assessment.urgency,
    summary: assessment.summary,
    keyFacts: ensureStringArray(assessment.keyFacts),
    attorneyQuestions: ensureStringArray(assessment.attorneyQuestions),
    recommendedDocuments: ensureStringArray(assessment.recommendedDocuments),
    complianceFlags: ensureStringArray(assessment.complianceFlags),
    nextActions: ensureStringArray(assessment.nextActions),
    confidence: assessment.confidence,
    model: assessment.modelName,
    provider: assessment.provider,
    popiaNotes: ensureStringArray(assessment.popiaNotes),
    createdAt: iso(assessment.createdAt),
  };
}

function formatCaseExport(caseRecord: CaseRow): MatterCaseSummary & { updatedAt: string } {
  return {
    id: caseRecord.id,
    submissionId: caseRecord.intakeSubmissionId,
    caseNumber: caseRecord.caseNumber,
    status: caseRecord.status,
    urgency: caseRecord.urgency,
    practiceArea: caseRecord.practiceArea,
    nextAction: caseRecord.nextAction,
    createdAt: iso(caseRecord.createdAt),
    updatedAt: iso(caseRecord.updatedAt),
  };
}

function formatSubmissionExport(item: intakeService.PrivateSubmission) {
  const { submission, raw } = item;
  return {
    id: submission.id,
    clientLabel: submission.clientLabel,
    practiceArea: submission.practiceArea,
    jurisdiction: submission.jurisdiction,
    urgencyHint: submission.urgencyHint,
    status: submission.status,
    summary: submission.summaryRedacted,
    createdAt: iso(submission.createdAt),
    personalData: {
      fullName: raw?.fullName || '',
      email: raw?.email || '',
      phone: raw?.phone || '',
      practiceArea: raw?.practiceArea || '',
      jurisdiction: raw?.jurisdiction || '',
      matterSummary: raw?.matterSummary || '',
      requestedOutcome: raw?.requestedOutcome || '',
      documentsMentioned: raw?.documentsMentioned || '',
      urgencyHint: raw?.urgencyHint || '',
      preferredLanguage: raw?.preferredLanguage || '',
      consentToAi: Boolean(raw?.consentToAi),
      consentToStorage: Boolean(raw?.consentToStorage),
    },
    assessment: formatAssessmentExport(item.assessment),
    matterCase: item.caseRecord ? formatCaseExport(item.caseRecord) : null,
  };
}

export interface RequestFilters {
  status?: string;
  requestType?: string;
}

export async function listRequests(filters: RequestFilters = {}, limit = 200) {
  const conditions: SQL[] = [];
  if (filters.status) {
    conditions.push(eq(complianceRequests.status, filters.status));
  }
  if (filters.requestType) {
    conditions.push(eq(complianceRequests.requestType, filters.requestType));
  }
  const rows = await db()
    .select()
    .from(complianceRequests)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(complianceRequests.createdAt))
    .limit(limit);
  return rows.map(formatRequest);
}

export async function createRequest(input: unknown, actor: Actor = {}): Promise<ComplianceRequest> {
  const request = parse(complianceRequestSchema, input);
  const [saved] = await db()
    .insert(complianceRequests)
    .values({
      requestType: request.requestType,
      subjectName: request.subjectName,
      subjectEmail: request.subjectEmail,
      caseRef: request.caseRef ?? null,
      description: request.description,
      dueAt: toDateOrNull(request.dueAt),
      createdBy: actorName(actor),
    })
    .returning();
  if (!saved) {
    throw new Error('Compliance request was not stored');
  }

  await auditService.logEventSafely(
    {
      entityType: 'compliance_request',
      entityId: saved.id,
      action: 'compliance_request_created',
      summary: `${saved.requestType} request submitted`,
      // The subject's email is personal information: keep it out of the
      // (unencrypted) audit trail; the request id links to it.
      details: { caseRef: saved.caseRef },
    },
    actor,
  );

  return formatRequest(saved);
}

export async function fulfillRequest(
  requestId: string,
  input: unknown,
  actor: Actor = {},
): Promise<ComplianceRequest> {
  const fulfilment = parse(complianceFulfilSchema, input);
  const [existing] = await db()
    .select()
    .from(complianceRequests)
    .where(eq(complianceRequests.id, requestId))
    .limit(1);
  if (!existing) {
    throw httpError('Compliance request not found', 404);
  }

  const now = new Date();
  const [updated] = await db()
    .update(complianceRequests)
    .set({
      status: fulfilment.status,
      responseSummary: fulfilment.responseSummary ?? existing.responseSummary,
      responsePayload: fulfilment.responsePayload ?? existing.responsePayload,
      fulfilledAt: now,
      updatedAt: now,
    })
    .where(eq(complianceRequests.id, requestId))
    .returning();
  if (!updated) {
    throw httpError('Compliance request not found', 404);
  }

  await auditService.logEventSafely(
    {
      entityType: 'compliance_request',
      entityId: requestId,
      action: 'compliance_request_fulfilled',
      summary: updated.responseSummary || updated.status,
    },
    actor,
  );

  return formatRequest(updated);
}

/** Everything held about a data subject (by email) or a matter (by reference). */
export async function buildDataExport(query: unknown): Promise<ComplianceExport> {
  const { subjectEmail, caseRef } = parse(dataExportQuerySchema, query);

  const submissionIds = new Set<string>();
  if (subjectEmail) {
    for (const match of await intakeService.findSubmissionsByEmail(subjectEmail)) {
      submissionIds.add(match.id);
    }
  }
  const directCases: CaseRow[] = [];
  // Parties (clients and others) registered with this email, and their matters.
  const subjectParties: PartyRecord[] = [];
  if (subjectEmail) {
    const [entry] = await indexEntries({ email: subjectEmail });
    const matches = entry
      ? await db()
          .select({ partyId: partyIndex.partyId })
          .from(partyIndex)
          .where(eq(partyIndex.hash, entry.hash))
      : [];
    for (const { partyId } of matches) {
      const party = await partyService.getParty(partyId);
      subjectParties.push(party);
      const rows = party.matters.length
        ? await db()
            .select()
            .from(cases)
            .where(
              inArray(
                cases.id,
                party.matters.map((m) => m.caseId),
              ),
            )
        : [];
      for (const row of rows) {
        if (row.intakeSubmissionId) {
          submissionIds.add(row.intakeSubmissionId);
        } else {
          directCases.push(row);
        }
      }
    }
  }
  if (caseRef) {
    const matched = await intakeService.findCaseByRef(caseRef);
    if (matched?.intakeSubmissionId) {
      submissionIds.add(matched.intakeSubmissionId);
    } else if (matched) {
      directCases.push(matched);
    }
  }

  const resolved = (
    await Promise.all([...submissionIds].map((id) => intakeService.getPrivateSubmission(id)))
  ).filter((item): item is intakeService.PrivateSubmission => Boolean(item));
  const caseRows = resolved
    .map((item) => item.caseRecord)
    .filter((row): row is CaseRow => Boolean(row))
    .concat(directCases);
  const caseIds = caseRows.map((row) => row.id);

  const [documentRows, invoiceRows, ledgerRows, calendarRows] = caseIds.length
    ? await Promise.all([
        db().select().from(documents).where(inArray(documents.caseId, caseIds)),
        db().select().from(invoices).where(inArray(invoices.caseId, caseIds)),
        db().select().from(ledgerEntries).where(inArray(ledgerEntries.caseId, caseIds)),
        db().select().from(calendarEvents).where(inArray(calendarEvents.caseId, caseIds)),
      ])
    : [[], [], [], []];

  const exportDocuments: DocumentRecord[] = documentRows.map((row) => ({
    id: row.id,
    caseId: row.caseId,
    caseNumber: row.caseNumber,
    clientLabel: row.clientLabel,
    title: row.title,
    documentType: row.documentType,
    status: row.status,
    tags: row.tags,
    contentPreview: row.contentPreview,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    signedAt: isoOrNull(row.signedAt),
    content: null,
  }));
  const exportInvoices: Invoice[] = invoiceRows.map((row) => ({
    id: row.id,
    caseId: row.caseId,
    caseNumber: row.caseNumber,
    clientLabel: row.clientLabel,
    number: row.invoiceNumber,
    subject: row.subject,
    currency: row.currency,
    status: row.status,
    lineItems: row.lineItems.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      rate: fromCents(item.rateCents),
    })),
    subtotal: fromCents(row.subtotalCents),
    vat: fromCents(row.vatCents),
    total: fromCents(row.totalCents),
    issuedAt: isoOrNull(row.issuedAt),
    dueAt: isoOrNull(row.dueAt),
    paidAt: isoOrNull(row.paidAt),
    createdAt: iso(row.createdAt),
  }));
  const exportLedger: LedgerEntry[] = ledgerRows.map((row) => ({
    id: row.id,
    caseId: row.caseId,
    caseNumber: row.caseNumber,
    entryType: row.entryType,
    account: row.account,
    amount: fromCents(row.amountCents),
    reference: row.reference,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
  }));
  const exportCalendar: CalendarEvent[] = calendarRows.map((row) => ({
    id: row.id,
    caseId: row.caseId,
    caseNumber: row.caseNumber,
    title: row.title,
    eventType: row.eventType,
    startsAt: iso(row.startsAt),
    endsAt: isoOrNull(row.endsAt),
    location: row.location,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
  }));

  return {
    generatedAt: new Date().toISOString(),
    retentionDays: getRetentionDays(),
    subjectEmail: subjectEmail ?? null,
    caseRef: caseRef ?? null,
    submissions: resolved.map(formatSubmissionExport),
    assessments: resolved
      .map((item) => formatAssessmentExport(item.assessment))
      .filter((item) => item !== null),
    cases: caseRows.map(formatCaseExport),
    parties: subjectParties,
    documents: exportDocuments,
    invoices: exportInvoices,
    ledger: exportLedger,
    calendar: exportCalendar,
    notices: [
      'Internal audit records are retained separately for compliance and supervision.',
      'This export intentionally excludes password hashes and secret keys.',
      'Personal data included here is the subject data requested for export.',
    ],
  };
}

export async function getComplianceSummary(): Promise<ComplianceSummary> {
  const [counts] = await db()
    .select({
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where ${complianceRequests.status} = 'open')::int`,
      fulfilled: sql<number>`count(*) filter (where ${complianceRequests.status} = 'fulfilled')::int`,
    })
    .from(complianceRequests);
  const [eligible] = await db()
    .select({ value: sql<number>`count(*)::int` })
    .from(cases)
    .where(retentionEligible());
  const [latest] = await listRequests({}, 1);

  return {
    retentionDays: getRetentionDays(),
    totalRequests: counts?.total ?? 0,
    openRequests: counts?.open ?? 0,
    fulfilledRequests: counts?.fulfilled ?? 0,
    eligibleForRetention: eligible?.value ?? 0,
    latestRequest: latest ?? null,
  };
}

/** Deletes closed matters past the retention window (and all their records). */
export async function runRetentionSweep(actor: Actor = {}): Promise<RetentionSweepResult> {
  const [scanned] = await db()
    .select({ value: sql<number>`count(*)::int` })
    .from(cases);
  const eligible = await db().select().from(cases).where(retentionEligible());
  const removedCaseIds = await intakeService.deleteMatters(eligible);

  for (const item of eligible) {
    await notificationsService
      .createNotification(
        {
          title: `Retained matter removed: ${item.caseNumber}`,
          body: `Closed matter ${item.caseNumber} exceeded the retention window and was removed from active records.`,
          category: 'compliance',
          priority: 'medium',
          recipientRole: 'admin',
        },
        actor,
      )
      .catch(() => {});
  }

  const summary: RetentionSweepResult = {
    retentionDays: getRetentionDays(),
    scannedCases: scanned?.value ?? 0,
    eligibleCases: eligible.length,
    removedSubmissions: eligible.length,
    removedCases: removedCaseIds.length,
  };

  await auditService.logEvent(
    {
      entityType: 'compliance',
      entityId: 'retention-sweep',
      action: 'retention_sweep_completed',
      summary: `Retention sweep completed: ${summary.removedCases} cases removed`,
      details: { ...summary, caseNumbers: eligible.map((row) => row.caseNumber) },
    },
    actor,
  );

  return summary;
}
