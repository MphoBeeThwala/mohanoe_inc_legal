import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { OnboardingStatus, OnboardingStep, PublicUser } from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';
import StaffAdmin from './StaffAdmin';
import {
  BrandForm,
  InvoicingForm,
  PracticeForm,
  ProfileForm,
  useFirmSettings,
} from './FirmSettingsForms';

const INTROS: Record<OnboardingStep, string> = {
  profile: 'Your practice details appear on invoices and statements.',
  brand:
    'Your name, logo and colours are what staff and clients see on every screen, email and PDF.',
  billing: 'How you invoice: VAT, payment terms and the account clients pay into.',
  practice: 'How matters and invoices are numbered, and your FICA and record-keeping choices.',
  team: 'Invite your colleagues. Each signs in with their own password and authenticator app.',
};

interface Props {
  currentUser: PublicUser;
  /** Reload branding and data after changes. */
  onChanged?: () => unknown;
}

/**
 * First-run setup for a new firm's administrator. Each step saves through
 * the same forms as Firm settings; steps can be skipped and the wizard
 * closed, and everything can be changed later.
 */
function OnboardingWizard({ currentUser, onChanged }: Props) {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [current, setCurrent] = useState<OnboardingStep>('profile');
  const [error, setError] = useState('');
  const { settings, save } = useFirmSettings();

  const load = useCallback(async () => {
    const { data } = await api.get<OnboardingStatus>('/firm/onboarding');
    setStatus(data);
    const next = data.steps.find((step) => !step.done);
    if (next) setCurrent(next.id);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(apiErrorMessage(err, 'Setup could not be loaded.')));
  }, [load]);

  if (!status || status.complete) return null;

  const index = status.steps.findIndex((step) => step.id === current);
  const update = async (body: { done?: OnboardingStep; finish?: boolean }) => {
    try {
      const { data } = await api.patch<OnboardingStatus>('/firm/onboarding', body);
      setStatus(data);
      return data;
    } catch (err) {
      setError(apiErrorMessage(err, 'Setup progress could not be saved.'));
      return null;
    }
  };
  const next = async () => {
    await update({ done: current });
    await onChanged?.();
    const following = status.steps[index + 1];
    if (following) setCurrent(following.id);
    else await update({ finish: true });
  };
  const skip = () => {
    const following = status.steps[index + 1];
    if (following) setCurrent(following.id);
    else void update({ finish: true });
  };

  let body: ReactNode = null;
  if (settings) {
    const props = { settings, save, onSaved: next, saveLabel: 'Save and continue' };
    if (current === 'profile') body = <ProfileForm {...props} />;
    if (current === 'brand') body = <BrandForm {...props} />;
    if (current === 'billing') body = <InvoicingForm {...props} />;
    if (current === 'practice') body = <PracticeForm {...props} />;
  }
  if (current === 'team') {
    body = (
      <>
        <StaffAdmin currentUser={currentUser} />
        <button type="button" className="primary-button" onClick={next}>
          Finish setup
        </button>
      </>
    );
  }

  return (
    <section className="panel onboarding" aria-label="Set up your firm">
      <div className="panel-head">
        <div>
          <p className="panel-kicker">
            Step {index + 1} of {status.steps.length}
          </p>
          <h2>Set up your firm: {status.steps[index]?.label}</h2>
        </div>
        <button type="button" className="link-button" onClick={() => update({ finish: true })}>
          Finish later in Firm settings
        </button>
      </div>
      <ol className="onboarding-steps">
        {status.steps.map((step) => (
          <li key={step.id} className={step.id === current ? 'current' : step.done ? 'done' : ''}>
            <button type="button" className="link-button" onClick={() => setCurrent(step.id)}>
              {step.done ? '✓ ' : ''}
              {step.label}
            </button>
          </li>
        ))}
      </ol>
      {error ? <p className="field-hint notice-error">{error}</p> : null}
      <p>{INTROS[current]}</p>
      {body}
      {current !== 'team' ? (
        <button type="button" className="link-button" onClick={skip}>
          Skip this step
        </button>
      ) : null}
    </section>
  );
}

export default OnboardingWizard;
