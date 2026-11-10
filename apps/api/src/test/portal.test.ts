// Client portal: invite and authenticator set-up, two-factor sign-in,
// sessions, and that a client only ever sees their own matters and what
// staff chose to share.
import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import app from '../server';
import { codeForStep, timeStep } from '../lib/totp';
import { createFirm } from '../services/firm.service';
import { testOutbox } from '../services/mail.service';
import { createStaff, type TestStaff } from './helpers';

let admin: TestStaff;
let attorney: TestStaff;
let secretary: TestStaff;
let bookkeeper: TestStaff;
let clientA: { partyId: string; matter: { id: string; caseNumber: string } };
let clientB: { partyId: string; matter: { id: string; caseNumber: string } };
let secret = '';
let cookie = '';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function openMatter(name: string, email: string, title: string) {
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
    .send({ kind: 'individual', details: { name, email }, conflictCheckId: check.body.id });
  const opened = await request(app).post('/api/cases').set(attorney.auth).send({
    clientId: client.body.id,
    conflictCheckId: check.body.id,
    title,
    practiceArea: 'Property',
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  return {
    partyId: client.body.id as string,
    matter: opened.body as { id: string; caseNumber: string },
  };
}

const lastLink = (kind: 'invite' | 'signin', to: string) => {
  const mail = [...testOutbox()].reverse().find((m) => m.to === to && m.text.includes(`?${kind}=`));
  return mail?.text.match(new RegExp(`\\?${kind}=([\\w-]+)`))?.[1] ?? '';
};
const code = (offset = 0) => codeForStep(secret, timeStep() + offset);
const asClient = (req: request.Test) => req.set('Cookie', cookie);
const portal = (path: string) => asClient(request(app).get(`/api/portal${path}`));

beforeAll(async () => {
  admin = await createStaff({ email: 'admin@portal.example', role: 'admin' });
  attorney = await createStaff({
    email: 'attorney@portal.example',
    role: 'attorney',
    fullName: 'Lerato Attorney',
  });
  secretary = await createStaff({ email: 'desk@portal.example', role: 'secretary' });
  bookkeeper = await createStaff({ email: 'books@portal.example', role: 'bookkeeper' });
  clientA = await openMatter('Ayanda Zulu', 'ayanda@client.example', 'Sale of erf 77');
  clientB = await openMatter('Bongani Other', 'bongani@client.example', 'Unrelated matter');
});

describe('invites and authenticator set-up', () => {
  test('staff with portal.manage invite a client; the email carries a one-time link', async () => {
    expect(
      (
        await request(app)
          .post(`/api/clients/${clientA.partyId}/portal/invite`)
          .set(bookkeeper.auth)
          .send({})
      ).status,
    ).toBe(403);
    const invited = await request(app)
      .post(`/api/clients/${clientA.partyId}/portal/invite`)
      .set(secretary.auth)
      .send({});
    expect(invited.status, JSON.stringify(invited.body)).toBe(200);
    expect(invited.body).toMatchObject({ status: 'invited' });
    expect(lastLink('invite', 'ayanda@client.example')).not.toBe('');
  });

  test('the client scans a secret, proves it with a code, and is signed in', async () => {
    const token = lastLink('invite', 'ayanda@client.example');
    const start = await request(app).post('/api/portal/invite/start').send({ token });
    expect(start.status).toBe(200);
    expect(start.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(start.body.name).toBe('Ayanda Zulu');
    secret = start.body.secret;

    const wrong = await request(app)
      .post('/api/portal/invite/complete')
      .send({ token, code: '000000' });
    expect(wrong.status).toBe(401);
    const done = await request(app)
      .post('/api/portal/invite/complete')
      .send({ token, code: code() });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ name: 'Ayanda Zulu' });
    const set = String(done.headers['set-cookie'] ?? '');
    expect(set).toMatch(/portal=/);
    expect(set).toMatch(/HttpOnly/i);
    cookie = set.split(';')[0]!;
    // The invite link is spent.
    expect((await request(app).post('/api/portal/invite/start').send({ token })).status).toBe(400);
  });
});

describe('what the client sees', () => {
  test('only their own matters, with the attorney’s update; no trust line when trust is off', async () => {
    await request(app)
      .put(`/api/cases/${clientA.matter.id}/client-update`)
      .set(attorney.auth)
      .send({ update: 'The deeds office has the transfer; registration expected in two weeks.' })
      .expect(200);
    const matters = await portal('/matters');
    expect(matters.status).toBe(200);
    expect(matters.body).toHaveLength(1);
    expect(matters.body[0]).toMatchObject({
      caseNumber: clientA.matter.caseNumber,
      update: expect.stringContaining('deeds office'),
      trustBalanceCents: null,
    });
    expect(JSON.stringify(matters.body)).not.toContain(clientB.matter.caseNumber);
  });

  test('a restricted matter still shows to its own client', async () => {
    await request(app)
      .put(`/api/cases/${clientA.matter.id}/access`)
      .set(attorney.auth)
      .send({ access: 'restricted' })
      .expect((res) => expect(res.status).toBeLessThan(300));
    expect((await portal('/matters')).body).toHaveLength(1);
  });

  test('documents only once shared, and never another client’s', async () => {
    const doc = await request(app)
      .post('/api/documents')
      .set(attorney.auth)
      .send({ caseRef: clientA.matter.id, title: 'Offer to purchase', body: 'Signed offer text' });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);
    const other = await request(app)
      .post('/api/documents')
      .set(attorney.auth)
      .send({ caseRef: clientB.matter.id, title: 'Other client letter', body: 'Private' });
    expect((await portal('/documents')).body).toEqual([]);
    expect((await portal(`/documents/${doc.body.id}`)).status).toBe(404);

    await request(app)
      .post(`/api/documents/${doc.body.id}/share`)
      .set(attorney.auth)
      .send({ shared: true })
      .expect(200);
    await request(app)
      .post(`/api/documents/${other.body.id}/share`)
      .set(attorney.auth)
      .send({ shared: true })
      .expect(200);
    const shared = await portal('/documents');
    expect(shared.body.map((d: { title: string }) => d.title)).toEqual(['Offer to purchase']);
    expect((await portal(`/documents/${doc.body.id}`)).body).toMatchObject({
      body: 'Signed offer text',
    });
    expect((await portal(`/documents/${other.body.id}`)).status).toBe(404);
  });

  test('messages both ways; the client’s email says only that there is a message', async () => {
    const sent = await asClient(
      request(app)
        .post(`/api/portal/matters/${clientA.matter.id}/messages`)
        .send({ body: 'When do I sign the transfer?' }),
    );
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(
      (
        await asClient(
          request(app)
            .post(`/api/portal/matters/${clientB.matter.id}/messages`)
            .send({ body: 'x' }),
        )
      ).status,
    ).toBe(404);

    const thread = await request(app)
      .get(`/api/cases/${clientA.matter.id}/portal-messages`)
      .set(attorney.auth);
    expect(thread.body).toEqual([
      expect.objectContaining({ from: 'client', body: 'When do I sign the transfer?' }),
    ]);
    await request(app)
      .post(`/api/cases/${clientA.matter.id}/portal-messages`)
      .set(attorney.auth)
      .send({ body: 'Next Tuesday at 10:00 at our offices.' })
      .expect(200);
    const mail = [...testOutbox()].reverse().find((m) => m.to === 'ayanda@client.example');
    expect(mail?.text).not.toContain('Tuesday');
    expect((await portal('/matters')).body[0].unreadMessages).toBe(1);
    const read = await portal(`/matters/${clientA.matter.id}/messages`);
    expect(read.body.map((m: { from: string }) => m.from)).toEqual(['client', 'staff']);
    expect(read.body[1]).toMatchObject({ senderName: 'Lerato Attorney' });
    expect((await portal('/matters')).body[0].unreadMessages).toBe(0);
  });

  test('FICA documents from the client go to their file; verifying stays with staff', async () => {
    const before = await portal('/fica');
    expect(before.body.missing.length).toBeGreaterThan(0);
    const uploaded = await asClient(
      request(app)
        .post('/api/portal/fica')
        .send({
          docType: 'id_document',
          fileName: 'id.png',
          contentType: 'image/png',
          dataBase64: PNG.toString('base64'),
        }),
    );
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    expect(uploaded.body.uploaded).toEqual([expect.objectContaining({ docType: 'id_document' })]);
    const profile = await request(app)
      .get(`/api/clients/${clientA.partyId}/fica`)
      .set(attorney.auth);
    expect(profile.body.documents).toHaveLength(1);
    expect(profile.body.status).not.toBe('verified');
  });

  test('the portal session is not a staff session, and staff sessions are not portal sessions', async () => {
    expect((await asClient(request(app).get('/api/cases'))).status).toBe(401);
    expect((await request(app).get('/api/portal/matters').set(attorney.auth)).status).toBe(401);
  });
});

