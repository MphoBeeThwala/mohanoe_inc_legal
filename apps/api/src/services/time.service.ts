// Time recording: manual entries and timers, in 6-minute units (tenths of an
// hour), valued at the hourly rate that applies when the time is recorded:
//   1. the fee earner's agreed rate on the matter,
//   2. the matter's rate for everyone on it,
//   3. the fee earner's standard rate.
// Unbilled billable time is the matter's work in progress (WIP); billing
// (epic 7d) marks entries billed. Narratives may name people, so they are
// encrypted with the firm's data key; audit rows carry only numbers.
import { and, asc, desc, eq, gte, isNull, lte, ne, sql, type SQL } from 'drizzle-orm';
import {
  hasPermission,
  MAX_UNITS_PER_DAY,
  MINUTES_PER_UNIT,
  STAFF_ROLES,
  type MatterRate,
  type StaffRate,
  type TimeActivity,
  type TimeEntry,
  type TimeEntryStatus,
  type TimerState,
  type UserRole,
  type WipSummary,
} from '@ahava88/shared';
import { db } from '../db/client';
import { withSystemScope } from '../db/tenant';
import {
  cases,
  matterRates,
  staffRates,
  timeEntries,
  timers,
  users,
  type CaseRow,
  type TimeEntryRow,
  type TimerRow,
} from '../db/schema';
import { httpError } from '../lib/http';
import { isUuid } from '../lib/ids';
import type { Actor } from '../lib/actor';
import { fromCents, toCents } from '../lib/money';
import { iso, localDate } from '../lib/time';
import {
  matterRateSchema,
  parse,
  staffRateSchema,
  timeEntrySchema,
  timeEntryUpdateSchema,
  timerStartSchema,
  timerStopSchema,
} from '../validation/schemas';
import { decryptJson, encryptJson } from './privacy.service';
import * as intakeService from './intake.service';
import * as auditService from './audit.service';
import { isClosed } from '../lib/matter-status';

// ---------------------------------------------------------------- helpers

export function unitsFromMinutes(minutes: number): number {
  return Math.ceil(minutes / MINUTES_PER_UNIT);
}

/** Timer seconds as units: any part of a unit counts, and at least one. */
export function unitsFromSeconds(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / (MINUTES_PER_UNIT * 60)));
}

/** Value of units at an hourly rate (a unit is a tenth of an hour). */
export function valueCents(units: number, rateCents: number): number {
  return Math.round((units * rateCents) / 10);
}

function requireActor(actor: Actor): string {
  if (!actor.userId) {
    throw httpError('Not signed in', 401);
  }
  return actor.userId;
}

const canManage = (actor: Actor) => hasPermission(actor.role ?? undefined, 'time.manage');

async function requireOpenMatter(ref: string): Promise<CaseRow> {
  const matter = await intakeService.findCaseByRef(ref);
  if (!matter) {
    throw httpError('Matter not found', 404);
  }
  if (isClosed(matter.status)) {
    throw httpError(`Matter ${matter.caseNumber} is closed; time can't be recorded on it`, 409);
  }
  return matter;
}

async function requireFeeEarner(userId: string) {
  if (!isUuid(userId)) {
    throw httpError('Fee earner not found', 404);
  }
  const [person] = await db().select().from(users).where(eq(users.id, userId)).limit(1);
  if (!person || !person.isActive || !STAFF_ROLES.includes(person.role as UserRole)) {
    throw httpError('Fee earner not found', 404);
  }
  if (!hasPermission(person.role, 'time.record')) {
    throw httpError(`${person.fullName} does not record time`, 400);
  }
  return person;
}

/** The hourly rate (cents) for a fee earner on a matter, or null if none is set. */
export async function rateFor(caseId: string, userId: string): Promise<number | null> {
  const onMatter = await db()
    .select()
    .from(matterRates)
    .where(
      and(
        eq(matterRates.caseId, caseId),
        sql`(${matterRates.userId} = ${userId} or ${matterRates.userId} is null)`,
      ),
    );
  const personal = onMatter.find((rate) => rate.userId === userId);
  const everyone = onMatter.find((rate) => rate.userId === null);
  if (personal || everyone) {
    return (personal ?? everyone)!.hourlyRateCents;
  }
  const [standard] = await db()
    .select()
    .from(staffRates)
    .where(eq(staffRates.userId, userId))
    .limit(1);
  return standard?.hourlyRateCents ?? null;
}

