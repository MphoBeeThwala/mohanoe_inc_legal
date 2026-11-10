// Support desk and help centre: requests raised by staff, answered from the
// console; encrypted at rest, kept out of emails and audit rows; firm-scoped.
import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../server';
import { db, rootDb } from '../db/client';
import { auditEvents, platformOperators, supportTickets, type FirmRow } from '../db/schema';
import { codeForStep, timeStep } from '../lib/totp';
import { createFirm } from '../services/firm.service';
import { testOutbox } from '../services/mail.service';
import { createOperator, type NewOperator } from '../services/support.service';
import { createStaff, defaultFirm, inDefaultFirm, type TestStaff } from './helpers';

const HOST = 'console.platform.test';
const ORIGIN = `https://${HOST}`;
const OTHER_HOST = 'portal.other-firm.test';
const SUBJECT = 'Invoice PDF will not download for MAT-2026-0001';
const BODY = 'Clicking Download on the invoice shows an error since this morning.';

let admin: TestStaff;
let attorney: TestStaff;
let paralegal: TestStaff;
let otherFirmStaff: TestStaff;
let otherFirm: FirmRow;
let operator: NewOperator;
let consoleAdmin: NewOperator;
let operatorCookie = '';
let adminCookie = '';
let ticketId = '';
let firmId = '';

