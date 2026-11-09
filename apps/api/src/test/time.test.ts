// Time recording: rates, entries in 6-minute units, the timer, WIP,
// permissions and isolation.
import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../server';
import { db } from '../db/client';
import { withTenant } from '../db/tenant';
import { auditEvents, timeEntries, timers } from '../db/schema';
import { createFirm } from '../services/firm.service';
import { rotateDataKey } from '../services/keys.service';
import { pendingReencryption, reencryptFirm } from '../services/reencrypt.service';
import { exportFirm } from '../services/firm-export.service';
import { unitsFromMinutes, unitsFromSeconds, valueCents } from '../services/time.service';
import { localDate } from '../lib/time';
import { createStaff, defaultFirm, inDefaultFirm, type TestStaff } from './helpers';

let admin: TestStaff;
let attorney: TestStaff;
let paralegal: TestStaff;
let secretary: TestStaff;
let bookkeeper: TestStaff;
let matterId: string;
let caseNumber: string;
let secondMatterId: string;

const NARRATIVE = 'Consultation with Thandi Nkosi about her dismissal';

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
  const matter = await request(app).post('/api/cases').set(attorney.auth).send({
    clientId: client.body.id,
    conflictCheckId: check.body.id,
    title,
    practiceArea: 'Labour',
  });
  expect(matter.status, JSON.stringify(matter.body)).toBe(201);
  return matter.body as { id: string; caseNumber: string };
}

function record(staff: TestStaff, body: Record<string, unknown>) {
  return request(app).post('/api/time/entries').set(staff.auth).send(body);
}

beforeAll(async () => {
  admin = await createStaff({ email: 'admin@time.example', role: 'admin', fullName: 'Ada Admin' });
  attorney = await createStaff({
    email: 'attorney@time.example',
    role: 'attorney',
    fullName: 'Lerato Attorney',
  });
  paralegal = await createStaff({
    email: 'paralegal@time.example',
    role: 'paralegal',
    fullName: 'Sipho Paralegal',
  });
  secretary = await createStaff({ email: 'secretary@time.example', role: 'secretary' });
  bookkeeper = await createStaff({ email: 'books@time.example', role: 'bookkeeper' });
  const first = await openMatter('Thandi Nkosi', 'Unfair dismissal');
  matterId = first.id;
  caseNumber = first.caseNumber;
  secondMatterId = (await openMatter('Pieter Botha', 'Lease dispute')).id;
});

describe('units and values', () => {
  test('time rounds up to whole 6-minute units', () => {
    expect(unitsFromMinutes(1)).toBe(1);
    expect(unitsFromMinutes(6)).toBe(1);
    expect(unitsFromMinutes(7)).toBe(2);
    expect(unitsFromMinutes(60)).toBe(10);
    expect(unitsFromSeconds(0)).toBe(1);
    expect(unitsFromSeconds(361)).toBe(2);
    expect(valueCents(3, 250_000)).toBe(75_000);
    expect(valueCents(1, 99_999)).toBe(10_000);
  });
});

