// Practice reports: figures checked against hand-computed fixtures; firm vs
// own scope; restricted matters masked but counted; CSV safe for spreadsheets;
// other firms see nothing.
//
// Fixtures (last month, rates: Lerato R2 000/h, Sipho R1 000/h):
//   M1 (Lerato): 60 min billable (billed), 30 min billable (unbilled),
//                30 min non-billable, 60 min billable (written off),
//                R450 disbursement (unbilled)
//   M2 (Sipho, restricted): 120 min billable (unbilled)
//   Invoice on M1 for the first entry: R2 000 + 15% VAT = R2 300, R1 150 paid.
import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import app from '../server';
import { csvCell } from '../lib/csv';
import { localDate } from '../lib/time';
import { createFirm } from '../services/firm.service';
import { createStaff, type TestStaff } from './helpers';

let admin: TestStaff;
let lerato: TestStaff;
let sipho: TestStaff;
let bookkeeper: TestStaff;
let secretary: TestStaff;
let outsider: TestStaff;
let m1: { id: string; caseNumber: string };
let m2: { id: string; caseNumber: string };
const OTHER_HOST = 'portal.reports-other.test';
const TODAY = localDate();
// Fixtures sit in last month, so the range (last month to today) stays valid on any day.
const LAST = (() => {
  const [y, m] = TODAY.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
})();
const START = `${LAST}-01`;
const RANGE = `from=${START}&to=${TODAY}`;

