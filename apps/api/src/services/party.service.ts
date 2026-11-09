// The firm's register of parties: clients, opposing parties, their attorneys,
// related persons. Details are encrypted (firm data key); party_index holds
// blind-index hashes so the register can be searched without decrypting it.
// Only the parties actually returned to a caller are decrypted.
import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  MatterParty,
  MatterPartyRole,
  PartyDetails,
  PartyKind,
  PartyRecord,
  PartySummary,
} from '@ahava88/shared';
import { db } from '../db/client';
import { nextValue } from '../db/sequences';
import { caseParties, cases, parties, partyIndex, type PartyRow } from '../db/schema';
import { httpError } from '../lib/http';
import type { Actor } from '../lib/actor';
import { iso, isoOrNull } from '../lib/time';
import { parse, partyInputSchema, partyUpdateSchema, uuidSchema } from '../validation/schemas';
import { decryptJson, encryptJson } from './privacy.service';
import { indexEntries, nameTokens } from './party-index';
import * as auditService from './audit.service';
import { statusesFor as ficaStatuses } from './fica.service';

export async function partyDetails(row: PartyRow): Promise<PartyDetails> {
  return (await decryptJson<PartyDetails>(row.detailsEncrypted)) ?? { name: '' };
}

export async function toSummary(row: PartyRow, details?: PartyDetails): Promise<PartySummary> {
  const decrypted = details ?? (await partyDetails(row));
  return {
    id: row.id,
    partyNumber: row.partyNumber,
    kind: row.kind as PartyKind,
    name: decrypted.name,
    isClient: row.isClient,
    clientSince: isoOrNull(row.clientSince),
  };
}

async function nextPartyNumber(): Promise<string> {
  return `P-${String(await nextValue('party_number')).padStart(5, '0')}`;
}

/** Replaces a party's blind-index entries. */
async function reindex(partyId: string, details: PartyDetails): Promise<void> {
  await db().delete(partyIndex).where(eq(partyIndex.partyId, partyId));
  const entries = await indexEntries(details);
  if (entries.length) {
    await db()
      .insert(partyIndex)
      .values(entries.map((entry) => ({ partyId, field: entry.field, hash: entry.hash })));
  }
}

export interface CreatePartyOptions {
  isClient?: boolean;
  conflictCheckId?: string;
}

export async function createParty(
  input: unknown,
  actor: Actor,
  options: CreatePartyOptions = {},
): Promise<PartyRow> {
  const { kind, details } = parse(partyInputSchema, input);
  const [saved] = await db()
    .insert(parties)
    .values({
      partyNumber: await nextPartyNumber(),
      kind,
      isClient: Boolean(options.isClient),
      clientSince: options.isClient ? new Date() : null,
      detailsEncrypted: await encryptJson(details),
      conflictCheckId: options.conflictCheckId ?? null,
    })
    .returning();
  if (!saved) {
    throw new Error('Party was not stored');
  }
  await reindex(saved.id, details);
  await auditService.logEvent(
    {
      entityType: 'party',
      entityId: saved.id,
      action: options.isClient ? 'client_created' : 'party_created',
      // Party numbers only: names are personal information.
      summary: `${options.isClient ? 'Client' : 'Party'} ${saved.partyNumber} created`,
      details: { kind, conflictCheckId: options.conflictCheckId ?? null },
    },
    actor,
  );
  return saved;
}

export async function requireParty(id: string): Promise<PartyRow> {
  const [row] = await db()
    .select()
    .from(parties)
    .where(eq(parties.id, parse(uuidSchema, id)))
    .limit(1);
  if (!row) {
    throw httpError('Party not found', 404);
  }
  return row;
}

/** Matters a party is on that the caller can see (RLS hides the rest). */
async function visibleMatters(partyId: string): Promise<PartyRecord['matters']> {
  const rows = await db()
    .select({
      caseId: cases.id,
      caseNumber: cases.caseNumber,
      title: cases.title,
      role: caseParties.role,
    })
    .from(caseParties)
    .innerJoin(cases, eq(cases.id, caseParties.caseId))
    .where(eq(caseParties.partyId, partyId))
    .orderBy(desc(cases.createdAt));
  return rows.map((row) => ({ ...row, role: row.role as MatterPartyRole }));
}

export async function getParty(id: string): Promise<PartyRecord> {
  const row = await requireParty(id);
  const details = await partyDetails(row);
  const statuses = row.isClient ? await ficaStatuses([row.id]) : new Map();
  return {
    ...(await toSummary(row, details)),
    ...(row.isClient ? { ficaStatus: statuses.get(row.id) } : {}),
    details,
    conflictCheckId: row.conflictCheckId,
    matters: await visibleMatters(row.id),
    createdAt: iso(row.createdAt),
  };
}

