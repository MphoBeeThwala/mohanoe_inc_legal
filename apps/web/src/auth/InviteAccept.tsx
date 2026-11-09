import { useEffect, useState, type FormEvent } from 'react';
import type { AuthConfig, InvitePreview, PublicUser, SignInResult } from '@ahava88/shared';
import { ROLE_LABELS } from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';
import Field from '../components/Field';
import MfaSetup from './MfaSetup';

interface InviteAcceptProps {
  token: string;
  config: AuthConfig;
  onSignedIn: (user: PublicUser) => void;
  onNotice: (tone: 'info' | 'success' | 'warn' | 'error', message: string) => void;
}

function InviteAccept({ token, config, onSignedIn, onNotice }: InviteAcceptProps) {
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [failed, setFailed] = useState(false);
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [challengeToken, setChallengeToken] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<InvitePreview>(`/auth/invites/${encodeURIComponent(token)}`)
      .then(({ data }) => {
        setInvite(data);
        setFullName(data.fullName);
      })
      .catch((error: unknown) => {
        setFailed(true);
        onNotice('error', apiErrorMessage(error, 'This invitation is not valid.'));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const accept = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password !== confirm) {
      onNotice('error', 'The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post<SignInResult>(
        `/auth/invites/${encodeURIComponent(token)}/accept`,
        { fullName, password },
      );
      if (data.status === 'mfa_enrollment_required') {
        setChallengeToken(data.challengeToken);
      }
    } catch (error) {
      onNotice('error', apiErrorMessage(error, 'Could not accept the invitation.'));
    } finally {
      setBusy(false);
    }
  };

  if (failed) {
    return <p>Ask your administrator to send you a new invitation.</p>;
  }
  if (!invite) {
    return <p aria-busy="true">Checking your invitation…</p>;
  }
  if (challengeToken) {
    return (
      <MfaSetup
        challengeToken={challengeToken}
        onDone={onSignedIn}
        onError={(message) => onNotice('error', message)}
      />
    );
  }

  return (
    <div className="sign-in">
      <h2>Join {invite.firmName}</h2>
      <p className="field-hint">
        You've been invited as <strong>{ROLE_LABELS[invite.role]}</strong> ({invite.email}).
      </p>
      {config.microsoft.enabled ? (
        <>
          <a
            className="primary-button oidc-button"
            href={`/api/auth/oidc/start?provider=microsoft&invite=${encodeURIComponent(token)}`}
          >
            Continue with Microsoft 365
          </a>
          <div className="divider">or</div>
        </>
      ) : null}
      {config.oidc.enabled ? (
        <>
          <a
            className="primary-button oidc-button"
            href={`/api/auth/oidc/start?invite=${encodeURIComponent(token)}`}
          >
            {config.oidc.label || 'Continue with Microsoft'}
          </a>
          {config.passwordLogin ? <div className="divider">or choose a password</div> : null}
        </>
      ) : null}
      {config.passwordLogin ? (
        <form className="auth-form" onSubmit={accept}>
          <Field label="Full name" id="invite-name">
            <input
              id="invite-name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              autoComplete="name"
              required
            />
          </Field>
          <Field
            label="Password"
            id="invite-password"
            hint="At least 12 characters, with upper-case, lower-case and a number."
          >
            <input
              id="invite-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={12}
              required
            />
          </Field>
          <Field label="Confirm password" id="invite-confirm">
            <input
              id="invite-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              required
            />
          </Field>
          <div className="action-row">
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? 'Creating your account…' : 'Continue to two-factor set-up'}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

export default InviteAccept;
