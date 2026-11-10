import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { ROLE_PERMISSIONS, type MatterCase, type PublicUser, type UserRole } from '@ahava88/shared';
import { api } from '../api';
import CalendarPanel, { saDateTime } from './CalendarPanel';
import MatterCourtPanel from './MatterCourtPanel';

const user = (role: UserRole) =>
  ({
    id: 'u1',
    email: 'x@example.com',
    fullName: 'X',
    role,
    permissions: [...ROLE_PERMISSIONS[role]],
  }) as PublicUser;

const matter = {
  id: 'c1',
  caseNumber: 'MAT-1',
  title: 'Arrest claim',
  status: 'open',
  courtDivision: 'ZAGPPHC',
  courtCaseNumber: '34660/2016',
} as MatterCase;

const event = {
  id: 'e1',
  caseId: 'c1',
  caseNumber: 'MAT-1',
  title: 'Opposed motion',
  eventType: 'court_date',
  startsAt: '2031-03-03T07:30:00.000Z',
  endsAt: null,
  allDay: false,
  location: 'Court 4A',
  notes: '',
  status: 'scheduled',
  source: 'manual',
  assigneeName: 'Lerato',
  createdBy: 'x',
  createdAt: '2026-11-01T00:00:00Z',
};

const period = {
  id: 'p1',
  caseId: 'c1',
  caseNumber: 'MAT-1',
  rule: 'organ_of_state_notice',
  startsOn: '2026-10-01',
  lastDay: '2027-03-31',
  status: 'running',
  lapsed: false,
  daysLeft: 20,
  notes: 'Arrest date',
  eventId: 'e2',
  createdAt: '2026-11-01T00:00:00Z',
};

function mockGet() {
  return vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/calendar') return { data: [event] };
    if (url === '/calendar/prescriptions') return { data: [period] };
    if (url === '/court-rolls/matches') return { data: [] };
    throw new Error(`unexpected ${url}`);
  });
}

afterEach(() => vi.restoreAllMocks());

test('South African times are sent with their offset', () => {
  expect(saDateTime('2031-03-03', '09:30')).toBe('2031-03-03T09:30:00+02:00');
});

test('the agenda groups by day in South African time; events are added with the offset', async () => {
  mockGet();
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} });
  render(<CalendarPanel currentUser={user('attorney')} cases={[matter]} selectedCaseId="c1" />);
  expect(await screen.findByText(/Monday, 3 March 2031/)).toBeInTheDocument();
  expect(screen.getByText('09:30')).toBeInTheDocument();
  expect(screen.getByText(/MAT-1 · Opposed motion · Court 4A/)).toBeInTheDocument();
  expect(screen.getByText('20')).toBeInTheDocument(); // days left on the running prescription

  fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Pre-trial' } });
  fireEvent.change(screen.getByLabelText('Event date'), { target: { value: '2031-04-01' } });
  fireEvent.change(screen.getByLabelText('Event time'), { target: { value: '10:00' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add event' }));
  });
  expect(post).toHaveBeenCalledWith(
    '/calendar',
    expect.objectContaining({
      caseId: 'c1',
      title: 'Pre-trial',
      startsAt: '2031-04-01T10:00:00+02:00',
      allDay: false,
    }),
  );
});

test('a bookkeeper reads the calendar without forms or actions', async () => {
  mockGet();
  render(<CalendarPanel currentUser={user('bookkeeper')} cases={[matter]} />);
  expect(await screen.findByText(/Opposed motion/)).toBeInTheDocument();
  expect(document.querySelectorAll('form')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
});

test('the matter panel saves court details and records prescriptions', async () => {
  mockGet();
  const put = vi.spyOn(api, 'put').mockResolvedValue({ data: {} });
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} });
  render(<MatterCourtPanel matter={matter} canEditMatter canEditCalendar />);
  expect(await screen.findByText('20 days left')).toBeInTheDocument();
  expect(screen.getByLabelText('Court case number')).toHaveValue('34660/2016');

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save court details' }));
  });
  expect(put).toHaveBeenCalledWith('/cases/c1/court', {
    courtDivision: 'ZAGPPHC',
    courtCaseNumber: '34660/2016',
    courtOnlineReference: null,
  });

  fireEvent.change(screen.getByLabelText('Prescription rule'), {
    target: { value: 'raf_identified' },
  });
  expect(screen.getByText(/Road Accident Fund Act 56 of 1996, s23\(1\)/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Period runs from'), {
    target: { value: '2026-05-01' },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add prescription' }));
  });
  expect(post).toHaveBeenCalledWith('/calendar/prescriptions', {
    caseRef: 'c1',
    rule: 'raf_identified',
    startsOn: '2026-05-01',
  });
  // Back to the default rule after saving.
  expect(screen.getByLabelText('Prescription rule')).toHaveValue('general_3y');
});

test('read-only staff see the court details but no forms', async () => {
  mockGet();
  render(<MatterCourtPanel matter={matter} canEditMatter={false} canEditCalendar={false} />);
  expect(
    await screen.findByText(/Gauteng Division, Pretoria · case 34660\/2016/),
  ).toBeInTheDocument();
  expect(document.querySelectorAll('form')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
});

test('a court on Court Online says so, with its source and a link', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) =>
    url.endsWith('/court-online')
      ? {
          data: {
            court: {
              division: 'ZAGPPHC',
              since: '2022-02-23',
              source: 'Acting Judge President notice',
            },
            url: 'https://www.judiciary.org.za/index.php/court-online',
          },
        }
      : { data: [] },
  );
  render(
    <MatterCourtPanel
      matter={
        {
          id: 'c9',
          courtDivision: 'ZAGPPHC',
          courtCaseNumber: '1/2024',
          courtOnlineReference: '2024-000001',
        } as never
      }
      canEditMatter={false}
      canEditCalendar={false}
    />,
  );
  expect(await screen.findByText(/This court uses Court Online \(since 2022-02-23\)/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open Court Online' }).getAttribute('href')).toMatch(
    /judiciary/,
  );
  expect(screen.getByText(/Court Online 2024-000001/)).toBeTruthy();
});
