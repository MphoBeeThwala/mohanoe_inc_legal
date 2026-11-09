// Platform support access: firm-approved, time-boxed, read-only, audited.
import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import app from '../server';
import { db, rootDb } from '../db/client';
import { withTenant } from '../db/tenant';
import { auditEvents, platformOperators, supportGrants } from '../db/schema';
import { createFirm } from '../services/firm.service';
import { createOperator, type NewOperator } from '../services/support.service';
import { codeForStep, timeStep } from '../lib/totp';
import {
  createStaff,
  defaultFirm,
  inDefaultFirm,
  sessionTokenFrom,
  type TestStaff,
} from './helpers';

let admin: TestStaff;
let attorney: TestStaff;
let operator: NewOperator;
let restrictedCaseId: string;
let openCaseId: string;
/**
 * Signs the operator in with the current authenticator code. Codes work once,
 * so the test forgets the last used step first (the replay rule is tested in
 * auth.test.ts).
 */
async function supportSignIn(code?: string, host?: string) {
  await rootDb().update(platformOperators).set({ mfaLastStep: null });
  const req = request(app).post('/api/support/sign-in');
  if (host) req.set('Host', host);
  return req.send({
    email: operator.email,
    password: operator.password,
    code: code ?? codeForStep(operator.secret, timeStep()),
  });
}

async function openMatter(label: string) {
  const created = await request(app)
    .post('/api/intake/submissions')
    .set(attorney.auth)
    .send({
      fullName: `Client ${label}`,
      email: `${label}@client.example`,
      phone: '0821234567',
      practiceArea: 'Labour',
      matterSummary: 'Unfair dismissal.',
      consentToAi: true,
      consentToStorage: true,
    });
  const assessed = await request(app)
    .post(`/api/intake/submissions/${created.body.id}/assess`)
    .set(attorney.auth);
  return assessed.body.matterCase.id as string;
}

beforeAll(async () => {
  admin = await createStaff({ email: 'admin@support.example', role: 'admin' });
  attorney = await createStaff({ email: 'attorney@support.example', role: 'attorney' });
  operator = await createOperator({
    email: 'helpdesk@platform.example',
    fullName: 'Helpdesk Agent',
  });
  openCaseId = await openMatter('open');
  restrictedCaseId = await openMatter('secret');
  await request(app)
    .put(`/api/cases/${restrictedCaseId}/access`)
    .set(attorney.auth)
    .send({ access: 'restricted' })
    .expect(200);
});

