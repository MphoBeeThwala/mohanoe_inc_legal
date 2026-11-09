// Client intake: encrypted submissions, de-identified AI triage, and the
// matter (case) each assessed intake becomes.

import { count, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type {
  IntakeSummary,
  MatterCase,
  MatterCaseSummary,
  PublicSubmission,
} from '@ahava88/shared';
import { db } from '../db/client';
import { nextValue } from '../db/sequences';
import {
  assessments,
  cases,
  submissions,
  type AssessmentRow,
  type CaseRow,
  type SubmissionRow,
} from '../db/schema';
import { getFirmBrand } from '../config/brand';
import { httpError } from '../lib/http';
import { SYSTEM_ACTOR } from '../lib/actor';
import { iso } from '../lib/time';
import { intakeSubmissionSchema, parse, type IntakeSubmission } from '../validation/schemas';
import { assessMatter, ensureStringArray, type MatterBrief } from './ai.service';
import {
  blindIndex,
  decryptJson,
  encryptJson,
  redactMatterForAi,
  redactText,
} from './privacy.service';
import * as auditService from './audit.service';

/** The de-identified brief sent for AI triage. Never contains raw PII. */
function toMatterBrief(submission: IntakeSubmission): MatterBrief {
  const redacted = redactMatterForAi(submission);
  return {
    clientLabel: redacted.clientLabel,
    practiceArea: redacted.practiceArea,
    jurisdiction: redacted.jurisdiction,
    urgencyHint: redacted.urgencyHint,
    matterSummary: redactText(redacted.matterSummary, {
      clientName: submission.fullName,
      fullName: submission.fullName,
    }),
  };
}

async function nextCaseNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const sequence = await nextValue(`case_number:${year}`);
  return `${getFirmBrand().casePrefix}-${year}-${String(sequence).padStart(4, '0')}`;
}

async function nextClientLabel(): Promise<string> {
  const sequence = await nextValue('client_label');
  return `Client ${String(sequence).padStart(3, '0')}`;
}

function toCaseSummary(row: CaseRow): MatterCaseSummary {
  return {
    id: row.id,
    submissionId: row.intakeSubmissionId,
    caseNumber: row.caseNumber,
    status: row.status,
    urgency: row.urgency,
    practiceArea: row.practiceArea,
    nextAction: row.nextAction,
    createdAt: iso(row.createdAt),
  };
}

