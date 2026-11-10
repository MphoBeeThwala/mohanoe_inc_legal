// Firm subscriptions through PayFast: signatures, checkout, ITN verification,
// renewal, dunning, read-only suspension, seats, cancelling, permissions and
// isolation. PayFast's servers are replaced with a fake (setPayFastNetwork).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../server';
import { db } from '../db/client';
import { firmSubscriptions, platformInvoices, subscriptionPayments } from '../db/schema';
import { issueMissing, vatIncluded } from '../services/platform-invoice.service';
import { createOperator } from '../services/support.service';
import { codeForStep, timeStep } from '../lib/totp';
import { createFirm } from '../services/firm.service';
import { testOutbox } from '../services/mail.service';
import { apiSignature, formSignature, paramString, setPayFastNetwork } from '../services/payfast';
import {
  addInterval,
  checkSubscription,
  effectiveStatus,
  ensureSubscription,
  upsertPlan,
} from '../services/subscription.service';
import { createStaff, defaultFirm, inDefaultFirm, type TestStaff } from './helpers';

const PAYFAST_IP = '197.97.145.144';
const PASSPHRASE = 'jt7NOE43FZPn';
const DAY = 86_400_000;

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
const calls: FakeCall[] = [];
let validateAnswer = 'VALID';

let admin: TestStaff;
let attorney: TestStaff;
let outsider: TestStaff;

function itn(fields: Array<[string, string]>, passphrase = PASSPHRASE): string {
  const signature = formSignature(fields, passphrase);
  return `${paramString(fields)}&signature=${signature}`;
}

/** Any ordinary change in the workspace (a conflict check). */
const write = (name: string) =>
  request(app)
    .post('/api/conflicts')
    .set(attorney.auth)
    .send({ subjects: [{ kind: 'individual', name }], purpose: 'New instruction' });

const notify = (body: string, ip = PAYFAST_IP) =>
  request(app)
    .post('/api/payfast/notify')
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .set('X-Forwarded-For', ip)
    .send(body);

async function setSubscription(values: Partial<typeof firmSubscriptions.$inferInsert>) {
  await inDefaultFirm(async () => {
    const row = await ensureSubscription();
    await db().update(firmSubscriptions).set(values).where(eq(firmSubscriptions.id, row.id));
  });
}

const subscription = () =>
  inDefaultFirm(async () => {
    const [row] = await db().select().from(firmSubscriptions);
    return row!;
  });

/** Starts a checkout as the admin and returns its form fields. */
async function checkout(body: object = { planCode: 'practice', interval: 'monthly', seats: 3 }) {
  const res = await request(app).post('/api/subscription/checkout').set(admin.auth).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    res,
    fields: Object.fromEntries(res.body.fields as Array<[string, string]>) as Record<
      string,
      string
    >,
  };
}

function paymentItn(
  fields: Record<string, string>,
  overrides: Record<string, string> = {},
): Array<[string, string]> {
  const values: Record<string, string> = {
    m_payment_id: fields.m_payment_id!,
    pf_payment_id: `pf-${Math.random().toString(36).slice(2, 10)}`,
    payment_status: 'COMPLETE',
    item_name: fields.item_name!,
    amount_gross: fields.amount!,
    amount_fee: '-12.50',
    amount_net: '0.00',
    custom_str1: fields.custom_str1!,
    name_first: 'Payer',
    email_address: 'payer@example.com',
    merchant_id: '10000100',
    token: 'tok-1111',
    billing_date: '2026-11-09',
    ...overrides,
  };
  return Object.entries(values);
}