async function openMatter(staff: TestStaff, name: string, title: string) {
  const as = (r: request.Test) => r.set(staff.auth);
  const check = await as(request(app).post('/api/conflicts')).send({
    subjects: [{ name }],
    purpose: title,
  });
  await as(request(app).post(`/api/conflicts/${check.body.id}/decision`)).send({
    decision: 'clear',
  });
  const client = await as(request(app).post('/api/clients')).send({
    kind: 'individual',
    details: { name, address: '1 Long Street, Cape Town' },
    conflictCheckId: check.body.id,
  });
  const opened = await as(request(app).post('/api/cases')).send({
    clientId: client.body.id,
    conflictCheckId: check.body.id,
    title,
    practiceArea: 'Property',
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  return opened.body as { id: string; caseNumber: string };
}

const record = async (staff: TestStaff, body: Record<string, unknown>) => {
  const res = await request(app).post('/api/time/entries').set(staff.auth).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};

const report = (staff: TestStaff, kind: string, query = RANGE) =>
  request(app).get(`/api/reports/practice/${kind}?${query}`).set(staff.auth);

beforeAll(async () => {
  admin = await createStaff({
    email: 'admin@reports.example',
    role: 'admin',
    fullName: 'Ada Admin',
  });
  lerato = await createStaff({
    email: 'lerato@reports.example',
    role: 'attorney',
    fullName: 'Lerato Attorney',
  });
  sipho = await createStaff({
    email: 'sipho@reports.example',
    role: 'attorney',
    fullName: 'Sipho Attorney',
  });
  bookkeeper = await createStaff({
    email: 'books@reports.example',
    role: 'bookkeeper',
    fullName: 'Bongi Books',
  });
  secretary = await createStaff({ email: 'desk@reports.example', role: 'secretary' });
  for (const [who, rate] of [
    [lerato, 2000],
    [sipho, 1000],
  ] as const) {
    await request(app)
      .put(`/api/time/rates/${who.id}`)
      .set(admin.auth)
      .send({ hourlyRate: rate })
      .expect(200);
  }
  await request(app)
    .patch('/api/firm/settings')
    .set(admin.auth)
    .send({ billing: { vatNumber: '4987654321', address: '1 Smith Street, Durban' } })
    .expect(200);

  m1 = await openMatter(lerato, 'Zanele Mthembu', 'Transfer of erf 9');
  m2 = await openMatter(sipho, 'Pieter van Wyk', 'Confidential dispute');
  await request(app)
    .put(`/api/cases/${m2.id}/access`)
    .set(sipho.auth)
    .send({ access: 'restricted' })
    .expect(200);

  const billed = await record(lerato, {
    caseRef: m1.id,
    workDate: `${LAST}-05`,
    minutes: 60,
    description: 'Drafted deed of sale',
  });
  await record(lerato, {
    caseRef: m1.id,
    workDate: `${LAST}-06`,
    minutes: 30,
    description: 'Call with conveyancer',
  });
  await record(lerato, {
    caseRef: m1.id,
    workDate: `${LAST}-07`,
    minutes: 30,
    billable: false,
    description: 'Internal file note',
  });
  const writeOff = await record(lerato, {
    caseRef: m1.id,
    workDate: `${LAST}-09`,
    minutes: 60,
    description: 'Duplicate research',
  });
  await request(app).post(`/api/time/entries/${writeOff}/write-off`).set(admin.auth).expect(200);
  await record(sipho, {
    caseRef: m2.id,
    workDate: `${LAST}-08`,
    minutes: 120,
    description: 'Consultation',
  });
  const cost = await request(app)
    .post('/api/billing/disbursements')
    .set(lerato.auth)
    .send({ caseRef: m1.id, incurredOn: `${LAST}-05`, description: 'Deeds office', amount: 450 });
  expect(cost.status, JSON.stringify(cost.body)).toBe(201);

  const invoice = await request(app)
    .post('/api/billing/invoices')
    .set(lerato.auth)
    .send({
      caseRef: m1.id,
      subject: 'First account',
      timeEntryIds: [billed],
      disbursementIds: [],
    });
  expect(invoice.status, JSON.stringify(invoice.body)).toBe(201);
  const issued = await request(app)
    .post(`/api/billing/invoices/${invoice.body.id}/issue`)
    .set(lerato.auth);
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  await request(app)
    .post(`/api/billing/invoices/${invoice.body.id}/payments`)
    .set(bookkeeper.auth)
    .send({ amount: 1150, method: 'eft' })
    .expect(201);

  await request(app)
    .patch(`/api/users/${lerato.id}`)
    .set(admin.auth)
    .send({ targetHoursPerMonth: 100 })
    .expect(200);

  const other = await createFirm({
    slug: 'reports-other',
    legalName: 'Other Reports Inc',
    domains: [OTHER_HOST],
  });
  outsider = await createStaff({
    email: 'admin@reports-other.example',
    role: 'admin',
    firm: other,
    host: OTHER_HOST,
  });
});

describe('firm-wide figures (administrator)', () => {
  test('work in progress: unbilled billable time and disbursements', async () => {
    const res = await report(admin, 'wip');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.scope).toBe('firm');
    expect(res.body.totals).toEqual({
      hours: 2.5,
      timeCents: 300_000,
      disbursementCents: 45_000,
      totalCents: 345_000,
    });
    const byMatter = Object.fromEntries(
      res.body.matters.map((m: { caseNumber: string }) => [m.caseNumber, m]),
    );
    expect(byMatter[m1.caseNumber]).toMatchObject({
      hours: 0.5,
      timeCents: 100_000,
      disbursementCents: 45_000,
      totalCents: 145_000,
      oldestWorkDate: `${LAST}-06`,
      restricted: false,
    });
    // An administrator sees the restricted matter.
    expect(byMatter[m2.caseNumber]).toMatchObject({ hours: 2, timeCents: 200_000 });
    expect(res.body.feeEarners).toEqual([
      { userId: sipho.id, name: 'Sipho Attorney', hours: 2, timeCents: 200_000 },
      { userId: lerato.id, name: 'Lerato Attorney', hours: 0.5, timeCents: 100_000 },
    ]);
  });

  test('realisation: billed ÷ recorded, collected ÷ invoiced', async () => {
    const res = await report(admin, 'realisation');
    expect(res.status).toBe(200);
    const leratoRow = res.body.feeEarners.find((e: { userId: string }) => e.userId === lerato.id);
    expect(leratoRow).toMatchObject({
      recordedCents: 500_000,
      billedCents: 200_000,
      writtenOffCents: 200_000,
      unbilledCents: 100_000,
      billingRealisation: 0.4,
    });
    expect(res.body.totals).toMatchObject({
      recordedCents: 700_000,
      billedCents: 200_000,
      billingRealisation: 0.2857,
      invoicedCents: 230_000,
      collectedCents: 115_000,
      collectionRealisation: 0.5,
    });
    const first = res.body.matters.find(
      (m: { caseNumber: string }) => m.caseNumber === m1.caseNumber,
    );
    expect(first).toMatchObject({ invoicedCents: 230_000, collectedCents: 115_000 });
  });

  test('utilisation: billable hours against the monthly target', async () => {
    const res = await report(admin, 'utilisation');
    expect(res.status).toBe(200);
    const october = res.body.rows.filter((r: { month: string }) => r.month === LAST);
    expect(october.find((r: { userId: string }) => r.userId === lerato.id)).toEqual({
      userId: lerato.id,
      name: 'Lerato Attorney',
      month: LAST,
      billableHours: 2.5,
      nonBillableHours: 0.5,
      targetHours: 100,
      utilisation: 0.025,
    });
    expect(october.find((r: { userId: string }) => r.userId === sipho.id)).toMatchObject({
      billableHours: 2,
      targetHours: null,
      utilisation: null,
    });
    // Staff who record no time and have no target aren't listed.
    expect(res.body.rows.some((r: { userId: string }) => r.userId === secretary.id)).toBe(false);
  });

  test('fee-earner summary and aged debtors', async () => {
    const summary = await report(admin, 'fee-earners');
    expect(summary.body.rows.find((r: { userId: string }) => r.userId === lerato.id)).toEqual({
      userId: lerato.id,
      name: 'Lerato Attorney',
      billableHours: 2.5,
      nonBillableHours: 0.5,
      recordedCents: 500_000,
      billedCents: 200_000,
      writtenOffCents: 200_000,
    });
    const debtors = await report(admin, 'debtors');
    expect(debtors.status).toBe(200);
    expect(debtors.body.totals).toMatchObject({ current: 115_000, total: 115_000 });
    expect(debtors.body.clients).toHaveLength(1);
    expect(debtors.body.restricted).toBeNull();
    // Clients by label (party number), never by name.
    expect(JSON.stringify(debtors.body)).not.toContain('Zanele');
  });
});

describe('restricted matters and scope', () => {
  test('a bookkeeper gets firm totals, with the restricted matter masked', async () => {
    const res = await report(bookkeeper, 'wip');
    expect(res.body.scope).toBe('firm');
    expect(res.body.totals.totalCents).toBe(345_000);
    const masked = res.body.matters.find((m: { restricted: boolean }) => m.restricted);
    expect(masked).toMatchObject({
      caseId: null,
      caseNumber: 'Restricted matter',
      timeCents: 200_000,
    });
    expect(JSON.stringify(res.body)).not.toContain(m2.caseNumber);
    expect(JSON.stringify(res.body)).not.toContain(m2.id);

    const csvRes = await report(bookkeeper, 'wip.csv');
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers['content-type']).toMatch(/^text\/csv/);
    expect(csvRes.headers['content-disposition']).toContain(`wip-${START}-to-${TODAY}.csv`);
    expect(csvRes.text).toContain('Restricted matter');
    expect(csvRes.text).not.toContain(m2.caseNumber);
    expect(csvRes.text).toContain('Total,2.5,3000.00,450.00,3450.00');
  });

  test('debts on a restricted matter show to a bookkeeper as one restricted line', async () => {
    const invoice = await request(app).post('/api/billing/invoices').set(sipho.auth).send({
      caseRef: m2.id,
      subject: 'Consultation',
    });
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(201);
    await request(app)
      .post(`/api/billing/invoices/${invoice.body.id}/issue`)
      .set(sipho.auth)
      .expect(200);

    const books = await report(bookkeeper, 'debtors');
    // R2 000 + 15% VAT, unpaid, on the matter the bookkeeper can't see.
    expect(books.body.restricted).toMatchObject({ current: 230_000, total: 230_000 });
    expect(books.body.clients).toHaveLength(1);
    expect(books.body.totals.total).toBe(345_000);
    const csvText = (await report(bookkeeper, 'debtors.csv')).text;
    expect(csvText).toContain('Restricted matter,,2300.00');

    const full = await report(admin, 'debtors');
    expect(full.body.clients).toHaveLength(2);
    expect(full.body.restricted).toBeNull();
  });

  test('a fee earner sees only their own figures, on matters they can see', async () => {
    const res = await report(lerato, 'wip');
    expect(res.body.scope).toBe('own');
    expect(res.body.matters).toHaveLength(1);
    expect(res.body.totals).toEqual({
      hours: 0.5,
      timeCents: 100_000,
      disbursementCents: 45_000,
      totalCents: 145_000,
    });
    const util = await report(lerato, 'utilisation');
    expect(new Set(util.body.rows.map((r: { userId: string }) => r.userId))).toEqual(
      new Set([lerato.id]),
    );
    const summary = await report(sipho, 'fee-earners');
    expect(summary.body.rows.map((r: { userId: string }) => r.userId)).toEqual([sipho.id]);
  });

  test('without reports.read: refused; another firm: nothing', async () => {
    expect((await report(secretary, 'wip')).status).toBe(403);
    const theirs = await request(app)
      .get(`/api/reports/practice/wip?${RANGE}`)
      .set('Host', OTHER_HOST)
      .set(outsider.auth);
    expect(theirs.status).toBe(200);
    expect(theirs.body.totals.totalCents).toBe(0);
    expect(theirs.body.matters).toEqual([]);
  });
});

