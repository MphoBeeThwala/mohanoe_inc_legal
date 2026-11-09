import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { ROLE_PERMISSIONS, type PublicUser, type UserRole } from '@ahava88/shared';
import { api } from '../api';
import ClientsPanel from './ClientsPanel';

function user(role: UserRole): PublicUser {
  return {
    id: 'u1',
    email: 'a@example.com',
    fullName: 'A',
    role,
    createdAt: '2026-01-01T00:00:00Z',
    lastLoginAt: null,
    permissions: [...ROLE_PERMISSIONS[role]],
    mfaEnabled: true,
    signInMethods: ['password'],
  };
}

afterEach(() => vi.restoreAllMocks());

const check = {
  id: 'chk1',
  subjects: [{ name: 'Thandi Nkosi' }],
  purpose: 'Dispute',
  matches: [],
  strongMatches: 0,
  possibleMatches: 0,
  decision: 'pending',
  decisionNotes: null,
  performedBy: 'A',
  decidedBy: null,
  decidedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
};

test('new client: conflict check, decision, client, then the matter', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: [] });
  const post = vi.spyOn(api, 'post').mockImplementation(async (path: string) => {
    if (path === '/conflicts') return { data: check };
    if (path.endsWith('/decision'))
      return { data: { ...check, decision: 'clear', decidedBy: 'A' } };
    if (path === '/clients') {
      return {
        data: {
          id: 'p1',
          partyNumber: 'P-00001',
          name: 'Thandi Nkosi',
          kind: 'individual',
          details: { name: 'Thandi Nkosi' },
          matters: [],
        },
      };
    }
    if (path === '/cases') return { data: { id: 'c1', caseNumber: 'NKP-2026-0001' } };
    throw new Error(path);
  });
  const opened = vi.fn();
  render(<ClientsPanel currentUser={user('attorney')} onMatterOpened={opened} />);

  fireEvent.click(await screen.findByRole('button', { name: 'New client' }));
  fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Thandi Nkosi' } });
  fireEvent.change(screen.getByLabelText('Proposed matter'), { target: { value: 'Dispute' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run conflict check' }));
  expect(await screen.findByText('No matches in the register')).toBeInTheDocument();
  // Attorneys can't waive.
  expect(screen.queryByRole('button', { name: /Waive/ })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'No conflict: proceed' }));
  expect(await screen.findByText(/2\. Open a matter for Thandi Nkosi/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Matter title'), { target: { value: 'Dismissal' } });
  fireEvent.change(screen.getByLabelText('Practice area'), { target: { value: 'Labour' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open matter' }));
  await waitFor(() => expect(opened).toHaveBeenCalled());
  expect(post).toHaveBeenCalledWith(
    '/cases',
    expect.objectContaining({ clientId: 'p1', conflictCheckId: 'chk1' }),
  );
});

test('a bookkeeper can look clients up but not open them', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: [] });
  render(<ClientsPanel currentUser={user('bookkeeper')} onMatterOpened={vi.fn()} />);
  expect(await screen.findByRole('button', { name: 'Search' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'New client' })).not.toBeInTheDocument();
});