beforeAll(async () => {
  process.env.PAYFAST_MERCHANT_ID = '10000100';
  process.env.PAYFAST_MERCHANT_KEY = '46f0cd694581a';
  process.env.PAYFAST_PASSPHRASE = PASSPHRASE;
  process.env.PAYFAST_SANDBOX = 'true';
  process.env.PLATFORM_ADDRESS = '1 Platform Street, Sandton, 2196';
  process.env.PLATFORM_REGISTRATION_NUMBER = '2024/123456/07';
  process.env.PLATFORM_VAT_NUMBER = '4123456789';
  setPayFastNetwork({
    payfastAddresses: async () => new Set([PAYFAST_IP]),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? init.body : '',
      });
      if (url.includes('/eng/query/validate')) {
        return new Response(validateAnswer, { status: 200 });
      }
      return new Response(JSON.stringify({ code: 200, status: 'success' }), { status: 200 });
    }) as typeof fetch,
  });
  admin = await createStaff({ email: 'admin@subs.example', role: 'admin', fullName: 'Ada Admin' });
  attorney = await createStaff({ email: 'attorney@subs.example', role: 'attorney' });
  await upsertPlan({
    code: 'practice',
    name: 'Practice',
    description: 'For small practices',
    monthlySeatPriceCents: 45_000,
    annualSeatPriceCents: 486_000,
    minSeats: 1,
    maxSeats: 25,
  });
});

afterAll(() => {
  setPayFastNetwork(null);
});

beforeEach(() => {
  calls.length = 0;
  validateAnswer = 'VALID';
});

describe('PayFast signatures', () => {
  test('match PayFast’s published algorithm (PHP urlencode, passphrase last)', () => {
    // Independently computed (Python quote_plus + md5).
    expect(
      formSignature(
        [
          ['merchant_id', '10000100'],
          ['merchant_key', '46f0cd694581a'],
          ['amount', '100.00'],
          ['item_name', "Test Item #1 (O'Brien) & co*"],
        ],
        PASSPHRASE,
      ),
    ).toBe('44936e4251dcb7460b5dabd7fdc18ce7');
    expect(
      apiSignature(
        {
          'merchant-id': '10000100',
          version: 'v1',
          timestamp: '2026-11-09T10:00:00+02:00',
          amount: '54000',
        },
        PASSPHRASE,
      ),
    ).toBe('7fa0df2794ffb053688e54d2e604f858');
  });

  test('periods add calendar months and clamp to month ends', () => {
    expect(addInterval(new Date('2026-01-31T10:00:00Z'), 'monthly').toISOString()).toBe(
      '2026-02-28T10:00:00.000Z',
    );
    expect(addInterval(new Date('2028-02-29T10:00:00Z'), 'annual').toISOString()).toBe(
      '2029-02-28T10:00:00.000Z',
    );
  });
});

describe('trial', () => {
  test('a firm starts on a trial that everyone can see in the banner', async () => {
    const res = await request(app).get('/api/subscription/banner').set(attorney.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ effectiveStatus: 'trialing', readOnly: false });
    expect(res.body.daysLeft).toBeGreaterThan(25);
  });

  test('only administrators see plans and manage the subscription', async () => {
    expect((await request(app).get('/api/subscription').set(attorney.auth)).status).toBe(403);
    expect(
      (
        await request(app)
          .post('/api/subscription/checkout')
          .set(attorney.auth)
          .send({ planCode: 'practice', interval: 'monthly', seats: 3 })
      ).status,
    ).toBe(403);
    expect((await request(app).get('/api/subscription/banner')).status).toBe(401);

    const plans = await request(app).get('/api/subscription/plans').set(admin.auth);
    expect(plans.body).toEqual([expect.objectContaining({ code: 'practice', minSeats: 1 })]);
    const status = await request(app).get('/api/subscription').set(admin.auth);
    expect(status.body).toMatchObject({
      state: 'trialing',
      seatsUsed: 2,
      onlinePayments: true,
      vatRate: 0.15,
    });
  });

  test('the trial has a seat allowance', async () => {
    process.env.SUBSCRIPTION_TRIAL_SEATS = '2';
    try {
      const res = await request(app)
        .post('/api/users/invites')
        .set(admin.auth)
        .send({ email: 'third@subs.example', fullName: 'Third', role: 'secretary' });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/trial includes 2/);
    } finally {
      process.env.SUBSCRIPTION_TRIAL_SEATS = '1000';
    }
  });
});

