// Matter-level access and ethical walls, enforced by PostgreSQL row-level
// security: a matter that is hidden from someone is hidden everywhere — its
// tasks, timeline, documents, invoices, ledger, calendar and intake record.
import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import app from '../server';
import { db } from '../db/client';
import { setPrincipal, withTenant } from '../db/tenant';
import { cases, documents } from '../db/schema';
import { createStaff, defaultFirm, type TestStaff } from './helpers';

let admin: TestStaff;
let lead: TestStaff;
let colleague: TestStaff;
let walled: TestStaff;
let bookkeeper: TestStaff;

interface Matter {
  submissionId: string;
  caseId: string;
  caseNumber: string;
  taskId: string;
  documentId: string;
  invoiceId: string;
  ledgerId: string;
  eventId: string;
}

let matter: Matter;

const as = (staff: TestStaff) => ({
  get: (path: string) => request(app).get(path).set(staff.auth),
  post: (path: string) => request(app).post(path).set(staff.auth),
  put: (path: string) => request(app).put(path).set(staff.auth),
  delete: (path: string) => request(app).delete(path).set(staff.auth),
});

async function openMatter(owner: TestStaff, label: string): Promise<Matter> {
  const client = as(owner);
  const created = await client.post('/api/intake/submissions').send({
    fullName: `Client ${label}`,
    email: `${label.toLowerCase()}@client.example`,
    phone: '0821234567',
    practiceArea: 'Commercial',
    matterSummary: `Dispute ${label}.`,
    consentToAi: true,
    consentToStorage: true,
  });
  const assessed = await client.post(`/api/intake/submissions/${created.body.id}/assess`);
  const caseId = assessed.body.matterCase.id as string;
  const result: Matter = {
    submissionId: created.body.id,
    caseId,
    caseNumber: assessed.body.matterCase.caseNumber,
    taskId: (await client.post(`/api/cases/${caseId}/tasks`).send({ title: `Task ${label}` })).body
      .id,
    documentId: (
      await client
        .post('/api/documents')
        .send({ caseId, title: `Doc ${label}`, body: 'Privileged' })
    ).body.id,
    invoiceId: (
      await client.post('/api/billing/invoices').send({
        caseId,
        subject: `Fees ${label}`,
        invoiceNumber: `INV-${label}`,
        lineItems: [{ rate: 1000 }],
      })
    ).body.id,
    ledgerId: (
      await client.post('/api/billing/ledger').send({ caseId, amount: 500, account: 'trust' })
    ).body.id,
    eventId: (
      await client.post('/api/calendar').send({
        caseId,
        title: `Hearing ${label}`,
        eventType: 'hearing',
        startsAt: '2031-03-01T09:00:00Z',
      })
    ).body.id,
  };
  for (const [key, value] of Object.entries(result)) {
    expect(value, key).toBeTruthy();
  }
  return result;
}

const LISTS = [
  '/api/intake/submissions',
  '/api/intake/cases',
  '/api/cases',
  '/api/documents',
  '/api/billing/invoices',
  '/api/billing/ledger',
  '/api/calendar',
  '/api/calendar/upcoming',
];

/** Whether staff can see the matter anywhere (lists and detail endpoints). */
async function visibility(staff: TestStaff, m: Matter) {
  const client = as(staff);
  const found: string[] = [];
  for (const path of LISTS) {
    const res = await client.get(path);
    if (res.status === 200) {
      const body = JSON.stringify(res.body);
      if (
        [m.caseId, m.documentId, m.invoiceId, m.ledgerId, m.eventId, m.submissionId].some((id) =>
          body.includes(id),
        )
      ) {
        found.push(path);
      }
    }
  }
  const detail = await client.get(`/api/cases/${m.caseId}`);
  const doc = await client.get(`/api/documents/${m.documentId}`);
  const intake = await client.get(`/api/intake/submissions/${m.submissionId}`);
  return {
    lists: found,
    caseStatus: detail.status,
    docStatus: doc.status,
    intakeStatus: intake.status,
  };
}

