// The firm's calendar: court dates, deadlines, prescription last days and
// meetings on matters, with reminders by email and in the app.
//
// - Title, location and notes can name people, so they are encrypted with
//   the firm's data key (events from before epic 7 keep their clear columns).
// - Reminders go to the event's assignee, or else the matter's team. They
//   carry the matter number, type, date and a link, never the title.
// - Events from a prescription follow it (their date changes there);
//   events from a court roll can be edited like any other.
import { and, asc, eq, gte, inArray, lte, ne, type SQL } from 'drizzle-orm';
import {
  CALENDAR_EVENT_LABELS,
  DEFAULT_REMINDERS,
  STAFF_ROLES,
  type CalendarEvent,
  type CalendarEventSource,
  type CalendarEventStatus,
  type CalendarEventType,
  type UpcomingItem,
  type UserRole,
} from '@ahava88/shared';
import { db, rootDb } from '../db/client';
import { withTenant } from '../db/tenant';
import { currentFirm } from '../db/tenant-context';
import {
  calendarEvents,
  caseMembers,
  firms,
  notifications,
  users,
  type CalendarEventRow,
} from '../db/schema';
import { httpError } from '../lib/http';
import { isUuid } from '../lib/ids';
import { actorName, type Actor } from '../lib/actor';
import { iso, isoOrNull, FIRM_TIME_ZONE } from '../lib/time';
import { calendarEventSchema, calendarEventUpdateSchema, parse } from '../validation/schemas';
import { decryptJson, encryptJson } from './privacy.service';
import { getFirmBrand } from '../config/brand';
import { firmOrigin } from './firm.service';
import { sendMail } from './mail.service';
import * as caseService from './case.service';
import * as intakeService from './intake.service';
import * as auditService from './audit.service';

interface EventContent {
  title: string;
  location: string;
  notes: string;
}

const MINUTE = 60_000;
/** Reminders more than this late (e.g. after downtime) are skipped, not sent. */
const STALE_AFTER_MS = 6 * 60 * MINUTE;

/** Midnight in South Africa (UTC+2, no DST) at the start of a calendar date. */
export function startOfLocalDay(date: string): Date {
  return new Date(`${date}T00:00:00+02:00`);
}

function localDateTime(value: Date): string {
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone: FIRM_TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value);
}

function localDay(value: Date): string {
  return new Intl.DateTimeFormat('en-ZA', { timeZone: FIRM_TIME_ZONE, dateStyle: 'full' }).format(
    value,
  );
}

async function content(row: CalendarEventRow): Promise<EventContent> {
  if (row.contentEncrypted) {
    return (
      (await decryptJson<EventContent>(row.contentEncrypted)) ?? {
        title: '',
        location: '',
        notes: '',
      }
    );
  }
  return { title: row.title, location: row.location, notes: row.notes };
}

async function formatEvent(row: CalendarEventRow, assigneeName: string | null = null) {
  const details = await content(row);
  const event: CalendarEvent = {
    id: row.id,
    caseId: row.caseId,
    caseNumber: row.caseNumber,
    title: details.title,
    eventType: row.eventType,
    startsAt: iso(row.startsAt),
    endsAt: isoOrNull(row.endsAt),
    allDay: row.allDay,
    location: details.location,
    notes: details.notes,
    status: row.status as CalendarEventStatus,
    source: row.source as CalendarEventSource,
    assigneeUserId: row.assigneeUserId,
    assigneeName,
    reminderOffsets: row.reminderOffsets,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
  };
  return event;
}

async function present(rows: CalendarEventRow[]): Promise<CalendarEvent[]> {
  const ids = [...new Set(rows.map((row) => row.assigneeUserId).filter(isUuid))];
  const names = new Map<string, string>();
  if (ids.length) {
    for (const person of await db()
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .where(inArray(users.id, ids))) {
      names.set(person.id, person.fullName);
    }
  }
  return Promise.all(
    rows.map((row) =>
      formatEvent(row, row.assigneeUserId ? (names.get(row.assigneeUserId) ?? null) : null),
    ),
  );
}

async function requireAssignee(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const [person] = await db().select().from(users).where(eq(users.id, userId)).limit(1);
  if (!person || !person.isActive || !STAFF_ROLES.includes(person.role as UserRole)) {
    throw httpError('Assignee not found', 404);
  }
  if (person.role === 'support') {
    throw httpError('Platform support cannot be assigned events', 400);
  }
  return person.id;
}

