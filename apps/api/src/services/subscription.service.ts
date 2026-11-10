// The firm's subscription to the platform: trial, plans, seats, PayFast
// payments, dunning and read-only suspension.
//
// Lifecycle (effectiveStatus): a new firm starts a trial. Subscribing through
// PayFast makes it active until the end of the paid period; each confirmed
// recurring payment extends it. Once the trial or paid period has run out
// (plus a short leeway for the recurring charge to arrive) the firm is
// past_due, with full access and reminders; after SUBSCRIPTION_GRACE_DAYS it
// is suspended: read-only, so the firm can still read and export its records
// but changes nothing until it pays. Cancelling keeps access to the end of
// the paid period.
import { and, asc, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import {
  subscriptionPriceCents,
  type SubscriptionBanner,
  type SubscriptionCheckout,
  type SubscriptionInterval,
  type SubscriptionPayment,
  type SubscriptionPlan,
  type SubscriptionState,
  type SubscriptionStatus,
} from '@ahava88/shared';
import { db, rootDb } from '../db/client';
import { withTenant } from '../db/tenant';
import { afterCommit, currentFirm } from '../db/tenant-context';
import {
  firms,
  firmSubscriptions,
  invites,
  subscriptionCheckouts,
  subscriptionPayments,
  subscriptionPlans,
  users,
  type FirmSubscriptionRow,
  type SubscriptionPlanRow,
} from '../db/schema';
import { httpError } from '../lib/http';
import { isUuid } from '../lib/ids';
import { SYSTEM_ACTOR, type Actor } from '../lib/actor';
import { iso, isoOrNull, localDate } from '../lib/time';
import {
  parse,
  subscriptionCheckoutSchema,
  subscriptionPlanSchema,
  subscriptionSeatsSchema,
} from '../validation/schemas';
import { findFirmById, firmOrigin } from './firm.service';
import { sendMail } from './mail.service';
import * as platformInvoices from './platform-invoice.service';
import * as payfast from './payfast';
import * as auditService from './audit.service';

const DAY = 86_400_000;

function numberEnv(name: string, fallback: number, min = 0): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

export const subscriptionSettings = () => ({
  trialDays: numberEnv('SUBSCRIPTION_TRIAL_DAYS', 30, 1),
  graceDays: numberEnv('SUBSCRIPTION_GRACE_DAYS', 7, 0),
  trialSeats: numberEnv('SUBSCRIPTION_TRIAL_SEATS', 10, 1),
  /** VAT the platform charges firms (0 if Ahava on 88 is not VAT-registered). */
  vatRate: numberEnv('PLATFORM_VAT_RATE', 0.15, 0),
});

/** Recurring charges can land a little after the period ends. */
const PAYMENT_LEEWAY_DAYS = 2;

const SYSTEM: Actor = { ...SYSTEM_ACTOR, fullName: 'Subscriptions' };

// --------------------------------------------------------------------- state

export async function ensureSubscription(now = new Date()): Promise<FirmSubscriptionRow> {
  const [existing] = await db().select().from(firmSubscriptions).limit(1);
  if (existing) {
    return existing;
  }
  await db()
    .insert(firmSubscriptions)
    .values({
      state: 'trialing',
      trialEndsAt: new Date(now.getTime() + subscriptionSettings().trialDays * DAY),
    })
    .onConflictDoNothing();
  const [created] = await db().select().from(firmSubscriptions).limit(1);
  if (!created) {
    throw new Error('Subscription was not stored');
  }
  return created;
}

/** The date access is paid (or free) until; null = open-ended complimentary. */
export function periodEnd(row: FirmSubscriptionRow): Date | null {
  if (row.state === 'complimentary') {
    return row.paidThrough;
  }
  // Never paid: the trial's end.
  return row.paidThrough ?? row.trialEndsAt;
}

export function effectiveStatus(row: FirmSubscriptionRow, now = new Date()): SubscriptionState {
  const end = periodEnd(row);
  if (!end) {
    return row.state === 'complimentary' ? 'complimentary' : 'suspended';
  }
  const leeway = row.payfastToken && row.state !== 'cancelled' ? PAYMENT_LEEWAY_DAYS : 0;
  const time = now.getTime();
  if (time <= end.getTime() + leeway * DAY) {
    return row.state === 'trialing' || row.state === 'complimentary' || row.state === 'cancelled'
      ? (row.state as SubscriptionState)
      : 'active';
  }
  if (time <= end.getTime() + subscriptionSettings().graceDays * DAY) {
    return 'past_due';
  }
  return 'suspended';
}

export function bannerFor(row: FirmSubscriptionRow, now = new Date()): SubscriptionBanner {
  const effective = effectiveStatus(row, now);
  const end = periodEnd(row);
  return {
    effectiveStatus: effective,
    readOnly: effective === 'suspended',
    paidThrough: isoOrNull(end),
    suspendsAt: end ? iso(new Date(end.getTime() + subscriptionSettings().graceDays * DAY)) : null,
    daysLeft: end ? Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY)) : null,
  };
}