describe('inputs and CSV', () => {
  test('periods are checked; unknown reports are 404', async () => {
    expect((await report(admin, 'wip', 'from=2026-10-31&to=2026-10-01')).status).toBe(400);
    expect((await report(admin, 'wip', 'from=2024-01-01&to=2026-10-01')).status).toBe(400);
    expect((await report(admin, 'wip', 'from=yesterday')).status).toBe(400);
    expect((await report(admin, 'salaries')).status).toBe(404);
    for (const kind of ['debtors', 'utilisation', 'realisation', 'fee-earners']) {
      const res = await report(admin, `${kind}.csv`);
      expect(res.status, kind).toBe(200);
      expect(res.text.startsWith(`Period,${START},`)).toBe(true);
    }
  });

  test('cells a spreadsheet would run as formulas are defused', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+27 82 000 0000')).toBe("'+27 82 000 0000");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-450.00')).toBe('-450.00');
    expect(csvCell(-12)).toBe('-12');
    expect(csvCell('Smith, J')).toBe('"Smith, J"');
  });

  test('only administrators set targets', async () => {
    expect(
      (
        await request(app)
          .patch(`/api/users/${sipho.id}`)
          .set(lerato.auth)
          .send({ targetHoursPerMonth: 120 })
      ).status,
    ).toBe(403);
    const self = await request(app)
      .patch(`/api/users/${admin.id}`)
      .set(admin.auth)
      .send({ targetHoursPerMonth: 40 });
    expect(self.status, JSON.stringify(self.body)).toBe(200);
    expect(self.body.targetHoursPerMonth).toBe(40);
    expect(
      (
        await request(app)
          .patch(`/api/users/${sipho.id}`)
          .set(admin.auth)
          .send({ targetHoursPerMonth: 1000 })
      ).status,
    ).toBe(400);
  });
});
