// Fetching published court rolls, politely, and reading their text.
//
// A source is a listing page (e.g. a High Court division's "court rolls" page
// on the judiciary website) whose links are roll documents. The sync reads
// the page, keeps links whose titles carry a date in the window and match the
// source's filter (e.g. "Pretoria"), and downloads each one. It identifies
// itself, honours robots.txt, waits between requests, caps sizes and times
// out, and never sends cookies or credentials.
import { createHash } from 'node:crypto';
import { firstDate } from './court-roll-parser';

export interface CourtRollSource {
  /** Court division code (COURT_DIVISIONS in shared). */
  division: string;
  /** The listing page. */
  url: string;
  /** Only links whose title matches (case-insensitive regular expression). */
  match?: string;
  /** At most this many documents per run (default 40). */
  maxDocuments?: number;
}

export interface RollLink {
  url: string;
  title: string;
  rollDate: string | null;
}

export interface FetchedDocument {
  body: Buffer;
  contentType: string;
}

export type Fetcher = (url: string) => Promise<FetchedDocument>;

export const MAX_ROLL_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

/** Sources from COURT_ROLL_SOURCES (a JSON array); none when unset. */
export function configuredSources(raw = process.env.COURT_ROLL_SOURCES): CourtRollSource[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('COURT_ROLL_SOURCES must be a JSON array of { division, url, match? }');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('COURT_ROLL_SOURCES must be a JSON array of { division, url, match? }');
  }
  return parsed.map((item, index) => {
    const source = item as Partial<CourtRollSource>;
    if (typeof source.division !== 'string' || typeof source.url !== 'string') {
      throw new Error(`COURT_ROLL_SOURCES[${index}] needs a division and a url`);
    }
    const url = new URL(source.url);
    if (url.protocol !== 'https:') {
      throw new Error(`COURT_ROLL_SOURCES[${index}] must use https`);
    }
    if (source.match !== undefined) new RegExp(source.match, 'i');
    return {
      division: source.division,
      url: url.toString(),
      match: source.match,
      maxDocuments: source.maxDocuments,
    };
  });
}

export function userAgent(): string {
  return process.env.COURT_ROLL_USER_AGENT?.trim() || 'court-roll-sync/1.0';
}

/** The real fetcher: https only, no cookies, size and time limits. */
export const httpFetcher: Fetcher = async (url) => {
  if (!url.startsWith('https://')) {
    throw new Error('Only https sources are fetched');
  }
  const response = await fetch(url, {
    headers: { 'User-Agent': userAgent(), Accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_ROLL_BYTES) {
    throw new Error('Document is too large');
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_ROLL_BYTES) {
    throw new Error('Document is too large');
  }
  return { body, contentType: response.headers.get('content-type') ?? '' };
};

// ---------------------------------------------------------------- robots.txt

/** Whether robots.txt lets any crawler ("*") fetch a path (longest rule wins). */
export function robotsAllows(robots: string, path: string, agent = userAgent()): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const field = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === 'allow' || field === 'disallow') && current) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: field === 'allow', path: value });
    }
  }
  const name = agent.toLowerCase().split('/')[0]!;
  const group =
    groups.find((candidate) => candidate.agents.some((a) => a !== '*' && name.includes(a))) ??
    groups.find((candidate) => candidate.agents.includes('*'));
  if (!group) return true;
  let best: { allow: boolean; path: string } | null = null;
  for (const rule of group.rules) {
    const pattern = new RegExp(
      `^${rule.path
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\\\$$/, '$')}`,
    );
    if (pattern.test(path) && (!best || rule.path.length > best.path.length)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------- listing pages

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h\d|table)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*/g, '\n');
}

const DOCUMENT_LINK = /\.(pdf|docx|html?|txt)(?:[?#]|$)|download/i;

/** Roll documents linked from a listing page. */
export function rollLinks(html: string, pageUrl: string, match?: string): RollLink[] {
  const filter = match ? new RegExp(match, 'i') : null;
  const links: RollLink[] = [];
  const seen = new Set<string>();
  const anchor = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const found of html.matchAll(anchor)) {
    const href = decodeEntities(found[1]!.trim());
    const title = htmlToText(found[2]!).replace(/\s+/g, ' ').trim();
    if (!title || !DOCUMENT_LINK.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || seen.has(url.toString())) continue;
    if (filter && !filter.test(title)) continue;
    seen.add(url.toString());
    links.push({ url: url.toString(), title, rollDate: firstDate(title) });
  }
  return links;
}

// ---------------------------------------------------------------- reading documents

export function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export type RollFormat = 'pdf' | 'docx' | 'html' | 'text';

export function rollFormat(body: Buffer, contentType = '', name = ''): RollFormat | null {
  if (body.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (body.subarray(0, 4).toString('latin1') === 'PK\u0003\u0004') {
    return /\.docx$/i.test(name) || /officedocument\.wordprocessingml/.test(contentType) || !name
      ? 'docx'
      : null;
  }
  const head = body.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (/html/.test(contentType) || head.startsWith('<!doctype html') || head.startsWith('<html')) {
    return 'html';
  }
  if (/^text\/plain/.test(contentType) || /\.txt$/i.test(name)) return 'text';
  return null;
}

/** A roll's text. PDFs are read with scripting off; .doc (Word 97) isn't supported. */
export async function extractText(body: Buffer, format: RollFormat): Promise<string> {
  if (format === 'pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(body), isEvalSupported: false });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }
  if (format === 'docx') {
    const mammoth = await import('mammoth');
    return (await mammoth.extractRawText({ buffer: body })).value;
  }
  if (format === 'html') {
    return htmlToText(body.toString('utf8'));
  }
  return body.toString('utf8');
}
