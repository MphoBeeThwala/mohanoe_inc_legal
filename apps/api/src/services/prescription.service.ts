// Prescription (limitation) periods on matters. Each has its last day on the
// calendar, with reminders 90, 30 and 7 days and a day before.
//
// The last day is the day before the anniversary: a debt due on 15 January
// 2008 with a three-year period prescribes at the end of 14 January 2011.
// The attorney confirms the rule and the start date; delays (minority,
// curatorship, s13) and interruptions (s14, s15) are entered by changing the
// dates or the status. The calendar is a reminder, not legal advice.
import { and, asc, eq } from 'drizzle-orm';
import {
  DEFAULT_REMINDERS,
  PRESCRIPTION_RULES,
  type Prescription,
  type PrescriptionRuleCode,
  type PrescriptionStatus,
} from '@ahava88/shared';
import { db } from '../db/client';
import { atomically } from '../db/tenant';
import {
  calendarEvents,
  cases,
  matterPrescriptions,
  type MatterPrescriptionRow,
} from '../db/schema';
import { httpError } from '../lib/http';
import { isUuid } from '../lib/ids';
import type { Actor } from '../lib/actor';
import { iso, localDate } from '../lib/time';
import { parse, prescriptionSchema, prescriptionUpdateSchema } from '../validation/schemas';
import { decryptJson, encryptJson } from './privacy.service';
import { insertEvent, startOfLocalDay } from './calendar.service';
import * as intakeService from './intake.service';
import * as auditService from './audit.service';

const DAY_MS = 86_400_000;

function rule(code: string) {
  return (
    PRESCRIPTION_RULES.find((candidate) => candidate.code === code) ?? PRESCRIPTION_RULES.at(-1)!
  );
}

