// Matter documents. Bodies are encrypted with the firm's data key; lists
// return only a short preview, and the decrypted content only for a single
// document. With OBJECT_STORE set, the encrypted body lives in the object
// store (Azure Blob Storage in production, one container per firm) and the
// row keeps only its key.
import { randomUUID } from 'crypto';

import { desc, eq } from 'drizzle-orm';
import type { DocumentContent, DocumentRecord } from '@ahava88/shared';
import { db } from '../db/client';
import { documents, type DocumentRow } from '../db/schema';
import { httpError } from '../lib/http';
import { actorName, type Actor } from '../lib/actor';
import { iso, isoOrNull } from '../lib/time';
import { documentSchema, parse } from '../validation/schemas';
import { currentFirm } from '../db/tenant-context';
import { decryptJson, encryptJson, payloadKeyVersion } from './privacy.service';
import { firmContainer, objectStore } from './object-store';
import * as intakeService from './intake.service';
import * as auditService from './audit.service';

const PREVIEW_LENGTH = 180;

/** The encrypted body of a document, wherever it is stored. */
export async function readSealedContent(row: DocumentRow): Promise<string | null> {
  if (row.storageKey) {
    const store = objectStore();
    if (!store) {
      throw new Error('This document is in the object store, but OBJECT_STORE is not configured');
    }
    return (await store.get(firmContainer(row.firmId), row.storageKey)).toString('utf8');
  }
  return row.encryptedContent;
}

/** Stores an encrypted body: in the object store when configured, else in the row. */
export async function writeSealedContent(documentId: string, sealed: string) {
  const store = objectStore();
  if (!store) {
    return { encryptedContent: sealed, storageKey: null, contentKeyVersion: null };
  }
  const storageKey = `documents/${documentId}`;
  await store.put(firmContainer(currentFirm().id), storageKey, Buffer.from(sealed, 'utf8'));
  return { encryptedContent: null, storageKey, contentKeyVersion: payloadKeyVersion(sealed) };
}

async function toPublicDocument(
  row: DocumentRow,
  includeContent: boolean,
): Promise<DocumentRecord> {
  let content: DocumentContent | null = null;
  if (includeContent) {
    content = await decryptJson<DocumentContent>(await readSealedContent(row));
  }

  return {
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
    sharedWithClientAt: isoOrNull(row.sharedWithClientAt),
    content,
  };
}

export async function listDocuments(limit = 200): Promise<DocumentRecord[]> {
  const rows = await db().select().from(documents).orderBy(desc(documents.createdAt)).limit(limit);
  return Promise.all(rows.map((row) => toPublicDocument(row, false)));
}

export async function getDocument(documentId: string): Promise<DocumentRecord | null> {
  const [row] = await db().select().from(documents).where(eq(documents.id, documentId)).limit(1);
  return row ? toPublicDocument(row, true) : null;
}

export async function createDocument(input: unknown, actor: Actor = {}): Promise<DocumentRecord> {
  const document = parse(documentSchema, input);
  const caseRecord = await intakeService.findCaseByRef(document.caseRef);
  if (!caseRecord) {
    throw httpError('Case not found', 404);
  }

  const id = randomUUID();
  const sealed = await encryptJson({
    title: document.title,
    body: document.body,
    metadata: document.metadata,
  } satisfies DocumentContent);
  // Insert first: if the upload then fails, the request (and the row) roll back.
  const [saved] = await db()
    .insert(documents)
    .values({
      id,
      caseId: caseRecord.id,
      caseNumber: caseRecord.caseNumber,
      clientLabel: caseRecord.clientLabel,
      title: document.title,
      documentType: document.documentType,
      tags: document.tags,
      status: document.status,
      encryptedContent: objectStore() ? null : sealed,
      contentPreview: document.body.slice(0, PREVIEW_LENGTH),
      createdBy: actorName(actor),
    })
    .returning();
  if (!saved) {
    throw new Error('Document was not stored');
  }
  const location = await writeSealedContent(id, sealed);
  if (location.storageKey) {
    await db()
      .update(documents)
      .set({ storageKey: location.storageKey, contentKeyVersion: location.contentKeyVersion })
      .where(eq(documents.id, id));
    saved.storageKey = location.storageKey;
    saved.contentKeyVersion = location.contentKeyVersion;
  }

  await auditService.logEvent(
    {
      entityType: 'document',
      entityId: saved.id,
      action: 'document_created',
      summary: `Document created on ${caseRecord.caseNumber}`,
      details: { caseId: caseRecord.id, documentType: saved.documentType },
    },
    actor,
  );

  return toPublicDocument(saved, true);
}

/**
 * Marks a document as signed. NOTE: this records an attorney's approval; it
 * is not an electronic signature (a signature provider comes in a later epic).
 */
export async function signDocument(documentId: string, actor: Actor = {}): Promise<DocumentRecord> {
  const now = new Date();
  const [updated] = await db()
    .update(documents)
    .set({ status: 'signed', signedAt: now, updatedAt: now })
    .where(eq(documents.id, documentId))
    .returning();
  if (!updated) {
    throw httpError('Document not found', 404);
  }

  await auditService.logEvent(
    {
      entityType: 'document',
      entityId: documentId,
      action: 'document_signed',
      summary: 'Document signed',
      details: { caseId: updated.caseId, documentType: updated.documentType },
    },
    actor,
  );

  return toPublicDocument(updated, true);
}