describe('rates', () => {
  test('only administrators set rates; the list holds the people who record time', async () => {
    const denied = await request(app)
      .put(`/api/time/rates/${attorney.id}`)
      .set(attorney.auth)
      .send({ hourlyRate: 9000 });
    expect(denied.status).toBe(403);

    const set = await request(app)
      .put(`/api/time/rates/${attorney.id}`)
      .set(admin.auth)
      .send({ hourlyRate: '2 500' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const rates = await request(app).get('/api/time/rates').set(bookkeeper.auth);
    expect(rates.status).toBe(200);
    expect(rates.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: attorney.id, hourlyRate: 2500 }),
        expect.objectContaining({ userId: paralegal.id, hourlyRate: null }),
      ]),
    );
    const ids = (rates.body as Array<{ userId: string }>).map((r) => r.userId);
    expect(ids).not.toContain(secretary.id);
    expect(ids).not.toContain(bookkeeper.id);

    const bad = await request(app)
      .put(`/api/time/rates/${attorney.id}`)
      .set(admin.auth)
      .send({ hourlyRate: -5 });
    expect(bad.status).toBe(400);
    const noEarner = await request(app)
      .put(`/api/time/rates/${secretary.id}`)
      .set(admin.auth)
      .send({ hourlyRate: 500 });
    expect(noEarner.status).toBe(400);
  });

  test('a matter rate (for one person, or everyone) comes before the standard rate', async () => {
    const everyone = await request(app)
      .put(`/api/time/matters/${secondMatterId}/rates`)
      .set(admin.auth)
      .send({ hourlyRate: 2000 });
    expect(everyone.status, JSON.stringify(everyone.body)).toBe(200);
    const a = await record(attorney, { caseRef: secondMatterId, units: 10, description: 'Lease' });
    expect(a.body).toMatchObject({ rate: 2000, amount: 2000 });

    await request(app)
      .put(`/api/time/matters/${secondMatterId}/rates`)
      .set(admin.auth)
      .send({ userId: attorney.id, hourlyRate: 1800 })
      .expect(200);
    const rates = await request(app)
      .get(`/api/time/matters/${secondMatterId}/rates`)
      .set(attorney.auth);
    expect(rates.body).toEqual([
      { userId: null, fullName: null, hourlyRate: 2000 },
      { userId: attorney.id, fullName: 'Lerato Attorney', hourlyRate: 1800 },
    ]);
    const b = await record(attorney, { caseRef: secondMatterId, units: 10, description: 'Lease' });
    expect(b.body).toMatchObject({ rate: 1800, amount: 1800 });
    // The earlier entry keeps the rate it was recorded at.
    const list = await request(app)
      .get(`/api/time/entries?caseId=${secondMatterId}`)
      .set(attorney.auth);
    expect((list.body as Array<{ rate: number }>).map((e) => e.rate).sort()).toEqual([1800, 2000]);

    for (const userId of [null, attorney.id]) {
      await request(app)
        .put(`/api/time/matters/${secondMatterId}/rates`)
        .set(admin.auth)
        .send({ userId, hourlyRate: null })
        .expect(200);
    }
    const c = await record(attorney, { caseRef: secondMatterId, units: 1, description: 'Lease' });
    expect(c.body).toMatchObject({ rate: 2500, amount: 250 });
  });
});

