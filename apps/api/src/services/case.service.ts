// Matter workspace: tasks, status changes and the case timeline.

import { and, asc, count, desc, eq, ne, sql } from 'drizzle-orm';
import type { CaseDetail, CaseIndexEntry, CaseTask, CaseTimelineEntry } from '@ahava88/shared';
import { db } from '../db/client';
import {
  cases,
  caseTasks,
  caseTimeline,
  type CaseTaskRow,
  type CaseTimelineRow,
} from '../db/schema';
import { httpError } from '../lib/http';
import { actorName, type Actor } from '../lib/actor';
import { iso, isoOrNull } from '../lib/time';
import {
  caseStatusSchema,
  caseTaskSchema,
  parse,
  timelineNoteSchema,
  type TimelineNoteInput,
} from '../validation/schemas';
import * as intakeService from './intake.service';
import * as auditService from './audit.service';

function toTask(row: CaseTaskRow): CaseTask {
  return {
    id: row.id,
    caseId: row.caseId,
    title: row.title,
    description: row.description,
    status: row.status,
    dueDate: row.dueDate,
    assigneeName: row.assigneeName,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
    completedAt: isoOrNull(row.completedAt),
  };
}

function toTimelineEntry(row: CaseTimelineRow): CaseTimelineEntry {
  return {
    id: row.id,
    caseId: row.caseId,
    eventType: row.eventType,
    message: row.message,
    metadata: row.metadata,
    actorName: row.actorName,
    createdAt: iso(row.createdAt),
  };
}

async function requireCase(caseRef: string) {
  const caseRecord = await intakeService.findCaseByRef(caseRef);
  if (!caseRecord) {
    throw httpError('Case not found', 404);
  }
  return caseRecord;
}

export async function getCasesIndex(limit = 500): Promise<CaseIndexEntry[]> {
  const rows = await db()
    .select({
      matterCase: cases,
      taskCount: sql<number>`(select count(*)::int from ${caseTasks} where ${caseTasks.caseId} = ${cases.id})`,
      openTaskCount: sql<number>`(select count(*)::int from ${caseTasks} where ${caseTasks.caseId} = ${cases.id} and ${caseTasks.status} <> 'done')`,
      timelineCount: sql<number>`(select count(*)::int from ${caseTimeline} where ${caseTimeline.caseId} = ${cases.id})`,
    })
    .from(cases)
    .orderBy(desc(cases.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    ...intakeService.toMatterCase(row.matterCase),
    taskCount: row.taskCount,
    openTaskCount: row.openTaskCount,
    timelineCount: row.timelineCount,
  }));
}

export async function getCase(caseRef: string): Promise<CaseDetail | null> {
  const caseRecord = await intakeService.findCaseByRef(caseRef);
  if (!caseRecord) {
    return null;
  }

  const [tasks, timeline] = await Promise.all([
    db()
      .select()
      .from(caseTasks)
      .where(eq(caseTasks.caseId, caseRecord.id))
      .orderBy(desc(caseTasks.createdAt)),
    db()
      .select()
      .from(caseTimeline)
      .where(eq(caseTimeline.caseId, caseRecord.id))
      .orderBy(desc(caseTimeline.createdAt)),
  ]);

  return {
    ...intakeService.toMatterCase(caseRecord),
    tasks: tasks.map(toTask),
    timeline: timeline.map(toTimelineEntry),
  };
}

/** Open tasks that have a due date, soonest first (for the calendar). */
export async function listDueTasks(limit = 50): Promise<CaseTask[]> {
  const rows = await db()
    .select()
    .from(caseTasks)
    .where(and(ne(caseTasks.status, 'done'), sql`${caseTasks.dueDate} is not null`))
    .orderBy(asc(caseTasks.dueDate))
    .limit(limit);
  return rows.map(toTask);
}

export async function countOpenTasks(): Promise<number> {
  const [row] = await db()
    .select({ value: count() })
    .from(caseTasks)
    .where(ne(caseTasks.status, 'done'));
  return row?.value ?? 0;
}