describe('checkout and payment notifications', () => {
  test('checkout returns a signed PayFast subscription form', async () => {
    const { res, fields } = await checkout();
    expect(res.body.action).toBe('https://sandbox.payfast.co.za/eng/process');
    // 3 seats × R450 + 15% VAT.
    expect(res.body.amountCents).toBe(155_250);
    expect(fields).toMatchObject({
      merchant_id: '10000100',
      amount: '1552.50',
      recurring_amount: '1552.50',
      subscription_type: '1',
      frequency: '3',
      cycles: '0',
      custom_str1: (await defaultFirm()).id,
    });
    expect(fields.notify_url).toMatch(/\/api\/payfast\/notify$/);
    // No personal information goes to PayFast from us.
    expect(Object.keys(fields)).not.toContain('email_address');
    const unsigned = (res.body.fields as Array<[string, string]>).filter(
      ([key]) => key !== 'signature',
    );
    expect(fields.signature).toBe(formSignature(unsigned, PASSPHRASE));

    // Seats below what the firm already uses are refused.
    const tooFew = await request(app)
      .post('/api/subscription/checkout')
      .set(admin.auth)
      .send({ planCode: 'practice', interval: 'monthly', seats: 1 });
    expect(tooFew.status).toBe(400);
  });

  test('forged, foreign or unconfirmed notifications change nothing', async () => {
    const { fields } = await checkout();
    const pairs = paymentItn(fields);

    expect((await notify(itn(pairs, 'wrong-passphrase'))).status).toBe(400);
    expect((await notify(itn(pairs), '203.0.113.9')).status).toBe(400);
    const otherMerchant = pairs.map(([k, v]): [string, string] =>
      k === 'merchant_id' ? [k, '99999999'] : [k, v],
    );
    expect((await notify(itn(otherMerchant))).status).toBe(400);
    validateAnswer = 'INVALID';
    expect((await notify(itn(pairs))).status).toBe(400);

    expect((await subscription()).state).toBe('trialing');
  });

  test('a confirmed first payment activates the plan, once', async () => {
    const { fields } = await checkout();
    const body = itn(paymentItn(fields, { pf_payment_id: 'pf-first' }));
    const res = await notify(body);
    expect(res.status, res.text).toBe(200);
    expect(res.text).toBe('activated');
    expect(
      calls.some((call) => call.url === 'https://sandbox.payfast.co.za/eng/query/validate'),
    ).toBe(true);

    expect((await notify(body)).text).toBe('duplicate');
    const row = await subscription();
    expect(row).toMatchObject({
      state: 'active',
      planCode: 'practice',
      seats: 3,
      interval: 'monthly',
      recurringAmountCents: 155_250,
      payfastToken: 'tok-1111',
    });
    expect(row.paidThrough!.getTime()).toBeGreaterThan(Date.now() + 27 * DAY);
    expect(
      testOutbox().some(
        (mail) => mail.to === 'admin@subs.example' && /Subscription confirmed/.test(mail.subject),
      ),
    ).toBe(true);
    // Platform mail, not in the firm's name; no payer details kept.
    const payments = await inDefaultFirm(() => db().select().from(subscriptionPayments));
    expect(payments).toHaveLength(1);
    expect(JSON.stringify(payments)).not.toMatch(/payer/i);

    const status = await request(app).get('/api/subscription').set(admin.auth);
    expect(status.body).toMatchObject({
      effectiveStatus: 'active',
      seats: 3,
      pendingCheckout: false,
    });
    expect(status.body.payments[0]).toMatchObject({ amountCents: 155_250, status: 'complete' });
  });

  test('a payment for the wrong amount is recorded but not applied', async () => {
    const before = await subscription();
    const res = await notify(
      itn(
        paymentItn(
          {
            m_payment_id: 'not-a-checkout',
            item_name: 'x',
            amount: '1.00',
            custom_str1: before.firmId,
          },
          { pf_payment_id: 'pf-odd' },
        ),
      ),
    );
    expect(res.text).toBe('mismatch');
    expect((await subscription()).paidThrough).toEqual(before.paidThrough);
  });

  test('recurring payments extend the paid period', async () => {
    const before = await subscription();
    const res = await notify(
      itn(
        paymentItn(
          {
            m_payment_id: 'recurring',
            item_name: 'Practice subscription',
            amount: '1552.50',
            custom_str1: before.firmId,
          },
          { pf_payment_id: 'pf-second' },
        ),
      ),
    );
    expect(res.text).toBe('renewed');
    const after = await subscription();
    expect(after.paidThrough!.getTime()).toBeGreaterThan(before.paidThrough!.getTime() + 27 * DAY);
  });
});

