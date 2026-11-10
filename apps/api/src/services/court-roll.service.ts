// Court roll sync: published rolls are fetched on a schedule (twice a week by
// default), read into hearings, and matched with every firm's matters by
// court and court case number. Matches go to the matter's team to confirm:
// a roll never changes the calendar by itself, because rolls are amended,
// matters are removed and postponed, and the published roll "does not
// indicate matters that are finalised, struck off, postponed or withdrawn".
//
// - Rolls are public. Platform tables keep only case numbers, courtrooms,
//   times and judges; party names are dropped when the text is read.
// - An amended roll (the same link with new content, or the same division,
//   date and title marked "amended") supersedes the earlier one. Matters that
//   drop off it are flagged "removed" and the team is told; their calendar
//   events stay, for a person to check with the registrar.
// - A roll a firm uploads (e.g. one emailed by a registrar) is matched only
//   with that firm's matters and is not stored.
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import {
  COURT_DIVISIONS,
  type CourtRollMatch,
  type CourtRollMatchStatus,
  type CourtRollUploadResult,
} from '@ahava88/shared';
import { db, rootDb } from '../db/client';
import { withTenant } from '../db/tenant';
import {
  calendarEvents,
  caseMembers,
  cases,
  courtRollDocuments,
  courtRollEntries,
  courtRollMatches,
  firms,
  type CourtRollDocumentRow,
  type CourtRollEntryRow,
  type CourtRollMatchRow,
} from '../db/schema';
import { httpError } from '../lib/http';
import { isUuid } from '../lib/ids';
import type { Actor } from '../lib/actor';
import { iso, localDate } from '../lib/time';
import { courtRollAcceptSchema, courtRollUploadSchema, parse } from '../validation/schemas';
import { parseRoll, type ParsedHearing } from './court-roll-parser';
import {
  configuredSources,
  extractText,
  httpFetcher,
  robotsAllows,
  rollFormat,
  rollLinks,
  sha256,
  MAX_ROLL_BYTES,
  type CourtRollSource,
  type Fetcher,
} from './court-roll-sources';
import {
  insertEvent,
  notifyMatterTeam,
  startOfLocalDay,
  type TeamNotice,
} from './calendar.service';
import { currentFirm } from '../db/tenant-context';
import * as auditService from './audit.service';

const DAY_MS = 86_400_000;

const divisionName = (code: string) =>
  COURT_DIVISIONS.find((division) => division.code === code)?.name ?? code;

export function listingKey(hearing: {
  division: string;
  hearingDate: string | null;
  section: string | null;
  courtroom: string | null;
  hearingTime: string | null;
}): string {
  return [
    hearing.division,
    hearing.hearingDate ?? '',
    hearing.section ?? '',
    hearing.courtroom ?? '',
    hearing.hearingTime ?? '',
  ].join('|');
}

