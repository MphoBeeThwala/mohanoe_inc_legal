// Calendar: court details, events, prescriptions, reminders, iCalendar
// export, permissions and isolation.
import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../server';
import { db } from '../db/client';
import { withTenant } from '../db/tenant';
import { auditEvents, calendarEvents, notifications } from '../db/schema';
import { createFirm } from '../services/firm.service';
import { rotateDataKey } from '../services/keys.service';
import { pendingReencryption, reencryptFirm } from '../services/reencrypt.service';
import { exportFirm } from '../services/firm-export.service';
import { testOutbox } from '../services/mail.service';
import { sendDueReminders } from '../services/calendar.service';
import { lastDayFor } from '../services/prescription.service';
import { courtCaseKey, courtCaseKeysIn } from '../lib/court';
import { createStaff, defaultFirm, inDefaultFirm, type TestStaff } from './helpers';

let attorney: TestStaff;
let paralegal: TestStaff;
let bookkeeper: TestStaff;
let matter: { id: string; caseNumber: string };

const TITLE = 'Trial: Ndlovu v Minister of Police';

async function openMatter(name: string, title: string) {
  const check = await request(app)
    .post('/api/conflicts')
    .set(attorney.auth)
    .send({ subjects: [{ name }], purpose: title });
  await request(app)
    .post(`/api/conflicts/${check.body.id}/decision`)
    .set(attorney.auth)
    .send({ decision: 'clear' });
  const client = await request(app)
    .post('/api/clients')
    .set(attorney.auth)
    .send({ kind: 'individual', details: { name }, conflictCheckId: check.body.id });
  const opened = await request(app).post('/api/cases').set(attorney.auth).send({
    clientId: client.body.id,
    conflictCheckId: check.body.id,
    title,
    practiceArea: 'Litigation',
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  return opened.body as { id: string; caseNumber: string };
}

const create = (staff: TestStaff, body: Record<string, unknown>) =>
  request(app).post('/api/calendar').set(staff.auth).send(body);

beforeAll(async () => {
  attorney = await createStaff({
    email: 'attorney@cal.example',
    role: 'attorney',
    fullName: 'Lerato Attorney',
  });
  paralegal = await createStaff({ email: 'para@cal.example', role: 'paralegal' });
  bookkeeper = await createStaff({ email: 'books@cal.example', role: 'bookkeeper' });
  matter = await openMatter('Sipho Ndlovu', 'Unlawful arrest claim');
});

describe('court case numbers and periods', () => {
  test('court case numbers normalise to number/yyyy', () => {
    const now = new Date('2026-11-09T00:00:00Z');
    expect(courtCaseKey('34660/16', now)).toBe('34660/2016');
    expect(courtCaseKey('034660/2016', now)).toBe('34660/2016');
    expect(courtCaseKey(' 34660 / 2016 ', now)).toBe('34660/2016');
    expect(courtCaseKey('2016-034660', now)).toBe('34660/2016');
    expect(courtCaseKey('A123/2024', now)).toBe('123/2024');
    expect(courtCaseKey('5/98', now)).toBe('5/1998');
    expect(courtCaseKey('hello', now)).toBeNull();
    expect(courtCaseKey('0/2020', now)).toBeNull();
    expect(
      courtCaseKeysIn('12 MEYER LH VS RAF 1DAY 34660/16 and 2023-012345 and 18099/20', now),
    ).toEqual(['34660/2016', '12345/2023', '18099/2020']);
  });

  test('the last day is the day before the anniversary', () => {
    expect(lastDayFor('general_3y', '2008-01-15')).toBe('2011-01-14');
    expect(lastDayFor('organ_of_state_notice', '2026-03-01')).toBe('2026-08-31');
    // Month ends clamp, then step back a day.
    expect(lastDayFor('organ_of_state_notice', '2026-08-31')).toBe('2027-02-27');
    expect(lastDayFor('general_3y', '2024-02-29')).toBe('2027-02-27');
    expect(lastDayFor('bond_judgment_30y', '2000-06-01')).toBe('2030-05-31');
    expect(lastDayFor('raf_unidentified', '2025-12-31')).toBe('2027-12-30');
  });

  test('court details on a matter', async () => {
    const set = await request(app)
      .put(`/api/cases/${matter.id}/court`)
      .set(attorney.auth)
      .send({ courtDivision: 'ZAGPPHC', courtCaseNumber: '034660/16' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ courtDivision: 'ZAGPPHC', courtCaseNumber: '034660/16' });
    const bad = await request(app)
      .put(`/api/cases/${matter.id}/court`)
      .set(attorney.auth)
      .send({ courtDivision: 'ZAGPPHC', courtCaseNumber: 'not a number' });
    expect(bad.status).toBe(400);
    const unknown = await request(app)
      .put(`/api/cases/${matter.id}/court`)
      .set(attorney.auth)
      .send({ courtDivision: 'NARNIA', courtCaseNumber: null });
    expect(unknown.status).toBe(400);
    expect(
      (
        await request(app)
          .put(`/api/cases/${matter.id}/court`)
          .set(bookkeeper.auth)
          .send({ courtDivision: null, courtCaseNumber: null })
      ).status,
    ).toBe(403);
  });
});

describe('events', () => {
  let eventId: string;

  test('an event is stored encrypted, without its title in the audit trail', async () => {
    const res = await create(attorney, {
      caseId: matter.caseNumber,
      title: TITLE,
      eventType: 'court_date',
      startsAt: '2031-03-03T09:30:00+02:00',
      endsAt: '2031-03-03T13:00:00+02:00',
      location: 'Court 4A, Palace of Justice',
      assigneeUserId: paralegal.id,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    eventId = res.body.id;
    expect(res.body).toMatchObject({
      title: TITLE,
      eventType: 'court_date',
      status: 'scheduled',
      source: 'manual',
      assigneeUserId: paralegal.id,
      reminderOffsets: [10080, 1440],
      startsAt: '2031-03-03T07:30:00.000Z',
    });
    const stored = await inDefaultFirm(async () => {
      const [row] = await db().select().from(calendarEvents).where(eq(calendarEvents.id, eventId));
      const trail = await db().select().from(auditEvents).where(eq(auditEvents.entityId, eventId));
      return { row, trail };
    });
    expect(stored.row?.contentEncrypted).toMatch(/^v2:/);
    expect(JSON.stringify(stored.row)).not.toContain('Ndlovu');
    expect(JSON.stringify(stored.trail)).not.toContain('Ndlovu');

    // 'hearing' is what older clients send.
    const legacy = await create(attorney, {
      caseId: matter.id,
      title: 'Hearing',
      eventType: 'hearing',
      startsAt: '2031-04-01T10:00:00Z',
    });
    expect(legacy.body.eventType).toBe('court_date');
  });

  test('input checks and permissions', async () => {
    const backwards = await create(attorney, {
      caseId: matter.id,
      title: 'x',
      startsAt: '2031-03-03T10:00:00Z',
      endsAt: '2031-03-03T09:00:00Z',
    });
    expect(backwards.status).toBe(400);
    expect(
      (
        await create(attorney, {
          caseId: matter.id,
          title: 'x',
          eventType: 'party',
          startsAt: '2031-01-01',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await create(bookkeeper, {
          caseId: matter.id,
          title: 'x',
          startsAt: '2031-01-01T10:00:00Z',
        })
      ).status,
    ).toBe(403);
    const support = await create(attorney, {
      caseId: matter.id,
      title: 'x',
      startsAt: '2031-01-01T10:00:00Z',
      assigneeUserId: '00000000-0000-4000-8000-000000000000',
    });
    expect(support.status).toBe(404);
  });

  test('listing, changing, finishing and deleting events', async () => {
    const range = await request(app)
      .get('/api/calendar?from=2031-03-01&to=2031-03-31')
      .set(attorney.auth);
    expect((range.body as Array<{ id: string }>).map((e) => e.id)).toContain(eventId);
    const mine = await request(app).get('/api/calendar?mine=1').set(paralegal.auth);
    expect((mine.body as Array<{ id: string }>).map((e) => e.id)).toEqual([eventId]);

    await inDefaultFirm(() =>
      db()
        .update(calendarEvents)
        .set({ remindersSent: [10080] })
        .where(eq(calendarEvents.id, eventId)),
    );
    const moved = await request(app)
      .patch(`/api/calendar/${eventId}`)
      .set(attorney.auth)
      .send({ startsAt: '2031-03-10T09:30:00+02:00', notes: 'Bring the docket' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ notes: 'Bring the docket', title: TITLE });
    const [row] = await inDefaultFirm(() =>
      db().select().from(calendarEvents).where(eq(calendarEvents.id, eventId)),
    );
    expect(row?.remindersSent).toEqual([]);

    const done = await request(app)
      .patch(`/api/calendar/${eventId}`)
      .set(attorney.auth)
      .send({ status: 'done' });
    expect(done.body.status).toBe('done');
    const open = await request(app).get('/api/calendar').set(attorney.auth);
    expect((open.body as Array<{ id: string }>).map((e) => e.id)).not.toContain(eventId);
    const all = await request(app).get('/api/calendar?all=1').set(attorney.auth);
    expect((all.body as Array<{ id: string }>).map((e) => e.id)).toContain(eventId);

    await request(app).delete(`/api/calendar/${eventId}`).set(attorney.auth).expect(200);
    expect((await request(app).get(`/api/calendar/${eventId}`).set(attorney.auth)).status).toBe(
      404,
    );
    expect((await request(app).get('/api/calendar/not-an-id').set(attorney.auth)).status).toBe(404);
  });
});

describe('prescriptions', () => {
  test('a prescription puts its last day on the calendar and follows status changes', async () => {
    const res = await request(app).post('/api/calendar/prescriptions').set(attorney.auth).send({
      caseRef: matter.id,
      rule: 'organ_of_state_notice',
      startsOn: '2026-10-01',
      notes: 'Arrest on 1 October; client Sipho',
      assigneeUserId: attorney.id,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      rule: 'organ_of_state_notice',
      lastDay: '2027-03-31',
      status: 'running',
      lapsed: false,
      notes: 'Arrest on 1 October; client Sipho',
    });
    const event = (await request(app).get(`/api/calendar/${res.body.eventId}`).set(attorney.auth))
      .body;
    expect(event).toMatchObject({
      eventType: 'prescription',
      source: 'prescription',
      allDay: true,
      startsAt: '2027-03-30T22:00:00.000Z',
      reminderOffsets: [129600, 43200, 10080, 1440],
    });
    expect(event.title).toContain('organ of state');

    // Its date belongs to the prescription.
    expect(
      (
        await request(app)
          .patch(`/api/calendar/${res.body.eventId}`)
          .set(attorney.auth)
          .send({ startsAt: '2027-05-01' })
      ).status,
    ).toBe(409);
    expect(
      (await request(app).delete(`/api/calendar/${res.body.eventId}`).set(attorney.auth)).status,
    ).toBe(409);

    const later = await request(app)
      .patch(`/api/calendar/prescriptions/${res.body.id}`)
      .set(attorney.auth)
      .send({ startsOn: '2026-11-01' });
    expect(later.body.lastDay).toBe('2027-04-30');
    const movedEvent = (
      await request(app).get(`/api/calendar/${res.body.eventId}`).set(attorney.auth)
    ).body;
    expect(movedEvent.startsAt).toBe('2027-04-29T22:00:00.000Z');

    const served = await request(app)
      .patch(`/api/calendar/prescriptions/${res.body.id}`)
      .set(attorney.auth)
      .send({ status: 'interrupted', notes: 'Notice served' });
    expect(served.body.status).toBe('interrupted');
    expect(
      (await request(app).get(`/api/calendar/${res.body.eventId}`).set(attorney.auth)).body.status,
    ).toBe('done');

    const custom = await request(app)
      .post('/api/calendar/prescriptions')
      .set(attorney.auth)
      .send({ caseRef: matter.id, rule: 'custom', startsOn: '2026-01-01' });
    expect(custom.status).toBe(400);
    const lapsed = await request(app)
      .post('/api/calendar/prescriptions')
      .set(attorney.auth)
      .send({ caseRef: matter.id, rule: 'custom', startsOn: '2020-01-01', lastDay: '2021-01-01' });
    expect(lapsed.body).toMatchObject({ lapsed: true });
    expect(lapsed.body.daysLeft).toBeLessThan(0);

    const list = await request(app)
      .get(`/api/calendar/prescriptions?caseId=${matter.id}`)
      .set(paralegal.auth);
    expect(list.body).toHaveLength(2);
  });
});

describe('reminders', () => {
  test('due reminders go out once, by email and in the app, without the title', async () => {
    const now = new Date('2031-06-01T08:00:00Z');
    const assigned = await create(attorney, {
      caseId: matter.id,
      title: TITLE,
      eventType: 'court_date',
      startsAt: '2031-06-02T07:00:00Z', // 23 hours away: the 1-day reminder is due
      assigneeUserId: paralegal.id,
    });
    const team = await create(attorney, {
      caseId: matter.id,
      title: 'Consultation with Sipho Ndlovu',
      eventType: 'consultation',
      startsAt: '2031-06-01T08:30:00Z', // 30 minutes away: the 1-hour reminder is due
    });

    const before = testOutbox().length;
    const run = await inDefaultFirm(() => sendDueReminders(now));
    expect(run.events).toBeGreaterThanOrEqual(2);
    const sent = testOutbox().slice(before);
    const toParalegal = sent.filter((mail) => mail.to === paralegal.email);
    expect(toParalegal).toHaveLength(1);
    expect(toParalegal[0]!.subject).toContain(matter.caseNumber);
    // The matter's team (the attorney who opened it) gets unassigned events.
    expect(sent.some((mail) => mail.to === attorney.email)).toBe(true);
    for (const mail of sent) {
      expect(mail.text).not.toContain('Ndlovu');
      expect(mail.subject).not.toContain('Ndlovu');
    }
    const inApp = await inDefaultFirm(() =>
      db().select().from(notifications).where(eq(notifications.relatedEntityId, assigned.body.id)),
    );
    expect(inApp).toHaveLength(1);
    expect(inApp[0]!.recipientUserId).toBe(paralegal.id);
    expect(JSON.stringify(inApp)).not.toContain('Ndlovu');

    // The 7-day reminder fell due days ago: marked, not sent.
    const [row] = await inDefaultFirm(() =>
      db().select().from(calendarEvents).where(eq(calendarEvents.id, assigned.body.id)),
    );
    expect(row?.remindersSent.sort()).toEqual([10080, 1440].sort());

    const again = testOutbox().length;
    await inDefaultFirm(() => sendDueReminders(now));
    expect(testOutbox().length).toBe(again);

    // Cancelled events remind no one.
    await request(app)
      .patch(`/api/calendar/${team.body.id}`)
      .set(attorney.auth)
      .send({ status: 'cancelled', reminderOffsets: [30] });
    await inDefaultFirm(() => sendDueReminders(new Date('2031-06-01T08:05:00Z')));
    expect(testOutbox().length).toBe(again);
  });
});

describe('iCalendar export', () => {
  test('scheduled events as an .ics file', async () => {
    const res = await request(app).get('/api/calendar/ics').set(attorney.auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    const text = res.text;
    expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(text).toContain('BEGIN:VEVENT');
    expect(text).toContain(`SUMMARY:${matter.caseNumber}: Trial: Ndlovu v Minister of Police`);
    expect(text).toContain('DTSTART:20310602T070000Z');
    expect(text.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    for (const line of text.split('\r\n')) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    }
  });
});

describe('isolation', () => {
  test("walled staff and other firms see none of the matter's calendar", async () => {
    const walled = await createStaff({ email: 'walled@cal.example', role: 'attorney' });
    await request(app)
      .post(`/api/cases/${matter.id}/exclusions`)
      .set(attorney.auth)
      .send({ userId: walled.id, reason: 'Acts for the Minister' })
      .expect(201);
    const events = await request(app).get('/api/calendar?all=1').set(walled.auth);
    expect((events.body as Array<{ caseId: string }>).some((e) => e.caseId === matter.id)).toBe(
      false,
    );
    const periods = await request(app).get('/api/calendar/prescriptions').set(walled.auth);
    expect(periods.body).toEqual([]);
    const ics = await request(app).get('/api/calendar/ics').set(walled.auth);
    expect(ics.text).not.toContain(matter.caseNumber);
    const one = (await request(app).get('/api/calendar?all=1').set(attorney.auth)).body[0];
    expect((await request(app).get(`/api/calendar/${one.id}`).set(walled.auth)).status).toBe(404);
    expect(
      (await create(walled, { caseId: matter.id, title: 'x', startsAt: '2031-01-01T10:00:00Z' }))
        .status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .put(`/api/cases/${matter.id}/court`)
          .set(walled.auth)
          .send({ courtDivision: null, courtCaseNumber: null })
      ).status,
    ).toBe(404);

    const otherFirm = await createFirm({
      slug: 'cal-other',
      legalName: 'Other',
      domains: ['portal.cal-other.test'],
    });
    const outsider = await createStaff({
      firm: otherFirm,
      host: 'portal.cal-other.test',
      email: 'a@cal-other.example',
      role: 'admin',
    });
    const outside = (path: string) =>
      request(app).get(path).set('Host', 'portal.cal-other.test').set(outsider.auth);
    expect((await outside('/api/calendar?all=1')).body).toEqual([]);
    expect((await outside(`/api/calendar/${one.id}`)).status).toBe(404);
    expect((await outside('/api/calendar/prescriptions')).body).toEqual([]);
    const assignAcross = await request(app)
      .post('/api/calendar')
      .set('Host', 'portal.cal-other.test')
      .set(outsider.auth)
      .send({ caseId: matter.id, title: 'x', startsAt: '2031-01-01T10:00:00Z' });
    expect(assignAcross.status).toBe(404);
  });
});

describe('records', () => {
  test('re-encryption and the firm export cover events and prescription notes', async () => {
    const firm = await defaultFirm();
    await withTenant(firm, () => rotateDataKey(), { system: true });
    expect(
      (await withTenant(firm, () => pendingReencryption(), { system: true })).pending.calendar,
    ).toBeGreaterThan(0);
    await reencryptFirm(firm);
    expect(
      (await withTenant(firm, () => pendingReencryption(), { system: true })).pending.calendar,
    ).toBe(0);
    const data = await exportFirm(firm);
    const events = data.tables.calendarEvents as Array<{ content: { title: string } | null }>;
    expect(events.some((e) => e.content?.title === TITLE)).toBe(true);
    const periods = data.tables.matterPrescriptions as Array<{ notes: string | null }>;
    expect(periods.some((p) => p.notes === 'Notice served')).toBe(true);
  });
});
