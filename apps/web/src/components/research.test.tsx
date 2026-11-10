import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { ResearchRequest } from '@ahava88/shared';
import { api } from '../api';
import ResearchPanel from './ResearchPanel';

afterEach(() => vi.restoreAllMocks());

const draft: ResearchRequest = {
  id: 'r1',
  caseNumber: 'MAT-2026-0001',
  status: 'draft',
  question: 'Can the landlord lock Thandiwe out?',
  brief: 'Research question:\nCan [Opposing party] lock [Client] out?\n\nFacts:\nSipho moved in.',
  replacements: [
    { token: '[Client]', kind: 'person', count: 2 },
    { token: '[ID number]', kind: 'id_number', count: 1 },
  ],
  warnings: ['Sipho'],
  createdAt: '2026-11-10T08:00:00Z',
  updatedAt: '2026-11-10T08:00:00Z',
  createdBy: 'u1',
  confirmedAt: null,
  confirmedBy: null,
  answer: null,
  lastError: null,
  approvedAt: null,
  approvedBy: null,
  approvalNote: null,
};

test('prepares a brief and shows exactly what will be sent, with what was removed and what to check', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: [] });
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: draft });
  render(<ResearchPanel caseId="c1" />);

  fireEvent.change(await screen.findByLabelText('Research question'), {
    target: { value: draft.question },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Prepare brief' }));
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith('/cases/c1/research', {
      question: draft.question,
      additionalFacts: '',
    }),
  );
  expect(
    ((await screen.findByLabelText('What the AI will receive')) as HTMLTextAreaElement).value,
  ).toBe(draft.brief);
  expect(screen.getByText(/Removed: 2 names, 1 ID numbers/)).toBeTruthy();
  expect(screen.getByText('Sipho')).toBeTruthy();
});

test('edits must be saved (and re-checked) before the brief can be confirmed', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: [draft] });
  const edited = { ...draft, brief: draft.brief.replace('Sipho', '[Person 1]'), warnings: [] };
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: edited });
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { ...edited, status: 'confirmed' } });
  render(<ResearchPanel caseId="c1" />);

  const box = await screen.findByLabelText('What the AI will receive');
  fireEvent.change(box, { target: { value: edited.brief } });
  expect(screen.getByRole('button', { name: 'Confirm brief' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save edits' }));
  await vi.waitFor(() =>
    expect(patch).toHaveBeenCalledWith('/research/r1', { brief: edited.brief }),
  );

  fireEvent.click(await screen.findByRole('button', { name: 'Confirm brief' }));
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith('/research/r1/confirm'));
  expect(await screen.findByText('Confirmed')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Save edits' })).toBeNull();
});

const answered: ResearchRequest = {
  ...draft,
  status: 'answered',
  answer: {
    noAuthority: false,
    claims: [{ text: '[Client] may not be locked out without a court order.', citations: ['S1'] }],
    claimsNamed: [
      { text: 'Thandiwe may not be locked out without a court order.', citations: ['S1'] },
    ],
    removed: [{ text: 'Thirty days notice applies.', reason: 'Cited no source' }],
    gaps: ['Whether a room is a dwelling.'],
    sources: [
      {
        ref: 'S1',
        kind: 'legislation',
        sourceName: 'Laws.Africa',
        title: 'Example Act',
        citation: 'Act 19 of 1998',
        pinpoint: 'section 8',
        url: '',
        versionDate: '2026-01-01',
        authorityLevel: 4,
        court: '',
        validity: 'amended',
        effectiveDate: null,
        text: 'No person may be evicted without a court order.',
      },
    ],
    queries: ['eviction court order'],
    model: 'fake',
    generatedAt: '2026-11-10T08:00:00Z',
  },
};

test('an answer shows cited claims, names only for staff, removed statements, sources and approval', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: [answered] });
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: { ...answered, status: 'approved', approvedAt: '2026-11-10T09:00:00Z' },
  });
  render(<ResearchPanel caseId="c1" canApprove />);

  expect(await screen.findByText(/Thandiwe may not be locked out/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText(/Show names/));
  expect(screen.getByText(/\[Client\] may not be locked out/)).toBeTruthy();
  expect(screen.getByText(/1 statement removed by citation checks/)).toBeTruthy();
  expect(
    screen.getByText(/Statutes and regulations · Laws.Africa · In force \(amended\)/),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Approve memo' }));
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith('/research/r1/approve', { note: '' }));
  expect(await screen.findByText(/memo and its sources are kept/)).toBeTruthy();
});

test('fee earners without research.approve cannot approve', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: [answered] });
  render(<ResearchPanel caseId="c1" />);
  expect(await screen.findByText(/Thandiwe may not be locked out/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve memo' })).toBeNull();
});