export async function banner(): Promise<SubscriptionBanner> {
  return bannerFor(await ensureSubscription());
}

// --------------------------------------------------------------------- seats

/** Active staff plus pending invites; platform support is never counted. */
export async function seatsUsed(now = new Date()): Promise<number> {
  const [staff] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.isActive, true), ne(users.role, 'support')));
  const [pending] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(invites)
    .where(and(isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, now)));
  return (staff?.count ?? 0) + (pending?.count ?? 0);
}

function seatLimit(row: FirmSubscriptionRow): number | null {
  if (row.state === 'complimentary') return row.seats;
  // Never subscribed (in or after the trial): the trial's allowance.
  if (!row.planCode) return subscriptionSettings().trialSeats;
  return row.seats;
}

/** Before adding a member (invite or reactivation). */
export async function assertSeatAvailable(): Promise<void> {
  const row = await ensureSubscription();
  const limit = seatLimit(row);
  if (limit === null) {
    return;
  }
  const used = await seatsUsed();
  if (used + 1 > limit) {
    throw httpError(
      !row.planCode && row.state !== 'complimentary'
        ? `The trial includes ${limit} staff members. Choose a plan under Account → Subscription to add more.`
        : `All ${limit} paid seats are in use. An administrator can add seats under Account → Subscription.`,
      409,
    );
  }
}

// --------------------------------------------------------------------- plans

const toPlan = (row: SubscriptionPlanRow): SubscriptionPlan => ({
  code: row.code,
  name: row.name,
  description: row.description,
  monthlySeatPriceCents: row.monthlySeatPriceCents,
  annualSeatPriceCents: row.annualSeatPriceCents,
  minSeats: row.minSeats,
  maxSeats: row.maxSeats,
});

export async function listPlans(): Promise<SubscriptionPlan[]> {
  const rows = await db()
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.isActive, true))
    .orderBy(asc(subscriptionPlans.sortOrder), asc(subscriptionPlans.code));
  return rows.map(toPlan);
}

async function requirePlan(code: string): Promise<SubscriptionPlanRow> {
  const [plan] = await db()
    .select()
    .from(subscriptionPlans)
    .where(and(eq(subscriptionPlans.code, code), eq(subscriptionPlans.isActive, true)));
  if (!plan) {
    throw httpError('That plan is not available', 400);
  }
  return plan;
}

function checkSeats(plan: SubscriptionPlanRow, seats: number, used: number): void {
  if (seats < plan.minSeats) {
    throw httpError(`The ${plan.name} plan starts at ${plan.minSeats} seats`, 400);
  }
  if (plan.maxSeats !== null && seats > plan.maxSeats) {
    throw httpError(`The ${plan.name} plan allows up to ${plan.maxSeats} seats`, 400);
  }
  if (seats < used) {
    throw httpError(
      `${used} staff members and pending invites use seats. Choose at least ${used}, or deactivate staff first.`,
      400,
    );
  }
}