describe('entries', () => {
  test('recording time: units, value, encryption at rest, no narrative in the audit trail', async () => {
    const res = await record(attorney, {
      caseRef: caseNumber,
      minutes: 13,
      activity: 'consultation',
      description: NARRATIVE,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      caseId: matterId,
      caseNumber,
      userId: attorney.id,
      feeEarnerName: 'Lerato Attorney',
      workDate: localDate(),
      units: 3,
      minutes: 18,
      billable: true,
      rate: 2500,
      amount: 750,
      activity: 'consultation',
      description: NARRATIVE,
      source: 'manual',
      status: 'unbilled',
    });

    const stored = await inDefaultFirm(async () => {
      const [row] = await db().select().from(timeEntries).where(eq(timeEntries.id, res.body.id));
      const trail = await db()
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, res.body.id));
      return { row, trail };
    });
    expect(stored.row?.descriptionEncrypted).toMatch(/^v2:/);
    expect(JSON.stringify(stored.row)).not.toContain('Thandi');
    expect(stored.trail.length).toBe(1);
    expect(JSON.stringify(stored.trail)).not.toContain('Thandi');
  });

  test('input checks: one amount, real past dates, at most 24 hours a day', async () => {
    const both = await record(attorney, {
      caseRef: matterId,
      minutes: 6,
      units: 1,
      description: 'x',
    });
    expect(both.status).toBe(400);
    expect((await record(attorney, { caseRef: matterId, description: 'x' })).status).toBe(400);
    const future = await record(attorney, {
      caseRef: matterId,
      units: 1,
      workDate: '2999-01-01',
      description: 'x',
    });
    expect(future.status).toBe(400);
    const notADate = await record(attorney, {
      caseRef: matterId,
      units: 1,
      workDate: '2025-02-30',
      description: 'x',
    });
    expect(notADate.status).toBe(400);

    const day = '2025-03-03';
    const full = await record(paralegal, {
      caseRef: matterId,
      units: 240,
      billable: false,
      workDate: day,
      description: 'Long day',
    });
    expect(full.status, JSON.stringify(full.body)).toBe(201);
    const over = await record(paralegal, {
      caseRef: secondMatterId,
      units: 1,
      billable: false,
      workDate: day,
      description: 'One more',
    });
    expect(over.status).toBe(400);
    expect(over.body.message).toContain('24 hours');
  });

  test('billable time needs a rate; non-billable time has no value', async () => {
    const billable = await record(paralegal, {
      caseRef: matterId,
      units: 5,
      description: 'Bundle of documents',
    });
    expect(billable.status).toBe(409);
    expect(billable.body.message).toContain('No hourly rate');

    const free = await record(paralegal, {
      caseRef: matterId,
      units: 5,
      billable: false,
      description: 'Bundle of documents',
    });
    expect(free.status).toBe(201);
    expect(free.body).toMatchObject({ billable: false, rate: 0, amount: 0 });

    await request(app)
      .put(`/api/time/rates/${paralegal.id}`)
      .set(admin.auth)
      .send({ hourlyRate: 1200 })
      .expect(200);
    const priced = await request(app)
      .patch(`/api/time/entries/${free.body.id}`)
      .set(paralegal.auth)
      .send({ billable: true, minutes: 31 });
    expect(priced.status, JSON.stringify(priced.body)).toBe(200);
    expect(priced.body).toMatchObject({ billable: true, units: 6, rate: 1200, amount: 720 });
  });

  test('who may record, change and write off time', async () => {
    expect(
      (await record(secretary, { caseRef: matterId, units: 1, description: 'x' })).status,
    ).toBe(403);
    expect(
      (await record(bookkeeper, { caseRef: matterId, units: 1, description: 'x' })).status,
    ).toBe(403);
    const forOther = await record(attorney, {
      caseRef: matterId,
      units: 1,
      userId: paralegal.id,
      description: 'x',
    });
    expect(forOther.status).toBe(403);
    const byAdmin = await record(admin, {
      caseRef: matterId,
      units: 2,
      userId: paralegal.id,
      description: 'Filing at court',
    });
    expect(byAdmin.status).toBe(201);
    expect(byAdmin.body).toMatchObject({ userId: paralegal.id, amount: 240 });

    const notMine = await request(app)
      .patch(`/api/time/entries/${byAdmin.body.id}`)
      .set(attorney.auth)
      .send({ units: 1 });
    expect(notMine.status).toBe(403);
    expect(
      (await request(app).delete(`/api/time/entries/${byAdmin.body.id}`).set(attorney.auth)).status,
    ).toBe(403);
    const corrected = await request(app)
      .patch(`/api/time/entries/${byAdmin.body.id}`)
      .set(admin.auth)
      .send({ units: 3, description: 'Filing and service' });
    expect(corrected.body).toMatchObject({
      units: 3,
      amount: 360,
      description: 'Filing and service',
    });

    expect(
      (await request(app).post(`/api/time/entries/${byAdmin.body.id}/write-off`).set(attorney.auth))
        .status,
    ).toBe(403);
    const off = await request(app)
      .post(`/api/time/entries/${byAdmin.body.id}/write-off`)
      .set(admin.auth);
    expect(off.body.status).toBe('written_off');
    const frozen = await request(app)
      .patch(`/api/time/entries/${byAdmin.body.id}`)
      .set(admin.auth)
      .send({ units: 1 });
    expect(frozen.status).toBe(409);

    const own = await record(attorney, { caseRef: matterId, units: 1, description: 'Note' });
    await request(app).delete(`/api/time/entries/${own.body.id}`).set(attorney.auth).expect(200);
  });

  test('closed matters take no new time', async () => {
    const closing = await openMatter('Naledi Dube', 'Finished matter');
    const status = await request(app)
      .post(`/api/cases/${closing.id}/status`)
      .set(attorney.auth)
      .send({ status: 'closed' });
    expect(status.status, JSON.stringify(status.body)).toBeLessThan(300);
    const res = await record(attorney, { caseRef: closing.id, units: 1, description: 'Late note' });
    expect(res.status).toBe(409);
  });
});