// ---------------------------------------------------------------- reading

export interface EventQuery {
  from?: string;
  to?: string;
  caseId?: string;
  /** Only events assigned to this user. */
  assigneeUserId?: string;
  includeClosed?: boolean;
  limit?: number;
}

export async function listEvents(query: EventQuery | number = {}): Promise<CalendarEvent[]> {
  const options = typeof query === 'number' ? { limit: query, includeClosed: true } : query;
  const conditions: SQL[] = [];
  if (options.from) conditions.push(gte(calendarEvents.startsAt, startOfLocalDay(options.from)));
  if (options.to) {
    const end = startOfLocalDay(options.to);
    conditions.push(lte(calendarEvents.startsAt, new Date(end.getTime() + 1440 * MINUTE - 1)));
  }
  if (options.caseId) conditions.push(eq(calendarEvents.caseId, options.caseId));
  if (options.assigneeUserId) {
    conditions.push(eq(calendarEvents.assigneeUserId, options.assigneeUserId));
  }
  if (!options.includeClosed) conditions.push(eq(calendarEvents.status, 'scheduled'));
  const rows = await db()
    .select()
    .from(calendarEvents)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(calendarEvents.startsAt))
    .limit(Math.min(Math.max(options.limit ?? 500, 1), 1000));
  return present(rows);
}

async function requireEvent(id: string): Promise<CalendarEventRow> {
  if (!isUuid(id)) {
    throw httpError('Event not found', 404);
  }
  const [row] = await db().select().from(calendarEvents).where(eq(calendarEvents.id, id)).limit(1);
  if (!row) {
    throw httpError('Event not found', 404);
  }
  return row;
}

export async function getEvent(id: string): Promise<CalendarEvent> {
  return (await present([await requireEvent(id)]))[0]!;
}

/** Upcoming scheduled events (from the start of today) merged with open task due dates. */
export async function getUpcomingEvents(limit = 8): Promise<UpcomingItem[]> {
  const startOfToday = startOfLocalDay(
    new Intl.DateTimeFormat('en-CA', { timeZone: FIRM_TIME_ZONE }).format(new Date()),
  );
  const [rows, tasks] = await Promise.all([
    db()
      .select()
      .from(calendarEvents)
      .where(
        and(gte(calendarEvents.startsAt, startOfToday), eq(calendarEvents.status, 'scheduled')),
      )
      .orderBy(asc(calendarEvents.startsAt))
      .limit(limit),
    caseService.listDueTasks(limit),
  ]);
  const items: UpcomingItem[] = [
    ...(await present(rows)),
    ...tasks.map((task) => ({
      id: `task-${task.id}`,
      type: 'task' as const,
      caseId: task.caseId,
      title: task.title,
      startsAt: task.dueDate as string,
      status: task.status,
      assigneeName: task.assigneeName,
    })),
  ];
  return items.sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, limit);
}

// ---------------------------------------------------------------- writing

export interface NewEvent {
  caseId: string;
  caseNumber: string;
  eventType: CalendarEventType;
  title: string;
  startsAt: Date;
  endsAt?: Date | null;
  allDay?: boolean;
  location?: string;
  notes?: string;
  assigneeUserId?: string | null;
  reminderOffsets?: number[];
  source?: CalendarEventSource;
  sourceRef?: string | null;
}

/** Stores an event (used by the API, prescriptions and court rolls). */
export async function insertEvent(event: NewEvent, actor: Actor = {}): Promise<CalendarEventRow> {
  const [saved] = await db()
    .insert(calendarEvents)
    .values({
      caseId: event.caseId,
      caseNumber: event.caseNumber,
      eventType: event.eventType,
      contentEncrypted: await encryptJson({
        title: event.title,
        location: event.location ?? '',
        notes: event.notes ?? '',
      } satisfies EventContent),
      startsAt: event.startsAt,
      endsAt: event.endsAt ?? null,
      allDay: event.allDay ?? false,
      assigneeUserId: event.assigneeUserId ?? null,
      reminderOffsets: event.reminderOffsets ?? DEFAULT_REMINDERS[event.eventType] ?? [],
      source: event.source ?? 'manual',
      sourceRef: event.sourceRef ?? null,
      createdBy: actorName(actor),
    })
    .returning();
  if (!saved) {
    throw new Error('Calendar event was not stored');
  }
  // No title: audit rows are not encrypted.
  await auditService.logEvent(
    {
      entityType: 'calendar_event',
      entityId: saved.id,
      action: 'calendar_event_created',
      summary: `${CALENDAR_EVENT_LABELS[event.eventType] ?? 'Event'} added to ${event.caseNumber}`,
      details: { caseId: event.caseId, eventType: event.eventType, source: saved.source },
    },
    actor,
  );
  return saved;
}

