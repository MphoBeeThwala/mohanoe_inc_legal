import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  ROLE_LABELS,
  STAFF_ROLES,
  type Invite,
  type LinkIssued,
  type PublicUser,
  type StaffUser,
  type UserRole,
} from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';
import DismissibleNotice, { type Notice } from './DismissibleNotice';

interface StaffAdminProps {
  currentUser: PublicUser;
}

/** Firm administrators: invite staff, change roles, deactivate, reset MFA or passwords. */
function StaffAdmin({ currentUser }: StaffAdminProps) {
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [form, setForm] = useState<{ email: string; fullName: string; role: UserRole }>({
    email: '',
    fullName: '',
    role: 'attorney',
  });
  const [link, setLink] = useState<{ label: string; url: string; emailed: boolean } | null>(null);
  const [notice, setNotice] = useState<Notice>({ tone: 'info', message: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [usersResponse, invitesResponse] = await Promise.all([
      api.get<StaffUser[]>('/users'),
      api.get<Invite[]>('/users/invites'),
    ]);
    setUsers(usersResponse.data);
    setInvites(invitesResponse.data.filter((invite) => invite.status === 'pending'));
  }, []);

  useEffect(() => {
    load().catch((error: unknown) =>
      setNotice({ tone: 'error', message: apiErrorMessage(error, 'Could not load staff.') }),
    );
  }, [load]);

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    try {
      await action();
      setNotice({ tone: 'success', message: success });
      await load();
    } catch (error) {
      setNotice({ tone: 'error', message: apiErrorMessage(error, 'That did not work.') });
    } finally {
      setBusy(false);
    }
  };

  const invite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(async () => {
      const { data } = await api.post<LinkIssued<Invite>>('/users/invites', form);
      setLink({ label: `Invitation for ${data.item.email}`, url: data.url, emailed: data.emailed });
      setForm({ email: '', fullName: '', role: 'attorney' });
    }, 'Invitation created.');
  };

  const resetPassword = (user: StaffUser) =>
    run(async () => {
      const { data } = await api.post<LinkIssued<StaffUser>>(`/users/${user.id}/password-reset`);
      setLink({ label: `Password reset for ${user.email}`, url: data.url, emailed: data.emailed });
    }, 'Reset link created.');

  return (
    <div className="panel">
      <p className="panel-kicker">Administration</p>
      <h2>Staff and access</h2>
      <DismissibleNotice
        tone={notice.tone}
        message={notice.message}
        onDismiss={() => setNotice({ tone: 'info', message: '' })}
      />

      {link ? (
        <div className="notice notice-info link-issued" role="status">
          <strong>{link.label}</strong>
          <p>
            {link.emailed
              ? 'Emailed, and shown here once: '
              : 'Share this link securely (shown once): '}
          </p>
          <code className="link-url">{link.url}</code>
          <div className="action-row">
            <button
              type="button"
              className="secondary-button"
              onClick={() => navigator.clipboard?.writeText(link.url)}
            >
              Copy link
            </button>
            <button type="button" className="secondary-button" onClick={() => setLink(null)}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      <form className="inline-form" onSubmit={invite} aria-label="Invite a staff member">
        <input
          type="text"
          placeholder="Full name"
          value={form.fullName}
          onChange={(event) => setForm((current) => ({ ...current, fullName: event.target.value }))}
          required
        />
        <input
          type="email"
          placeholder="Work email"
          value={form.email}
          onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
          required
        />
        <select
          aria-label="Role"
          value={form.role}
          onChange={(event) =>
            setForm((current) => ({ ...current, role: event.target.value as UserRole }))
          }
        >
          {STAFF_ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
        <button className="primary-button" disabled={busy}>
          Invite
        </button>
      </form>

      {invites.length ? (
        <>
          <h3>Pending invitations</h3>
          <div className="mini-list">
            {invites.map((item) => (
              <div key={item.id} className="mini-item">
                <div>
                  <strong>{item.fullName}</strong> · {item.email} · {ROLE_LABELS[item.role]}
                  <div className="field-hint">
                    Expires {new Date(item.expiresAt).toLocaleDateString()}
                  </div>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => api.delete(`/users/invites/${item.id}`).then(() => undefined),
                      'Invitation revoked.',
                    )
                  }
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <h3>Staff</h3>
      <div className="mini-list">
        {users.map((user) => {
          const self = user.id === currentUser.id;
          return (
            <div key={user.id} className={`mini-item ${user.isActive ? '' : 'is-inactive'}`}>
              <div>
                <strong>{user.fullName}</strong> · {user.email}
                <div className="field-hint">
                  {user.signInMethods.includes('oidc') ? 'Microsoft sign-in' : 'Password'}
                  {user.signInMethods.includes('password')
                    ? user.mfaEnabled
                      ? ' · two-factor on'
                      : ' · two-factor not set up yet'
                    : ''}
                  {user.lockedUntil ? ' · locked after failed sign-ins' : ''}
                  {user.isActive ? '' : ' · deactivated'}
                </div>
              </div>
              <div className="action-row">
                <select
                  aria-label={`Role for ${user.fullName}`}
                  value={user.role}
                  disabled={busy || self}
                  onChange={(event) =>
                    run(
                      () =>
                        api
                          .patch(`/users/${user.id}`, { role: event.target.value })
                          .then(() => undefined),
                      'Role updated.',
                    )
                  }
                >
                  {STAFF_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
                {user.role === 'support' ? null : (
                  <input
                    type="number"
                    min={0}
                    max={400}
                    className="target-hours"
                    aria-label={`Billable hours target per month for ${user.fullName}`}
                    placeholder="Target h/month"
                    defaultValue={user.targetHoursPerMonth ?? ''}
                    disabled={busy}
                    onBlur={(event) => {
                      const raw = event.target.value.trim();
                      const next = raw === '' ? null : Math.round(Number(raw));
                      if (next === user.targetHoursPerMonth) return;
                      if (next !== null && !(next >= 0 && next <= 400)) return;
                      void run(
                        () =>
                          api
                            .patch(`/users/${user.id}`, { targetHoursPerMonth: next })
                            .then(() => undefined),
                        next === null ? 'Target cleared.' : 'Target saved.',
                      );
                    }}
                  />
                )}
                {self ? null : (
                  <>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () =>
                            api
                              .patch(`/users/${user.id}`, { isActive: !user.isActive })
                              .then(() => undefined),
                          user.isActive ? 'Deactivated and signed out.' : 'Reactivated.',
                        )
                      }
                    >
                      {user.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                    {user.signInMethods.includes('password') ? (
                      <>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => resetPassword(user)}
                        >
                          Reset password
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy || !user.mfaEnabled}
                          onClick={() =>
                            run(
                              () => api.post(`/users/${user.id}/mfa-reset`).then(() => undefined),
                              'Two-factor reset: they will set it up again at next sign-in.',
                            )
                          }
                        >
                          Reset two-factor
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => api.post(`/users/${user.id}/sessions/revoke`).then(() => undefined),
                          'Signed out on every device.',
                        )
                      }
                    >
                      Sign out everywhere
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default StaffAdmin;