/** Platform administration (ops CLI): add or change a plan. */
export async function upsertPlan(input: unknown): Promise<SubscriptionPlanRow> {
  const plan = parse(subscriptionPlanSchema, input);
  const values = {
    name: plan.name,
    description: plan.description ?? '',
    monthlySeatPriceCents: plan.monthlySeatPriceCents,
    annualSeatPriceCents: plan.annualSeatPriceCents,
    minSeats: plan.minSeats,
    maxSeats: plan.maxSeats ?? null,
    sortOrder: plan.sortOrder,
    isActive: true,
    updatedAt: new Date(),
  };
  const [saved] = await rootDb()
    .insert(subscriptionPlans)
    .values({ code: plan.code, ...values })
    .onConflictDoUpdate({ target: subscriptionPlans.code, set: values })
    .returning();
  return saved!;
}

export async function listAllPlans(): Promise<SubscriptionPlanRow[]> {
  return rootDb().select().from(subscriptionPlans).orderBy(asc(subscriptionPlans.sortOrder));
}

/** Retires a plan for new checkouts; firms already on it keep it. */
export async function disablePlan(code: string): Promise<boolean> {
  const rows = await rootDb()
    .update(subscriptionPlans)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(subscriptionPlans.code, code))
    .returning({ code: subscriptionPlans.code });
  return rows.length > 0;
}

// -------------------------------------------------------------------- status

export async function getStatus(): Promise<SubscriptionStatus> {
  const row = await ensureSubscription();
  const [plan] = row.planCode
    ? await db().select().from(subscriptionPlans).where(eq(subscriptionPlans.code, row.planCode))
    : [];
  const [pending] = await db()
    .select({ id: subscriptionCheckouts.id })
    .from(subscriptionCheckouts)
    .where(
      and(
        eq(subscriptionCheckouts.status, 'pending'),
        gt(subscriptionCheckouts.createdAt, new Date(Date.now() - DAY)),
      ),
    )
    .limit(1);
  const payments = await db()
    .select()
    .from(subscriptionPayments)
    .orderBy(desc(subscriptionPayments.paidAt))
    .limit(24);
  return {
    ...bannerFor(row),
    state: row.state as SubscriptionState,
    planCode: row.planCode,
    planName: plan?.name ?? row.planCode,
    interval: (row.interval as SubscriptionInterval | null) ?? null,
    seats: seatLimit(row),
    seatsUsed: await seatsUsed(),
    recurringAmountCents: row.recurringAmountCents,
    cancelledAt: isoOrNull(row.cancelledAt),
    pendingCheckout: Boolean(pending),
    payments: payments.map((p): SubscriptionPayment => ({
      id: p.id,
      amountCents: p.amountCents,
      status: p.status as SubscriptionPayment['status'],
      paidAt: iso(p.paidAt),
      reference: p.pfPaymentId,
    })),
    vatRate: subscriptionSettings().vatRate,
    onlinePayments: payfast.payfastConfig() !== null,
  };
}

// ------------------------------------------------------------------ checkout

export async function startCheckout(input: unknown, actor: Actor): Promise<SubscriptionCheckout> {
  const config = payfast.requirePayfast();
  const request = parse(subscriptionCheckoutSchema, input);
  const plan = await requirePlan(request.planCode);
  checkSeats(plan, request.seats, await seatsUsed());
  const amountCents = subscriptionPriceCents(
    plan,
    request.interval,
    request.seats,
    subscriptionSettings().vatRate,
  );
  if (amountCents <= 0) {
    throw httpError('That plan has no price set', 400);
  }

  const [checkout] = await db()
    .insert(subscriptionCheckouts)
    .values({
      planCode: plan.code,
      interval: request.interval,
      seats: request.seats,
      amountCents,
      createdBy: actor.userId ?? null,
    })
    .returning();
  const firm = currentFirm();
  const origin = firmOrigin(firm);
  const period = request.interval === 'annual' ? 'year' : 'month';
  const fields = payfast.checkoutFields(config, {
    paymentId: checkout!.id,
    amountCents,
    itemName: `${plan.name} subscription`,
    itemDescription: `${request.seats} seat${request.seats === 1 ? '' : 's'}, billed every ${period}`,
    billingDate: localDate(),
    frequency: request.interval,
    returnUrl: `${origin}/?subscription=return`,
    cancelUrl: `${origin}/?subscription=cancelled`,
    notifyUrl: `${origin}/api/payfast/notify`,
    firmId: firm.id,
  });

  await auditService.logEventSafely(
    {
      entityType: 'subscription',
      entityId: checkout!.id,
      action: 'subscription_checkout_started',
      summary: `Subscription checkout started (${plan.code}, ${request.seats} seats, ${request.interval})`,
      details: {
        planCode: plan.code,
        seats: request.seats,
        interval: request.interval,
        amountCents,
      },
    },
    actor,
  );
  return { action: payfast.processUrl(config), fields, amountCents };
}

