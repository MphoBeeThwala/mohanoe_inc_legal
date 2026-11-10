// The approved legal corpus (roadmap §7.4) and search over it.
//
// - A source (legislation feed, law reports, a tribunal's decisions...) is
//   registered by a platform operator with the licence or written permission
//   that allows its use. Only approved sources are searched; suspending one
//   takes it out of research immediately.
// - Documents carry the hierarchy of authority (1 Constitutional Court ...
//   6 commentary) and temporal validity (effective date, repealed/overruled).
//   Repealed or overruled material is never offered to the model.
// - Search is PostgreSQL full-text search, weighted by authority level, over
//   approved public passages and the firm's approved precedents.
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  SOURCE_KINDS,
  type ApprovedSource,
  type CitedSource,
  type SourceKind,
  type SourceValidity,
} from '@ahava88/shared';
import { db, rootDb } from '../db/client';
import {
  firmPrecedents,
  legalDocuments,
  legalPassages,
  legalSources,
  precedentPassages,
} from '../db/schema';
import { httpError } from '../lib/http';

// ------------------------------------------------------------------ passages

export interface Passage {
  pinpoint: string;
  text: string;
  repealed?: boolean;
}

const MAX_PASSAGE = 2400;

/** Long text broken at sentence ends so passages stay citable and small. */
function chunk(pinpoint: string, text: string): Passage[] {
  const clean = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (clean.length <= MAX_PASSAGE) {
    return clean ? [{ pinpoint, text: clean }] : [];
  }
  const out: Passage[] = [];
  let rest = clean;
  let part = 1;
  while (rest.length > MAX_PASSAGE) {
    const window = rest.slice(0, MAX_PASSAGE);
    const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'), MAX_PASSAGE / 2);
    out.push({
      pinpoint: `${pinpoint} (part ${part})`.trim(),
      text: rest.slice(0, cut + 1).trim(),
    });
    rest = rest.slice(cut + 1);
    part += 1;
  }
  if (rest.trim()) out.push({ pinpoint: `${pinpoint} (part ${part})`.trim(), text: rest.trim() });
  return out;
}