export async function addTask(
  caseRef: string,
  input: unknown,
  actor: Actor = {},
): Promise<CaseTask> {
  const caseRecord = await requireCase(caseRef);
  const task = parse(caseTaskSchema, input);

  const [saved] = await db()
    .insert(caseTasks)
    .values({
      caseId: caseRecord.id,
      title: task.title,
      description: task.description,
      dueDate: task.dueDate ?? null,
      assigneeName: task.assigneeName ?? null,
      createdBy: actorName(actor),
    })
    .returning();
  if (!saved) {
    throw new Error('Task was not stored');
  }

  await auditService.logEventSafely(
    {
      entityType: 'case_task',
      entityId: saved.id,
      action: 'task_created',
      summary: `Task created: ${saved.title}`,
      details: { caseId: caseRecord.id },
    },
    actor,
  );
  await recordTimeline(
    caseRecord.id,
    {
      eventType: 'task_created',
      message: `Task created: ${saved.title}`,
      metadata: { taskId: saved.id },
    },
    actor,
  );

  return toTask(saved);
}

export async function completeTask(
  caseRef: string,
  taskId: string,
  actor: Actor = {},
): Promise<CaseTask> {
  const caseRecord = await requireCase(caseRef);
  const [updated] = await db()
    .update(caseTasks)
    .set({ status: 'done', completedAt: new Date() })
    .where(and(eq(caseTasks.id, taskId), eq(caseTasks.caseId, caseRecord.id)))
    .returning();
  if (!updated) {
    throw httpError('Task not found', 404);
  }

  await recordTimeline(
    caseRecord.id,
    {
      eventType: 'task_completed',
      message: `Task completed: ${updated.title}`,
      metadata: { taskId },
    },
    actor,
  );
  await auditService.logEventSafely(
    {
      entityType: 'case_task',
      entityId: updated.id,
      action: 'task_completed',
      summary: `Task completed: ${updated.title}`,
      details: { caseId: caseRecord.id },
    },
    actor,
  );

  return toTask(updated);
}

export async function updateCaseStatus(caseRef: string, input: unknown, actor: Actor = {}) {
  const caseRecord = await requireCase(caseRef);
  const { status, nextAction } = parse(caseStatusSchema, input);

  const [updated] = await db()
    .update(cases)
    .set({ status, nextAction: nextAction || caseRecord.nextAction, updatedAt: new Date() })
    .where(eq(cases.id, caseRecord.id))
    .returning();
  if (!updated) {
    throw httpError('Case not found', 404);
  }

  const details = { previousStatus: caseRecord.status, newStatus: status };
  await recordTimeline(
    caseRecord.id,
    { eventType: 'status_changed', message: `Case status changed to ${status}`, metadata: details },
    actor,
  );
  await auditService.logEventSafely(
    {
      entityType: 'case',
      entityId: caseRecord.id,
      action: 'case_status_changed',
      summary: `Case status changed to ${status}`,
      details,
    },
    actor,
  );

  return intakeService.toMatterCase(updated);
}

/** Endpoint: POST /cases/:caseId/timeline (a note written by staff). */
export async function addTimeline(caseRef: string, input: unknown, actor: Actor = {}) {
  const caseRecord = await requireCase(caseRef);
  return recordTimeline(caseRecord.id, parse(timelineNoteSchema, input), actor);
}

async function recordTimeline(
  caseId: string,
  entry: TimelineNoteInput,
  actor: Actor = {},
): Promise<CaseTimelineEntry> {
  const [saved] = await db()
    .insert(caseTimeline)
    .values({
      caseId,
      eventType: entry.eventType,
      message: entry.message,
      metadata: entry.metadata,
      actorName: actorName(actor),
    })
    .returning();
  if (!saved) {
    throw new Error('Timeline entry was not stored');
  }

  await auditService.logEventSafely(
    {
      entityType: 'case_timeline',
      entityId: saved.id,
      action: 'timeline_note_added',
      summary: saved.message,
      details: { caseId, eventType: saved.eventType },
    },
    actor,
  );
  return toTimelineEntry(saved);
}