describe('without the firm’s approval', () => {
  test('an operator cannot sign in at all', async () => {
    const res = await supportSignIn();
    expect(res.status).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('only firm administrators can grant support access', async () => {
    const res = await request(app)
      .post('/api/support/grants')
      .set(attorney.auth)
      .send({ hours: 4, reason: 'Ticket 1' });
    expect(res.status).toBe(403);
    const tooLong = await request(app)
      .post('/api/support/grants')
      .set(admin.auth)
      .send({ hours: 500, reason: 'Ticket 1' });
    expect(tooLong.status).toBe(400);
  });

  test('the operator table is out of reach of every request', async () => {
    await expect(
      withTenant(await defaultFirm(), () => db().execute(sql`select * from platform_operators`), {
        system: true,
      }),
    ).rejects.toSatisfy((error: unknown) =>
      /permission denied/.test(String((error as { cause?: Error }).cause?.message ?? error)),
    );
  });
});

describe('with an active grant', () => {
  let token: string;
  let grantId: string;

  beforeAll(async () => {
    const grant = await request(app)
      .post('/api/support/grants')
      .set(admin.auth)
      .send({ hours: 4, reason: 'Ticket HD-1042: invoices not loading' });
    expect(grant.status).toBe(201);
    grantId = grant.body.id;
    const signedIn = await supportSignIn();
    expect(signedIn.status).toBe(200);
    token = sessionTokenFrom(signedIn);
  });

  const asSupport = (path: string) =>
    request(app).get(path).set('authorization', `Bearer ${token}`);

  test('support gets a read-only session that ends with the grant', async () => {
    const me = await asSupport('/api/auth/me');
    expect(me.body.user).toMatchObject({
      role: 'support',
      fullName: expect.stringMatching(/Helpdesk Agent/),
    });
    expect(me.body.session.method).toBe('support');
    const ends = Date.parse(me.body.session.expiresAt);
    expect(ends).toBeLessThanOrEqual(Date.now() + 4 * 3_600_000 + 1_000);
    expect(ends).toBeGreaterThan(Date.now() + 3.9 * 3_600_000);

    expect((await asSupport('/api/cases')).status).toBe(200);
    expect((await asSupport('/api/billing/invoices')).status).toBe(200);
    const write = await request(app)
      .post(`/api/cases/${openCaseId}/tasks`)
      .set('authorization', `Bearer ${token}`)
      .send({ title: 'Support should not write' });
    expect(write.status).toBe(403);
    expect((await asSupport('/api/users')).status).toBe(403);
    expect((await asSupport('/api/compliance/requests')).status).toBe(403);
    expect((await asSupport('/api/audit')).status).toBe(403);
  });

  test('restricted matters stay hidden from support', async () => {
    const cases = await asSupport('/api/cases');
    const ids = cases.body.map((c: { id: string }) => c.id);
    expect(ids).toContain(openCaseId);
    expect(ids).not.toContain(restrictedCaseId);
    expect((await asSupport(`/api/cases/${restrictedCaseId}`)).status).toBe(404);
  });

  test('every support request is in the firm’s audit trail', async () => {
    await asSupport('/api/documents');
    const events = await inDefaultFirm(() =>
      db().select().from(auditEvents).where(eq(auditEvents.action, 'support_request')),
    );
    expect(events.map((event) => event.details.path)).toEqual(
      expect.arrayContaining(['/api/cases', '/api/documents']),
    );
    const signIns = await inDefaultFirm(() =>
      db().select().from(auditEvents).where(eq(auditEvents.action, 'support_signed_in')),
    );
    expect(signIns).toHaveLength(1);
  });

  test('the stand-in account is not staff: hidden from pickers, not editable', async () => {
    const directory = await request(app).get('/api/users/directory').set(admin.auth);
    expect(directory.body.map((u: { role: string }) => u.role)).not.toContain('support');
    const users = await request(app).get('/api/users').set(admin.auth);
    const stand = users.body.find((u: { role: string }) => u.role === 'support');
    const edit = await request(app)
      .patch(`/api/users/${stand.id}`)
      .set(admin.auth)
      .send({ role: 'admin' });
    expect(edit.status).toBe(400);
  });

  test('a grant in one firm does not open another firm', async () => {
    await createFirm({
      slug: 'no-grant',
      legalName: 'No Grant Inc.',
      domains: ['portal.nogrant.test'],
    });
    const res = await supportSignIn(undefined, 'portal.nogrant.test');
    expect(res.status).toBe(403);
  });

  test('revoking the grant ends the session at once', async () => {
    await request(app).delete(`/api/support/grants/${grantId}`).set(admin.auth).expect(200);
    expect((await asSupport('/api/cases')).status).toBe(401);
    expect((await supportSignIn()).status).toBe(403);
    const grants = await request(app).get('/api/support/grants').set(admin.auth);
    expect(grants.body[0]).toMatchObject({
      status: 'revoked',
      reason: expect.stringMatching(/HD-1042/),
    });
  });
});

describe('expiry and lockout', () => {
  test('when a grant expires, its sessions stop working', async () => {
    await request(app)
      .post('/api/support/grants')
      .set(admin.auth)
      .send({ hours: 1, reason: 'Short' });
    const signedIn = await supportSignIn();
    expect(signedIn.status).toBe(200);
    const token = sessionTokenFrom(signedIn);
    await inDefaultFirm(() =>
      db()
        .update(supportGrants)
        .set({ expiresAt: new Date(Date.now() - 1_000) }),
    );
    const res = await request(app).get('/api/cases').set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  test('an operator’s authenticator code works only once', async () => {
    await request(app)
      .post('/api/support/grants')
      .set(admin.auth)
      .send({ hours: 1, reason: 'Replay' });
    const code = codeForStep(operator.secret, timeStep());
    expect((await supportSignIn(code)).status).toBe(200);
    const replay = await request(app)
      .post('/api/support/sign-in')
      .send({ email: operator.email, password: operator.password, code });
    expect(replay.status).toBe(401);
  });

  test('wrong codes lock the operator account', async () => {
    await request(app)
      .post('/api/support/grants')
      .set(admin.auth)
      .send({ hours: 1, reason: 'Lockout' });
    for (let i = 0; i < 5; i += 1) {
      expect((await supportSignIn('000000')).status).toBe(401);
    }
    // Even a correct code is refused while locked.
    expect((await supportSignIn()).status).toBe(401);
  });
});
