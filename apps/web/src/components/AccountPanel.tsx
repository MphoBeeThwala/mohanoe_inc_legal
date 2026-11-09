import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { PublicUser, SessionInfo } from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';
import DismissibleNotice, { type Notice } from './DismissibleNotice';

/** The signed-in user's own security: password and devices. */
function AccountPanel({ currentUser }: { currentUser: PublicUser }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [form, setForm] = useState({ currentPassword: '', newPassword: '' });
  const [notice, setNotice] = useState<Notice>({ tone: 'info', message: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get<SessionInfo[]>('/auth/sessions');
    setSessions(data);
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.post('/auth/password', form);
      setForm({ currentPassword: '', newPassword: '' });
      setNotice({ tone: 'success', message: 'Password changed. Other devices were signed out.' });
      await load();
    } catch (error) {
      setNotice({
        tone: 'error',
        message: apiErrorMessage(error, 'Could not change the password.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const signOutOthers = async () => {
    setBusy(true);
    try {
      const { data } = await api.post<{ revoked: number }>('/auth/sessions/revoke-others');
      setNotice({ tone: 'success', message: `Signed out ${data.revoked} other session(s).` });
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <p className="panel-kicker">My account</p>
      <h2>Sign-in and devices</h2>
      <DismissibleNotice
        tone={notice.tone}
        message={notice.message}
        onDismiss={() => setNotice({ tone: 'info', message: '' })}
      />
      <div className="mini-list">
        {sessions.map((session) => (
          <div key={session.id} className="mini-item">
            <div>
              <strong>
                {session.current ? 'This device' : session.userAgent || 'Another device'}
              </strong>
              <div className="field-hint">
                {session.method === 'oidc' ? 'Microsoft sign-in' : 'Password + authenticator'} ·
                last active {new Date(session.lastSeenAt).toLocaleString()}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="action-row">
        <button
          type="button"
          className="secondary-button"
          disabled={busy || sessions.length < 2}
          onClick={signOutOthers}
        >
          Sign out other devices
        </button>
      </div>
      {currentUser.signInMethods.includes('password') ? (
        <form className="inline-form" onSubmit={changePassword} aria-label="Change password">
          <input
            type="password"
            placeholder="Current password"
            autoComplete="current-password"
            value={form.currentPassword}
            onChange={(event) =>
              setForm((current) => ({ ...current, currentPassword: event.target.value }))
            }
            required
          />
          <input
            type="password"
            placeholder="New password (12+ characters)"
            autoComplete="new-password"
            minLength={12}
            value={form.newPassword}
            onChange={(event) =>
              setForm((current) => ({ ...current, newPassword: event.target.value }))
            }
            required
          />
          <button className="secondary-button" disabled={busy}>
            Change password
          </button>
        </form>
      ) : null}
    </div>
  );
}

export default AccountPanel;
