import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { ROLE_PERMISSIONS, type MatterCase, type PublicUser, type UserRole } from '@ahava88/shared';
import { api } from '../api';
import TimePanel from './TimePanel';

const user = (role: UserRole, id = 'u1') =>
  ({
    id,
    email: 'x@example.com',
    fullName: 'X',
    role,
    permissions: [...ROLE_PERMISSIONS[role]],
  }) as PublicUser;

const cases = [
  { id: 'c1', caseNumber: 'MAT-1', title: 'Dismissal', status: 'open' },
  { id: 'c2', caseNumber: 'MAT-2', title: 'Old', status: 'closed' },
] as MatterCase[];

const entry = {
  id: 'e1',
  caseId: 'c1',
  caseNumber: 'MAT-1',
  userId: 'u1',
  feeEarnerName: 'Lerato',
  workDate: '2026-11-02',
  units: 3,
  minutes: 18,
  billable: true,
  rate: 2500,
  amount: 750,
  activity: 'consultation',
  description: 'First consultation',
  source: 'manual',
  status: 'unbilled',
  invoiceId: null,
  createdAt: '2026-11-02T08:00:00Z',
  updatedAt: '2026-11-02T08:00:00Z',
};

const wip = {
  units: 3,
  value: 750,
  matters: [
    {
      caseId: 'c1',
      caseNumber: 'MAT-1',
      title: 'Dismissal',
      units: 3,
      value: 750,
      entries: 1,
      oldestWorkDate: '2026-11-02',
    },
  ],
  feeEarners: [],
};

function mockGet(timer: unknown = null) {
  return vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/time/entries') return { data: [entry] };
    if (url === '/time/wip') return { data: wip };
    if (url === '/time/timer') return { data: { timer } };
    if (url === '/time/rates') return { data: [] };
    throw new Error(`unexpected ${url}`);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('a fee earner records time on open matters only', async () => {
  mockGet();
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: entry });
  render(<TimePanel currentUser={user('attorney')} cases={cases} selectedCaseId="c1" />);
  expect(await screen.findByText('First consultation', { exact: false })).toBeInTheDocument();
  expect(screen.getByText('Work in progress: 0.3 h · R 750.00')).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /MAT-2/ })).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Drafted letter' } });
  fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '13' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
  });
  expect(post).toHaveBeenCalledWith(
    '/time/entries',
    expect.objectContaining({ caseRef: 'c1', minutes: 13, description: 'Drafted letter' }),
  );
  expect(screen.getByRole('button', { name: /Delete time on MAT-1/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Write off' })).not.toBeInTheDocument();
});

test('a running timer ticks and can be stopped', async () => {
  mockGet({
    caseId: 'c1',
    caseNumber: 'MAT-1',
    activity: 'drafting',
    billable: true,
    description: 'Heads of argument',
    running: true,
    elapsedSeconds: 65,
    units: 2,
  });
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: entry });
  render(<TimePanel currentUser={user('attorney')} cases={cases} />);
  expect(await screen.findByText('00:01:05')).toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Stop & record' }));
  });
  expect(post).toHaveBeenCalledWith('/time/timer/stop', { description: undefined });
});

test('a bookkeeper sees time and WIP but records none', async () => {
  mockGet();
  render(<TimePanel currentUser={user('bookkeeper', 'b1')} cases={cases} />);
  expect(await screen.findByText(/Work in progress/)).toBeInTheDocument();
  expect(screen.queryByRole('form', { name: 'Record time' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
});