/** "Amended First Weekly Roll (as at 16-1-2024)" and "First Weekly Roll" are the same roll. */
export function rollIdentity(title: string): string {
  return title
    .toLowerCase()
    .replace(/\(as at[^)]*\)/g, ' ')
    .replace(/\b(amended|revised|updated|final|corrected|new|version \d+|v\d+)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- storing rolls (platform)

export interface IncomingRoll {
  source: string;
  division: string;
  url: string;
  title: string;
  body: Buffer;
  contentType: string;
}

export interface IngestResult {
  document: CourtRollDocumentRow;
  /** False when this exact version was already stored. */
  fresh: boolean;
  superseded: CourtRollDocumentRow[];
}

/** Reads and stores one roll document (platform data; no tenant). */
export async function ingestRoll(roll: IncomingRoll): Promise<IngestResult> {
  const contentHash = sha256(roll.body);
  const [existing] = await rootDb()
    .select()
    .from(courtRollDocuments)
    .where(
      and(eq(courtRollDocuments.url, roll.url), eq(courtRollDocuments.contentHash, contentHash)),
    )
    .limit(1);
  if (existing) {
    return { document: existing, fresh: false, superseded: [] };
  }

  let hearings: ParsedHearing[] = [];
  let rollDate: string | null = null;
  let error: string | null = null;
  const format = rollFormat(roll.body, roll.contentType, roll.url);
  try {
    if (!format) throw new Error('Unsupported document type');
    const parsed = parseRoll(await extractText(roll.body, format), roll.title);
    hearings = parsed.hearings;
    rollDate = parsed.rollDate;
  } catch (failure) {
    error = failure instanceof Error ? failure.message.slice(0, 300) : 'Could not read the roll';
  }

  return rootDb().transaction(async (tx) => {
    const [document] = await tx
      .insert(courtRollDocuments)
      .values({
        source: roll.source,
        division: roll.division,
        url: roll.url,
        title: roll.title.slice(0, 300),
        rollDate,
        contentHash,
        contentType: format ?? roll.contentType.slice(0, 100),
        status: error ? 'failed' : 'active',
        entryCount: hearings.length,
        error,
      })
      .returning();
    if (error || !document) {
      return { document: document!, fresh: true, superseded: [] };
    }
    if (hearings.length) {
      await tx.insert(courtRollEntries).values(
        hearings.map((hearing) => ({
          documentId: document.id,
          division: roll.division,
          caseKey: hearing.caseKey,
          hearingDate: hearing.hearingDate,
          hearingTime: hearing.hearingTime,
          courtroom: hearing.courtroom,
          judge: hearing.judge,
          section: hearing.section,
        })),
      );
    }
    // Earlier versions of this roll.
    const candidates = await tx
      .select()
      .from(courtRollDocuments)
      .where(
        and(
          eq(courtRollDocuments.status, 'active'),
          eq(courtRollDocuments.division, roll.division),
          ne(courtRollDocuments.id, document.id),
        ),
      );
    const identity = rollIdentity(roll.title);
    const superseded = candidates.filter(
      (candidate) =>
        candidate.url === roll.url ||
        (rollDate !== null &&
          candidate.rollDate === rollDate &&
          rollIdentity(candidate.title) === identity),
    );
    if (superseded.length) {
      await tx
        .update(courtRollDocuments)
        .set({ status: 'superseded', supersededBy: document.id })
        .where(
          inArray(
            courtRollDocuments.id,
            superseded.map((old) => old.id),
          ),
        );
    }
    return { document, fresh: true, superseded };
  });
}

// ---------------------------------------------------------------- matching with firms

interface Listing {
  caseKey: string;
  division: string;
  hearingDate: string | null;
  hearingTime: string | null;
  courtroom: string | null;
  judge: string | null;
  section: string | null;
}

interface RollRef {
  origin: 'sync' | 'upload';
  documentRef: string;
  documentTitle: string;
}

export interface MatchRun {
  matched: number;
  removed: number;
  emails: number;
}

function hearingText(listing: Listing): string {
  const when = listing.hearingDate
    ? `${listing.hearingDate}${listing.hearingTime ? ` at ${listing.hearingTime}` : ''}`
    : 'a date to be confirmed';
  const where = listing.courtroom ? `, court ${listing.courtroom}` : '';
  return `${listing.section ? `${listing.section} ` : ''}roll, ${divisionName(listing.division)}${where}, ${when}`;
}

/**
 * Records the current firm's matters found on a roll, and flags matters that
 * an amended roll dropped. Runs in the firm's tenant context, seeing every
 * matter (system scope), and tells each matter's team.
 */
async function matchForFirm(
  roll: RollRef,
  listings: Listing[],
  dropped: Listing[] = [],
): Promise<{ run: MatchRun; rows: CourtRollMatchRow[] }> {
  const run: MatchRun = { matched: 0, removed: 0, emails: 0 };
  const rows: CourtRollMatchRow[] = [];
  const keys = [...new Set([...listings, ...dropped].map((listing) => listing.caseKey))];
  if (!keys.length) return { run, rows };
  const divisions = [...new Set([...listings, ...dropped].map((listing) => listing.division))];
  const matters = await db()
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      division: cases.courtDivision,
      key: cases.courtCaseKey,
      onlineKey: cases.courtOnlineKey,
    })
    .from(cases)
    .where(
      and(
        inArray(cases.courtDivision, divisions),
        or(inArray(cases.courtCaseKey, keys), inArray(cases.courtOnlineKey, keys)),
      ),
    );
  if (!matters.length) return { run, rows };
  // The court's case number or the Court Online number.
  const on = (listing: Listing) =>
    matters.filter(
      (candidate) =>
        candidate.division === listing.division &&
        (candidate.key === listing.caseKey || candidate.onlineKey === listing.caseKey),
    );
  // Per matter: what newly appeared and what an amended roll dropped, so a
  // moved hearing is one "listing changed" notice rather than two.
  const appeared = new Map<string, Array<{ listing: Listing; id: string }>>();
  const vanished = new Map<string, Array<{ listing: Listing; id: string; hadEvent: boolean }>>();

  for (const listing of listings) {
    for (const matter of on(listing)) {
      const key = listingKey(listing);
      const [before] = await db()
        .select()
        .from(courtRollMatches)
        .where(and(eq(courtRollMatches.caseId, matter.id), eq(courtRollMatches.listingKey, key)))
        .limit(1);
      const details = {
        origin: roll.origin,
        documentRef: roll.documentRef,
        documentTitle: roll.documentTitle.slice(0, 300),
        judge: listing.judge,
        updatedAt: new Date(),
      };
      let saved: CourtRollMatchRow | undefined;
      if (before) {
        [saved] = await db()
          .update(courtRollMatches)
          .set({ ...details, ...(before.status === 'removed' ? { status: 'new' } : {}) })
          .where(eq(courtRollMatches.id, before.id))
          .returning();
      } else {
        [saved] = await db()
          .insert(courtRollMatches)
          .values({
            caseId: matter.id,
            division: listing.division,
            hearingDate: listing.hearingDate,
            hearingTime: listing.hearingTime,
            courtroom: listing.courtroom,
            section: listing.section,
            listingKey: key,
            ...details,
          })
          .returning();
      }
      if (!saved) continue;
      rows.push(saved);
      if (!before || before.status === 'removed') {
        run.matched += 1;
        appeared.set(matter.id, [...(appeared.get(matter.id) ?? []), { listing, id: saved.id }]);
      }
    }
  }

  for (const listing of dropped) {
    for (const matter of on(listing)) {
      const gone = await db()
        .update(courtRollMatches)
        .set({ status: 'removed', updatedAt: new Date() })
        .where(
          and(
            eq(courtRollMatches.caseId, matter.id),
            eq(courtRollMatches.listingKey, listingKey(listing)),
            inArray(courtRollMatches.status, ['new', 'accepted']),
          ),
        )
        .returning();
      for (const row of gone) {
        run.removed += 1;
        vanished.set(matter.id, [
          ...(vanished.get(matter.id) ?? []),
          { listing, id: row.id, hadEvent: Boolean(row.eventId) },
        ]);
      }
    }
  }

  for (const matter of matters) {
    const added = appeared.get(matter.id) ?? [];
    const removed = vanished.get(matter.id) ?? [];
    if (added.length && removed.length) {
      run.emails += await notifyRollTeam({
        caseId: matter.id,
        subject: `${matter.caseNumber}: court roll listing changed`,
        body: `The amended roll moves matter ${matter.caseNumber}. It was on the ${removed.map((r) => hearingText(r.listing)).join('; ')}. It is now on the ${added.map((a) => hearingText(a.listing)).join('; ')}. ${removed.some((r) => r.hadEvent) ? 'The calendar still shows the old listing until someone accepts the new one. ' : ''}Check the roll (Operations → Calendar → Court rolls).`,
        priority: 'high',
        entityType: 'court_roll_match',
        entityId: added[0]!.id,
      });
      continue;
    }
    for (const { listing, id } of added) {
      run.emails += await notifyRollTeam({
        caseId: matter.id,
        subject: `${matter.caseNumber} is on a court roll`,
        body: `Matter ${matter.caseNumber} appears on the ${hearingText(listing)}. Check the roll and put it on the calendar (Operations → Calendar → Court rolls).`,
        priority: 'high',
        entityType: 'court_roll_match',
        entityId: id,
      });
    }
    for (const { listing, id, hadEvent } of removed) {
      run.emails += await notifyRollTeam({
        caseId: matter.id,
        subject: `${matter.caseNumber} is no longer on an amended roll`,
        body: `Matter ${matter.caseNumber} was on the ${hearingText(listing)}, but is not on the amended roll. ${hadEvent ? 'Its calendar entry has been kept. ' : ''}Check with the registrar before changing the calendar.`,
        priority: 'high',
        entityType: 'court_roll_match',
        entityId: id,
      });
    }
  }
  return { run, rows };
}