export function toMatterCase(row: CaseRow): MatterCase {
  return {
    id: row.id,
    submissionId: row.intakeSubmissionId,
    caseNumber: row.caseNumber,
    clientLabel: row.clientLabel,
    practiceArea: row.practiceArea,
    urgency: row.urgency,
    status: row.status,
    nextAction: row.nextAction,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toPublicSubmission(
  submission: SubmissionRow,
  assessment: AssessmentRow | null = null,
  caseRecord: CaseRow | null = null,
): PublicSubmission {
  return {
    id: submission.id,
    clientLabel: submission.clientLabel,
    practiceArea: submission.practiceArea,
    jurisdiction: submission.jurisdiction,
    urgencyHint: submission.urgencyHint,
    status: submission.status,
    summary: submission.summaryRedacted,
    createdAt: iso(submission.createdAt),
    assessment: assessment && {
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
    },
    matterCase: caseRecord && toCaseSummary(caseRecord),
  };
}

/** Submissions joined with their assessment and case, newest first. */
async function selectSubmissions(where?: ReturnType<typeof eq>, limit = 100) {
  return db()
    .select({ submission: submissions, assessment: assessments, matterCase: cases })
    .from(submissions)
    .leftJoin(assessments, eq(assessments.intakeSubmissionId, submissions.id))
    .leftJoin(cases, eq(cases.intakeSubmissionId, submissions.id))
    .where(where)
    .orderBy(desc(submissions.createdAt))
    .limit(limit);
}

export async function createSubmission(input: unknown): Promise<PublicSubmission> {
  const submission = parse(intakeSubmissionSchema, input);
  const brief = toMatterBrief(submission);

  const [saved] = await db()
    .insert(submissions)
    .values({
      clientLabel: await nextClientLabel(),
      practiceArea: submission.practiceArea,
      jurisdiction: submission.jurisdiction,
      urgencyHint: submission.urgencyHint,
      status: 'received',
      summaryRedacted: brief.matterSummary ?? '',
      rawPayloadEncrypted: encryptJson(submission),
      emailLookup: blindIndex(submission.email),
      consentToAi: submission.consentToAi,
      consentToStorage: submission.consentToStorage,
    })
    .returning();
  if (!saved) {
    throw new Error('Submission was not stored');
  }

  await auditService.logEventSafely(
    {
      entityType: 'submission',
      entityId: saved.id,
      action: 'submission_created',
      summary: `Intake submitted: ${saved.clientLabel}`,
    },
    // Audit rows are not encrypted, so they never carry the client's identity.
    { fullName: saved.clientLabel, role: 'client' },
  );
  return toPublicSubmission(saved);
}

export async function listSubmissions(limit = 100): Promise<PublicSubmission[]> {
  const rows = await selectSubmissions(undefined, limit);
  return rows.map((row) => toPublicSubmission(row.submission, row.assessment, row.matterCase));
}

export async function getSubmission(id: string): Promise<PublicSubmission | null> {
  const [row] = await selectSubmissions(eq(submissions.id, id), 1);
  return row ? toPublicSubmission(row.submission, row.assessment, row.matterCase) : null;
}

export interface PrivateSubmission {
  submission: SubmissionRow;
  raw: IntakeSubmission | null;
  assessment: AssessmentRow | null;
  caseRecord: CaseRow | null;
}

/** Includes the decrypted personal information: admin/compliance use only. */
export async function getPrivateSubmission(id: string): Promise<PrivateSubmission | null> {
  const [row] = await selectSubmissions(eq(submissions.id, id), 1);
  if (!row) {
    return null;
  }
  return {
    submission: row.submission,
    raw: decryptJson<IntakeSubmission>(row.submission.rawPayloadEncrypted),
    assessment: row.assessment,
    caseRecord: row.matterCase,
  };
}

/** Finds a data subject's submissions through the email blind index. */
export async function findSubmissionsByEmail(email: string): Promise<PublicSubmission[]> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const rows = await selectSubmissions(eq(submissions.emailLookup, blindIndex(normalized)), 1_000);
  return rows.map((row) => toPublicSubmission(row.submission, row.assessment, row.matterCase));
}

export async function assessSubmission(id: string): Promise<PublicSubmission> {
  const [existing] = await selectSubmissions(eq(submissions.id, id), 1);
  if (!existing) {
    throw httpError('Intake submission not found', 404);
  }

  const raw = decryptJson<IntakeSubmission>(existing.submission.rawPayloadEncrypted);
  if (!raw) {
    throw httpError('Intake submission could not be decrypted', 500);
  }
  const brief = toMatterBrief(raw);
  // The AI call happens outside any transaction: it can take seconds.
  const result = await assessMatter(brief);
  const nextAction =
    result.nextActions?.[0] || 'Attorney to review the intake and confirm next steps.';
  const caseNumber = existing.matterCase ? null : await nextCaseNumber();

  const { submission, assessment, matterCase, created } = await db().transaction(async (tx) => {
    const assessmentValues = {
      intakeSubmissionId: id,
      provider: result.provider,
      modelName: result.model,
      matterType: result.matterType,
      urgency: result.urgency,
      summary: result.summary,
      keyFacts: ensureStringArray(result.keyFacts),
      attorneyQuestions: ensureStringArray(result.attorneyQuestions),
      recommendedDocuments: ensureStringArray(result.recommendedDocuments),
      complianceFlags: ensureStringArray(result.complianceFlags),
      nextActions: ensureStringArray(result.nextActions),
      confidence: Number.isFinite(result.confidence) ? result.confidence : 0,
      popiaNotes: ensureStringArray(result.popiaNotes),
      rawRedactedBrief: brief as Record<string, unknown>,
    };
    const [savedAssessment] = await tx
      .insert(assessments)
      .values(assessmentValues)
      .onConflictDoUpdate({
        target: assessments.intakeSubmissionId,
        set: { ...assessmentValues, createdAt: new Date() },
      })
      .returning();

    let savedCase: CaseRow | undefined;
    let isNew = false;
    if (existing.matterCase) {
      // Re-assessment refreshes the triage; the case keeps its number,
      // status and history.
      [savedCase] = await tx
        .update(cases)
        .set({
          urgency: result.urgency,
          practiceArea: result.matterType || existing.submission.practiceArea,
          nextAction,
          updatedAt: new Date(),
        })
        .where(eq(cases.id, existing.matterCase.id))
        .returning();
    } else {
      isNew = true;
      [savedCase] = await tx
        .insert(cases)
        .values({
          intakeSubmissionId: id,
          caseNumber: caseNumber as string,
          clientLabel: existing.submission.clientLabel,
          practiceArea: result.matterType || existing.submission.practiceArea,
          urgency: result.urgency,
          status: result.urgency === 'critical' ? 'priority-review' : 'triage',
          nextAction,
        })
        .returning();
    }

    const [savedSubmission] = await tx
      .update(submissions)
      .set({ status: 'assessed', updatedAt: new Date() })
      .where(eq(submissions.id, id))
      .returning();

    if (!savedAssessment || !savedCase || !savedSubmission) {
      throw new Error('Assessment could not be stored');
    }
    return {
      submission: savedSubmission,
      assessment: savedAssessment,
      matterCase: savedCase,
      created: isNew,
    };
  });

  if (created) {
    await auditService.logEventSafely(
      {
        entityType: 'case',
        entityId: matterCase.id,
        action: 'case_created',
        summary: `Case created: ${matterCase.caseNumber}`,
        details: { submissionId: id, urgency: matterCase.urgency },
      },
      { ...SYSTEM_ACTOR, fullName: 'Intake pipeline' },
    );
  }
  await auditService.logEventSafely(
    {
      entityType: 'submission',
      entityId: id,
      action: 'submission_assessed',
      summary: `Intake assessed: ${submission.clientLabel}`,
      details: { provider: assessment.provider, urgency: matterCase.urgency },
    },
    { ...SYSTEM_ACTOR, fullName: 'Assessment pipeline' },
  );

  return toPublicSubmission(submission, assessment, matterCase);
}

export async function listCases(limit = 500): Promise<MatterCase[]> {
  const rows = await db().select().from(cases).orderBy(desc(cases.createdAt)).limit(limit);
  return rows.map(toMatterCase);
}

/** Finds a case by its id, case number, or intake submission id. */
export async function findCaseByRef(ref: string): Promise<CaseRow | null> {
  const value = ref.trim();
  if (!value) {
    return null;
  }
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const [row] = await db()
    .select()
    .from(cases)
    .where(
      isUuid
        ? or(eq(cases.id, value), eq(cases.intakeSubmissionId, value), eq(cases.caseNumber, value))
        : eq(cases.caseNumber, value),
    )
    .limit(1);
  return row ?? null;
}

export async function getSummary(): Promise<IntakeSummary> {
  const [submissionCounts] = await db()
    .select({
      open: sql<number>`count(*) filter (where ${submissions.status} = 'received')::int`,
    })
    .from(submissions);
  const [assessmentCount] = await db().select({ value: count() }).from(assessments);
  const [caseCounts] = await db()
    .select({
      live: sql<number>`count(*)::int`,
      critical: sql<number>`count(*) filter (where ${cases.urgency} = 'critical')::int`,
    })
    .from(cases);
  const [latest] = await selectSubmissions(undefined, 1);

  return {
    openIntakes: submissionCounts?.open ?? 0,
    assessedIntakes: assessmentCount?.value ?? 0,
    liveCases: caseCounts?.live ?? 0,
    criticalMatters: caseCounts?.critical ?? 0,
    encryptedStorage: true,
    popiaCompliantAi: true,
    latestIntake: latest
      ? toPublicSubmission(latest.submission, latest.assessment, latest.matterCase)
      : null,
  };
}

/**
 * Permanently deletes submissions and everything that hangs off them
 * (assessment, case, tasks, timeline, documents, billing, calendar) via
 * ON DELETE CASCADE. Returns the ids of the cases removed.
 */
export async function deleteSubmissions(submissionIds: string[]): Promise<string[]> {
  if (!submissionIds.length) {
    return [];
  }
  const removedCases = await db()
    .select({ id: cases.id })
    .from(cases)
    .where(inArray(cases.intakeSubmissionId, submissionIds));
  await db().delete(submissions).where(inArray(submissions.id, submissionIds));
  return removedCases.map((row) => row.id);
}
