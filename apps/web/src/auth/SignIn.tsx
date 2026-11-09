import { useState, type FormEvent } from 'react';
import type { AuthConfig, PublicUser, SignInResult } from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';
import Field from '../components/Field';
import MfaSetup from './MfaSetup';

type Step =
  | { kind: 'password' }
  | { kind: 'mfa'; challengeToken: string }
  | { kind: 'enroll'; challengeToken: string }
  | { kind: 'forgot' };

interface SignInProps {
  config: AuthConfig;
  onSignedIn: (user: PublicUser) => void;
  onNotice: (tone: 'info' | 'success' | 'warn' | 'error', message: string) => void;
}

const SIGNIN_ERRORS: Record<string, string> = {
  not_invited:
    'That Microsoft account is not linked to this workspace. Ask your administrator for an invitation.',
  inactive: 'Your account has been deactivated. Contact your administrator.',
  mfa_required: 'Your Microsoft sign-in did not include multi-factor authentication.',
  oidc_state_missing: 'Your sign-in took too long or was started elsewhere. Please try again.',
  oidc_state_invalid: 'Your sign-in took too long or was started elsewhere. Please try again.',
  oidc_failed: 'Microsoft sign-in did not complete. Please try again.',
};

export function signInErrorMessage(code: string | null): string | null {
  return code ? (SIGNIN_ERRORS[code] ?? SIGNIN_ERRORS.oidc_failed!) : null;
}

function SignIn({ config, onSignedIn, onNotice }: SignInProps) {
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post<SignInResult>('/auth/login', { email, password });
      setPassword('');
      if (data.status === 'mfa_required') {
        setStep({ kind: 'mfa', challengeToken: data.challengeToken });
      } else if (data.status === 'mfa_enrollment_required') {
        setStep({ kind: 'enroll', challengeToken: data.challengeToken });
        onNotice('info', 'Two-factor sign-in is required for every staff account.');
      } else {
        onSignedIn(data.user);
      }
    } catch (error) {
      onNotice('error', apiErrorMessage(error, 'Sign-in failed.'));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (step.kind !== 'mfa') return;
    setBusy(true);
    try {
      const { data } = await api.post<SignInResult>('/auth/mfa/verify', {
        challengeToken: step.challengeToken,
        code,
      });
      if (data.status === 'signed_in') {
        onSignedIn(data.user);
      }
    } catch (error) {
      onNotice('error', apiErrorMessage(error, 'That code did not work.'));
    } finally {
      setCode('');
      setBusy(false);
    }
  };

  const submitForgot = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post<{ message: string }>('/auth/password/forgot', { email });
      onNotice('success', data.message);
      setStep({ kind: 'password' });
    } catch (error) {
      onNotice('error', apiErrorMessage(error, 'Could not send the reset link.'));
    } finally {
      setBusy(false);
    }
  };

  if (step.kind === 'enroll') {
    return (
      <MfaSetup
        challengeToken={step.challengeToken}
        onDone={onSignedIn}
        onError={(message) => onNotice('error', message)}
      />
    );
  }

  if (step.kind === 'mfa') {
    return (
      <form className="auth-form" onSubmit={submitCode}>
        <h2>Two-factor sign-in</h2>
        <Field
          label={useRecovery ? 'Recovery code' : '6-digit code from your authenticator app'}
          id="mfa-code"
        >
          <input
            id="mfa-code"
            inputMode={useRecovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
            autoFocus
          />
        </Field>
        <div className="action-row">
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? 'Checking…' : 'Verify'}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setUseRecovery((current) => !current)}
          >
            {useRecovery ? 'Use my authenticator app' : 'Use a recovery code'}
          </button>
        </div>
      </form>
    );
  }

  if (step.kind === 'forgot') {
    return (
      <form className="auth-form" onSubmit={submitForgot}>
        <h2>Reset your password</h2>
        <Field label="Work email" id="forgot-email">
          <input
            id="forgot-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </Field>
        <div className="action-row">
          <button type="submit" className="primary-button" disabled={busy}>
            Email me a reset link
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setStep({ kind: 'password' })}
          >
            Back to sign in
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="sign-in">
      <h2>Sign in</h2>
      {config.oidc.enabled ? (
        <>
          <a className="primary-button oidc-button" href="/api/auth/oidc/start">
            {config.oidc.label || 'Sign in with Microsoft'}
          </a>
          {config.passwordLogin ? <div className="divider">or</div> : null}
        </>
      ) : null}
      {config.passwordLogin ? (
        <form className="auth-form" onSubmit={submitPassword}>
          <Field label="Email" id="auth-email">
            <input
              id="auth-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </Field>
          <Field label="Password" id="auth-password">
            <input
              id="auth-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </Field>
          <div className="action-row">
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? 'Signing in…' : 'Continue'}
            </button>
            {config.selfServiceReset ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => setStep({ kind: 'forgot' })}
              >
                Forgot password?
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
      <div className="field-hint">
        Accounts are by invitation only.{' '}
        {config.selfServiceReset ? '' : 'For a password reset, ask your administrator.'}
      </div>
    </div>
  );
}

export default SignIn;