describe('timer', () => {
  test('start, pause, resume and stop records the time in units', async () => {
    expect((await request(app).get('/api/time/timer').set(attorney.auth)).body).toEqual({
      timer: null,
    });
    const start = await request(app)
      .post('/api/time/timer')
      .set(attorney.auth)
      .send({ caseRef: matterId, activity: 'drafting' });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    expect(start.body).toMatchObject({ caseNumber, running: true, units: 1 });

    const again = await request(app)
      .post('/api/time/timer')
      .set(attorney.auth)
      .send({ caseRef: secondMatterId });
    expect(again.status).toBe(409);

    // 61 minutes ago.
    await inDefaultFirm(() =>
      db()
        .update(timers)
        .set({ runningSince: new Date(Date.now() - 61 * 60_000) })
        .where(eq(timers.userId, attorney.id)),
    );
    const paused = await request(app).post('/api/time/timer/pause').set(attorney.auth);
    expect(paused.body).toMatchObject({ running: false, units: 11 });
    expect(paused.body.elapsedSeconds).toBeGreaterThanOrEqual(61 * 60);
    const resumed = await request(app).post('/api/time/timer/resume').set(attorney.auth);
    expect(resumed.body.running).toBe(true);

    const undescribed = await request(app).post('/api/time/timer/stop').set(attorney.auth).send({});
    expect(undescribed.status).toBe(400);
    const stop = await request(app)
      .post('/api/time/timer/stop')
      .set(attorney.auth)
      .send({ description: 'Drafted the statement of claim' });
    expect(stop.status, JSON.stringify(stop.body)).toBe(201);
    expect(stop.body).toMatchObject({
      source: 'timer',
      units: 11,
      amount: 2750,
      activity: 'drafting',
      caseId: matterId,
    });
    expect((await request(app).get('/api/time/timer').set(attorney.auth)).body.timer).toBeNull();
  });

  test('a timer can be discarded; the secretary has none', async () => {
    await request(app)
      .post('/api/time/timer')
      .set(attorney.auth)
      .send({ caseRef: matterId, description: 'Call' })
      .expect(201);
    await request(app).delete('/api/time/timer').set(attorney.auth).expect(200);
    expect(
      (await request(app).post('/api/time/timer/stop').set(attorney.auth).send({})).status,
    ).toBe(404);
    expect(
      (await request(app).post('/api/time/timer').set(secretary.auth).send({ caseRef: matterId }))
        .status,
    ).toBe(403);
  });

  test('a billable timer needs a rate before it starts', async () => {
    const newcomer = await createStaff({ email: 'new@time.example', role: 'attorney' });
    const res = await request(app)
      .post('/api/time/timer')
      .set(newcomer.auth)
      .send({ caseRef: matterId });
    expect(res.status).toBe(409);
  });
});

