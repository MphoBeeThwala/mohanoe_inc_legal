// Reads a court roll's text into hearings: case number, date, time,
// courtroom, judge and roll section. Party names and everything else on the
// line are discarded.
//
// Rolls are typed by registrars and vary, but follow a common shape:
//
//   PRETORIA THIS 13 AUGUST 2024              <- the roll's date
//   OPPOSED MOTIONS                           <- section
//   IN COURT 4C AT 10:00                      <- courtroom and time
//   BEFORE THE HONOURABLE JUSTICE KHUMALO J   <- judge
//   076666/23;   10907/22;                    <- case numbers
//   114. WESBANK LTD VS ST AIR PROJECTS 040272/24
//
// Weekly rolls add day headings ("MONDAY, 22 JANUARY 2024", "Thursday, 8 June
// @ 10:00"). Anything not understood is skipped; a case number with no date
// is still reported, and staff enter the date when they accept it.
import { courtCaseKeysIn } from '../lib/court';

export interface ParsedHearing {
  caseKey: string;
  hearingDate: string | null;
  hearingTime: string | null;
  courtroom: string | null;
  judge: string | null;
  section: string | null;
}

export interface ParsedRoll {
  rollDate: string | null;
  hearings: ParsedHearing[];
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const MONTH = `(${MONTHS.join('|')}|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)`;
const DAY_NAME = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)';

function monthIndex(name: string): number {
  const lower = name.toLowerCase();
  return MONTHS.findIndex((month) => month.startsWith(lower.slice(0, 3)));
}

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day || year < 2000 || year > 2100) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * The first date in a title or line: "13 August 2024", "22 - 26 January
 * 2024" (the first day), "29 January - 02 February 2024", or 2024-08-13.
 * A missing year comes from fallbackYear.
 */
