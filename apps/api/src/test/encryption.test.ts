// Epic 6: per-firm envelope encryption, rotation and re-encryption, Key Vault
// wrapping, documents in object storage, audit anchors, admin-only POPIA
// requests, per-firm retention and the firm exit export.
import {
  constants,
  createCipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import app from '../server';
import { db } from '../db/client';
import { withTenant } from '../db/tenant';
import {
  auditAnchors,
  auditEvents,
  documents,
  firmKeys,
  firms,
  submissions,
  type FirmRow,
} from '../db/schema';
import { createFirm } from '../services/firm.service';
import { blindIndex, decryptJson, encryptJson } from '../services/privacy.service';
import {
  clearKeyCache,
  legacyKey,
  rewrapKeys,
  rotateDataKey,
  setKeyVaultCryptoFactory,
  type KeyVaultCrypto,
} from '../services/keys.service';
import {
  pendingReencryption,
  pruneRetiredKeys,
  reencryptFirm,
} from '../services/reencrypt.service';
import { resetObjectStore } from '../services/object-store';
import { anchorCurrentFirm, verifyAuditTrail } from '../services/audit-anchor.service';
import { deleteSubmissions } from '../services/intake.service';
import { exportFirm } from '../services/firm-export.service';
import { createStaff, defaultFirm, inDefaultFirm, type TestStaff } from './helpers';

let objectDir: string;
let admin: TestStaff;
let attorney: TestStaff;
let firm: FirmRow;

const asSystem = <T>(target: FirmRow, fn: () => Promise<T>) =>
  withTenant(target, fn, { system: true });

async function newMatter(staff: TestStaff, email: string) {
  const created = await request(app).post('/api/intake/submissions').set(staff.auth).send({
    fullName: 'Lindiwe Zulu',
    email,
    phone: '0821234567',
    practiceArea: 'Property',
    matterSummary: 'Deposit not returned by the landlord.',
    consentToAi: true,
    consentToStorage: true,
  });
  const assessed = await request(app)
    .post(`/api/intake/submissions/${created.body.id}/assess`)
    .set(staff.auth);
  return { submissionId: created.body.id as string, caseId: assessed.body.matterCase.id as string };
}

beforeAll(async () => {
  objectDir = mkdtempSync(path.join(tmpdir(), 'objects-'));
  process.env.OBJECT_STORE = 'filesystem';
  process.env.OBJECT_STORE_DIR = objectDir;
  resetObjectStore();
  firm = await defaultFirm();
  admin = await createStaff({ email: 'admin@enc.example', role: 'admin' });
  attorney = await createStaff({ email: 'attorney@enc.example', role: 'attorney' });
});

afterAll(() => {
  delete process.env.OBJECT_STORE;
  delete process.env.OBJECT_STORE_DIR;
  resetObjectStore();
  rmSync(objectDir, { recursive: true, force: true });
});

describe('per-firm envelope encryption', () => {
  test('each firm has its own keys: ciphertext and blind indexes do not carry over', async () => {
    const other = await createFirm({
      slug: 'other-enc',
      legalName: 'Other Firm',
      casePrefix: 'OTH',
    });
    const sealed = await inDefaultFirm(() => encryptJson({ secret: 'privileged' }));
    await expect(asSystem(other, () => decryptJson(sealed))).rejects.toThrow();
    const here = await inDefaultFirm(() => blindIndex('same@example.com'));
    const there = await asSystem(other, () => blindIndex('same@example.com'));
    expect(here).not.toBe(there);

    // Keys are stored wrapped, never in the clear.
    const keys = await inDefaultFirm(() => db().select().from(firmKeys));
    expect(keys.map((k) => k.purpose).sort()).toEqual(['data', 'index']);
    expect(
      keys.every((k) => k.kekProvider === 'local' && k.wrappedKey.split('.').length === 3),
    ).toBe(true);
  });

  test('legacy v1 data stays readable and searchable, and re-encryption moves it to the firm key', async () => {
    const { submissionId } = await newMatter(attorney, 'legacy.client@example.com');
    // Turn the row into what epic 5 wrote: v1 ciphertext and the old blind index.
    const legacy = legacyKey()!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', legacy, iv);
    const raw = await inDefaultFirm(async () => {
      const [row] = await db().select().from(submissions).where(eq(submissions.id, submissionId));
      return decryptJson(row!.rawPayloadEncrypted);
    });
    const body = Buffer.concat([cipher.update(JSON.stringify(raw)), cipher.final()]);
    const v1 = [
      'v1',
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      body.toString('base64'),
    ].join(':');
    const lookupKey = createHash('sha256')
      .update(Buffer.concat([Buffer.from('blind-index:v1:'), legacy]))
      .digest();
    const legacyIndex = createHmac('sha256', lookupKey)
      .update('legacy.client@example.com')
      .digest('hex');
    await inDefaultFirm(() =>
      db()
        .update(submissions)
        .set({ rawPayloadEncrypted: v1, emailLookup: legacyIndex })
        .where(eq(submissions.id, submissionId)),
    );

    const exportBefore = await request(app)
      .get('/api/compliance/export?subjectEmail=legacy.client@example.com')
      .set(admin.auth);
    expect(JSON.stringify(exportBefore.body)).toContain('legacy.client@example.com');

    expect((await asSystem(firm, () => pendingReencryption())).pending.submissions).toBeGreaterThan(
      0,
    );
    await reencryptFirm(firm);
    const [after] = await inDefaultFirm(() =>
      db().select().from(submissions).where(eq(submissions.id, submissionId)),
    );
    expect(after!.rawPayloadEncrypted).toMatch(/^v2:1:/);
    expect(after!.emailLookup).not.toBe(legacyIndex);
    const exportAfter = await request(app)
      .get('/api/compliance/export?subjectEmail=legacy.client@example.com')
      .set(admin.auth);
    expect(JSON.stringify(exportAfter.body)).toContain('legacy.client@example.com');
    expect((await asSystem(firm, () => pendingReencryption())).pending).toEqual({
      submissions: 0,
      documents: 0,
      users: 0,
      parties: 0,
      conflictChecks: 0,
      fica: 0,
      time: 0,
      billing: 0,
      calendar: 0,
      research: 0,
      trust: 0,
      portal: 0,
      support: 0,
    });
  });

  test('rotation: new data uses the new key, old data still reads, re-encryption and pruning finish the job', async () => {
    const before = await inDefaultFirm(() => encryptJson({ n: 1 }));
    const version = await asSystem(firm, () => rotateDataKey());
    expect(version).toBe(2);
    const afterRotation = await inDefaultFirm(() => encryptJson({ n: 2 }));
    expect(afterRotation).toMatch(/^v2:2:/);
    expect(await inDefaultFirm(() => decryptJson(before))).toEqual({ n: 1 });

    // Stored data (intake, documents, MFA secrets) is still on v1.
    expect((await asSystem(firm, () => pendingReencryption())).pending.users).toBeGreaterThan(0);
    // A retired key in use is not pruned.
    expect(await asSystem(firm, () => pruneRetiredKeys())).toEqual([]);
    await reencryptFirm(firm);
    expect(await asSystem(firm, () => pruneRetiredKeys())).toEqual([1]);

    // Everyone can still sign in (MFA secrets were re-encrypted).
    const me = await request(app).get('/api/auth/me').set(attorney.auth);
    expect(me.status).toBe(200);
  });

  test('Azure Key Vault wraps new keys; rewrap moves existing firms from the local key', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const calls: string[] = [];
    const fakeVault: KeyVaultCrypto = {
      async wrapKey(_alg, key) {
        calls.push('wrap');
        const result = publicEncrypt(
          { key: publicKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
          key,
        );
        return { result, keyID: 'https://vault.example/keys/firm-kek/version1' };
      },
      async unwrapKey(_alg, wrapped) {
        calls.push('unwrap');
        return {
          result: privateDecrypt(
            { key: privateKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
            wrapped,
          ),
        };
      },
    };
    setKeyVaultCryptoFactory(() => fakeVault);
    process.env.KEY_PROVIDER = 'azure-keyvault';
    process.env.AZURE_KEY_VAULT_KEY_ID = 'https://vault.example/keys/firm-kek';
    try {
      const sealedLocal = await inDefaultFirm(() => encryptJson({ moved: true }));
      const changed = await asSystem(firm, () => rewrapKeys());
      expect(changed).toBeGreaterThan(0);
      const keys = await inDefaultFirm(() => db().select().from(firmKeys));
      expect(keys.every((k) => k.kekProvider === 'azure-keyvault')).toBe(true);
      expect(keys[0]!.kekId).toBe('https://vault.example/keys/firm-kek/version1');

      clearKeyCache();
      expect(await inDefaultFirm(() => decryptJson(sealedLocal))).toEqual({ moved: true });
      expect(calls).toContain('unwrap');

      const fresh = await createFirm({
        slug: 'vault-firm',
        legalName: 'Vault Firm',
        casePrefix: 'VLT',
      });
      await asSystem(fresh, () => encryptJson({ x: 1 }));
      const freshKeys = await asSystem(fresh, () => db().select().from(firmKeys));
      expect(freshKeys[0]!.kekProvider).toBe('azure-keyvault');

      // And back again (e.g. leaving Key Vault): rewrap with the local key.
      process.env.KEY_PROVIDER = 'local';
      await asSystem(firm, () => rewrapKeys());
      const local = await inDefaultFirm(() => db().select().from(firmKeys));
      expect(local.every((k) => k.kekProvider === 'local')).toBe(true);
    } finally {
      delete process.env.KEY_PROVIDER;
      delete process.env.AZURE_KEY_VAULT_KEY_ID;
      setKeyVaultCryptoFactory(null);
      clearKeyCache();
    }
  });
});

describe('documents in the object store', () => {
  let matter: { submissionId: string; caseId: string };
  let documentId: string;

  beforeAll(async () => {
    process.env.KEY_PROVIDER = 'local';
    matter = await newMatter(attorney, 'docs.client@example.com');
    const created = await request(app)
      .post('/api/documents')
      .set(attorney.auth)
      .send({ caseId: matter.caseId, title: 'Letter of demand', body: 'Privileged strategy note' });
    expect(created.status).toBe(201);
    documentId = created.body.id;
  });

  afterAll(() => {
    delete process.env.KEY_PROVIDER;
  });

  function storedFile() {
    const container = `firm-${firm.id.replace(/-/g, '')}`;
    return path.join(objectDir, container, 'documents', documentId);
  }

  test('the body goes to the firm container, encrypted; the row keeps only its key', async () => {
    const [row] = await inDefaultFirm(() =>
      db().select().from(documents).where(eq(documents.id, documentId)),
    );
    expect(row!.encryptedContent).toBeNull();
    expect(row!.storageKey).toBe(`documents/${documentId}`);
    const onDisk = readFileSync(storedFile(), 'utf8');
    expect(onDisk).toMatch(/^v2:/);
    expect(onDisk).not.toContain('Privileged');
    const read = await request(app).get(`/api/documents/${documentId}`).set(attorney.auth);
    expect(read.body.content.body).toBe('Privileged strategy note');
  });

  test('a rolled-back deletion keeps the file; a committed one removes it', async () => {
    await expect(
      withTenant(
        firm,
        async () => {
          await deleteSubmissions([matter.submissionId]);
          throw new Error('roll back');
        },
        { system: true },
      ),
    ).rejects.toThrow('roll back');
    expect(existsSync(storedFile())).toBe(true);

    await inDefaultFirm(() => deleteSubmissions([matter.submissionId]));
    expect(existsSync(storedFile())).toBe(false);
  });
});

describe('audit anchors', () => {
  test('anchors are written once to the store and verification checks them', async () => {
    const anchor = await inDefaultFirm(() => anchorCurrentFirm());
    expect(anchor).toBeTruthy();
    expect(await inDefaultFirm(() => anchorCurrentFirm())).toBeNull(); // nothing new
    const anchorFiles = readdirSync(path.join(objectDir, 'audit-anchors', firm.id));
    expect(anchorFiles).toHaveLength(1);

    const verify = await request(app).get('/api/audit/verify').set(admin.auth);
    expect(verify.body).toMatchObject({
      valid: true,
      trustworthy: true,
      anchors: { checked: 1, problems: [] },
    });
  });

  test('deleting anchored history, or editing an anchor, is detected', async () => {
    // Remove the newest anchored event: the remaining chain is still a valid
    // prefix, but the anchor proves it was longer.
    const [anchor] = await inDefaultFirm(() => db().select().from(auditAnchors));
    await inDefaultFirm(() =>
      db()
        .delete(auditEvents)
        .where(sql`${auditEvents.seq} >= ${anchor!.lastSeq}`),
    );
    const afterDelete = await inDefaultFirm(() => verifyAuditTrail());
    expect(afterDelete.trustworthy).toBe(false);
    expect(afterDelete.anchors.problems.join(' ')).toMatch(/missing/);

    // Editing the database copy of the anchor to match no longer helps.
    await inDefaultFirm(() =>
      db().update(auditAnchors).set({ lastHash: 'forged' }).where(eq(auditAnchors.id, anchor!.id)),
    );
    const afterEdit = await inDefaultFirm(() => verifyAuditTrail());
    expect(afterEdit.anchors.problems.length).toBeGreaterThan(0);
  });
});

describe('records administration', () => {
  test('POPIA data-subject requests are for administrators only', async () => {
    expect((await request(app).get('/api/compliance/requests').set(attorney.auth)).status).toBe(
      403,
    );
    expect((await request(app).get('/api/compliance/requests').set(admin.auth)).status).toBe(200);
  });

  test('administrators set their firm’s retention period (at least a year)', async () => {
    const initial = await request(app).get('/api/firm/settings').set(admin.auth);
    expect(initial.body).toMatchObject({ retentionDays: 3650, retentionIsDefault: true });
    expect(
      (await request(app).patch('/api/firm/settings').set(admin.auth).send({ retentionDays: 30 }))
        .status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .patch('/api/firm/settings')
          .set(attorney.auth)
          .send({ retentionDays: 2000 })
      ).status,
    ).toBe(403);
    const updated = await request(app)
      .patch('/api/firm/settings')
      .set(admin.auth)
      .send({ retentionDays: 2555 });
    expect(updated.body).toMatchObject({ retentionDays: 2555, retentionIsDefault: false });
    const summary = await request(app).get('/api/compliance/summary').set(admin.auth);
    expect(summary.body.retentionDays).toBe(2555);
  });

  test('a firm can only change its own settings row', async () => {
    const other = await createFirm({
      slug: 'settings-other',
      legalName: 'Settings Other',
      casePrefix: 'SOT',
    });
    const changed = await withTenant(other, () =>
      db().update(firms).set({ retentionDays: 400 }).where(eq(firms.id, firm.id)).returning(),
    );
    expect(changed).toHaveLength(0);
    // And only the settings columns, even for its own row.
    await expect(
      withTenant(other, () =>
        db().update(firms).set({ plan: 'free' }).where(eq(firms.id, other.id)),
      ),
    ).rejects.toThrow();
  });

  test('the exit export has decrypted client data and no credentials or keys', async () => {
    const matter = await newMatter(attorney, 'export.client@example.com');
    await request(app)
      .post('/api/documents')
      .set(attorney.auth)
      .send({ caseId: matter.caseId, title: 'Exported note', body: 'Body to export' });
    const data = await exportFirm(await defaultFirm());
    const text = JSON.stringify(data);
    expect(text).toContain('export.client@example.com');
    expect(text).toContain('Body to export');
    expect(Object.keys(data.tables)).not.toContain('firmKeys');
    expect(Object.keys(data.tables)).not.toContain('sessions');
    expect(text).not.toMatch(/passwordHash|mfaSecret|wrappedKey|tokenHash|rawPayloadEncrypted/);
    expect(data.tables.auditEvents!.length).toBeGreaterThan(0);
  });
});