beforeAll(async () => {
  admin = await createStaff({ email: 'admin@firm.example', role: 'admin', fullName: 'Admin' });
  lead = await createStaff({ email: 'lead@firm.example', role: 'attorney', fullName: 'Lead' });
  colleague = await createStaff({
    email: 'colleague@firm.example',
    role: 'attorney',
    fullName: 'Colleague',
  });
  walled = await createStaff({
    email: 'walled@firm.example',
    role: 'paralegal',
    fullName: 'Walled',
  });
  bookkeeper = await createStaff({
    email: 'books@firm.example',
    role: 'bookkeeper',
    fullName: 'Books',
  });
  matter = await openMatter(lead, 'ACME');
});

describe('default: firm-wide access', () => {
  test('the creator leads the matter; colleagues can see it', async () => {
    const access = await as(lead).get(`/api/cases/${matter.caseId}/access`);
    expect(access.body).toMatchObject({ access: 'firm', canManage: true });
    expect(access.body.members).toEqual([
      expect.objectContaining({ userId: lead.id, memberRole: 'lead' }),
    ]);
    const seen = await visibility(colleague, matter);
    expect(seen).toEqual({ lists: LISTS, caseStatus: 200, docStatus: 200, intakeStatus: 200 });
  });

  test('a colleague who is not the lead cannot change access', async () => {
    const res = await as(colleague)
      .put(`/api/cases/${matter.caseId}/access`)
      .send({ access: 'restricted' });
    expect(res.status).toBe(403);
  });
});

describe('restricted matters', () => {
  test('only members and admins see a restricted matter, everywhere', async () => {
    const res = await as(lead)
      .put(`/api/cases/${matter.caseId}/access`)
      .send({ access: 'restricted' });
    expect(res.status).toBe(200);
    expect(res.body.access).toBe('restricted');

    expect(await visibility(colleague, matter)).toEqual({
      lists: [],
      caseStatus: 404,
      docStatus: 404,
      intakeStatus: 404,
    });
    expect((await visibility(lead, matter)).caseStatus).toBe(200);
    expect((await visibility(admin, matter)).lists).toEqual(LISTS);
  });

  test('non-members cannot add work to it either', async () => {
    const task = await as(colleague)
      .post(`/api/cases/${matter.caseId}/tasks`)
      .send({ title: 'Sneak' });
    expect(task.status).toBe(404);
    const invoice = await as(colleague)
      .post('/api/billing/invoices')
      .send({
        caseId: matter.caseId,
        subject: 'Sneak',
        invoiceNumber: 'INV-SNEAK',
        lineItems: [{ rate: 1 }],
      });
    expect(invoice.status).toBe(404);
  });

  test('adding a member grants access; removing it takes it away', async () => {
    await as(lead)
      .post(`/api/cases/${matter.caseId}/members`)
      .send({ userId: colleague.id })
      .expect(201);
    expect((await visibility(colleague, matter)).caseStatus).toBe(200);
    await as(lead).delete(`/api/cases/${matter.caseId}/members/${colleague.id}`).expect(200);
    expect((await visibility(colleague, matter)).caseStatus).toBe(404);
  });

  test('a bookkeeper sees restricted matters only as a member', async () => {
    expect((await as(bookkeeper).get('/api/billing/invoices')).body).toEqual([]);
    await as(admin)
      .post(`/api/cases/${matter.caseId}/members`)
      .send({ userId: bookkeeper.id })
      .expect(201);
    const invoices = await as(bookkeeper).get('/api/billing/invoices');
    expect(invoices.body.map((i: { id: string }) => i.id)).toContain(matter.invoiceId);
  });

  test('the database applies the rule itself, not just the API', async () => {
    const firm = await defaultFirm();
    const asUser = (user: TestStaff) =>
      withTenant(firm, async () => {
        await setPrincipal({ id: user.id, role: user.role });
        const visibleCases = await db().select({ id: cases.id }).from(cases);
        const visibleDocs = await db().select({ id: documents.id }).from(documents);
        return [...visibleCases, ...visibleDocs].map((row) => row.id);
      });
    expect(await asUser(colleague)).not.toContain(matter.caseId);
    expect(await asUser(lead)).toEqual(expect.arrayContaining([matter.caseId, matter.documentId]));
    // No principal at all (an unauthenticated request): no matters.
    const anonymous = await withTenant(firm, () => db().select({ id: cases.id }).from(cases));
    expect(anonymous).toEqual([]);
  });

  test('the cases table carries its own restrictive matter policy', async () => {
    const result = (await withTenant(await defaultFirm(), () =>
      db().execute(
        sql`select permissive from pg_policies where policyname = 'cases_matter_access'`,
      ),
    )) as { rows: Array<{ permissive: string }> };
    expect(result.rows).toEqual([{ permissive: 'RESTRICTIVE' }]);
  });
});