function eventTimes(input: { startsAt: string; endsAt?: string | null; allDay?: boolean }) {
  if (input.allDay) {
    return { startsAt: startOfLocalDay(input.startsAt.slice(0, 10)), endsAt: null };
  }
  return {
    startsAt: new Date(input.startsAt),
    endsAt: input.endsAt ? new Date(input.endsAt) : null,
  };
}

export async function createEvent(input: unknown, actor: Actor = {}): Promise<CalendarEvent> {
  const event = parse(calendarEventSchema, input);
  const matter = await intakeService.findCaseByRef(event.caseId);
  if (!matter) {
    throw httpError('Case not found', 404);
  }
  const saved = await insertEvent(
    {
      caseId: matter.id,
      caseNumber: matter.caseNumber,
      eventType: event.eventType,
      title: event.title,
      ...eventTimes(event),
      allDay: event.allDay,
      location: event.location,
      notes: event.notes,
      assigneeUserId: await requireAssignee(event.assigneeUserId),
      reminderOffsets: event.reminderOffsets,
    },
    actor,
  );
  return (await present([saved]))[0]!;
}

export async function updateEvent(
  id: string,
  input: unknown,
  actor: Actor = {},
): Promise<CalendarEvent> {
  const changes = parse(calendarEventUpdateSchema, input);
  const row = await requireEvent(id);
  const fromPrescription = row.source === 'prescription';
  if (
    fromPrescription &&
    (changes.startsAt !== undefined ||
      changes.eventType !== undefined ||
      changes.allDay !== undefined)
  ) {
    throw httpError("Change a prescription's dates on the prescription itself", 409);
  }
  const current = await content(row);
  const allDay = changes.allDay ?? row.allDay;
  const times =
    changes.startsAt !== undefined || changes.allDay !== undefined || changes.endsAt !== undefined
      ? eventTimes({
          startsAt: changes.startsAt ?? iso(row.startsAt),
          // Moving the start without a new end keeps the event's length.
          endsAt:
            changes.endsAt !== undefined
              ? changes.endsAt
              : row.endsAt && changes.startsAt
                ? new Date(
                    Date.parse(changes.startsAt) + (row.endsAt.getTime() - row.startsAt.getTime()),
                  ).toISOString()
                : isoOrNull(row.endsAt),
          allDay,
        })
      : null;
  if (times?.endsAt && times.endsAt < times.startsAt) {
    throw httpError('The end must be after the start', 400);
  }
  const moved = times !== null && times.startsAt.getTime() !== row.startsAt.getTime();
  const [saved] = await db()
    .update(calendarEvents)
    .set({
      ...(changes.title !== undefined ||
      changes.location !== undefined ||
      changes.notes !== undefined
        ? {
            contentEncrypted: await encryptJson({
              title: changes.title ?? current.title,
              location: changes.location ?? current.location,
              notes: changes.notes ?? current.notes,
            } satisfies EventContent),
            title: '',
            location: '',
            notes: '',
          }
        : {}),
      ...(changes.eventType ? { eventType: changes.eventType } : {}),
      ...(times ? { ...times, allDay } : {}),
      ...(changes.assigneeUserId !== undefined
        ? { assigneeUserId: await requireAssignee(changes.assigneeUserId) }
        : {}),
      ...(changes.reminderOffsets ? { reminderOffsets: changes.reminderOffsets } : {}),
      // A moved event (or new reminder times) reminds again.
      ...(moved || changes.reminderOffsets ? { remindersSent: [] } : {}),
      ...(changes.status ? { status: changes.status } : {}),
      updatedAt: new Date(),
    })
    .where(eq(calendarEvents.id, row.id))
    .returning();
  await auditService.logEvent(
    {
      entityType: 'calendar_event',
      entityId: row.id,
      action:
        changes.status && changes.status !== row.status
          ? `calendar_event_${changes.status}`
          : 'calendar_event_updated',
      summary: `Calendar event changed on ${row.caseNumber}`,
      details: { caseId: row.caseId, moved, status: changes.status ?? row.status },
    },
    actor,
  );
  return (await present([saved!]))[0]!;
}

