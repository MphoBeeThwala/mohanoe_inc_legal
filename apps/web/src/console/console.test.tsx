import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { api } from '../api';
import ConsoleApp from './ConsoleApp';

const firm = {
  id: 'f1',
  slug: 'mokoena',
  legalName: 'Mokoena Attorneys Inc',
  tradingName: 'Mokoena Attorneys',
  status: 'active',
  domains: ['mokoena.example'],
  createdAt: '2026-01-01T00:00:00Z',
  features: { trustAccounting: false },
  staff: 4,
  matters: 12,
  subscription: {
    state: 'active',
    effectiveStatus: 'active',
    planCode: 'practice',
    seats: 4,
    paidThrough: '2026-12-01T00:00:00Z',
  },
  aiTokensThisMonth: 1200,
};

function mockMe(role: 'viewer' | 'admin' | null) {
  vi.spyOn(api, 'get').mockImplementation((url: string) => {
    if (url === '/platform/me') {
      return role
        ? Promise.resolve({ data: { id: 'o1', email: 'o@p', fullName: 'Op', consoleRole: role } })
        : Promise.reject({ isAxiosError: true, response: { status: 401, data: {} } });
    }
    if (url === '/platform/firms') return Promise.resolve({ data: [firm] });
    return Promise.resolve({ data: [] });
  });
}

describe('ConsoleApp', () => {
  beforeEach(() => vi.restoreAllMocks());

  test('asks for password and authenticator code when signed out', async () => {
    mockMe(null);
    render(<ConsoleApp />);
    expect(await screen.findByLabelText('Authenticator code')).toBeTruthy();
  });

  test('viewers see firms without change buttons', async () => {
    mockMe('viewer');
    render(<ConsoleApp />);
    expect(await screen.findByText('Mokoena Attorneys')).toBeTruthy();
    expect(screen.queryByText('Suspend')).toBeNull();
    expect(screen.queryByLabelText('New firm')).toBeNull();
  });

  test('administrators can change firms', async () => {
    mockMe('admin');
    render(<ConsoleApp />);
    expect(await screen.findByText('Suspend')).toBeTruthy();
    expect(screen.getByText('Turn trust on')).toBeTruthy();
    expect(screen.getByLabelText('New firm')).toBeTruthy();
  });
});
