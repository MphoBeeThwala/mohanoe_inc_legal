import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { api } from '../api';
import PortalApp from './PortalApp';
import PortalStaffPanel from '../components/PortalStaffPanel';

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

test('an invite link sets up the authenticator, then shows the client’s matters', async () => {
  window.history.replaceState(null, '', '/portal?invite=tok123');
  const post = vi.spyOn(api, 'post').mockImplementation(async (url: string) => {
    if (url === '/portal/invite/start') {
      return {
        data: {
          secret: 'ABCDEFGHIJKLMNOP',
          otpauthUrl: 'otpauth://totp/x',
          qrCodeDataUrl: 'data:image/svg+xml;base64,',
          name: 'Ayanda',
        },
      };
    }
    return { data: { name: 'Ayanda', firmName: 'Example Attorneys' } };
  });
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/portal/matters') {
      return {
        data: [
          {
            id: 'm1',
            caseNumber: 'MAT-1',
            title: 'Sale of erf 77',
            status: 'active',
            update: 'Lodged at the deeds office.',
            updatedAt: '2026-11-10T08:00:00Z',
            trustBalanceCents: 1_500_000,
            unreadMessages: 2,
          },
        ],
      };
    }
    if (url === '/portal/fica')
      return { data: { status: 'pending', missing: ['proof_of_address'], uploaded: [] } };
    return { data: [] };
  });
  render(<PortalApp />);
  expect(await screen.findByText('Welcome, Ayanda')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('6-digit code from the app'), {
    target: { value: '123456' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith('/portal/invite/complete', {
      token: 'tok123',
      code: '123456',
    }),
  );
  expect(await screen.findByText('Hello, Ayanda')).toBeTruthy();
  expect(screen.getByText(/Lodged at the deeds office/)).toBeTruthy();
  expect(screen.getByText(/Held in trust for this matter: R 15/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Messages (2 new)' })).toBeTruthy();
  expect(await screen.findByText(/Still needed: Proof of address/)).toBeTruthy();
  expect(window.location.search).toBe('');
});

test('signing in never says whether an address has access', async () => {
  window.history.replaceState(null, '', '/portal');
  vi.spyOn(api, 'get').mockRejectedValue(new Error('401'));
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { sent: true } });
  render(<PortalApp />);
  fireEvent.change(await screen.findByLabelText('Email address'), {
    target: { value: 'a@b.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith('/portal/sign-in', { email: 'a@b.test' }),
  );
  expect(await screen.findByText(/If that address has portal access/)).toBeTruthy();
});

test('staff see portal access, share documents and reply only as their permissions allow', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url.endsWith('/parties'))
      return { data: [{ role: 'client', party: { id: 'p1', name: 'Ayanda Zulu' } }] };
    if (url === '/clients/p1/portal') return { data: { access: null } };
    if (url === '/documents')
      return { data: [{ id: 'd1', caseId: 'c1', title: 'Offer', sharedWithClientAt: null }] };
    return { data: [] };
  });
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} });
  const { unmount } = render(
    <PortalStaffPanel caseId="c1" canManagePortal canWriteMatter canShareDocuments />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Invite to the portal' }));
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith('/clients/p1/portal/invite', {}));
  fireEvent.click(await screen.findByLabelText(/Offer — shared with the client/));
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith('/documents/d1/share', { shared: true }),
  );
  unmount();

  render(
    <PortalStaffPanel
      caseId="c1"
      canManagePortal={false}
      canWriteMatter
      canShareDocuments={false}
    />,
  );
  expect(await screen.findByLabelText('Update for the client')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Invite to the portal' })).toBeNull();
  expect(screen.queryByLabelText('Reply to the client')).toBeNull();
});
