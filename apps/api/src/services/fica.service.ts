// FICA customer due diligence (Financial Intelligence Centre Act).
//
// For each client: a risk profile (factors → rating, which staff may raise
// but not lower), KYC documents, and verification. Verification needs every
// document the client type and risk require; it sets the next review date by
// risk (high 12, medium 24, low 36 months). Files and their names are
// encrypted with the firm's key and kept in the object store when one is
// configured. When the firm turns on `ficaEnforced`, new matters are only
// opened for verified clients (clients.service.ts).
import { randomUUID } from 'crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  FICA_DOCUMENT_TYPES,
  type FicaDocument,
  type FicaDocumentType,
  type FicaProfile,
  type FicaRiskFactors,
  type FicaRiskRating,
  type FicaStatus,
} from '@ahava88/shared';
import { db } from '../db/client';
import { afterCommit, currentFirm } from '../db/tenant-context';
import {
  ficaDocuments,
  ficaProfiles,
  users,
  type FicaDocumentRow,
  type FicaProfileRow,
  type PartyRow,
} from '../db/schema';
import { httpError } from '../lib/http';
import type { Actor } from '../lib/actor';
import { iso, isoOrNull } from '../lib/time';
import { parse, uuidSchema } from '../validation/schemas';
import { decryptJson, encryptJson, payloadKeyVersion } from './privacy.service';
import { firmContainer, objectStore } from './object-store';
import { requireParty } from './party.service';
import * as auditService from './audit.service';

const MAX_BYTES = 10 * 1024 * 1024;

/** File types accepted, with the bytes they must start with. */
const ACCEPTED: Record<string, (bytes: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) =>
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
};

const RANK: Record<FicaRiskRating, number> = { low: 0, medium: 1, high: 2 };
const REVIEW_MONTHS: Record<FicaRiskRating, number> = { high: 12, medium: 24, low: 36 };

const riskSchema = z.object({
  riskFactors: z
    .object({
      politicallyExposed: z.boolean().optional(),
      highRiskJurisdiction: z.boolean().optional(),
      nonFaceToFace: z.boolean().optional(),
      cashIntensive: z.boolean().optional(),
      complexStructure: z.boolean().optional(),
    })
    .strict(),
  riskRating: z.enum(['low', 'medium', 'high']).optional(),
  notes: z.string().trim().max(4_000).optional(),
});

const uploadSchema = z.object({
  docType: z.enum(FICA_DOCUMENT_TYPES),
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().trim().toLowerCase(),
  dataBase64: z
    .string()
    .min(1)
    .max(Math.ceil((MAX_BYTES * 4) / 3) + 16),
});

/** The rating the factors call for. */
export function ratingFor(factors: FicaRiskFactors): FicaRiskRating {
  if (factors.politicallyExposed || factors.highRiskJurisdiction) return 'high';
  if (factors.nonFaceToFace || factors.cashIntensive || factors.complexStructure) return 'medium';
  return 'low';
}

