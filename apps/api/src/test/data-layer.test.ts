import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import app from '../server';
import { db } from '../db/client';
import { inDefaultFirm as asFirm } from './helpers';
import { nextValue } from '../db/sequences';
import { auditEvents, cases, documents, invoices, submissions } from '../db/schema';
import * as auditService from '../services/audit.service';

let adminToken: string;
const auth = () => ({ authorization: `Bearer ${adminToken}` });

async function createMatter(fullName: string, email: string) {
  const created = await request(app)
    .post('/api/intake/submissions')
    .set(auth())
    .send({
      fullName,
      email,
      phone: '0821234567',
      practiceArea: 'Labour Law',
      matterSummary: `${fullName} was dismissed without a hearing.`,
      consentToAi: true,
      consentToStorage: true,
    });
  expect(created.status).toBe(201);
  const assessed = await request(app)
    .post(`/api/intake/submissions/${created.body.id}/assess`)
    .set(auth());
  expect(assessed.status).toBe(200);
  return assessed.body as { id: string; matterCase: { id: string; caseNumber: string } };
}

beforeAll(async () => {
  const admin = await request(app).post('/api/auth/register').send({
    fullName: 'Founding Partner',
    email: 'partner@example.com',
    password: 'CorrectHorse123',
  });
  adminToken = admin.body.token;
});

describe('audit chain', () => {
  test('every event links to the previous one and the chain verifies', () =>
    asFirm(async () => {
      await auditService.logEvent({ action: 'test_one', summary: 'one' });
      await auditService.logEvent({ action: 'test_two', summary: 'two', details: { n: 2 } });

      const rows = await db().select().from(auditEvents).orderBy(auditEvents.seq);
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i]!.previousHash).toBe(rows[i - 1]!.entryHash);
      }
      expect(await auditService.verifyEventChain()).toMatchObject({ valid: true });
    }));

  test('concurrent requests still form a single unbroken chain', async () => {
    // Each write is its own tenant transaction, like concurrent requests.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        asFirm(() => auditService.logEvent({ action: 'concurrent', summary: `event ${i}` })),
      ),
    );
    const result = await asFirm(() => auditService.verifyEventChain());
    expect(result.valid).toBe(true);
  });

  test('details with undefined values hash the same after storage', () =>
    asFirm(async () => {
      await auditService.logEvent({ action: 'sparse', details: { kept: 1, dropped: undefined } });
      expect((await auditService.verifyEventChain()).valid).toBe(true);
    }));

  test('editing a stored event breaks the chain', () =>
    asFirm(async () => {
      const [row] = await db()
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'test_one'))
        .limit(1);
      await db()
        .update(auditEvents)
        .set({ summary: 'tampered' })
        .where(eq(auditEvents.id, row!.id));

      const result = await auditService.verifyEventChain();
      expect(result).toMatchObject({ valid: false, brokenAt: row!.id });

      await db().update(auditEvents).set({ summary: 'one' }).where(eq(auditEvents.id, row!.id));
      expect((await auditService.verifyEventChain()).valid).toBe(true);
    }));
});

describe('numbering', () => {
  test('counters never hand out the same value under concurrency', async () => {
    const values = await Promise.all(
      Array.from({ length: 25 }, () => asFirm(() => nextValue('test-counter'))),
    );
    expect(new Set(values).size).toBe(25);
    expect(Math.max(...values)).toBe(25);
  });

  test('case numbers are sequential and re-assessment keeps the case', async () => {
    const first = await createMatter('Sipho Dlamini', 'sipho@example.com');
    const second = await createMatter('Lerato Mokoena', 'lerato@example.com');
    const year = new Date().getFullYear();
    expect(first.matterCase.caseNumber).toMatch(new RegExp(`^NKP-${year}-\\d{4}$`));
    const n1 = Number(first.matterCase.caseNumber.slice(-4));
    const n2 = Number(second.matterCase.caseNumber.slice(-4));
    expect(n2).toBe(n1 + 1);

    const again = await request(app).post(`/api/intake/submissions/${first.id}/assess`).set(auth());
    expect(again.body.matterCase.id).toBe(first.matterCase.id);
    expect(again.body.matterCase.caseNumber).toBe(first.matterCase.caseNumber);
  });
});

