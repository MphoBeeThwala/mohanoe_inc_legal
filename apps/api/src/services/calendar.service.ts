// Hearings, deadlines and meetings, plus task due dates for the upcoming view.

import { asc, gte } from 'drizzle-orm';
import type { CalendarEvent, UpcomingItem } from '@ahava88/shared';
import { db } from '../db/client';
import { calendarEvents, type CalendarEventRow } from '../db/schema';
import { httpError } from '../lib/http';
import { actorName, type Actor } from '../lib/actor';
import { iso, isoOrNull, toDateOrNull } from '../lib/time';
import { calendarEventSchema, parse } from '../validation/schemas';
import * as caseService from './case.service';
import * as intakeService from './intake.service';
import * as auditService from './audit.service';

function formatEvent(row: CalendarEventRow): CalendarEvent {
  return {
    id: row.id,
    caseId: row.caseId,
    caseNumber: row.caseNumber,
    title: row.title,
    eventType: row.eventType,
    startsAt: iso(row.startsAt),
    endsAt: isoOrNull(row.endsAt),
    location: row.location,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
  };
}

export async function listEvents(limit = 500): Promise<CalendarEvent[]> {
  const rows = await db()
    .select()
    .from(calendarEvents)
    .orderBy(asc(calendarEvents.startsAt))
    .limit(limit);
  return rows.map(formatEvent);
}

export async function createEvent(input: unknown, actor: Actor = {}): Promise<CalendarEvent> {
  const event = parse(calendarEventSchema, input);
  const caseRecord = await intakeService.findCaseByRef(event.caseId);
  if (!caseRecord) {
    throw httpError('Case not found', 404);
  }

  const [saved] = await db()
    .insert(calendarEvents)
    .values({
      caseId: caseRecord.id,
      caseNumber: caseRecord.caseNumber,
      title: event.title,
      eventType: event.eventType,
      startsAt: new Date(event.startsAt),
      endsAt: toDateOrNull(event.endsAt),
      location: event.location,
      notes: event.notes,
      createdBy: actorName(actor),
    })
    .returning();
  if (!saved) {
    throw new Error('Calendar event was not stored');
  }

  await auditService.logEvent(
    {
      entityType: 'calendar_event',
      entityId: saved.id,
      action: 'calendar_event_created',
      summary: `Calendar event created: ${saved.title}`,
      details: { caseId: caseRecord.id },
    },
    actor,
  );

  return formatEvent(saved);
}

/** Upcoming events (from the start of today) merged with open task due dates. */
export async function getUpcomingEvents(limit = 8): Promise<UpcomingItem[]> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [events, tasks] = await Promise.all([
    db()
      .select()
      .from(calendarEvents)
      .where(gte(calendarEvents.startsAt, startOfToday))
      .orderBy(asc(calendarEvents.startsAt))
      .limit(limit),
    caseService.listDueTasks(limit),
  ]);

  const items: UpcomingItem[] = [
    ...events.map(formatEvent),
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