describe('ethical walls', () => {
  let other: Matter;

  beforeAll(async () => {
    other = await openMatter(lead, 'GLOBEX');
  });

  test('a walled user cannot see a firm-wide matter at all', async () => {
    expect((await visibility(walled, other)).caseStatus).toBe(200);
    const res = await as(lead)
      .post(`/api/cases/${other.caseId}/exclusions`)
      .send({ userId: walled.id, reason: 'Previously acted for the opposing party' });
    expect(res.status).toBe(201);
    expect(res.body.exclusions).toEqual([
      expect.objectContaining({
        userId: walled.id,
        reason: 'Previously acted for the opposing party',
      }),
    ]);
    expect(await visibility(walled, other)).toEqual({
      lists: [],
      caseStatus: 404,
      docStatus: 404,
      intakeStatus: 404,
    });
    // Everyone else still sees it.
    expect((await visibility(colleague, other)).caseStatus).toBe(200);
  });

  test('walls bind administrators too, and walled people cannot be added as members', async () => {
    const secondAdmin = await createStaff({ email: 'admin2@firm.example', role: 'admin' });
    await as(admin)
      .post(`/api/cases/${other.caseId}/exclusions`)
      .send({ userId: secondAdmin.id, reason: 'Conflict' })
      .expect(201);
    expect((await visibility(secondAdmin, other)).caseStatus).toBe(404);

    const blocked = await as(lead)
      .post(`/api/cases/${other.caseId}/members`)
      .send({ userId: walled.id });
    expect(blocked.status).toBe(409);

    const self = await as(lead)
      .post(`/api/cases/${other.caseId}/exclusions`)
      .send({ userId: lead.id, reason: 'x' });
    expect(self.status).toBe(400);
  });

  test('only managers see why a wall exists', async () => {
    const access = await as(colleague).get(`/api/cases/${other.caseId}/access`);
    expect(access.body.canManage).toBe(false);
    expect(access.body.exclusions.every((e: { reason: string }) => e.reason === '')).toBe(true);
  });

  test('wall reasons never reach the audit trail', async () => {
    const audit = await as(admin).get('/api/audit');
    expect(JSON.stringify(audit.body)).not.toContain('opposing party');
    expect(JSON.stringify(audit.body)).toContain('ethical_wall_added');
  });

  test('POPIA exports by the information officer still cover walled matters', async () => {
    // The admin is walled off GLOBEX's case, but a data subject's export must be complete.
    await as(lead)
      .post(`/api/cases/${other.caseId}/exclusions`)
      .send({ userId: admin.id, reason: 'Conflict' })
      .expect(201);
    expect((await visibility(admin, other)).caseStatus).toBe(404);
    const exported = await as(admin).get(
      '/api/compliance/export?subjectEmail=globex@client.example',
    );
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.body)).toContain(other.caseNumber);
  });

  test('removing the wall restores access', async () => {
    await as(lead).delete(`/api/cases/${other.caseId}/exclusions/${walled.id}`).expect(200);
    expect((await visibility(walled, other)).caseStatus).toBe(200);
  });
});
