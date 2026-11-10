// Tenant isolation. Firm A creates one of everything; firm B must not be able
// to see, find, change or count any of it, through any endpoint or query.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import app from '../server';
import { db, rootDb } from '../db/client';
import { withTenant } from '../db/tenant';
import { cases, firms, type FirmRow } from '../db/schema';
import { clearFirmCache, createFirm } from '../services/firm.service';
import * as auditService from '../services/audit.service';
import { createStaff, signInAgain, type TestStaff } from './helpers';

/** Platform-level tables: no firm_id, and no access for app_tenant. */
const PLATFORM_TABLES = [
  'platform_operators',
  'platform_sessions',
  'platform_audit',
  'court_roll_documents',
  'court_roll_entries',
];
/** Platform-level tables requests may read but never change. */
const PLATFORM_READ_TABLES = [
  'subscription_plans',
  'legal_sources',
  'legal_documents',
  'legal_passages',
  'court_online_courts',
];

const HOST_A = 'portal.alpha-law.test';
const HOST_B = 'portal.beta-law.test';

let firmA: FirmRow;
let firmB: FirmRow;
let tokenA: string;
let tokenB: string;

/** Everything firm A created, by kind. */
const a = {
  submissionId: '',
  caseId: '',
  caseNumber: '',
  taskId: '',
  documentId: '',
  invoiceId: '',
  ledgerId: '',
  eventId: '',
  notificationId: '',
  reportId: '',
  requestId: '',
};

const asA = (method: 'get' | 'post', path: string) =>
  request(app)[method](path).set('Host', HOST_A).set('authorization', `Bearer ${tokenA}`);
const asB = (method: 'get' | 'post', path: string) =>
  request(app)[method](path).set('Host', HOST_B).set('authorization', `Bearer ${tokenB}`);

let staffB: TestStaff;

beforeAll(async () => {
  firmA = await createFirm({
    slug: 'alpha',
    legalName: 'Alpha Attorneys Inc.',
    casePrefix: 'ALP',
    domains: [HOST_A],
  });
  firmB = await createFirm({
    slug: 'beta',
    legalName: 'Beta Legal',
    casePrefix: 'BET',
    domains: [HOST_B],
  });
  // The same person may work at both firms: emails are unique per firm.
  const email = 'same.person@example.com';
  tokenA = (await createStaff({ firm: firmA, host: HOST_A, email, role: 'admin' })).token;
  staffB = await createStaff({ firm: firmB, host: HOST_B, email, role: 'admin' });
  tokenB = staffB.token;

  const created = await asA('post', '/api/intake/submissions').send({
    fullName: 'Client Of Alpha',
    email: 'client.alpha@example.com',
    phone: '0821234567',
    practiceArea: 'Commercial',
    matterSummary: 'Breach of a supply contract.',
    consentToAi: true,
    consentToStorage: true,
  });
  a.submissionId = created.body.id;
  const assessed = await asA('post', `/api/intake/submissions/${a.submissionId}/assess`);
  a.caseId = assessed.body.matterCase.id;
  a.caseNumber = assessed.body.matterCase.caseNumber;

  a.taskId = (
    await asA('post', `/api/cases/${a.caseId}/tasks`).send({ title: 'Draft letter' })
  ).body.id;
  await asA('post', `/api/cases/${a.caseId}/timeline`).send({ message: 'Consulted client' });
  a.documentId = (
    await asA('post', '/api/documents').send({ caseId: a.caseId, title: 'Letter', body: 'Text' })
  ).body.id;
  a.invoiceId = (
    await asA('post', '/api/billing/invoices').send({
      caseId: a.caseId,
      subject: 'Fees',
      invoiceNumber: 'INV-001',
      lineItems: [{ rate: 1000 }],
    })
  ).body.id;
  a.ledgerId = (
    await asA('post', '/api/billing/ledger').send({
      caseId: a.caseId,
      amount: 500,
      account: 'trust',
    })
  ).body.id;
  a.eventId = (
    await asA('post', '/api/calendar').send({
      caseId: a.caseId,
      title: 'Hearing',
      eventType: 'hearing',
      startsAt: '2031-03-01T09:00:00Z',
    })
  ).body.id;
  a.notificationId = (
    await asA('post', '/api/notifications').send({ title: 'Alpha only', body: 'Secret' })
  ).body.id;
  a.reportId = (await asA('post', '/api/reports').send({ title: 'Alpha report' })).body.id;
  a.requestId = (
    await asA('post', '/api/compliance/requests').send({
      subjectName: 'Client Of Alpha',
      subjectEmail: 'client.alpha@example.com',
      description: 'Access request',
    })
  ).body.id;

  for (const [key, value] of Object.entries(a)) {
    expect(value, key).toBeTruthy();
  }
});