export async function updateParty(id: string, input: unknown, actor: Actor): Promise<PartyRecord> {
  const { details } = parse(partyUpdateSchema, input);
  const row = await requireParty(id);
  await db()
    .update(parties)
    .set({ detailsEncrypted: await encryptJson(details), updatedAt: new Date() })
    .where(eq(parties.id, row.id));
  await reindex(row.id, details);
  await auditService.logEvent(
    {
      entityType: 'party',
      entityId: row.id,
      action: 'party_updated',
      summary: `Party ${row.partyNumber} details updated`,
    },
    actor,
  );
  return getParty(row.id);
}

/**
 * Finds parties by name (any word), ID/registration number, email or phone,
 * through the blind index. Without a query, the most recent parties.
 */
export async function searchParties(
  query: string | undefined,
  options: { clientsOnly?: boolean; limit?: number } = {},
): Promise<PartySummary[]> {
  const limit = Math.min(options.limit ?? 50, 100);
  const filters = options.clientsOnly ? [eq(parties.isClient, true)] : [];
  let rows: PartyRow[];
  const text = (query ?? '').trim();
  if (!text) {
    rows = await db()
      .select()
      .from(parties)
      .where(and(...filters))
      .orderBy(desc(parties.createdAt))
      .limit(limit);
  } else {
    const looksNumeric = /\d{6,}/.test(text);
    const entries = await indexEntries(
      looksNumeric
        ? { idNumber: text, registrationNumber: text, phone: text }
        : text.includes('@')
          ? { email: text }
          : { name: text },
    );
    const hashes = entries.map((entry) => entry.hash);
    if (!hashes.length) {
      return [];
    }
    const hits = await db()
      .select({ partyId: partyIndex.partyId, field: partyIndex.field })
      .from(partyIndex)
      .where(inArray(partyIndex.hash, hashes));
    // Rank by how many search words matched; a full-name match ranks first.
    const wanted = Math.max(nameTokens(text).length, 1);
    const scores = new Map<string, number>();
    for (const hit of hits) {
      scores.set(hit.partyId, (scores.get(hit.partyId) ?? 0) + (hit.field === 'name' ? 100 : 1));
    }
    const ids = [...scores.entries()]
      .filter(([, score]) => looksNumeric || text.includes('@') || score >= wanted)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);
    if (!ids.length) {
      return [];
    }
    const found = await db()
      .select()
      .from(parties)
      .where(and(inArray(parties.id, ids), ...filters));
    rows = ids
      .map((id) => found.find((row) => row.id === id))
      .filter((row): row is PartyRow => Boolean(row));
  }
  const statuses = await ficaStatuses(rows.filter((row) => row.isClient).map((row) => row.id));
  return Promise.all(
    rows.map(async (row) => ({
      ...(await toSummary(row)),
      ...(row.isClient ? { ficaStatus: statuses.get(row.id) } : {}),
    })),
  );
}

/** Makes an existing party a client (after a cleared conflict check). */
export async function markClient(partyId: string, conflictCheckId: string): Promise<void> {
  await db()
    .update(parties)
    .set({ isClient: true, clientSince: new Date(), conflictCheckId, updatedAt: new Date() })
    .where(eq(parties.id, partyId));
}

// ---------------------------------------------------------------- parties on a matter

export async function listMatterParties(caseId: string): Promise<MatterParty[]> {
  const rows = await db()
    .select({ link: caseParties, party: parties })
    .from(caseParties)
    .innerJoin(parties, eq(parties.id, caseParties.partyId))
    .where(eq(caseParties.caseId, caseId))
    .orderBy(caseParties.createdAt);
  return Promise.all(
    rows.map(async (row) => ({
      role: row.link.role as MatterPartyRole,
      party: await toSummary(row.party),
    })),
  );
}

export async function linkParty(caseId: string, partyId: string, role: MatterPartyRole) {
  await db().insert(caseParties).values({ caseId, partyId, role }).onConflictDoNothing();
}

export async function unlinkParty(caseId: string, partyId: string, role: MatterPartyRole) {
  const removed = await db()
    .delete(caseParties)
    .where(
      and(
        eq(caseParties.caseId, caseId),
        eq(caseParties.partyId, partyId),
        eq(caseParties.role, role),
      ),
    )
    .returning({ id: caseParties.id });
  return removed.length > 0;
}

/** Whether a party is a client of the firm or a client on any matter (all matters). */
export async function isFirmClient(partyId: string): Promise<boolean> {
  const row = await requireParty(partyId);
  if (row.isClient) {
    return true;
  }
  const [link] = await db()
    .select({ id: caseParties.id })
    .from(caseParties)
    .where(and(eq(caseParties.partyId, partyId), eq(caseParties.role, 'client')))
    .limit(1);
  return Boolean(link);
}
