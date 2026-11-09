// Moves a firm's encrypted data onto its active data key: legacy v1 values
// (global INTAKE_ENCRYPTION_KEY) and values under retired key versions.
// Runs in small batches, each in its own transaction, so it is safe to stop
// and re-run. Blind indexes are recomputed with the firm's index key on the way.
import { and, count, eq, isNotNull, isNull, ne, not, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { IntakeSubmission } from '../validation/schemas';
import { db } from '../db/client';
import { withTenant } from '../db/tenant';
import {
  conflictChecks,
  documents,
  firmKeys,
  parties,
  submissions,
  users,
  type FirmRow,
} from '../db/schema';
import { activeKey, deleteKey } from './keys.service';
import { blindIndex, decryptJson, encryptJson } from './privacy.service';
import { readSealedContent, writeSealedContent } from './documents.service';

const BATCH = 200;

function notOnVersion(column: AnyPgColumn, version: number): SQL {
  return not(sql`${column} like ${`v2:${version}:%`}`);
}

function staleSubmissions(version: number): SQL {
  return notOnVersion(submissions.rawPayloadEncrypted, version);
}

function staleDocuments(version: number): SQL {
  return or(
    and(isNotNull(documents.encryptedContent), notOnVersion(documents.encryptedContent, version)),
    and(
      isNotNull(documents.storageKey),
      or(isNull(documents.contentKeyVersion), ne(documents.contentKeyVersion, version)),
    ),
  ) as SQL;
}

function staleParties(version: number): SQL {
  return notOnVersion(parties.detailsEncrypted, version);
}

function staleChecks(version: number): SQL {
  return or(
    notOnVersion(conflictChecks.queryEncrypted, version),
    and(
      isNotNull(conflictChecks.decisionNotesEncrypted),
      notOnVersion(conflictChecks.decisionNotesEncrypted, version),
    ),
  ) as SQL;
}

function staleUsers(version: number): SQL {
  return and(
    isNotNull(users.mfaSecretEncrypted),
    notOnVersion(users.mfaSecretEncrypted, version),
  ) as SQL;
}

export interface ReencryptCounts {
  submissions: number;
  documents: number;
  users: number;
  parties: number;
  conflictChecks: number;
}

export interface ReencryptStatus {
  activeVersion: number;
  pending: {
    submissions: number;
    documents: number;
    users: number;
    parties: number;
    conflictChecks: number;
  };
}

/** How much of the current firm's data is not yet on the active key. */
export async function pendingReencryption(): Promise<ReencryptStatus> {
  const { version } = await activeKey('data');
  const [[s], [d], [u], [p], [c]] = await Promise.all([
    db().select({ value: count() }).from(submissions).where(staleSubmissions(version)),
    db().select({ value: count() }).from(documents).where(staleDocuments(version)),
    db().select({ value: count() }).from(users).where(staleUsers(version)),
    db().select({ value: count() }).from(parties).where(staleParties(version)),
    db().select({ value: count() }).from(conflictChecks).where(staleChecks(version)),
  ]);
  return {
    activeVersion: version,
    pending: {
      submissions: s?.value ?? 0,
      documents: d?.value ?? 0,
      users: u?.value ?? 0,
      parties: p?.value ?? 0,
      conflictChecks: c?.value ?? 0,
    },
  };
}

async function reencryptBatch(): Promise<ReencryptCounts> {
  const { version } = await activeKey('data');

  const subs = await db().select().from(submissions).where(staleSubmissions(version)).limit(BATCH);
  for (const row of subs) {
    const raw = await decryptJson<IntakeSubmission>(row.rawPayloadEncrypted);
    if (!raw) continue;
    await db()
      .update(submissions)
      .set({
        rawPayloadEncrypted: await encryptJson(raw),
        emailLookup: await blindIndex(raw.email),
      })
      .where(eq(submissions.id, row.id));
  }

  const docs = await db().select().from(documents).where(staleDocuments(version)).limit(BATCH);
  for (const row of docs) {
    const content = await decryptJson(await readSealedContent(row));
    const sealed = await encryptJson(content);
    if (row.storageKey) {
      // Same key: the stored object is replaced with the new ciphertext.
      const location = await writeSealedContent(row.id, sealed);
      await db()
        .update(documents)
        .set({ contentKeyVersion: location.contentKeyVersion ?? version })
        .where(eq(documents.id, row.id));
    } else {
      await db()
        .update(documents)
        .set({ encryptedContent: sealed })
        .where(eq(documents.id, row.id));
    }
  }

  const people = await db().select().from(users).where(staleUsers(version)).limit(BATCH);
  for (const row of people) {
    const secret = await decryptJson<string>(row.mfaSecretEncrypted);
    await db()
      .update(users)
      .set({ mfaSecretEncrypted: await encryptJson(secret) })
      .where(eq(users.id, row.id));
  }

  const partyRows = await db().select().from(parties).where(staleParties(version)).limit(BATCH);
  for (const row of partyRows) {
    const details = await decryptJson(row.detailsEncrypted);
    await db()
      .update(parties)
      .set({ detailsEncrypted: await encryptJson(details) })
      .where(eq(parties.id, row.id));
  }
  // Party blind indexes use the stable index key, so they need no rebuild.

  const checks = await db().select().from(conflictChecks).where(staleChecks(version)).limit(BATCH);
  for (const row of checks) {
    await db()
      .update(conflictChecks)
      .set({
        queryEncrypted: await encryptJson(await decryptJson(row.queryEncrypted)),
        decisionNotesEncrypted: row.decisionNotesEncrypted
          ? await encryptJson(await decryptJson(row.decisionNotesEncrypted))
          : null,
      })
      .where(eq(conflictChecks.id, row.id));
  }

  return {
    submissions: subs.length,
    documents: docs.length,
    users: people.length,
    parties: partyRows.length,
    conflictChecks: checks.length,
  };
}

/** Re-encrypts all of a firm's data onto its active key. */
export async function reencryptFirm(firm: FirmRow) {
  const total = { submissions: 0, documents: 0, users: 0, parties: 0, conflictChecks: 0 };
  for (;;) {
    const done = await withTenant(firm, () => reencryptBatch(), { system: true });
    total.submissions += done.submissions;
    total.documents += done.documents;
    total.users += done.users;
    total.parties += done.parties;
    total.conflictChecks += done.conflictChecks;
    if (
      !done.submissions &&
      !done.documents &&
      !done.users &&
      !done.parties &&
      !done.conflictChecks
    ) {
      return total;
    }
  }
}

/** Deletes retired data keys that no stored value uses any more. */
export async function pruneRetiredKeys(): Promise<number[]> {
  const retired = await db()
    .select()
    .from(firmKeys)
    .where(and(eq(firmKeys.purpose, 'data'), eq(firmKeys.status, 'retired')));
  const pruned: number[] = [];
  for (const key of retired) {
    const prefix = `v2:${key.version}:%`;
    const [[s], [d], [u]] = await Promise.all([
      db()
        .select({ value: count() })
        .from(submissions)
        .where(sql`${submissions.rawPayloadEncrypted} like ${prefix}`),
      db()
        .select({ value: count() })
        .from(documents)
        .where(
          or(
            sql`${documents.encryptedContent} like ${prefix}`,
            eq(documents.contentKeyVersion, key.version),
          ),
        ),
      db()
        .select({ value: count() })
        .from(users)
        .where(sql`${users.mfaSecretEncrypted} like ${prefix}`),
    ]);
    const [[p], [c]] = await Promise.all([
      db()
        .select({ value: count() })
        .from(parties)
        .where(sql`${parties.detailsEncrypted} like ${prefix}`),
      db()
        .select({ value: count() })
        .from(conflictChecks)
        .where(
          or(
            sql`${conflictChecks.queryEncrypted} like ${prefix}`,
            sql`${conflictChecks.decisionNotesEncrypted} like ${prefix}`,
          ),
        ),
    ]);
    if (!s?.value && !d?.value && !u?.value && !p?.value && !c?.value) {
      await deleteKey(key.id);
      pruned.push(key.version);
    }
  }
  return pruned;
}
