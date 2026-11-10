// The platform console: only on its own host, operator sign-in with MFA,
// viewer vs admin, firm metadata without client data, audited changes.
import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../server';
import { rootDb } from '../db/client';
import { platformOperators } from '../db/schema';
import { codeForStep, timeStep } from '../lib/totp';
import { createOperator, type NewOperator } from '../services/support.service';
import { testOutbox } from '../services/mail.service';
import { createStaff, defaultFirm } from './helpers';

const HOST = 'console.platform.test';
const ORIGIN = `https://${HOST}`;
process.env.PLATFORM_CONSOLE_HOST = HOST;

let admin: NewOperator;
let viewer: NewOperator;
let adminCookie = '';
let viewerCookie = '';

const consoleGet = (path: string, cookie: string) =>
  request(app).get(`/api/platform${path}`).set('Host', HOST).set('Cookie', cookie);
const consoleSend = (
  method: 'post' | 'patch' | 'put' | 'delete',
  path: string,
  cookie: string,
  body: object = {},
) =>
  request(app)
    [method](`/api/platform${path}`)
    .set('Host', HOST)
    .set('Origin', ORIGIN)
    .set('Cookie', cookie)
    .send(body);

async function signIn(operator: NewOperator, step = 0) {
  const res = await request(app)
    .post('/api/platform/sign-in')
    .set('Host', HOST)
    .set('Origin', ORIGIN)
    .send({
      email: operator.email,
      password: operator.password,
      code: codeForStep(operator.secret, timeStep() + step),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return String(res.headers['set-cookie'] ?? '').split(';')[0]!;
}

beforeAll(async () => {
  admin = await createOperator({ email: 'ops-admin@platform.example', fullName: 'Ops Admin' });
  viewer = await createOperator({ email: 'ops-viewer@platform.example', fullName: 'Ops Viewer' });
  await rootDb()
    .update(platformOperators)
    .set({ consoleRole: 'admin' })
    .where(eq(platformOperators.email, admin.email));
  // A firm with a matter, so counts are non-zero.
  await createStaff({ email: 'attorney@console.example', role: 'attorney' });
});

describe('access', () => {
  test('the console answers only on its own host', async () => {
    expect((await request(app).get('/api/platform/me')).status).toBe(404);
    expect((await request(app).get('/api/platform/me').set('Host', HOST)).status).toBe(401);
  });

  test('sign-in takes password and authenticator code; wrong details are refused', async () => {
    const wrong = await request(app)
      .post('/api/platform/sign-in')
      .set('Host', HOST)
      .set('Origin', ORIGIN)
      .send({ email: admin.email, password: admin.password, code: '000000' });
    expect(wrong.status).toBe(401);
    adminCookie = await signIn(admin);
    viewerCookie = await signIn(viewer);
    expect((await consoleGet('/me', adminCookie)).body).toMatchObject({
      email: admin.email,
      consoleRole: 'admin',
    });
  });

  test('changes need the console’s own origin', async () => {
    const res = await request(app)
      .patch('/api/platform/firms/x')
      .set('Host', HOST)
      .set('Origin', 'https://evil.example')
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(403);
  });

  test('a console session is not a firm session', async () => {
    expect((await request(app).get('/api/cases').set('Cookie', adminCookie)).status).toBe(401);
  });
});

describe('firms', () => {
  test('firms are listed with metadata and counts only', async () => {
    const res = await consoleGet('/firms', viewerCookie);
    expect(res.status).toBe(200);
    const firm = await defaultFirm();
    const row = res.body.find((f: { id: string }) => f.id === firm.id);
    expect(row).toMatchObject({
      slug: firm.slug,
      features: { trustAccounting: false },
      subscription: expect.objectContaining({ state: 'trialing' }),
    });
    expect(row.staff).toBeGreaterThan(0);
    // No client or staff details.
    expect(JSON.stringify(res.body)).not.toMatch(/attorney@console\.example/);
  });

  test('viewers read; admins change, and every change is audited', async () => {
    const firm = await defaultFirm();
    expect(
      (await consoleSend('patch', `/firms/${firm.id}`, viewerCookie, { trustAccounting: true }))
        .status,
    ).toBe(403);
    const updated = await consoleSend('patch', `/firms/${firm.id}`, adminCookie, {
      trustAccounting: true,
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.features.trustAccounting).toBe(true);

    const comp = await consoleSend('post', `/firms/${firm.id}/complimentary`, adminCookie, {
      until: '2027-06-30',
    });
    expect(comp.body.subscription).toMatchObject({
      state: 'complimentary',
      effectiveStatus: 'complimentary',
    });

    const audit = await consoleGet('/audit', viewerCookie);
    expect(audit.body.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['firm_updated', 'firm_complimentary', 'console_sign_in']),
    );
    expect(audit.body.find((e: { action: string }) => e.action === 'firm_updated')).toMatchObject({
      operator: admin.email,
      firmSlug: firm.slug,
    });
  });

  test('an admin creates a firm and its first administrator is invited by email', async () => {
    const created = await consoleSend('post', '/firms', adminCookie, {
      slug: 'console-new',
      legalName: 'Console New Attorneys Inc',
      domains: ['portal.console-new.test'],
      adminEmail: 'partner@console-new.example',
      adminName: 'Naledi Partner',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ slug: 'console-new', staff: 0, matters: 0 });
    expect(testOutbox().some((m) => m.to === 'partner@console-new.example')).toBe(true);
    expect((await consoleSend('post', '/firms', viewerCookie, {})).status).toBe(403);
  });
});

describe('platform lists', () => {
  test('plans, research sources and Court Online courts are managed here', async () => {
    const plan = await consoleSend('put', '/plans', adminCookie, {
      code: 'practice',
      name: 'Practice',
      monthlySeatPriceCents: 45_000,
      annualSeatPriceCents: 486_000,
    });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(
      (await consoleGet('/plans', viewerCookie)).body.map((p: { code: string }) => p.code),
    ).toContain('practice');

    const source = await consoleSend('put', '/sources', adminCookie, {
      code: 'gazettes',
      name: 'Government Gazettes',
      kind: 'legislation',
      licence: 'Official texts: no copyright (Copyright Act s12(8)(a))',
    });
    expect(source.body).toMatchObject({ code: 'gazettes', approvedBy: admin.email });
    await consoleSend('post', '/sources/gazettes/status', adminCookie, {
      status: 'suspended',
    }).expect(200);
    expect((await consoleGet('/sources', viewerCookie)).body[0]).toMatchObject({
      status: 'suspended',
    });

    const courts = await consoleGet('/court-online', viewerCookie);
    expect(courts.body.map((c: { division: string }) => c.division)).toContain('ZAGPPHC');
    await consoleSend('put', '/court-online', adminCookie, {
      division: 'ZAWCHC',
      since: '2026-10-01',
      source: 'Western Cape Division directive (test)',
    }).expect(200);
    expect(
      (await consoleGet('/court-online', viewerCookie)).body.map(
        (c: { division: string }) => c.division,
      ),
    ).toContain('ZAWCHC');
  });

  test('signing out ends the console session', async () => {
    await consoleSend('post', '/sign-out', viewerCookie).expect(204);
    expect((await consoleGet('/me', viewerCookie)).status).toBe(401);
  });
});