/** Adds whole months (clamping to the month's end), then steps back one day. */
export function lastDayFor(code: PrescriptionRuleCode, startsOn: string): string {
  const { months } = rule(code);
  const [year, month, day] = startsOn.split('-').map(Number) as [number, number, number];
  const targetMonth = month - 1 + months;
  const y = year + Math.floor(targetMonth / 12);
  const m = targetMonth % 12;
  const lastOfMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const anniversary = Date.UTC(y, m, Math.min(day, lastOfMonth));
  return new Date(anniversary - DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

async function format(row: MatterPrescriptionRow, caseNumber: string): Promise<Prescription> {
  const today = localDate();
  return {
    id: row.id,
    caseId: row.caseId,
    caseNumber,
    rule: row.rule as PrescriptionRuleCode,
    startsOn: row.startsOn,
    lastDay: row.lastDay,
    status: row.status as PrescriptionStatus,
    lapsed: row.status === 'running' && row.lastDay < today,
    daysLeft: daysBetween(today, row.lastDay),
    notes: row.notesEncrypted ? ((await decryptJson<string>(row.notesEncrypted)) ?? '') : '',
    eventId: row.eventId,
    createdAt: iso(row.createdAt),
  };
}

function eventTitle(code: string): string {
  return `Prescription: ${rule(code).label}`;
}

function eventNotes(code: string): string {
  const { source } = rule(code);
  return `Last day to act${source ? ` (${source})` : ''}. Confirm the period and dates.`;
}

export async function listPrescriptions(caseId?: string): Promise<Prescription[]> {
  const rows = await db()
    .select({ row: matterPrescriptions, caseNumber: cases.caseNumber })
    .from(matterPrescriptions)
    .innerJoin(cases, eq(cases.id, matterPrescriptions.caseId))
    .where(caseId && isUuid(caseId) ? eq(matterPrescriptions.caseId, caseId) : undefined)
    .orderBy(asc(matterPrescriptions.lastDay));
  return Promise.all(rows.map(({ row, caseNumber }) => format(row, caseNumber)));
}

export function createPrescription(input: unknown, actor: Actor = {}): Promise<Prescription> {
  return atomically(async () => {
    const entry = parse(prescriptionSchema, input);
    const matter = await intakeService.findCaseByRef(entry.caseRef);
    if (!matter) {
      throw httpError('Case not found', 404);
    }
    const code = entry.rule as PrescriptionRuleCode;
    const lastDay = code === 'custom' ? entry.lastDay! : lastDayFor(code, entry.startsOn);
    if (lastDay < entry.startsOn) {
      throw httpError('The last day must be after the start', 400);
    }
    const event = await insertEvent(
      {
        caseId: matter.id,
        caseNumber: matter.caseNumber,
        eventType: 'prescription',
        title: eventTitle(code),
        notes: eventNotes(code),
        startsAt: startOfLocalDay(lastDay),
        allDay: true,
        assigneeUserId: entry.assigneeUserId ?? null,
        reminderOffsets: DEFAULT_REMINDERS.prescription,
        source: 'prescription',
      },
      actor,
    );
    const [saved] = await db()
      .insert(matterPrescriptions)
      .values({
        caseId: matter.id,
        rule: code,
        startsOn: entry.startsOn,
        lastDay,
        notesEncrypted: entry.notes ? await encryptJson(entry.notes) : null,
        eventId: event.id,
        createdBy: actor.userId ?? null,
      })
      .returning();
    await db()
      .update(calendarEvents)
      .set({ sourceRef: saved!.id })
      .where(eq(calendarEvents.id, event.id));
    await auditService.logEvent(
      {
        entityType: 'prescription',
        entityId: saved!.id,
        action: 'prescription_recorded',
        summary: `Prescription recorded on ${matter.caseNumber}`,
        details: { caseId: matter.id, rule: code, lastDay },
      },
      actor,
    );
    return format(saved!, matter.caseNumber);
  });
}

export function updatePrescription(
  id: string,
  input: unknown,
  actor: Actor = {},
): Promise<Prescription> {
  return atomically(async () => {
    const changes = parse(prescriptionUpdateSchema, input);
    if (!isUuid(id)) {
      throw httpError('Prescription not found', 404);
    }
    const [row] = await db()
      .select({ row: matterPrescriptions, caseNumber: cases.caseNumber })
      .from(matterPrescriptions)
      .innerJoin(cases, eq(cases.id, matterPrescriptions.caseId))
      .where(eq(matterPrescriptions.id, id))
      .limit(1);
    if (!row) {
      throw httpError('Prescription not found', 404);
    }
    const current = row.row;
    const code = current.rule as PrescriptionRuleCode;
    const startsOn = changes.startsOn ?? current.startsOn;
    const lastDay =
      changes.lastDay ??
      (changes.startsOn && code !== 'custom' ? lastDayFor(code, startsOn) : current.lastDay);
    if (lastDay < startsOn) {
      throw httpError('The last day must be after the start', 400);
    }
    const status = changes.status ?? (current.status as PrescriptionStatus);
    const [saved] = await db()
      .update(matterPrescriptions)
      .set({
        startsOn,
        lastDay,
        status,
        ...(changes.notes !== undefined
          ? { notesEncrypted: changes.notes ? await encryptJson(changes.notes) : null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(matterPrescriptions.id, current.id))
      .returning();
    if (current.eventId) {
      const moved = lastDay !== current.lastDay;
      await db()
        .update(calendarEvents)
        .set({
          startsAt: startOfLocalDay(lastDay),
          // Only a running period needs its last day reminded.
          status: status === 'running' ? 'scheduled' : 'done',
          ...(moved ? { remindersSent: [] } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(calendarEvents.id, current.eventId)));
    }
    await auditService.logEvent(
      {
        entityType: 'prescription',
        entityId: current.id,
        action: 'prescription_updated',
        summary: `Prescription changed on ${row.caseNumber}`,
        details: {
          caseId: current.caseId,
          status,
          lastDay,
          previous: { status: current.status, lastDay: current.lastDay },
        },
      },
      actor,
    );
    return format(saved!, row.caseNumber);
  });
}