afterAll(() => {
  delete process.env.PLATFORM_BASE_DOMAIN;
  clearFirmCache();
});

describe('firm A sees its own data', () => {
  test('case numbers use the firm prefix and start at 1', () => {
    expect(a.caseNumber).toMatch(/^ALP-\d{4}-0001$/);
  });

  test('branding is resolved per host', async () => {
    const brandA = await request(app).get('/api/tenant/branding').set('Host', HOST_A);
    const brandB = await request(app).get('/api/tenant/branding').set('Host', HOST_B);
    expect(brandA.body.firmName).toBe('Alpha Attorneys Inc.');
    expect(brandB.body.firmName).toBe('Beta Legal');
  });
});

describe('firm B cannot see firm A data through any list endpoint', () => {
  const lists = [
    '/api/intake/submissions',
    '/api/intake/cases',
    '/api/cases',
    '/api/documents',
    '/api/billing/invoices',
    '/api/billing/ledger',
    '/api/calendar',
    '/api/calendar/upcoming',
    '/api/notifications',
    '/api/reports',
    '/api/compliance/requests',
    '/api/audit',
  ];

  test.each(lists)('%s', async (path) => {
    const own = await asA('get', path);
    const other = await asB('get', path);
    expect(own.status).toBe(200);
    expect(other.status).toBe(200);
    const body = JSON.stringify(other.body);
    for (const id of Object.values(a)) {
      expect(body).not.toContain(id);
    }
    expect(body).not.toContain('Alpha');
  });

  test('summaries and dashboards count only the firm’s own records', async () => {
    const intake = await asB('get', '/api/intake/summary');
    expect(intake.body).toMatchObject({ liveCases: 0, assessedIntakes: 0, latestIntake: null });
    const billing = await asB('get', '/api/billing/summary');
    expect(billing.body).toMatchObject({ invoices: 0, outstanding: 0, trustBalance: 0 });
    const dashboard = await asB('get', '/api/reports/dashboard');
    expect(dashboard.body).toMatchObject({ caseCount: 0, openTasks: 0, overdueInvoices: 0 });
    const compliance = await asB('get', '/api/compliance/summary');
    expect(compliance.body.totalRequests).toBe(0);
  });

  test('a data-subject export cannot find another firm’s client', async () => {
    const res = await request(app)
      .get('/api/compliance/export')
      .query({ subjectEmail: 'client.alpha@example.com' })
      .set('Host', HOST_B)
      .set('authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    expect(res.body.submissions).toHaveLength(0);
    expect(res.body.cases).toHaveLength(0);
  });
});

describe('firm B cannot open or change firm A records by id', () => {
  test.each([
    ['submission', () => `/api/intake/submissions/${a.submissionId}`],
    ['case by id', () => `/api/cases/${a.caseId}`],
    ['case by number', () => `/api/cases/${a.caseNumber}`],
    ['document', () => `/api/documents/${a.documentId}`],
  ])('%s → 404', async (_label, path) => {
    expect((await asB('get', path())).status).toBe(404);
  });

  test.each([
    ['assess submission', () => `/api/intake/submissions/${a.submissionId}/assess`, {}],
    ['add task', () => `/api/cases/${a.caseId}/tasks`, { title: 'Hijack' }],
    ['complete task', () => `/api/cases/${a.caseId}/tasks/${a.taskId}/complete`, {}],
    ['change status', () => `/api/cases/${a.caseId}/status`, { status: 'closed' }],
    ['add timeline note', () => `/api/cases/${a.caseId}/timeline`, { message: 'Hijack' }],
    ['sign document', () => `/api/documents/${a.documentId}/sign`, {}],
    ['mark notification read', () => `/api/notifications/${a.notificationId}/read`, {}],
    ['fulfil compliance request', () => `/api/compliance/requests/${a.requestId}/fulfill`, {}],
  ])('%s → 404', async (_label, path, body) => {
    expect((await asB('post', path()).send(body)).status).toBe(404);
  });

  test.each([
    ['invoice', '/api/billing/invoices', { subject: 'X', lineItems: [{ rate: 1 }] }],
    ['ledger entry', '/api/billing/ledger', { amount: 1 }],
    ['document', '/api/documents', { title: 'X', body: 'Y' }],
    ['calendar event', '/api/calendar', { title: 'X', startsAt: '2031-01-01T00:00:00Z' }],
  ])('cannot attach a new %s to firm A’s case', async (_label, path, body) => {
    const res = await asB('post', path).send({ ...body, caseId: a.caseId });
    expect([400, 404]).toContain(res.status);
  });

  test('firm A’s records are unchanged afterwards', async () => {
    const detail = await asA('get', `/api/cases/${a.caseId}`);
    expect(detail.body.status).not.toBe('closed');
    expect(detail.body.tasks.map((t: { title: string }) => t.title)).not.toContain('Hijack');
    const doc = await asA('get', `/api/documents/${a.documentId}`);
    expect(doc.body.status).toBe('draft');
  });
});

describe('sessions are bound to their firm', () => {
  test('firm A’s token is rejected on firm B’s workspace', async () => {
    const res = await request(app)
      .get('/api/cases')
      .set('Host', HOST_B)
      .set('authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(401);
  });

  test('signing in on firm B with the same email gets firm B’s account', async () => {
    const token = await signInAgain(staffB);
    const onB = await request(app)
      .get('/api/auth/me')
      .set('Host', HOST_B)
      .set('authorization', `Bearer ${token}`);
    expect(onB.status).toBe(200);
    const onA = await request(app)
      .get('/api/cases')
      .set('Host', HOST_A)
      .set('authorization', `Bearer ${token}`);
    expect(onA.status).toBe(401);
  });

  test('invites and reset links use the firm’s own address, not the request’s Host', async () => {
    const invite = await request(app)
      .post('/api/users/invites')
      .set('Host', HOST_B)
      .set('authorization', `Bearer ${tokenB}`)
      .send({ email: 'joiner@example.com', fullName: 'Joiner', role: 'attorney' });
    expect(invite.body.url).toMatch(new RegExp(`^https://${HOST_B.replace(/\./g, '\\.')}/invite/`));
    // The invite belongs to firm B only.
    const token = invite.body.url.split('/invite/')[1];
    expect((await request(app).get(`/api/auth/invites/${token}`).set('Host', HOST_A)).status).toBe(
      404,
    );
  });
});

describe('workspace resolution', () => {
  test('suspended firms are refused', async () => {
    await rootDb().update(firms).set({ status: 'suspended' }).where(eq(firms.id, firmB.id));
    clearFirmCache();
    expect((await request(app).get('/api/tenant/branding').set('Host', HOST_B)).status).toBe(403);
    await rootDb().update(firms).set({ status: 'active' }).where(eq(firms.id, firmB.id));
    clearFirmCache();
  });

  test('with a platform domain, subdomains resolve and unknown hosts do not', async () => {
    process.env.PLATFORM_BASE_DOMAIN = 'legal.test';
    clearFirmCache();
    const known = await request(app).get('/api/tenant/branding').set('Host', 'alpha.legal.test');
    expect(known.body.firmName).toBe('Alpha Attorneys Inc.');
    expect(
      (await request(app).get('/api/tenant/branding').set('Host', 'nobody.legal.test')).status,
    ).toBe(404);
    expect(
      (await request(app).get('/api/tenant/branding').set('Host', 'random.example')).status,
    ).toBe(404);
    delete process.env.PLATFORM_BASE_DOMAIN;
    clearFirmCache();
  });
});

describe('the database enforces isolation (row-level security)', () => {
  test('tenant queries run as the restricted app_tenant role', async () => {
    const result = (await withTenant(firmB, () =>
      db().execute(sql`select current_user as role`),
    )) as { rows: Array<{ role: string }> };
    expect(result.rows[0]!.role).toBe('app_tenant');
  });

  test('a raw query for firm A’s rows from firm B returns nothing', async () => {
    const rows = await withTenant(
      firmB,
      () => db().select().from(cases).where(eq(cases.firmId, firmA.id)),
      { system: true },
    );
    expect(rows).toHaveLength(0);
  });

  test('writing a row into another firm is rejected by the database', async () => {
    await expect(
      withTenant(
        firmB,
        () =>
          db().insert(cases).values({
            firmId: firmA.id,
            intakeSubmissionId: a.submissionId,
            caseNumber: 'BET-HACK',
            clientLabel: 'x',
            practiceArea: 'x',
            urgency: 'low',
            nextAction: 'x',
          }),
        { system: true },
      ),
    ).rejects.toSatisfy((error: unknown) => {
      const err = error as { message?: string; cause?: { message?: string } };
      return /row-level security/.test(`${err.cause?.message ?? ''} ${err.message ?? ''}`);
    });
  });

  test('moving a row to another firm is rejected', async () => {
    const changed = await withTenant(
      firmB,
      () => db().update(cases).set({ firmId: firmA.id }).where(eq(cases.id, a.caseId)).returning(),
      { system: true },
    );
    expect(changed).toHaveLength(0);
  });

  test('each firm has its own audit chain and both verify', async () => {
    const chainA = await withTenant(firmA, () => auditService.verifyEventChain());
    const chainB = await withTenant(firmB, () => auditService.verifyEventChain());
    expect(chainA).toMatchObject({ valid: true });
    expect(chainB).toMatchObject({ valid: true });
    expect(chainA.count).toBeGreaterThan(chainB.count);
  });

  test('every table except firms has firm_id, forced RLS and, if it belongs to a matter, matter access', async () => {
    const result = (await rootDb().execute(sql`
      select c.relname as name,
             c.relrowsecurity as rls,
             c.relforcerowsecurity as forced,
             exists (
               select 1 from information_schema.columns col
               where col.table_schema = 'public' and col.table_name = c.relname
                 and col.column_name = 'firm_id'
             ) as has_firm_id,
             (select count(*)::int from pg_policies p
               where p.schemaname = 'public' and p.tablename = c.relname
                 and p.policyname = c.relname || '_tenant_isolation') as policies,
             exists (
               select 1 from information_schema.columns col
               where col.table_schema = 'public' and col.table_name = c.relname
                 and col.column_name = 'case_id'
             ) as has_case_id,
             exists (
               select 1 from pg_policies p
               where p.schemaname = 'public' and p.tablename = c.relname
                 and p.policyname = c.relname || '_matter_access' and p.permissive = 'RESTRICTIVE'
             ) as matter_policy
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`)) as { rows: unknown[] };
    const tables = result.rows as Array<{
      name: string;
      rls: boolean;
      forced: boolean;
      has_firm_id: boolean;
      policies: number;
      has_case_id: boolean;
      matter_policy: boolean;
    }>;
    expect(tables.length).toBeGreaterThan(10);
    for (const table of tables) {
      if (table.name === 'firms') {
        continue;
      }
      if (PLATFORM_READ_TABLES.includes(table.name)) {
        const privileges = (await rootDb().execute(
          sql`select has_table_privilege('app_tenant', ${table.name}, 'select') as read, has_table_privilege('app_tenant', ${table.name}, 'insert, update, delete') as write`,
        )) as { rows: Array<{ read: boolean; write: boolean }> };
        expect(privileges.rows[0], table.name).toEqual({ read: true, write: false });
        continue;
      }
      // Platform tables carry no firm data, and requests can't touch them.
      if (PLATFORM_TABLES.includes(table.name)) {
        const privileges = (await rootDb().execute(
          sql`select has_table_privilege('app_tenant', ${table.name}, 'select, insert, update, delete') as any`,
        )) as { rows: Array<{ any: boolean }> };
        expect(privileges.rows[0]!.any, `app_tenant must not access ${table.name}`).toBe(false);
        continue;
      }
      expect(table, table.name).toMatchObject({
        rls: true,
        forced: true,
        has_firm_id: true,
        policies: 1,
      });
      // Rows that belong to a matter are hidden with it (matter-level access).
      if (table.has_case_id && !['case_members', 'case_exclusions'].includes(table.name)) {
        expect(table.matter_policy, `${table.name} needs a _matter_access policy`).toBe(true);
      }
    }
  });
});
