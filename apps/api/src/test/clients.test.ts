// Clients, parties and conflict checks.
import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import app from '../server';
import { db } from '../db/client';
import { withTenant } from '../db/tenant';
import { auditEvents, cases, parties } from '../db/schema';
import { createFirm } from '../services/firm.service';
import { rotateDataKey } from '../services/keys.service';
import { pendingReencryption, reencryptFirm } from '../services/reencrypt.service';
import { exportFirm } from '../services/firm-export.service';
import { createStaff, defaultFirm, inDefaultFirm, type TestStaff } from './helpers';

let admin: TestStaff;
let attorney: TestStaff;
let colleague: TestStaff;
let secretary: TestStaff;
let bookkeeper: TestStaff;

const THANDI = {
  name: 'Thandi Grace Nkosi',
  idNumber: '8001015009087',
  email: 'thandi@client.example',
  phone: '082 123 4567',
};

async function check(staff: TestStaff, subjects: object[], purpose = 'Employment dispute') {
  const res = await request(app).post('/api/conflicts').set(staff.auth).send({ subjects, purpose });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function decide(staff: TestStaff, id: string, decision: string, notes?: string) {
  return request(app)
    .post(`/api/conflicts/${id}/decision`)
    .set(staff.auth)
    .send({ decision, notes });
}

async function clearedClient(staff: TestStaff, kind: string, details: Record<string, string>) {
  const result = await check(staff, [{ ...details, kind }]);
  await decide(staff, result.id, 'clear', 'Checked: no conflict').then((r) =>
    expect(r.status).toBe(200),
  );
  const client = await request(app)
    .post('/api/clients')
    .set(staff.auth)
    .send({ kind, details, conflictCheckId: result.id });
  expect(client.status, JSON.stringify(client.body)).toBe(201);
  return { client: client.body, checkId: result.id as string };
}

let thandiId: string;
let thandiCheck: string;
let matterId: string;

beforeAll(async () => {
  admin = await createStaff({ email: 'admin@clients.example', role: 'admin' });
  attorney = await createStaff({ email: 'attorney@clients.example', role: 'attorney' });
  colleague = await createStaff({ email: 'colleague@clients.example', role: 'attorney' });
  secretary = await createStaff({ email: 'secretary@clients.example', role: 'secretary' });
  bookkeeper = await createStaff({ email: 'books@clients.example', role: 'bookkeeper' });
});

describe('opening a client', () => {
  test('a clear conflict check opens a client; details are encrypted', async () => {
    const result = await check(secretary, [{ ...THANDI, kind: 'individual' }]);
    expect(result).toMatchObject({ strongMatches: 0, possibleMatches: 0, decision: 'pending' });
    const { client, checkId } = await clearedClient(attorney, 'individual', THANDI);
    thandiId = client.id;
    thandiCheck = checkId;
    expect(client).toMatchObject({
      isClient: true,
      name: 'Thandi Grace Nkosi',
      partyNumber: 'P-00001',
    });
    expect(client.details.idNumber).toBe('8001015009087');

    const [row] = await inDefaultFirm(() =>
      db().select().from(parties).where(eq(parties.id, thandiId)),
    );
    expect(row!.detailsEncrypted).toMatch(/^v2:/);
    expect(row!.detailsEncrypted).not.toContain('Thandi');
  });

  test('no client without a decided, clearing check', async () => {
    const pending = await check(attorney, [{ name: 'Someone New' }]);
    const blocked = await request(app)
      .post('/api/clients')
      .set(attorney.auth)
      .send({ kind: 'individual', details: { name: 'Someone New' }, conflictCheckId: pending.id });
    expect(blocked.status).toBe(409);
    await decide(attorney, pending.id, 'conflict');
    const conflicted = await request(app)
      .post('/api/clients')
      .set(attorney.auth)
      .send({ kind: 'individual', details: { name: 'Someone New' }, conflictCheckId: pending.id });
    expect(conflicted.status).toBe(409);
    expect(conflicted.body.message).toMatch(/cannot act/);
    expect((await decide(attorney, pending.id, 'clear')).status).toBe(409); // decided once
  });

  test('the register is searchable by name words, ID number, email and phone', async () => {
    const find = async (q: string) =>
      (await request(app).get('/api/clients').query({ q }).set(attorney.auth)).body.map(
        (p: { id: string }) => p.id,
      );
    expect(await find('nkosi')).toContain(thandiId);
    expect(await find('NKOSI Thandi')).toContain(thandiId);
    expect(await find('800101 5009 087')).toContain(thandiId);
    expect(await find('Thandi@Client.example')).toContain(thandiId);
    expect(await find('+27821234567')).toContain(thandiId);
    expect(await find('mokoena')).toEqual([]);
  });
});

describe('conflict checks', () => {
  test('matches: strong on ID/email/full name, possible on shared name words', async () => {
    const result = await check(attorney, [
      { name: 'T. Nkosi', idNumber: '8001015009087' },
      { name: 'Nkosi Grace Thandi' },
      { name: 'Grace Nkosi' },
      { name: 'Thandi Mokoena' },
    ]);
    const bySubject = (i: number) =>
      result.matches.filter((m: { subject: number }) => m.subject === i);
    expect(bySubject(0)[0]).toMatchObject({
      strength: 'strong',
      reasons: expect.arrayContaining(['id_number']),
    });
    expect(bySubject(1)[0]).toMatchObject({ strength: 'strong', reasons: ['name'] });
    expect(bySubject(2)[0]).toMatchObject({ strength: 'possible' });
    expect(bySubject(3)).toEqual([]);
    expect(result.strongMatches).toBe(2);

    const noNotes = await decide(attorney, result.id, 'clear');
    expect(noNotes.status).toBe(400);
  });

  test('only administrators can waive, and only with notes', async () => {
    const result = await check(attorney, [{ name: 'Thandi Grace Nkosi' }]);
    expect(
      (await decide(attorney, result.id, 'waived', 'Client consented in writing')).status,
    ).toBe(403);
    expect((await decide(admin, result.id, 'waived')).status).toBe(400);
    const waived = await decide(
      admin,
      result.id,
      'waived',
      'Both clients consented in writing on 9 Nov',
    );
    expect(waived.body).toMatchObject({
      decision: 'waived',
      decisionNotes: expect.stringMatching(/consented/),
    });
  });
});

describe('matters for clients', () => {
  test('a matter opens for a cleared client, with the client on it and the opener as lead', async () => {
    const opened = await request(app).post('/api/cases').set(attorney.auth).send({
      clientId: thandiId,
      conflictCheckId: thandiCheck,
      title: 'Unfair dismissal claim',
      practiceArea: 'Labour',
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    matterId = opened.body.id;
    expect(opened.body).toMatchObject({
      caseNumber: expect.stringMatching(/^NKP-\d{4}-\d{4}$/),
      title: 'Unfair dismissal claim',
      clientLabel: 'P-00001',
      submissionId: null,
      status: 'open',
    });
    const partiesOn = await request(app).get(`/api/cases/${matterId}/parties`).set(attorney.auth);
    expect(partiesOn.body).toEqual([
      expect.objectContaining({ role: 'client', party: expect.objectContaining({ id: thandiId }) }),
    ]);
    const access = await request(app).get(`/api/cases/${matterId}/access`).set(attorney.auth);
    expect(access.body.members[0]).toMatchObject({ userId: attorney.id, memberRole: 'lead' });

    const client = await request(app).get(`/api/clients/${thandiId}`).set(attorney.auth);
    expect(client.body.matters).toEqual([
      expect.objectContaining({ caseId: matterId, role: 'client' }),
    ]);
  });

  test('opposing parties can be added; an existing client only with a waiver', async () => {
    const opposing = await request(app)
      .post(`/api/cases/${matterId}/parties`)
      .set(attorney.auth)
      .send({
        role: 'opposing',
        party: {
          kind: 'entity',
          details: { name: 'Mega Retail (Pty) Ltd', registrationNumber: '2001/000001/07' },
        },
      });
    expect(opposing.status).toBe(201);
    expect(opposing.body.map((p: { role: string }) => p.role)).toEqual(['client', 'opposing']);

    // A second client, then a matter where Thandi would be the other side.
    const { client: other, checkId } = await clearedClient(attorney, 'individual', {
      name: 'Sipho Dlamini',
    });
    const second = await request(app).post('/api/cases').set(attorney.auth).send({
      clientId: other.id,
      conflictCheckId: checkId,
      title: 'Debt claim',
      practiceArea: 'Civil',
    });
    const against = await request(app)
      .post(`/api/cases/${second.body.id}/parties`)
      .set(attorney.auth)
      .send({ role: 'opposing', partyId: thandiId });
    expect(against.status).toBe(409);
    expect(against.body.message).toMatch(/client of the firm/);

    const waiver = await check(
      attorney,
      [{ name: 'Thandi Grace Nkosi' }],
      'Acting against existing client',
    );
    await decide(admin, waiver.id, 'waived', 'Both clients gave informed written consent');
    const allowed = await request(app)
      .post(`/api/cases/${second.body.id}/parties`)
      .set(attorney.auth)
      .send({ role: 'opposing', partyId: thandiId, conflictCheckId: waiver.id });
    expect(allowed.status).toBe(201);
  });

  test('conflict checks see restricted matters but only count them', async () => {
    await request(app)
      .put(`/api/cases/${matterId}/access`)
      .set(attorney.auth)
      .send({ access: 'restricted' })
      .expect(200);
    const result = await check(colleague, [{ name: 'Mega Retail Ltd' }]);
    const match = result.matches.find((m: { party: { name: string } }) =>
      m.party.name.startsWith('Mega'),
    );
    expect(match).toMatchObject({ strength: 'strong', matters: [], hiddenMatters: 1 });
    const [restricted] = await inDefaultFirm(() =>
      db().select().from(cases).where(eq(cases.id, matterId)),
    );
    expect(JSON.stringify(result)).not.toContain(restricted!.caseNumber);
    // The lead sees it in full.
    const own = await request(app).get(`/api/conflicts/${result.id}`).set(attorney.auth);
    const ownMatch = own.body.matches.find((m: { party: { name: string } }) =>
      m.party.name.startsWith('Mega'),
    );
    expect(ownMatch.matters[0]).toMatchObject({
      caseNumber: restricted!.caseNumber,
      role: 'opposing',
    });
  });
});

describe('permissions and isolation', () => {
  test('roles: secretaries check and open clients; bookkeepers read; support none', async () => {
    expect((await request(app).post('/api/cases').set(secretary.auth).send({})).status).toBe(403);
    expect((await request(app).get('/api/clients').set(bookkeeper.auth)).status).toBe(200);
    expect(
      (
        await request(app)
          .post('/api/clients')
          .set(bookkeeper.auth)
          .send({ kind: 'individual', details: { name: 'x' } })
      ).status,
    ).toBe(403);
    expect((await request(app).post('/api/conflicts').set(bookkeeper.auth).send({})).status).toBe(
      403,
    );
  });

  test('another firm cannot find this firm’s parties', async () => {
    const other = await createFirm({
      slug: 'clients-other',
      legalName: 'Other',
      domains: ['portal.clients-other.test'],
    });
    const otherAdmin = await createStaff({
      firm: other,
      host: 'portal.clients-other.test',
      email: 'a@o.example',
      role: 'admin',
    });
    const res = await request(app)
      .get('/api/clients')
      .query({ q: 'thandi@client.example' })
      .set('Host', 'portal.clients-other.test')
      .set(otherAdmin.auth);
    expect(res.body).toEqual([]);
    const conflict = await request(app)
      .post('/api/conflicts')
      .set('Host', 'portal.clients-other.test')
      .set(otherAdmin.auth)
      .send({ subjects: [THANDI], purpose: 'x' });
    expect(conflict.body.matches).toEqual([]);
  });

  test('the audit trail names no one', async () => {
    const events = await inDefaultFirm(() => db().select().from(auditEvents));
    const text = JSON.stringify(events);
    expect(text).toContain('conflict_check_run');
    expect(text).not.toMatch(/Thandi|Nkosi|Dlamini|8001015009087|thandi@/);
  });
});

describe('records duties', () => {
  test('a data subject export by email includes the client and their matters', async () => {
    const res = await request(app)
      .get('/api/compliance/export')
      .query({ subjectEmail: 'thandi@client.example' })
      .set(admin.auth);
    expect(res.body.parties[0]).toMatchObject({
      id: thandiId,
      details: { idNumber: '8001015009087' },
    });
    expect(res.body.cases.map((c: { id: string }) => c.id)).toContain(matterId);
  });

  test('re-encryption covers parties and conflict checks; the exit export decrypts them', async () => {
    const firm = await defaultFirm();
    await withTenant(firm, () => rotateDataKey(), { system: true });
    const before = await withTenant(firm, () => pendingReencryption(), { system: true });
    expect(before.pending.parties).toBeGreaterThan(0);
    expect(before.pending.conflictChecks).toBeGreaterThan(0);
    await reencryptFirm(firm);
    const after = await withTenant(firm, () => pendingReencryption(), { system: true });
    expect(after.pending).toMatchObject({ parties: 0, conflictChecks: 0 });
    expect((await request(app).get(`/api/clients/${thandiId}`).set(attorney.auth)).body.name).toBe(
      'Thandi Grace Nkosi',
    );

    const data = await exportFirm(firm);
    expect(JSON.stringify(data.tables.parties)).toContain('8001015009087');
    expect(JSON.stringify(data.tables.conflictChecks)).toContain('Employment dispute');
    expect(Object.keys(data.tables)).not.toContain('partyIndex');
  });

  test('retention removes closed matters that never had an intake', async () => {
    await inDefaultFirm(() =>
      db()
        .update(cases)
        .set({ status: 'closed', updatedAt: sql`now() - interval '20 years'` })
        .where(eq(cases.id, matterId)),
    );
    const sweep = await request(app).post('/api/compliance/retention/sweep').set(admin.auth);
    expect(sweep.body.removedCases).toBeGreaterThanOrEqual(1);
    const left = await inDefaultFirm(() => db().select().from(cases).where(eq(cases.id, matterId)));
    expect(left).toEqual([]);
  });
});
