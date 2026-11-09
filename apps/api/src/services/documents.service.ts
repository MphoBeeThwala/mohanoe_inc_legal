// Matter documents. Bodies are encrypted at rest; lists return only a short
// preview, and the decrypted content only for a single document.
// (Real file storage in Azure Blob Storage arrives in roadmap epic 6.)

import { desc, eq } from 'drizzle-orm';
import type { DocumentContent, DocumentRecord } from '@ahava88/shared';
import { db } from '../db/client';
import { documents, type DocumentRow } from '../db/schema';
import { httpError } from '../lib/http';
import { actorName, type Actor } from '../lib/actor';
import { iso, isoOrNull } from '../lib/time';
import { documentSchema, parse } from '../validation/schemas';
import { decryptJson, encryptJson } from './privacy.service';
import * as intakeService from './intake.service';
import * as auditService from './audit.service';

const PREVIEW_LENGTH = 180;

function toPublicDocument(row: DocumentRow, includeContent: boolean): DocumentRecord {
  let content: DocumentContent | null = null;
  if (includeContent) {
    try {
      content = decryptJson<DocumentContent>(row.encryptedContent);
    } catch {
      content = null;
    }
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
    content,
  };
}

export async function listDocuments(limit = 200): Promise<DocumentRecord[]> {
  const rows = await db().select().from(documents).orderBy(desc(documents.createdAt)).limit(limit);
  return rows.map((row) => toPublicDocument(row, false));
}

export async function getDocument(documentId: string): Promise<DocumentRecord | null> {
  const [row] = await db().select().from(documents).where(eq(documents.id, documentId)).limit(1);
  return row ? toPublicDocument(row, true) : null;
}

export async function createDocument(input: unknown, actor: Actor = {}): Promise<DocumentRecord> {
  const document = parse(documentSchema, input);
  const caseRecord = await intakeService.findCaseByRef(document.caseRef);
  if (!caseRecord) {
    throw httpError('title, body, and caseId are required', 400);
  }

  const [saved] = await db()
    .insert(documents)
    .values({
      caseId: caseRecord.id,
      caseNumber: caseRecord.caseNumber,
      clientLabel: caseRecord.clientLabel,
      title: document.title,
      documentType: document.documentType,
      tags: document.tags,
      status: document.status,
      encryptedContent: encryptJson({
        title: document.title,
        body: document.body,
        metadata: document.metadata,
      } satisfies DocumentContent),
      contentPreview: document.body.slice(0, PREVIEW_LENGTH),
      createdBy: actorName(actor),
    })
    .returning();
  if (!saved) {
    throw new Error('Document was not stored');
  }

  await auditService.logEvent(
    {
      entityType: 'document',
      entityId: saved.id,
      action: 'document_created',
      summary: `Document created: ${saved.title}`,
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
      summary: `Document signed: ${updated.title}`,
    },
    actor,
  );

  return toPublicDocument(updated, true);
}
