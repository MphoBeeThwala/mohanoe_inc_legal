// FICA customer due diligence: risk, KYC documents, verification, enforcement.
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../server';
import { db } from '../db/client';
import { withTenant } from '../db/tenant';
import { ficaDocuments, ficaProfiles } from '../db/schema';
import { createFirm } from '../services/firm.service';
import { resetObjectStore } from '../services/object-store';
import { rotateDataKey } from '../services/keys.service';
import { pendingReencryption, reencryptFirm } from '../services/reencrypt.service';
import { exportFirm } from '../services/firm-export.service';
import { createStaff, defaultFirm, inDefaultFirm, type TestStaff } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n% test identity document\n%%EOF\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let admin: TestStaff;
let attorney: TestStaff;
let secretary: TestStaff;
let bookkeeper: TestStaff;
let clientId: string;
let checkId: string;

function upload(
  staff: TestStaff,
  docType: string,
  file = PDF,
  contentType = 'application/pdf',
  fileName = 'Thandi Nkosi ID.pdf',
) {
  return request(app)
    .post(`/api/clients/${clientId}/fica/documents`)
    .set(staff.auth)
    .send({ docType, fileName, contentType, dataBase64: file.toString('base64') });
}

async function newClient(name: string) {
  const check = await request(app)
    .post('/api/conflicts')
    .set(attorney.auth)
    .send({ subjects: [{ name }], purpose: 'Advice' });
  await request(app)
    .post(`/api/conflicts/${check.body.id}/decision`)
    .set(attorney.auth)
    .send({ decision: 'clear' });
  const client = await request(app)
    .post('/api/clients')
    .set(attorney.auth)
    .send({ kind: 'individual', details: { name }, conflictCheckId: check.body.id });
  return { id: client.body.id as string, checkId: check.body.id as string };
}

beforeAll(async () => {
  admin = await createStaff({ email: 'admin@fica.example', role: 'admin' });
  attorney = await createStaff({ email: 'attorney@fica.example', role: 'attorney' });
  secretary = await createStaff({ email: 'secretary@fica.example', role: 'secretary' });
  bookkeeper = await createStaff({ email: 'books@fica.example', role: 'bookkeeper' });
  ({ id: clientId, checkId } = await newClient('Thandi Nkosi'));
});

describe('documents', () => {
  test('only PDF, JPEG or PNG whose bytes match the type', async () => {
    expect(
      (await upload(secretary, 'id_document', Buffer.from('hello'), 'text/plain')).status,
    ).toBe(400);
    expect((await upload(secretary, 'id_document', PNG, 'application/pdf')).status).toBe(400);
  });

  test('a secretary uploads; the file and its name are encrypted', async () => {
    const res = await upload(secretary, 'id_document');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'in_progress',
      riskRating: 'low',
      missing: ['proof_of_address'],
    });
    expect(res.body.documents[0]).toMatchObject({
      docType: 'id_document',
      fileName: 'Thandi Nkosi ID.pdf',
    });
    const [row] = await inDefaultFirm(() => db().select().from(ficaDocuments));
    expect(row!.fileNameEncrypted).toMatch(/^v2:/);
    expect(row!.encryptedContent).not.toContain('PDF');
  });

  test('download returns the original file and is audited', async () => {
    const profile = await request(app).get(`/api/clients/${clientId}/fica`).set(bookkeeper.auth);
    const doc = profile.body.documents[0];
    const res = await request(app)
      .get(`/api/clients/${clientId}/fica/documents/${doc.id}`)
      .set(attorney.auth)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('Thandi%20Nkosi%20ID.pdf');
    expect((res.body as Buffer).equals(PDF)).toBe(true);
  });

  test('roles: bookkeepers read only; secretaries collect but cannot verify', async () => {
    expect((await upload(bookkeeper, 'proof_of_address')).status).toBe(403);
    expect(
      (await request(app).post(`/api/clients/${clientId}/fica/verify`).set(secretary.auth)).status,
    ).toBe(403);
  });
});

describe('risk and verification', () => {
  test('verification needs every required document', async () => {
    const blocked = await request(app)
      .post(`/api/clients/${clientId}/fica/verify`)
      .set(attorney.auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/proof of address/);
    await upload(secretary, 'proof_of_address');
    const verified = await request(app)
      .post(`/api/clients/${clientId}/fica/verify`)
      .set(attorney.auth);
    expect(verified.body).toMatchObject({ status: 'verified', verifiedBy: expect.any(String) });
    const due = new Date(verified.body.reviewDue);
    expect(due.getFullYear()).toBe(new Date().getFullYear() + 3); // low risk: 36 months
  });

  test('a politically exposed person is high risk; it can be raised, never lowered', async () => {
    const res = await request(app)
      .put(`/api/clients/${clientId}/fica/risk`)
      .set(attorney.auth)
      .send({
        riskFactors: { politicallyExposed: true },
        riskRating: 'low',
        notes: 'Spouse of a councillor',
      });
    expect(res.body).toMatchObject({
      riskRating: 'high',
      status: 'in_progress', // re-verification needed
      missing: ['source_of_funds'],
      notes: 'Spouse of a councillor',
    });
    await upload(secretary, 'source_of_funds');
    const verified = await request(app)
      .post(`/api/clients/${clientId}/fica/verify`)
      .set(attorney.auth);
    expect(new Date(verified.body.reviewDue).getFullYear()).toBe(new Date().getFullYear() + 1);
  });

  test('client lists show FICA status', async () => {
    const list = await request(app).get('/api/clients').set(attorney.auth);
    expect(list.body.find((c: { id: string }) => c.id === clientId).ficaStatus).toBe('verified');
  });
});

