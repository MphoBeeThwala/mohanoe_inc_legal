// AI legal research on a matter (roadmap §7), step one: the brief.
//
// The attorney asks a question; the brief combines it with the intake facts
// and anything the attorney adds, and is de-identified against everyone the
// firm knows on the matter (the intake client and the matter's parties). The
// attorney sees exactly what the model will receive, can edit it (edits are
// checked again: an edit that puts a name or identifier back is refused),
// and confirms it. Only a confirmed brief is ever sent.
import { and, desc, eq } from 'drizzle-orm';
import type { ResearchAnswer, ResearchRequest, ResearchStatus } from '@ahava88/shared';
import { db } from '../db/client';
import { caseParties, parties, researchRequests, submissions, type CaseRow } from '../db/schema';
import { httpError } from '../lib/http';
import type { Actor } from '../lib/actor';
import { iso, isoOrNull } from '../lib/time';
import { isUuid } from '../lib/ids';
import {
  parse,
  researchBriefSchema,
  researchDraftSchema,
  type IntakeSubmission,
} from '../validation/schemas';
import { decryptJson, encryptJson } from './privacy.service';
import {
  deidentify,
  reidentify,
  remainingIdentifiers,
  type KnownPerson,
  type PersonRole,
} from './deidentify';
import { answerBrief } from './research-run';
import { z } from 'zod';
import { findCaseByRef } from './intake.service';
import { partyDetails } from './party.service';
import * as auditService from './audit.service';

interface StoredBrief {
  text: string;
  replacements: ResearchRequest['replacements'];
  warnings: string[];
}

async function requireCase(caseRef: string): Promise<CaseRow> {
  const row = await findCaseByRef(caseRef);
  if (!row) {
    throw httpError('Matter not found', 404);
  }
  return row;
}

const PARTY_ROLES: Record<string, PersonRole> = {
  client: 'client',
  opposing: 'opposing',
  opposing_attorney: 'opposing_attorney',
  related: 'related',
  witness: 'witness',
};

/** Everyone the firm has recorded on the matter, with their identifiers. */
export async function matterPeople(row: CaseRow): Promise<KnownPerson[]> {
  const people: KnownPerson[] = [];
  const intake = row.intakeSubmissionId ? await intakeOf(row.intakeSubmissionId) : null;
  if (intake) {
    people.push({
      role: 'client',
      name: intake.fullName,
      identifiers: [intake.email, intake.phone],
    });
  }
  const linked = await db()
    .select({ role: caseParties.role, party: parties })
    .from(caseParties)
    .innerJoin(parties, eq(parties.id, caseParties.partyId))
    .where(eq(caseParties.caseId, row.id))
    .orderBy(caseParties.createdAt);
  for (const { role, party } of linked) {
    const details = await partyDetails(party);
    // The intake client is usually also the matter's client party.
    if (
      intake &&
      role === 'client' &&
      details.name.trim().toLowerCase() === intake.fullName.trim().toLowerCase()
    ) {
      people[0]!.identifiers!.push(
        details.idNumber,
        details.registrationNumber,
        details.email,
        details.phone,
        details.address,
      );
      continue;
    }
    people.push({
      role: PARTY_ROLES[role] ?? 'other',
      name: details.name,
      identifiers: [
        details.idNumber,
        details.registrationNumber,
        details.email,
        details.phone,
        details.address,
      ],
    });
  }
  return people;
}

async function intakeOf(submissionId: string): Promise<IntakeSubmission | null> {
  const [row] = await db()
    .select({ raw: submissions.rawPayloadEncrypted })
    .from(submissions)
    .where(eq(submissions.id, submissionId));
  return row ? decryptJson<IntakeSubmission>(row.raw) : null;
}

async function toRequest(
  row: typeof researchRequests.$inferSelect,
  caseNumber: string,
): Promise<ResearchRequest> {
  const brief = (await decryptJson<StoredBrief>(row.briefEncrypted)) ?? {
    text: '',
    replacements: [],
    warnings: [],
  };
  const stored = row.answerEncrypted
    ? await decryptJson<Omit<ResearchAnswer, 'claimsNamed'>>(row.answerEncrypted)
    : null;
  let answer: ResearchAnswer | null = null;
  if (stored) {
    const mapping = (await decryptJson<Record<string, string>>(row.mappingEncrypted)) ?? {};
    answer = {
      ...stored,
      claimsNamed: stored.claims.map((claim) => ({
        ...claim,
        text: reidentify(claim.text, mapping),
      })),
    };
  }
  return {
    id: row.id,
    caseNumber,
    status: row.status as ResearchStatus,
    answer,
    lastError: row.lastError,
    approvedAt: isoOrNull(row.approvedAt),
    approvedBy: row.approvedBy,
    approvalNote: row.approvalNoteEncrypted
      ? ((await decryptJson<string>(row.approvalNoteEncrypted)) ?? null)
      : null,
    question: (await decryptJson<string>(row.questionEncrypted)) ?? '',
    brief: brief.text,
    replacements: brief.replacements,
    warnings: brief.warnings,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    createdBy: row.createdBy,
    confirmedAt: isoOrNull(row.confirmedAt),
    confirmedBy: row.confirmedBy,
  };
}

