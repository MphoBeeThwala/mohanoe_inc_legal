import { useState, type FormEvent } from 'react';
import { api, apiErrorMessage } from '../api';
import Field from '../components/Field';

interface SupportSignInProps {
  onSignedIn: () => void;
  onNotice: (tone: 'info' | 'success' | 'warn' | 'error', message: string) => void;
}

/** /support: platform operators, only while the firm has granted access. */
function SupportSignIn({ onSignedIn, onNotice }: SupportSignInProps) {
  const [form, setForm] = useState({ email: '', password: '', code: '' });
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.post('/support/sign-in', form);
      onSignedIn();
    } catch (error) {
      onNotice('error', apiErrorMessage(error, 'Support sign-in refused.'));
    } finally {
      setForm((current) => ({ ...current, password: '', code: '' }));
      setBusy(false);
    }
  };

  const field = (name: 'email' | 'password' | 'code') => ({
    value: form[name],
    onChange: (event: { target: { value: string } }) =>
      setForm((current) => ({ ...current, [name]: event.target.value })),
    required: true,
  });

  return (
    <form className="auth-form" onSubmit={submit}>
      <h2>Platform support sign-in</h2>
      <p className="field-hint">
        Only possible while this firm has allowed support access. Your session is read-only and
        recorded in the firm's audit trail.
      </p>
      <Field label="Support email" id="support-email">
        <input id="support-email" type="email" autoComplete="username" {...field('email')} />
      </Field>
      <Field label="Password" id="support-password">
        <input
          id="support-password"
          type="password"
          autoComplete="current-password"
          {...field('password')}
        />
      </Field>
      <Field label="Authenticator code" id="support-code">
        <input
          id="support-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          {...field('code')}
        />
      </Field>
      <div className="action-row">
        <button type="submit" className="primary-button" disabled={busy}>
          Sign in
        </button>
      </div>
    </form>
  );
}

export default SupportSignIn;