describe('signing in again', () => {
  test('emailed link plus an authenticator code; unknown addresses get the same answer', async () => {
    const before = testOutbox().length;
    const unknown = await request(app)
      .post('/api/portal/sign-in')
      .send({ email: 'nobody@client.example' });
    expect(unknown.body).toEqual({ sent: true });
    expect(testOutbox().length).toBe(before);

    await request(app)
      .post('/api/portal/sign-in')
      .send({ email: 'AYANDA@client.example' })
      .expect(200);
    const token = lastLink('signin', 'ayanda@client.example');
    expect(token).not.toBe('');
    // The code used at set-up can't be replayed.
    expect(
      (
        await request(app)
          .post('/api/portal/sign-in/complete')
          .send({ token, code: code(-1) })
      ).status,
    ).toBe(401);
    const ok = await request(app)
      .post('/api/portal/sign-in/complete')
      .send({ token, code: code(1) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(
      (
        await request(app)
          .post('/api/portal/sign-in/complete')
          .send({ token, code: code(1) })
      ).status,
    ).toBe(400);
  });

  test('five wrong codes spend the link', async () => {
    await request(app)
      .post('/api/portal/sign-in')
      .send({ email: 'ayanda@client.example' })
      .expect(200);
    const token = lastLink('signin', 'ayanda@client.example');
    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/api/portal/sign-in/complete').send({ token, code: '111111' });
    }
    expect(
      (
        await request(app)
          .post('/api/portal/sign-in/complete')
          .send({ token, code: code(1) })
      ).status,
    ).toBe(400);
  });

  test('withdrawing access ends the session; signing out ends it too', async () => {
    const access = await request(app).get(`/api/clients/${clientA.partyId}/portal`).set(admin.auth);
    expect(access.body.access).toMatchObject({ status: 'active' });
    await request(app)
      .post(`/api/portal-users/${access.body.access.id}/disable`)
      .set(admin.auth)
      .expect(200);
    expect((await portal('/matters')).status).toBe(401);
    expect((await request(app).post('/api/portal/sign-out').set('Cookie', cookie)).status).toBe(
      204,
    );
  });

  test('another firm never accepts this firm’s portal session', async () => {
    await createFirm({
      slug: 'portal-other',
      legalName: 'Other Portal Inc',
      domains: ['portal.portal-other.test'],
    });
    expect(
      (
        await request(app)
          .get('/api/portal/matters')
          .set('Host', 'portal.portal-other.test')
          .set('Cookie', cookie)
      ).status,
    ).toBe(401);
  });
});