/** Staff who also get every court roll notice (Operations → Court rolls). */
async function rollWatchers(): Promise<string[]> {
  return currentFirm().notificationSettings?.courtRollWatcherIds ?? [];
}

/** The matter's team plus the firm's court roll watchers who may see the matter. */
async function notifyRollTeam(notice: TeamNotice): Promise<number> {
  const [matter] = await db()
    .select({ access: cases.access })
    .from(cases)
    .where(eq(cases.id, notice.caseId));
  let watchers = await rollWatchers();
  if (matter?.access !== 'firm' && watchers.length) {
    // A restricted matter's number goes only to watchers on the matter.
    const members = await db()
      .select({ userId: caseMembers.userId })
      .from(caseMembers)
      .where(eq(caseMembers.caseId, notice.caseId));
    const allowed = new Set(members.map((m) => m.userId));
    watchers = watchers.filter((id) => allowed.has(id));
  }
  return notifyMatterTeam({ ...notice, alsoUserIds: watchers });
}

/**
 * Daily: listings in the next two days that nobody has confirmed yet get a
 * reminder to the matter's team and watchers (once per listing).
 */
export async function remindUnconfirmed(now = new Date()): Promise<number> {
  const today = localDate(now);
  const soon = localDate(new Date(now.getTime() + 2 * 86_400_000));
  const due = await db()
    .select({ match: courtRollMatches, caseNumber: cases.caseNumber })
    .from(courtRollMatches)
    .innerJoin(cases, eq(cases.id, courtRollMatches.caseId))
    .where(
      and(
        eq(courtRollMatches.status, 'new'),
        isNull(courtRollMatches.remindedAt),
        sql`${courtRollMatches.hearingDate} between ${today} and ${soon}`,
      ),
    );
  let emails = 0;
  for (const { match, caseNumber } of due) {
    emails += await notifyRollTeam({
      caseId: match.caseId,
      subject: `${caseNumber}: court roll listing not yet confirmed`,
      body: `Matter ${caseNumber} is on the ${hearingText({
        caseKey: '',
        division: match.division,
        hearingDate: match.hearingDate,
        hearingTime: match.hearingTime,
        courtroom: match.courtroom,
        judge: match.judge,
        section: match.section,
      })}, and nobody has confirmed it on the calendar yet. Check the roll and accept or dismiss the match.`,
      priority: 'high',
      entityType: 'court_roll_match',
      entityId: match.id,
    });
    await db()
      .update(courtRollMatches)
      .set({ remindedAt: now })
      .where(eq(courtRollMatches.id, match.id));
  }
  return emails;
}

