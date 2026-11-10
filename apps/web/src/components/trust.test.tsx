import { render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { PublicUser, TrustEntry } from '@ahava88/shared';
import { api } from '../api';
import TrustPanel from './TrustPanel';

afterEach(() => vi.restoreAllMocks());

const user = (role: PublicUser['role'], id = 'u-me') =>
  ({ id, role, fullName: 'Me', email: 'me@x.test' }) as PublicUser;

const pendingPayment: TrustEntry = {
  id: 'e1',
  accountId: 'a1',
  caseNumber: 'MAT-0001',
  kind: 'payment',
  amountCents: -3_000_000,
  entryDate: '2026-11-10',
  reference: 'SARS',
  description: 'Transfer duty',
  status: 'pending',
  invoiceNumber: null,
  requestedBy: 'u-me',
  authorisedBy: null,
  authorisedAt: null,
  rejectedReason: null,
  reversesId: null,
  reversedBy: null,
  clearedOn: null,
  groupId: null,
};

function mockTrust(enabled = true) {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/trust/status') return { data: { enabled } };
    if (url === '/trust/accounts')
      return {
        data: [
          {
            id: 'a1',
            name: 'Trust',
            kind: 'trust',
            bankName: 'B',
            accountLast4: '0012',
            isActive: true,
            balanceCents: 7_000_000,
          },
        ],
      };
    if (url === '/trust/pending') return { data: [pendingPayment] };
    if (url.endsWith('/balances'))
      return { data: [{ caseId: 'c1', caseNumber: 'MAT-0001', balanceCents: 7_000_000 }] };
    return { data: [] };
  });
}

test('says so when trust accounting is not enabled', async () => {
  mockTrust(false);
  render(<TrustPanel currentUser={user('bookkeeper')} cases={[]} />);
  expect(await screen.findByText(/not enabled for this firm/)).toBeTruthy();
});

test('a practitioner cannot authorise their own request', async () => {
  mockTrust();
  render(<TrustPanel currentUser={user('admin')} cases={[]} />);
  expect(await screen.findByText(/Transfer duty/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Authorise' })).toBeDisabled();
});

test('a bookkeeper records and reconciles but never authorises', async () => {
  mockTrust();
  render(<TrustPanel currentUser={user('bookkeeper', 'u-books')} cases={[]} />);
  expect(await screen.findByText(/Transfer duty/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Authorise' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Post receipt' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Reconcile' })).toBeTruthy();
  expect(screen.getByText('MAT-0001')).toBeTruthy();
});