async function signIn(op: NewOperator) {
  const res = await request(app)
    .post('/api/platform/sign-in')
    .set('Host', HOST)
    .set('Origin', ORIGIN)
    .send({ email: op.email, password: op.password, code: codeForStep(op.secret, timeStep()) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return String(res.headers['set-cookie'] ?? '').split(';')[0]!;
}
const consoleGet = (path: string, cookie = operatorCookie) =>
  request(app).get(`/api/platform${path}`).set('Host', HOST).set('Cookie', cookie);
const consoleSend = (
  method: 'post' | 'put' | 'delete',
  path: string,
  bodyValue: object = {},
  cookie = operatorCookie,
) =>
  request(app)
    [method](`/api/platform${path}`)
    .set('Host', HOST)
    .set('Origin', ORIGIN)
    .set('Cookie', cookie)
    .send(bodyValue);

beforeAll(async () => {
  process.env.PLATFORM_CONSOLE_HOST = HOST;
  process.env.PLATFORM_SUPPORT_EMAIL = 'help@platform.example';
  process.env.PLATFORM_STATUS_URL = 'https://status.platform.example';
  admin = await createStaff({
    email: 'admin@helpdesk.example',
    role: 'admin',
    fullName: 'Ada Admin',
  });
  attorney = await createStaff({
    email: 'attorney@helpdesk.example',
    role: 'attorney',
    fullName: 'Thabo Attorney',
  });
  paralegal = await createStaff({ email: 'para@helpdesk.example', role: 'paralegal' });
  otherFirm = await createFirm({
    slug: 'other-firm',
    legalName: 'Other Firm Inc',
    casePrefix: 'OTH',
    domains: [OTHER_HOST],
  });
  otherFirmStaff = await createStaff({
    email: 'someone@other-firm.example',
    role: 'admin',
    firm: otherFirm,
    host: OTHER_HOST,
  });
  operator = await createOperator({ email: 'agent@platform.example', fullName: 'Lerato Agent' });
  consoleAdmin = await createOperator({ email: 'boss@platform.example', fullName: 'Boss' });
  await rootDb()
    .update(platformOperators)
    .set({ consoleRole: 'admin' })
    .where(eq(platformOperators.email, consoleAdmin.email));
  operatorCookie = await signIn(operator);
  adminCookie = await signIn(consoleAdmin);
  firmId = (await defaultFirm()).id;
});

describe('help centre', () => {
  test('lists published articles and the status page', async () => {
    const res = await request(app).get('/api/helpdesk').set(attorney.auth);
    expect(res.status).toBe(200);
    expect(res.body.statusPageUrl).toBe('https://status.platform.example');
    expect(res.body.articles.map((a: { slug: string }) => a.slug)).toContain('signing-in');
    const article = await request(app)
      .get('/api/helpdesk/articles/support-access')
      .set(attorney.auth);
    expect(article.body.body).toMatch(/Support access/);
  });

  test('only console administrators change articles; unpublished ones are hidden', async () => {
    const draft = {
      slug: 'draft-note',
      title: 'Draft note',
      category: 'Misc',
      body: 'Soon.',
      published: false,
    };
    expect((await consoleSend('put', '/articles', draft)).status).toBe(403);
    expect((await consoleSend('put', '/articles', draft, adminCookie)).status).toBe(200);
    const list = await request(app).get('/api/helpdesk').set(attorney.auth);
    expect(list.body.articles.map((a: { slug: string }) => a.slug)).not.toContain('draft-note');
    expect(
      (await request(app).get('/api/helpdesk/articles/draft-note').set(attorney.auth)).status,
    ).toBe(404);
    expect((await consoleSend('delete', '/articles/draft-note', {}, adminCookie)).status).toBe(200);
  });
});

describe('support requests', () => {
  test('staff raise a request; the platform is told the number only', async () => {
    const before = testOutbox().length;
    const res = await request(app)
      .post('/api/helpdesk/tickets')
      .set(attorney.auth)
      .send({ subject: SUBJECT, body: BODY, category: 'problem', priority: 'urgent' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ number: 'SUP-000001', status: 'open', subject: SUBJECT });
    expect(res.body.messages[0]).toMatchObject({
      author: 'staff',
      name: 'Thabo Attorney',
      body: BODY,
    });
    ticketId = res.body.id;

    const mail = testOutbox().slice(before);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ to: 'help@platform.example' });
    expect(mail[0]!.subject).toMatch(/\[Urgent\].*SUP-000001/);
    expect(`${mail[0]!.subject}${mail[0]!.text}`).not.toContain('Invoice PDF');
    expect(mail[0]!.text).toContain(`https://${HOST}/console#ticket-`);
  });

  test('stored encrypted; audit rows carry the number only', async () => {
    await inDefaultFirm(async () => {
      const [row] = await db().select().from(supportTickets).where(eq(supportTickets.id, ticketId));
      expect(row!.subjectEncrypted).not.toContain('Invoice');
      const events = await db()
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, ticketId));
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).not.toContain('Invoice PDF');
    });
  });

  test('others see only their own requests; administrators see all', async () => {
    expect((await request(app).get('/api/helpdesk/tickets').set(paralegal.auth)).body).toEqual([]);
    expect(
      (await request(app).get(`/api/helpdesk/tickets/${ticketId}`).set(paralegal.auth)).status,
    ).toBe(404);
    const all = await request(app).get('/api/helpdesk/tickets').set(admin.auth);
    expect(all.body.map((t: { id: string }) => t.id)).toEqual([ticketId]);
  });

  test('another firm cannot see the request', async () => {
    const list = await request(app)
      .get('/api/helpdesk/tickets')
      .set('Host', OTHER_HOST)
      .set(otherFirmStaff.auth);
    expect(list.body).toEqual([]);
    const one = await request(app)
      .get(`/api/helpdesk/tickets/${ticketId}`)
      .set('Host', OTHER_HOST)
      .set(otherFirmStaff.auth);
    expect(one.status).toBe(404);
    // And numbers are per firm.
    const theirs = await request(app)
      .post('/api/helpdesk/tickets')
      .set('Host', OTHER_HOST)
      .set(otherFirmStaff.auth)
      .send({ subject: 'Adding a domain', body: 'How?', category: 'question' });
    expect(theirs.body.number).toBe('SUP-000001');
  });

  test('operators see requests across firms and answer them; the requester is emailed a link only', async () => {
    const list = await consoleGet('/tickets');
    expect(list.status).toBe(200);
    expect(list.body.map((t: { firmSlug: string }) => t.firmSlug).sort()).toEqual(
      [(await defaultFirm()).slug, 'other-firm'].sort(),
    );
    // Urgent first.
    expect(list.body[0]).toMatchObject({ id: ticketId, priority: 'urgent', subject: SUBJECT });

    const before = testOutbox().length;
    const reply = await consoleSend('post', `/tickets/${firmId}/${ticketId}/messages`, {
      body: 'Fixed: please try again.',
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.status).toBe('answered');
    expect(reply.body.firstResponseAt).toBeTruthy();
    const mail = testOutbox().slice(before);
    expect(mail.map((m) => m.to)).toEqual([attorney.email]);
    expect(mail[0]!.text).not.toContain('Fixed');
    expect(mail[0]!.text).toContain('#section-help');

    const seen = await request(app).get(`/api/helpdesk/tickets/${ticketId}`).set(attorney.auth);
    expect(seen.body.messages.at(-1)).toMatchObject({
      author: 'operator',
      name: 'Lerato Agent (support)',
      body: 'Fixed: please try again.',
    });

    const audit = await consoleGet('/audit', adminCookie);
    expect(
      audit.body.find((e: { action: string }) => e.action === 'ticket_answered'),
    ).toMatchObject({
      operator: operator.email,
    });
  });

  test('staff reply reopens the request; closing it moves it off the console list', async () => {
    const replied = await request(app)
      .post(`/api/helpdesk/tickets/${ticketId}/messages`)
      .set(attorney.auth)
      .send({ body: 'Works now, thanks.' });
    expect(replied.body.status).toBe('open');
    const closed = await request(app)
      .post(`/api/helpdesk/tickets/${ticketId}/close`)
      .set(attorney.auth);
    expect(closed.body.status).toBe('closed');
    const open = await consoleGet('/tickets');
    expect(open.body.map((t: { id: string }) => t.id)).not.toContain(ticketId);
    const closedList = await consoleGet('/tickets?status=closed');
    expect(closedList.body.map((t: { id: string }) => t.id)).toContain(ticketId);
  });

  test('a firm console session does not open the helpdesk, and input is validated', async () => {
    expect((await request(app).get('/api/helpdesk/tickets')).status).toBe(401);
    const bad = await request(app)
      .post('/api/helpdesk/tickets')
      .set(attorney.auth)
      .send({ subject: 'x', body: '', category: 'nonsense' });
    expect(bad.status).toBe(400);
  });
});
