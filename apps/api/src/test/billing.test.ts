// Billing: disbursements, drafts from WIP, gap-free issuing, payments, voids,
// PDFs and email, statements and aging, permissions and isolation.
import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../server';
import { db } from '../db/client';
import { withTenant } from '../db/tenant';
import { auditEvents, disbursements, invoices, timeEntries } from '../db/schema';
import { createFirm } from '../services/firm.service';
import { rotateDataKey } from '../services/keys.service';
import { pendingReencryption, reencryptFirm } from '../services/reencrypt.service';
import { exportFirm } from '../services/firm-export.service';
import { testOutbox } from '../services/mail.service';
import { totals } from '../services/billing.service';
import { createStaff, defaultFirm, inDefaultFirm, type TestStaff } from './helpers';

let admin: TestStaff;
let attorney: TestStaff;
let bookkeeper: TestStaff;
let secretary: TestStaff;
let matter: { id: string; caseNumber: string };
let clientId: string;

const CLIENT = {
  name: 'Ayanda Zulu',
  email: 'ayanda@client.example',
  address: '12 Florida Road, Durban, 4001',
};

async function openMatter(details: Record<string, string>, title: string) {
  const check = await request(app)
    .post('/api/conflicts')
    .set(attorney.auth)
    .send({ subjects: [{ name: details.name }], purpose: title });
  await request(app)
    .post(`/api/conflicts/${check.body.id}/decision`)
    .set(attorney.auth)
    .send({ decision: 'clear' });
  const client = await request(app)
    .post('/api/clients')
    .set(attorney.auth)
    .send({ kind: 'individual', details, conflictCheckId: check.body.id });
  const opened = await request(app).post('/api/cases').set(attorney.auth).send({
    clientId: client.body.id,
    conflictCheckId: check.body.id,
    title,
    practiceArea: 'Property',
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  return { matter: opened.body as { id: string; caseNumber: string }, clientId: client.body.id };
}

const record = (staff: TestStaff, body: Record<string, unknown>) =>
  request(app).post('/api/time/entries').set(staff.auth).send(body).expect(201);
const disburse = (staff: TestStaff, body: Record<string, unknown>) =>
  request(app).post('/api/billing/disbursements').set(staff.auth).send(body);
const draft = (staff: TestStaff, body: Record<string, unknown>) =>
  request(app).post('/api/billing/invoices').set(staff.auth).send(body);
const act = (staff: TestStaff, id: string, action: string, body: object = {}) =>
  request(app).post(`/api/billing/invoices/${id}/${action}`).set(staff.auth).send(body);

beforeAll(async () => {
  admin = await createStaff({ email: 'admin@bill.example', role: 'admin', fullName: 'Ada Admin' });
  attorney = await createStaff({
    email: 'attorney@bill.example',
    role: 'attorney',
    fullName: 'Lerato Attorney',
  });
  bookkeeper = await createStaff({ email: 'books@bill.example', role: 'bookkeeper' });
  secretary = await createStaff({ email: 'desk@bill.example', role: 'secretary' });
  await request(app)
    .put(`/api/time/rates/${attorney.id}`)
    .set(admin.auth)
    .send({ hourlyRate: 2000 })
    .expect(200);
  ({ matter, clientId } = await openMatter(CLIENT, 'Transfer of erf 123'));
});

describe('amounts', () => {
  test('VAT applies only to vatable lines and rounds to the cent', () => {
    expect(
      totals(
        [
          {
            kind: 'fee',
            description: '',
            quantity: 1,
            unitCents: 100_001,
            amountCents: 100_001,
            vatable: true,
          },
          {
            kind: 'disbursement',
            description: '',
            quantity: 1,
            unitCents: 50_000,
            amountCents: 50_000,
            vatable: false,
          },
        ],
        1500,
      ),
    ).toEqual({ subtotalCents: 150_001, vatCents: 15_000, totalCents: 165_001 });
    expect(totals([], 0)).toEqual({ subtotalCents: 0, vatCents: 0, totalCents: 0 });
  });
});

describe('disbursements', () => {
  test('recorded on a matter, encrypted, and only by billing staff', async () => {
    const sheriff = await disburse(attorney, {
      caseRef: matter.caseNumber,
      description: 'Sheriff: service on Ayanda Zulu',
      amount: '450.00',
    });
    expect(sheriff.status, JSON.stringify(sheriff.body)).toBe(201);
    expect(sheriff.body).toMatchObject({ amount: 450, vatable: true, status: 'unbilled' });
    const court = await disburse(bookkeeper, {
      caseRef: matter.id,
      description: 'Deeds office fee',
      amount: 120,
      vatable: false,
    });
    expect(court.status).toBe(201);

    const [row] = await inDefaultFirm(() =>
      db().select().from(disbursements).where(eq(disbursements.id, sheriff.body.id)),
    );
    expect(row?.descriptionEncrypted).toMatch(/^v2:/);
    expect(JSON.stringify(row)).not.toContain('Ayanda');

    expect(
      (await disburse(secretary, { caseRef: matter.id, description: 'x', amount: 1 })).status,
    ).toBe(403);
    const future = await disburse(attorney, {
      caseRef: matter.id,
      description: 'x',
      amount: 1,
      incurredOn: '2999-01-01',
    });
    expect(future.status).toBe(400);
    expect(
      (await disburse(attorney, { caseRef: matter.id, description: 'x', amount: 0 })).status,
    ).toBe(400);
    const list = await request(app)
      .get(`/api/billing/disbursements?caseId=${matter.id}`)
      .set(bookkeeper.auth);
    expect(list.body).toHaveLength(2);
  });
});

describe('invoices', () => {
  let invoiceId: string;
  let firstNumber: string;

  test('a draft gathers unbilled billable time and disbursements, and holds them', async () => {
    await record(attorney, {
      caseRef: matter.id,
      minutes: 90,
      activity: 'drafting',
      description: 'Drafted deed of sale for Ayanda Zulu',
      workDate: '2026-10-01',
    });
    await record(attorney, {
      caseRef: matter.id,
      minutes: 12,
      billable: false,
      description: 'Internal note',
      workDate: '2026-10-02',
    });

    const res = await draft(attorney, {
      caseRef: matter.caseNumber,
      subject: 'Transfer: first account',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    invoiceId = res.body.id;
    expect(res.body).toMatchObject({
      status: 'draft',
      number: null,
      clientPartyId: clientId,
      subject: 'Transfer: first account',
      subtotal: 3570, // 1.5 h × R2 000 + R450 + R120
      vat: 517.5, // 15% of R3 450 (the deeds office fee has no VAT)
      total: 4087.5,
      vatRate: 0.15,
    });
    const fee = res.body.lines.find((line: { kind: string }) => line.kind === 'fee');
    expect(fee).toMatchObject({
      quantity: 1.5,
      unitPrice: 2000,
      amount: 3000,
      feeEarner: 'Lerato Attorney',
      workDate: '2026-10-01',
      description: 'Drafted deed of sale for Ayanda Zulu',
    });
    expect(res.body.lines).toHaveLength(3);

    const stored = await inDefaultFirm(async () => {
      const [row] = await db().select().from(invoices).where(eq(invoices.id, invoiceId));
      const trail = await db()
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, invoiceId));
      return { row, trail };
    });
    expect(stored.row?.contentEncrypted).toMatch(/^v2:/);
    expect(JSON.stringify(stored.row)).not.toContain('Ayanda');
    expect(JSON.stringify(stored.trail)).not.toContain('Ayanda');

    // Held: nothing left to bill, and the time can't change.
    const again = await draft(attorney, { caseRef: matter.id, subject: 'Again' });
    expect(again.status).toBe(400);
    const fees = await request(app).get(`/api/time/entries?caseId=${matter.id}`).set(attorney.auth);
    const held = (fees.body as Array<{ id: string; billable: boolean }>).find((e) => e.billable)!;
    const edit = await request(app)
      .patch(`/api/time/entries/${held.id}`)
      .set(attorney.auth)
      .send({ minutes: 60 });
    expect(edit.status).toBe(409);
    const taken = await draft(attorney, {
      caseRef: matter.id,
      subject: 'Specific',
      timeEntryIds: [held.id],
    });
    expect(taken.status).toBe(409);

    // Drafts aren't owed yet.
    const summary = await request(app).get('/api/billing/summary').set(bookkeeper.auth);
    expect(summary.body).toMatchObject({ outstanding: 0, drafts: 1 });
  });

  test('a draft can change and be deleted, which releases its time', async () => {
    const changed = await request(app)
      .patch(`/api/billing/invoices/${invoiceId}`)
      .set(attorney.auth)
      .send({ lines: [{ description: 'Postage', rate: 30, vatable: true }], notes: 'Thank you' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ subtotal: 3600, vat: 522, notes: 'Thank you' });
    const replaced = await request(app)
      .patch(`/api/billing/invoices/${invoiceId}`)
      .set(attorney.auth)
      .send({ lines: [] });
    expect(replaced.body.subtotal).toBe(3570);

    const other = await draft(attorney, {
      caseRef: matter.id,
      subject: 'Manual only',
      timeEntryIds: [],
      disbursementIds: [],
      lines: [{ description: 'Consultation fee', rate: 500 }],
    });
    expect(other.status).toBe(201);
    await request(app)
      .delete(`/api/billing/invoices/${other.body.id}`)
      .set(attorney.auth)
      .expect(200);
    expect(
      (await request(app).get(`/api/billing/invoices/${other.body.id}`).set(attorney.auth)).status,
    ).toBe(404);
  });

  test('issuing needs the firm details, numbers the invoice and bills its time', async () => {
    const blocked = await act(attorney, invoiceId, 'issue');
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toContain('VAT number');
    const badVat = await request(app)
      .patch('/api/firm/settings')
      .set(admin.auth)
      .send({ billing: { vatNumber: '123' } });
    expect(badVat.status).toBe(400);
    await request(app)
      .patch('/api/firm/settings')
      .set(admin.auth)
      .send({
        billing: {
          vatNumber: '4987654321',
          address: '1 Smith Street, Durban',
          bankDetails: 'Business account 123 456 789, branch 250655',
          paymentTermsDays: 14,
        },
      })
      .expect(200);
    const settings = await request(app).get('/api/firm/settings').set(admin.auth);
    expect(settings.body.billing).toMatchObject({ vatRegistered: true, paymentTermsDays: 14 });

    const issued = await act(attorney, invoiceId, 'issue');
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    firstNumber = issued.body.number;
    expect(firstNumber).toMatch(/^INV-\d{6}$/);
    expect(issued.body).toMatchObject({ status: 'issued', balance: 4087.5 });
    const days = (Date.parse(issued.body.dueAt) - Date.parse(issued.body.issuedAt)) / 86_400_000;
    expect(days).toBe(14);

    const rows = await inDefaultFirm(() =>
      db().select().from(timeEntries).where(eq(timeEntries.invoiceId, invoiceId)),
    );
    expect(rows.map((row) => row.status)).toEqual(['billed']);
    expect((await request(app).get('/api/time/wip').set(bookkeeper.auth)).body.value).toBe(0);

    expect((await act(attorney, invoiceId, 'issue')).status).toBe(409);
    expect(
      (
        await request(app)
          .patch(`/api/billing/invoices/${invoiceId}`)
          .set(attorney.auth)
          .send({ notes: 'x' })
      ).status,
    ).toBe(409);
    expect(
      (await request(app).delete(`/api/billing/invoices/${invoiceId}`).set(attorney.auth)).status,
    ).toBe(409);
  });

  test('payments: part, more than owing, in full, and reversed by an administrator', async () => {
    const part = await act(bookkeeper, invoiceId, 'payments', {
      amount: '1 000',
      method: 'eft',
      reference: 'FNB 8812',
      receivedOn: '2026-10-20',
    });
    expect(part.status, JSON.stringify(part.body)).toBe(201);
    expect(part.body).toMatchObject({ status: 'partially_paid', paid: 1000, balance: 3087.5 });
    expect(
      (await act(bookkeeper, invoiceId, 'payments', { amount: 5000, method: 'eft' })).status,
    ).toBe(400);
    expect(
      (
        await act(bookkeeper, invoiceId, 'payments', {
          amount: 1,
          method: 'eft',
          receivedOn: '2999-01-01',
        })
      ).status,
    ).toBe(400);
    expect(
      (await act(bookkeeper, invoiceId, 'payments', { amount: 1, method: 'cheque' })).status,
    ).toBe(400);
    const full = await act(bookkeeper, invoiceId, 'payments', {
      amount: 3087.5,
      method: 'card',
      receivedOn: '2026-10-25',
    });
    expect(full.body).toMatchObject({ status: 'paid', balance: 0, paid: 4087.5 });
    expect(full.body.paidAt.slice(0, 10)).toBe('2026-10-25');
    expect(
      (await act(bookkeeper, invoiceId, 'payments', { amount: 1, method: 'eft' })).status,
    ).toBe(409);

    const last = full.body.payments.at(-1).id;
    expect(
      (
        await request(app)
          .delete(`/api/billing/invoices/${invoiceId}/payments/${last}`)
          .set(bookkeeper.auth)
      ).status,
    ).toBe(403);
    const reversed = await request(app)
      .delete(`/api/billing/invoices/${invoiceId}/payments/${last}`)
      .set(admin.auth);
    expect(reversed.body).toMatchObject({
      status: 'partially_paid',
      balance: 3087.5,
      paidAt: null,
    });
    await act(bookkeeper, invoiceId, 'payments', {
      amount: 3087.5,
      method: 'eft',
      receivedOn: '2026-10-26',
    }).expect(201);
  });

  test('voiding keeps the number and returns the time to WIP; the next number follows', async () => {
    await record(attorney, { caseRef: matter.id, minutes: 30, description: 'Lodgement' });
    const second = await draft(attorney, { caseRef: matter.id, subject: 'Second account' });
    expect(second.body.total).toBe(1150);
    const issued = await act(attorney, second.body.id, 'issue');
    const n = (value: string) => Number(value.slice(4));
    expect(n(issued.body.number)).toBe(n(firstNumber) + 1);

    expect((await act(attorney, second.body.id, 'void')).status).toBe(403);
    expect((await act(admin, invoiceId, 'void')).status).toBe(409); // paid
    const voided = await act(admin, second.body.id, 'void');
    expect(voided.body).toMatchObject({ status: 'void', number: issued.body.number, balance: 0 });
    expect((await request(app).get('/api/time/wip').set(bookkeeper.auth)).body.value).toBe(1000);

    const third = await draft(attorney, { caseRef: matter.id, subject: 'Second account (again)' });
    const reissued = await act(attorney, third.body.id, 'issue');
    expect(n(reissued.body.number)).toBe(n(firstNumber) + 2);
  });

  test('the invoice PDF, and email to the client with the PDF attached', async () => {
    const res = await request(app)
      .get(`/api/billing/invoices/${invoiceId}/pdf`)
      .set(bookkeeper.auth)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain(`${firstNumber}.pdf`);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const before = testOutbox().length;
    const sent = await act(attorney, invoiceId, 'send');
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.sentAt).toBeTruthy();
    const message = testOutbox().at(-1)!;
    expect(testOutbox().length).toBe(before + 1);
    expect(message.to).toBe(CLIENT.email);
    expect(message.text).toContain(firstNumber);
    expect(message.attachments?.[0]).toMatchObject({
      filename: `${firstNumber}.pdf`,
      contentType: 'application/pdf',
    });
    expect(message.attachments?.[0]?.content.subarray(0, 5).toString()).toBe('%PDF-');
    const trail = await inDefaultFirm(() =>
      db().select().from(auditEvents).where(eq(auditEvents.action, 'invoice_sent')),
    );
    expect(JSON.stringify(trail)).not.toContain(CLIENT.email);

    const drafted = await draft(attorney, {
      caseRef: matter.id,
      subject: 'Not yet',
      lines: [{ description: 'Fee', rate: 10 }],
    });
    expect((await act(attorney, drafted.body.id, 'send')).status).toBe(409);
    await request(app).delete(`/api/billing/invoices/${drafted.body.id}`).set(attorney.auth);
  });
});

describe('statements and aging', () => {
  test("a client's statement runs a balance and ages what is owing", async () => {
    // The reissued second account: make it 45 days overdue.
    const open = await request(app)
      .get(`/api/billing/invoices?clientId=${clientId}&status=issued`)
      .set(bookkeeper.auth);
    expect(open.body).toHaveLength(1);
    const owing = open.body[0];
    await inDefaultFirm(() =>
      db()
        .update(invoices)
        .set({
          issuedAt: new Date(Date.now() - 59 * 86_400_000),
          dueAt: new Date(Date.now() - 45 * 86_400_000),
        })
        .where(eq(invoices.id, owing.id)),
    );
    // And the first account issued before its payments (20 and 26 October).
    const [first] = (
      await request(app)
        .get(`/api/billing/invoices?clientId=${clientId}&status=paid`)
        .set(bookkeeper.auth)
    ).body;
    await inDefaultFirm(() =>
      db()
        .update(invoices)
        .set({ issuedAt: new Date('2026-10-15T08:00:00Z') })
        .where(eq(invoices.id, first.id)),
    );

    const res = await request(app).get(`/api/billing/statements/${clientId}`).set(bookkeeper.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ clientName: CLIENT.name, closingBalance: 1150 });
    const kinds = (res.body.lines as Array<{ kind: string }>).map((line) => line.kind);
    expect(kinds.filter((kind) => kind === 'invoice')).toHaveLength(2); // void left out
    expect(kinds.filter((kind) => kind === 'payment')).toHaveLength(2);
    expect(res.body.lines.at(-1).balance).toBe(1150);
    expect(res.body.aging).toMatchObject({ days60: 1150, total: 1150, current: 0 });

    const later = await request(app)
      .get(`/api/billing/statements/${clientId}?from=2026-10-21`)
      .set(bookkeeper.auth);
    // Before 21 October: the second account (+1 150), the first (+4 087.50) and R1 000 paid.
    expect(later.body.openingBalance).toBe(4237.5);
    expect(later.body.lines.map((line: { date: string }) => line.date)).toEqual(['2026-10-26']);

    const aging = await request(app).get('/api/billing/aging').set(bookkeeper.auth);
    expect(aging.body.totals).toMatchObject({ days60: 1150, total: 1150 });
    expect(aging.body.clients[0]).toMatchObject({ clientPartyId: clientId, invoices: 1 });
    const summary = await request(app).get('/api/billing/summary').set(bookkeeper.auth);
    expect(summary.body).toMatchObject({ outstanding: 1150, overdue: 1150, drafts: 0 });

    const pdf = await request(app)
      .get(`/api/billing/statements/${clientId}/pdf`)
      .set(bookkeeper.auth);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(
      (await request(app).get('/api/billing/statements/nope').set(bookkeeper.auth)).status,
    ).toBe(404);
  });
});

