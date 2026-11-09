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