/** Documents needed to verify a client of this kind and risk. */
export function requiredDocuments(kind: string, rating: FicaRiskRating): FicaDocumentType[] {
  const base: FicaDocumentType[] =
    kind === 'entity'
      ? ['company_registration', 'directors_ids', 'beneficial_ownership', 'proof_of_address']
      : ['id_document', 'proof_of_address'];
  return rating === 'high' ? [...base, 'source_of_funds'] : base;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function effectiveStatus(
  profile: Pick<FicaProfileRow, 'status' | 'reviewDue'> | null,
): FicaStatus {
  if (!profile) return 'not_started';
  if (profile.status === 'verified') {
    return profile.reviewDue && profile.reviewDue < today() ? 'review_due' : 'verified';
  }
  return 'in_progress';
}

async function profileRow(partyId: string): Promise<FicaProfileRow | null> {
  const [row] = await db()
    .select()
    .from(ficaProfiles)
    .where(eq(ficaProfiles.partyId, partyId))
    .limit(1);
  return row ?? null;
}

async function ensureProfile(partyId: string): Promise<FicaProfileRow> {
  await db().insert(ficaProfiles).values({ partyId }).onConflictDoNothing();
  return (await profileRow(partyId))!;
}

/** FICA status of many parties at once (client lists). */
export async function statusesFor(partyIds: string[]): Promise<Map<string, FicaStatus>> {
  const rows = partyIds.length
    ? await db().select().from(ficaProfiles).where(inArray(ficaProfiles.partyId, partyIds))
    : [];
  return new Map(
    partyIds.map((id) => [id, effectiveStatus(rows.find((r) => r.partyId === id) ?? null)]),
  );
}

async function documentRows(partyId: string): Promise<FicaDocumentRow[]> {
  return db()
    .select()
    .from(ficaDocuments)
    .where(eq(ficaDocuments.partyId, partyId))
    .orderBy(desc(ficaDocuments.createdAt));
}

async function present(party: PartyRow, row: FicaProfileRow | null): Promise<FicaProfile> {
  const docs = await documentRows(party.id);
  const people = await db()
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .where(
      inArray(
        users.id,
        [row?.verifiedBy, ...docs.map((d) => d.uploadedBy)].filter((id): id is string =>
          Boolean(id),
        ),
      ),
    );
  const nameOf = (id: string | null | undefined) =>
    people.find((p) => p.id === id)?.fullName ?? null;
  const rating = (row?.riskRating ?? 'low') as FicaRiskRating;
  const present = new Set(docs.map((d) => d.docType));
  const documents: FicaDocument[] = await Promise.all(
    docs.map(async (doc) => ({
      id: doc.id,
      docType: doc.docType as FicaDocumentType,
      fileName: (await decryptJson<string>(doc.fileNameEncrypted)) ?? '',
      contentType: doc.contentType,
      sizeBytes: doc.sizeBytes,
      uploadedBy: nameOf(doc.uploadedBy),
      createdAt: iso(doc.createdAt),
    })),
  );
  return {
    partyId: party.id,
    status: effectiveStatus(row),
    riskRating: rating,
    riskFactors: (row?.riskFactors ?? {}) as FicaRiskFactors,
    notes: row?.notesEncrypted ? await decryptJson<string>(row.notesEncrypted) : null,
    documents,
    missing: requiredDocuments(party.kind, rating).filter((type) => !present.has(type)),
    verifiedBy: nameOf(row?.verifiedBy),
    verifiedAt: isoOrNull(row?.verifiedAt ?? null),
    reviewDue: row?.reviewDue ?? null,
  };
}

export async function getProfile(partyId: string): Promise<FicaProfile> {
  const party = await requireParty(partyId);
  return present(party, await profileRow(party.id));
}

export async function assessRisk(
  partyId: string,
  input: unknown,
  actor: Actor,
): Promise<FicaProfile> {
  const { riskFactors, riskRating, notes } = parse(riskSchema, input);
  const party = await requireParty(partyId);
  const existing = await ensureProfile(party.id);
  const computed = ratingFor(riskFactors);
  // Staff may raise the rating, never lower it below what the factors give.
  const rating = riskRating && RANK[riskRating] > RANK[computed] ? riskRating : computed;
  const raised = RANK[rating] > RANK[existing.riskRating as FicaRiskRating];
  const [updated] = await db()
    .update(ficaProfiles)
    .set({
      riskFactors,
      riskRating: rating,
      notesEncrypted: notes ? await encryptJson(notes) : existing.notesEncrypted,
      // A higher risk needs a fresh verification (more documents may be due).
      ...(raised && existing.status === 'verified'
        ? { status: 'in_progress', verifiedAt: null, verifiedBy: null, reviewDue: null }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(ficaProfiles.id, existing.id))
    .returning();
  await auditService.logEvent(
    {
      entityType: 'party',
      entityId: party.id,
      action: 'fica_risk_assessed',
      summary: `FICA risk for ${party.partyNumber}: ${rating}`,
      details: {
        rating,
        factors: riskFactors,
        reverification: raised && existing.status === 'verified',
      },
    },
    actor,
  );
  return present(party, updated ?? existing);
}

export async function uploadDocument(
  partyId: string,
  input: unknown,
  actor: Actor,
): Promise<FicaProfile> {
  const upload = parse(uploadSchema, input);
  const party = await requireParty(partyId);
  const check = ACCEPTED[upload.contentType];
  if (!check) {
    throw httpError('Upload a PDF, JPEG or PNG file', 400);
  }
  const bytes = Buffer.from(upload.dataBase64, 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES) {
    throw httpError('Files must be between 1 byte and 10 MB', 400);
  }
  if (!check(bytes)) {
    throw httpError('The file content does not match its type', 400);
  }
  await ensureProfile(party.id);
  const id = randomUUID();
  const sealed = await encryptJson(bytes.toString('base64'));
  const store = objectStore();
  const storageKey = store ? `fica/${id}` : null;
  await db()
    .insert(ficaDocuments)
    .values({
      id,
      partyId: party.id,
      docType: upload.docType,
      fileNameEncrypted: await encryptJson(upload.fileName),
      contentType: upload.contentType,
      sizeBytes: bytes.length,
      encryptedContent: store ? null : sealed,
      storageKey,
      contentKeyVersion: store ? payloadKeyVersion(sealed) : null,
      uploadedBy: actor.userId ?? null,
    });
  if (store && storageKey) {
    // After the row: if the upload fails, the request (and the row) roll back.
    await store.put(firmContainer(currentFirm().id), storageKey, Buffer.from(sealed, 'utf8'));
  }
  await auditService.logEvent(
    {
      entityType: 'party',
      entityId: party.id,
      action: 'fica_document_uploaded',
      summary: `FICA document for ${party.partyNumber}: ${upload.docType}`,
      details: { documentId: id, docType: upload.docType, sizeBytes: bytes.length },
    },
    actor,
  );
  return getProfile(party.id);
}

async function requireDocument(partyId: string, documentId: string): Promise<FicaDocumentRow> {
  const [row] = await db()
    .select()
    .from(ficaDocuments)
    .where(
      and(eq(ficaDocuments.id, parse(uuidSchema, documentId)), eq(ficaDocuments.partyId, partyId)),
    )
    .limit(1);
  if (!row) {
    throw httpError('Document not found', 404);
  }
  return row;
}

/** The sealed (encrypted) content of a FICA document, wherever it is stored. */
export async function readSealedFica(row: FicaDocumentRow): Promise<string | null> {
  if (row.storageKey) {
    const store = objectStore();
    if (!store) {
      throw new Error('This document is in the object store, but OBJECT_STORE is not configured');
    }
    return (await store.get(firmContainer(row.firmId), row.storageKey)).toString('utf8');
  }
  return row.encryptedContent;
}

export async function downloadDocument(partyId: string, documentId: string, actor: Actor) {
  const party = await requireParty(partyId);
  const row = await requireDocument(party.id, documentId);
  const data = await decryptJson<string>(await readSealedFica(row));
  await auditService.logEvent(
    {
      entityType: 'party',
      entityId: party.id,
      action: 'fica_document_viewed',
      summary: `FICA document opened for ${party.partyNumber}`,
      details: { documentId: row.id, docType: row.docType },
    },
    actor,
  );
  return {
    fileName: (await decryptJson<string>(row.fileNameEncrypted)) ?? 'document',
    contentType: row.contentType,
    bytes: Buffer.from(data ?? '', 'base64'),
  };
}

export async function deleteDocument(partyId: string, documentId: string, actor: Actor) {
  const party = await requireParty(partyId);
  const row = await requireDocument(party.id, documentId);
  await db().delete(ficaDocuments).where(eq(ficaDocuments.id, row.id));
  const profile = await profileRow(party.id);
  if (profile?.status === 'verified') {
    const remaining = new Set((await documentRows(party.id)).map((d) => d.docType));
    const missing = requiredDocuments(party.kind, profile.riskRating as FicaRiskRating).some(
      (type) => !remaining.has(type),
    );
    if (missing) {
      await db()
        .update(ficaProfiles)
        .set({ status: 'in_progress', verifiedAt: null, verifiedBy: null, reviewDue: null })
        .where(eq(ficaProfiles.id, profile.id));
    }
  }
  if (row.storageKey) {
    const key = row.storageKey;
    afterCommit(async () => {
      await objectStore()?.delete(firmContainer(row.firmId), key);
    });
  }
  await auditService.logEvent(
    {
      entityType: 'party',
      entityId: party.id,
      action: 'fica_document_deleted',
      summary: `FICA document removed for ${party.partyNumber}`,
      details: { documentId: row.id, docType: row.docType },
    },
    actor,
  );
  return getProfile(party.id);
}

export async function verify(partyId: string, actor: Actor): Promise<FicaProfile> {
  const party = await requireParty(partyId);
  const row = await ensureProfile(party.id);
  const current = await present(party, row);
  if (current.missing.length) {
    throw httpError(
      `Still needed before verification: ${current.missing.join(', ').replace(/_/g, ' ')}`,
      409,
    );
  }
  const due = new Date();
  due.setMonth(due.getMonth() + REVIEW_MONTHS[current.riskRating]);
  const [updated] = await db()
    .update(ficaProfiles)
    .set({
      status: 'verified',
      verifiedBy: actor.userId ?? null,
      verifiedAt: new Date(),
      reviewDue: due.toISOString().slice(0, 10),
      updatedAt: new Date(),
    })
    .where(eq(ficaProfiles.id, row.id))
    .returning();
  await auditService.logEvent(
    {
      entityType: 'party',
      entityId: party.id,
      action: 'fica_verified',
      summary: `FICA verified for ${party.partyNumber} (${current.riskRating} risk)`,
      details: { rating: current.riskRating, reviewDue: updated?.reviewDue },
    },
    actor,
  );
  return present(party, updated ?? row);
}

/** Throws unless the client is FICA-verified (used when the firm enforces it). */
export async function requireVerified(partyId: string): Promise<void> {
  const status = effectiveStatus(await profileRow(partyId));
  if (status !== 'verified') {
    throw httpError(
      status === 'review_due'
        ? "The client's FICA review is due: re-verify before opening a matter"
        : 'Complete FICA verification for this client before opening a matter',
      409,
    );
  }
}