const toListing = (entry: CourtRollEntryRow): Listing => ({
  caseKey: entry.caseKey,
  division: entry.division,
  hearingDate: entry.hearingDate,
  hearingTime: entry.hearingTime,
  courtroom: entry.courtroom,
  judge: entry.judge,
  section: entry.section,
});

/** Matches newly stored rolls (and amendments) with every active firm. */
export async function matchAllFirms(results: IngestResult[]): Promise<MatchRun> {
  const total: MatchRun = { matched: 0, removed: 0, emails: 0 };
  const work: Array<{ roll: RollRef; listings: Listing[]; dropped: Listing[] }> = [];
  for (const result of results.filter((item) => item.fresh && item.document.status === 'active')) {
    const entries = await rootDb()
      .select()
      .from(courtRollEntries)
      .where(eq(courtRollEntries.documentId, result.document.id));
    const listings = entries.map(toListing);
    const present = new Set(listings.map((listing) => `${listing.caseKey}|${listingKey(listing)}`));
    const dropped: Listing[] = [];
    for (const old of result.superseded) {
      for (const entry of await rootDb()
        .select()
        .from(courtRollEntries)
        .where(eq(courtRollEntries.documentId, old.id))) {
        const listing = toListing(entry);
        if (!present.has(`${listing.caseKey}|${listingKey(listing)}`)) dropped.push(listing);
      }
    }
    work.push({
      roll: {
        origin: 'sync',
        documentRef: result.document.url,
        documentTitle: result.document.title,
      },
      listings,
      dropped,
    });
  }
  if (!work.length) return total;

  const active = await rootDb().select().from(firms).where(eq(firms.status, 'active'));
  for (const firm of active) {
    const run = await withTenant(
      firm,
      async () => {
        const firmRun: MatchRun = { matched: 0, removed: 0, emails: 0 };
        for (const item of work) {
          const { run: one } = await matchForFirm(item.roll, item.listings, item.dropped);
          firmRun.matched += one.matched;
          firmRun.removed += one.removed;
          firmRun.emails += one.emails;
        }
        return firmRun;
      },
      { system: true },
    );
    total.matched += run.matched;
    total.removed += run.removed;
    total.emails += run.emails;
  }
  return total;
}