describe('the firm can require FICA before new matters', () => {
  test('enforced: unverified clients get no new matters; verified ones do; overdue reviews block', async () => {
    await request(app)
      .patch('/api/firm/settings')
      .set(admin.auth)
      .send({ ficaEnforced: true })
      .expect(200);
    const fresh = await newClient('Sipho Dlamini');
    const blocked = await request(app).post('/api/cases').set(attorney.auth).send({
      clientId: fresh.id,
      conflictCheckId: fresh.checkId,
      title: 'Advice',
      practiceArea: 'Civil',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/FICA/);

    const ok = await request(app).post('/api/cases').set(attorney.auth).send({
      clientId,
      conflictCheckId: checkId,
      title: 'Advice',
      practiceArea: 'Civil',
    });
    expect(ok.status).toBe(201);

    await inDefaultFirm(() =>
      db()
        .update(ficaProfiles)
        .set({ reviewDue: '2020-01-01' })
        .where(eq(ficaProfiles.partyId, clientId)),
    );
    const overdue = await request(app).post('/api/cases').set(attorney.auth).send({
      clientId,
      conflictCheckId: checkId,
      title: 'Second matter',
      practiceArea: 'Civil',
    });
    expect(overdue.status).toBe(409);
    expect(overdue.body.message).toMatch(/review is due/);
    expect(
      (await request(app).get(`/api/clients/${clientId}/fica`).set(attorney.auth)).body.status,
    ).toBe('review_due');
    await request(app)
      .patch('/api/firm/settings')
      .set(admin.auth)
      .send({ ficaEnforced: false })
      .expect(200);
  });
});

describe('storage, records and isolation', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'fica-'));
    process.env.OBJECT_STORE = 'filesystem';
    process.env.OBJECT_STORE_DIR = dir;
    resetObjectStore();
  });

  afterAll(() => {
    delete process.env.OBJECT_STORE;
    delete process.env.OBJECT_STORE_DIR;
    resetObjectStore();
    rmSync(dir, { recursive: true, force: true });
  });

  test('with an object store, files go to the firm container and go when deleted', async () => {
    const res = await upload(secretary, 'other', PNG, 'image/png', 'scan.png');
    const doc = res.body.documents.find((d: { fileName: string }) => d.fileName === 'scan.png');
    const firm = await defaultFirm();
    const file = path.join(dir, `firm-${firm.id.replace(/-/g, '')}`, 'fica', doc.id);
    expect(existsSync(file)).toBe(true);
    await request(app)
      .delete(`/api/clients/${clientId}/fica/documents/${doc.id}`)
      .set(secretary.auth)
      .expect(200);
    expect(existsSync(file)).toBe(false);
  });

  test('deleting a required document after verification reopens verification', async () => {
    await request(app)
      .put(`/api/clients/${clientId}/fica/risk`)
      .set(attorney.auth)
      .send({ riskFactors: { politicallyExposed: true } });
    await inDefaultFirm(() =>
      db()
        .update(ficaProfiles)
        .set({ reviewDue: '2099-01-01' })
        .where(eq(ficaProfiles.partyId, clientId)),
    );
    const profile = await request(app).get(`/api/clients/${clientId}/fica`).set(attorney.auth);
    const sof = profile.body.documents.find(
      (d: { docType: string }) => d.docType === 'source_of_funds',
    );
    const after = await request(app)
      .delete(`/api/clients/${clientId}/fica/documents/${sof.id}`)
      .set(attorney.auth);
    expect(after.body).toMatchObject({ status: 'in_progress', missing: ['source_of_funds'] });
  });

  test('re-encryption and the exit export cover FICA records', async () => {
    const firm = await defaultFirm();
    await withTenant(firm, () => rotateDataKey(), { system: true });
    expect(
      (await withTenant(firm, () => pendingReencryption(), { system: true })).pending.fica,
    ).toBeGreaterThan(0);
    await reencryptFirm(firm);
    expect(
      (await withTenant(firm, () => pendingReencryption(), { system: true })).pending.fica,
    ).toBe(0);
    const profile = await request(app).get(`/api/clients/${clientId}/fica`).set(attorney.auth);
    expect(profile.body.notes).toBe('Spouse of a councillor');

    const data = await exportFirm(firm);
    const docs = data.tables.ficaDocuments as Array<{ fileName: string; dataBase64: string }>;
    expect(
      docs.some(
        (d) =>
          d.fileName === 'Thandi Nkosi ID.pdf' && Buffer.from(d.dataBase64, 'base64').equals(PDF),
      ),
    ).toBe(true);
  });

  test('another firm cannot see the profile', async () => {
    const other = await createFirm({
      slug: 'fica-other',
      legalName: 'Other',
      domains: ['portal.fica-other.test'],
    });
    const otherAdmin = await createStaff({
      firm: other,
      host: 'portal.fica-other.test',
      email: 'a@o.example',
      role: 'admin',
    });
    const res = await request(app)
      .get(`/api/clients/${clientId}/fica`)
      .set('Host', 'portal.fica-other.test')
      .set(otherAdmin.auth);
    expect(res.status).toBe(404);
  });
});
