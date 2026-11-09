import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { ROLE_PERMISSIONS, type PublicUser } from '@ahava88/shared';
import { api } from '../api';
import OnboardingWizard from './OnboardingWizard';
import DomainsPanel from './DomainsPanel';
import { BrandForm } from './FirmSettingsForms';

const admin = {
  id: 'u1',
  email: 'admin@example.com',
  fullName: 'Ada',
  role: 'admin',
  permissions: [...ROLE_PERMISSIONS.admin],
} as PublicUser;

const settings = {
  retentionDays: 1825,
  retentionIsDefault: true,
  ficaEnforced: false,
  billing: {
    vatRegistered: true,
    vatNumber: null,
    paymentTermsDays: 30,
    address: '',
    bankDetails: '',
    invoiceFooter: '',
    invoicePrefix: 'INV',
  },
  profile: {
    registrationNumber: '',
    lpcNumber: '',
    fidelityFundCertificate: '',
    email: '',
    phone: '',
    website: '',
    replyToEmail: '',
  },
  brand: {
    legalName: 'Nkosi Inc',
    tradingName: 'Nkosi',
    primaryColor: '#1f4e79',
    accentColor: '#7a4b00',
    casePrefix: 'MAT',
    logoUrl: null,
    iconUrl: null,
  },
  microsoft: {
    available: false,
    tenantId: null,
    domains: [],
    enforced: false,
    adminConsentUrl: null,
  },
};

const status = (done: string[] = [], complete = false) => ({
  steps: ['profile', 'brand', 'billing', 'practice', 'team'].map((id) => ({
    id,
    label: id,
    done: done.includes(id),
  })),
  complete,
  completedAt: complete ? '2026-11-09T00:00:00Z' : null,
});

afterEach(() => vi.restoreAllMocks());

test('the wizard saves a step, marks it done and moves on', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/firm/onboarding') return { data: status() };
    if (url === '/firm/settings') return { data: settings };
    throw new Error(url);
  });
  const patch = vi.spyOn(api, 'patch').mockImplementation(async (url: string, body: unknown) => {
    if (url === '/firm/settings') return { data: settings };
    return { data: status((body as { done?: string }).done ? ['profile'] : []) };
  });
  const changed = vi.fn();
  render(<OnboardingWizard currentUser={admin} onChanged={changed} />);
  expect(await screen.findByText('Step 1 of 5')).toBeInTheDocument();
  fireEvent.change(await screen.findByLabelText(/Physical or postal address/), {
    target: { value: '1 Smith Street, Durban' },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
  });
  expect(patch).toHaveBeenCalledWith(
    '/firm/settings',
    expect.objectContaining({ billing: { address: '1 Smith Street, Durban' } }),
  );
  expect(patch).toHaveBeenCalledWith('/firm/onboarding', { done: 'profile' });
  expect(changed).toHaveBeenCalled();
  expect(await screen.findByText('Step 2 of 5')).toBeInTheDocument();
});

test('a finished setup shows nothing', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) =>
    url === '/firm/onboarding' ? { data: status([], true) } : { data: settings },
  );
  const { container } = render(<OnboardingWizard currentUser={admin} />);
  await act(async () => {});
  expect(container).toBeEmptyDOMElement();
});

test('colours too light for white text are flagged as you type', () => {
  render(<BrandForm settings={settings} save={vi.fn()} />);
  expect(screen.getByText(/Contrast with white text 8\.\d:1$/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Main colour'), { target: { value: '#ffeb3b' } });
  expect(screen.getByText(/needs 4\.5:1/)).toBeInTheDocument();
});

test('domains show the DNS records to publish and can be checked', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: [
      {
        id: 'd1',
        domain: 'portal.nkosi.co.za',
        status: 'pending_dns',
        txtRecordName: '_firm-verify.portal.nkosi.co.za',
        txtRecordValue: 'firm-domain-verification=abc',
        cnameTarget: 'firms.platform.example',
        lastCheckedAt: null,
        lastError: null,
        activatedAt: null,
        createdAt: '2026-11-09T00:00:00Z',
      },
    ],
  });
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} });
  render(<DomainsPanel />);
  expect(await screen.findByText('_firm-verify.portal.nkosi.co.za')).toBeInTheDocument();
  expect(screen.getByText('firms.platform.example')).toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
  });
  expect(post).toHaveBeenCalledWith('/firm/domains/d1/check');
});