export async function createDraft(
  caseRef: string,
  input: unknown,
  actor: Actor,
): Promise<ResearchRequest> {
  const { question, additionalFacts } = parse(researchDraftSchema, input);
  const matter = await requireCase(caseRef);
  const intake = matter.intakeSubmissionId ? await intakeOf(matter.intakeSubmissionId) : null;
  const facts = [intake?.matterSummary, additionalFacts].filter(Boolean).join('\n\n');
  const text = [
    `Research question:\n${question}`,
    `Jurisdiction: ${intake?.jurisdiction || 'South Africa'}`,
    `Practice area: ${matter.practiceArea || intake?.practiceArea || 'Not stated'}`,
    facts ? `Facts:\n${facts}` : '',
    intake?.requestedOutcome ? `Outcome the client wants:\n${intake.requestedOutcome}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const result = deidentify(text, await matterPeople(matter));
  const brief: StoredBrief = {
    text: result.text,
    replacements: result.replacements,
    warnings: result.warnings,
  };
  const [row] = await db()
    .insert(researchRequests)
    .values({
      caseId: matter.id,
      questionEncrypted: await encryptJson(question),
      briefEncrypted: await encryptJson(brief),
      mappingEncrypted: await encryptJson(result.mapping),
      createdBy: actor.userId ?? null,
    })
    .returning();
  await auditService.logEvent(
    {
      entityType: 'research_request',
      entityId: row!.id,
      action: 'research_brief_drafted',
      summary: `Research brief drafted on ${matter.caseNumber}`,
      details: {
        caseNumber: matter.caseNumber,
        identifiersRemoved: result.replacements.reduce((n, r) => n + r.count, 0),
        warnings: result.warnings.length,
      },
    },
    actor,
  );
  return toRequest(row!, matter.caseNumber);
}

export async function listForMatter(caseRef: string): Promise<ResearchRequest[]> {
  const matter = await requireCase(caseRef);
  const rows = await db()
    .select()
    .from(researchRequests)
    .where(eq(researchRequests.caseId, matter.id))
    .orderBy(desc(researchRequests.createdAt));
  return Promise.all(rows.map((row) => toRequest(row, matter.caseNumber)));
}

async function requireRequest(id: string) {
  if (!isUuid(id)) {
    throw httpError('Research request not found', 404);
  }
  const [row] = await db().select().from(researchRequests).where(eq(researchRequests.id, id));
  if (!row) {
    throw httpError('Research request not found', 404);
  }
  const matter = await requireCase(row.caseId);
  return { row, matter };
}

export async function getRequest(id: string): Promise<ResearchRequest> {
  const { row, matter } = await requireRequest(id);
  return toRequest(row, matter.caseNumber);
}

/** Refuses a brief that still holds (or regained) names or identifiers. */
async function assertClean(text: string, matter: CaseRow): Promise<string[]> {
  const people = await matterPeople(matter);
  const left = remainingIdentifiers(text, people);
  if (left.length) {
    const kinds = [...new Set(left.map((r) => r.token.replace(/[[\]]/g, '')))];
    throw httpError(
      `The brief still contains personal information (${kinds.join(', ')}). Remove it or use the tokens such as [Client].`,
      422,
    );
  }
  return deidentify(text, people).warnings;
}

export async function updateBrief(
  id: string,
  input: unknown,
  actor: Actor,
): Promise<ResearchRequest> {
  const { brief } = parse(researchBriefSchema, input);
  const { row, matter } = await requireRequest(id);
  if (row.status !== 'draft') {
    throw httpError('A confirmed brief cannot be changed; start a new one.', 409);
  }
  const warnings = await assertClean(brief, matter);
  const previous = await decryptJson<StoredBrief>(row.briefEncrypted);
  const [saved] = await db()
    .update(researchRequests)
    .set({
      briefEncrypted: await encryptJson({
        text: brief.trim(),
        replacements: previous?.replacements ?? [],
        warnings,
      } satisfies StoredBrief),
      updatedAt: new Date(),
    })
    .where(eq(researchRequests.id, row.id))
    .returning();
  await auditService.logEvent(
    {
      entityType: 'research_request',
      entityId: row.id,
      action: 'research_brief_edited',
      summary: `Research brief edited on ${matter.caseNumber}`,
      details: { caseNumber: matter.caseNumber },
    },
    actor,
  );
  return toRequest(saved!, matter.caseNumber);
}

/** The attorney's confirmation that this exact brief may be sent. */
export async function confirmBrief(id: string, actor: Actor): Promise<ResearchRequest> {
  const { row, matter } = await requireRequest(id);
  if (row.status !== 'draft') {
    throw httpError('This brief is already confirmed', 409);
  }
  const stored = await decryptJson<StoredBrief>(row.briefEncrypted);
  await assertClean(stored?.text ?? '', matter);
  const [saved] = await db()
    .update(researchRequests)
    .set({
      status: 'confirmed',
      confirmedBy: actor.userId ?? null,
      confirmedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(researchRequests.id, row.id), eq(researchRequests.status, 'draft')))
    .returning();
  await auditService.logEvent(
    {
      entityType: 'research_request',
      entityId: row.id,
      action: 'research_brief_confirmed',
      summary: `Research brief confirmed for sending on ${matter.caseNumber}`,
      details: { caseNumber: matter.caseNumber },
    },
    actor,
  );
  return toRequest(saved!, matter.caseNumber);
}

export async function deleteDraft(id: string, actor: Actor): Promise<void> {
  const { row, matter } = await requireRequest(id);
  if (row.status !== 'draft') {
    throw httpError('Only drafts can be deleted', 409);
  }
  await db().delete(researchRequests).where(eq(researchRequests.id, row.id));
  await auditService.logEvent(
    {
      entityType: 'research_request',
      entityId: row.id,
      action: 'research_brief_deleted',
      summary: `Research brief draft deleted on ${matter.caseNumber}`,
      details: { caseNumber: matter.caseNumber },
    },
    actor,
  );
}

/**
 * Researches a confirmed brief against the approved sources. Only the
 * confirmed (de-identified) text is sent. Can be run again until approved.
 */
export async function run(id: string, actor: Actor): Promise<ResearchRequest> {
  const { row, matter } = await requireRequest(id);
  if (row.status === 'draft') {
    throw httpError('Confirm the brief before running research.', 409);
  }
  if (row.status === 'approved') {
    throw httpError(
      'This research is approved and frozen; start a new brief to research again.',
      409,
    );
  }
  const stored = await decryptJson<StoredBrief>(row.briefEncrypted);
  // The brief was clean when confirmed; matter parties may have been added since.
  await assertClean(stored?.text ?? '', matter);
  const answer = await answerBrief(stored!.text, { subjectId: row.id, actor });
  const [saved] = await db()
    .update(researchRequests)
    .set({
      status: 'answered',
      answerEncrypted: await encryptJson(answer),
      sourcesEncrypted: await encryptJson(answer.sources),
      answeredAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(researchRequests.id, row.id))
    .returning();
  await auditService.logEvent(
    {
      entityType: 'research_request',
      entityId: row.id,
      action: 'research_answered',
      summary: `Research answered on ${matter.caseNumber}`,
      details: {
        caseNumber: matter.caseNumber,
        claims: answer.claims.length,
        removedClaims: answer.removed.length,
        sources: answer.sources.length,
        noAuthority: answer.noAuthority,
      },
    },
    actor,
  );
  return toRequest(saved!, matter.caseNumber);
}

const approvalSchema = z.object({ note: z.string().trim().max(4000).optional() });

/** The attorney signs off the memo; it is frozen with its sources (research.approve). */
export async function approve(id: string, input: unknown, actor: Actor): Promise<ResearchRequest> {
  const { note } = parse(approvalSchema, input ?? {});
  const { row, matter } = await requireRequest(id);
  if (row.status !== 'answered') {
    throw httpError('Only answered research can be approved', 409);
  }
  const [saved] = await db()
    .update(researchRequests)
    .set({
      status: 'approved',
      approvedBy: actor.userId ?? null,
      approvedAt: new Date(),
      approvalNoteEncrypted: note ? await encryptJson(note) : null,
      updatedAt: new Date(),
    })
    .where(and(eq(researchRequests.id, row.id), eq(researchRequests.status, 'answered')))
    .returning();
  await auditService.logEvent(
    {
      entityType: 'research_request',
      entityId: row.id,
      action: 'research_approved',
      summary: `Research memo approved on ${matter.caseNumber}`,
      details: { caseNumber: matter.caseNumber },
    },
    actor,
  );
  return toRequest(saved!, matter.caseNumber);
}