describe('billing', () => {
  test('amounts are stored in cents and VAT is 15%', async () => {
    const matter = await createMatter('Thabo Molefe', 'thabo@example.com');
    const res = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({
        caseId: matter.matterCase.id,
        subject: 'Consultation',
        lineItems: [{ description: 'Consultation', quantity: 1, rate: '1 500.50' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.subtotal).toBe(1500.5);
    expect(res.body.vat).toBe(225.08);
    expect(res.body.total).toBe(1725.58);

    const [row] = await asFirm(() =>
      db().select().from(invoices).where(eq(invoices.id, res.body.id)),
    );
    expect(row!.totalCents).toBe(172558);

    const summary = await request(app).get('/api/billing/summary').set(auth());
    expect(summary.body.outstanding).toBe(1725.58);
  });

  test('duplicate invoice numbers are rejected with 409', async () => {
    const matter = await createMatter('Naledi Khumalo', 'naledi@example.com');
    const body = {
      caseId: matter.matterCase.id,
      subject: 'Fees',
      invoiceNumber: 'INV-TEST-1',
      lineItems: [{ rate: 100 }],
    };
    expect((await request(app).post('/api/billing/invoices').set(auth()).send(body)).status).toBe(
      201,
    );
    expect((await request(app).post('/api/billing/invoices').set(auth()).send(body)).status).toBe(
      409,
    );
  });

  test('ledger rejects amounts with fractions of a cent', async () => {
    const matter = await createMatter('Zanele Ndlovu', 'zanele@example.com');
    const res = await request(app)
      .post('/api/billing/ledger')
      .set(auth())
      .send({ caseId: matter.matterCase.id, account: 'trust', amount: '10.005' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/two decimal places/);
  });
});

describe('privacy', () => {
  test('the intake summary never exposes stored ciphertext', async () => {
    await createMatter('Ayanda Zulu', 'ayanda@example.com');
    const res = await request(app).get('/api/intake/summary').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.latestIntake).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/raw_payload|rawPayload|v1:/);
  });

  test('a data subject export finds their records by email (blind index)', async () => {
    const matter = await createMatter('Kagiso Sithole', 'Kagiso.Sithole@example.com');
    const res = await request(app)
      .get('/api/compliance/export')
      .query({ subjectEmail: 'kagiso.sithole@example.com' })
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.submissions).toHaveLength(1);
    expect(res.body.submissions[0].personalData.fullName).toBe('Kagiso Sithole');
    expect(res.body.cases[0].id).toBe(matter.matterCase.id);

    const [stored] = await asFirm(() =>
      db().select().from(submissions).where(eq(submissions.id, matter.id)),
    );
    expect(stored!.emailLookup).not.toContain('kagiso');
    expect(stored!.rawPayloadEncrypted).not.toContain('Kagiso');
  });

  test('audit entries for intake do not contain client names or emails', async () => {
    const rows = await asFirm(() =>
      db().select().from(auditEvents).where(eq(auditEvents.action, 'submission_created')),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/@example\.com|Sithole|Zulu/);
  });
});

describe('retention', () => {
  test('closed matters past the window are deleted with all their records', async () => {
    const matter = await createMatter('Old Matter', 'old@example.com');
    const keep = await createMatter('Recent Matter', 'recent@example.com');
    await request(app)
      .post('/api/documents')
      .set(auth())
      .send({ caseId: matter.matterCase.id, title: 'Letter', body: 'Dear Sir' });
    await request(app)
      .post(`/api/cases/${matter.matterCase.id}/status`)
      .set(auth())
      .send({ status: 'closed' });
    await request(app)
      .post(`/api/cases/${keep.matterCase.id}/status`)
      .set(auth())
      .send({ status: 'closed' });
    // Backdate only the old matter's closing beyond the 10-year default.
    await asFirm(() =>
      db()
        .update(cases)
        .set({ updatedAt: sql`now() - interval '11 years'` })
        .where(eq(cases.id, matter.matterCase.id)),
    );

    const summary = await request(app).get('/api/compliance/summary').set(auth());
    expect(summary.body.eligibleForRetention).toBe(1);

    const sweep = await request(app).post('/api/compliance/retention/sweep').set(auth());
    expect(sweep.status).toBe(200);
    expect(sweep.body.removedCases).toBe(1);

    await asFirm(async () => {
      expect(
        await db().select().from(cases).where(eq(cases.id, matter.matterCase.id)),
      ).toHaveLength(0);
      expect(
        await db().select().from(documents).where(eq(documents.caseId, matter.matterCase.id)),
      ).toHaveLength(0);
      expect(await db().select().from(cases).where(eq(cases.id, keep.matterCase.id))).toHaveLength(
        1,
      );
      expect((await auditService.verifyEventChain()).valid).toBe(true);
    });
  });
});

describe('validation and response shapes', () => {
  test('invalid input returns 400 with the field that is wrong', async () => {
    const res = await request(app).post('/api/intake/submissions').set(auth()).send({
      fullName: 'X',
      email: 'not-an-email',
      phone: '1',
      practiceArea: 'A',
      matterSummary: 'B',
      consentToAi: true,
      consentToStorage: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/email/);
  });

  test('case detail returns camelCase tasks and timeline', async () => {
    const matter = await createMatter('Shape Check', 'shape@example.com');
    await request(app)
      .post(`/api/cases/${matter.matterCase.id}/tasks`)
      .set(auth())
      .send({ title: 'Request documents', dueDate: '2030-01-15' });
    const res = await request(app).get(`/api/cases/${matter.matterCase.caseNumber}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.tasks[0]).toMatchObject({
      caseId: matter.matterCase.id,
      title: 'Request documents',
      dueDate: '2030-01-15',
      status: 'open',
    });
    expect(res.body.timeline[0]).toHaveProperty('eventType', 'task_created');
    expect(res.body.timeline[0]).not.toHaveProperty('event_type');
  });

  test('unknown cases return 404', async () => {
    const res = await request(app).get('/api/cases/NKP-1999-9999').set(auth());
    expect(res.status).toBe(404);
  });
});