// ----------------------------------------------------------------------- ITN

export function addInterval(from: Date, interval: SubscriptionInterval): Date {
  const next = new Date(from.getTime());
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + (interval === 'annual' ? 12 : 1));
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

export interface ItnResult {
  outcome: 'activated' | 'renewed' | 'cancelled' | 'failed' | 'duplicate' | 'mismatch' | 'ignored';
}

/** Handles a notification already verified with payfast.verifyItn(). */
async function applyItn(fields: Record<string, string>, now: Date): Promise<ItnResult> {
  const status = (fields.payment_status || '').toUpperCase();
  const token = fields.token || '';
  const pfPaymentId = fields.pf_payment_id || '';
  const sub = await ensureSubscription(now);
  const [checkout] = isUuid(fields.m_payment_id || '')
    ? await db()
        .select()
        .from(subscriptionCheckouts)
        .where(eq(subscriptionCheckouts.id, fields.m_payment_id!))
    : [];

  if (status === 'CANCELLED') {
    if (!token || token !== sub.payfastToken) {
      return { outcome: 'ignored' };
    }
    if (sub.state !== 'cancelled') {
      await db()
        .update(firmSubscriptions)
        .set({ state: 'cancelled', cancelledAt: now, updatedAt: now })
        .where(eq(firmSubscriptions.id, sub.id));
      await auditService.logEvent(
        {
          entityType: 'subscription',
          entityId: sub.id,
          action: 'subscription_cancelled',
          summary: 'Subscription cancelled at PayFast',
          details: { paidThrough: isoOrNull(sub.paidThrough) },
        },
        SYSTEM,
      );
    }
    return { outcome: 'cancelled' };
  }

  if (!pfPaymentId) {
    return { outcome: 'ignored' };
  }
  const [seen] = await db()
    .select({ id: subscriptionPayments.id })
    .from(subscriptionPayments)
    .where(eq(subscriptionPayments.pfPaymentId, pfPaymentId));
  if (seen) {
    return { outcome: 'duplicate' };
  }

  const amountCents = payfast.toCents(fields.amount_gross) ?? -1;
  const feeCents = payfast.toCents(fields.amount_fee);
  const record = (paymentStatus: 'complete' | 'failed' | 'mismatch') =>
    db()
      .insert(subscriptionPayments)
      .values({
        checkoutId: checkout?.id ?? null,
        pfPaymentId,
        amountCents: Math.max(0, amountCents),
        feeCents: feeCents === null ? null : Math.abs(feeCents),
        status: paymentStatus,
        paidAt: now,
      })
      .onConflictDoNothing();

  if (status === 'FAILED') {
    await record('failed');
    await auditService.logEvent(
      {
        entityType: 'subscription',
        entityId: sub.id,
        action: 'subscription_payment_failed',
        summary: 'Subscription payment failed',
        details: { pfPaymentId },
      },
      SYSTEM,
    );
    await emailAdmins('Subscription payment failed', [
      'PayFast could not collect this period’s subscription payment.',
      'Please check the card or account used for the subscription with your bank, or subscribe again under Account → Subscription.',
    ]);
    return { outcome: 'failed' };
  }
  if (status !== 'COMPLETE') {
    return { outcome: 'ignored' };
  }

  const first = Boolean(checkout && checkout.status === 'pending');
  const recurring = !first && token !== '' && token === sub.payfastToken;
  const expected = first ? checkout!.amountCents : recurring ? sub.recurringAmountCents : null;
  if (expected === null || amountCents !== expected) {
    await record('mismatch');
    await auditService.logEvent(
      {
        entityType: 'subscription',
        entityId: sub.id,
        action: 'subscription_payment_unmatched',
        summary: 'Subscription payment did not match what was expected; not applied',
        details: { pfPaymentId, amountCents, expectedCents: expected },
      },
      SYSTEM,
    );
    return { outcome: 'mismatch' };
  }

  await record('complete');
  if (first) {
    const interval = checkout!.interval as SubscriptionInterval;
    const previousToken = sub.payfastToken && sub.payfastToken !== token ? sub.payfastToken : null;
    await db()
      .update(firmSubscriptions)
      .set({
        state: 'active',
        planCode: checkout!.planCode,
        interval,
        seats: checkout!.seats,
        recurringAmountCents: checkout!.amountCents,
        paidThrough: addInterval(now, interval),
        payfastToken: token || null,
        cancelledAt: null,
        notices: {},
        updatedAt: now,
      })
      .where(eq(firmSubscriptions.id, sub.id));
    await db()
      .update(subscriptionCheckouts)
      .set({ status: 'complete', completedAt: now })
      .where(eq(subscriptionCheckouts.id, checkout!.id));
    await db()
      .update(subscriptionCheckouts)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(subscriptionCheckouts.status, 'pending'),
          ne(subscriptionCheckouts.id, checkout!.id),
        ),
      );
    // A plan change replaces the earlier PayFast agreement: stop it once this
    // one is recorded, so the firm is never charged twice.
    if (previousToken) {
      afterCommit(async () => {
        try {
          await payfast.cancelSubscription(payfast.requirePayfast(), previousToken);
        } catch (error) {
          console.error(
            JSON.stringify({
              level: 'error',
              message: 'payfast_previous_subscription_cancel_failed',
              firmId: currentFirm().id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      });
    }
    await auditService.logEvent(
      {
        entityType: 'subscription',
        entityId: sub.id,
        action: 'subscription_activated',
        summary: `Subscription active (${checkout!.planCode}, ${checkout!.seats} seats, ${interval})`,
        details: { pfPaymentId, amountCents, checkoutId: checkout!.id },
      },
      SYSTEM,
    );
    await emailAdmins('Subscription confirmed', [
      `Your subscription is active: ${checkout!.seats} seats, billed ${interval === 'annual' ? 'yearly' : 'monthly'}.`,
      `PayFast collected R${payfast.rands(amountCents)} (reference ${pfPaymentId}).`,
    ]);
    return { outcome: 'activated' };
  }

  const interval = (sub.interval as SubscriptionInterval | null) ?? 'monthly';
  // An on-time payment extends the current period; a late one starts from now.
  const base =
    sub.paidThrough && sub.paidThrough.getTime() > now.getTime() - 5 * DAY ? sub.paidThrough : now;
  await db()
    .update(firmSubscriptions)
    .set({
      state: 'active',
      paidThrough: addInterval(base, interval),
      notices: {},
      updatedAt: now,
    })
    .where(eq(firmSubscriptions.id, sub.id));
  await auditService.logEvent(
    {
      entityType: 'subscription',
      entityId: sub.id,
      action: 'subscription_payment_received',
      summary: 'Subscription renewed',
      details: { pfPaymentId, amountCents },
    },
    SYSTEM,
  );
  return { outcome: 'renewed' };
}

/**
 * The notify_url handler: verifies the notification, then applies it in the
 * firm it names (custom_str1, covered by the signature).
 */
export async function handleItn(rawBody: string, sourceIp: string, now = new Date()) {
  const config = payfast.requirePayfast();
  const { fields } = await payfast.verifyItn(config, rawBody, sourceIp);
  const firm = isUuid(fields.custom_str1 || '') ? await findFirmById(fields.custom_str1!) : null;
  if (!firm) {
    return { outcome: 'ignored' as const };
  }
  const result = await withTenant(firm, () => applyItn(fields, now), { system: true });
  // Once the payment is committed: the firm's invoice (retried by `ops subscriptions`).
  if (result.outcome === 'activated' || result.outcome === 'renewed') {
    await platformInvoices.issueAfterItn(firm.id, fields.pf_payment_id || '');
  }
  return result;
}

// ------------------------------------------------------- seats and cancelling

function requireAgreement(row: FirmSubscriptionRow): string {
  if (!row.payfastToken || !['active', 'past_due'].includes(row.state)) {
    throw httpError('There is no active PayFast subscription to change', 400);
  }
  return row.payfastToken;
}

/** Seats count at once; the new amount applies from the next billing date. */
export async function changeSeats(input: unknown, actor: Actor): Promise<SubscriptionStatus> {
  const { seats } = parse(subscriptionSeatsSchema, input);
  const row = await ensureSubscription();
  const token = requireAgreement(row);
  const plan = await requirePlan(row.planCode ?? '');
  checkSeats(plan, seats, await seatsUsed());
  const interval = (row.interval as SubscriptionInterval | null) ?? 'monthly';
  const amountCents = subscriptionPriceCents(plan, interval, seats, subscriptionSettings().vatRate);
  if (seats !== row.seats || amountCents !== row.recurringAmountCents) {
    await payfast.updateSubscriptionAmount(payfast.requirePayfast(), token, amountCents);
    await db()
      .update(firmSubscriptions)
      .set({ seats, recurringAmountCents: amountCents, updatedAt: new Date() })
      .where(eq(firmSubscriptions.id, row.id));
    await auditService.logEvent(
      {
        entityType: 'subscription',
        entityId: row.id,
        action: 'subscription_seats_changed',
        summary: `Subscription seats changed from ${row.seats ?? 0} to ${seats}`,
        details: { from: row.seats, to: seats, amountCents },
      },
      actor,
    );
  }
  return getStatus();
}

export async function cancel(actor: Actor): Promise<SubscriptionStatus> {
  const row = await ensureSubscription();
  const token = requireAgreement(row);
  await payfast.cancelSubscription(payfast.requirePayfast(), token);
  await db()
    .update(firmSubscriptions)
    .set({ state: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() })
    .where(eq(firmSubscriptions.id, row.id));
  await auditService.logEvent(
    {
      entityType: 'subscription',
      entityId: row.id,
      action: 'subscription_cancelled',
      summary: 'Subscription cancelled by the firm',
      details: { paidThrough: isoOrNull(row.paidThrough) },
    },
    actor,
  );
  return getStatus();
}

/** Platform administration: free access for a pilot firm (until a date, or open-ended). */
export async function setComplimentary(until: Date | null, seats: number | null): Promise<void> {
  const row = await ensureSubscription();
  await db()
    .update(firmSubscriptions)
    .set({ state: 'complimentary', paidThrough: until, seats, notices: {}, updatedAt: new Date() })
    .where(eq(firmSubscriptions.id, row.id));
  await auditService.logEvent(
    {
      entityType: 'subscription',
      entityId: row.id,
      action: 'subscription_complimentary',
      summary: 'Complimentary access set by the platform',
      details: { until: isoOrNull(until), seats },
    },
    SYSTEM,
  );
}

// ------------------------------------------------------------------- dunning

async function emailAdmins(subject: string, lines: string[]): Promise<number> {
  const admins = await db()
    .select({ email: users.email, fullName: users.fullName })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.isActive, true)));
  const firm = currentFirm();
  const link = `${firmOrigin(firm)}/?view=account#subscription`;
  let sent = 0;
  for (const admin of admins) {
    const ok = await sendMail({
      platform: true,
      to: admin.email,
      subject: `${firm.tradingName || firm.legalName}: ${subject}`,
      text: [`Hello ${admin.fullName},`, '', ...lines, '', link].join('\n'),
    });
    if (ok) sent += 1;
  }
  return sent;
}

