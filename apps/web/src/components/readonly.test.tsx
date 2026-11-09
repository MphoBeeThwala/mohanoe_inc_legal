import { render, screen } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { ROLE_PERMISSIONS, type PublicUser, type UserRole } from '@ahava88/shared';
import { api } from '../api';
import OperationsHub from './OperationsHub';
import CaseWorkspace from './CaseWorkspace';

function user(role: UserRole): PublicUser {
  return {
    id: `u-${role}`,
    email: `${role}@example.com`,
    fullName: role,
    role,
    createdAt: '2026-01-01T00:00:00Z',
    lastLoginAt: null,
    permissions: [...ROLE_PERMISSIONS[role]],
    mfaEnabled: true,
    signInMethods: ['password'],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function mockGet() {
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => ({
    data: path.endsWith('summary') ? {} : [],
  }));
}

async function renderHub(role: UserRole) {
  const get = mockGet();
  render(
    <OperationsHub
      api={api}
      selectedCaseId={null}
      cases={[]}
      currentUser={user(role)}
      onChanged={async () => {}}
    />,
  );
  await screen.findByRole('button', { name: /Notifications/ });
  return get.mock.calls.map(([path]) => path);
}

test('a secretary sees documents and calendar, not billing, and can draft documents', async () => {
  const fetched = await renderHub('secretary');
  expect(screen.queryByRole('button', { name: 'Billing' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Compliance' })).not.toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Save document' })).toBeInTheDocument();
  expect(fetched).not.toContain('/billing/invoices');
  expect(fetched).not.toContain('/audit');
});

test('a bookkeeper starts on billing and is not offered documents', async () => {
  const fetched = await renderHub('bookkeeper');
  expect(screen.queryByRole('button', { name: 'Documents' })).not.toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Issue invoice' })).toBeInTheDocument();
  expect(fetched).toContain('/billing/invoices');
  expect(fetched).not.toContain('/documents');
});

test('platform support is read-only: no forms at all', async () => {
  await renderHub('support');
  expect(screen.getByRole('button', { name: 'Documents' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save document' })).not.toBeInTheDocument();
  expect(document.querySelectorAll('form')).toHaveLength(0);
});

test('the case workspace hides its edit forms without matters.write', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path.endsWith('/access')) {
      return {
        data: { caseId: 'c1', access: 'firm', members: [], exclusions: [], canManage: false },
      };
    }
    if (path === '/users/directory') {
      return { data: [] };
    }
    return {
      data: {
        id: 'c1',
        submissionId: 's1',
        caseNumber: 'NKP-2026-0001',
        clientLabel: 'Client 001',
        practiceArea: 'Labour',
        urgency: 'low',
        status: 'triage',
        nextAction: 'Review',
        access: 'firm',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
        tasks: [
          {
            id: 't1',
            caseId: 'c1',
            title: 'Call client',
            description: '',
            status: 'open',
            dueDate: null,
            assigneeName: null,
            createdBy: 'x',
            createdAt: '2026-01-01T00:00:00Z',
            completedAt: null,
          },
        ],
        timeline: [],
      },
    };
  });
  render(
    <CaseWorkspace api={api} selectedCaseId="c1" onChanged={async () => {}} canEdit={false} />,
  );
  expect(await screen.findByText('Call client')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add task' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save status' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument();
});
