import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { api } from '../api';
import HelpPanel, { HelpText } from './HelpPanel';

const ticket = {
  id: 't1',
  number: 'SUP-000001',
  subject: 'Help',
  category: 'question',
  priority: 'normal',
  status: 'open',
  createdAt: '2026-11-10T08:00:00Z',
  lastMessageAt: '2026-11-10T08:00:00Z',
  createdBy: 'Me',
  messages: [],
};

describe('HelpPanel', () => {
  beforeEach(() => vi.restoreAllMocks());

  test('shows guides, the status page and asks to leave client details out', async () => {
    vi.spyOn(api, 'get').mockImplementation((url: string) =>
      Promise.resolve({
        data:
          url === '/helpdesk'
            ? {
                articles: [
                  { slug: 'signing-in', title: 'Signing in', category: 'Getting started' },
                ],
                statusPageUrl: 'https://status.example',
                supportEmail: null,
              }
            : url.startsWith('/helpdesk/tickets/')
              ? { ...ticket, messages: [] }
              : [],
      }),
    );
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: ticket });
    render(<HelpPanel />);
    expect(await screen.findByText('Signing in')).toBeTruthy();
    expect(screen.getByText('Check the service status').getAttribute('href')).toBe(
      'https://status.example',
    );
    expect(screen.getByText(/leave out client names/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Cannot upload' } });
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'Error 500' } });
    fireEvent.click(screen.getByText('Send to support'));
    await screen.findByText('Send to support');
    expect(post).toHaveBeenCalledWith('/helpdesk/tickets', {
      subject: 'Cannot upload',
      body: 'Error 500',
      category: 'question',
      priority: 'normal',
    });
  });

  test('article text renders headings and lists, never HTML', () => {
    render(<HelpText body={'# Steps\n- one\n- two\n\n<b>bold</b>'} />);
    expect(screen.getByRole('heading', { name: 'Steps' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('<b>bold</b>')).toBeTruthy();
  });
});