export async function deleteEvent(id: string, actor: Actor = {}): Promise<{ deleted: true }> {
  const row = await requireEvent(id);
  if (row.source === 'prescription') {
    throw httpError('Close the prescription instead of deleting its last day', 409);
  }
  await db().delete(calendarEvents).where(eq(calendarEvents.id, row.id));
  await auditService.logEvent(
    {
      entityType: 'calendar_event',
      entityId: row.id,
      action: 'calendar_event_deleted',
      summary: `Calendar event deleted on ${row.caseNumber}`,
      details: { caseId: row.caseId, eventType: row.eventType, source: row.source },
    },
    actor,
  );
  return { deleted: true };
}

// ---------------------------------------------------------------- iCalendar export

function icsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsStamp(value: Date): string {
  return value
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function icsDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FIRM_TIME_ZONE })
    .format(value)
    .replace(/-/g, '');
}

/** Folds lines at 75 octets as RFC 5545 asks. */
function fold(line: string): string {
  const parts: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut -= 1;
    parts.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  parts.push(rest);
  return parts.join('\r\n');
}

/** Scheduled events (from 30 days ago) as an .ics file for Outlook or Google Calendar. */
export async function icsExport(options: { assigneeUserId?: string } = {}): Promise<string> {
  const from = new Date(Date.now() - 30 * 1440 * MINUTE);
  const events = (await listEvents({ assigneeUserId: options.assigneeUserId, limit: 1000 })).filter(
    (event) => Date.parse(event.startsAt) >= from.getTime(),
  );
  const host = new URL(firmOrigin(currentFirm())).host;
  const brand = getFirmBrand(currentFirm());
  const now = icsStamp(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${icsText(brand.firmName)}//Practice calendar//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  for (const event of events) {
    const start = new Date(event.startsAt);
    lines.push('BEGIN:VEVENT', `UID:${event.id}@${host}`, `DTSTAMP:${now}`);
    if (event.allDay) {
      const next = new Date(start.getTime() + 1440 * MINUTE);
      lines.push(`DTSTART;VALUE=DATE:${icsDate(start)}`, `DTEND;VALUE=DATE:${icsDate(next)}`);
    } else {
      lines.push(`DTSTART:${icsStamp(start)}`);
      if (event.endsAt) lines.push(`DTEND:${icsStamp(new Date(event.endsAt))}`);
    }
    lines.push(`SUMMARY:${icsText(`${event.caseNumber}: ${event.title}`)}`);
    if (event.location) lines.push(`LOCATION:${icsText(event.location)}`);
    if (event.notes) lines.push(`DESCRIPTION:${icsText(event.notes)}`);
    lines.push(
      `CATEGORIES:${icsText(CALENDAR_EVENT_LABELS[event.eventType as CalendarEventType] ?? 'Event')}`,
    );
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------- reminders

/** The assignee if there is one, else the matter's team (active staff, not support). */
export async function matterTeam(caseId: string, assigneeUserId: string | null = null) {
  const ids = assigneeUserId
    ? [assigneeUserId]
    : (
        await db()
          .select({ userId: caseMembers.userId })
          .from(caseMembers)
          .where(eq(caseMembers.caseId, caseId))
      ).map((member) => member.userId);
  if (!ids.length) return [];
  return db()
    .select({ id: users.id, email: users.email, fullName: users.fullName, role: users.role })
    .from(users)
    .where(and(inArray(users.id, ids), eq(users.isActive, true), ne(users.role, 'support')));
}

export interface TeamNotice {
  caseId: string;
  subject: string;
  /** Plain text, no personal information (it is stored unencrypted). */
  body: string;
  priority: 'high' | 'medium';
  entityType: string;
  entityId: string;
  assigneeUserId?: string | null;
  /** Others to tell as well (e.g. the firm's court roll watchers), deduplicated. */
  alsoUserIds?: string[];
}

/** Tells a matter's team in the app and by email. Returns the emails sent. */
export async function notifyMatterTeam(notice: TeamNotice): Promise<number> {
  const firm = currentFirm();
  const brand = getFirmBrand(firm);
  const link = `${firmOrigin(firm)}/`;
  let emails = 0;
  const team = await matterTeam(notice.caseId, notice.assigneeUserId ?? null);
  const extra = (notice.alsoUserIds ?? []).filter((id) => !team.some((person) => person.id === id));
  const others = extra.length
    ? await db()
        .select({ id: users.id, email: users.email, fullName: users.fullName, role: users.role })
        .from(users)
        .where(and(inArray(users.id, extra), eq(users.isActive, true), ne(users.role, 'support')))
    : [];
  for (const person of [...team, ...others]) {
    await db().insert(notifications).values({
      title: notice.subject,
      body: notice.body,
      category: 'calendar',
      priority: notice.priority,
      recipientRole: person.role,
      recipientUserId: person.id,
      relatedEntityType: notice.entityType,
      relatedEntityId: notice.entityId,
      createdBy: 'system',
    });
    const sent = await sendMail({
      to: person.email,
      subject: `${brand.firmName}: ${notice.subject}`,
      text: [`Hello ${person.fullName},`, '', notice.body, '', `Open it here: ${link}`].join('\n'),
    });
    if (sent) emails += 1;
  }
  return emails;
}

export interface ReminderRun {
  events: number;
  emails: number;
}

/**
 * Sends reminders that are due for the current firm: once per offset, by
 * email and in the app. Reminders that fell due more than a few hours ago
 * (e.g. while the job was down) are marked sent without sending.
 */
export async function sendDueReminders(now = new Date()): Promise<ReminderRun> {
  const horizon = new Date(now.getTime() + 367 * 1440 * MINUTE);
  const rows = await db()
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.status, 'scheduled'),
        gte(calendarEvents.startsAt, new Date(now.getTime() - STALE_AFTER_MS)),
        lte(calendarEvents.startsAt, horizon),
      ),
    );
  const run: ReminderRun = { events: 0, emails: 0 };

  for (const row of rows) {
    const due = row.reminderOffsets.filter(
      (offset) =>
        !row.remindersSent.includes(offset) &&
        row.startsAt.getTime() - offset * MINUTE <= now.getTime(),
    );
    if (!due.length) continue;
    const fresh = due.some(
      (offset) => now.getTime() - (row.startsAt.getTime() - offset * MINUTE) <= STALE_AFTER_MS,
    );
    // Claim the offsets first so two runs never send the same reminder.
    const [claimed] = await db()
      .update(calendarEvents)
      .set({ remindersSent: [...row.remindersSent, ...due] })
      .where(
        and(eq(calendarEvents.id, row.id), eq(calendarEvents.remindersSent, row.remindersSent)),
      )
      .returning({ id: calendarEvents.id });
    if (!claimed || !fresh) continue;

    const label = CALENDAR_EVENT_LABELS[row.eventType as CalendarEventType] ?? 'Event';
    const when = row.allDay ? localDay(row.startsAt) : localDateTime(row.startsAt);
    run.events += 1;
    run.emails += await notifyMatterTeam({
      caseId: row.caseId,
      assigneeUserId: row.assigneeUserId,
      subject: `${label} on ${row.caseNumber}: ${when}`,
      body: `Reminder: ${label.toLowerCase()} on matter ${row.caseNumber}, ${when}.`,
      priority:
        row.eventType === 'prescription' || row.eventType === 'court_date' ? 'high' : 'medium',
      entityType: 'calendar_event',
      entityId: row.id,
    });
  }
  return run;
}

/** Sends due reminders for every active firm (the scheduled job). */
export async function sendRemindersForAllFirms(now = new Date()) {
  const all = await rootDb().select().from(firms).where(eq(firms.status, 'active'));
  const results: Array<{ firm: string } & ReminderRun> = [];
  for (const firm of all) {
    const run = await withTenant(firm, () => sendDueReminders(now), { system: true });
    results.push({ firm: firm.slug, ...run });
  }
  return results;
}

/** Optional in-process schedule (CALENDAR_REMINDER_INTERVAL_MINUTES). */
export function scheduleReminders(): NodeJS.Timeout | null {
  const minutes = Number(process.env.CALENDAR_REMINDER_INTERVAL_MINUTES ?? 0);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  const run = () => {
    sendRemindersForAllFirms().catch((error: unknown) =>
      console.error('Calendar reminders failed:', error instanceof Error ? error.message : error),
    );
  };
  const timer = setInterval(run, minutes * MINUTE);
  timer.unref();
  return timer;
}
