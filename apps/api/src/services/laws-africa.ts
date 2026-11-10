// Laws.Africa Content API (https://developers.laws.africa): consolidated,
// machine-readable South African legislation (Akoma Ntoso). Needs an account
// token (LAWS_AFRICA_TOKEN) and the source registered with the terms of that
// account (`ops sources add --code laws-africa ...`).
//
// Sync is polite: one request at a time with a pause, and works whose
// expression date hasn't changed are not fetched again.
import { and, eq } from 'drizzle-orm';
import type { SourceValidity } from '@ahava88/shared';
import { rootDb } from '../db/client';
import { legalDocuments, legalSources } from '../db/schema';
import { importDocument, type Passage } from './corpus.service';

const API = 'https://api.laws.africa/v3';

export interface LawsAfricaWork {
  url?: string;
  frbr_uri?: string;
  expression_frbr_uri?: string;
  title?: string;
  numbered_title?: string | null;
  nature?: string;
  subtype?: string | null;
  year?: string;
  number?: string;
  expression_date?: string | null;
  commenced?: boolean;
  commencement_date?: string | null;
  repeal?: { date?: string | null } | null;
  amendments?: unknown[];
  stub?: boolean;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const decode = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d|tr|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();

/** Akoma Ntoso HTML → one passage per section (subsections stay inside it). */
export function passagesFromAknHtml(html: string): Passage[] {
  const parts = html.split(/<section\b(?=[^>]*\bclass="[^"]*\bakn-section\b)/i);
  const passages: Passage[] = [];
  for (const part of parts.slice(1)) {
    const eid = part.match(/data-eid="([^"]+)"/i)?.[1] ?? '';
    const number = eid.match(/sec_([\w-]+)$/)?.[1]?.replace(/-/g, '');
    const heading = decode(part.match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/i)?.[1] ?? '');
    const text = decode(`<section${part}`);
    if (!text) continue;
    passages.push({
      pinpoint: number ? `section ${number}` : heading.slice(0, 60),
      text,
      // A provision repealed inside an act that is still in force.
      repealed: text.length < 400 && /\[(?:[^\]]*\b)?repealed\b/i.test(text),
    });
  }
  if (passages.length === 0) {
    const text = decode(html);
    if (text) passages.push({ pinpoint: '', text });
  }
  return passages;
}

/** "Act 55 of 1998" from /akn/za/act/1998/55, else the numbered title or title. */
export function citationFor(work: LawsAfricaWork): string {
  if (work.numbered_title) return work.numbered_title;
  const match = (work.frbr_uri ?? '').match(/\/act\/(\d{4})\/([\w-]+)$/);
  if (match && !work.subtype) return `Act ${match[2]} of ${match[1]}`;
  return work.title ?? work.frbr_uri ?? 'Untitled';
}

export function validityFor(work: LawsAfricaWork): SourceValidity {
  if (work.repeal) return 'repealed';
  if (work.commenced === false) return 'not_commenced';
  if (Array.isArray(work.amendments) && work.amendments.length) return 'amended';
  return 'in_force';
}

export interface SyncResult {
  seen: number;
  imported: number;
  unchanged: number;
  skipped: number;
  failed: number;
}

export async function syncLawsAfrica(options: {
  token: string;
  sourceCode?: string;
  place?: string;
  limit?: number;
  pauseMs?: number;
  fetcher?: Fetcher;
  userAgent?: string;
}): Promise<SyncResult> {
  const sourceCode = options.sourceCode ?? 'laws-africa';
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const pause = options.pauseMs ?? 500;
  const headers = {
    authorization: `Bearer ${options.token}`,
    accept: 'application/json',
    'user-agent':
      options.userAgent || process.env.COURT_ROLL_USER_AGENT || 'LegalPracticeResearch/1.0',
  };
  const [source] = await rootDb()
    .select()
    .from(legalSources)
    .where(eq(legalSources.code, sourceCode));
  if (!source || source.status !== 'approved') {
    throw new Error(`Source "${sourceCode}" is not registered and approved (ops sources add).`);
  }

  const result: SyncResult = { seen: 0, imported: 0, unchanged: 0, skipped: 0, failed: 0 };
  let url: string | null = `${API}/akn/${options.place ?? 'za'}/.json`;
  while (url && (!options.limit || result.seen < options.limit)) {
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`Laws.Africa answered ${response.status} for the work list`);
    }
    const page = (await response.json()) as { results?: LawsAfricaWork[]; next?: string | null };
    for (const work of page.results ?? []) {
      if (options.limit && result.seen >= options.limit) break;
      result.seen += 1;
      if (work.stub || !work.url || !work.title) {
        result.skipped += 1;
        continue;
      }
      const citation = citationFor(work);
      const [existing] = await rootDb()
        .select({ versionDate: legalDocuments.versionDate, validity: legalDocuments.validity })
        .from(legalDocuments)
        .where(and(eq(legalDocuments.sourceId, source.id), eq(legalDocuments.citation, citation)));
      if (
        existing &&
        existing.versionDate === (work.expression_date ?? null) &&
        existing.validity === validityFor(work)
      ) {
        result.unchanged += 1;
        continue;
      }
      try {
        await sleep(pause);
        const html = await fetcher(`${work.url}.html`, {
          headers: { ...headers, accept: 'text/html' },
          signal: AbortSignal.timeout(60_000),
        });
        if (!html.ok) throw new Error(`HTML ${html.status}`);
        const passages = passagesFromAknHtml(await html.text());
        const imported = await importDocument(sourceCode, {
          title: work.title,
          citation,
          url: work.frbr_uri ? `https://lawlibrary.org.za${work.frbr_uri}` : '',
          versionDate: work.expression_date ?? null,
          effectiveDate: work.commencement_date ?? null,
          validity: validityFor(work),
          repealedDate: work.repeal?.date ?? null,
          authorityLevel: 4,
          court: work.subtype ? '' : 'Parliament',
          passages,
        });
        if (imported.changed) result.imported += 1;
        else result.unchanged += 1;
      } catch (error) {
        result.failed += 1;
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'laws_africa_work_failed',
            work: work.frbr_uri,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    url = page.next ?? null;
    if (url) await sleep(pause);
  }
  return result;
}
