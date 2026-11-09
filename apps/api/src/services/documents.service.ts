import type { DbRow, RequestBody, Actor } from '../types/db';
import { httpError } from '../lib/http';
import { randomUUID } from 'crypto';
import { getSupabaseClient } from '../config/supabase';
import * as intakeService from './intake.service';
import { decryptJson, encryptJson } from './privacy.service';
import * as auditService from './audit.service';

const memory: Record<string, DbRow[]> = {
  documents: [],
};

function toIso(value = new Date()) {
  return new Date(value).toISOString();
}

async function resolveCase(caseRef: string) {
  if (!caseRef) {
    return null;
  }

  const cases = await intakeService.listCases();
  return (
    cases.find(
      (item) =>
        item.id === caseRef ||
        item.caseNumber === caseRef ||
        item.submissionId === caseRef,
    ) || null
  );
}

async function listRows() {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db
      .from('documents')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      throw error;
    }

    return data || [];
  }

  return [...memory.documents].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
}

async function saveRow(record: DbRow) {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db.from('documents').insert(record).select().single();
    if (error) {
      throw error;
    }

    return data;
  }

  memory.documents.unshift(record);
  return record;
}

function toPublicDocument(row: DbRow, caseRecord?: DbRow | null) {
  if (!row) {
    return null;
  }

  let content = null;
  try {
    content = row.encrypted_content ? decryptJson(row.encrypted_content) : null;
  } catch (error) {
    content = null;
  }

  return {
    id: row.id,
    caseId: row.case_id,
    caseNumber: caseRecord?.caseNumber || row.case_number || null,
    clientLabel: row.client_label,
    title: row.title,
    documentType: row.document_type,
    status: row.status,
    tags: row.tags || [],
    contentPreview: content?.body ? String(content.body).slice(0, 180) : row.content_preview || '',
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    signedAt: row.signed_at,
    content,
  };
}

async function listDocuments() {
  const rows = await listRows();
  const cases = await intakeService.listCases();

  return rows.map((row) =>
    toPublicDocument(
      row,
      cases.find((item) => item.id === row.case_id || item.caseNumber === row.case_number),
    ),
  );
}

async function getDocument(documentId: string) {
  const rows = await listRows();
  const row = rows.find((item) => item.id === documentId);
  if (!row) {
    return null;
  }

  const cases = await intakeService.listCases();
  return toPublicDocument(
    row,
    cases.find((item) => item.id === row.case_id || item.caseNumber === row.case_number),
  );
}

async function createDocument(input: RequestBody = {}, actor: Actor = {}) {
  const title = String(input.title || '').trim();
  const body = String(input.body || '').trim();
  const documentType = String(input.documentType || 'correspondence').trim();
  const caseRef = String(input.caseId || input.caseRef || '').trim();
  const caseRecord = await resolveCase(caseRef);

  if (!title || !body || !caseRecord) {
    throw httpError('title, body, and caseId are required', 400);
  }

  const now = toIso();
  const record = {
    id: randomUUID(),
    case_id: caseRecord.id,
    case_number: caseRecord.caseNumber,
    client_label: caseRecord.clientLabel,
    title,
    document_type: documentType,
    tags: Array.isArray(input.tags) ? input.tags : [],
    status: String(input.status || 'draft').trim(),
    encrypted_content: encryptJson({
      title,
      body,
      metadata: input.metadata || {},
    }),
    content_preview: body.slice(0, 180),
    created_by: actor?.fullName || actor?.email || 'system',
    created_at: now,
    updated_at: now,
    signed_at: input.signedAt || null,
  };

  const saved = await saveRow(record);
  await auditService.logEvent(
    {
      entityType: 'document',
      entityId: saved.id,
      action: 'document_created',
      summary: `Document created: ${title}`,
      details: {
        caseId: caseRecord.id,
        documentType,
      },
    },
    actor,
  );

  return toPublicDocument(saved, caseRecord);
}

async function signDocument(documentId: string, actor: Actor = {}) {
  const rows = await listRows();
  const row = rows.find((item) => item.id === documentId);
  if (!row) {
    throw httpError('Document not found', 404);
  }

  const updated = {
    ...row,
    status: 'signed',
    signed_at: toIso(),
    updated_at: toIso(),
  };

  const db = getSupabaseClient();
  if (db) {
    const { error } = await db
      .from('documents')
      .update({
        status: updated.status,
        signed_at: updated.signed_at,
        updated_at: updated.updated_at,
      })
      .eq('id', documentId);
    if (error) {
      throw error;
    }
  } else {
    const index = memory.documents.findIndex((item) => item.id === documentId);
    if (index >= 0) {
      memory.documents[index] = updated;
    }
  }

  await auditService.logEvent(
    {
      entityType: 'document',
      entityId: documentId,
      action: 'document_signed',
      summary: `Document signed: ${row.title}`,
    },
    actor,
  );

  return getDocument(documentId);
}

async function deleteByCaseIds(caseIds: DbRow[] = []) {
  if (!caseIds.length) {
    return 0;
  }

  const normalized = new Set(caseIds.map((value) => String(value)));
  const db = getSupabaseClient();
  if (db) {
    const { error } = await db.from('documents').delete().in('case_id', [...normalized]);
    if (error) {
      throw error;
    }
  } else {
    memory.documents = memory.documents.filter((doc) => !normalized.has(String(doc.case_id)));
  }

  return normalized.size;
}

export {
  createDocument,
  deleteByCaseIds,
  getDocument,
  listDocuments,
  signDocument,
};
