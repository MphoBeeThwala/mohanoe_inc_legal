// Conflict-of-interest checks.
//
// A check takes the prospective client and the other parties of a proposed
// matter, and finds every party in the firm's register that matches any of
// them (blind-index hashes: ID/registration number, email, phone, full name,
// or enough name words). It looks across all matters, including restricted
// and walled ones, because a conflict hidden from the person checking is
// still a conflict; but it only names matters the person can see, and counts
// the rest.
//
// Every check is kept with its decision (the firm's record under the LPC
// rules): clear, conflict, or waived (administrators only, with notes, after
// informed consent). Clients and matters can only be opened on a cleared or
// waived check.
import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  ConflictCheck,
  ConflictCheckInput,
  ConflictDecision,
  ConflictMatch,
  ConflictStrength,
  ConflictSubject,
  MatterPartyRole,
} from '@ahava88/shared';
import { hasPermission } from '@ahava88/shared';
import { db } from '../db/client';
import { withSystemScope } from '../db/tenant';
import {
  caseParties,
  cases,
  conflictChecks,
  parties,
  partyIndex,
  users,
  type ConflictCheckRow,
} from '../db/schema';
import { httpError } from '../lib/http';
import type { Actor } from '../lib/actor';
import { iso, isoOrNull } from '../lib/time';
import {
  conflictCheckSchema,
  conflictDecisionSchema,
  parse,
  uuidSchema,
} from '../validation/schemas';
import { decryptJson, encryptJson } from './privacy.service';
import { indexEntries, nameTokens } from './party-index';
import { toSummary } from './party.service';
import * as auditService from './audit.service';

/** How long a cleared check can be used to open a client or matter. */
const CHECK_VALID_DAYS = 90;

const STRONG_FIELDS = new Set(['id_number', 'reg_number', 'email', 'phone', 'name']);

interface StoredMatch {
  subject: number;
  partyId: string;
  strength: ConflictStrength;
  reasons: string[];
  links: Array<{ caseId: string; role: string }>;
}

interface StoredQuery {
  subjects: ConflictSubject[];
  purpose: string;
}

async function findMatches(subjects: ConflictSubject[]): Promise<StoredMatch[]> {
  const matches: StoredMatch[] = [];
  for (const [index, subject] of subjects.entries()) {
    const entries = await indexEntries(subject);
    if (!entries.length) continue;
    const hits = await db()
      .select({ partyId: partyIndex.partyId, field: partyIndex.field, hash: partyIndex.hash })
      .from(partyIndex)
      .where(
        inArray(
          partyIndex.hash,
          entries.map((entry) => entry.hash),
        ),
      );
    const tokenCount = nameTokens(subject.name).length;
    const byParty = new Map<string, Set<string>>();
    for (const hit of hits) {
      const fields = byParty.get(hit.partyId) ?? new Set<string>();
      fields.add(hit.field === 'token' ? `token:${hit.hash}` : hit.field);
      byParty.set(hit.partyId, fields);
    }
    for (const [partyId, fields] of byParty) {
      const tokens = [...fields].filter((field) => field.startsWith('token:')).length;
      const strong = [...fields].filter((field) => STRONG_FIELDS.has(field));
      // A possible match: at least two shared name words, or every word of a
      // one-word name (e.g. a company called "Acme").
      const possible = tokens >= Math.min(2, tokenCount) && tokens > 0;
      if (!strong.length && !possible) continue;
      matches.push({
        subject: index,
        partyId,
        strength: strong.length ? 'strong' : 'possible',
        reasons: strong.length ? strong : [`${tokens} name word${tokens === 1 ? '' : 's'}`],
        links: [],
      });
    }
  }
  if (!matches.length) {
    return matches;
  }
  // Every matter each matched party is on, restricted and walled included.
  const links = await withSystemScope(() =>
    db()
      .select({ partyId: caseParties.partyId, caseId: caseParties.caseId, role: caseParties.role })
      .from(caseParties)
      .where(inArray(caseParties.partyId, [...new Set(matches.map((m) => m.partyId))])),
  );
  for (const match of matches) {
    match.links = links
      .filter((link) => link.partyId === match.partyId)
      .map((link) => ({ caseId: link.caseId, role: link.role }));
  }
  return matches.sort((a, b) => (a.strength === b.strength ? 0 : a.strength === 'strong' ? -1 : 1));
}

/** Resolves stored matches for the viewer: decrypts matched parties, names only visible matters. */
async function presentMatches(stored: StoredMatch[]): Promise<ConflictMatch[]> {
  if (!stored.length) return [];
  const partyRows = await db()
    .select()
    .from(parties)
    .where(inArray(parties.id, [...new Set(stored.map((m) => m.partyId))]));
  const caseIds = [...new Set(stored.flatMap((m) => m.links.map((l) => l.caseId)))];
  // RLS: only matters this viewer may see come back.
  const visible = caseIds.length
    ? await db()
        .select({ id: cases.id, caseNumber: cases.caseNumber, title: cases.title })
        .from(cases)
        .where(inArray(cases.id, caseIds))
    : [];
  const result: ConflictMatch[] = [];
  for (const match of stored) {
    const row = partyRows.find((p) => p.id === match.partyId);
    if (!row) continue; // since deleted
    const shown = match.links.flatMap((link) => {
      const found = visible.find((c) => c.id === link.caseId);
      return found
        ? [
            {
              caseId: found.id,
              caseNumber: found.caseNumber,
              title: found.title,
              role: link.role as MatterPartyRole,
            },
          ]
        : [];
    });
    result.push({
      subject: match.subject,
      party: await toSummary(row),
      strength: match.strength,
      reasons: match.reasons,
      matters: shown,
      hiddenMatters: match.links.length - shown.length,
    });
  }
  return result;
}