async function pricing(caseId: string, userId: string, billable: boolean, name: string) {
  const rateCents = await rateFor(caseId, userId);
  if (billable && rateCents === null) {
    throw httpError(
      `No hourly rate is set for ${name}. An administrator sets rates under Time → Rates.`,
      409,
    );
  }
  return rateCents ?? 0;
}

/**
 * Units already recorded by a fee earner on a day, across every matter
 * (including ones the caller can't see), so a day never holds more than 24 hours.
 */
async function unitsOnDay(userId: string, workDate: string, exceptId?: string): Promise<number> {
  return withSystemScope(async () => {
    const conditions: SQL[] = [eq(timeEntries.userId, userId), eq(timeEntries.workDate, workDate)];
    if (exceptId) {
      conditions.push(ne(timeEntries.id, exceptId));
    }
    const [row] = await db()
      .select({ total: sql<number>`coalesce(sum(${timeEntries.units}), 0)::int` })
      .from(timeEntries)
      .where(and(...conditions));
    return row?.total ?? 0;
  });
}

async function checkDay(userId: string, workDate: string, units: number, exceptId?: string) {
  if (workDate > localDate()) {
    throw httpError("Time can't be recorded for a future date", 400);
  }
  const already = await unitsOnDay(userId, workDate, exceptId);
  if (already + units > MAX_UNITS_PER_DAY) {
    throw httpError(
      `That would put more than 24 hours on ${workDate} (${(already / 10).toFixed(1)} h already recorded)`,
      400,
    );
  }
}