describe('seats and cancelling', () => {
  test('seat changes update the PayFast amount for the next period', async () => {
    const res = await request(app)
      .patch('/api/subscription/seats')
      .set(admin.auth)
      .send({ seats: 5 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.seats).toBe(5);
    const update = calls.find((call) => call.url.includes('/subscriptions/tok-1111/update'));
    expect(update).toBeDefined();
    expect(update!.method).toBe('PATCH');
    expect(update!.url).toMatch(/\?testing=true$/);
    // 5 × R450 + VAT, in cents.
    expect(JSON.parse(update!.body)).toEqual({ amount: '258750' });
    expect(update!.headers).toMatchObject({ 'merchant-id': '10000100', version: 'v1' });
    expect(update!.headers.signature).toBe(
      apiSignature(
        {
          'merchant-id': '10000100',
          version: 'v1',
          timestamp: update!.headers.timestamp!,
          amount: '258750',
        },
        PASSPHRASE,
      ),
    );
    expect((await subscription()).recurringAmountCents).toBe(258_750);

    const tooFew = await request(app)
      .patch('/api/subscription/seats')
      .set(admin.auth)
      .send({ seats: 1 });
    expect(tooFew.status).toBe(400);
  });

  test('paid seats limit invites', async () => {
    await setSubscription({ seats: 2 });
    const res = await request(app)
      .post('/api/users/invites')
      .set(admin.auth)
      .send({ email: 'extra@subs.example', fullName: 'Extra', role: 'secretary' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/All 2 paid seats/);
    await setSubscription({ seats: 5 });
  });

  test('cancelling stops PayFast billing and keeps access to the end of the period', async () => {
    const res = await request(app).post('/api/subscription/cancel').set(admin.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      state: 'cancelled',
      effectiveStatus: 'cancelled',
      readOnly: false,
    });
    expect(calls.some((call) => call.url.includes('/subscriptions/tok-1111/cancel'))).toBe(true);
  });
});

describe('dunning and read-only mode', () => {
  test('an unpaid period goes past due, then read-only; reads and payment keep working', async () => {
    // The trial ended 3 days ago, never paid.
    await setSubscription({
      state: 'trialing',
      planCode: null,
      seats: null,
      payfastToken: null,
      paidThrough: null,
      cancelledAt: null,
      notices: {},
      trialEndsAt: new Date(Date.now() - 3 * DAY),
    });
    const sent = testOutbox().length;
    const pastDue = await inDefaultFirm(() => checkSubscription());
    expect(pastDue).toMatchObject({ status: 'past_due', changed: true });
    expect(pastDue.emails).toBeGreaterThan(0);
    expect(
      testOutbox()
        .slice(sent)
        .some((mail) => /overdue/.test(mail.subject)),
    ).toBe(true);
    // Each notice once.
    expect((await inDefaultFirm(() => checkSubscription())).emails).toBe(0);
    // Past due still works.
    const client = await write('Grace Period');
    expect(client.status, JSON.stringify(client.body)).toBe(201);

    await setSubscription({ trialEndsAt: new Date(Date.now() - 30 * DAY) });
    expect((await inDefaultFirm(() => checkSubscription())).status).toBe('suspended');

    const blocked = await write('Read Only');
    expect(blocked.status).toBe(402);
    expect(blocked.body.code).toBe('subscription_suspended');
    expect((await request(app).get('/api/conflicts').set(attorney.auth)).status).toBe(200);
    const banner = await request(app).get('/api/subscription/banner').set(attorney.auth);
    expect(banner.body).toMatchObject({ effectiveStatus: 'suspended', readOnly: true });
    // Signing out and paying are always possible.
    const { fields } = await checkout();
    const paid = await notify(
      itn(paymentItn(fields, { pf_payment_id: 'pf-restore', token: 'tok-2222' })),
    );
    expect(paid.text).toBe('activated');
    const unblocked = await write('Back Again');
    expect(unblocked.status).toBe(201);
  });

  test('complimentary access has no end unless one is set', async () => {
    const row = await inDefaultFirm(() => ensureSubscription());
    expect(effectiveStatus({ ...row, state: 'complimentary', paidThrough: null })).toBe(
      'complimentary',
    );
    expect(
      effectiveStatus({
        ...row,
        state: 'complimentary',
        paidThrough: new Date(Date.now() - 60 * DAY),
      }),
    ).toBe('suspended');
  });
});

describe('isolation', () => {
  test('a firm never sees or pays into another firm’s subscription', async () => {
    const other = await createFirm({
      slug: 'subs-other',
      legalName: 'Other Subs Inc',
      domains: ['portal.subs-other.test'],
    });
    outsider = await createStaff({
      email: 'admin@subs-other.example',
      role: 'admin',
      firm: other,
      host: 'portal.subs-other.test',
    });
    const status = await request(app)
      .get('/api/subscription')
      .set('Host', 'portal.subs-other.test')
      .set(outsider.auth);
    expect(status.body).toMatchObject({ state: 'trialing', payments: [], seatsUsed: 1 });

    // A notification naming the other firm with our checkout id finds nothing there.
    const { fields } = await checkout();
    const res = await notify(
      itn(paymentItn({ ...fields, custom_str1: other.id }, { pf_payment_id: 'pf-cross' })),
    );
    expect(res.text).toBe('mismatch');
    const otherStatus = await request(app)
      .get('/api/subscription')
      .set('Host', 'portal.subs-other.test')
      .set(outsider.auth);
    expect(otherStatus.body.state).toBe('trialing');
  });
});

describe('the platform’s invoices to the firm', () => {
  test('each confirmed payment gets a tax invoice with the VAT Act particulars', async () => {
    const res = await request(app).get('/api/subscription/invoices').set(admin.auth);
    expect(res.status).toBe(200);
    const complete = (await inDefaultFirm(() => db().select().from(subscriptionPayments))).filter(
      (p) => p.status === 'complete',
    );
    // One per confirmed payment, none for the mismatched ones; one gap-free series.
    expect(res.body).toHaveLength(complete.length);
    expect(res.body.map((i: { number: string }) => i.number).sort()).toEqual(
      complete.map((_, n) => `PI-${String(n + 1).padStart(6, '0')}`),
    );
    const first = res.body.find(
      (i: { paymentReference: string }) => i.paymentReference === 'pf-first',
    );
    expect(first).toMatchObject({
      taxInvoice: true,
      totalCents: 155_250,
      vatCents: 20_250,
      exclusiveCents: 135_000,
      vatRate: 0.15,
      supplier: {
        address: '1 Platform Street, Sandton, 2196',
        vatNumber: '4123456789',
        registrationNumber: '2024/123456/07',
      },
      recipient: { name: (await defaultFirm()).legalName },
    });
    expect(first.lines[0]).toMatchObject({ quantity: 3, amountCents: 135_000 });
    expect(first.lines[0].description).toMatch(/Practice subscription: 3 seats, billed monthly/);
  });

  test('administrators are emailed the PDF, and can download it', async () => {
    const mail = testOutbox().find((m) => /^Tax invoice PI-000001/.test(m.subject));
    expect(mail?.to).toBe('admin@subs.example');
    expect(mail?.attachments?.[0]).toMatchObject({
      filename: 'PI-000001.pdf',
      contentType: 'application/pdf',
    });
    const list = await request(app).get('/api/subscription/invoices').set(admin.auth);
    const pdf = await request(app)
      .get(`/api/subscription/invoices/${list.body[0].id}/pdf`)
      .set(admin.auth)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect((await request(app).get('/api/subscription/invoices').set(attorney.auth)).status).toBe(
      403,
    );
  });

  test('firms read their invoices but can never write them', async () => {
    await inDefaultFirm(async () => {
      const [row] = await db().select().from(platformInvoices).limit(1);
      await expect(
        db()
          .update(platformInvoices)
          .set({ totalCents: 1 })
          .where(eq(platformInvoices.id, row!.id)),
      ).rejects.toThrow();
    });
  });

  test('a payment left without an invoice is caught up; without a VAT number it is a plain invoice', async () => {
    const saved = process.env.PLATFORM_VAT_NUMBER;
    delete process.env.PLATFORM_VAT_NUMBER;
    try {
      await inDefaultFirm(() =>
        db()
          .insert(subscriptionPayments)
          .values({ pfPaymentId: 'pf-missed', amountCents: 155_250, status: 'complete' }),
      );
      expect(await issueMissing()).toEqual({ issued: 1, failed: 0 });
      expect(await issueMissing()).toEqual({ issued: 0, failed: 0 });
      const list = await request(app).get('/api/subscription/invoices').set(admin.auth);
      const missed = list.body.find(
        (i: { paymentReference: string }) => i.paymentReference === 'pf-missed',
      );
      expect(missed).toMatchObject({ taxInvoice: false, vatCents: 0, exclusiveCents: 155_250 });
    } finally {
      process.env.PLATFORM_VAT_NUMBER = saved;
    }
  });

  test('VAT is the tax fraction of the inclusive amount', () => {
    expect(vatIncluded(115_00, 0.15)).toBe(15_00);
    expect(vatIncluded(155_250, 0.15)).toBe(20_250);
    expect(vatIncluded(1_00, 0)).toBe(0);
  });

  test('another firm sees none of them', async () => {
    const res = await request(app)
      .get('/api/subscription/invoices')
      .set('Host', 'portal.subs-other.test')
      .set(outsider.auth);
    expect(res.body).toEqual([]);
  });

  test('operators see every firm’s invoices in the console', async () => {
    process.env.PLATFORM_CONSOLE_HOST = 'console.subs.test';
    const op = await createOperator({ email: 'ops@subs.example', fullName: 'Ops' });
    const signIn = await request(app)
      .post('/api/platform/sign-in')
      .set('Host', 'console.subs.test')
      .set('Origin', 'https://console.subs.test')
      .send({ email: op.email, password: op.password, code: codeForStep(op.secret, timeStep()) });
    const cookie = String(signIn.headers['set-cookie'] ?? '').split(';')[0]!;
    const list = await request(app)
      .get('/api/platform/invoices')
      .set('Host', 'console.subs.test')
      .set('Cookie', cookie);
    expect(list.status).toBe(200);
    const firm = await defaultFirm();
    expect(list.body.length).toBeGreaterThan(0);
    console.log(
      'SLUGS',
      firm.slug,
      JSON.stringify(list.body.map((i: any) => [i.firmSlug, i.number, i.paymentReference])),
    );
    expect(list.body.every((i: { firmSlug: string }) => i.firmSlug === firm.slug)).toBe(true);
    const pdf = await request(app)
      .get(`/api/platform/invoices/${firm.id}/${list.body[0].id}/pdf`)
      .set('Host', 'console.subs.test')
      .set('Cookie', cookie);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    // Not from a firm's address.
    expect((await request(app).get('/api/platform/invoices').set('Cookie', cookie)).status).toBe(
      404,
    );
  });
});