async function present(row: ConflictCheckRow): Promise<ConflictCheck> {
  const query = (await decryptJson<StoredQuery>(row.queryEncrypted)) ?? {
    subjects: [],
    purpose: '',
  };
  const names = await db()
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .where(
      inArray(
        users.id,
        [row.performedBy, row.decidedBy].filter((id): id is string => Boolean(id)),
      ),
    );
  const nameOf = (id: string | null) => names.find((n) => n.id === id)?.fullName ?? null;
  return {
    id: row.id,
    subjects: query.subjects,
    purpose: query.purpose,
    matches: await presentMatches(row.results as unknown as StoredMatch[]),
    strongMatches: row.strongMatches,
    possibleMatches: row.possibleMatches,
    decision: row.decision as ConflictDecision,
    decisionNotes: row.decisionNotesEncrypted
      ? await decryptJson<string>(row.decisionNotesEncrypted)
      : null,
    performedBy: nameOf(row.performedBy),
    decidedBy: nameOf(row.decidedBy),
    decidedAt: isoOrNull(row.decidedAt),
    createdAt: iso(row.createdAt),
  };
}

export async function runCheck(input: unknown, actor: Actor): Promise<ConflictCheck> {
  const query = parse(conflictCheckSchema, input) as ConflictCheckInput;
  const matches = await findMatches(query.subjects);
  const strong = matches.filter((m) => m.strength === 'strong').length;
  const [saved] = await db()
    .insert(conflictChecks)
    .values({
      queryEncrypted: await encryptJson(query),
      results: matches as unknown as Record<string, unknown>[],
      strongMatches: strong,
      possibleMatches: matches.length - strong,
      performedBy: actor.userId ?? null,
    })
    .returning();
  if (!saved) {
    throw new Error('Conflict check was not stored');
  }
  await auditService.logEvent(
    {
      entityType: 'conflict_check',
      entityId: saved.id,
      action: 'conflict_check_run',
      summary: `Conflict check: ${strong} strong, ${matches.length - strong} possible match(es)`,
      details: { subjects: query.subjects.length, strong, possible: matches.length - strong },
    },
    actor,
  );
  return present(saved);
}

async function requireCheck(id: string): Promise<ConflictCheckRow> {
  const [row] = await db()
    .select()
    .from(conflictChecks)
    .where(eq(conflictChecks.id, parse(uuidSchema, id)))
    .limit(1);
  if (!row) {
    throw httpError('Conflict check not found', 404);
  }
  return row;
}

export async function getCheck(id: string): Promise<ConflictCheck> {
  return present(await requireCheck(id));
}

export async function listChecks(limit = 50): Promise<ConflictCheck[]> {
  const rows = await db()
    .select()
    .from(conflictChecks)
    .orderBy(desc(conflictChecks.createdAt))
    .limit(limit);
  return Promise.all(rows.map(present));
}

export async function decide(id: string, input: unknown, actor: Actor): Promise<ConflictCheck> {
  const { decision, notes } = parse(conflictDecisionSchema, input);
  const row = await requireCheck(id);
  if (row.decision !== 'pending') {
    throw httpError('This check has already been decided; run a new check', 409);
  }
  if (decision === 'waived') {
    if (!hasPermission(actor.role ?? undefined, 'conflicts.waive')) {
      throw httpError('Only an administrator can record a waiver', 403);
    }
    if (!notes || notes.length < 10) {
      throw httpError('Record how informed consent was obtained (notes)', 400);
    }
  }
  if (decision === 'clear' && row.strongMatches > 0 && !notes) {
    throw httpError('Explain why the strong matches are not conflicts (notes)', 400);
  }
  const [updated] = await db()
    .update(conflictChecks)
    .set({
      decision,
      decisionNotesEncrypted: notes ? await encryptJson(notes) : null,
      decidedBy: actor.userId ?? null,
      decidedAt: new Date(),
    })
    .where(and(eq(conflictChecks.id, row.id), eq(conflictChecks.decision, 'pending')))
    .returning();
  if (!updated) {
    throw httpError('This check has already been decided; run a new check', 409);
  }
  await auditService.logEvent(
    {
      entityType: 'conflict_check',
      entityId: row.id,
      action: 'conflict_check_decided',
      summary: `Conflict check decided: ${decision}`,
      details: { decision, strong: row.strongMatches, possible: row.possibleMatches },
    },
    actor,
  );
  return present(updated);
}

/** A check that permits opening a client or matter: cleared or waived, and recent. */
export async function requireClearedCheck(id: string): Promise<ConflictCheckRow> {
  const row = await requireCheck(id);
  if (row.decision !== 'clear' && row.decision !== 'waived') {
    throw httpError(
      row.decision === 'conflict'
        ? 'The conflict check found a conflict: the firm cannot act'
        : 'Record a decision on the conflict check first',
      409,
    );
  }
  if (Date.now() - row.createdAt.getTime() > CHECK_VALID_DAYS * 86_400_000) {
    throw httpError(
      `That conflict check is older than ${CHECK_VALID_DAYS} days; run a new one`,
      409,
    );
  }
  return row;
}

/** Whether a check recorded a waiver (used when a client is added as an opposing party). */
export async function isWaiver(id: string | undefined): Promise<boolean> {
  if (!id) return false;
  const row = await requireCheck(id);
  return row.decision === 'waived';
}