async function format(
  row: TimeEntryRow,
  caseNumber: string,
  feeEarnerName: string,
): Promise<TimeEntry> {
  return {
    id: row.id,
    caseId: row.caseId,
    caseNumber,
    userId: row.userId,
    feeEarnerName,
    workDate: row.workDate,
    units: row.units,
    minutes: row.units * MINUTES_PER_UNIT,
    billable: row.billable,
    rate: fromCents(row.rateCents),
    amount: fromCents(row.amountCents),
    activity: row.activity as TimeActivity,
    description: (await decryptJson<string>(row.descriptionEncrypted)) ?? '',
    source: row.source as TimeEntry['source'],
    status: row.status as TimeEntryStatus,
    invoiceId: row.invoiceId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

async function present(row: TimeEntryRow): Promise<TimeEntry> {
  const [matter] = await db()
    .select({ caseNumber: cases.caseNumber })
    .from(cases)
    .where(eq(cases.id, row.caseId));
  const [person] = await db()
    .select({ fullName: users.fullName })
    .from(users)
    .where(eq(users.id, row.userId));
  return format(row, matter?.caseNumber ?? '', person?.fullName ?? '');
}

async function audit(
  action: string,
  summary: string,
  row: TimeEntryRow,
  actor: Actor,
  extra: Record<string, unknown> = {},
) {
  await auditService.logEvent(
    {
      entityType: 'time_entry',
      entityId: row.id,
      action,
      summary,
      details: {
        caseId: row.caseId,
        userId: row.userId,
        workDate: row.workDate,
        units: row.units,
        billable: row.billable,
        amountCents: row.amountCents,
        ...extra,
      },
    },
    actor,
  );
}

// ---------------------------------------------------------------- entries

interface NewEntry {
  matter: CaseRow;
  userId: string;
  workDate: string;
  units: number;
  billable: boolean;
  activity: TimeActivity;
  description: string;
  source: 'manual' | 'timer';
}

async function insertEntry(entry: NewEntry, actor: Actor): Promise<TimeEntry> {
  const person = await requireFeeEarner(entry.userId);
  await checkDay(entry.userId, entry.workDate, entry.units);
  const rateCents = await pricing(entry.matter.id, entry.userId, entry.billable, person.fullName);

  const [saved] = await db()
    .insert(timeEntries)
    .values({
      caseId: entry.matter.id,
      userId: entry.userId,
      workDate: entry.workDate,
      units: entry.units,
      billable: entry.billable,
      rateCents,
      amountCents: entry.billable ? valueCents(entry.units, rateCents) : 0,
      activity: entry.activity,
      descriptionEncrypted: await encryptJson(entry.description),
      source: entry.source,
      createdBy: actor.userId ?? null,
    })
    .returning();
  if (!saved) {
    throw new Error('Time entry was not stored');
  }
  await audit(
    'time_recorded',
    `${(saved.units / 10).toFixed(1)} h recorded on ${entry.matter.caseNumber}`,
    saved,
    actor,
    { source: entry.source },
  );
  return format(saved, entry.matter.caseNumber, person.fullName);
}

export async function recordTime(input: unknown, actor: Actor): Promise<TimeEntry> {
  const self = requireActor(actor);
  const entry = parse(timeEntrySchema, input);
  const userId = entry.userId ?? self;
  if (userId !== self && !canManage(actor)) {
    throw httpError("Only an administrator can record someone else's time", 403);
  }
  return insertEntry(
    {
      matter: await requireOpenMatter(entry.caseRef),
      userId,
      workDate: entry.workDate ?? localDate(),
      units: entry.units ?? unitsFromMinutes(entry.minutes!),
      billable: entry.billable,
      activity: entry.activity,
      description: entry.description,
      source: 'manual',
    },
    actor,
  );
}

async function requireEditable(id: string, actor: Actor): Promise<TimeEntryRow> {
  const self = requireActor(actor);
  if (!isUuid(id)) {
    throw httpError('Time entry not found', 404);
  }
  const [row] = await db().select().from(timeEntries).where(eq(timeEntries.id, id)).limit(1);
  if (!row) {
    throw httpError('Time entry not found', 404);
  }
  if (row.userId !== self && !canManage(actor)) {
    throw httpError("Only an administrator can change someone else's time", 403);
  }
  if (row.status === 'billed') {
    throw httpError('This time has been billed and can no longer change', 409);
  }
  if (row.status === 'written_off') {
    throw httpError('This time has been written off', 409);
  }
  if (row.invoiceId) {
    throw httpError('This time is on a draft invoice; delete the draft to change it', 409);
  }
  return row;
}

export interface TimeQuery {
  caseId?: string;
  userId?: string;
  from?: string;
  to?: string;
  status?: string;
  limit?: number;
}

export async function listEntries(query: TimeQuery = {}): Promise<TimeEntry[]> {
  const conditions: SQL[] = [];
  if (query.caseId) conditions.push(eq(timeEntries.caseId, query.caseId));
  if (query.userId) conditions.push(eq(timeEntries.userId, query.userId));
  if (query.from) conditions.push(gte(timeEntries.workDate, query.from));
  if (query.to) conditions.push(lte(timeEntries.workDate, query.to));
  if (query.status) conditions.push(eq(timeEntries.status, query.status));
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 500);

  const rows = await db()
    .select({ entry: timeEntries, caseNumber: cases.caseNumber, fullName: users.fullName })
    .from(timeEntries)
    .innerJoin(cases, eq(cases.id, timeEntries.caseId))
    .innerJoin(users, eq(users.id, timeEntries.userId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(timeEntries.workDate), desc(timeEntries.createdAt))
    .limit(limit);
  return Promise.all(rows.map((row) => format(row.entry, row.caseNumber, row.fullName)));
}

export async function updateEntry(id: string, input: unknown, actor: Actor): Promise<TimeEntry> {
  const changes = parse(timeEntryUpdateSchema, input);
  const row = await requireEditable(id, actor);

  const units =
    changes.units ??
    (changes.minutes !== undefined ? unitsFromMinutes(changes.minutes) : row.units);
  const workDate = changes.workDate ?? row.workDate;
  const billable = changes.billable ?? row.billable;
  if (units !== row.units || workDate !== row.workDate) {
    await checkDay(row.userId, workDate, units, row.id);
  }
  let rateCents = row.rateCents;
  if (billable && !rateCents) {
    // Recorded as non-billable before a rate was set: price it now.
    const [person] = await db().select().from(users).where(eq(users.id, row.userId));
    rateCents = await pricing(row.caseId, row.userId, true, person?.fullName ?? 'this fee earner');
  }

  const [saved] = await db()
    .update(timeEntries)
    .set({
      units,
      workDate,
      billable,
      rateCents,
      amountCents: billable ? valueCents(units, rateCents) : 0,
      activity: changes.activity ?? row.activity,
      ...(changes.description !== undefined
        ? { descriptionEncrypted: await encryptJson(changes.description) }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(timeEntries.id, row.id), eq(timeEntries.status, 'unbilled')))
    .returning();
  if (!saved) {
    throw httpError('This time has been billed and can no longer change', 409);
  }
  await audit('time_updated', 'Time entry changed', saved, actor, {
    previous: { units: row.units, workDate: row.workDate, billable: row.billable },
  });
  return present(saved);
}

export async function deleteEntry(id: string, actor: Actor): Promise<{ deleted: true }> {
  const row = await requireEditable(id, actor);
  const [gone] = await db()
    .delete(timeEntries)
    .where(and(eq(timeEntries.id, row.id), eq(timeEntries.status, 'unbilled')))
    .returning();
  if (!gone) {
    throw httpError('This time has been billed and can no longer change', 409);
  }
  await audit('time_deleted', 'Time entry deleted', row, actor);
  return { deleted: true };
}

/** Takes unbilled time out of WIP without billing it (time.manage). */
export async function writeOff(id: string, actor: Actor): Promise<TimeEntry> {
  if (!canManage(actor)) {
    throw httpError('Insufficient permissions', 403);
  }
  const row = await requireEditable(id, actor);
  const [saved] = await db()
    .update(timeEntries)
    .set({ status: 'written_off', updatedAt: new Date() })
    .where(and(eq(timeEntries.id, row.id), eq(timeEntries.status, 'unbilled')))
    .returning();
  if (!saved) {
    throw httpError('This time has been billed and can no longer change', 409);
  }
  await audit('time_written_off', 'Time written off', saved, actor);
  return present(saved);
}

// ---------------------------------------------------------------- work in progress

export async function wip(): Promise<WipSummary> {
  const unbilled = and(eq(timeEntries.status, 'unbilled'), eq(timeEntries.billable, true)) as SQL;
  const matterRows = await db()
    .select({
      caseId: cases.id,
      caseNumber: cases.caseNumber,
      title: cases.title,
      units: sql<number>`sum(${timeEntries.units})::int`,
      value: sql<string>`sum(${timeEntries.amountCents})`,
      entries: sql<number>`count(*)::int`,
      oldest: sql<string>`min(${timeEntries.workDate})::text`,
    })
    .from(timeEntries)
    .innerJoin(cases, eq(cases.id, timeEntries.caseId))
    .where(unbilled)
    .groupBy(cases.id, cases.caseNumber, cases.title)
    .orderBy(sql`sum(${timeEntries.amountCents}) desc`);
  const peopleRows = await db()
    .select({
      userId: users.id,
      fullName: users.fullName,
      units: sql<number>`sum(${timeEntries.units})::int`,
      value: sql<string>`sum(${timeEntries.amountCents})`,
    })
    .from(timeEntries)
    .innerJoin(users, eq(users.id, timeEntries.userId))
    .where(unbilled)
    .groupBy(users.id, users.fullName)
    .orderBy(asc(users.fullName));

  const matters = matterRows.map((row) => ({
    caseId: row.caseId,
    caseNumber: row.caseNumber,
    title: row.title,
    units: row.units,
    value: fromCents(Number(row.value)),
    entries: row.entries,
    oldestWorkDate: row.oldest,
  }));
  return {
    units: matters.reduce((total, row) => total + row.units, 0),
    value: fromCents(matterRows.reduce((total, row) => total + Number(row.value), 0)),
    matters,
    feeEarners: peopleRows.map((row) => ({
      userId: row.userId,
      fullName: row.fullName,
      units: row.units,
      value: fromCents(Number(row.value)),
    })),
  };
}

// ---------------------------------------------------------------- timer

function elapsed(timer: TimerRow, now = new Date()): number {
  const running = timer.runningSince
    ? Math.max(0, Math.floor((now.getTime() - timer.runningSince.getTime()) / 1000))
    : 0;
  return timer.elapsedSeconds + running;
}

async function presentTimer(timer: TimerRow): Promise<TimerState> {
  const [matter] = await db()
    .select({ caseNumber: cases.caseNumber })
    .from(cases)
    .where(eq(cases.id, timer.caseId));
  const seconds = elapsed(timer);
  return {
    caseId: timer.caseId,
    caseNumber: matter?.caseNumber ?? '',
    activity: timer.activity as TimeActivity,
    billable: timer.billable,
    description: timer.descriptionEncrypted
      ? ((await decryptJson<string>(timer.descriptionEncrypted)) ?? '')
      : '',
    running: Boolean(timer.runningSince),
    elapsedSeconds: seconds,
    units: unitsFromSeconds(seconds),
  };
}

async function findTimer(userId: string): Promise<TimerRow | null> {
  const [timer] = await db().select().from(timers).where(eq(timers.userId, userId)).limit(1);
  return timer ?? null;
}

async function requireTimer(actor: Actor): Promise<TimerRow> {
  const timer = await findTimer(requireActor(actor));
  if (!timer) {
    throw httpError('No timer is running', 404);
  }
  return timer;
}

export async function getTimer(actor: Actor): Promise<TimerState | null> {
  const timer = await findTimer(requireActor(actor));
  return timer ? presentTimer(timer) : null;
}

export async function startTimer(input: unknown, actor: Actor): Promise<TimerState> {
  const self = requireActor(actor);
  const start = parse(timerStartSchema, input);
  const matter = await requireOpenMatter(start.caseRef);
  const existing = await findTimer(self);
  if (existing) {
    const current = await presentTimer(existing);
    throw httpError(`Your timer is already on ${current.caseNumber}; stop it first`, 409);
  }
  const person = await requireFeeEarner(self);
  if (start.billable) {
    // Check now, rather than when an hour of work is stopped.
    await pricing(matter.id, self, true, person.fullName);
  }
  const [timer] = await db()
    .insert(timers)
    .values({
      userId: self,
      caseId: matter.id,
      activity: start.activity,
      billable: start.billable,
      descriptionEncrypted: start.description ? await encryptJson(start.description) : null,
      runningSince: new Date(),
    })
    .onConflictDoNothing({ target: timers.userId })
    .returning();
  if (!timer) {
    // A timer on a matter this person can no longer see.
    throw httpError('You already have a timer on a matter you can no longer open', 409);
  }
  return presentTimer(timer);
}

export async function pauseTimer(actor: Actor): Promise<TimerState> {
  const timer = await requireTimer(actor);
  if (!timer.runningSince) {
    return presentTimer(timer);
  }
  const [saved] = await db()
    .update(timers)
    .set({ elapsedSeconds: elapsed(timer), runningSince: null, updatedAt: new Date() })
    .where(eq(timers.id, timer.id))
    .returning();
  return presentTimer(saved!);
}

export async function resumeTimer(actor: Actor): Promise<TimerState> {
  const timer = await requireTimer(actor);
  if (timer.runningSince) {
    return presentTimer(timer);
  }
  const [saved] = await db()
    .update(timers)
    .set({ runningSince: new Date(), updatedAt: new Date() })
    .where(eq(timers.id, timer.id))
    .returning();
  return presentTimer(saved!);
}

/** Stops the timer and records its time (rounded up to whole units). */
export async function stopTimer(input: unknown, actor: Actor): Promise<TimeEntry> {
  const self = requireActor(actor);
  const stop = parse(timerStopSchema, input);
  const timer = await requireTimer(actor);
  const description =
    stop.description ??
    (timer.descriptionEncrypted ? await decryptJson<string>(timer.descriptionEncrypted) : null);
  if (!description) {
    throw httpError('Describe the work before stopping the timer', 400);
  }
  const units = unitsFromSeconds(elapsed(timer));
  if (units > MAX_UNITS_PER_DAY) {
    throw httpError('The timer ran for more than 24 hours; discard it and record the time', 409);
  }
  const [matter] = await db().select().from(cases).where(eq(cases.id, timer.caseId));
  if (!matter) {
    throw httpError('Matter not found', 404);
  }
  const entry = await insertEntry(
    {
      matter,
      userId: self,
      workDate: stop.workDate ?? localDate(),
      units,
      billable: stop.billable ?? timer.billable,
      activity: stop.activity ?? (timer.activity as TimeActivity),
      description,
      source: 'timer',
    },
    actor,
  );
  await db().delete(timers).where(eq(timers.id, timer.id));
  return entry;
}

export async function discardTimer(actor: Actor): Promise<{ discarded: true }> {
  const timer = await requireTimer(actor);
  await db().delete(timers).where(eq(timers.id, timer.id));
  return { discarded: true };
}

// ---------------------------------------------------------------- rates

export async function listStaffRates(): Promise<StaffRate[]> {
  const rows = await db()
    .select({
      userId: users.id,
      fullName: users.fullName,
      role: users.role,
      rate: staffRates.hourlyRateCents,
    })
    .from(users)
    .leftJoin(staffRates, eq(staffRates.userId, users.id))
    .where(and(eq(users.isActive, true), isNull(users.platformOperatorId)))
    .orderBy(asc(users.fullName));
  return rows
    .filter((row) => hasPermission(row.role, 'time.record'))
    .map((row) => ({
      userId: row.userId,
      fullName: row.fullName,
      role: row.role as UserRole,
      hourlyRate: row.rate === null ? null : fromCents(row.rate),
    }));
}

export async function setStaffRate(
  userId: string,
  input: unknown,
  actor: Actor,
): Promise<StaffRate[]> {
  const { hourlyRate } = parse(staffRateSchema, input);
  const person = await requireFeeEarner(userId);
  if (hourlyRate === null) {
    await db().delete(staffRates).where(eq(staffRates.userId, person.id));
  } else {
    const hourlyRateCents = toCents(hourlyRate);
    await db()
      .insert(staffRates)
      .values({ userId: person.id, hourlyRateCents, updatedBy: actor.userId ?? null })
      .onConflictDoUpdate({
        target: staffRates.userId,
        set: { hourlyRateCents, updatedBy: actor.userId ?? null, updatedAt: new Date() },
      });
  }
  await auditService.logEvent(
    {
      entityType: 'user',
      entityId: person.id,
      action: 'staff_rate_set',
      summary: 'Standard hourly rate changed',
      details: { hourlyRateCents: hourlyRate === null ? null : toCents(hourlyRate) },
    },
    actor,
  );
  return listStaffRates();
}

export async function listMatterRates(caseRef: string): Promise<MatterRate[]> {
  const matter = await intakeService.findCaseByRef(caseRef);
  if (!matter) {
    throw httpError('Matter not found', 404);
  }
  const rows = await db()
    .select({
      userId: matterRates.userId,
      fullName: users.fullName,
      rate: matterRates.hourlyRateCents,
    })
    .from(matterRates)
    .leftJoin(users, eq(users.id, matterRates.userId))
    .where(eq(matterRates.caseId, matter.id))
    .orderBy(sql`${matterRates.userId} is not null`, asc(users.fullName));
  return rows.map((row) => ({
    userId: row.userId,
    fullName: row.fullName,
    hourlyRate: fromCents(row.rate),
  }));
}

export async function setMatterRate(
  caseRef: string,
  input: unknown,
  actor: Actor,
): Promise<MatterRate[]> {
  const { userId, hourlyRate } = parse(matterRateSchema, input);
  const matter = await intakeService.findCaseByRef(caseRef);
  if (!matter) {
    throw httpError('Matter not found', 404);
  }
  if (userId) {
    await requireFeeEarner(userId);
  }
  const who = userId ? eq(matterRates.userId, userId) : isNull(matterRates.userId);
  await db()
    .delete(matterRates)
    .where(and(eq(matterRates.caseId, matter.id), who));
  if (hourlyRate !== null) {
    await db()
      .insert(matterRates)
      .values({
        caseId: matter.id,
        userId,
        hourlyRateCents: toCents(hourlyRate),
        updatedBy: actor.userId ?? null,
      });
  }
  await auditService.logEvent(
    {
      entityType: 'case',
      entityId: matter.id,
      action: 'matter_rate_set',
      summary: `Hourly rate changed on ${matter.caseNumber}`,
      details: { userId, hourlyRateCents: hourlyRate === null ? null : toCents(hourlyRate) },
    },
    actor,
  );
  return listMatterRates(matter.id);
}