export function firstDate(text: string, fallbackYear?: number): string | null {
  const candidates: Array<{ at: number; date: string | null }> = [];
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) {
    candidates.push({
      at: iso.index,
      date: isoDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])),
    });
  }
  const crossMonth = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\s*(?:-|–|to)\\s*\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\s+(\\d{4})`,
    'i',
  ).exec(text);
  if (crossMonth) {
    const startMonth = monthIndex(crossMonth[2]!);
    const endMonth = monthIndex(crossMonth[3]!);
    const year = Number(crossMonth[4]) - (startMonth > endMonth ? 1 : 0);
    candidates.push({
      at: crossMonth.index,
      date: isoDate(year, startMonth, Number(crossMonth[1])),
    });
  }
  const range = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|to|&|and|,)\\s*(?:\\d{1,2}(?:st|nd|rd|th)?\\s*(?:-|–|to|&|and|,)\\s*)*\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\s+(\\d{4})`,
    'i',
  ).exec(text);
  if (range) {
    candidates.push({
      at: range.index,
      date: isoDate(Number(range[3]), monthIndex(range[2]!), Number(range[1])),
    });
  }
  const single = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}(?:,?\\s+(\\d{4}))?\\b`,
    'i',
  ).exec(text);
  if (single && (single[3] || fallbackYear)) {
    candidates.push({
      at: single.index,
      date: isoDate(Number(single[3] ?? fallbackYear), monthIndex(single[2]!), Number(single[1])),
    });
  }
  const found = candidates
    .filter((candidate) => candidate.date)
    // Earliest wins; at the same place, the more specific pattern (added first).
    .sort((a, b) => a.at - b.at);
  return found[0]?.date ?? null;
}

const COURT_LINE =
  /\bIN\s+COURT\s*(?:ROOM)?\s*:?\s*([A-Z]?\d{1,3}[A-Z]?|[A-Z](?:\s+PALACE)?|[A-Z]{1,2}\d?)\b/i;
const COURTROOM = /\bCOURT\s*ROOM\s*:?\s*([A-Z]?\d{1,3}[A-Z]?)\b/i;
const TIME = /(?:\bAT\b|@|\bfrom\b)\s*(\d{1,2})\s*[:hH.]\s*(\d{2})\b/i;
const JUDGE =
  /^\s*BEFORE\s+(?:THE\s+)?(?:HONOURABLE\s+|HON\.?\s+)?(?:MADAM\s+|MR\.?\s+|MS\.?\s+)?(?:ACTING\s+)?(?:JUSTICE\s+|JUDGE\s+)?(.+?)\s*[.:]?\s*$/i;
const DATE_HEADING = new RegExp(`^\\s*(?:${DAY_NAME}\\b|[A-Z ]+\\bTHIS\\b)`, 'i');
const NOT_SECTIONS =
  /HIGH COURT|DIVISION|REPUBLIC|REPUBLIEK|JUDGE'?S|SECRETARY|REGISTRAR|DIRECTIVE|TO ALL|ATTORNEYS|COUNSEL|PRACTITIONERS|ROLL CALL|PAGE\b|^VS$|^AND$/;

function sectionName(line: string): string | null {
  const text = line.trim();
  if (text.length < 4 || text.length > 60) return null;
  if (!/^[A-Z][A-Z &'/-]+$/.test(text)) return null;
  if (NOT_SECTIONS.test(text) || /^(IN COURT|BEFORE)\b/.test(text)) return null;
  if (new RegExp(`^${DAY_NAME}$`, 'i').test(text)) return null;
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^./, (first) => first.toUpperCase());
}

function cleanJudge(raw: string): string | null {
  const name = raw
    .replace(/\s+/g, ' ')
    .replace(/[;,]+$/, '')
    .trim();
  if (!name || name.length > 80 || /\d/.test(name)) return null;
  return name;
}

/** Hearings on a roll, from its text and title. */
export function parseRoll(text: string, title = ''): ParsedRoll {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim());
  let rollDate = firstDate(title);
  if (!rollDate) {
    for (const line of lines.slice(0, 40)) {
      if (/\bTHIS\b/i.test(line) || DATE_HEADING.test(line)) {
        rollDate = firstDate(line);
        if (rollDate) break;
      }
    }
  }
  const year = rollDate ? Number(rollDate.slice(0, 4)) : undefined;

  let date = rollDate;
  let time: string | null = null;
  let courtroom: string | null = null;
  let judges: string[] = [];
  let lastWasJudge = false;
  let section: string | null = null;
  const seen = new Set<string>();
  const hearings: ParsedHearing[] = [];

  for (const line of lines) {
    if (!line) continue;

    if (
      DATE_HEADING.test(line) ||
      (/^\d{1,2}\s/.test(line) && line.length < 40 && !/\d+\/\d+/.test(line))
    ) {
      const heading = firstDate(line, year);
      if (heading) {
        date = heading;
        const at = TIME.exec(line);
        if (at) time = `${at[1]!.padStart(2, '0')}:${at[2]}`;
        continue;
      }
    }

    const court = COURT_LINE.exec(line) ?? COURTROOM.exec(line);
    if (court) {
      courtroom = court[1]!.toUpperCase().replace(/\s+/g, ' ');
      const at = TIME.exec(line);
      time = at ? `${at[1]!.padStart(2, '0')}:${at[2]}` : time;
      judges = [];
      lastWasJudge = false;
      continue;
    }

    const judge = JUDGE.exec(line);
    if (judge && /^\s*BEFORE\b/i.test(line)) {
      const name = cleanJudge(judge[1]!);
      if (name) {
        // A new "before" after case numbers starts a new bench.
        judges = lastWasJudge ? [...judges, name] : [name];
        lastWasJudge = true;
      }
      continue;
    }

    const heading = sectionName(line);
    if (heading) {
      section = heading;
      courtroom = null;
      judges = [];
      lastWasJudge = false;
      continue;
    }

    const keys = courtCaseKeysIn(line);
    if (!keys.length) {
      const at = TIME.exec(line);
      if (at && line.length < 30) time = `${at[1]!.padStart(2, '0')}:${at[2]}`;
      continue;
    }
    lastWasJudge = false;
    for (const caseKey of keys) {
      const hearing: ParsedHearing = {
        caseKey,
        hearingDate: date,
        hearingTime: time,
        courtroom,
        judge: judges.length ? judges.join(' and ') : null,
        section,
      };
      const id = `${caseKey}|${hearing.hearingDate}|${hearing.section}|${hearing.courtroom}`;
      if (!seen.has(id)) {
        seen.add(id);
        hearings.push(hearing);
      }
    }
  }
  return { rollDate, hearings };
}
