import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { ROLE_PERMISSIONS, type MatterCase, type PublicUser, type UserRole } from '@ahava88/shared';
import { api } from '../api';
import BillingPanel, { rand } from './BillingPanel';

const user = (role: UserRole) =>
  ({
    id: 'u1',
    email: 'x@example.com',
    fullName: 'X',
    role,
    permissions: [...ROLE_PERMISSIONS[role]],
  }) as PublicUser;

const cases = [
  { id: 'c1', caseNumber: 'MAT-1', title: 'Transfer', status: 'open' },
] as MatterCase[];

const invoice = (status: string, extra: object = {}) => ({
  id: `i-${status}`,
  caseId: 'c1',
  caseNumber: 'MAT-1',
  number: status === 'draft' ? null : 'INV-000001',
  subject: `${status} account`,
  status,
  total: 1150,
  balance: status === 'draft' ? 0 : 1150,
  paid: 0,
  sentAt: null,
  lines: [],
  ...extra,
});

function mockGet() {
  return vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/billing/summary')
      return { data: { outstanding: 1150, overdue: 0, wip: 3000, unbilledDisbursements: 450 } };
    if (url === '/billing/invoices') return { data: [invoice('draft'), invoice('issued')] };
    if (url === '/billing/disbursements') return { data: [] };
    if (url === '/billing/aging')
      return {
        data: {
          asOf: '2026-11-09',
          totals: {},
          clients: [
            {
              clientPartyId: 'p1',
              clientLabel: 'P-00001',
              invoices: 1,
              current: 1150,
              days30: 0,
              days60: 0,
              days90: 0,
              days120: 0,
              total: 1150,
            },
          ],
        },
      };
    if (url === '/firm/settings')
      return {
        data: {
          billing: {
            vatRegistered: true,
            vatNumber: null,
            paymentTermsDays: 30,
            address: '',
            bankDetails: '',
            invoiceFooter: '',
          },
        },
      };
    throw new Error(`unexpected ${url}`);
  });
}

afterEach(() => vi.restoreAllMocks());

test('rand formats South African amounts', () => {
  expect(rand(1234567.5)).toBe('R 1 234 567.50');
  expect(rand(-20)).toBe('-R 20.00');
});

test('drafts from unbilled work, issues drafts, takes payments on issued invoices', async () => {
  mockGet();
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} });
  render(<BillingPanel currentUser={user('bookkeeper')} cases={cases} selectedCaseId="c1" />);
  expect(await screen.findByText('draft account')).toBeInTheDocument();
  expect(screen.getByText('R 3 000.00')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Statement' })).toHaveAttribute(
    'href',
    '/api/billing/statements/p1/pdf',
  );
  // A bookkeeper can't void, and doesn't manage firm settings.
  expect(screen.queryByRole('button', { name: /Void/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('form', { name: 'Billing settings' })).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Invoice subject'), { target: { value: 'October' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Draft from unbilled work' }));
  });
  expect(post).toHaveBeenCalledWith('/billing/invoices', { caseRef: 'c1', subject: 'October' });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Issue' }));
  });
  expect(post).toHaveBeenCalledWith('/billing/invoices/i-draft/issue');

  fireEvent.click(screen.getByRole('button', { name: 'Payment' }));
  expect(screen.getByLabelText('Payment amount')).toHaveValue('1150.00');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
  });
  expect(post).toHaveBeenCalledWith('/billing/invoices/i-issued/payments', {
    amount: '1150.00',
    method: 'eft',
    reference: '',
  });
});

test('an administrator can void unpaid invoices and edit invoice details', async () => {
  mockGet();
  render(<BillingPanel currentUser={user('admin')} cases={cases} />);
  expect(await screen.findByRole('button', { name: 'Void INV-000001' })).toBeInTheDocument();
  expect(await screen.findByRole('form', { name: 'Billing settings' })).toBeInTheDocument();
});

test('platform support only reads', async () => {
  mockGet();
  render(<BillingPanel currentUser={user('support')} cases={cases} />);
  expect(await screen.findByText('issued account')).toBeInTheDocument();
  expect(document.querySelectorAll('form')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Issue' })).not.toBeInTheDocument();
});