const NOTICES: Record<string, (end: Date, suspends: Date) => [string, string[]]> = {
  trial_7: (end) => [
    'Your trial ends in a week',
    [
      `The trial ends on ${localDate(end)}. Choose a plan under Account → Subscription to keep working without interruption.`,
    ],
  ],
  trial_1: (end) => [
    'Your trial ends tomorrow',
    [`The trial ends on ${localDate(end)}. Choose a plan under Account → Subscription.`],
  ],
  past_due: (_end, suspends) => [
    'Subscription payment overdue',
    [
      'We have not received this period’s subscription payment.',
      `Everything keeps working until ${localDate(suspends)}; after that the workspace becomes read-only until payment is received.`,
    ],
  ],
  suspended: () => [
    'Workspace is now read-only',
    [
      'Because the subscription is unpaid, the workspace is read-only: your team can still sign in, read and export records, but cannot make changes.',
      'An administrator can subscribe again under Account → Subscription; access is restored as soon as PayFast confirms the payment.',
    ],
  ],
};

/** One firm: record past-due and suspended states and email each notice once. */
export async function checkSubscription(now = new Date()) {
  const row = await ensureSubscription(now);
  const effective = effectiveStatus(row, now);
  const end = periodEnd(row);
  let changed = false;
  if ((effective === 'past_due' || effective === 'suspended') && effective !== row.state) {
    await db()
      .update(firmSubscriptions)
      .set({ state: effective, updatedAt: now })
      .where(eq(firmSubscriptions.id, row.id));
    await auditService.logEvent(
      {
        entityType: 'subscription',
        entityId: row.id,
        action: 'subscription_state_changed',
        summary: `Subscription ${effective === 'suspended' ? 'suspended (read-only)' : 'past due'}`,
        details: { from: row.state, to: effective, periodEnd: isoOrNull(end) },
      },
      SYSTEM,
    );
    changed = true;
  }

  let kind: string | null = null;
  if (end && effective === 'trialing') {
    const days = (end.getTime() - now.getTime()) / DAY;
    kind = days <= 1 ? 'trial_1' : days <= 7 ? 'trial_7' : null;
  } else if (effective === 'past_due' || effective === 'suspended') {
    kind = effective;
  }
  let emails = 0;
  if (kind && end && row.notices[kind] !== iso(end)) {
    const suspends = new Date(end.getTime() + subscriptionSettings().graceDays * DAY);
    const [subject, lines] = NOTICES[kind]!(end, suspends);
    emails = await emailAdmins(subject, lines);
    await db()
      .update(firmSubscriptions)
      .set({ notices: { ...row.notices, [kind]: iso(end) } })
      .where(eq(firmSubscriptions.id, row.id));
  }
  return { status: effective, changed, emails };
}

/** The daily job (`ops subscriptions`). */
export async function checkAllSubscriptions(now = new Date()) {
  const all = await rootDb().select().from(firms).where(eq(firms.status, 'active'));
  const results: Array<{
    firm: string;
    status: SubscriptionState;
    changed: boolean;
    emails: number;
  }> = [];
  for (const firm of all) {
    const run = await withTenant(firm, () => checkSubscription(now), { system: true });
    results.push({ firm: firm.slug, ...run });
  }
  return results;
}

// -------------------------------------------------------------- read-only mode

/** Paths that keep working while suspended: signing in, paying, and support. */
const ALWAYS_ALLOWED = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/subscription(\/|$)/,
  /^\/api\/support(\/|$)/,
  // Firms can always ask for help.
  /^\/api\/helpdesk(\/|$)/,
  // A firm's unpaid subscription never locks its clients out of the portal.
  /^\/api\/portal(\/|$)/,
];

export function writeAllowedWhileSuspended(path: string): boolean {
  return ALWAYS_ALLOWED.some((pattern) => pattern.test(path));
}

/** For the tenant middleware: is this write blocked by an unpaid subscription? */
export async function blocksWrites(): Promise<boolean> {
  return effectiveStatus(await ensureSubscription()) === 'suspended';
}
