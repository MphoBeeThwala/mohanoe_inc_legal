import { render, screen } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { ROLE_PERMISSIONS, type PublicUser, type UserRole } from '@ahava88/shared';
import { api } from '../api';
import FicaPanel from './FicaPanel';

const user = (role: UserRole) =>
  ({
    id: 'u',
    email: 'x@example.com',
    fullName: 'X',
    role,
    permissions: [...ROLE_PERMISSIONS[role]],
  }) as PublicUser;

const profile = {
  partyId: 'p1',
  status: 'in_progress',
  riskRating: 'low',
  riskFactors: {},
  notes: null,
  documents: [
    {
      id: 'd1',
      docType: 'id_document',
      fileName: 'id.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
      uploadedBy: 'S',
      createdAt: '2026-01-01T00:00:00Z',
    },
  ],
  missing: ['proof_of_address'],
  verifiedBy: null,
  verifiedAt: null,
  reviewDue: null,
};

afterEach(() => vi.restoreAllMocks());

test('a secretary collects documents but cannot verify', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: profile });
  render(<FicaPanel clientId="p1" currentUser={user('secretary')} />);
  expect(await screen.findByText(/Still needed: Proof of address/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'id.pdf' })).toHaveAttribute(
    'href',
    '/api/clients/p1/fica/documents/d1',
  );
  expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Mark FICA verified' })).not.toBeInTheDocument();
});

test('an attorney can verify only once nothing is missing', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: profile });
  render(<FicaPanel clientId="p1" currentUser={user('attorney')} />);
  expect(await screen.findByRole('button', { name: 'Mark FICA verified' })).toBeDisabled();
});

test('a bookkeeper only reads', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: profile });
  render(<FicaPanel clientId="p1" currentUser={user('bookkeeper')} />);
  expect(await screen.findByText(/Still needed/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Upload' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save risk assessment' })).not.toBeInTheDocument();
});