describe('work in progress', () => {
  test('WIP is unbilled billable time, by matter and fee earner', async () => {
    const res = await request(app).get('/api/time/wip').set(bookkeeper.auth);
    expect(res.status).toBe(200);
    const entries = await inDefaultFirm(() => db().select().from(timeEntries));
    const wip = entries.filter((e) => e.billable && e.status === 'unbilled');
    expect(res.body.units).toBe(wip.reduce((t, e) => t + e.units, 0));
    expect(res.body.value).toBe(wip.reduce((t, e) => t + e.amountCents, 0) / 100);
    const first = (res.body.matters as Array<{ caseId: string; value: number }>).find(
      (m) => m.caseId === matterId,
    );
    expect(first?.value).toBe(
      wip.filter((e) => e.caseId === matterId).reduce((t, e) => t + e.amountCents, 0) / 100,
    );
    expect(res.body.feeEarners).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: paralegal.id, value: 720 })]),
    );
    expect((await request(app).get('/api/time/wip').set(secretary.auth)).status).toBe(403);
  });
});

describe('isolation', () => {
  test('walled staff see no time on the matter; other firms see none at all', async () => {
    const walled = await createStaff({ email: 'walled@time.example', role: 'paralegal' });
    await request(app)
      .post(`/api/cases/${matterId}/exclusions`)
      .set(attorney.auth)
      .send({ userId: walled.id, reason: 'Acted for the employer' })
      .expect(201);
    const list = await request(app).get('/api/time/entries').set(walled.auth);
    expect(list.status).toBe(200);
    expect((list.body as Array<{ caseId: string }>).some((e) => e.caseId === matterId)).toBe(false);
    const wip = await request(app).get('/api/time/wip').set(walled.auth);
    expect((wip.body.matters as Array<{ caseId: string }>).some((m) => m.caseId === matterId)).toBe(
      false,
    );
    const anEntry = (await request(app).get(`/api/time/entries?caseId=${matterId}`).set(admin.auth))
      .body[0];
    expect(
      (await request(app).patch(`/api/time/entries/${anEntry.id}`).set(walled.auth).send({}))
        .status,
    ).toBe(404);
    expect(
      (await record(walled, { caseRef: matterId, units: 1, billable: false, description: 'x' }))
        .status,
    ).toBe(404);

    const other = await createFirm({
      slug: 'time-other',
      legalName: 'Other',
      domains: ['portal.time-other.test'],
    });
    const outsider = await createStaff({
      firm: other,
      host: 'portal.time-other.test',
      email: 'a@time-other.example',
      role: 'admin',
    });
    const theirs = await request(app)
      .get('/api/time/entries')
      .set('Host', 'portal.time-other.test')
      .set(outsider.auth);
    expect(theirs.body).toEqual([]);
    const edit = await request(app)
      .patch(`/api/time/entries/${anEntry.id}`)
      .set('Host', 'portal.time-other.test')
      .set(outsider.auth)
      .send({ units: 1 });
    expect(edit.status).toBe(404);
    const rate = await request(app)
      .put(`/api/time/rates/${attorney.id}`)
      .set('Host', 'portal.time-other.test')
      .set(outsider.auth)
      .send({ hourlyRate: 1 });
    expect(rate.status).toBe(404);
  });
});

describe('records', () => {
  test('re-encryption and the firm export cover time narratives', async () => {
    const firm = await defaultFirm();
    await request(app)
      .post('/api/time/timer')
      .set(attorney.auth)
      .send({ caseRef: matterId, description: 'Call with Thandi' })
      .expect(201);
    await withTenant(firm, () => rotateDataKey(), { system: true });
    expect(
      (await withTenant(firm, () => pendingReencryption(), { system: true })).pending.time,
    ).toBeGreaterThan(0);
    await reencryptFirm(firm);
    expect(
      (await withTenant(firm, () => pendingReencryption(), { system: true })).pending.time,
    ).toBe(0);
    const timer = await request(app).get('/api/time/timer').set(attorney.auth);
    expect(timer.body.timer.description).toBe('Call with Thandi');

    const data = await exportFirm(firm);
    const exported = data.tables.timeEntries as Array<{ description: string }>;
    expect(exported.some((e) => e.description === NARRATIVE)).toBe(true);
    expect((data.tables.timers as unknown[]).length).toBe(1);
    expect(data.tables.staffRates?.length).toBeGreaterThan(0);
  });
});