// ---------------------------------------------------------------- the scheduled sync

export interface SyncOptions {
  sources?: CourtRollSource[];
  fetcher?: Fetcher;
  now?: Date;
  /** Pause between requests to the same site (default 2 s). */
  pause?: (ms: number) => Promise<void>;
  /** Roll dates kept: from this many days ago (default 7) ... */
  daysBack?: number;
  /** ... to this many ahead (default 90). */
  daysAhead?: number;
}

export interface SourceReport {
  url: string;
  division: string;
  listed: number;
  fetched: number;
  stored: number;
  unchanged: number;
  failed: number;
  skipped?: string;
  error?: string;
}

export interface SyncReport extends MatchRun {
  sources: SourceReport[];
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function syncCourtRolls(options: SyncOptions = {}): Promise<SyncReport> {
  const sources = options.sources ?? configuredSources();
  const fetcher = options.fetcher ?? httpFetcher;
  const pause = options.pause ?? wait;
  const now = options.now ?? new Date();
  const from = localDate(new Date(now.getTime() - (options.daysBack ?? 7) * DAY_MS));
  const to = localDate(new Date(now.getTime() + (options.daysAhead ?? 90) * DAY_MS));
  const robotsCache = new Map<string, string>();
  const results: IngestResult[] = [];
  const reports: SourceReport[] = [];

  const allowed = async (url: string) => {
    const { origin, pathname, search } = new URL(url);
    if (!robotsCache.has(origin)) {
      try {
        robotsCache.set(origin, (await fetcher(`${origin}/robots.txt`)).body.toString('utf8'));
      } catch {
        robotsCache.set(origin, '');
      }
    }
    return robotsAllows(robotsCache.get(origin)!, `${pathname}${search}`);
  };

  for (const source of sources) {
    const report: SourceReport = {
      url: source.url,
      division: source.division,
      listed: 0,
      fetched: 0,
      stored: 0,
      unchanged: 0,
      failed: 0,
    };
    reports.push(report);
    try {
      if (!(await allowed(source.url))) {
        report.skipped = 'robots.txt does not allow the listing page';
        continue;
      }
      const page = await fetcher(source.url);
      const links = rollLinks(page.body.toString('utf8'), source.url, source.match)
        .filter((link) => link.rollDate && link.rollDate >= from && link.rollDate <= to)
        .slice(0, source.maxDocuments ?? 40);
      report.listed = links.length;
      for (const link of links) {
        if (!(await allowed(link.url))) continue;
        await pause(2_000);
        let body: Buffer;
        let contentType: string;
        try {
          ({ body, contentType } = await fetcher(link.url));
        } catch {
          report.failed += 1;
          continue;
        }
        report.fetched += 1;
        if (body.length > MAX_ROLL_BYTES) {
          report.failed += 1;
          continue;
        }
        const result = await ingestRoll({
          source: source.url,
          division: source.division,
          url: link.url,
          title: link.title,
          body,
          contentType,
        });
        if (!result.fresh) report.unchanged += 1;
        else if (result.document.status === 'failed') report.failed += 1;
        else report.stored += 1;
        results.push(result);
      }
    } catch (failure) {
      report.error = failure instanceof Error ? failure.message : 'failed';
    }
  }
  return { sources: reports, ...(await matchAllFirms(results)) };
}

// ---------------------------------------------------------------- the firm's view

async function present(
  rows: Array<{ match: CourtRollMatchRow; caseNumber: string; courtCaseNumber: string | null }>,
): Promise<CourtRollMatch[]> {
  const onCalendar = new Set<string>();
  const caseIds = [...new Set(rows.map((row) => row.match.caseId))];
  if (caseIds.length) {
    const events = await db()
      .select({ caseId: calendarEvents.caseId, startsAt: calendarEvents.startsAt })
      .from(calendarEvents)
      .where(
        and(
          inArray(calendarEvents.caseId, caseIds),
          eq(calendarEvents.eventType, 'court_date'),
          eq(calendarEvents.status, 'scheduled'),
        ),
      );
    for (const event of events) onCalendar.add(`${event.caseId}|${localDate(event.startsAt)}`);
  }
  return rows.map(({ match, caseNumber, courtCaseNumber }) => ({
    id: match.id,
    caseId: match.caseId,
    caseNumber,
    courtCaseNumber,
    origin: match.origin as CourtRollMatch['origin'],
    documentUrl: match.origin === 'sync' ? match.documentRef : null,
    documentTitle: match.documentTitle,
    division: match.division,
    hearingDate: match.hearingDate,
    hearingTime: match.hearingTime,
    courtroom: match.courtroom,
    judge: match.judge,
    section: match.section,
    status: match.status as CourtRollMatchStatus,
    onCalendar: Boolean(
      match.hearingDate && onCalendar.has(`${match.caseId}|${match.hearingDate}`),
    ),
    eventId: match.eventId,
    createdAt: iso(match.createdAt),
    updatedAt: iso(match.updatedAt),
  }));
}

const matchColumns = {
  match: courtRollMatches,
  caseNumber: cases.caseNumber,
  courtCaseNumber: cases.courtCaseNumber,
};

export async function listMatches(
  query: { status?: string; caseId?: string } = {},
): Promise<CourtRollMatch[]> {
  const conditions = [];
  if (query.status && query.status !== 'all') {
    conditions.push(eq(courtRollMatches.status, query.status));
  } else if (!query.status) {
    conditions.push(inArray(courtRollMatches.status, ['new', 'removed']));
  }
  if (query.caseId && isUuid(query.caseId))
    conditions.push(eq(courtRollMatches.caseId, query.caseId));
  const rows = await db()
    .select(matchColumns)
    .from(courtRollMatches)
    .innerJoin(cases, eq(cases.id, courtRollMatches.caseId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(sql`${courtRollMatches.hearingDate} asc nulls last`, desc(courtRollMatches.createdAt))
    .limit(500);
  return present(rows);
}

async function requireMatch(id: string) {
  if (!isUuid(id)) throw httpError('Court roll match not found', 404);
  const [row] = await db()
    .select(matchColumns)
    .from(courtRollMatches)
    .innerJoin(cases, eq(cases.id, courtRollMatches.caseId))
    .where(eq(courtRollMatches.id, id))
    .limit(1);
  if (!row) throw httpError('Court roll match not found', 404);
  return row;
}

/** Puts a roll listing on the matter's calendar as a court date. */
export async function acceptMatch(
  id: string,
  input: unknown,
  actor: Actor = {},
): Promise<CourtRollMatch> {
  const choice = parse(courtRollAcceptSchema, input ?? {});
  const { match, caseNumber } = await requireMatch(id);
  if (match.status !== 'new') {
    throw httpError(`This listing is already ${match.status}`, 409);
  }
  let startsAt: Date;
  let allDay = false;
  if (choice.startsAt) {
    startsAt = new Date(choice.startsAt);
  } else if (match.hearingDate && match.hearingTime) {
    startsAt = new Date(`${match.hearingDate}T${match.hearingTime}:00+02:00`);
  } else if (match.hearingDate) {
    startsAt = startOfLocalDay(match.hearingDate);
    allDay = true;
  } else {
    throw httpError('The roll gives no date: enter the date and time', 400);
  }
  const event = await insertEvent(
    {
      caseId: match.caseId,
      caseNumber,
      eventType: 'court_date',
      title: `${match.section ?? 'Court roll'} (from the court roll)`,
      startsAt,
      allDay,
      location: [match.courtroom ? `Court ${match.courtroom}` : null, divisionName(match.division)]
        .filter(Boolean)
        .join(', '),
      notes: [
        match.judge ? `Before ${match.judge}.` : null,
        `Roll: ${match.documentTitle}.`,
        'Rolls change: check amended rolls and directives before the hearing.',
      ]
        .filter(Boolean)
        .join(' '),
      assigneeUserId: choice.assigneeUserId ?? null,
      source: 'court_roll',
      sourceRef: match.id,
    },
    actor,
  );
  await db()
    .update(courtRollMatches)
    .set({
      status: 'accepted',
      eventId: event.id,
      reviewedBy: actor.userId ?? null,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(courtRollMatches.id, match.id));
  return (await present([await requireMatch(match.id)]))[0]!;
}

export async function dismissMatch(id: string, actor: Actor = {}): Promise<CourtRollMatch> {
  const { match, caseNumber } = await requireMatch(id);
  if (match.status === 'accepted') {
    throw httpError('Cancel the calendar entry instead', 409);
  }
  await db()
    .update(courtRollMatches)
    .set({
      status: 'dismissed',
      reviewedBy: actor.userId ?? null,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(courtRollMatches.id, match.id));
  await auditService.logEvent(
    {
      entityType: 'court_roll_match',
      entityId: match.id,
      action: 'court_roll_match_dismissed',
      summary: `Court roll listing dismissed on ${caseNumber}`,
      details: { caseId: match.caseId, hearingDate: match.hearingDate },
    },
    actor,
  );
  return (await present([await requireMatch(match.id)]))[0]!;
}

/**
 * Reads a roll the firm has (e.g. emailed by a registrar) and matches it with
 * the firm's matters. Not stored and not shared with other firms.
 */
export async function uploadRoll(
  input: unknown,
  actor: Actor = {},
): Promise<CourtRollUploadResult> {
  const upload = parse(courtRollUploadSchema, input);
  const body = Buffer.from(upload.contentBase64, 'base64');
  if (!body.length || body.length > 10 * 1024 * 1024) {
    throw httpError('The roll must be a file of up to 10 MB', 400);
  }
  const format = rollFormat(body, upload.contentType, upload.fileName);
  if (!format) {
    throw httpError('Upload the roll as a PDF, Word (.docx), HTML or text file', 400);
  }
  let parsed;
  try {
    parsed = parseRoll(await extractText(body, format), upload.title ?? upload.fileName);
  } catch {
    throw httpError('The roll could not be read', 400);
  }
  const listings: Listing[] = parsed.hearings.map((hearing) => ({
    ...hearing,
    division: upload.division,
  }));
  const { rows } = await matchForFirm(
    {
      origin: 'upload',
      documentRef: `upload:${sha256(body)}`,
      documentTitle: upload.title ?? upload.fileName,
    },
    listings,
  );
  // No file name: it may name people.
  await auditService.logEvent(
    {
      entityType: 'court_roll',
      entityId: sha256(body).slice(0, 32),
      action: 'court_roll_uploaded',
      summary: 'Court roll uploaded and matched',
      details: { division: upload.division, hearings: listings.length, matches: rows.length },
    },
    actor,
  );
  const visible = rows.length
    ? await db()
        .select(matchColumns)
        .from(courtRollMatches)
        .innerJoin(cases, eq(cases.id, courtRollMatches.caseId))
        .where(
          inArray(
            courtRollMatches.id,
            rows.map((row) => row.id),
          ),
        )
    : [];
  return { hearings: listings.length, matches: await present(visible) };
}

/** Imports a roll file for every firm (ops CLI: a roll received another way). */
export async function importRollFile(roll: {
  division: string;
  title: string;
  fileName: string;
  body: Buffer;
}): Promise<SyncReport> {
  const result = await ingestRoll({
    source: 'manual',
    division: roll.division,
    url: `manual:${sha256(roll.body)}`,
    title: roll.title,
    body: roll.body,
    contentType: roll.fileName,
  });
  return {
    sources: [
      {
        url: 'manual',
        division: roll.division,
        listed: 1,
        fetched: 1,
        stored: result.fresh && result.document.status === 'active' ? 1 : 0,
        unchanged: result.fresh ? 0 : 1,
        failed: result.document.status === 'failed' ? 1 : 0,
        error: result.document.error ?? undefined,
      },
    ],
    ...(await matchAllFirms([result])),
  };
}

/** Optional in-process schedule (COURT_ROLL_SYNC_INTERVAL_HOURS); a scheduled job is better. */
export function scheduleCourtRollSync(): NodeJS.Timeout | null {
  const hours = Number(process.env.COURT_ROLL_SYNC_INTERVAL_HOURS ?? 0);
  if (!Number.isFinite(hours) || hours <= 0 || !configuredSources().length) {
    return null;
  }
  const timer = setInterval(() => {
    syncCourtRolls().catch((error: unknown) =>
      console.error('Court roll sync failed:', error instanceof Error ? error.message : error),
    );
  }, hours * 3_600_000);
  timer.unref();
  return timer;
}

/** The daily reminder for every active firm (run with `ops reminders`). */
export async function remindUnconfirmedForAllFirms(now = new Date()) {
  const all = await rootDb().select().from(firms).where(eq(firms.status, 'active'));
  let emails = 0;
  for (const firm of all) {
    emails += await withTenant(firm, () => remindUnconfirmed(now), { system: true });
  }
  return emails;
}
