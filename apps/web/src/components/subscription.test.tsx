import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { SubscriptionStatus } from '@ahava88/shared';
import { api } from '../api';
import SubscriptionPanel from './SubscriptionPanel';
import SubscriptionBanner from './SubscriptionBanner';

const plan = {
  code: 'practice',
  name: 'Practice',
  description: 'For small practices',
  monthlySeatPriceCents: 45_000,
  annualSeatPriceCents: 486_000,
  minSeats: 1,
  maxSeats: 25,
};

const status = (over: Partial<SubscriptionStatus> = {}): SubscriptionStatus => ({
  effectiveStatus: 'trialing',
  readOnly: false,
  paidThrough: '2026-12-09T10:00:00.000Z',
  suspendsAt: '2026-12-16T10:00:00.000Z',
  daysLeft: 30,
  state: 'trialing',
  planCode: null,
  planName: null,
  interval: null,
  seats: 10,
  seatsUsed: 3,
  recurringAmountCents: null,
  cancelledAt: null,
  pendingCheckout: false,
  payments: [],
  vatRate: 0.15,
  onlinePayments: true,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

function mockGet(current: SubscriptionStatus) {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => ({
    data: url === '/subscription/plans' ? [plan] : current,
  }));
}

test('choosing a plan shows the price with VAT and hands a signed form to PayFast', async () => {
  mockGet(status());
  const checkout = {
    action: 'https://sandbox.payfast.co.za/eng/process',
    fields: [],
    amountCents: 1,
  };
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: checkout });
  const onCheckout = vi.fn();
  render(<SubscriptionPanel onCheckout={onCheckout} />);

  // Seats start at what the firm uses: 3 × R450 + 15% VAT.
  expect(await screen.findByText(/R 1 552.50 a month incl. 15% VAT/)).toBeTruthy();
  fireEvent.change(screen.getByDisplayValue('Monthly'), { target: { value: 'annual' } });
  expect(screen.getByText(/R 16 767.00 a year/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Continue to PayFast' }));
  await vi.waitFor(() => expect(onCheckout).toHaveBeenCalledWith(checkout));
  expect(post).toHaveBeenCalledWith('/subscription/checkout', {
    planCode: 'practice',
    interval: 'annual',
    seats: 3,
  });
});

test('an active subscription offers seat changes and cancelling, and lists payments', async () => {
  mockGet(
    status({
      effectiveStatus: 'active',
      state: 'active',
      planCode: 'practice',
      planName: 'Practice',
      interval: 'monthly',
      seats: 5,
      recurringAmountCents: 258_750,
      payments: [
        {
          id: 'p1',
          amountCents: 258_750,
          status: 'complete',
          paidAt: '2026-11-09T08:00:00Z',
          reference: 'pf-1',
        },
      ],
    }),
  );
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: status({ state: 'active' }) });
  render(<SubscriptionPanel />);

  expect(await screen.findByText('pf-1')).toBeTruthy();
  expect(screen.getAllByText(/R 2 587.50/).length).toBeGreaterThan(0);
  expect(screen.queryByRole('button', { name: 'Continue to PayFast' })).toBeNull();
  fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Change seats' }));
  await vi.waitFor(() => expect(patch).toHaveBeenCalledWith('/subscription/seats', { seats: 7 }));
  expect(screen.getByRole('button', { name: 'Cancel subscription' })).toBeTruthy();
});

test('the banner tells everyone when the workspace is read-only', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      effectiveStatus: 'suspended',
      readOnly: true,
      paidThrough: null,
      suspendsAt: null,
      daysLeft: 0,
    },
  });
  render(<SubscriptionBanner canManage={false} />);
  expect(await screen.findByText(/read-only because the subscription is unpaid/)).toBeTruthy();
  expect(screen.getByText(/let an administrator know/)).toBeTruthy();
});

test('the banner stays quiet early in the trial', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({ data: status({ daysLeft: 25 }) });
  const { container } = render(<SubscriptionBanner canManage />);
  await vi.waitFor(() => expect(get).toHaveBeenCalled());
  expect(container.textContent).toBe('');
});
