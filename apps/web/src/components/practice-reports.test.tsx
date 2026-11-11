import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../api';
import PracticeReportsPanel from './PracticeReportsPanel';

afterEach(() => vi.restoreAllMocks());

const wip = {
  from: '2026-11-01',
  to: '2026-11-11',
  scope: 'firm',
  matters: [
    {
      caseId: null,
      caseNumber: 'Restricted matter',
      restricted: true,
      hours: 2,
      timeCents: 200_000,
      disbursementCents: 0,
      totalCents: 200_000,
      oldestWorkDate: '2026-11-03',
    },
  ],
  feeEarners: [{ userId: 'u1', name: 'Sipho Attorney', hours: 2, timeCents: 200_000 }],
  totals: { hours: 2, timeCents: 200_000, disbursementCents: 0, totalCents: 200_000 },
};

test('shows the report for the period, masks restricted matters, and links the CSV', async () => {
  const get = vi.spyOn(api, 'get').mockImplementation(async (_url: string, config?: any) => ({
    data: { ...wip, from: config.params.from, to: config.params.to },
  }));
  render(<PracticeReportsPanel />);
  expect(await screen.findByText('Restricted matter')).toBeTruthy();
  expect(screen.getByText(/Whole firm/)).toBeTruthy();
  const link = screen.getByText('Download CSV');
  expect(link.getAttribute('href')).toMatch(
    /^\/api\/reports\/practice\/wip\.csv\?from=\d{4}-\d{2}-01&to=/,
  );

  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
  await waitFor(() =>
    expect(get).toHaveBeenLastCalledWith('/reports/practice/wip', {
      params: expect.objectContaining({ from: '2026-10-01' }),
    }),
  );
  expect(link.getAttribute('href')).toContain('from=2026-10-01');
});

test('switching report never draws the old data in the new layout', async () => {
  let resolveUtil: (value: unknown) => void = () => {};
  let asked = { from: '', to: '' };
  vi.spyOn(api, 'get').mockImplementation(async (url: string, config?: any) => {
    if (url.endsWith('/utilisation')) {
      asked = config.params;
      return new Promise((resolve) => {
        resolveUtil = resolve;
      }) as never;
    }
    return { data: { ...wip, from: config.params.from, to: config.params.to } };
  });
  render(<PracticeReportsPanel />);
  await screen.findByText('Restricted matter');
  fireEvent.change(screen.getByLabelText('Report'), { target: { value: 'utilisation' } });
  // Until utilisation arrives, nothing is drawn (and nothing crashes).
  expect(screen.queryByText('Restricted matter')).toBeNull();
  resolveUtil({
    data: {
      from: asked.from,
      to: asked.to,
      scope: 'own',
      rows: [
        {
          userId: 'u1',
          name: 'Sipho Attorney',
          month: '2026-11',
          billableHours: 10,
          nonBillableHours: 1,
          targetHours: 100,
          utilisation: 0.1,
        },
      ],
    },
  });
  expect(await screen.findByText('10.0%')).toBeTruthy();
});
