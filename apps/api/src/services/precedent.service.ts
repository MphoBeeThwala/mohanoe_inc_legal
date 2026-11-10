// The firm's own precedents (opinions, heads of argument, memos) as a
// research source. On upload the text is de-identified by pattern and title
// rules (a precedent names no matter, so there is no party list to match);
// it stays in review, unsearchable, until someone has checked the
// de-identified text and an attorney (research.approve) approves it.
import { desc, eq } from 'drizzle-orm';
import type { Precedent, PrecedentStatus } from '@ahava88/shared';
import { db } from '../db/client';
import { firmPrecedents, precedentPassages, type FirmPrecedentRow } from '../db/schema';
import { httpError } from '../lib/http';
import type { Actor } from '../lib/actor';
import { iso, isoOrNull } from '../lib/time';
import { isUuid } from '../lib/ids';
import { z } from 'zod';
import { parse } from '../validation/schemas';
import { decryptJson, encryptJson } from './privacy.service';
import { deidentify, remainingIdentifiers, type Replacement } from './deidentify';
import { splitPassages } from './corpus.service';
import * as auditService from './audit.service';

const uploadSchema = z.object({
  title: z.string().trim().min(1).max(200),
  practiceArea: z.string().trim().max(100).optional(),
  text: z.string().trim().min(20, 'The precedent has no text').max(400_000),
});
const textSchema = z.object({ text: z.string().trim().min(20).max(400_000) });

interface Review {
  warnings: string[];
  replacements: Replacement[];
}

async function toPrecedent(row: FirmPrecedentRow): Promise<Precedent> {
  const passages = await db()
    .select({ text: precedentPassages.text })
    .from(precedentPassages)
    .where(eq(precedentPassages.precedentId, row.id))
    .orderBy(precedentPassages.ordinal);
  const review = (await decryptJson<Review>(row.reviewEncrypted)) ?? {
    warnings: [],
    replacements: [],
  };
  return {
    id: row.id,
    title: row.title,
    practiceArea: row.practiceArea,
    status: row.status as PrecedentStatus,
    text: passages.map((p) => p.text).join('\n\n'),
    warnings: review.warnings,
    replacements: review.replacements,
    createdAt: iso(row.createdAt),
    approvedAt: isoOrNull(row.approvedAt),
  };
}

async function storePassages(precedentId: string, text: string) {
  await db().delete(precedentPassages).where(eq(precedentPassages.precedentId, precedentId));
  const passages = splitPassages(text, 'other');
  if (passages.length) {
    await db()
      .insert(precedentPassages)
      .values(
        passages.map((p, ordinal) => ({
          precedentId,
          ordinal,
          pinpoint: p.pinpoint,
          text: p.text,
        })),
      );
  }
}

export async function upload(input: unknown, actor: Actor): Promise<Precedent> {
  const { title, practiceArea, text } = parse(uploadSchema, input);
  const result = deidentify(text);
  const [row] = await db()
    .insert(firmPrecedents)
    .values({
      // The title is shown in citations: de-identified as well.
      title: deidentify(title).text,
      practiceArea: practiceArea ?? '',
      originalEncrypted: await encryptJson(text),
      reviewEncrypted: await encryptJson({
        warnings: result.warnings,
        replacements: result.replacements,
      } satisfies Review),
      createdBy: actor.userId ?? null,
    })
    .returning();
  await storePassages(row!.id, result.text);
  await auditService.logEvent(
    {
      entityType: 'precedent',
      entityId: row!.id,
      action: 'precedent_uploaded',
      summary: 'Precedent uploaded for research (in review)',
      details: { identifiersRemoved: result.replacements.reduce((n, r) => n + r.count, 0) },
    },
    actor,
  );
  return toPrecedent(row!);
}

export async function list(): Promise<Precedent[]> {
  const rows = await db().select().from(firmPrecedents).orderBy(desc(firmPrecedents.createdAt));
  return Promise.all(rows.map(toPrecedent));
}

async function requirePrecedent(id: string): Promise<FirmPrecedentRow> {
  const [row] = isUuid(id)
    ? await db().select().from(firmPrecedents).where(eq(firmPrecedents.id, id))
    : [];
  if (!row) throw httpError('Precedent not found', 404);
  return row;
}

export async function get(id: string): Promise<Precedent> {
  return toPrecedent(await requirePrecedent(id));
}

/** The reviewer's corrected de-identified text (checked again). */
export async function updateText(id: string, input: unknown, actor: Actor): Promise<Precedent> {
  const { text } = parse(textSchema, input);
  const row = await requirePrecedent(id);
  if (row.status !== 'review') {
    throw httpError('An approved precedent cannot be edited; upload a new version.', 409);
  }
  const left = remainingIdentifiers(text);
  if (left.length) {
    throw httpError(
      `The text still contains personal information (${[...new Set(left.map((r) => r.token.replace(/[[\]]/g, '')))].join(', ')}).`,
      422,
    );
  }
  const previous = await decryptJson<Review>(row.reviewEncrypted);
  await storePassages(row.id, text);
  const [saved] = await db()
    .update(firmPrecedents)
    .set({
      reviewEncrypted: await encryptJson({
        warnings: deidentify(text).warnings,
        replacements: previous?.replacements ?? [],
      } satisfies Review),
      updatedAt: new Date(),
    })
    .where(eq(firmPrecedents.id, row.id))
    .returning();
  await auditService.logEvent(
    {
      entityType: 'precedent',
      entityId: row.id,
      action: 'precedent_edited',
      summary: 'Precedent text corrected in review',
      details: {},
    },
    actor,
  );
  return toPrecedent(saved!);
}

export async function approve(id: string, actor: Actor): Promise<Precedent> {
  const row = await requirePrecedent(id);
  if (row.status !== 'review') throw httpError('Already approved', 409);
  const [saved] = await db()
    .update(firmPrecedents)
    .set({
      status: 'approved',
      approvedBy: actor.userId ?? null,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(firmPrecedents.id, row.id))
    .returning();
  await auditService.logEvent(
    {
      entityType: 'precedent',
      entityId: row.id,
      action: 'precedent_approved',
      summary: 'Precedent approved as a research source',
      details: {},
    },
    actor,
  );
  return toPrecedent(saved!);
}

export async function remove(id: string, actor: Actor): Promise<void> {
  const row = await requirePrecedent(id);
  await db().delete(firmPrecedents).where(eq(firmPrecedents.id, row.id));
  await auditService.logEvent(
    {
      entityType: 'precedent',
      entityId: row.id,
      action: 'precedent_deleted',
      summary: 'Precedent removed from research sources',
      details: {},
    },
    actor,
  );
}
