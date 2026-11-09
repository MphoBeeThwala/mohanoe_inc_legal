import { useState, type FormEvent } from 'react';
import { api, apiErrorMessage } from '../api';
import Field from '../components/Field';

interface ResetPasswordProps {
  token: string;
  onDone: () => void;
  onNotice: (tone: 'info' | 'success' | 'warn' | 'error', message: string) => void;
}

function ResetPassword({ token, onDone, onNotice }: ResetPasswordProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password !== confirm) {
      onNotice('error', 'The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/auth/password/reset/${encodeURIComponent(token)}`, { password });
      onNotice('success', 'Password changed. Sign in with your new password.');
      onDone();
    } catch (error) {
      onNotice('error', apiErrorMessage(error, 'Could not reset the password.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="auth-form" onSubmit={submit}>
      <h2>Choose a new password</h2>
      <Field
        label="New password"
        id="reset-password"
        hint="At least 12 characters, with upper-case, lower-case and a number."
      >
        <input
          id="reset-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          minLength={12}
          required
        />
      </Field>
      <Field label="Confirm password" id="reset-confirm">
        <input
          id="reset-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          required
        />
      </Field>
      <div className="action-row">
        <button type="submit" className="primary-button" disabled={busy}>
          Set password
        </button>
      </div>
    </form>
  );
}

export default ResetPassword;