describe('access', () => {
  test('secretaries see no billing; walled staff and other firms see none of this matter', async () => {
    expect((await request(app).get('/api/billing/invoices').set(secretary.auth)).status).toBe(403);
    expect((await request(app).get('/api/billing/aging').set(secretary.auth)).status).toBe(403);

    const walled = await createStaff({ email: 'walled@bill.example', role: 'attorney' });
    await request(app)
      .post(`/api/cases/${matter.id}/exclusions`)
      .set(attorney.auth)
      .send({ userId: walled.id, reason: 'Acted for the seller' })
      .expect(201);
    const list = await request(app).get('/api/billing/invoices').set(walled.auth);
    expect((list.body as Array<{ caseId: string }>).some((i) => i.caseId === matter.id)).toBe(
      false,
    );
    const all = await request(app).get('/api/billing/invoices').set(admin.auth);
    const one = (all.body as Array<{ id: string; caseId: string }>).find(
      (i) => i.caseId === matter.id,
    )!;
    expect(
      (await request(app).get(`/api/billing/invoices/${one.id}`).set(walled.auth)).status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/billing/invoices/${one.id}/pdf`).set(walled.auth)).status,
    ).toBe(404);
    expect((await act(walled, one.id, 'payments', { amount: 1, method: 'eft' })).status).toBe(404);
    const aging = await request(app).get('/api/billing/aging').set(walled.auth);
    expect(aging.body.totals.total).toBe(0);

    const otherFirm = await createFirm({
      slug: 'bill-other',
      legalName: 'Other',
      domains: ['portal.bill-other.test'],
    });
    const other = await createStaff({
      firm: otherFirm,
      host: 'portal.bill-other.test',
      email: 'a@bill-other.example',
      role: 'admin',
    });
    const outside = (path: string) =>
      request(app).get(path).set('Host', 'portal.bill-other.test').set(other.auth);
    expect((await outside('/api/billing/invoices')).body).toEqual([]);
    expect((await outside(`/api/billing/invoices/${one.id}`)).status).toBe(404);
    expect((await outside(`/api/billing/statements/${clientId}`)).status).toBe(404);
    expect((await outside('/api/billing/disbursements')).body).toEqual([]);
  });
});

describe('records', () => {
  test('re-encryption and the firm export cover invoices and disbursements', async () => {
    const firm = await defaultFirm();
    await withTenant(firm, () => rotateDataKey(), { system: true });
    expect(
      (await withTenant(firm, () => pendingReencryption(), { system: true })).pending.billing,
    ).toBeGreaterThan(0);
    await reencryptFirm(firm);
    expect(
      (await withTenant(firm, () => pendingReencryption(), { system: true })).pending.billing,
    ).toBe(0);
    const invoice = await request(app).get('/api/billing/invoices').set(admin.auth);
    expect(
      invoice.body.some((i: { subject: string }) => i.subject === 'Transfer: first account'),
    ).toBe(true);

    const data = await exportFirm(firm);
    const exported = data.tables.invoices as Array<{ content: { subject: string } | null }>;
    expect(exported.some((i) => i.content?.subject === 'Transfer: first account')).toBe(true);
    const costs = data.tables.disbursements as Array<{ description: string }>;
    expect(costs.map((c) => c.description)).toContain('Deeds office fee');
    // Three recorded, one reversed.
    expect((data.tables.invoicePayments as unknown[]).length).toBe(2);
  });
});
