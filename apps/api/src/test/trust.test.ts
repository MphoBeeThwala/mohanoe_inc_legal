// Trust accounting: feature flag, permissions, no debit balances, four-eyes
// authorisation, fee transfers against invoices, reversals, reconciliation
// and sign-off, restricted matters, isolation.
import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../server';
import { rootDb } from '../db/client';
import { firms } from '../db/schema';
import { clearFirmCache, createFirm } from '../services/firm.service';
import { createStaff, defaultFirm, type TestStaff } from './helpers';

let admin: TestStaff;
let attorney: TestStaff;
let partner: TestStaff;
let bookkeeper: TestStaff;
let secretary: TestStaff;
let accountId = '';
let matterA: { id: string; caseNumber: string };
let matterB: { id: string; caseNumber: string };

async function openMatter(name: string, title: string) {
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
    .send({ kind: 'individual', details: { name }, conflictCheckId: check.body.id });
  const opened = await request(app).post('/api/cases').set(attorney.auth).send({
    clientId: client.body.id,
    conflictCheckId: check.body.id,
    title,
    practiceArea: 'Property',
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  return opened.body as { id: string; caseNumber: string };
}

const post = (staff: TestStaff, path: string, body: object = {}) =>
  request(app).post(`/api/trust${path}`).set(staff.auth).send(body);
const balanceOf = async (matter: { id: string }) =>
  (
    await request(app)
      .get(`/api/trust/accounts/${accountId}/ledger?matter=${matter.id}`)
      .set(bookkeeper.auth)
  ).body.balanceCents as number;

beforeAll(async () => {
  admin = await createStaff({ email: 'admin@trust.example', role: 'admin' });
  attorney = await createStaff({ email: 'attorney@trust.example', role: 'attorney' });
  partner = await createStaff({ email: 'partner@trust.example', role: 'attorney' });
  bookkeeper = await createStaff({ email: 'books@trust.example', role: 'bookkeeper' });
  secretary = await createStaff({ email: 'desk@trust.example', role: 'secretary' });
  matterA = await openMatter('Sipho Ndlovu', 'Sale of erf 55');
  matterB = await openMatter('Naledi Khumalo', 'Purchase of erf 56');
});

describe('switching on', () => {
  test('trust accounting is off until the platform enables it for the firm', async () => {
    expect((await request(app).get('/api/trust/accounts').set(bookkeeper.auth)).status).toBe(404);
    const firm = await defaultFirm();
    await rootDb()
      .update(firms)
      .set({
        features: { trustAccounting: true },
        vatNumber: '4123456789',
        billingSettings: { address: '1 Main Road, Pretoria' },
      })
      .where(eq(firms.id, firm.id));
    clearFirmCache();
    expect((await request(app).get('/api/trust/status').set(bookkeeper.auth)).body).toEqual({
      enabled: true,
    });
  });

  test('practitioners add trust accounts; the number is kept encrypted, only the last digits shown', async () => {
    expect(
      (
        await post(bookkeeper, '/accounts', {
          name: 'Trust',
          bankName: 'Bank',
          accountNumber: '62000000001',
        })
      ).status,
    ).toBe(403);
    const created = await post(admin, '/accounts', {
      name: 'Trust account',
      bankName: 'Example Bank',
      accountNumber: '6200 0000 0012',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ kind: 'trust', accountLast4: '0012', balanceCents: 0 });
    expect(JSON.stringify(created.body)).not.toContain('62000000');
    accountId = created.body.id;
    expect((await request(app).get('/api/trust/accounts').set(secretary.auth)).status).toBe(403);
  });
});

describe('receipts, payments and authorisation', () => {
  test('receipts post at once', async () => {
    const receipt = await post(bookkeeper, '/receipts', {
      accountId,
      caseRef: matterA.id,
      amount: 100_000,
      reference: 'EFT NDLOVU DEPOSIT',
      description: 'Deposit on sale',
    });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    expect(receipt.body).toMatchObject({
      status: 'posted',
      amountCents: 10_000_000,
      kind: 'receipt',
    });
    expect(await balanceOf(matterA)).toBe(10_000_000);
  });

  test('a matter can never pay out more than it holds', async () => {
    const tooMuch = await post(bookkeeper, '/payments', {
      accountId,
      caseRef: matterA.id,
      amount: 100_000.01,
      description: 'Transfer duty',
    });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.message).toMatch(/never go into debit/);
    // Matter B holds nothing: no payment from it, even though the account holds money.
    expect(
      (
        await post(bookkeeper, '/payments', {
          accountId,
          caseRef: matterB.id,
          amount: 1,
          description: 'x',
        })
      ).status,
    ).toBe(409);
  });

  test('payments wait for a practitioner other than the requester', async () => {
    const payment = await post(bookkeeper, '/payments', {
      accountId,
      caseRef: matterA.id,
      amount: 30_000,
      reference: 'SARS',
      description: 'Transfer duty',
    });
    expect(payment.body.status).toBe('pending');
    expect(await balanceOf(matterA)).toBe(10_000_000);
    // The bookkeeper can't authorise; nor can the person who asked.
    expect((await post(bookkeeper, `/entries/${payment.body.id}/authorise`)).status).toBe(403);
    // An admin may both request and authorise, but never their own request.
    const ownRequest = await post(admin, '/payments', {
      accountId,
      caseRef: matterA.id,
      amount: 10,
      description: 'Courier',
    });
    expect(ownRequest.status).toBe(201);
    expect((await post(admin, `/entries/${ownRequest.body.id}/authorise`)).status).toBe(403);
    await post(partner, `/entries/${ownRequest.body.id}/reject`, { reason: 'Not ours' }).expect(
      200,
    );

    const authorised = await post(attorney, `/entries/${payment.body.id}/authorise`);
    expect(authorised.status, JSON.stringify(authorised.body)).toBe(200);
    expect(authorised.body).toMatchObject({ status: 'posted', authorisedBy: attorney.id });
    expect(await balanceOf(matterA)).toBe(7_000_000);
  });

  test('two pending payments can’t together take a ledger into debit', async () => {
    const first = await post(bookkeeper, '/payments', {
      accountId,
      caseRef: matterA.id,
      amount: 50_000,
      description: 'Bond cancellation',
    });
    const second = await post(bookkeeper, '/payments', {
      accountId,
      caseRef: matterA.id,
      amount: 50_000,
      description: 'Seller proceeds',
    });
    await post(attorney, `/entries/${first.body.id}/authorise`).expect(200);
    const blocked = await post(attorney, `/entries/${second.body.id}/authorise`);
    expect(blocked.status).toBe(409);
    expect(await balanceOf(matterA)).toBe(2_000_000);
    await post(attorney, `/entries/${second.body.id}/reject`, { reason: 'Insufficient' }).expect(
      200,
    );
  });

  test('matter-to-matter transfers move both legs together on one authorisation', async () => {
    const transfer = await post(bookkeeper, '/transfers', {
      accountId,
      caseRef: matterA.id,
      toCaseRef: matterB.id,
      amount: 5_000,
      description: 'Client instruction: apply to purchase',
    });
    expect(transfer.status, JSON.stringify(transfer.body)).toBe(201);
    const pending = (await request(app).get('/api/trust/pending').set(attorney.auth)).body;
    expect(
      pending.filter((e: { groupId: string }) => e.groupId === transfer.body.groupId),
    ).toHaveLength(1);
    await post(attorney, `/entries/${transfer.body.id}/authorise`).expect(200);
    expect(await balanceOf(matterA)).toBe(1_500_000);
    expect(await balanceOf(matterB)).toBe(500_000);
  });
});

describe('fees, reversals and reconciliation', () => {
  test('fee transfers only against an issued invoice on the matter, and they settle it', async () => {
    await request(app)
      .post('/api/billing/disbursements')
      .set(attorney.auth)
      .send({ caseRef: matterA.id, description: 'Deeds office fee', amount: 2_000, vatable: false })
      .expect(201);
    const draft = await request(app)
      .post('/api/billing/invoices')
      .set(attorney.auth)
      .send({ caseRef: matterA.id, subject: 'Transfer costs' });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const early = await post(bookkeeper, '/fee-transfers', {
      accountId,
      caseRef: matterA.id,
      invoiceId: draft.body.id,
      amount: 2_000,
    });
    expect(early.status).toBe(409);
    const issued = await request(app)
      .post(`/api/billing/invoices/${draft.body.id}/issue`)
      .set(attorney.auth)
      .send({});
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(
      (
        await post(bookkeeper, '/fee-transfers', {
          accountId,
          caseRef: matterB.id,
          invoiceId: draft.body.id,
          amount: 2_000,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(bookkeeper, '/fee-transfers', {
          accountId,
          caseRef: matterA.id,
          invoiceId: draft.body.id,
          amount: 2_000.01,
        })
      ).status,
    ).toBe(400);
    const fee = await post(bookkeeper, '/fee-transfers', {
      accountId,
      caseRef: matterA.id,
      invoiceId: draft.body.id,
      amount: 2_000,
    });
    expect(fee.body).toMatchObject({ kind: 'transfer_to_business', status: 'pending' });
    const posted = await post(attorney, `/entries/${fee.body.id}/authorise`);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.invoiceNumber).toMatch(/^INV-\d+$/);
    const invoice = await request(app)
      .get(`/api/billing/invoices/${draft.body.id}`)
      .set(attorney.auth);
    expect(invoice.body.status).toBe('paid');
    expect(await balanceOf(matterA)).toBe(1_300_000);
  });

  test('a posted entry is corrected by an authorised reversal, once', async () => {
    const wrong = await post(bookkeeper, '/receipts', {
      accountId,
      caseRef: matterB.id,
      amount: 1_234,
      reference: 'DUPLICATE',
      description: 'Captured twice',
    });
    const reversal = await post(bookkeeper, `/entries/${wrong.body.id}/reverse`, {
      reason: 'Duplicate capture',
    });
    expect(reversal.status, JSON.stringify(reversal.body)).toBe(201);
    expect(reversal.body).toMatchObject({
      kind: 'reversal',
      amountCents: -123_400,
      status: 'pending',
    });
    expect(
      (await post(bookkeeper, `/entries/${wrong.body.id}/reverse`, { reason: 'Again' })).status,
    ).toBe(409);
    await post(attorney, `/entries/${reversal.body.id}/authorise`).expect(200);
    expect(await balanceOf(matterB)).toBe(500_000);
    const ledger = await request(app)
      .get(`/api/trust/accounts/${accountId}/ledger?matter=${matterB.id}`)
      .set(attorney.auth);
    const original = ledger.body.entries.find((e: { id: string }) => e.id === wrong.body.id);
    expect(original).toMatchObject({
      status: 'posted',
      reversedBy: reversal.body.id,
      reference: 'DUPLICATE',
    });
  });

  test('reconciliation: statement vs cash book vs client ledgers, signed off by someone else', async () => {
    const ledgers = await request(app)
      .get(`/api/trust/accounts/${accountId}/balances`)
      .set(bookkeeper.auth);
    const total = ledgers.body.reduce(
      (n: number, l: { balanceCents: number }) => n + l.balanceCents,
      0,
    );
    expect(total).toBe(1_800_000);

    const today = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
    // Nothing matched to the statement yet: every receipt and payment is uncleared.
    const unbalanced = await post(bookkeeper, `/accounts/${accountId}/reconciliations`, {
      periodEnd: today,
      bankBalance: 0,
    });
    expect(unbalanced.status, JSON.stringify(unbalanced.body)).toBe(201);
    expect(unbalanced.body).toMatchObject({
      cashbookCents: 1_800_000,
      ledgerDifferenceCents: 0,
      debitLedgers: 0,
    });
    expect(unbalanced.body.differenceCents).toBe(0);

    // Match everything to a statement showing R18 000.
    const all = (
      await request(app)
        .get(`/api/trust/accounts/${accountId}/ledger?matter=${matterA.id}`)
        .set(bookkeeper.auth)
    ).body.entries
      .concat(
        (
          await request(app)
            .get(`/api/trust/accounts/${accountId}/ledger?matter=${matterB.id}`)
            .set(bookkeeper.auth)
        ).body.entries,
      )
      .filter(
        (e: { status: string; groupId: string | null }) => e.status === 'posted' && !e.groupId,
      )
      .map((e: { id: string }) => e.id);
    await post(bookkeeper, '/clear', { entryIds: all, clearedOn: today }).expect(200);
    const off = await post(bookkeeper, `/accounts/${accountId}/reconciliations`, {
      periodEnd: today,
      bankBalance: 17_990,
    });
    expect(off.body).toMatchObject({ differenceCents: -1_000, balanced: false });
    expect((await post(attorney, `/reconciliations/${off.body.id}/sign-off`)).status).toBe(400);

    const ok = await post(bookkeeper, `/accounts/${accountId}/reconciliations`, {
      periodEnd: today,
      bankBalance: 18_000,
    });
    expect(ok.body).toMatchObject({
      balanced: true,
      unclearedReceiptsCents: 0,
      unclearedPaymentsCents: 0,
    });
    expect((await post(bookkeeper, `/reconciliations/${ok.body.id}/sign-off`)).status).toBe(403);
    const signed = await post(attorney, `/reconciliations/${ok.body.id}/sign-off`);
    expect(signed.body).toMatchObject({ signedOffBy: attorney.id });

    const csv = await request(app)
      .get(`/api/trust/accounts/${accountId}/cashbook.csv?from=2000-01-01&to=${today}`)
      .set(attorney.auth);
    expect(csv.status).toBe(200);
    expect(csv.text.split('\n')[0]).toBe(
      'date,matter,kind,amount,reference,description,cleared_on,entry_id',
    );
    expect(csv.text).toContain(`${matterA.caseNumber},receipt,100000.00,EFT NDLOVU DEPOSIT`);
  });
});

describe('restricted matters and other firms', () => {
  test('restricted matters stay hidden but still count in balances and reconciliation', async () => {
    const restricted = await openMatter('Thabo Restricted', 'Confidential sale');
    await post(bookkeeper, '/receipts', {
      accountId,
      caseRef: restricted.id,
      amount: 1_000,
      reference: 'SECRET REF',
      description: 'Confidential deposit',
    }).expect(201);
    await request(app)
      .put(`/api/cases/${restricted.id}/access`)
      .set(attorney.auth)
      .send({ access: 'restricted' })
      .expect((res) => expect(res.status).toBeLessThan(300));

    const lines = (
      await request(app).get(`/api/trust/accounts/${accountId}/balances`).set(bookkeeper.auth)
    ).body;
    expect(lines.map((l: { caseNumber: string }) => l.caseNumber)).not.toContain(
      restricted.caseNumber,
    );
    const accounts = (await request(app).get('/api/trust/accounts').set(bookkeeper.auth)).body;
    expect(accounts[0].balanceCents).toBe(1_900_000);
    const today = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
    const rec = await post(bookkeeper, `/accounts/${accountId}/reconciliations`, {
      periodEnd: today,
      bankBalance: 18_000,
    });
    expect(rec.body).toMatchObject({
      cashbookCents: 1_900_000,
      unclearedReceiptsCents: 100_000,
      balanced: true,
    });

    const csv = await request(app)
      .get(`/api/trust/accounts/${accountId}/cashbook.csv?from=2000-01-01&to=${today}`)
      .set(partner.auth);
    expect(csv.text).toContain('Restricted matter,receipt,1000.00,,');
    expect(csv.text).not.toContain('SECRET REF');
  });

  test('another firm sees none of it', async () => {
    const other = await createFirm({
      slug: 'trust-other',
      legalName: 'Other Trust Inc',
      domains: ['portal.trust-other.test'],
    });
    await rootDb()
      .update(firms)
      .set({ features: { trustAccounting: true } })
      .where(eq(firms.id, other.id));
    clearFirmCache();
    const outsider = await createStaff({
      email: 'admin@trust-other.example',
      role: 'admin',
      firm: other,
      host: 'portal.trust-other.test',
    });
    const host = 'portal.trust-other.test';
    expect(
      (await request(app).get('/api/trust/accounts').set('Host', host).set(outsider.auth)).body,
    ).toEqual([]);
    expect(
      (
        await request(app)
          .get(`/api/trust/accounts/${accountId}/balances`)
          .set('Host', host)
          .set(outsider.auth)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post('/api/trust/receipts')
          .set('Host', host)
          .set(outsider.auth)
          .send({ accountId, caseRef: matterA.id, amount: 1, description: 'x' })
      ).status,
    ).toBe(404);
  });
});