const SECTION_START = /^\s*(?:section\s+)?(\d{1,3}[A-Z]{0,2})\.?\s+(?=[A-Z(])/i;
const PARA_START = /^\s*\[(\d{1,4})\]\s+/;

/**
 * Splits plain text into passages: numbered sections for legislation and
 * rules ("12. ...", "Section 12 ..."), numbered paragraphs for judgments
 * ("[23] ..."), otherwise blank-line paragraphs.
 */
export function splitPassages(text: string, kind: SourceKind): Passage[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const judgment = kind === 'case_law' || kind === 'tribunal';
  const marker = judgment ? PARA_START : SECTION_START;
  const label = judgment ? 'para' : kind === 'rules' ? 'rule' : 'section';
  const passages: Passage[] = [];
  let current: { pinpoint: string; lines: string[] } = { pinpoint: '', lines: [] };
  let found = 0;
  const flush = () => {
    passages.push(...chunk(current.pinpoint, current.lines.join('\n')));
  };
  for (const line of lines) {
    const match = line.match(marker);
    if (match) {
      flush();
      found += 1;
      current = { pinpoint: `${label} ${match[1]}`, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  if (found >= 2) {
    return passages.filter((p) => p.text);
  }
  // No numbering: paragraphs.
  return text
    .split(/\n\s*\n/)
    .flatMap((paragraph, index) => chunk(`paragraph ${index + 1}`, paragraph))
    .filter((p) => p.text);
}

// ------------------------------------------------------------------- sources

export interface SourceInput {
  code: string;
  name: string;
  kind: string;
  publisher?: string;
  url?: string;
  licence: string;
  permission?: string;
  approvedBy: string;
}

/** Platform administration (ops CLI): register or update an approved source. */
export async function upsertSource(input: SourceInput) {
  const code = input.code.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(code)) {
    throw httpError('Source code: lower-case letters, digits and dashes', 400);
  }
  if (!(SOURCE_KINDS as readonly string[]).includes(input.kind)) {
    throw httpError(`Source kind must be one of ${SOURCE_KINDS.join(', ')}`, 400);
  }
  if (!input.licence.trim() || !input.approvedBy.trim()) {
    throw httpError('A source needs the licence or terms relied on and who approved it', 400);
  }
  const values = {
    name: input.name.trim(),
    kind: input.kind,
    publisher: input.publisher?.trim() ?? '',
    url: input.url?.trim() ?? '',
    licence: input.licence.trim(),
    permission: input.permission?.trim() ?? '',
    approvedBy: input.approvedBy.trim(),
    status: 'approved',
    approvedAt: new Date(),
    updatedAt: new Date(),
  };
  const [saved] = await rootDb()
    .insert(legalSources)
    .values({ code, ...values })
    .onConflictDoUpdate({ target: legalSources.code, set: values })
    .returning();
  return saved!;
}

export async function setSourceStatus(code: string, status: 'approved' | 'suspended') {
  const rows = await rootDb()
    .update(legalSources)
    .set({ status, updatedAt: new Date() })
    .where(eq(legalSources.code, code))
    .returning({ code: legalSources.code });
  return rows.length > 0;
}

export async function listAllSources() {
  return rootDb().select().from(legalSources).orderBy(legalSources.code);
}

/** For staff: what research may draw on (approved sources only). */
export async function approvedSources(): Promise<ApprovedSource[]> {
  const rows = await db()
    .select({
      code: legalSources.code,
      name: legalSources.name,
      kind: legalSources.kind,
      publisher: legalSources.publisher,
      url: legalSources.url,
      licence: legalSources.licence,
      documents: sql<number>`(select count(*)::int from legal_documents d where d.source_id = "legal_sources"."id")`,
    })
    .from(legalSources)
    .where(eq(legalSources.status, 'approved'))
    .orderBy(legalSources.name);
  return rows.map((row) => ({ ...row, kind: row.kind as SourceKind }));
}

// ----------------------------------------------------------------- documents

export interface DocumentInput {
  title: string;
  citation: string;
  url?: string;
  jurisdiction?: string;
  versionDate?: string | null;
  authorityLevel?: number;
  court?: string;
  effectiveDate?: string | null;
  validity?: SourceValidity;
  repealedDate?: string | null;
  /** Plain text (split into passages) or passages already split. */
  text?: string;
  passages?: Passage[];
}

const DEFAULT_LEVEL: Record<string, number> = {
  legislation: 4,
  regulation: 4,
  rules: 5,
  practice_directive: 5,
  case_law: 3,
  tribunal: 6,
  guidance: 6,
  journal: 6,
  treatise: 6,
  other: 6,
};

/** Court codes in SA neutral citations, mapped to the hierarchy. */
export function authorityFromCitation(citation: string): number | null {
  if (/\bZACC\b/.test(citation)) return 1;
  if (/\bZASCA\b/.test(citation)) return 2;
  if (/\bZA(?:GP|WC|KZ|EC|FS|NC|NW|LP|MP|LC|LAC|LCC|TC|CAC|EQ)[A-Z]*\b/.test(citation)) return 3;
  return null;
}

const VALIDITY = ['in_force', 'amended', 'repealed', 'not_commenced', 'overruled'];

/**
 * Imports (or refreshes) one document of an approved source. Unchanged text
 * is left alone; changed text replaces its passages.
 */
export async function importDocument(sourceCode: string, input: DocumentInput) {
  const [source] = await rootDb()
    .select()
    .from(legalSources)
    .where(eq(legalSources.code, sourceCode));
  if (!source) {
    throw httpError(`No source "${sourceCode}"`, 404);
  }
  const passages = (
    input.passages ?? splitPassages(input.text ?? '', source.kind as SourceKind)
  ).filter((p) => p.text.trim());
  if (!input.title.trim() || !input.citation.trim() || passages.length === 0) {
    throw httpError('A document needs a title, a citation and some text', 400);
  }
  const validity =
    input.validity && VALIDITY.includes(input.validity) ? input.validity : 'in_force';
  const contentHash = createHash('sha256')
    .update(JSON.stringify({ passages, validity, repealed: input.repealedDate ?? null }))
    .digest('hex');
  const values = {
    title: input.title.trim(),
    url: input.url?.trim() ?? '',
    jurisdiction: input.jurisdiction?.trim() || 'South Africa',
    versionDate: input.versionDate ?? null,
    authorityLevel:
      input.authorityLevel ??
      authorityFromCitation(input.citation) ??
      DEFAULT_LEVEL[source.kind] ??
      6,
    court: input.court?.trim() ?? '',
    effectiveDate: input.effectiveDate ?? null,
    validity,
    repealedDate: input.repealedDate ?? null,
    contentHash,
    updatedAt: new Date(),
  };
  return rootDb().transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(legalDocuments)
      .where(
        and(
          eq(legalDocuments.sourceId, source.id),
          eq(legalDocuments.citation, input.citation.trim()),
        ),
      );
    if (existing?.contentHash === contentHash) {
      return { document: existing, changed: false, passages: 0 };
    }
    const [document] = existing
      ? await tx
          .update(legalDocuments)
          .set(values)
          .where(eq(legalDocuments.id, existing.id))
          .returning()
      : await tx
          .insert(legalDocuments)
          .values({ sourceId: source.id, citation: input.citation.trim(), ...values })
          .returning();
    await tx.delete(legalPassages).where(eq(legalPassages.documentId, document!.id));
    await tx.insert(legalPassages).values(
      passages.map((passage, ordinal) => ({
        documentId: document!.id,
        ordinal,
        pinpoint: passage.pinpoint,
        text: passage.text,
        repealed: Boolean(passage.repealed),
      })),
    );
    return { document: document!, changed: true, passages: passages.length };
  });
}

// -------------------------------------------------------------------- search

export interface SearchHit extends Omit<CitedSource, 'ref'> {
  key: string;
  rank: number;
}

/** Words of the queries, joined so any of them matches (ranked by how many do). */
function tsQuery(queries: string[]): string {
  const words = new Set<string>();
  for (const query of queries) {
    for (const word of query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
      words.add(word);
    }
  }
  return [...words].slice(0, 40).join(' OR ');
}

/**
 * The best passages for the queries: approved public sources (in force,
 * weighted by authority) and the firm's approved precedents.
 */
export async function search(queries: string[], limit = 12): Promise<SearchHit[]> {
  const terms = tsQuery(queries);
  if (!terms) {
    return [];
  }
  const query = sql`websearch_to_tsquery('english', ${terms})`;
  // Level 1 counts 2x, level 6 1x.
  const weight = sql`(1 + (6 - ${legalDocuments.authorityLevel}) / 5.0)`;
  const publicRows = await db()
    .select({
      id: legalPassages.id,
      text: legalPassages.text,
      pinpoint: legalPassages.pinpoint,
      title: legalDocuments.title,
      citation: legalDocuments.citation,
      url: legalDocuments.url,
      versionDate: legalDocuments.versionDate,
      authorityLevel: legalDocuments.authorityLevel,
      court: legalDocuments.court,
      validity: legalDocuments.validity,
      effectiveDate: legalDocuments.effectiveDate,
      sourceName: legalSources.name,
      kind: legalSources.kind,
      rank: sql<number>`ts_rank(${legalPassages.search}, ${query}) * ${weight}`,
    })
    .from(legalPassages)
    .innerJoin(legalDocuments, eq(legalDocuments.id, legalPassages.documentId))
    .innerJoin(legalSources, eq(legalSources.id, legalDocuments.sourceId))
    .where(
      and(
        eq(legalSources.status, 'approved'),
        inArray(legalDocuments.validity, ['in_force', 'amended']),
        eq(legalPassages.repealed, false),
        sql`${legalPassages.search} @@ ${query}`,
      ),
    )
    .orderBy(
      sql`ts_rank(${legalPassages.search}, ${query}) * ${weight} desc`,
      legalDocuments.authorityLevel,
    )
    .limit(limit);

  const precedentRows = await db()
    .select({
      id: precedentPassages.id,
      text: precedentPassages.text,
      pinpoint: precedentPassages.pinpoint,
      title: firmPrecedents.title,
      rank: sql<number>`ts_rank(${precedentPassages.search}, ${query})`,
    })
    .from(precedentPassages)
    .innerJoin(firmPrecedents, eq(firmPrecedents.id, precedentPassages.precedentId))
    .where(and(eq(firmPrecedents.status, 'approved'), sql`${precedentPassages.search} @@ ${query}`))
    .orderBy(sql`ts_rank(${precedentPassages.search}, ${query}) desc`)
    .limit(Math.ceil(limit / 3));

  const hits: SearchHit[] = [
    ...publicRows.map((row) => ({
      key: `passage:${row.id}`,
      rank: Number(row.rank),
      kind: row.kind as SourceKind,
      sourceName: row.sourceName,
      title: row.title,
      citation: row.citation,
      pinpoint: row.pinpoint,
      url: row.url,
      versionDate: row.versionDate,
      authorityLevel: row.authorityLevel,
      court: row.court,
      validity: row.validity as SourceValidity,
      effectiveDate: row.effectiveDate,
      text: row.text,
    })),
    ...precedentRows.map((row) => ({
      key: `precedent:${row.id}`,
      rank: Number(row.rank) * 0.8,
      kind: 'precedent' as const,
      sourceName: 'Firm precedent',
      title: row.title,
      citation: `Firm precedent: ${row.title}`,
      pinpoint: row.pinpoint,
      url: '',
      versionDate: null,
      authorityLevel: 6,
      court: '',
      validity: 'in_force' as const,
      effectiveDate: null,
      text: row.text,
    })),
  ];
  // Stronger authority first among equally relevant passages.
  return hits
    .sort((a, b) => b.rank - a.rank || a.authorityLevel - b.authorityLevel)
    .slice(0, limit);
}
