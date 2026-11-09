import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { ROLE_PERMISSIONS, type PublicUser, type UserRole } from '@ahava88/shared';
import { api } from '../api';
import CourtRollPanel from './CourtRollPanel';

const user = (role: UserRole) =>
  ({
    id: 'u1',
    email: 'x@example.com',
    fullName: 'X',
    role,
    permissions: [...ROLE_PERMISSIONS[role]],
  }) as PublicUser;

const match = (id: string, extra: object = {}) => ({
  id,
  caseId: 'c1',
  caseNumber: 'MAT-1',
  courtCaseNumber: '2023-076666',
  origin: 'sync',
  documentUrl: 'https://court.example/roll.pdf',
  documentTitle: '03 March 2031 - Pretoria - Daily Court Roll',
  division: 'ZAGPPHC',
  hearingDate: '2031-03-03',
  hearingTime: '10:00',
  courtroom: '4C',
  judge: 'KHUMALO J',
  section: 'Opposed motions',
  status: 'new',
  onCalendar: false,
  eventId: null,
  createdAt: '2031-03-01T00:00:00Z',
  updatedAt: '2031-03-01T00:00:00Z',
  ...extra,
});

afterEach(() => vi.restoreAllMocks());

test('listings can be added to the calendar or dismissed; undated ones need a date', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: [
      match('m1'),
      match('m2', { caseNumber: 'MAT-2', hearingDate: null, hearingTime: null }),
      match('m3', { caseNumber: 'MAT-3', status: 'removed' }),
    ],
  });
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} });
  render(<CourtRollPanel currentUser={user('attorney')} />);
  expect(await screen.findAllByText(/court 4C · Opposed motions · before KHUMALO J/)).toHaveLength(
    3,
  );
  expect(screen.getByText(/Not on the amended roll/)).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: /Daily Court Roll/ })[0]).toHaveAttribute(
    'href',
    'https://court.example/roll.pdf',
  );

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add MAT-1 hearing to the calendar' }));
  });
  expect(post).toHaveBeenCalledWith('/court-rolls/matches/m1/accept', {});

  const undated = screen.getByRole('button', { name: 'Add MAT-2 hearing to the calendar' });
  expect(undated).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Hearing date for MAT-2'), {
    target: { value: '2031-04-01' },
  });
  await act(async () => {
    fireEvent.click(undated);
  });
  expect(post).toHaveBeenCalledWith('/court-rolls/matches/m2/accept', {
    startsAt: '2031-04-01T10:00:00+02:00',
  });
  // Removed listings can't be added again.
  expect(screen.queryByRole('button', { name: 'Add MAT-3 hearing to the calendar' })).toBeNull();
});

test('read-only staff see listings without actions or upload', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: [match('m1')] });
  render(<CourtRollPanel currentUser={user('support')} />);
  expect(await screen.findByText('MAT-1')).toBeInTheDocument();
  expect(document.querySelectorAll('form')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: /Add MAT-1/ })).toBeNull();
});
